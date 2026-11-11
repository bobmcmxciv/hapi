import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VOXCPM_VOICE_CATALOG, getVoiceTtsLanAccess, getVoiceTtsStatus, proxyVoiceTts, serveVoiceTtsLanCert, signVoiceTtsTicket } from './tts'

const saved = { url: process.env.HAPI_VOICE_TTS_URL, token: process.env.HAPI_VOICE_TTS_TOKEN }

beforeEach(() => {
    process.env.HAPI_VOICE_TTS_URL = 'http://127.0.0.1:13019/'
    process.env.HAPI_VOICE_TTS_TOKEN = 'secret-token'
})

afterEach(() => {
    if (saved.url === undefined) delete process.env.HAPI_VOICE_TTS_URL
    else process.env.HAPI_VOICE_TTS_URL = saved.url
    if (saved.token === undefined) delete process.env.HAPI_VOICE_TTS_TOKEN
    else process.env.HAPI_VOICE_TTS_TOKEN = saved.token
})

describe('voice TTS relay', () => {
    it('reports unavailable without configuration', async () => {
        delete process.env.HAPI_VOICE_TTS_URL
        expect(await getVoiceTtsStatus()).toMatchObject({ available: false, reason: 'not configured' })
    })

    it('reports the service health and caches it briefly', async () => {
        let calls = 0
        const fetchImpl = (async () => {
            calls += 1
            return Response.json({ ok: true, voice: 'manbo', sampleRate: 32000 })
        }) as unknown as typeof fetch
        const now = 5_000_000
        expect(await getVoiceTtsStatus(fetchImpl, now)).toEqual({ available: true, voice: 'manbo', sampleRate: 32000 })
        expect(await getVoiceTtsStatus(fetchImpl, now + 1_000)).toMatchObject({ available: true })
        expect(calls).toBe(1)
        expect(await getVoiceTtsStatus(fetchImpl, now + 60_000)).toMatchObject({ available: true })
        expect(calls).toBe(2)
    })

    it('surfaces available VoxCPM multi-voice list and engine from health check', async () => {
        const fetchImpl = (async () => {
            return Response.json({
                ok: true,
                voice: 'manbo',
                engine: 'voxcpm2',
                sampleRate: 16000,
                voices: VOXCPM_VOICE_CATALOG,
            })
        }) as unknown as typeof fetch
        const status = await getVoiceTtsStatus(fetchImpl, 9_000_000)
        expect(status).toEqual({
            available: true,
            voice: 'manbo',
            engine: 'voxcpm2',
            sampleRate: 16000,
            voices: [...VOXCPM_VOICE_CATALOG],
        })
        expect(status.voices?.length).toBe(94)
        const ids = status.voices?.map((v) => v.id) ?? []
        expect(ids.slice(0, 12)).toEqual([
            'manbo', 'nian', 'dusk', 'almond', 'skadi2', 'aglina',
            'surtr', 'helage', 'mizuki', 'kalts', 'amiya', 'closur',
        ])
        expect(ids).toContain('wisadel')
        expect(ids).toContain('perlica')
        expect(ids).toContain('furina')
        expect(ids).toContain('firefly')
        expect(ids).toContain('sunchang')
        expect(ids).toContain('jinlei')
    })

    it('forwards text with the server-side token and streams the audio back', async () => {
        const seen: Array<{ url: string; token: string | null; body: string }> = []
        const fetchImpl = (async (url: string, init: RequestInit) => {
            seen.push({ url, token: new Headers(init.headers).get('X-Voice-Token'), body: String(init.body) })
            return new Response(new Uint8Array([1, 0, 2, 0]), { headers: { 'x-sample-rate': '32000', 'x-audio-format': 's16le' } })
        }) as unknown as typeof fetch
        const response = await proxyVoiceTts('  你好。 ', undefined, fetchImpl)
        expect(response.status).toBe(200)
        expect(response.headers.get('x-sample-rate')).toBe('32000')
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 0, 2, 0]))
        expect(seen).toEqual([{ url: 'http://127.0.0.1:13019/tts', token: 'secret-token', body: JSON.stringify({ text: '你好。' }) }])
    })

    it('forwards optional voice id to upstream /tts endpoint', async () => {
        const seen: Array<{ body: string }> = []
        const fetchImpl = (async (_url: string, init: RequestInit) => {
            seen.push({ body: String(init.body) })
            return new Response(new Uint8Array([1, 0]), {
                headers: { 'x-sample-rate': '16000', 'x-audio-format': 's16le', 'x-voice-id': 'nian' }
            })
        }) as unknown as typeof fetch
        const response = await proxyVoiceTts('来吃火锅！', undefined, fetchImpl, 'nian')
        expect(response.status).toBe(200)
        expect(response.headers.get('x-voice-id')).toBe('nian')
        expect(seen).toEqual([{ body: JSON.stringify({ text: '来吃火锅！', voice: 'nian' }) }])
    })

    it('answers 502 when the service is unreachable so the browser can fall back', async () => {
        const fetchImpl = (async () => { throw new Error('connect ECONNREFUSED') }) as unknown as typeof fetch
        const response = await proxyVoiceTts('你好', undefined, fetchImpl)
        expect(response.status).toBe(502)
        expect(await response.text()).toContain('ECONNREFUSED')
    })

    it('cancels the upstream request when the browser goes away', async () => {
        const client = new AbortController()
        let upstreamSignal: AbortSignal | undefined
        const fetchImpl = ((_url: string, init: RequestInit) => {
            upstreamSignal = init.signal ?? undefined
            return new Promise<Response>((_resolve, reject) => {
                init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
            })
        }) as unknown as typeof fetch
        const pending = proxyVoiceTts('你好', client.signal, fetchImpl)
        client.abort()
        expect((await pending).status).toBe(502)
        expect(upstreamSignal?.aborted).toBe(true)
    })
})

