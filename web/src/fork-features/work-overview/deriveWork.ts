import type { SessionSummary } from '@/types/api'
import type { WorkFolder, WorkLine, WorkMap } from './workApi'

/**
 * 工作总览的全部派生数据，纯函数，前端每次数据变化时重算。
 *
 * 归属规则与 hub workStore 的注释一致：
 * 会话行优先（lineId 或 null=忽略）→ 目录行（line 跟随 / mixed 逐个会话 / ignored）→ 没有目录行 = 待整理。
 * 「我的」范围：机器主人是当前账号，或者目录/会话已经在映射里——别人的机器不进待整理。
 */

export type WorkStatus = 'push' | 'slow' | 'stall'

export const UNKNOWN_MACHINE_ID = '__unknown__'
const DAY_MS = 86_400_000

export type MachineInfo = { id: string; label: string; ownerUsername?: string | null; platform?: string | null; icon?: string | null }

/** 项目阶段等摘要信息，来自 /api/digests/projects。 */
export type FolderDigest = { stage: string; overview: string; todo: string[]; status: string; artifacts?: string[] }

export type FolderStat = {
    projectKey: string
    machineId: string | null
    machineLabel: string
    path: string
    displayName: string
    project: string
    mode: WorkFolder['mode'] | 'unassigned'
    lineId: string | null
    sessionCount: number
    activeCount: number
    pendingCount: number
    lastActivity: number
    digest: FolderDigest | null
}

export type ProjectStat = {
    name: string
    folders: FolderStat[]
    sessionCount: number
    activeCount: number
    lastActivity: number
    stage: string | null
    machines: string[]
}

export type LineStats = {
    sessionCount: number
    activeCount: number
    thinkingCount: number
    pendingCount: number
    lastActivity: number
    machineLabels: string[]
    /** 与 machineLabels 同序；渲染设备图标用。 */
    machineIds: Array<string | null>
    status: WorkStatus
}

export type SublineView = WorkLine & LineStats & {
    projects: ProjectStat[]
    /** 从家目录这类混合目录逐个归过来的会话数。 */
    looseSessionCount: number
}

export type MainlineView = WorkLine & LineStats & {
    sublines: SublineView[]
    nextStep: { text: string; project: string; projectKey: string } | null
}

export type LooseSession = { session: SessionSummary; projectKey: string; machineLabel: string }

export type WorkModel = {
    mainlines: MainlineView[]
    /** 会话 id → 支线 id；忽略或待整理的会话不在里面。 */
    sublineOfSession: Map<string, string>
    mainlineOfLine: Map<string, string>
    folders: Map<string, FolderStat>
    /** 没有目录行的「我的」目录。 */
    unassignedFolders: FolderStat[]
    /** 混合目录里还没归属的会话。 */
    looseSessions: LooseSession[]
    /** 所有待整理会话（没归属、也没被忽略）。 */
    unassignedSessionIds: Set<string>
    /** 参与统计的机器（有「我的」目录的），按目录数降序。 */
    machines: Array<{ id: string | null; label: string; folderCount: number; platform: string | null; icon: string | null }>
    totals: {
        sessions: number
        mapped: number
        active: number
        needsApproval: number
        pushingMainlines: number
        stalledMainlines: number
        unassignedSessions: number
    }
}

export function projectKeyOfSession(session: SessionSummary): string {
    const path = session.metadata?.worktree?.basePath ?? session.metadata?.path ?? 'Other'
    return `${session.metadata?.machineId ?? UNKNOWN_MACHINE_ID}::${path}`
}

export function splitProjectKey(projectKey: string): { machineId: string | null; path: string } {
    const index = projectKey.indexOf('::')
    if (index < 0) return { machineId: null, path: projectKey }
    const machineId = projectKey.slice(0, index)
    return { machineId: machineId === UNKNOWN_MACHINE_ID ? null : machineId, path: projectKey.slice(index + 2) }
}

export function folderDisplayName(path: string): string {
    const parts = path.split(/[\\/]+/).filter(Boolean)
    if (parts.length === 0) return path
    return parts.length === 1 ? parts[0]! : `${parts[parts.length - 2]}/${parts[parts.length - 1]}`
}

export function statusOf(lastActivity: number, now: number): WorkStatus {
    if (!lastActivity) return 'stall'
    const days = Math.floor((now - lastActivity) / DAY_MS)
    return days <= 7 ? 'push' : days <= 30 ? 'slow' : 'stall'
}

const STATUS_ORDER: Record<WorkStatus, number> = { push: 0, slow: 1, stall: 2 }

function emptyStats(): Omit<LineStats, 'status'> {
    return { sessionCount: 0, activeCount: 0, thinkingCount: 0, pendingCount: 0, lastActivity: 0, machineLabels: [], machineIds: [] }
}

