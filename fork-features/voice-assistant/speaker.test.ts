import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildEnrollment, embedSpeaker, speakerScore, voicedPcm, VoiceprintStore } from './speaker'

let dir: string
const savedEnv = {
    gate: process.env.HAPI_VOICE_SPEAKER_GATE,
    threshold: process.env.HAPI_VOICE_SPEAKER_THRESHOLD,
    url: process.env.HAPI_VOICE_TTS_URL,
    token: process.env.HAPI_VOICE_TTS_TOKEN
}

function restore(name: string, value: string | undefined) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
}

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hapi-voiceprint-'))
    delete process.env.HAPI_VOICE_SPEAKER_GATE
    delete process.env.HAPI_VOICE_SPEAKER_THRESHOLD
})

afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    restore('HAPI_VOICE_SPEAKER_GATE', savedEnv.gate)
    restore('HAPI_VOICE_SPEAKER_THRESHOLD', savedEnv.threshold)
    restore('HAPI_VOICE_TTS_URL', savedEnv.url)
    restore('HAPI_VOICE_TTS_TOKEN', savedEnv.token)
})

/** PCM with `seconds` of a 200 Hz tone at `amplitude`, 16 kHz s16le. */
function tone(seconds: number, amplitude: number): Uint8Array {
    const samples = Math.round(seconds * 16_000)
    const out = new Uint8Array(samples * 2)
    const view = new DataView(out.buffer)
    for (let i = 0; i < samples; i += 1) view.setInt16(i * 2, Math.round(amplitude * Math.sin(2 * Math.PI * 200 * i / 16_000)), true)
    return out
}

function concat(...parts: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0))
    let offset = 0
    for (const part of parts) {
        out.set(part, offset)
        offset += part.byteLength
    }
    return out
}

describe('VoiceprintStore', () => {
    it('falls back to the imported owner voiceprint for admins only, until they enroll in hapi', () => {
        writeFileSync(join(dir, 'voice-owner-voiceprints.json'), JSON.stringify({ extractedAt: '2026-10-13', items: [{ vectors: [[3, 4]] }, { vectors: [[0, 2]] }] }))
        const store = new VoiceprintStore(dir)
        expect(store.get(1, true)).toMatchObject({ vectors: [[0.6, 0.8], [0, 1]], source: 'recording-helper owner voiceprint' })
        expect(store.get(2, false)).toBeNull()
        expect(store.hasOwn(1)).toBe(false)

        store.add(1, [[1, 0]], 'hapi web enrollment')
        expect(store.get(1, true)).toMatchObject({ vectors: [[1, 0]], source: 'hapi web enrollment' })
        expect(new VoiceprintStore(dir).get(1, true)?.vectors).toEqual([[1, 0]])
        expect(store.hasOwn(1)).toBe(true)

        store.clear(1)
        expect(store.get(1, true)?.source).toBe('recording-helper owner voiceprint')
    })

    it('scores against the closest enrolled sample', () => {
        expect(speakerScore([1, 0], { vectors: [[0, 1], [0.8, 0.6]], source: '', updatedAt: '' })).toBeCloseTo(0.8)
    })

    it('reads the gate switch from the data dir first, then the environment', () => {
        const store = new VoiceprintStore(dir)
        expect(store.gateConfig()).toEqual({ mode: 'observe', threshold: 0.4 })
        process.env.HAPI_VOICE_SPEAKER_GATE = 'enforce'
        process.env.HAPI_VOICE_SPEAKER_THRESHOLD = '0.5'
        expect(store.gateConfig()).toEqual({ mode: 'enforce', threshold: 0.5 })
        writeFileSync(join(dir, 'voice-speaker-gate.json'), JSON.stringify({ mode: 'off', threshold: 0.35 }))
        expect(store.gateConfig()).toEqual({ mode: 'off', threshold: 0.35 })
        writeFileSync(join(dir, 'voice-speaker-gate.json'), JSON.stringify({ mode: 'nonsense', threshold: 7 }))
        expect(store.gateConfig()).toEqual({ mode: 'enforce', threshold: 0.5 })
    })

    it('keeps the recent verdicts per account', () => {
        const store = new VoiceprintStore(dir)
        for (let i = 0; i < 35; i += 1) store.recordDecision(1, { at: i, seconds: 1, score: 0.5, decision: 'accept', reason: '', enforced: false })
        expect(store.recentDecisions(1)).toHaveLength(30)
        expect(store.recentDecisions(1)[0]?.at).toBe(5)
        expect(store.recentDecisions(2)).toEqual([])
    })
})

