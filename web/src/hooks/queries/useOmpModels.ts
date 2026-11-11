import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { OmpModelSummary, OmpModelsResponse } from '@hapi/protocol/apiTypes'
import type { ApiClient } from '@/api/client'
import { queryKeys } from '@/lib/query-keys'
import { refreshOmpModelCatalogs } from '@/fork-features/omp-host-integration/refreshOmpModelCatalogs'

export function useOmpModels(args: {
    api: ApiClient | null
    sessionId?: string | null
    enabled?: boolean
}): {
    availableModels: OmpModelSummary[]
    currentModel: { provider: string; modelId: string } | null
    isLoading: boolean
    error: string | null
    refetch: () => Promise<void>
    refreshCatalogs: () => Promise<void>
} {
    const { api, sessionId } = args
    const queryClient = useQueryClient()
    const enabled = Boolean(args.enabled && api && sessionId)
    const query = useQuery({
        queryKey: sessionId ? queryKeys.sessionOmpModels(sessionId) : ['session-omp-models', 'unknown'] as const,
        queryFn: async (): Promise<OmpModelsResponse> => {
            if (!api || !sessionId) throw new Error('OMP model target unavailable')
            return await api.getSessionOmpModels(sessionId)
        },
        enabled,
        staleTime: 30_000,
        placeholderData: undefined,
        retry: 2
    })

    return {
        availableModels: enabled && query.data?.success === true ? query.data.availableModels ?? [] : [],
        currentModel: enabled && query.data?.success === true ? query.data.currentModel ?? null : null,
        isLoading: enabled && query.isFetching,
        error: query.data?.success === false
            ? query.data.error ?? 'Failed to load OMP models'
            : query.error instanceof Error ? query.error.message : null,
        refetch: async () => {
            if (enabled) await query.refetch()
        },
        refreshCatalogs: async () => {
            if (enabled) await refreshOmpModelCatalogs(queryClient)
        }
    }
}