function addSession(stats: Omit<LineStats, 'status'>, session: SessionSummary, machineLabel: string, machineId: string | null): void {
    stats.sessionCount += 1
    if (session.active) stats.activeCount += 1
    if (session.thinking) stats.thinkingCount += 1
    if (session.pendingRequestsCount > 0) stats.pendingCount += 1
    if (session.updatedAt > stats.lastActivity) stats.lastActivity = session.updatedAt
    if (!stats.machineLabels.includes(machineLabel)) {
        stats.machineLabels.push(machineLabel)
        stats.machineIds.push(machineId)
    }
}

export function deriveWork(input: {
    map: WorkMap
    sessions: SessionSummary[]
    machines: MachineInfo[]
    username: string | null | undefined
    digests: Record<string, FolderDigest>
    now: number
}): WorkModel {
    const { map, sessions, now } = input
    const machineById = new Map(input.machines.map(machine => [machine.id, machine]))
    const labelOf = (machineId: string | null) => (machineId ? machineById.get(machineId)?.label ?? machineId.slice(0, 8) : '?')
    const lineById = new Map(map.lines.map(line => [line.id, line]))
    const isSubline = (id: string | null | undefined): id is string => !!id && lineById.get(id)?.parentId != null
    const folderRows = new Map(map.folders.map(folder => [folder.projectKey, folder]))
    const sessionRows = new Map(map.sessions.map(row => [row.sessionId, row]))
    const isMine = (machineId: string | null) => {
        if (!machineId || !input.username) return false
        return machineById.get(machineId)?.ownerUsername === input.username
    }

    const folders = new Map<string, FolderStat>()
    const folderOf = (projectKey: string): FolderStat => {
        let stat = folders.get(projectKey)
        if (!stat) {
            const { machineId, path } = splitProjectKey(projectKey)
            const row = folderRows.get(projectKey)
            stat = {
                projectKey,
                machineId,
                machineLabel: labelOf(machineId),
                path,
                displayName: folderDisplayName(path),
                project: row?.project ?? folderDisplayName(path),
                mode: row?.mode ?? 'unassigned',
                lineId: row?.mode === 'line' && isSubline(row.lineId) ? row.lineId : null,
                sessionCount: 0,
                activeCount: 0,
                pendingCount: 0,
                lastActivity: 0,
                digest: input.digests[projectKey] ?? null
            }
            folders.set(projectKey, stat)
        }
        return stat
    }

    const sublineStats = new Map<string, Omit<LineStats, 'status'> & { loose: number }>()
    const statsOf = (lineId: string) => {
        let stats = sublineStats.get(lineId)
        if (!stats) {
            stats = { ...emptyStats(), loose: 0 }
            sublineStats.set(lineId, stats)
        }
        return stats
    }

    const sublineOfSession = new Map<string, string>()
    const looseSessions: LooseSession[] = []
    const unassignedSessionIds = new Set<string>()
    let inScope = 0
    let unassignedSessions = 0
    let active = 0
    let needsApproval = 0

    for (const session of sessions) {
        const projectKey = projectKeyOfSession(session)
        const machineId = session.metadata?.machineId ?? null
        const sessionRow = sessionRows.get(session.id)
        const folderRow = folderRows.get(projectKey)
        if (!isMine(machineId) && !sessionRow && !folderRow) continue
        inScope += 1
        if (session.active) active += 1
        if (session.pendingRequestsCount > 0) needsApproval += 1
        const folder = folderOf(projectKey)
        const machineLabel = folder.machineLabel

        let lineId: string | null = null
        let ignored = false
        if (sessionRow) {
            if (isSubline(sessionRow.lineId)) lineId = sessionRow.lineId
            else ignored = true
        } else if (folderRow?.mode === 'line' && isSubline(folderRow.lineId)) {
            lineId = folderRow.lineId
        } else if (folderRow?.mode === 'ignored') {
            ignored = true
        }

        if (lineId) {
            sublineOfSession.set(session.id, lineId)
            const stats = statsOf(lineId)
            addSession(stats, session, machineLabel, machineId)
            if (folder.lineId === lineId) {
                folder.sessionCount += 1
                if (session.active) folder.activeCount += 1
                if (session.pendingRequestsCount > 0) folder.pendingCount += 1
                if (session.updatedAt > folder.lastActivity) folder.lastActivity = session.updatedAt
            } else {
                stats.loose += 1
            }
            continue
        }
        if (ignored) continue
        unassignedSessions += 1
        unassignedSessionIds.add(session.id)
        folder.sessionCount += 1
        if (session.active) folder.activeCount += 1
        if (session.updatedAt > folder.lastActivity) folder.lastActivity = session.updatedAt
        if (folderRow?.mode === 'mixed') looseSessions.push({ session, projectKey, machineLabel })
    }

    // 映射里有、但目前没有会话的目录也要出现在支线下（会话可能被删了或还没同步）。
    for (const row of map.folders) {
        if (row.mode === 'line' && isSubline(row.lineId)) folderOf(row.projectKey)
    }

    const mainlines: MainlineView[] = []
    const mainlineOfLine = new Map<string, string>()
    const sortLines = (a: WorkLine, b: WorkLine) => a.sort - b.sort || a.id.localeCompare(b.id)
    for (const main of map.lines.filter(line => line.parentId === null).sort(sortLines)) {
        const mainStats = emptyStats()
        const todoCandidates: Array<{ text: string; project: string; projectKey: string; at: number }> = []
        const sublines: SublineView[] = []
        mainlineOfLine.set(main.id, main.id)
        for (const sub of map.lines.filter(line => line.parentId === main.id).sort(sortLines)) {
            mainlineOfLine.set(sub.id, main.id)
            const stats = sublineStats.get(sub.id) ?? { ...emptyStats(), loose: 0 }
            mainStats.sessionCount += stats.sessionCount
            mainStats.activeCount += stats.activeCount
            mainStats.thinkingCount += stats.thinkingCount
            mainStats.pendingCount += stats.pendingCount
            mainStats.lastActivity = Math.max(mainStats.lastActivity, stats.lastActivity)
            stats.machineLabels.forEach((label, index) => {
                if (mainStats.machineLabels.includes(label)) return
                mainStats.machineLabels.push(label)
                mainStats.machineIds.push(stats.machineIds[index] ?? null)
            })

            const byProject = new Map<string, FolderStat[]>()
            for (const folder of folders.values()) {
                if (folder.lineId !== sub.id) continue
                const list = byProject.get(folder.project) ?? []
                list.push(folder)
                byProject.set(folder.project, list)
                const todo = folder.digest?.todo?.[0]
                if (todo) todoCandidates.push({ text: todo, project: folder.project, projectKey: folder.projectKey, at: folder.lastActivity })
            }
            const projects: ProjectStat[] = [...byProject.entries()].map(([name, list]) => {
                list.sort((a, b) => b.lastActivity - a.lastActivity)
                return {
                    name,
                    folders: list,
                    sessionCount: list.reduce((sum, folder) => sum + folder.sessionCount, 0),
                    activeCount: list.reduce((sum, folder) => sum + folder.activeCount, 0),
                    lastActivity: Math.max(0, ...list.map(folder => folder.lastActivity)),
                    stage: list.find(folder => folder.digest?.stage)?.digest?.stage ?? null,
                    machines: [...new Set(list.map(folder => folder.machineLabel))]
                }
            }).sort((a, b) => b.lastActivity - a.lastActivity)

            sublines.push({
                ...sub,
                sessionCount: stats.sessionCount,
                activeCount: stats.activeCount,
                thinkingCount: stats.thinkingCount,
                pendingCount: stats.pendingCount,
                lastActivity: stats.lastActivity,
                machineLabels: stats.machineLabels,
                machineIds: stats.machineIds,
                status: statusOf(stats.lastActivity, now),
                projects,
                looseSessionCount: stats.loose
            })
        }
        mainlines.push({
            ...main,
            ...mainStats,
            status: statusOf(mainStats.lastActivity, now),
            sublines,
            nextStep: todoCandidates.length > 0
                ? (({ text, project, projectKey }) => ({ text, project, projectKey }))(todoCandidates.reduce((best, item) => (item.at > best.at ? item : best)))
                : null
        })
    }
    mainlines.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.lastActivity - a.lastActivity || a.sort - b.sort)

    const unassignedFolders = [...folders.values()]
        .filter(folder => folder.mode === 'unassigned' && folder.sessionCount > 0)
        .sort((a, b) => b.lastActivity - a.lastActivity)
    looseSessions.sort((a, b) => b.session.updatedAt - a.session.updatedAt)

    const folderCountByMachine = new Map<string | null, number>()
    for (const folder of folders.values()) {
        if (folder.mode === 'ignored') continue
        folderCountByMachine.set(folder.machineId, (folderCountByMachine.get(folder.machineId) ?? 0) + 1)
    }
    const machines = [...folderCountByMachine.entries()]
        .map(([id, folderCount]) => ({ id, label: labelOf(id), folderCount, platform: (id && machineById.get(id)?.platform) || null, icon: (id && machineById.get(id)?.icon) || null }))
        .sort((a, b) => b.folderCount - a.folderCount || a.label.localeCompare(b.label))

    return {
        mainlines,
        sublineOfSession,
        mainlineOfLine,
        folders,
        unassignedFolders,
        looseSessions,
        unassignedSessionIds,
        machines,
        totals: {
            sessions: inScope,
            mapped: sublineOfSession.size,
            active,
            needsApproval,
            pushingMainlines: mainlines.filter(line => line.status === 'push').length,
            stalledMainlines: mainlines.filter(line => line.status === 'stall').length,
            unassignedSessions
        }
    }
}

