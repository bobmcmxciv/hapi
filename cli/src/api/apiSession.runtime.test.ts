import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { configuration } from '@/configuration'
import type { Session } from './types'
import type { RuntimePublication, RuntimePatch } from '@hapi/protocol/runtimeTimeline'
import { createRuntimeSnapshot } from '@hapi/protocol/runtimeTimeline'
import type { SessionRuntimeAck } from '@hapi/protocol'

const ioMock = vi.hoisted(() => vi.fn())
vi.mock('socket.io-client', () => ({ io: ioMock }))
vi.mock('../modules/common/registerCommonHandlers', () => ({ registerCommonHandlers() { } }))
vi.mock('@/terminal/TerminalManager', () => ({ TerminalManager: class { closeAll() { } } }))
vi.mock('@/modules/common/generatedBlobUpload', () => ({
    configureGeneratedBlobUploader() { }, hasPendingGeneratedBlobUploads: () => false,
    registerGeneratedBlobSource() { },
    waitForGeneratedBlobUploads: async () => { }
}))
vi.mock('@/modules/common/generatedFiles', () => ({ resumePendingGeneratedFileUploads: async () => [] }))
import { ApiSessionClient } from './apiSession'

const clients: ApiSessionClient[] = []
function harness() {
    const listeners = new Map<string, (data?: unknown) => void>()
    const runtimeEmit = vi.fn()
    const socket = {
        connected: false,
        on: vi.fn((name: string, listener: (data?: unknown) => void) => listeners.set(name, listener)),
        emit: vi.fn(), connect: vi.fn(), disconnect: vi.fn(),
        timeout: vi.fn(() => ({ emit: runtimeEmit })), volatile: { emit: vi.fn() }
    }
    ioMock.mockReturnValue(socket)
    const client = new ApiSessionClient('token', {
        id: 'session-1', metadata: null, metadataVersion: 0, agentState: null, agentStateVersion: 0
    } as Session)
    clients.push(client)
    return { client, socket, runtimeEmit, listeners }
}
function patch(seq: number): RuntimePublication {
    const value: RuntimePatch = {
        version: 1, epoch: 'launch', seq, updatedAt: seq,
        changes: [{ type: 'item', item: { id: 'a', kind: 'assistant', runId: 'run', createdAt: 1, updatedAt: seq, state: 'running', text: `text-${seq}` } }]
    }
    return { kind: 'patch', patch: value }
}
function initialize(client: ApiSessionClient) {
    client.publishRuntime({ kind: 'snapshot', snapshot: createRuntimeSnapshot('launch') })
}

beforeEach(() => {
    configuration._setApiUrl('https://hapi.example.com')
    ioMock.mockReset()
})
afterEach(() => { for (const client of clients.splice(0)) client.close() })

describe('ApiSessionClient native runtime transport', () => {
    it('never puts disconnected patches in Socket.IO sendBuffer and reconnects with latest snapshot then contiguous patches', () => {
        const h = harness()
        initialize(h.client)
        h.client.publishRuntime(patch(1))
        expect(h.runtimeEmit).not.toHaveBeenCalled()
        h.socket.connected = true
        h.listeners.get('connect')?.()
        expect(h.runtimeEmit.mock.calls[0][1]).toMatchObject({ sid: 'session-1', publication: { kind: 'snapshot', snapshot: { epoch: 'launch', seq: 1, items: [{ text: 'text-1' }] } } })
        h.client.publishRuntime(patch(2))
        expect(h.runtimeEmit.mock.calls[1][1]).toMatchObject({ publication: { kind: 'patch', patch: { seq: 2 } } })
        h.socket.connected = false
        h.listeners.get('disconnect')?.('transport close')
        h.client.publishRuntime(patch(3))
        expect(h.runtimeEmit).toHaveBeenCalledTimes(2)
        h.socket.connected = true
        h.listeners.get('connect')?.()
        expect(h.runtimeEmit.mock.calls[2][1]).toMatchObject({ publication: { kind: 'snapshot', snapshot: { seq: 3, items: [{ text: 'text-3' }] } } })
        h.client.publishRuntime(patch(4))
        expect(h.runtimeEmit.mock.calls[3][1]).toMatchObject({ publication: { kind: 'patch', patch: { seq: 4 } } })
        expect(h.socket.emit.mock.calls.some(call => call[0] === 'session-runtime')).toBe(false)
    })

    it('replays an authoritative same-epoch snapshot for hub resync ack or sid-matched resync event', () => {
        const h = harness()
        h.socket.connected = true
        initialize(h.client)
        h.client.publishRuntime(patch(1))
        const ack = h.runtimeEmit.mock.calls[1][2] as (error: Error | null, result?: SessionRuntimeAck) => void
        ack(null, { result: 'resync' })
        expect(h.runtimeEmit.mock.calls[2][1]).toMatchObject({ publication: { kind: 'snapshot', snapshot: { epoch: 'launch', seq: 1 } } })
        h.listeners.get('session-runtime:resync')?.({ sid: 'other' })
        expect(h.runtimeEmit).toHaveBeenCalledTimes(3)
        h.listeners.get('session-runtime:resync')?.({ sid: 'session-1', epoch: 'old' })
        expect(h.runtimeEmit).toHaveBeenCalledTimes(4)
        ack(null, { result: 'error' })
        expect(h.runtimeEmit).toHaveBeenCalledTimes(4)
    })

    it('validates raw publications and rejects gaps before mutating local reconnect truth', () => {
        const h = harness()
        initialize(h.client)
        h.client.publishRuntime({ kind: 'patch', patch: { ...patch(1), seq: -1 } } as unknown as RuntimePublication)
        h.client.publishRuntime(patch(2))
        h.socket.connected = true
        h.listeners.get('connect')?.()
        expect(h.runtimeEmit.mock.calls[0][1]).toMatchObject({ publication: { kind: 'snapshot', snapshot: { seq: 0, items: [] } } })
    })

    it('defers native-ready until the alive barrier and cancels stale disconnected readiness', () => {
        const h = harness()
        h.client.emitSessionReady()
        // Socket.IO flushes its sendBuffer before firing connect. Ready there
        // would arrive before alive and be rejected by the Hub's inactive guard.
        expect(h.socket.emit.mock.calls.filter(call => call[0] === 'session-ready')).toEqual([])
        h.socket.connected = true
        h.listeners.get('connect')?.()
        expect(h.socket.emit.mock.calls.map(call => call[0])).toEqual(['session-alive', 'session-ready'])
        h.socket.connected = false
        h.listeners.get('disconnect')?.('transport close')
        h.socket.emit.mockClear()
        h.client.emitSessionReady({ replayOnReconnect: true })
        h.client.clearSessionReady()
        h.socket.connected = true
        h.listeners.get('connect')?.()
        expect(h.socket.emit.mock.calls.map(call => call[0])).toEqual(['session-alive'])
    })
})
