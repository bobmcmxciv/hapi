import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiClient, ApiError } from './client'

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })

function openBody() {
    return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.close() } }), {
        headers: { 'content-type': 'text/event-stream' }
    })
}

describe('ApiClient runtime endpoints', () => {
    it('fetches the exact session snapshot using the live token and existing API base', async () => {
        const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ available: false, source: 'none' })))
        globalThis.fetch = fetchMock
        const api = new ApiClient('old', { baseUrl: 'https://hub.example.test', getToken: () => 'current' })
        expect(await api.getRuntimeSnapshot('session/id')).toEqual({ available: false, source: 'none' })
        expect(fetchMock.mock.calls[0][0]).toBe('https://hub.example.test/api/sessions/session%2Fid/runtime')
        expect(new Headers(fetchMock.mock.calls[0][1].headers).get('authorization')).toBe('Bearer current')
    })

    it('keeps bearer auth out of the URL and passes the caller abort signal to the stream fetch', async () => {
        const response = openBody()
        const fetchMock = vi.fn().mockResolvedValue(response)
        globalThis.fetch = fetchMock
        const api = new ApiClient('secret')
        const controller = new AbortController()
        expect(await api.openRuntimeEventsStream('s1', controller.signal)).toBe(response)
        const [url, init] = fetchMock.mock.calls[0]
        expect(url).toBe('/api/sessions/s1/runtime/events')
        expect(init.signal).toBe(controller.signal)
        expect(new Headers(init.headers).get('authorization')).toBe('Bearer secret')
        expect(new Headers(init.headers).get('accept')).toBe('text/event-stream')
    })

    it('retries a stream 401 exactly once through the existing auth refresh mechanism', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(new Response('{}', { status: 401 }))
            .mockResolvedValueOnce(openBody())
        globalThis.fetch = fetchMock
        const refresh = vi.fn(async () => 'fresh')
        const api = new ApiClient('expired', { onUnauthorized: refresh })
        await api.openRuntimeEventsStream('s1')
        expect(refresh).toHaveBeenCalledTimes(1)
        expect(fetchMock).toHaveBeenCalledTimes(2)
        expect(new Headers(fetchMock.mock.calls[1][1].headers).get('authorization')).toBe('Bearer fresh')
    })

    it('returns a typed fatal auth error when refresh cannot restore access', async () => {
        const fetchMock = vi.fn().mockImplementation(async () => new Response('{}', { status: 401 }))
        globalThis.fetch = fetchMock
        const api = new ApiClient('expired', { onUnauthorized: async () => null })
        await expect(api.openRuntimeEventsStream('s1')).rejects.toMatchObject({ status: 401 })
        expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('preserves forbidden error codes for access-revocation handling', async () => {
        const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 'session_access_denied' }), { status: 403 }))
        globalThis.fetch = fetchMock
        const api = new ApiClient('user')
        await expect(api.openRuntimeEventsStream('s1')).rejects.toBeInstanceOf(ApiError)
        const again = new Response(JSON.stringify({ code: 'session_access_denied' }), { status: 403 })
        fetchMock.mockResolvedValueOnce(again)
        await expect(api.openRuntimeEventsStream('s1')).rejects.toMatchObject({ status: 403, code: 'session_access_denied' })
    })
})
