import type { QueryClient } from '@tanstack/react-query'

// Native authentication/configuration can change outside HAPI. Session catalogs
// have no machine key, so invalidate all of them rather than leave stale choices.
export async function refreshOmpModelCatalogs(queryClient: QueryClient, machineId?: string | null): Promise<void> {
    await Promise.all([
        queryClient.invalidateQueries({
            queryKey: machineId ? ['machine-omp-models', machineId] : ['machine-omp-models']
        }, { cancelRefetch: false }),
        queryClient.invalidateQueries({ queryKey: ['session-omp-models'] }, { cancelRefetch: false })
    ])
}
