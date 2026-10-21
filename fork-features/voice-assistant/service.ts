/**
 * 语音助手的两件事：问进度（askSessionStatus）与整理指令（prepareInstruction）。
 *
 * 两者都只读会话：材料从内存态会话、摘要库和消息表里取，模型调用是 hub 发给模型网关的
 * 独立单轮请求，不写会话消息表。指令的发送由网页走现有的 /api/sessions/:id/messages，
 * 在用户确认之后才发生。
 *
 * 模型按顺序尝试：主模型（默认 DeepSeek，快）失败或超时就换下一个（摘要用的 luna）。
 */

import { createLlmCall, type LlmCall } from '../session-digest/llmClient'
import type { TranscriptMessage } from '../session-digest/transcript'
import {
    buildSessionMaterial,
    describeSessionForIndex,
    describeSessionForTargeting,
    type VoiceDigestView,
    type VoiceProjectView,
    type VoiceSessionView
} from './material'
import {
    EVIDENCE_QA_SYSTEM_PROMPT,
    NORMALIZE_SYSTEM_PROMPT,
    QA_DETAIL_SYSTEM_PROMPT,
    QA_ROUTER_SYSTEM_PROMPT,
    TARGET_SYSTEM_PROMPT,
    buildNormalizePrompt,
    buildQaDetailPrompt,
    buildQaRouterPrompt,
    buildTargetPrompt,
    parseJsonObject
} from './prompts'

export type VoiceLlmProvider = { label: string; model: string; call: LlmCall }

export type VoiceTurn = { q: string; a: string }

export type VoiceAssistantDeps = {
    getSession: (sessionId: string) => VoiceSessionView | undefined
    getRecentMessages: (sessionId: string, limit: number) => TranscriptMessage[]
    getDigest: (sessionId: string) => VoiceDigestView | null
    getProject: (session: VoiceSessionView) => VoiceProjectView | null
    providers: VoiceLlmProvider[]
    now?: () => number
}

export type VoiceTarget = { id: string; title: string }

export type VoiceDelivery = 'queue' | 'steer'

export type PrepareResult =
    | {
        status: 'ready'
        target: VoiceTarget
        instruction: string
        readback: string
        original: string
        model: string
        /** How to deliver while the target is busy; when it is idle both mean "now". */
        delivery: VoiceDelivery
        deliveryReason: string
        targetBusy: boolean
    }
    | { status: 'need_info'; target: VoiceTarget; ask: string }
    | { status: 'ambiguous'; candidates: VoiceTarget[]; ask: string }
    | { status: 'no_target'; ask: string }
    | { status: 'target_inactive'; target: VoiceTarget }

const QA_MESSAGES = 160
const DETAIL_MESSAGES = 120
const TARGET_MESSAGES = 60
const MAX_HISTORY_TURNS = 4
const MAX_CANDIDATES = 40
/** Sessions listed in the cross-session index: every running one plus the most recently active. */
const INDEX_RECENT = 40
const MAX_DETAIL_SESSIONS = 2

export class VoiceAssistantUnavailableError extends Error {}

export class VoiceAssistant {
    private readonly deps: VoiceAssistantDeps
    private readonly now: () => number

    constructor(deps: VoiceAssistantDeps) {
        this.deps = deps
        this.now = deps.now ?? Date.now
    }

    configured(): boolean {
        return this.deps.providers.length > 0
    }

    providerLabels(): string[] {
        return this.deps.providers.map((provider) => `${provider.label}:${provider.model}`)
    }

    /** 依次尝试各个模型，返回第一个成功的。全部失败时抛出最后一个错误。 */
    private async complete(system: string, prompt: string, maxTokens: number): Promise<{ text: string; model: string }> {
        if (this.deps.providers.length === 0) {
            throw new VoiceAssistantUnavailableError('Voice assistant model is not configured (HAPI_VOICE_QA_API_URL/KEY or HAPI_DIGEST_API_URL/KEY)')
        }
        let lastError: unknown = null
        for (const provider of this.deps.providers) {
            try {
                const text = await provider.call({ model: provider.model, system, prompt, maxTokens })
                return { text: text.trim(), model: provider.model }
            } catch (error) {
                lastError = error
                console.warn(`[VoiceAssistant] ${provider.label} (${provider.model}) failed: ${error instanceof Error ? error.message : String(error)}`)
            }
        }
        throw lastError instanceof Error ? lastError : new Error(String(lastError))
    }

