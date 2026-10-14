/**
 * “只认我的声音”：在 hub 的 Qwen 代理里按声纹放行用户的每一轮话。
 *
 * 会话用 semantic_vad + create_response:false，百炼断句但不自己回答。本类缓存浏览器发上去的音频，
 * 对每一轮：先扣住这一轮的事件（speech_started/stopped、条目创建、转写），去掉静音后算声纹——
 *   - 是本人：放行扣住的事件（speech_started 带 hapi_verified，网页据此立即停止朗读），并发 response.create；
 *     说到 2 秒时先判一次，像本人就提前放行，这样本人插话能及时打断朗读；
 *   - 不是：丢掉这些事件，conversation.item.delete 删掉这一轮，模型和网页都不知道有人说过话。
 *     短片段的声纹不稳（实测本人 1 秒左右的片段可低到 0.12），所以拒绝只看整轮，不提前拒。
 * 说不准的情况一律放行（服务不可用、话太短、超时），宁可多答一句，不能把用户本人挡在外面。
 * observe 模式只打分记日志，始终放行，用于先拿真实分数定阈值。
 *
 * 实测（2026-10-13，qwen3.5-omni-flash-realtime）：create_response:false 时百炼不发
 * input_audio_buffer.committed，这一轮进入对话的信号是 conversation.item.created；两者都认，各只处理一次。
 */

import { embedSpeaker, getVoiceprintStore, speakerScore, speakerServiceConfigured, voicedPcm, type SpeakerGateRecord, type Voiceprint } from './speaker'

export type SpeakerGateDecision = 'accept' | 'reject'

export type SpeakerGateDeps = {
    mode: 'enforce' | 'observe'
    voiceprint: Voiceprint | null
    embed: (pcm: Uint8Array) => Promise<number[] | null>
    sendUpstream: (event: Record<string, unknown>) => void
    sendClient: (raw: string) => void
    threshold: number
    onDecision?: (record: SpeakerGateRecord) => void
    now?: () => number
}

const BYTES_PER_MS = 32 // 16 kHz × 16-bit mono
const KEEP_AUDIO_MS = 60_000
/** Once this much of a turn has arrived it is checked early, so the real user can still interrupt a reply quickly. */
export const PARTIAL_MS = 2_000
/** Turns with less speech than this ("对", "确认") are let through: too little to tell voices apart reliably. */
export const MIN_SCORED_MS = 800
/** Longer turns are judged on their first seconds: plenty for a voiceprint, and quick to send over ECS's narrow uplink. */
export const MAX_SCORED_MS = 6_000
/** A verdict still missing this long after the speaker stopped is abandoned in favour of letting the turn through. */
const DECISION_TIMEOUT_MS = 5_000
/** Decided turns are kept a while for their late transcription events, then forgotten. */
const FORGET_TURN_MS = 120_000

type Turn = {
    itemId: string
    startMs: number
    endMs: number | null
    stoppedAt: number | null
    decision: 'pending' | SpeakerGateDecision
    held: string[]
    /** The turn is now an item of the conversation (committed / item created): it can be answered or deleted. */
    committed: boolean
    responded: boolean
    deleted: boolean
    partialStarted: boolean
    fullStarted: boolean
    createdAt: number
}

export class SpeakerGate {
    private readonly deps: SpeakerGateDeps
    private readonly now: () => number
    private chunks: Array<{ offset: number; bytes: Uint8Array }> = []
    private totalBytes = 0
    private readonly turns = new Map<string, Turn>()
    private responseActive = false

    constructor(deps: SpeakerGateDeps) {
        this.deps = deps
        this.now = deps.now ?? Date.now
    }

    /** A client frame on its way upstream: keep the audio it carries. */
    clientFrame(raw: string): void {
        if (!raw.includes('input_audio_buffer.append')) return
        let event: { type?: unknown; audio?: unknown }
        try { event = JSON.parse(raw) as typeof event } catch { return }
        if (event.type !== 'input_audio_buffer.append' || typeof event.audio !== 'string') return
        const bytes = Uint8Array.from(Buffer.from(event.audio, 'base64'))
        this.chunks.push({ offset: this.totalBytes, bytes })
        this.totalBytes += bytes.length
        const keepFrom = this.totalBytes - KEEP_AUDIO_MS * BYTES_PER_MS
        while (this.chunks.length > 1 && this.chunks[0]!.offset + this.chunks[0]!.bytes.length < keepFrom) this.chunks.shift()
        for (const turn of this.turns.values()) this.maybeCheckPartial(turn)
    }

