import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OmpUsageResponse } from '@hapi/protocol/ompUsage'
import { ApiClient } from './client'

afterEach(() => vi.unstubAllGlobals())

const emptyUsage: OmpUsageResponse = {
    success: true, source: 'omp-native', generatedAt: 1,
    reports: [], accountsWithoutUsage: [], disabledCredentialCount: 0
}

describe('ApiClient.getOmpUsage', () => {
    it('uses the selected machine endpoint, existing base URL and live bearer token', async () => {
        const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(emptyUsage)))
        vi.stubGlobal('fetch', fetcher)
        const api = new ApiClient('old', { baseUrl: 'https://hub.example', getToken: () => 'current' })
        expect(await api.getOmpUsage('machine/id ?')).toEqual(emptyUsage)
        const [url, init] = fetcher.mock.calls[0]!
        expect(url).toBe('https://hub.example/api/subscription/omp/machine%2Fid%20%3F')
        expect(init?.method ?? 'GET').toBe('GET')
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer current')
    })

    it('reuses unauthorized refresh and retains native failure envelopes', async () => {
        const body: OmpUsageResponse = { success: false, source: 'omp-native', errorCode: 'unsupported', error: 'Unsupported' }
        const fetcher = vi.fn<typeof fetch>()
            .mockResolvedValueOnce(new Response('{}', { status: 401 }))
            .mockResolvedValueOnce(new Response(JSON.stringify(body)))
        vi.stubGlobal('fetch', fetcher)
        const refresh = vi.fn(async () => 'fresh')
        const api = new ApiClient('expired', { onUnauthorized: refresh })
        expect(await api.getOmpUsage('runner')).toEqual(body)
        expect(refresh).toHaveBeenCalledTimes(1)
        expect(fetcher).toHaveBeenCalledTimes(2)
        expect(new Headers(fetcher.mock.calls[1]?.[1]?.headers).get('authorization')).toBe('Bearer fresh')
    })

    it('does not bypass permission failures', async () => {
        const fetcher = vi.fn(async () => new Response(JSON.stringify({ code: 'machine_access_denied' }), { status: 403 }))
        vi.stubGlobal('fetch', fetcher)
        await expect(new ApiClient('jwt').getOmpUsage('private')).rejects.toMatchObject({ status: 403, code: 'machine_access_denied' })
        expect(fetcher).toHaveBeenCalledTimes(1)
    })
})