    private titleOf(session: VoiceSessionView): string {
        return session.metadata?.name?.trim()
            || this.deps.getDigest(session.id)?.title
            || session.metadata?.summary?.text?.trim()
            || session.id.slice(0, 8)
    }

    private materialFor(session: VoiceSessionView, messageLimit: number, fullTranscript?: boolean): string {
        return buildSessionMaterial({
            session,
            digest: this.deps.getDigest(session.id),
            project: this.deps.getProject(session),
            messages: this.deps.getRecentMessages(session.id, messageLimit),
            now: this.now(),
            fullTranscript
        })
    }

    /**
     * 问进度。第一轮给模型当前会话的详细材料和其他可见会话的索引：问当前会话、或索引够用就直接答；
     * 问别的工作而索引不够时，模型点名最多两个会话，第二轮带上它们的详细材料再答。
     */
    async ask(params: {
        sessionId: string
        question: string
        history?: VoiceTurn[]
        candidates?: VoiceSessionView[]
        mode?: 'voice' | 'evidence'
    }): Promise<{ answer: string; model: string; ms: number; sessions: string[] }> {
        const startedAt = this.now()
        const history = (params.history ?? []).slice(-MAX_HISTORY_TURNS)
        if (params.mode === 'evidence') {
            const current = this.deps.getSession(params.sessionId)
            if (!current) throw new Error('Session not found')
            const material = this.materialFor(current, QA_MESSAGES, true)
            const { text, model } = await this.complete(EVIDENCE_QA_SYSTEM_PROMPT, buildQaDetailPrompt({
                now: this.now(),
                materials: [{ title: this.titleOf(current), material }],
                history,
                question: params.question
            }), 900)
            return { answer: text, model, ms: this.now() - startedAt, sessions: [current.id] }
        }
        const current = params.candidates?.find((session) => session.id === params.sessionId) ?? this.deps.getSession(params.sessionId)
        if (!current) throw new Error('Session not found')

        const others = (params.candidates ?? []).filter((session) => session.id !== current.id)
        const running = others.filter((session) => session.active !== false && session.thinking)
        const recent = others
            .filter((session) => !running.includes(session))
            .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
            .slice(0, INDEX_RECENT)
        const indexed = [...running, ...recent]
        const index = indexed.map((session) => describeSessionForIndex(session, this.deps.getDigest(session.id), startedAt)).join('\n')

        const first = await this.complete(QA_ROUTER_SYSTEM_PROMPT, buildQaRouterPrompt({
            now: startedAt,
            currentMaterial: this.materialFor(current, QA_MESSAGES),
            index,
            history,
            question: params.question
        }), 500)
        const parsed = parseJsonObject(first.text)
        // A model that ignores the JSON format still produced a usable spoken answer.
        if (!parsed) {
            if (!first.text) throw new Error('Model returned an empty answer')
            return { answer: first.text, model: first.model, ms: this.now() - startedAt, sessions: [current.id] }
        }
        const answer = typeof parsed.answer === 'string' ? parsed.answer.trim() : ''
        const wanted = (Array.isArray(parsed.details) ? parsed.details : [])
            .filter((id): id is string => typeof id === 'string')
            .map((id) => id.replace(/[[\]\s]/g, ''))
            .filter((id) => id.length >= 4)
        const detailSessions = wanted
            .map((id) => [current, ...indexed].find((session) => session.id.startsWith(id)))
            .filter((session): session is VoiceSessionView => session !== undefined)
            .filter((session, i, all) => all.findIndex((other) => other.id === session.id) === i)
            .slice(0, MAX_DETAIL_SESSIONS)

        if (detailSessions.length === 0) {
            if (!answer) throw new Error('Model returned an empty answer')
            return { answer, model: first.model, ms: this.now() - startedAt, sessions: [current.id] }
        }

        const second = await this.complete(QA_DETAIL_SYSTEM_PROMPT, buildQaDetailPrompt({
            now: startedAt,
            materials: detailSessions.map((session) => ({ title: this.titleOf(session), material: this.materialFor(session, DETAIL_MESSAGES) })),
            history,
            question: params.question
        }), 500)
        if (!second.text) throw new Error('Model returned an empty answer')
        return { answer: second.text, model: second.model, ms: this.now() - startedAt, sessions: detailSessions.map((session) => session.id) }
    }