    /** An upstream event. Returns true when the gate took it (held, forwarded or dropped). */
    upstream(raw: string): boolean {
        let event: Record<string, unknown>
        try { event = JSON.parse(raw) as Record<string, unknown> } catch { return false }
        const type = event.type
        if (type === 'response.created') this.responseActive = true
        if (type === 'response.done') this.responseActive = false
        if (type === 'input_audio_buffer.speech_started' && typeof event.item_id === 'string') {
            this.forgetOldTurns()
            const turn: Turn = {
                itemId: event.item_id,
                startMs: typeof event.audio_start_ms === 'number' ? event.audio_start_ms : this.totalBytes / BYTES_PER_MS,
                endMs: null,
                stoppedAt: null,
                decision: 'pending',
                held: [raw],
                committed: false,
                responded: false,
                deleted: false,
                partialStarted: false,
                fullStarted: false,
                createdAt: this.now()
            }
            this.turns.set(turn.itemId, turn)
            this.maybeCheckPartial(turn)
            return true
        }
        const itemId = typeof event.item_id === 'string'
            ? event.item_id
            : typeof (event.item as { id?: unknown } | undefined)?.id === 'string' ? (event.item as { id: string }).id : null
        const turn = itemId ? this.turns.get(itemId) : undefined
        if (!turn) return false

        if (type === 'input_audio_buffer.speech_stopped') {
            turn.stoppedAt = this.now()
            if (typeof event.audio_end_ms === 'number') turn.endMs = event.audio_end_ms
        }
        if (type === 'input_audio_buffer.committed' || type === 'conversation.item.created') turn.committed = true

        if (turn.decision === 'accept') {
            this.deps.sendClient(raw)
            this.answer(turn)
            return true
        }
        if (turn.decision === 'reject') {
            this.forget(turn)
            return true
        }
        turn.held.push(raw)
        if (type === 'input_audio_buffer.speech_stopped') void this.checkFull(turn)
        // A turn whose voiceprint never arrived must not stay stuck. Counted from the end of speech, so a
        // stranger talking at length is still judged on the whole turn rather than waved through.
        if (turn.stoppedAt !== null && this.now() - turn.stoppedAt > DECISION_TIMEOUT_MS) this.settle(turn, 'accept', null, 'timeout')
        return true
    }

    close(): void {
        this.turns.clear()
        this.chunks = []
    }

    /** Ask for the reply to an accepted turn, once it is part of the conversation. */
    private answer(turn: Turn): void {
        if (!turn.committed || turn.responded) return
        turn.responded = true
        this.deps.sendUpstream({ type: 'response.create' })
    }

    /** Take a rejected turn out of the conversation, once it is part of it. */
    private forget(turn: Turn): void {
        if (!turn.committed || turn.deleted) return
        turn.deleted = true
        this.deps.sendUpstream({ type: 'conversation.item.delete', item_id: turn.itemId })
    }

    private forgetOldTurns(): void {
        const cutoff = this.now() - FORGET_TURN_MS
        for (const [itemId, turn] of this.turns) {
            if (turn.decision !== 'pending' && turn.createdAt < cutoff) this.turns.delete(itemId)
        }
    }

    private audio(startMs: number, endMs: number): Uint8Array {
        const from = Math.max(0, Math.floor(startMs) * BYTES_PER_MS)
        const to = Math.min(this.totalBytes, Math.floor(endMs) * BYTES_PER_MS)
        const out = new Uint8Array(Math.max(0, to - from))
        for (const chunk of this.chunks) {
            const a = Math.max(from, chunk.offset)
            const b = Math.min(to, chunk.offset + chunk.bytes.length)
            if (a < b) out.set(chunk.bytes.subarray(a - chunk.offset, b - chunk.offset), a - from)
        }
        return out.subarray(0, out.length - (out.length % 2))
    }

    /** Similarity of the speech (silence removed) in a stretch of the stream; null when there is too little speech or no answer. */
    private async score(startMs: number, endMs: number): Promise<{ score: number | null; voicedMs: number }> {
        const voiced = voicedPcm(this.audio(startMs, endMs))
        const voicedMs = voiced.byteLength / BYTES_PER_MS
        if (!this.deps.voiceprint || voicedMs < MIN_SCORED_MS) return { score: null, voicedMs }
        const embedding = await this.deps.embed(voiced)
        return { score: embedding ? speakerScore(embedding, this.deps.voiceprint) : null, voicedMs }
    }

