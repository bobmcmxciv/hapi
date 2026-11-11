import { describe, expect, it, vi } from 'vitest'
import { VoiceTtsLanRouter } from './lanTts'
import type { VoiceTtsStatus } from './types'

const LAN = 'https://voice-lan.test:9443'
const status = (expiresAt: number, ticket = 't1'): VoiceTtsStatus => ({
    available: true, voice: 'manbo', sampleRate: 16000, lan: { url: LAN, ticket, expiresAt }
})
const pcm = () => new Response(new Uint8Array([1, 2]), { status: 200 })

function router(options: { reachable: boolean; tts?: () => Response; statuses?: VoiceTtsStatus[] }) {
    let clock = 1_000_000
    const statuses = [...(options.statuses ?? [status(clock + 30 * 60_000)])]
    const loadStatus = vi.fn(async () => statuses.length > 1 ? statuses.shift()! : statuses[0])
    const calls: Array<{ url: string; ticket?: string }> = []
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        calls.push({ url, ticket: new Headers(init?.headers).get('x-voice-ticket') ?? undefined })
        if (url.endsWith('/health')) {
            if (!options.reachable) throw new TypeError('Failed to fetch')
            return Response.json({ ok: true })
        }
        return (options.tts ?? pcm)()
    }) as unknown as typeof fetch
    const instance = new VoiceTtsLanRouter(loadStatus, fetchImpl, () => clock)
    return { instance, calls, loadStatus, advance: (ms: number) => { clock += ms } }
}

describe('VoiceTtsLanRouter', () => {
    it('speaks directly to the engine with the ticket when the LAN address answers', async () => {
        const { instance, calls } = router({ reachable: true })
        const response = await instance.open('{"text":"hi"}')
        expect(response?.status).toBe(200)
        expect(calls.at(-1)).toEqual({ url: `${LAN}/tts`, ticket: 't1' })
    })

    it('returns null (hub relay) outside the LAN and does not re-probe within a minute', async () => {
        const { instance, calls, advance } = router({ reachable: false })
        expect(await instance.open('{}')).toBeNull()
        advance(30_000)
        expect(await instance.open('{}')).toBeNull()
        expect(calls.filter(call => call.url.endsWith('/health'))).toHaveLength(1)
        expect(calls.some(call => call.url.endsWith('/tts'))).toBe(false)
    })

    it('falls back to the relay and refetches a ticket after the engine rejects it', async () => {
        const later = 1_000_000 + 30 * 60_000
        const { instance, calls, loadStatus } = router({
            reachable: true,
            tts: () => new Response('bad ticket', { status: 401 }),
            statuses: [status(later, 'old'), status(later, 'new')]
        })
        expect(await instance.open('{}')).toBeNull()
        await instance.open('{}')
        expect(loadStatus).toHaveBeenCalledTimes(2)
        expect(calls.filter(call => call.url.endsWith('/tts')).map(call => call.ticket)).toEqual(['old', 'new'])
    })

    it('renews the ticket before it expires', async () => {
        const start = 1_000_000
        const { instance, loadStatus, advance, calls } = router({
            reachable: true,
            statuses: [status(start + 30 * 60_000, 'first'), status(start + 60 * 60_000, 'second')]
        })
        await instance.open('{}')
        advance(29 * 60_000 + 30_000)
        await instance.open('{}')
        expect(loadStatus).toHaveBeenCalledTimes(2)
        expect(calls.filter(call => call.url.endsWith('/tts')).at(-1)?.ticket).toBe('second')
    })

    it('propagates a caller abort instead of silently retrying through the relay', async () => {
        const controller = new AbortController()
        const { instance } = router({
            reachable: true,
            tts: () => { controller.abort(); throw new DOMException('aborted', 'AbortError') }
        })
        await expect(instance.open('{}', controller.signal)).rejects.toThrow('aborted')
    })
})
