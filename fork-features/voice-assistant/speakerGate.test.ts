import { describe, expect, it } from 'bun:test'
import { SpeakerGate, type SpeakerGateDeps } from './speakerGate'
import type { SpeakerGateRecord } from './speaker'

const OWNER = [1, 0]
const STRANGER = [0, 1]
const AMBIGUOUS = [0.3, Math.sqrt(1 - 0.09)]

/** Steady "speech" (every frame well above the noise floor), so silence removal keeps all of it. */
function audioFrame(ms: number): string {
    return JSON.stringify({ type: 'input_audio_buffer.append', audio: Buffer.alloc(ms * 32, 7).toString('base64') })
}

function silenceFrame(ms: number): string {
    return JSON.stringify({ type: 'input_audio_buffer.append', audio: Buffer.alloc(ms * 32, 0).toString('base64') })
}

/** Bytes sent for scoring `ms` of speech: whole 30 ms frames only. */
const voiced = (ms: number) => Math.floor(ms * 32 / 960) * 960

function event(type: string, extra: Record<string, unknown> = {}): string {
    return JSON.stringify({ type, ...extra })
}

function setup(embeddings: Array<number[] | null>, overrides: Partial<SpeakerGateDeps> = {}) {
    const upstream: Array<Record<string, unknown>> = []
    const client: Array<Record<string, unknown>> = []
    const records: SpeakerGateRecord[] = []
    const embedded: number[] = []
    const queue = [...embeddings]
    const gate = new SpeakerGate({
        mode: 'enforce',
        threshold: 0.4,
        voiceprint: { vectors: [OWNER], source: 'test', updatedAt: '' },
        embed: async (pcm) => {
            embedded.push(pcm.byteLength)
            return queue.length > 0 ? queue.shift()! : null
        },
        sendUpstream: (e) => upstream.push(e),
        sendClient: (raw) => client.push(JSON.parse(raw) as Record<string, unknown>),
        onDecision: (record) => records.push(record),
        ...overrides
    })
    return { gate, upstream, client, records, embedded }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('SpeakerGate', () => {
    it('lets the owner through as soon as two seconds identify them, and asks for the reply after commit', async () => {
        const { gate, upstream, client, records, embedded } = setup([OWNER])
        expect(gate.upstream(event('input_audio_buffer.speech_started', { item_id: 'u1', audio_start_ms: 0 }))).toBe(true)
        gate.clientFrame(audioFrame(1_500))
        await settle()
        expect(embedded).toEqual([])
        expect(client).toEqual([])
        gate.clientFrame(audioFrame(1_000))
        await settle()
        expect(embedded).toEqual([voiced(2_000)])
        expect(client).toEqual([{ type: 'input_audio_buffer.speech_started', item_id: 'u1', audio_start_ms: 0, hapi_verified: true }])
        gate.upstream(event('input_audio_buffer.speech_stopped', { item_id: 'u1', audio_end_ms: 3_000 }))
        gate.upstream(event('input_audio_buffer.committed', { item_id: 'u1' }))
        gate.upstream(event('conversation.item.input_audio_transcription.completed', { item_id: 'u1', transcript: '进度怎么样' }))
        expect(client.map((e) => e.type)).toEqual([
            'input_audio_buffer.speech_started',
            'input_audio_buffer.speech_stopped',
            'input_audio_buffer.committed',
            'conversation.item.input_audio_transcription.completed'
        ])
        expect(upstream).toEqual([{ type: 'response.create' }])
        expect(records).toMatchObject([{ decision: 'accept', score: 1, reason: 'voiceprint match (early)', enforced: true }])
    })

    it('silently drops another voice and deletes its turn from the conversation', async () => {
        const { gate, upstream, client, records } = setup([STRANGER, STRANGER])
        gate.upstream(event('input_audio_buffer.speech_started', { item_id: 'x1', audio_start_ms: 0 }))
        gate.clientFrame(audioFrame(2_500))
        await settle()
        gate.upstream(event('input_audio_buffer.speech_stopped', { item_id: 'x1', audio_end_ms: 2_500 }))
        gate.upstream(event('input_audio_buffer.committed', { item_id: 'x1' }))
        await settle()
        gate.upstream(event('conversation.item.created', { item: { id: 'x1', role: 'user' } }))
        gate.upstream(event('conversation.item.input_audio_transcription.completed', { item_id: 'x1', transcript: '别人说的话' }))
        gate.upstream(event('conversation.item.deleted', { item_id: 'x1' }))
        expect(client).toEqual([])
        expect(upstream).toEqual([{ type: 'conversation.item.delete', item_id: 'x1' }])
        expect(records).toMatchObject([{ decision: 'reject', score: 0, reason: 'voiceprint mismatch' }])
    })

    it('never rejects on the early check alone', async () => {
        const { gate, client, records } = setup([STRANGER, OWNER])
        gate.upstream(event('input_audio_buffer.speech_started', { item_id: 'u2', audio_start_ms: 0 }))
        gate.clientFrame(audioFrame(3_000))
        await settle()
        expect(records).toEqual([])
        gate.upstream(event('input_audio_buffer.speech_stopped', { item_id: 'u2', audio_end_ms: 3_000 }))
        await settle()
        expect(records).toMatchObject([{ decision: 'accept', reason: 'voiceprint match' }])
        expect(client.map((e) => e.type)).toEqual(['input_audio_buffer.speech_started', 'input_audio_buffer.speech_stopped'])
    })

    it('rejects a borderline voice once the whole turn scores below the threshold', async () => {
        const { gate, upstream, client } = setup([AMBIGUOUS, AMBIGUOUS])
        gate.upstream(event('input_audio_buffer.speech_started', { item_id: 'x2', audio_start_ms: 0 }))
        gate.clientFrame(audioFrame(2_000))
        await settle()
        gate.upstream(event('input_audio_buffer.speech_stopped', { item_id: 'x2', audio_end_ms: 2_000 }))
        gate.upstream(event('input_audio_buffer.committed', { item_id: 'x2' }))
        await settle()
        expect(client).toEqual([])
        expect(upstream).toEqual([{ type: 'conversation.item.delete', item_id: 'x2' }])
    })

    it('judges a long turn on its first seconds', async () => {
        const { gate, embedded } = setup([AMBIGUOUS, OWNER])
        gate.upstream(event('input_audio_buffer.speech_started', { item_id: 'u8', audio_start_ms: 0 }))
        gate.clientFrame(audioFrame(20_000))
        gate.upstream(event('input_audio_buffer.speech_stopped', { item_id: 'u8', audio_end_ms: 20_000 }))
        await settle()
        expect(embedded).toEqual([voiced(2_000), voiced(6_000)])
    })

    it('keeps a stranger who talks at length out instead of timing them through', async () => {
        let now = 1_000
        const { gate, client, upstream, records } = setup([STRANGER, STRANGER], { now: () => now })
        gate.upstream(event('input_audio_buffer.speech_started', { item_id: 'x5', audio_start_ms: 0 }))
        for (let second = 0; second < 12; second += 1) {
            gate.clientFrame(audioFrame(1_000))
            now += 1_000
            gate.upstream(event('conversation.item.input_audio_transcription.delta', { item_id: 'x5', delta: '啊' }))
        }
        await settle()
        expect(records).toEqual([])
        gate.upstream(event('input_audio_buffer.speech_stopped', { item_id: 'x5', audio_end_ms: 12_000 }))
        gate.upstream(event('input_audio_buffer.committed', { item_id: 'x5' }))
        await settle()
        expect(records).toMatchObject([{ decision: 'reject' }])
        expect(client).toEqual([])
        expect(upstream).toEqual([{ type: 'conversation.item.delete', item_id: 'x5' }])
    })

    it('scores speech only, leaving out the silence around it', async () => {
        const { gate, embedded } = setup([OWNER])
        gate.upstream(event('input_audio_buffer.speech_started', { item_id: 'u9', audio_start_ms: 0 }))
        gate.clientFrame(silenceFrame(600))
        gate.clientFrame(audioFrame(1_400))
        gate.clientFrame(silenceFrame(1_000))
        gate.upstream(event('input_audio_buffer.speech_stopped', { item_id: 'u9', audio_end_ms: 3_000 }))
        await settle()
        const sent = embedded.at(-1)!
        expect(Math.abs(sent - 1_400 * 32)).toBeLessThanOrEqual(2 * 960)
    })

    it('lets very short turns through without scoring them', async () => {
        const { gate, upstream, client, records, embedded } = setup([])
        gate.upstream(event('input_audio_buffer.speech_started', { item_id: 'u3', audio_start_ms: 0 }))
        gate.clientFrame(audioFrame(500))
        gate.upstream(event('input_audio_buffer.speech_stopped', { item_id: 'u3', audio_end_ms: 500 }))
        gate.upstream(event('input_audio_buffer.committed', { item_id: 'u3' }))
        await settle()
        expect(embedded).toEqual([])
        expect(client).toHaveLength(3)
        expect(upstream).toEqual([{ type: 'response.create' }])
        expect(records).toMatchObject([{ decision: 'accept', score: null, reason: 'too short to judge' }])
    })

    it('fails open when the voiceprint service does not answer', async () => {
        const { gate, upstream, client, records } = setup([null, null])
        gate.upstream(event('input_audio_buffer.speech_started', { item_id: 'u4', audio_start_ms: 0 }))
        gate.clientFrame(audioFrame(2_000))
        gate.upstream(event('input_audio_buffer.speech_stopped', { item_id: 'u4', audio_end_ms: 2_000 }))
        gate.upstream(event('input_audio_buffer.committed', { item_id: 'u4' }))
        await settle()
        await settle()
        expect(client).toHaveLength(3)
        expect(upstream).toEqual([{ type: 'response.create' }])
        expect(records).toMatchObject([{ decision: 'accept', reason: 'voiceprint service unavailable' }])
    })

    it('only records the verdict in observe mode', async () => {
        const { gate, upstream, client, records } = setup([STRANGER, STRANGER], { mode: 'observe' })
        gate.upstream(event('input_audio_buffer.speech_started', { item_id: 'x3', audio_start_ms: 0 }))
        gate.clientFrame(audioFrame(2_500))
        gate.upstream(event('input_audio_buffer.speech_stopped', { item_id: 'x3', audio_end_ms: 2_500 }))
        await settle()
        gate.upstream(event('input_audio_buffer.committed', { item_id: 'x3' }))
        expect(client.map((e) => e.type)).toEqual(['input_audio_buffer.speech_started', 'input_audio_buffer.speech_stopped', 'input_audio_buffer.committed'])
        expect(upstream).toEqual([{ type: 'response.create' }])
        expect(records).toMatchObject([{ decision: 'reject', score: 0, enforced: false }])
    })

    it('interrupts a reply in progress only for the verified speaker', async () => {
        const { gate, upstream } = setup([STRANGER, STRANGER, OWNER])
        gate.upstream(event('response.created', { response: { id: 'r1' } }))
        gate.upstream(event('input_audio_buffer.speech_started', { item_id: 'x4', audio_start_ms: 0 }))
        gate.clientFrame(audioFrame(2_500))
        gate.upstream(event('input_audio_buffer.speech_stopped', { item_id: 'x4', audio_end_ms: 2_500 }))
        await settle()
        expect(upstream).toEqual([])
        gate.upstream(event('input_audio_buffer.speech_started', { item_id: 'u5', audio_start_ms: 3_000 }))
        gate.clientFrame(audioFrame(2_500))
        await settle()
        expect(upstream).toEqual([{ type: 'response.cancel' }])
    })

    it('scores the audio of the turn itself, not what came before it', async () => {
        const { gate, embedded } = setup([OWNER])
        gate.clientFrame(audioFrame(5_000))
        gate.upstream(event('input_audio_buffer.speech_started', { item_id: 'u6', audio_start_ms: 4_000 }))
        gate.clientFrame(audioFrame(1_000))
        await settle()
        expect(embedded).toEqual([voiced(2_000)])
    })

    it('lets a turn through when no verdict arrives in time after the speaker stops', async () => {
        let now = 1_000
        const { gate, client, records } = setup([], { embed: () => new Promise(() => {}), now: () => now })
        gate.upstream(event('input_audio_buffer.speech_started', { item_id: 'u7', audio_start_ms: 0 }))
        gate.clientFrame(audioFrame(2_000))
        gate.upstream(event('input_audio_buffer.speech_stopped', { item_id: 'u7', audio_end_ms: 2_000 }))
        now += 6_000
        gate.upstream(event('input_audio_buffer.committed', { item_id: 'u7' }))
        expect(client.map((e) => e.type)).toEqual(['input_audio_buffer.speech_started', 'input_audio_buffer.speech_stopped', 'input_audio_buffer.committed'])
        expect(records).toMatchObject([{ decision: 'accept', reason: 'timeout' }])
    })

    it('takes the item being created as the turn entering the conversation, and acts on it once', async () => {
        const owner = setup([OWNER])
        owner.gate.upstream(event('input_audio_buffer.speech_started', { item_id: 'u10', audio_start_ms: 0 }))
        owner.gate.clientFrame(audioFrame(2_500))
        await settle()
        owner.gate.upstream(event('input_audio_buffer.speech_stopped', { item_id: 'u10', audio_end_ms: 2_500 }))
        owner.gate.upstream(event('conversation.item.created', { item: { id: 'u10', role: 'user' } }))
        owner.gate.upstream(event('input_audio_buffer.committed', { item_id: 'u10' }))
        expect(owner.upstream).toEqual([{ type: 'response.create' }])

        const stranger = setup([STRANGER, STRANGER])
        stranger.gate.upstream(event('input_audio_buffer.speech_started', { item_id: 'x6', audio_start_ms: 0 }))
        stranger.gate.clientFrame(audioFrame(2_500))
        stranger.gate.upstream(event('input_audio_buffer.speech_stopped', { item_id: 'x6', audio_end_ms: 2_500 }))
        stranger.gate.upstream(event('conversation.item.created', { item: { id: 'x6', role: 'user' } }))
        await settle()
        stranger.gate.upstream(event('input_audio_buffer.committed', { item_id: 'x6' }))
        expect(stranger.upstream).toEqual([{ type: 'conversation.item.delete', item_id: 'x6' }])
        expect(stranger.client).toEqual([])
    })

    it('passes through events that belong to no user turn', () => {
        const { gate } = setup([])
        expect(gate.upstream(event('response.text.delta', { delta: '好' }))).toBe(false)
        expect(gate.upstream(event('session.updated'))).toBe(false)
        expect(gate.upstream('not json')).toBe(false)
    })
})
