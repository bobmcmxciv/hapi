import { useSyncExternalStore } from 'react'

export const TOOLBAR_BUTTON_KEYS = ['calendar', 'archive', 'unread', 'work', 'browse', 'usage', 'new'] as const
export type ToolbarButtonKey = typeof TOOLBAR_BUTTON_KEYS[number]
export type MachineLayout = 'grid' | 'compact' | 'icons'
export type ListPrefs = { hiddenToolbar: ToolbarButtonKey[]; machineLayout: MachineLayout }
const STORAGE_KEY = 'hapi-list-prefs'
const DEFAULT_PREFS: ListPrefs = { hiddenToolbar: [], machineLayout: 'grid' }
const listeners = new Set<() => void>()
let cachedPrefs: ListPrefs | undefined

function readPrefs(): ListPrefs {
    if (cachedPrefs) return cachedPrefs
    try {
        const raw = localStorage.getItem(STORAGE_KEY)
        if (raw) {
            const value: unknown = JSON.parse(raw)
            if (typeof value === 'object' && value !== null) {
                const candidate = value as { hiddenToolbar?: unknown; machineLayout?: unknown }
                if (Array.isArray(candidate.hiddenToolbar) && candidate.hiddenToolbar.every(key => TOOLBAR_BUTTON_KEYS.includes(key))
                    && ['grid', 'compact', 'icons'].includes(candidate.machineLayout as string)) {
                    cachedPrefs = { hiddenToolbar: [...new Set(candidate.hiddenToolbar)], machineLayout: candidate.machineLayout as MachineLayout }
                    return cachedPrefs
                }
            }
        }
    } catch { /* Unavailable storage or malformed JSON uses defaults. */ }
    cachedPrefs = DEFAULT_PREFS
    return cachedPrefs
}

function notify() { for (const listener of listeners) listener() }
function subscribe(listener: () => void) {
    listeners.add(listener)
    return () => listeners.delete(listener)
}
function getSnapshot() { return readPrefs() }

export function useListPrefs(): ListPrefs {
    return useSyncExternalStore(subscribe, getSnapshot, () => DEFAULT_PREFS)
}

function updatePrefs(update: (prefs: ListPrefs) => ListPrefs) {
    const next = update(readPrefs())
    cachedPrefs = next
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)) } catch { /* Keep the in-memory preference usable. */ }
    notify()
}

export function setToolbarButtonHidden(key: ToolbarButtonKey, hidden: boolean) {
    updatePrefs(prefs => ({ ...prefs, hiddenToolbar: hidden
        ? [...new Set([...prefs.hiddenToolbar, key])]
        : prefs.hiddenToolbar.filter(item => item !== key) }))
}

export function setMachineLayout(layout: MachineLayout) {
    updatePrefs(prefs => ({ ...prefs, machineLayout: layout }))
}

export function isToolbarButtonHidden(prefs: ListPrefs, key: ToolbarButtonKey) {
    return prefs.hiddenToolbar.includes(key)
}
