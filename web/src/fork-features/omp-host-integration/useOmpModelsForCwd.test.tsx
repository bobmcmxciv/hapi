import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { OmpModelsResponse } from '@hapi/protocol/apiTypes'
import { queryKeys } from '@/lib/query-keys'
import { useOmpModels } from '@/hooks/queries/useOmpModels'
import { useOmpModelsForCwd } from './useOmpModelsForCwd'
import { refreshOmpModelCatalogs } from './refreshOmpModelCatalogs'

const catalog: OmpModelsResponse = {
    success: true,
    availableModels: [{
        provider: 'anthropic', modelId: 'claude-sonnet-5-5', name: 'Claude Sonnet',
        reasoning: true, contextWindow: 200000, maxTokens: 64000, thinkingLevels: ['low', 'high']
    }],
    currentModel: { provider: 'anthropic', modelId: 'claude-sonnet-5-5' }
}
const clients: QueryClient[] = []
function harness() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
    clients.push(queryClient)
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    return { queryClient, wrapper }
}
afterEach(() => { for (const client of clients.splice(0)) client.clear() })

describe('native OMP catalog queries', () => {
    it('never reuses a previous machine/cwd response to validate a new target', async () => {
        const { wrapper } = harness()
        const pending = new Map<string, (value: OmpModelsResponse) => void>()
        const getMachineOmpModelsForCwd = vi.fn((machine: string, cwd: string) => {
            const { promise, resolve } = Promise.withResolvers<OmpModelsResponse>()
            pending.set(`${machine}:${cwd}`, resolve)
            return promise
        })
        const api = { getMachineOmpModelsForCwd } as unknown as ApiClient
        const view = renderHook(({ machineId, cwd }) => useOmpModelsForCwd({ api, machineId, cwd, enabled: true }), {
            wrapper, initialProps: { machineId: 'one', cwd: '/repo' }
        })
        await waitFor(() => expect(pending.has('one:/repo')).toBe(true))
        await act(async () => pending.get('one:/repo')!(catalog))
        await waitFor(() => expect(view.result.current.isReady).toBe(true))
        view.rerender({ machineId: 'two', cwd: '/repo' })
        expect(view.result.current.isReady).toBe(false)
        expect(view.result.current.availableModels).toEqual([])
        await waitFor(() => expect(pending.has('two:/repo')).toBe(true))
        view.rerender({ machineId: 'two', cwd: '/other' })
        await act(async () => pending.get('two:/repo')!(catalog))
        expect(view.result.current.isReady).toBe(false)
        expect(view.result.current.availableModels).toEqual([])
        await waitFor(() => expect(pending.has('two:/other')).toBe(true))
        await act(async () => pending.get('two:/other')!(catalog))
        await waitFor(() => expect(view.result.current.isReady).toBe(true))
        expect(view.result.current.availableModels[0]?.provider).toBe('anthropic')
    })

    it('retries an unsuccessful native response from the explicit refresh action', async () => {
        const { wrapper } = harness()
        const getMachineOmpModelsForCwd = vi.fn()
            .mockResolvedValueOnce({ success: false, error: 'native unavailable' })
            .mockResolvedValue(catalog)
        const api = { getMachineOmpModelsForCwd } as unknown as ApiClient
        const view = renderHook(() => useOmpModelsForCwd({ api, machineId: 'one', cwd: '/repo', enabled: true }), { wrapper })
        await waitFor(() => expect(view.result.current.error).toBe('native unavailable'))
        expect(view.result.current.isReady).toBe(false)
        await act(async () => view.result.current.refreshCatalogs())
        await waitFor(() => expect(view.result.current.isReady).toBe(true))
        expect(getMachineOmpModelsForCwd).toHaveBeenCalledTimes(2)
        expect(view.result.current.currentModel).toEqual(catalog.currentModel)
    })

    it('refreshes active session and target machine catalogs, invalidating inactive sessions too', async () => {
        const { queryClient, wrapper } = harness()
        const getMachineOmpModelsForCwd = vi.fn().mockResolvedValue(catalog)
        const getSessionOmpModels = vi.fn().mockResolvedValue(catalog)
        const api = { getMachineOmpModelsForCwd, getSessionOmpModels } as unknown as ApiClient
        queryClient.setQueryData(queryKeys.machineOmpModelsForCwd('other', '/repo'), catalog)
        queryClient.setQueryData(queryKeys.sessionOmpModels('inactive'), catalog)
        const machine = renderHook(() => useOmpModelsForCwd({ api, machineId: 'one', cwd: '/repo', enabled: true }), { wrapper })
        const session = renderHook(() => useOmpModels({ api, sessionId: 'active', enabled: true }), { wrapper })
        await waitFor(() => expect(machine.result.current.isReady).toBe(true))
        await waitFor(() => expect(session.result.current.currentModel).toEqual(catalog.currentModel))
        await act(async () => refreshOmpModelCatalogs(queryClient, 'one'))
        expect(getMachineOmpModelsForCwd).toHaveBeenCalledTimes(2)
        expect(getSessionOmpModels).toHaveBeenCalledTimes(2)
        expect(queryClient.getQueryState(queryKeys.sessionOmpModels('inactive'))?.isInvalidated).toBe(true)
        expect(queryClient.getQueryState(queryKeys.machineOmpModelsForCwd('other', '/repo'))?.isInvalidated).toBe(false)
    })
})
