import { describe, expect, it } from 'vitest'
import type { Machine } from '@/types/api'
import { describeCreateStatus, isMachineOnline } from './createStatus'

const ready = {
    canCreate: false,
    isBusy: false,
    machinesLoading: false,
    hasSelectableMachines: true,
    hasOnlineMachines: true,
    machineSelected: true,
    machineOffline: false,
    directoryEntered: true,
    directoryProblemShown: false,
    validationPending: false,
    validationTimedOut: false,
    ompOnly: false
}

describe('isMachineOnline', () => {
    it('treats only an explicit active=false as offline', () => {
        expect(isMachineOnline({ id: 'a', active: false } as Machine)).toBe(false)
        expect(isMachineOnline({ id: 'b', active: true } as Machine)).toBe(true)
        expect(isMachineOnline({ id: 'c' } as Machine)).toBe(true)
    })
})

describe('describeCreateStatus', () => {
    it('is silent when Create is enabled normally, while busy, or while machines load', () => {
        expect(describeCreateStatus({ ...ready, canCreate: true })).toBeNull()
        expect(describeCreateStatus({ ...ready, isBusy: true })).toBeNull()
        expect(describeCreateStatus({ ...ready, machinesLoading: true })).toBeNull()
    })

    it('warns that Create will skip a validation that timed out', () => {
        expect(describeCreateStatus({ ...ready, canCreate: true, validationPending: true, validationTimedOut: true }))
            .toEqual({ messageKey: 'newSession.status.validationTimedOut', tone: 'warning' })
    })

    it('names the first blocking condition', () => {
        expect(describeCreateStatus({ ...ready, hasSelectableMachines: false })?.messageKey).toBe('newSession.status.noMachine')
        expect(describeCreateStatus({ ...ready, hasSelectableMachines: false, ompOnly: true })?.messageKey).toBe('newSession.status.noOmpMachine')
        expect(describeCreateStatus({ ...ready, machineSelected: false })?.messageKey).toBe('newSession.status.pickMachine')
        expect(describeCreateStatus({ ...ready, machineSelected: false, hasOnlineMachines: false })?.messageKey).toBe('newSession.status.allMachinesOffline')
        expect(describeCreateStatus({ ...ready, machineOffline: true })?.messageKey).toBe('newSession.status.machineOffline')
        expect(describeCreateStatus({ ...ready, directoryEntered: false })?.messageKey).toBe('newSession.status.enterDirectory')
        expect(describeCreateStatus({ ...ready, validationPending: true })?.messageKey).toBe('newSession.status.checkingLaunchOptions')
    })

    it('leaves directory errors to the directory section', () => {
        expect(describeCreateStatus({ ...ready, directoryProblemShown: true, validationPending: true })).toBeNull()
    })
})
