import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

async function loadPrefs() {
    vi.resetModules()
    return import('./listPrefs')
}

describe('list preferences', () => {
    beforeEach(() => localStorage.clear())

    it('uses defaults', async () => {
        const { useListPrefs } = await loadPrefs()
        const { result } = renderHook(() => useListPrefs())
        expect(result.current).toEqual({ hiddenToolbar: [], machineLayout: 'grid' })
    })

    it('publishes and persists toolbar visibility changes immediately', async () => {
        const { useListPrefs, setToolbarButtonHidden, isToolbarButtonHidden } = await loadPrefs()
        const { result } = renderHook(() => useListPrefs())
        act(() => setToolbarButtonHidden('calendar', true))
        expect(isToolbarButtonHidden(result.current, 'calendar')).toBe(true)
        act(() => setToolbarButtonHidden('calendar', false))
        expect(result.current.hiddenToolbar).toEqual([])
    })

    it('falls back to defaults for malformed JSON', async () => {
        localStorage.setItem('hapi-list-prefs', '{')
        const { useListPrefs } = await loadPrefs()
        const { result } = renderHook(() => useListPrefs())
        expect(result.current).toEqual({ hiddenToolbar: [], machineLayout: 'grid' })
    })

    it('persists machine layout', async () => {
        const { useListPrefs, setMachineLayout } = await loadPrefs()
        const { result } = renderHook(() => useListPrefs())
        act(() => setMachineLayout('icons'))
        expect(result.current.machineLayout).toBe('icons')
        expect(JSON.parse(localStorage.getItem('hapi-list-prefs')!).machineLayout).toBe('icons')
    })
})