    private maybeCheckPartial(turn: Turn): void {
        if (turn.decision !== 'pending' || turn.partialStarted || turn.endMs !== null) return
        if (this.totalBytes / BYTES_PER_MS < turn.startMs + PARTIAL_MS) return
        turn.partialStarted = true
        void this.checkPartial(turn)
    }

    private async checkPartial(turn: Turn): Promise<void> {
        const { score } = await this.score(turn.startMs, turn.startMs + PARTIAL_MS)
        if (turn.decision !== 'pending' || score === null) return
        // Only a match is trusted this early; a low score on two seconds may still be the user.
        if (score >= this.deps.threshold) this.settle(turn, 'accept', score, 'voiceprint match (early)')
    }

    private async checkFull(turn: Turn): Promise<void> {
        if (turn.fullStarted || turn.decision !== 'pending' || turn.endMs === null) return
        turn.fullStarted = true
        if (!this.deps.voiceprint) return this.settle(turn, 'accept', null, 'no voiceprint')
        const { score, voicedMs } = await this.score(turn.startMs, Math.min(turn.endMs, turn.startMs + MAX_SCORED_MS))
        if (turn.decision !== 'pending') return
        if (voicedMs < MIN_SCORED_MS) return this.settle(turn, 'accept', null, 'too short to judge')
        if (score === null) return this.settle(turn, 'accept', null, 'voiceprint service unavailable')
        this.settle(turn, score >= this.deps.threshold ? 'accept' : 'reject', score, score >= this.deps.threshold ? 'voiceprint match' : 'voiceprint mismatch')
    }

    private settle(turn: Turn, verdict: SpeakerGateDecision, score: number | null, reason: string): void {
        if (turn.decision !== 'pending') return
        const decision: SpeakerGateDecision = this.deps.mode === 'observe' ? 'accept' : verdict
        turn.decision = decision
        const seconds = ((turn.endMs ?? this.totalBytes / BYTES_PER_MS) - turn.startMs) / 1000
        this.deps.onDecision?.({
            at: this.now(),
            seconds: Math.round(seconds * 10) / 10,
            score: score === null ? null : Math.round(score * 1000) / 1000,
            decision: verdict,
            reason,
            enforced: this.deps.mode === 'enforce'
        })
        const held = turn.held
        turn.held = []
        if (decision === 'reject') {
            this.forget(turn)
            return
        }
        // The session no longer interrupts replies by itself (interrupt_response:false); do it for the real user.
        if (this.responseActive) {
            this.responseActive = false
            this.deps.sendUpstream({ type: 'response.cancel' })
        }
        for (const raw of held) {
            let out = raw
            try {
                const event = JSON.parse(raw) as Record<string, unknown>
                if (event.type === 'input_audio_buffer.speech_started') out = JSON.stringify({ ...event, hapi_verified: true })
                this.deps.sendClient(out)
            } catch {
                this.deps.sendClient(out)
            }
        }
        this.answer(turn)
    }
}

export type SpeakerGateLike = Pick<SpeakerGate, 'clientFrame' | 'upstream' | 'close'>

export type OpenSpeakerGate = (params: {
    accountId: number | null
    isAdmin: boolean
    sendUpstream: (event: Record<string, unknown>) => void
    sendClient: (raw: string) => void
}) => SpeakerGateLike | null

/**
 * 为一条 `turn=verified` 的语音连接开门。返回 null 表示这次不按声纹判断（门关着、账号没有声纹、
 * 声纹服务没配置），调用方据此退回普通的 semantic_vad 自动应答。
 */
export const openSpeakerGate: OpenSpeakerGate = (params) => {
    const store = getVoiceprintStore()
    if (!store || params.accountId === null || !speakerServiceConfigured()) return null
    const config = store.gateConfig()
    if (config.mode === 'off') return null
    const voiceprint = store.get(params.accountId, params.isAdmin)
    if (!voiceprint) return null
    const accountId = params.accountId
    return new SpeakerGate({
        mode: config.mode,
        threshold: config.threshold,
        voiceprint,
        embed: (pcm) => embedSpeaker(pcm),
        sendUpstream: params.sendUpstream,
        sendClient: params.sendClient,
        onDecision: (record) => {
            store.recordDecision(accountId, record)
            console.log(`[SpeakerGate] account=${accountId} mode=${config.mode} threshold=${config.threshold} seconds=${record.seconds} score=${record.score ?? '-'} verdict=${record.decision} reason=${record.reason}`)
        }
    })
}
