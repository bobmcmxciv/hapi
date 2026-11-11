import { useCallback, useEffect, useState } from 'react'

export type ProjectSidebarMode = 'directories' | 'projects' | 'favorites'
export type ProjectSidebarPreferences = {
    mode: ProjectSidebarMode
    favorites: Record<string, boolean>
    collapsed: Record<string, boolean>
    aliases: Record<string, string>
    collapseAll: boolean
    miscellaneousOpen: boolean
}
const defaults = (): ProjectSidebarPreferences => ({ mode: 'projects', favorites: {}, collapsed: {}, aliases: {}, collapseAll: false, miscellaneousOpen: false })

export function readProjectPreferences(scope?: string): ProjectSidebarPreferences {
    if (!scope) return defaults()
    try {
        const value: unknown = JSON.parse(localStorage.getItem(`hapi.beta.projects.v1:${scope}`) ?? 'null')
        if (!value || typeof value !== 'object') return defaults()
        const data = value as Record<string, unknown>
        const booleans = (input: unknown): Record<string, boolean> => Object.fromEntries(input && typeof input === 'object' ? Object.entries(input).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean') : [])
        return {
            mode: data.mode === 'directories' || data.mode === 'favorites' ? data.mode : 'projects',
            favorites: booleans(data.favorites), collapsed: booleans(data.collapsed),
            aliases: Object.fromEntries(data.aliases && typeof data.aliases === 'object' ? Object.entries(data.aliases).filter((entry): entry is [string, string] => typeof entry[1] === 'string') : []),
            collapseAll: data.collapseAll === true, miscellaneousOpen: data.miscellaneousOpen === true,
        }
    } catch { return defaults() }
}

/** Caller supplies an opaque Hub/account scope, never an access token. */
export function useProjectPreferences(scope?: string) {
    const [snapshot, setSnapshot] = useState(() => ({ scope, value: readProjectPreferences(scope) }))
    const value = snapshot.scope === scope ? snapshot.value : readProjectPreferences(scope)
    useEffect(() => {
        setSnapshot(current => current.scope === scope ? current : { scope, value: readProjectPreferences(scope) })
    }, [scope])
    const update = useCallback((change: (current: ProjectSidebarPreferences) => ProjectSidebarPreferences) => {
        setSnapshot(current => {
            const next = change(current.scope === scope ? current.value : readProjectPreferences(scope))
            if (scope) {
                try { localStorage.setItem(`hapi.beta.projects.v1:${scope}`, JSON.stringify(next)) } catch { /* Preferences stay usable without storage. */ }
            }
            return { scope, value: next }
        })
    }, [scope])
    return [value, update] as const
}
