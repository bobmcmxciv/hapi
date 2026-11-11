import { describe, expect, it } from 'vitest'
import { createVirtualRowHeights, selectVirtualIndices } from './betaVirtualizer'

describe('beta measured row-height index', () => {
    it('uses estimates for unmounted rows, exact heights for measured rows, and binary-search boundaries', () => {
        const index = createVirtualRowHeights(100)
        index.setRowIds(['a', 'b', 'c', 'd'])
        expect(index.totalHeight()).toBe(400)
        expect(index.indexAtY(0)).toBe(0)
        expect(index.indexAtY(99)).toBe(0)
        expect(index.indexAtY(100)).toBe(1)
        expect(index.indexAtY(400)).toBe(4)
        expect(index.setHeight('b', 250)).toBe(true)
        expect(index.offsetOf(2)).toBe(350)
        expect(index.totalHeight()).toBe(550)
        expect(index.indexAtY(349)).toBe(1)
        expect(index.indexAtY(350)).toBe(2)
    })

    it('preserves known heights by stable id on prepend, canonical replacement and eviction', () => {
        const index = createVirtualRowHeights(100)
        index.setRowIds(['a', 'b'])
        index.setHeight('a', 180)
        index.setHeight('b', 40)
        const anchorOffset = index.offsetOf(1) - 160
        index.setRowIds(['older', 'a', 'b'])
        // Restoring b + offset keeps the same visual content after prepend.
        expect(index.offsetOf(2) - anchorOffset).toBe(260)
        index.setRowIds(['a', 'b', 'new'])
        expect(index.totalHeight()).toBe(320)
        expect(index.setHeight('a', 180.2)).toBe(false)
        expect(index.setHeight('a', Number.NaN)).toBe(false)
        expect(index.setHeight('a', 0)).toBe(false)
    })

    it('handles large history windows without mounting or measuring all rows', () => {
        const index = createVirtualRowHeights(160)
        index.setRowIds(Array.from({ length: 10000 }, (_, i) => String(i)))
        const start = index.indexAtY(800000 - 800)
        const end = index.indexAtY(800000 + 1600)
        expect(end - start).toBe(15)
        expect(index.totalHeight()).toBe(1600000)
    })

    it('keeps remote focus and selection pins disjoint from the bounded window', () => {
        expect(selectVirtualIndices({ start: 10, end: 13 }, 10000, [-1, 10000, 2, 9999])).toEqual([2, 10, 11, 12, 9999])
        expect(selectVirtualIndices({ start: 0, end: 1000 }, 10000, []).length).toBe(100)
        expect(selectVirtualIndices({ start: 0, end: 0 }, 0, [2])).toEqual([])
    })
})