    /**
     * 目标会话由代码决定：没说别的会话就是当前会话；说了就先按 id 前缀 / 名字精确找，
     * 找不到唯一一个再请模型从在线会话里挑，模型没把握时把候选交回给用户选。
     */
    private async resolveTarget(params: {
        currentSessionId: string
        targetHint?: string
        candidates: VoiceSessionView[]
    }): Promise<{ kind: 'one'; session: VoiceSessionView } | { kind: 'many'; sessions: VoiceSessionView[] } | { kind: 'none' }> {
        const hint = params.targetHint?.trim()
        if (!hint) {
            const current = params.candidates.find((session) => session.id === params.currentSessionId)
                ?? this.deps.getSession(params.currentSessionId)
            return current ? { kind: 'one', session: current } : { kind: 'none' }
        }

        const online = params.candidates
            .filter((session) => session.active !== false)
            .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
            .slice(0, MAX_CANDIDATES)

        const idMatch = /^[0-9a-f]{4,}$/i.test(hint)
            ? online.filter((session) => session.id.toLowerCase().startsWith(hint.toLowerCase()))
            : []
        if (idMatch.length === 1) return { kind: 'one', session: idMatch[0]! }

        const compact = (text: string) => text.replace(/\s+/g, '').toLowerCase()
        const nameMatch = online.filter((session) => {
            const title = compact(this.titleOf(session))
            return title.length >= 2 && (title.includes(compact(hint)) || compact(hint).includes(title))
        })
        if (nameMatch.length === 1) return { kind: 'one', session: nameMatch[0]! }

        if (online.length === 0) return { kind: 'none' }
        const listing = online.map((session) => describeSessionForTargeting(session, this.deps.getDigest(session.id))).join('\n')
        const current = this.deps.getSession(params.currentSessionId)
        const { text } = await this.complete(TARGET_SYSTEM_PROMPT, buildTargetPrompt({
            hint,
            listing,
            currentLine: current ? describeSessionForTargeting(current, this.deps.getDigest(current.id)) : null
        }), 200)
        const parsed = parseJsonObject(text)
        const ids = Array.isArray(parsed?.matches) ? parsed.matches.filter((id): id is string => typeof id === 'string') : []
        const matched = ids
            .map((id) => id.replace(/[[\]\s]/g, ''))
            .filter((id) => id.length >= 4)
            .map((id) => online.find((session) => session.id.startsWith(id)))
            .filter((session): session is VoiceSessionView => session !== undefined)
            .filter((session, index, all) => all.findIndex((other) => other.id === session.id) === index)
            .slice(0, 3)
        if (matched.length === 0) return { kind: 'none' }
        if (matched.length === 1 && parsed?.confident === true) return { kind: 'one', session: matched[0]! }
        return { kind: 'many', sessions: matched }
    }

