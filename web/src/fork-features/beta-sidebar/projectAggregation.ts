import type { SessionSummary } from '@/types/api'
import { folderDisplayName, projectKeyOfSession } from '@/fork-features/work-overview/deriveWork'
import type { ProjectDigest } from '@/fork-features/session-digest/digestApi'

export type ProjectOrigin = {
    key: string
    directory: string
    machineId: string | null
    sessions: SessionSummary[]
}
export type SidebarProject = {
    key: string
    favoriteKey: string
    directory: string
    displayName: string
    machineId: string | null
    sessions: SessionSummary[]
    origins: ProjectOrigin[]
    latestUpdatedAt: number
    hasActiveSession: boolean
    activeCount: number
    miscellaneous: boolean
    digest?: ProjectDigest
}

export function normalizeProjectDirectory(path: string): string {
    const slashes = path.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/')
    const root = slashes.startsWith('/') ? '/' : ''
    const parts: string[] = []
    for (const part of slashes.split('/')) {
        if (!part || part === '.') continue
        if (part === '..' && parts.length && parts[parts.length - 1] !== '..') parts.pop()
        else parts.push(part)
    }
    const result = root + parts.join('/')
    return /^[a-z]:/i.test(result) ? result.toLowerCase() : result
}

/** Home roots only; named projects below a home directory remain projects. */
export function isMiscellaneousDirectory(path: string): boolean {
    const value = normalizeProjectDirectory(path).toLowerCase()
    if (!value || value === 'other' || value === '/' || /^[a-z]:$/.test(value) || value === '~') return true
    if (/^(?:[a-z]:)?\/users\/[^/]+$/.test(value) || /^\/home\/[^/]+$/.test(value) || value === '/root') return true
    return /(?:^|\/)(?:temp|tmp|\.tmp|live-probe(?:[-_][^/]*)?)(?:\/|$)/.test(value)
}

function compareSessions(a: SessionSummary, b: SessionSummary): number {
    const rank = (s: SessionSummary) => s.active ? s.pendingRequestsCount > 0 ? 0 : 1 : 2
    return rank(a) - rank(b) || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)
}

export function buildSidebarProjects(
    sessions: SessionSummary[],
    owners: Readonly<Record<string, string | null | undefined>>,
    digests: ReadonlyMap<string, ProjectDigest> = new Map(),
    homeDirectories: Readonly<Record<string, string | null | undefined>> = {},
): { directories: SidebarProject[]; projects: SidebarProject[] } {
    const origins = new Map<string, ProjectOrigin>()
    for (const session of sessions) {
        const key = projectKeyOfSession(session)
        let origin = origins.get(key)
        if (!origin) {
            origin = { key, directory: session.metadata?.worktree?.basePath ?? session.metadata?.path ?? 'Other', machineId: session.metadata?.machineId ?? null, sessions: [] }
            origins.set(key, origin)
        }
        origin.sessions.push(session)
    }
    const miscellaneousOrigins = new Set([...origins.values()].filter(origin => {
        const home = origin.machineId ? homeDirectories[origin.machineId] : undefined
        return isMiscellaneousDirectory(origin.directory) || Boolean(home && normalizeProjectDirectory(home) === normalizeProjectDirectory(origin.directory))
    }).map(origin => origin.key))
    const identity = (origin: ProjectOrigin) => {
        if (miscellaneousOrigins.has(origin.key)) return `misc:${origin.key}`
        const directory = normalizeProjectDirectory(origin.directory)
        const name = directory.split('/').filter(Boolean).at(-1) ?? directory
        const owner = origin.machineId ? owners[origin.machineId]?.trim() : undefined
        // An unknown owner is NOT evidence that two machines belong to one person.
        // A missing machine has no trustworthy identity, even when hosts look alike.
        const scope = owner ? ['owner', owner] : origin.machineId ? ['machine', origin.machineId] : ['origin', origin.key]
        return `project:${JSON.stringify([...scope, name])}`
    }
    const make = (key: string, sources: ProjectOrigin[], directoryMode: boolean): SidebarProject => {
        const ordered = sources.flatMap(origin => origin.sessions).sort(compareSessions)
        let latestDigest: ProjectDigest | undefined
        for (const source of sources) {
            const digest = digests.get(source.key)
            if (digest?.generatedAt && (!latestDigest || digest.generatedAt > (latestDigest.generatedAt ?? 0))) latestDigest = digest
        }
        let activeCount = 0
        let latestUpdatedAt = 0
        for (const session of ordered) {
            if (session.active) activeCount += 1
            latestUpdatedAt = Math.max(latestUpdatedAt, session.updatedAt)
        }
        const first = sources[0]!
        const name = first.directory.replace(/\\/g, '/').replace(/\/+$/, '').split('/').at(-1)
        return {
            key, favoriteKey: identity(first), directory: first.directory,
            displayName: directoryMode ? folderDisplayName(first.directory) : name || first.directory,
            machineId: sources.length === 1 ? first.machineId : null,
            sessions: ordered, origins: sources,
            latestUpdatedAt,
            hasActiveSession: activeCount > 0,
            activeCount,
            miscellaneous: sources.every(origin => miscellaneousOrigins.has(origin.key)),
            digest: latestDigest,
        }
    }
    const projects = new Map<string, ProjectOrigin[]>()
    const directories: SidebarProject[] = []
    for (const origin of origins.values()) {
        directories.push(make(origin.key, [origin], true))
        // Miscellaneous paths never aggregate unrelated temporary/home sessions.
        const key = identity(origin)
        const sources = projects.get(key) ?? []
        sources.push(origin)
        projects.set(key, sources)
    }
    return { directories, projects: [...projects].map(([key, sources]) => make(key, sources, false)) }
}

export function sortSidebarProjects(projects: SidebarProject[], favorites: Readonly<Record<string, boolean>>): SidebarProject[] {
    return [...projects].sort((a, b) => Number(Boolean(favorites[b.favoriteKey])) - Number(Boolean(favorites[a.favoriteKey])) || Number(b.hasActiveSession) - Number(a.hasActiveSession) || b.latestUpdatedAt - a.latestUpdatedAt || a.key.localeCompare(b.key))
}
