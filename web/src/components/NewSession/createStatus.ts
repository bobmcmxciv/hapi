import type { Machine } from '@/types/api'

/** How long Create waits for model-list / directory probes before launching unvalidated. */
export const LAUNCH_VALIDATION_WAIT_MS = 8_000

/** `/api/machines` lists every accessible machine, including ones whose runner is gone. */
export function isMachineOnline(machine: Machine): boolean {
    return machine.active !== false
}

export type CreateStatus = {
    messageKey: string
    tone: 'hint' | 'warning'
}

/**
 * The one line under the form that says why Create is disabled (or that it will
 * launch without a finished validation). A grey button with no reason was the
 * reported symptom; every blocking condition now has a message.
 */
export function describeCreateStatus(state: {
    canCreate: boolean
    isBusy: boolean
    machinesLoading: boolean
    hasSelectableMachines: boolean
    hasOnlineMachines: boolean
    machineSelected: boolean
    machineOffline: boolean
    directoryEntered: boolean
    /** The directory section already shows its own error for this case. */
    directoryProblemShown: boolean
    validationPending: boolean
    validationTimedOut: boolean
    ompOnly: boolean
}): CreateStatus | null {
    if (state.canCreate) {
        return state.validationPending && state.validationTimedOut
            ? { messageKey: 'newSession.status.validationTimedOut', tone: 'warning' }
            : null
    }
    if (state.isBusy || state.machinesLoading) {
        return null
    }
    if (!state.hasSelectableMachines) {
        return {
            messageKey: state.ompOnly ? 'newSession.status.noOmpMachine' : 'newSession.status.noMachine',
            tone: 'warning'
        }
    }
    if (!state.machineSelected) {
        return {
            messageKey: state.hasOnlineMachines ? 'newSession.status.pickMachine' : 'newSession.status.allMachinesOffline',
            tone: 'warning'
        }
    }
    if (state.machineOffline) {
        return { messageKey: 'newSession.status.machineOffline', tone: 'warning' }
    }
    if (!state.directoryEntered) {
        return { messageKey: 'newSession.status.enterDirectory', tone: 'hint' }
    }
    if (state.directoryProblemShown) {
        return null
    }
    if (state.validationPending) {
        return { messageKey: 'newSession.status.checkingLaunchOptions', tone: 'hint' }
    }
    return null
}
