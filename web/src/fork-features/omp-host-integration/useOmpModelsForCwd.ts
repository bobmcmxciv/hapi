import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { OmpModelSummary, OmpModelsResponse } from '@hapi/protocol/apiTypes';
import type { ApiClient } from '@/api/client';
import { queryKeys } from '@/lib/query-keys';
import { refreshOmpModelCatalogs } from './refreshOmpModelCatalogs';

export function useOmpModelsForCwd(args: {
    api: ApiClient | null;
    machineId?: string | null;
    cwd?: string | null;
    enabled?: boolean;
}): {
    availableModels: OmpModelSummary[];
    currentModel: { provider: string; modelId: string } | null;
    isLoading: boolean;
    isReady: boolean;
    error: string | null;
    refetch: () => Promise<void>;
    refreshCatalogs: () => Promise<void>;
} {
    const cwd = args.cwd?.trim() ?? '';
    const queryClient = useQueryClient();
    const enabled = Boolean(args.enabled && args.api && args.machineId && cwd);
    const query = useQuery({
        queryKey: args.machineId && cwd
            ? queryKeys.machineOmpModelsForCwd(args.machineId, cwd)
            : ['machine-omp-models', 'unknown', 'unknown'] as const,
        queryFn: async (): Promise<OmpModelsResponse> => {
            if (!args.api || !args.machineId || !cwd) throw new Error('OMP model target unavailable');
            return await args.api.getMachineOmpModelsForCwd(args.machineId, cwd);
        },
        enabled,
        staleTime: 30_000,
        placeholderData: undefined,
        retry: 2
    });

    return {
        availableModels: enabled && query.data?.success === true ? query.data.availableModels ?? [] : [],
        currentModel: enabled && query.data?.success === true ? query.data.currentModel ?? null : null,
        isLoading: enabled && query.isFetching,
        isReady: enabled && query.data?.success === true && Array.isArray(query.data.availableModels) && !query.isFetching && !query.isError,
        error: query.data?.success === false
            ? query.data.error ?? 'Failed to load OMP models'
            : query.error instanceof Error ? query.error.message : null,
        refetch: async () => {
            if (enabled) await query.refetch();
        },
        refreshCatalogs: async () => {
            if (enabled) await refreshOmpModelCatalogs(queryClient, args.machineId);
        }
    };
}
