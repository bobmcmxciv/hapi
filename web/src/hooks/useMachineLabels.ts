import { useEffect, useMemo } from 'react'
import type { Machine, MachineWithOwner } from '@/types/api'

export function getMachineTitle(machine: Machine): string {
    if (machine.metadata?.displayName) return machine.metadata.displayName
    if (machine.metadata?.host) return machine.metadata.host
    return machine.id.slice(0, 8)
}

const STORAGE_KEY = 'hapi-machine-labels'
const OWNERS_STORAGE_KEY = 'hapi-machine-owners'

function isBrowser(): boolean {
    return typeof window !== 'undefined' && typeof document !== 'undefined'
}

function readCachedStrings(key: string): Record<string, string> {
    if (!isBrowser()) return {}
    try {
        const raw = localStorage.getItem(key)
        if (!raw) return {}
        const parsed: unknown = JSON.parse(raw)
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
        const labels: Record<string, string> = {}
        for (const [key, value] of Object.entries(parsed)) {
            if (typeof value === 'string' && value.length > 0) {
                labels[key] = value
            }
        }
        return labels
    } catch {
        return {}
    }
}

function writeCachedStrings(key: string, values: Record<string, string>): void {
    if (!isBrowser()) return
    try {
        localStorage.setItem(key, JSON.stringify(values))
    } catch {
        // Ignore storage errors
    }
}

const readCachedLabels = () => readCachedStrings(STORAGE_KEY)

/**
 * Machine id → display label for the session list. Live data from the
 * machines query wins, but labels are also cached in localStorage so a
 * machine whose row is gone (reinstalled CLI, stale sessions) or whose
 * query has not loaded yet keeps its last known name instead of falling
 * back to a raw id prefix.
 */
export function useMachineLabels(machines: Machine[]): Record<string, string> {
    const labels = useMemo(() => {
        const merged = readCachedLabels()
        for (const machine of machines) {
            merged[machine.id] = getMachineTitle(machine)
        }
        return merged
    }, [machines])

    useEffect(() => {
        writeCachedStrings(STORAGE_KEY, labels)
    }, [labels])

    return labels
}

/**
 * Machine id → owning account username, cached the same way labels are.
 *
 * Ownership only ever arrives on the `/api/machines` projection, so any moment
 * where that data is incomplete — the query has not resolved after a reload, a
 * machine dropped out of the online list, an SSE event landed before its
 * refetch — used to read as "this machine has no owner". Since the filter bar
 * only groups once it can see two or more owners, a single such gap flipped the
 * whole bar back to a flat list. Remembering the last known owner keeps the
 * grouped layout stable instead of letting it depend on refetch timing.
 */
export function useMachineOwners(machines: MachineWithOwner[]): Record<string, string> {
    const owners = useMemo(() => {
        const merged = readCachedStrings(OWNERS_STORAGE_KEY)
        for (const machine of machines) {
            if (machine.ownerUsername) {
                merged[machine.id] = machine.ownerUsername
            }
        }
        return merged
    }, [machines])

    useEffect(() => {
        writeCachedStrings(OWNERS_STORAGE_KEY, owners)
    }, [owners])

    return owners
}
