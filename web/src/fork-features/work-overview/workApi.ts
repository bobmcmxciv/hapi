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
    /** 「需要你处理」里被忽略的会话（旧 hub 不带）。 */
    dismissed?: string[]
}

/** 「梳理待办」：与 hub fork-features/work-overview/briefing.ts 同构。 */
export type BriefingItem = { text: string; sessionId?: string; lineId?: string; priority?: 'high' | 'normal' }
export type Briefing = {
    summary: string
    groups: Array<{ title: string; items: BriefingItem[] }>
    generatedAt: number
    model: string | null
    error: string | null
}
export type BriefingContext = {
    lines: Array<{ id: string; name: string; parentId: string | null; goal?: string; status?: string; lastActivity?: number; nextSteps?: string[] }>
    pending: Array<{ sessionId: string; title: string; lineId?: string | null; machine?: string; updatedAt?: number; detail?: string }>
    active: Array<{ sessionId: string; title: string; lineId?: string | null; machine?: string; thinking?: boolean; status?: string }>
    recent: Array<{ sessionId: string; title: string; lineId?: string | null; updatedAt?: number; status?: string; completed?: boolean }>
    dismissed: Array<{ sessionId: string; title: string }>
}

export const workQueryKeys = {
    map: ['fork-work', 'map'] as const,
    briefing: ['fork-work', 'briefing'] as const
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
    const setDismissed = useMutation({
        mutationFn: (patch: { sessionId: string; dismissed: boolean }) => fetchJson<{ dismissed: string[] }>('/api/work/dismissed', { method: 'PUT', body: patch }),
        onSuccess: (data) => {
            queryClient.setQueryData<WorkMap>(workQueryKeys.map, previous => (previous ? { ...previous, dismissed: data.dismissed } : previous))
        },
        onSettled: refresh
    })
    return { setFolder, setSession, upsertLine, deleteLine, setDismissed }
}

/** 最新一份「梳理待办」；生成中每 3 秒轮询一次。 */
export function useBriefing(enabled: boolean, fast = false) {
    const fetchJson = useWorkFetch()
    return useQuery({
        queryKey: workQueryKeys.briefing,
        queryFn: () => fetchJson<{ briefing: Briefing | null; running: boolean }>('/api/work/briefing'),
        enabled,
        retry: false,
        refetchInterval: (query) => (fast || query.state.data?.running ? 3000 : false)
    })
}

export function useRefreshBriefing() {
    const fetchJson = useWorkFetch()
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: (context: BriefingContext) => fetchJson<{ running: boolean }>('/api/work/briefing/refresh', { method: 'POST', body: context }),
        onSuccess: () => { void queryClient.invalidateQueries({ queryKey: workQueryKeys.briefing }) }
    })
}

export function newLineId(): string {
    return `l-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}