describe('voice TTS LAN direct access', () => {
    afterEach(() => { delete process.env.HAPI_VOICE_TTS_LAN_URL })

    it('only offers LAN access when a LAN URL is configured, with a 30-minute ticket bound to the service token', () => {
        expect(getVoiceTtsLanAccess(1_000_000)).toBeNull()
        process.env.HAPI_VOICE_TTS_LAN_URL = 'https://voice-lan.example:9443/'
        const access = getVoiceTtsLanAccess(1_000_000)
        expect(access).toMatchObject({ url: 'https://voice-lan.example:9443', expiresAt: 1_000_000 + 30 * 60_000 })
        expect(access?.ticket.startsWith(`${Math.floor((1_000_000 + 30 * 60_000) / 1000)}.`)).toBe(true)
        expect(access?.ticket).not.toBe(signVoiceTtsTicket('another-token', 1_000_000 + 30 * 60_000))
    })

    it('serves the LAN certificate only to the voice service token', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'voice-lan-cert-'))
        process.env.HAPI_VOICE_TTS_LAN_CERT_DIR = dir
        try {
            expect((await serveVoiceTtsLanCert('secret-token', dir)).status).toBe(503)
            writeFileSync(join(dir, 'fullchain.pem'), 'CERT')
            writeFileSync(join(dir, 'key.pem'), 'KEY')
            expect((await serveVoiceTtsLanCert(undefined, dir)).status).toBe(404)
            expect((await serveVoiceTtsLanCert('secret-tokex', dir)).status).toBe(404)
            const ok = await serveVoiceTtsLanCert('secret-token', dir)
            expect(ok.status).toBe(200)
            expect(await ok.json()).toEqual({ cert: 'CERT', key: 'KEY' })
        } finally {
            delete process.env.HAPI_VOICE_TTS_LAN_CERT_DIR
            rmSync(dir, { recursive: true, force: true })
        }
    })
})