/** 选中的线（主线或支线）→ 会话过滤谓词。 */
export function sessionsInLine(model: WorkModel, lineId: string): Set<string> {
    const sublines = new Set<string>()
    for (const [id, mainId] of model.mainlineOfLine) {
        if (id === lineId || (mainId === lineId && id !== mainId)) sublines.add(id)
    }
    const ids = new Set<string>()
    for (const [sessionId, sublineId] of model.sublineOfSession) {
        if (sublines.has(sublineId)) ids.add(sessionId)
    }
    return ids
}

export function findLine(model: WorkModel, lineId: string): { main: MainlineView; sub: SublineView | null } | null {
    for (const main of model.mainlines) {
        if (main.id === lineId) return { main, sub: null }
        const sub = main.sublines.find(item => item.id === lineId)
        if (sub) return { main, sub }
    }
    return null
}

/**
 * 时间泳道：每条主线最近 days 天每天「最后更新落在这天」的会话数（本地日）。
 * 返回值按 model.mainlines 的顺序；unmapped 是同期没归到任何主线的会话数。
 */
export function dailyActivity(model: WorkModel, sessions: SessionSummary[], days: number, now: number): {
    days: number[]
    byMainline: Map<string, number[]>
    unmapped: number
} {
    const today = new Date(now)
    today.setHours(0, 0, 0, 0)
    const start = today.getTime() - (days - 1) * DAY_MS
    const dayStarts = Array.from({ length: days }, (_, index) => {
        const date = new Date(start)
        date.setDate(date.getDate() + index)
        return date.getTime()
    })
    const byMainline = new Map(model.mainlines.map(line => [line.id, new Array<number>(days).fill(0)]))
    let unmapped = 0
    for (const session of sessions) {
        if (session.updatedAt < start) continue
        const day = new Date(session.updatedAt)
        day.setHours(0, 0, 0, 0)
        const index = dayStarts.indexOf(day.getTime())
        if (index < 0) continue
        const sub = model.sublineOfSession.get(session.id)
        const main = sub ? model.mainlineOfLine.get(sub) : undefined
        if (main) byMainline.get(main)![index]! += 1
        else if (model.unassignedSessionIds.has(session.id)) unmapped += 1
    }
    return { days: dayStarts, byMainline, unmapped }
}

