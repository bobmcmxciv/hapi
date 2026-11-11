import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { SessionSummary } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

export function useSessions(api: ApiClient | null): {
 sessions: SessionSummary[]
 isLoading: boolean
 error: string | null
 refetch: () => Promise<unknown>
} {
 const query = useQuery({
  queryKey: queryKeys.sessions,
  queryFn: async () => {
   if (!api) {
    throw new Error('API unavailable')
   }
   return await api.getSessions()
  },
  enabled: Boolean(api),
 })

 return {
  sessions: query.data?.sessions ?? [],
  isLoading: query.isLoading,
  error: query.error instanceof Error ? query.error.message : query.error ? 'Failed to load sessions' : null,
  refetch: query.refetch,
 }
}

/**
 * Selected single-session projection of the sessions list cache. Unlike
 * `useSessions`, which hands every consumer the whole array (and therefore a
 * new result identity whenever any sibling row moves), this hook's `select`
 * output stays reference-identical while the chosen summary is unchanged —
 * an unrelated heartbeat or tool-progress patch on another session cannot
 * re-render the consumer. Use it for "is the selected/other session active,
 * pending, renamed" lookups, not for rendering the list itself.
 */
export function useSessionSummary(api: ApiClient | null, sessionId: string | null): {
 summary: SessionSummary | null
 isLoading: boolean
 error: string | null
} {
 const query = useQuery({
  queryKey: queryKeys.sessions,
  queryFn: async () => {
   if (!api) {
    throw new Error('API unavailable')
   }
   return await api.getSessions()
  },
  enabled: Boolean(api && sessionId),
  select: (data) => data.sessions.find((item) => item.id === sessionId) ?? null,
 })

 return {
  summary: sessionId ? query.data ?? null : null,
  isLoading: Boolean(sessionId) && query.isLoading,
  error: query.error instanceof Error ? query.error.message : query.error ? 'Failed to load sessions' : null,
 }
}
