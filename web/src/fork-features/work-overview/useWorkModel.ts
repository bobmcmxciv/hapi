import { useMemo } from 'react'
import { useAppContext } from '@/lib/app-context'
import { useSessions } from '@/hooks/queries/useSessions'
import { useMachines } from '@/hooks/queries/useMachines'
import { getMachineTitle } from '@/hooks/useMachineLabels'
import { prepareSidebarSessions } from '@/components/SessionList'
import { useProjectDigests } from '@/fork-features/session-digest/digestApi'
import { deriveWork, type FolderDigest, type WorkModel } from './deriveWork'
import { useIsWorkOverviewEnabled, useWorkMap, type WorkMap } from './workApi'

export type WorkModelResult = {
    model: WorkModel
    map: WorkMap
    /** 与左侧列表同口径（去重、隐藏空壳）的会话，时间泳道和详情面板用。 */
    sessions: ReturnType<typeof prepareSidebarSessions>
    /** 「需要你处理」里被忽略的会话。 */
    dismissed: ReadonlySet<string>
    /** 项目摘要（按 projectKey），线详情与梳理待办用。 */
    digests: Record<string, FolderDigest>
}

/**
 * 工作总览的数据入口。非 admin 返回 null 且不发 /api/work 请求；会话、机器、项目摘要
 * 都复用会话页已经在用的 react-query 缓存，不额外打 hub。
 */
export function useWorkModel(): { enabled: boolean; isLoading: boolean; error: string | null; result: WorkModelResult | null } {
    const enabled = useIsWorkOverviewEnabled()
    const { api, user } = useAppContext()
    const mapQuery = useWorkMap(enabled)
    const { sessions } = useSessions(enabled ? api : null)
    const { machines } = useMachines(api, enabled)
    const digestQuery = useProjectDigests(enabled)

    const result = useMemo((): WorkModelResult | null => {
        if (!enabled || !mapQuery.data) return null
        const prepared = prepareSidebarSessions(sessions, null)
        const digests: Record<string, FolderDigest> = {}
        for (const digest of digestQuery.data?.projects ?? []) {
            digests[digest.projectKey] = { stage: digest.stage, overview: digest.overview, todo: digest.todo, status: digest.status, artifacts: digest.artifacts }
        }
        const model = deriveWork({
            map: mapQuery.data,
            sessions: prepared,
            machines: machines.map(machine => ({
                id: machine.id,
                label: getMachineTitle(machine),
                ownerUsername: machine.ownerUsername ?? null,
                platform: machine.metadata?.platform ?? null,
                icon: typeof machine.metadata?.icon === 'string' ? machine.metadata.icon : null
            })),
            username: user.username,
            digests,
            now: Date.now(),
            dismissed: new Set(mapQuery.data.dismissed ?? [])
        })
        return { model, map: mapQuery.data, sessions: prepared, dismissed: model.dismissed, digests }
    }, [enabled, mapQuery.data, sessions, machines, digestQuery.data, user.username])

    return {
        enabled,
        isLoading: enabled && mapQuery.isLoading,
        error: mapQuery.error instanceof Error ? mapQuery.error.message : null,
        result
    }
}
