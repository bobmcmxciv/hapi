import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAppContext } from '@/lib/app-context'

/** 与 hub fork-features/work-overview/workStore 同构。 */
export type WorkLine = {
    id: string
    parentId: string | null
    name: string
    goal: string
    sort: number
    updatedAt: number
}

export type WorkFolderMode = 'line' | 'mixed' | 'ignored'

export type WorkFolder = {
    projectKey: string
    mode: WorkFolderMode
    lineId: string | null
    project: string | null
    updatedAt: number
}

export type WorkSessionAssignment = {
    sessionId: string
    lineId: string | null
    updatedAt: number
}

export type WorkMap = {
    lines: WorkLine[]
    folders: WorkFolder[]
    sessions: WorkSessionAssignment[]
}

export const workQueryKeys = {
    map: ['fork-work', 'map'] as const
}

/** 工作总览目前只给 admin：非 admin 不发请求，hub 侧也会 403。 */
export function useIsWorkOverviewEnabled(): boolean {
    try {
        return useAppContext().user.role === 'admin'
    } catch {
        return false
    }
}

function useWorkFetch() {
    const { baseUrl, token } = useAppContext()
    return async <T,>(path: string, init?: { method?: string; body?: unknown }): Promise<T> => {
        const response = await fetch(`${baseUrl}${path}`, {
            method: init?.method ?? 'GET',
            headers: {
                authorization: `Bearer ${token}`,
                ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {})
            },
            body: init?.body !== undefined ? JSON.stringify(init.body) : undefined
        })
        if (!response.ok) {
            const body = await response.json().catch(() => null) as { error?: string } | null
            throw new Error(body?.error ?? `HTTP ${response.status}`)
        }
        return await response.json() as T
    }
}

export function useWorkMap(enabled: boolean) {
    const fetchJson = useWorkFetch()
    return useQuery({
        queryKey: workQueryKeys.map,
        queryFn: () => fetchJson<WorkMap>('/api/work/map'),
        enabled,
        staleTime: 30_000,
        retry: false
    })
}

export type FolderPatch = { projectKey: string; mode: WorkFolderMode | null; lineId?: string | null; project?: string | null }
export type SessionPatch = { sessionId: string; state: 'line' | 'ignored' | 'follow'; lineId?: string }
export type LinePatch = { id: string; parentId: string | null; name: string; goal: string; sort: number }

export function useWorkActions() {
    const fetchJson = useWorkFetch()
    const queryClient = useQueryClient()
    const refresh = () => queryClient.invalidateQueries({ queryKey: workQueryKeys.map })
    const setFolder = useMutation({
        mutationFn: (patch: FolderPatch) => fetchJson('/api/work/folders', { method: 'PUT', body: patch }),
        onSettled: refresh
    })
    const setSession = useMutation({
        mutationFn: (patch: SessionPatch) => fetchJson('/api/work/sessions', { method: 'PUT', body: patch }),
        onSettled: refresh
    })
    const upsertLine = useMutation({
        mutationFn: (line: LinePatch) => fetchJson<{ line: WorkLine }>('/api/work/lines', { method: 'PUT', body: line }),
        onSettled: refresh
    })
    const deleteLine = useMutation({
        mutationFn: (id: string) => fetchJson(`/api/work/lines/${encodeURIComponent(id)}`, { method: 'DELETE' }),
        onSettled: refresh
    })
    return { setFolder, setSession, upsertLine, deleteLine }
}

export function newLineId(): string {
    return `l-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}