describe('voiceprint enrollment', () => {
    it('drops the silence before windowing', () => {
        const pcm = concat(tone(1, 50), tone(2, 8_000), tone(1, 50))
        const voiced = voicedPcm(pcm).byteLength
        // 30 ms frames: the two frames straddling the edges of the tone may go either way.
        expect(voiced % 960).toBe(0)
        expect(Math.abs(voiced - 2 * 32_000)).toBeLessThanOrEqual(2 * 960)
    })

    it('needs a few seconds of actual speech', async () => {
        expect(await buildEnrollment(concat(tone(10, 30), tone(2, 8_000)), async () => [1, 0])).toMatchObject({ ok: false, reason: 'too-little-speech' })
    })

    it('averages the windows of one voice into a single sample', async () => {
        const calls: number[] = []
        const result = await buildEnrollment(tone(10, 8_000), async (pcm) => {
            calls.push(pcm.byteLength)
            return calls.length % 2 === 0 ? [1, 0.2] : [1, -0.2]
        })
        expect(calls.every((bytes) => bytes === 3 * 32_000)).toBe(true)
        expect(calls).toHaveLength(4)
        expect(result).toMatchObject({ ok: true, windows: 4 })
        if (result.ok) {
            expect(result.centroid[0]).toBeCloseTo(1)
            expect(result.consistency).toBeGreaterThan(0.9)
        }
    })

    it('refuses a recording whose windows sound like different people', async () => {
        let n = 0
        const result = await buildEnrollment(tone(10, 8_000), async () => (n++ % 2 === 0 ? [1, 0] : [-0.2, 1]))
        expect(result).toMatchObject({ ok: false, reason: 'inconsistent' })
    })

    it('reports an unreachable voiceprint service', async () => {
        expect(await buildEnrollment(tone(10, 8_000), async () => null)).toMatchObject({ ok: false, reason: 'service-unavailable' })
    })
})

describe('embedSpeaker', () => {
    it('posts raw PCM with the voice token and returns the embedding', async () => {
        process.env.HAPI_VOICE_TTS_URL = 'http://127.0.0.1:13019/'
        process.env.HAPI_VOICE_TTS_TOKEN = 'secret-token'
        const seen: Array<{ url: string; token: string | null; bytes: number }> = []
        const fetchImpl = (async (url: string, init: RequestInit) => {
            seen.push({ url, token: new Headers(init.headers).get('x-voice-token'), bytes: (init.body as Uint8Array).byteLength })
            return Response.json({ embedding: [0.6, 0.8] })
        }) as unknown as typeof fetch
        expect(await embedSpeaker(new Uint8Array(32_000), fetchImpl)).toEqual([0.6, 0.8])
        expect(seen).toEqual([{ url: 'http://127.0.0.1:13019/speaker/embed', token: 'secret-token', bytes: 32_000 }])
    })

    it('returns null when not configured or the service fails', async () => {
        delete process.env.HAPI_VOICE_TTS_URL
        expect(await embedSpeaker(new Uint8Array(10))).toBeNull()
        process.env.HAPI_VOICE_TTS_URL = 'http://127.0.0.1:13019'
        process.env.HAPI_VOICE_TTS_TOKEN = 't'
        const failing = (async () => new Response('bad', { status: 400 })) as unknown as typeof fetch
        expect(await embedSpeaker(new Uint8Array(10), failing)).toBeNull()
    })
})