    async prepareInstruction(params: {
        currentSessionId: string
        utterance: string
        targetHint?: string
        history?: VoiceTurn[]
        candidates: VoiceSessionView[]
    }): Promise<PrepareResult> {
        const resolved = await this.resolveTarget(params)
        if (resolved.kind === 'none') {
            return { status: 'no_target', ask: '没找到你说的那个会话，能说一下它的名字吗？' }
        }
        if (resolved.kind === 'many') {
            const candidates = resolved.sessions.map((session) => ({ id: session.id, title: this.titleOf(session) }))
            return {
                status: 'ambiguous',
                candidates,
                ask: `你指的是哪一个：${candidates.map((candidate) => `《${candidate.title}》`).join('、')}？`
            }
        }

        const session = resolved.session
        const target = { id: session.id, title: this.titleOf(session) }
        if (session.active === false) return { status: 'target_inactive', target }

        const { text, model } = await this.complete(NORMALIZE_SYSTEM_PROMPT, buildNormalizePrompt({
            targetMaterial: this.materialFor(session, TARGET_MESSAGES),
            utterance: params.utterance,
            history: (params.history ?? []).slice(-MAX_HISTORY_TURNS)
        }), 700)
        const parsed = parseJsonObject(text)
        const instruction = typeof parsed?.instruction === 'string' ? parsed.instruction.trim() : ''
        const ask = typeof parsed?.ask === 'string' && parsed.ask.trim() && parsed.ask.trim() !== 'null' ? parsed.ask.trim() : null
        if (ask) return { status: 'need_info', target, ask }
        if (!instruction) throw new Error('Model did not return an instruction')
        const readback = typeof parsed?.readback === 'string' && parsed.readback.trim() ? parsed.readback.trim() : instruction.slice(0, 40)
        const targetBusy = session.thinking === true
        // Interrupting only matters while the target is working; anything unclear waits its turn.
        const delivery: VoiceDelivery = targetBusy && parsed?.delivery === 'steer' ? 'steer' : 'queue'
        const deliveryReason = typeof parsed?.deliveryReason === 'string' ? parsed.deliveryReason.trim().slice(0, 30) : ''
        return { status: 'ready', target, instruction, readback, original: params.utterance, model, delivery, deliveryReason, targetBusy }
    }
}

let instance: VoiceAssistant | null = null

export function getVoiceAssistant(): VoiceAssistant | null {
    return instance
}

function envFlag(name: string, fallback: boolean): boolean {
    const raw = process.env[name]?.trim().toLowerCase()
    if (!raw) return fallback
    return raw === '1' || raw === 'true' || raw === 'on'
}

/**
 * 模型来源（按顺序）：
 *   HAPI_VOICE_QA_API_URL / _API_KEY / _MODEL（默认 deepseek-flash，关思考，8 秒超时）
 *   HAPI_DIGEST_API_URL / _API_KEY + HAPI_VOICE_QA_FALLBACK_MODEL（默认 gpt-6-luna，20 秒超时）
 * 都没配时服务照常创建，接口返回 503。
 */
export function buildVoiceProvidersFromEnv(fetchImpl?: typeof fetch): VoiceLlmProvider[] {
    const providers: VoiceLlmProvider[] = []
    const primaryUrl = process.env.HAPI_VOICE_QA_API_URL?.trim()
    const primaryKey = process.env.HAPI_VOICE_QA_API_KEY?.trim()
    if (primaryUrl && primaryKey) {
        const disableThinking = envFlag('HAPI_VOICE_QA_DISABLE_THINKING', true)
        providers.push({
            label: 'primary',
            model: process.env.HAPI_VOICE_QA_MODEL?.trim() || 'deepseek-flash',
            call: createLlmCall({
                baseUrl: primaryUrl,
                apiKey: primaryKey,
                fetchImpl,
                timeoutMs: Number(process.env.HAPI_VOICE_QA_TIMEOUT_MS) || 8_000,
                extraBody: disableThinking ? { thinking: { type: 'disabled' } } : undefined
            })
        })
    }
    const fallbackUrl = process.env.HAPI_DIGEST_API_URL?.trim()
    const fallbackKey = process.env.HAPI_DIGEST_API_KEY?.trim()
    if (fallbackUrl && fallbackKey && process.env.HAPI_VOICE_QA_FALLBACK_MODEL?.trim() !== 'none') {
        providers.push({
            label: 'fallback',
            model: process.env.HAPI_VOICE_QA_FALLBACK_MODEL?.trim() || 'gpt-6-luna',
            call: createLlmCall({ baseUrl: fallbackUrl, apiKey: fallbackKey, fetchImpl, timeoutMs: 20_000 })
        })
    }
    return providers
}

export function startVoiceAssistant(deps: Omit<VoiceAssistantDeps, 'providers'> & { providers?: VoiceLlmProvider[] }): VoiceAssistant {
    instance = new VoiceAssistant({ ...deps, providers: deps.providers ?? buildVoiceProvidersFromEnv() })
    return instance
}
