import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAppContext } from '@/lib/app-context'

/** 与 hub fork-features/session-digest 同构的形状。 */
export type SessionDigest = {
    sessionId: string
    title: string
    done: string[]
    status: string
    todo: string[]
    suggestComplete: boolean
    completed: boolean
    completedAt: number | null
    model: string | null
    generatedAt: number | null
    error: string | null
}

export type ProjectDigest = {
    projectKey: string
    machineId: string | null
    path: string
    overview: string
    stage: string
    stageReason: string
    capabilities: string[]
    artifacts: string[]
    status: string
    todo: string[]
    judgement: string
    model: string | null
    generatedAt: number | null
    error: string | null
}

export type DigestIndexEntry = { completed: boolean; suggestComplete: boolean; hasDigest: boolean; status: string }

export type DigestSettings = { enabled: boolean; model: string; autoRename: boolean; maxPerHour: number }

export type DigestStatus = {
    configured: boolean
    settings: DigestSettings
    running: string | null
    runsLastHour: number
    pendingSessions: number
    digestedSessions: number
    projects: number
    lastRunAt: number | null
    lastError: string | null
    queuedProjects: number
}

export const digestQueryKeys = {
    index: ['fork-digest', 'index'] as const,
    session: (id: string) => ['fork-digest', 'session', id] as const,
    projects: ['fork-digest', 'projects'] as const,
    settings: ['fork-digest', 'settings'] as const,
    models: ['fork-digest', 'models'] as const
}

/** 没有 AppContext（例如单独渲染会话列表的场景）时返回 null，调用方据此不发请求。 */
function useOptionalConnection(): { baseUrl: string; token: string } | null {
    try {
        const { baseUrl, token } = useAppContext()
        return { baseUrl, token }
    } catch {
        return null
    }
}

function useDigestFetch() {
    const connection = useOptionalConnection()
    return async <T,>(path: string, init?: { method?: string; body?: unknown }): Promise<T> => {
        if (!connection) throw new Error('Not connected')
        const { baseUrl, token } = connection
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

/** 会话列表用：只有完结标记的轻量索引。 */
export function useDigestIndex(): Record<string, DigestIndexEntry> {
    const connected = useOptionalConnection() !== null
    const fetchJson = useDigestFetch()
    const query = useQuery({
        queryKey: digestQueryKeys.index,
        enabled: connected,
        queryFn: () => fetchJson<{ digests: Record<string, DigestIndexEntry> }>('/api/digests/sessions'),
        refetchInterval: 120_000,
        staleTime: 60_000,
        retry: false
    })
    return query.data?.digests ?? {}
}

export function useSessionDigest(sessionId: string, enabled: boolean) {
    const fetchJson = useDigestFetch()
    return useQuery({
        queryKey: digestQueryKeys.session(sessionId),
        queryFn: () => fetchJson<{ digest: SessionDigest | null; running: boolean }>(`/api/digests/sessions/${encodeURIComponent(sessionId)}`),
        enabled,
        // 刷新请求发出后摘要在后台生成，打开期间短间隔轮询直到出结果。
        refetchInterval: (query) => (query.state.data?.running ? 4000 : 30_000)
    })
}

export function useProjectDigests(enabled: boolean) {
    const connected = useOptionalConnection() !== null
    const fetchJson = useDigestFetch()
    return useQuery({
        queryKey: digestQueryKeys.projects,
        queryFn: () => fetchJson<{ projects: ProjectDigest[] }>('/api/digests/projects'),
        enabled: enabled && connected,
        retry: false,
        refetchInterval: 60_000
    })
}

export function useDigestActions() {
    const fetchJson = useDigestFetch()
    const queryClient = useQueryClient()
    const refreshSession = useMutation({
        mutationFn: (sessionId: string) => fetchJson(`/api/digests/sessions/${encodeURIComponent(sessionId)}/refresh`, { method: 'POST', body: {} }),
        onSuccess: (_data, sessionId) => {
            void queryClient.invalidateQueries({ queryKey: digestQueryKeys.session(sessionId) })
        }
    })
    const setCompleted = useMutation({
        mutationFn: (params: { sessionId: string; completed: boolean }) =>
            fetchJson(`/api/digests/sessions/${encodeURIComponent(params.sessionId)}/complete`, { method: 'POST', body: { completed: params.completed } }),
        onSuccess: (_data, params) => {
            void queryClient.invalidateQueries({ queryKey: digestQueryKeys.session(params.sessionId) })
            void queryClient.invalidateQueries({ queryKey: digestQueryKeys.index })
        }
    })
    const refreshProject = useMutation({
        mutationFn: (key: string) => fetchJson('/api/digests/projects/refresh', { method: 'POST', body: { key } }),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: digestQueryKeys.projects })
        }
    })
    return { refreshSession, setCompleted, refreshProject }
}

export function useDigestSettings(enabled: boolean) {
    const fetchJson = useDigestFetch()
    const queryClient = useQueryClient()
    const status = useQuery({
        queryKey: digestQueryKeys.settings,
        queryFn: () => fetchJson<DigestStatus>('/api/digests/settings'),
        enabled,
        refetchInterval: 15_000
    })
    const models = useQuery({
        queryKey: digestQueryKeys.models,
        queryFn: () => fetchJson<{ models: string[]; error?: string }>('/api/digests/models'),
        enabled,
        staleTime: 5 * 60_000
    })
    const update = useMutation({
        mutationFn: (patch: Partial<DigestSettings>) => fetchJson<DigestStatus>('/api/digests/settings', { method: 'PUT', body: patch }),
        onSuccess: (data) => queryClient.setQueryData(digestQueryKeys.settings, data)
    })
    const refreshAllProjects = useMutation({
        mutationFn: () => fetchJson<{ queued: number }>('/api/digests/projects/refresh-all', { method: 'POST', body: {} }),
        onSuccess: () => { void queryClient.invalidateQueries({ queryKey: digestQueryKeys.settings }) }
    })
    return { status, models, update, refreshAllProjects }
}