/** 会话列表的过滤条件：主线/支线、机器、目录、某一天、只看运行中/待审批，可以组合。 */
export type WorkFilter = {
    lineId?: string
    machineId?: string
    projectKey?: string
    /** 本地日零点（毫秒）。 */
    day?: number
    mode?: 'running' | 'pending'
}

export function isEmptyFilter(filter: WorkFilter | null | undefined): boolean {
    return !filter || (!filter.lineId && !filter.machineId && !filter.projectKey && filter.day === undefined && !filter.mode)
}

/** 返回过滤谓词；线已被删除时那一项忽略。 */
export function sessionFilterPredicate(model: WorkModel, filter: WorkFilter): (session: SessionSummary) => boolean {
    const lineIds = filter.lineId && findLine(model, filter.lineId) ? sessionsInLine(model, filter.lineId) : null
    return session => {
        if (lineIds && !lineIds.has(session.id)) return false
        if (filter.machineId && session.metadata?.machineId !== filter.machineId) return false
        if (filter.projectKey && projectKeyOfSession(session) !== filter.projectKey) return false
        if (filter.day !== undefined && (session.updatedAt < filter.day || session.updatedAt >= filter.day + DAY_MS)) return false
        if (filter.mode === 'running' && !session.active) return false
        if (filter.mode === 'pending' && session.pendingRequestsCount <= 0) return false
        return true
    }
}

/** 一条线（主线或支线）里最近更新的会话——「继续工作」打开它。 */
export function latestSessionInLine(model: WorkModel, sessions: SessionSummary[], lineId: string): SessionSummary | null {
    const ids = sessionsInLine(model, lineId)
    let best: SessionSummary | null = null
    for (const session of sessions) {
        if (ids.has(session.id) && (!best || session.updatedAt > best.updatedAt)) best = session
    }
    return best
}

/** 一个目录里最近更新的会话。 */
export function latestSessionInFolder(sessions: SessionSummary[], projectKey: string): SessionSummary | null {
    let best: SessionSummary | null = null
    for (const session of sessions) {
        if (projectKeyOfSession(session) === projectKey && (!best || session.updatedAt > best.updatedAt)) best = session
    }
    return best
}
