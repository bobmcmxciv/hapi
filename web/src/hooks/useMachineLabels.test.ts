import { beforeEach, describe, expect, it } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { Machine, MachineWithOwner } from '@/types/api'
import { getMachineTitle, useMachineLabels, useMachineOwners } from './useMachineLabels'

function makeMachine(id: string, metadata: Machine['metadata']): Machine {
    return {
        id,
        namespace: 'default',
        seq: 1,
        createdAt: 0,
        updatedAt: 0,
        active: true,
        activeAt: 0,
        metadata,
        metadataVersion: 1,
        runnerState: null,
        runnerStateVersion: 0,
    }
}

describe('getMachineTitle', () => {
    it('prefers displayName, then host, then the id prefix', () => {
        expect(getMachineTitle(makeMachine('abcdef123456', { displayName: 'Work', host: 'mac' } as Machine['metadata']))).toBe('Work')
        expect(getMachineTitle(makeMachine('abcdef123456', { host: 'mac' } as Machine['metadata']))).toBe('mac')
        expect(getMachineTitle(makeMachine('abcdef123456', null))).toBe('abcdef12')
    })
})

describe('useMachineLabels', () => {
    beforeEach(() => {
        window.localStorage.clear()
    })

    it('returns live titles and caches them', () => {
        const machines = [makeMachine('machine-1', { host: 'MacBook Pro' } as Machine['metadata'])]
        const { result } = renderHook(() => useMachineLabels(machines))

        expect(result.current['machine-1']).toBe('MacBook Pro')
        expect(JSON.parse(window.localStorage.getItem('hapi-machine-labels')!)).toEqual({ 'machine-1': 'MacBook Pro' })
    })

    it('keeps the cached label when the machine is absent from the list', () => {
        window.localStorage.setItem('hapi-machine-labels', JSON.stringify({ 'gone-machine': 'MacBook Pro' }))
        const { result } = renderHook(() => useMachineLabels([]))

        expect(result.current['gone-machine']).toBe('MacBook Pro')
    })

    it('prefers the live title over a stale cached one', () => {
        window.localStorage.setItem('hapi-machine-labels', JSON.stringify({ 'machine-1': 'old-name' }))
        const machines = [makeMachine('machine-1', { host: 'new-name' } as Machine['metadata'])]
        const { result } = renderHook(() => useMachineLabels(machines))

        expect(result.current['machine-1']).toBe('new-name')
    })
})

// The machine filter bar only splits into per-owner sections once it can see
// two or more owners, and ownership rides exclusively on the /api/machines
// projection. Any gap in that data used to read as "unowned" and collapse the
// whole bar to a flat list, so the layout visibly flipped back and forth.
describe('useMachineOwners', () => {
    beforeEach(() => {
        window.localStorage.clear()
    })

    function owned(id: string, ownerUsername?: string): MachineWithOwner {
        return { ...makeMachine(id, { host: id } as Machine['metadata']), ownerUsername }
    }

    it('records and caches the owner reported by /api/machines', () => {
        const { result } = renderHook(() => useMachineOwners([owned('m1', 'admin'), owned('m2', 'peter')]))

        expect(result.current).toEqual({ m1: 'admin', m2: 'peter' })
        expect(JSON.parse(window.localStorage.getItem('hapi-machine-owners')!)).toEqual({ m1: 'admin', m2: 'peter' })
    })

    it('keeps the last known owner when a machine arrives without one', () => {
        window.localStorage.setItem('hapi-machine-owners', JSON.stringify({ m1: 'admin', m2: 'peter' }))

        // An undecorated machine must not erase what we already knew — that is
        // exactly the transient that used to drop the owner count below two.
        const { result } = renderHook(() => useMachineOwners([owned('m1'), owned('m2', 'peter')]))

        expect(result.current.m1).toBe('admin')
        expect(result.current.m2).toBe('peter')
    })

    it('keeps owners across an empty machines list', () => {
        window.localStorage.setItem('hapi-machine-owners', JSON.stringify({ m1: 'admin', m2: 'peter' }))
        const { result } = renderHook(() => useMachineOwners([]))

        expect(result.current).toEqual({ m1: 'admin', m2: 'peter' })
    })

    it('follows a genuine ownership change', () => {
        window.localStorage.setItem('hapi-machine-owners', JSON.stringify({ m1: 'admin' }))
        const { result } = renderHook(() => useMachineOwners([owned('m1', 'peter')]))

        expect(result.current.m1).toBe('peter')
    })
})
