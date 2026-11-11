import { describe, expect, it } from 'vitest'
import { createVirtualRowHeights, selectVirtualIndices } from '@/fork-features/beta-timeline/betaVirtualizer'
import { captureSidebarAnchor, restoreSidebarAnchor, sameSidebarValue, sidebarWindow } from './sidebarWindow'

describe('sidebar anchor geometry', () => {
    it('preserves an intra-row offset across measured growth and reordered groups', () => {
        const heights = createVirtualRowHeights(64)
        const ids = ['group:a', 'session:a', 'group:b', 'session:b']
        heights.setRowIds(ids)
        const anchor = captureSidebarAnchor(ids, heights, 64 * 3 + 11)
        heights.setHeight('session:a', 180)
        expect(restoreSidebarAnchor(anchor, ids, heights)).toBe(64 * 3 + 116 + 11)
        const reordered = ['group:b', 'session:b', 'group:a', 'session:a']
        heights.setRowIds(reordered)
        expect(restoreSidebarAnchor(anchor, reordered, heights)).toBe(64 + 11)
        heights.setRowIds(['group:a'])
        expect(restoreSidebarAnchor(anchor, ['group:a'], heights)).toBeNull()
    })

    it('bounds a large window and keeps remote focus as a disjoint pin', () => {
        const heights = createVirtualRowHeights(64)
        heights.setRowIds(Array.from({ length: 1900 }, (_, index) => String(index)))
        const range = sidebarWindow(heights, 1900, 1800 * 64, 640)
        const indices = selectVirtualIndices(range, 1900, [0], 80)
        expect(indices).toContain(0)
        expect(indices).toContain(1800)
        expect(indices).not.toContain(500)
        expect(indices.length).toBeLessThan(30)
    })
})

describe('sidebar row snapshot comparison', () => {
    it('ignores liveness-only heartbeats but retains attention, summary and action changes', () => {
        const before = { id: 'one', activeAt: 100, active: true, thinking: false, metadata: { name: 'Task' }, pendingRequests: [], todoProgress: { completed: 1, total: 2 } }
        expect(sameSidebarValue(before, { ...before, activeAt: 200 })).toBe(true)
        expect(sameSidebarValue(before, { ...before, thinking: true })).toBe(false)
        expect(sameSidebarValue(before, { ...before, metadata: { name: 'Renamed' } })).toBe(false)
        expect(sameSidebarValue(before, { ...before, pendingRequests: [{ id: 'permission' }] })).toBe(false)
        expect(sameSidebarValue(before, { ...before, todoProgress: { completed: 2, total: 2 } })).toBe(false)
        expect(sameSidebarValue(before, { ...before, active: false })).toBe(false)
    })

    it('compares cloned snapshot values but requires opaque dependencies and callbacks to keep identity', () => {
        const action = () => undefined
        const before = { session: { pendingRequestKinds: ['permission'], metadata: { name: 'Task' } }, onSelect: action }
        expect(sameSidebarValue(before, { session: { pendingRequestKinds: ['permission'], metadata: { name: 'Task' } }, onSelect: action })).toBe(true)
        expect(sameSidebarValue(before, { ...before, onSelect: () => undefined })).toBe(false)
        expect(sameSidebarValue({ value: new Date(0) }, { value: new Date(0) })).toBe(false)
    })
})
