import { describe, expect, it } from 'bun:test'
import { Store, type StoredMachine } from '../../../store'
import type { CliSocketWithData } from '../../socketTypes'
import { registerMachineHandlers } from './machineHandlers'

class FakeSocket {
    readonly roomEvents: Array<{ room: string; event: string; data: unknown }> = []
    private readonly handlers = new Map<string, (data: unknown, ack?: (response: unknown) => void) => void>()

    on(event: string, handler: (data: unknown, ack?: (response: unknown) => void) => void): this {
        this.handlers.set(event, handler)
        return this
    }

    to(room: string): { emit: (event: string, data: unknown) => void } {
        return {
            emit: (event: string, data: unknown) => {
                this.roomEvents.push({ room, event, data })
            }
        }
    }

    trigger(event: string, data: unknown, ack?: (response: unknown) => void): void {
        this.handlers.get(event)?.(data, ack)
    }
}

const CLI_METADATA = {
    host: 'workstation',
    platform: 'win32',
    happyCliVersion: '0.27.1',
    workspaceRoots: ['C:\\Users\\bobmc']
}

function setup(storedMetadata: unknown) {
    const store = new Store(':memory:')
    store.machines.getOrCreateMachine('machine-1', storedMetadata, null, 'default')
    const socket = new FakeSocket()
    registerMachineHandlers(socket as unknown as CliSocketWithData, {
        store,
        resolveMachineAccess: (machineId: string) => {
            const machine = store.machines.getMachine(machineId)
            return machine
                ? { ok: true as const, value: machine as StoredMachine }
                : { ok: false as const, reason: 'not-found' as const }
        },
        emitAccessError: () => { throw new Error('unexpected access error') }
    })
    return { store, socket }
}

function pushMetadata(socket: FakeSocket, store: Store, metadata: unknown): unknown {
    const version = store.machines.getMachine('machine-1')!.metadataVersion
    let ack: unknown = null
    socket.trigger(
        'machine-update-metadata',
        { machineId: 'machine-1', expectedVersion: version, metadata },
        (response) => { ack = response }
    )
    return ack
}

describe('cli machine metadata updates', () => {
    it('keeps the hub-set displayName when the CLI replaces metadata wholesale', () => {
        const { store, socket } = setup({ ...CLI_METADATA, displayName: '吹雪3080' })

        // The runner recomputes metadata from its own cached copy, which never
        // carries displayName. Before the fix this erased the rename.
        pushMetadata(socket, store, CLI_METADATA)

        expect(store.machines.getMachine('machine-1')?.metadata).toEqual({
            ...CLI_METADATA,
            displayName: '吹雪3080'
        })
    })

    it('keeps the displayName even when the CLI pushes a metadata that lost its machine-owned fields', () => {
        const { store, socket } = setup({ ...CLI_METADATA, displayName: '吹雪3080' })

        pushMetadata(socket, store, { workspaceRoots: ['G:\\i3s_data'] })

        expect(store.machines.getMachine('machine-1')?.metadata).toEqual({
            workspaceRoots: ['G:\\i3s_data'],
            displayName: '吹雪3080'
        })
    })

    it('broadcasts the preserved name rather than the raw CLI payload', () => {
        const { store, socket } = setup({ ...CLI_METADATA, displayName: '吹雪3080' })

        pushMetadata(socket, store, CLI_METADATA)

        const update = socket.roomEvents.at(-1)?.data as {
            body: { metadata: { value: { displayName?: string } } }
        }
        expect(update.body.metadata.value.displayName).toBe('吹雪3080')
    })

    it('acks with the stored value so the runner caches the name too', () => {
        const { store, socket } = setup({ ...CLI_METADATA, displayName: '吹雪3080' })

        const ack = pushMetadata(socket, store, CLI_METADATA) as {
            result: string
            metadata: { displayName?: string }
        }
        expect(ack.result).toBe('success')
        expect(ack.metadata.displayName).toBe('吹雪3080')
    })

    it('leaves metadata untouched when the hub has no name of its own', () => {
        const { store, socket } = setup(CLI_METADATA)

        pushMetadata(socket, store, { ...CLI_METADATA, workspaceRoots: ['D:\\src'] })

        expect(store.machines.getMachine('machine-1')?.metadata).toEqual({
            ...CLI_METADATA,
            workspaceRoots: ['D:\\src']
        })
    })
})
