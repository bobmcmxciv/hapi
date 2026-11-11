import { describe, expect, it } from 'bun:test'
import type { RuntimeSnapshot } from '@hapi/protocol/runtimeTimeline'
import type { SessionRuntimeAck } from '@hapi/protocol'
import { Store, type StoredSession } from '../../../store'
import { RuntimeTimelineRegistry } from '../../../sync/runtimeTimeline'
import type { CliSocketWithData } from '../../socketTypes'
import { registerRuntimeHandlers } from './runtimeHandlers'

type Handler = (data: unknown, ack?: (result: SessionRuntimeAck) => void) => void

class FakeSocket {
    readonly emitted: Array<{ event: string; data: unknown }> = []
    readonly handshake = { auth: {} as Record<string, unknown> }
    private readonly handlers = new Map<string, Handler>()

    constructor(readonly id: string) { }

    on(event: string, handler: Handler): this {
        this.handlers.set(event, handler)
        return this
    }

    emit(event: string, data: unknown): boolean {
        this.emitted.push({ event, data })
        return true
    }

    trigger(event: string, data: unknown, ack?: (result: SessionRuntimeAck) => void): void {
        this.handlers.get(event)?.(data, ack)
    }
}

const snapshot = (epoch: string, seq: number): RuntimeSnapshot => ({
    version: 1,
    epoch,
    seq,
    items: [],
    run: null,
    updatedAt: seq
})

function setup(sessionId = 'session-1', sessionScoped = true, authorize?: (sid: string) => boolean) {
    const store = new Store(':memory:')
    const session = store.sessions.getOrCreateSession(sessionId, {}, null, 'default') as StoredSession
    const registry = new RuntimeTimelineRegistry()
    const socket = new FakeSocket('sock-1')
    socket.handshake.auth = sessionScoped ? { sessionId } : { machineId: 'machine-1' }
    const accessErrors: Array<{ scope: string; id: string; reason: string }> = []
    registerRuntimeHandlers(socket as unknown as CliSocketWithData, {
        store,
        registry,
        resolveSessionAccess: () => ({ ok: true, value: session }),
        emitAccessError: (scope, id, reason) => accessErrors.push({ scope, id, reason }),
        // Tests opt out of principal checks by default; production always wires it.
        authorizeSessionPublication: authorize ?? (() => true),
        isCurrentSessionSource: () => true
    })
    return { store, session, registry, socket, accessErrors }
}

describe('cli runtime handlers', () => {
    it('applies a schema-valid publication and acks ok', () => {
        const { registry, socket } = setup()
        let acked: SessionRuntimeAck | undefined
        socket.trigger('session-runtime', {
            sid: 'session-1',
            publication: { kind: 'snapshot', snapshot: snapshot('e1', 0) }
        }, (result) => { acked = result })

        expect(acked).toEqual({ result: 'ok' })
        expect(registry.snapshot('session-1', 'default')?.snapshot?.epoch).toBe('e1')
    })

    it('rejects a sid that does not match the authenticated socket session', () => {
        const { registry, socket, accessErrors } = setup()
        let acked: SessionRuntimeAck | undefined
        socket.trigger('session-runtime', {
            sid: 'other-session',
            publication: { kind: 'snapshot', snapshot: snapshot('e1', 0) }
        }, (result) => { acked = result })

        expect(acked).toEqual({ result: 'error' })
        expect(accessErrors).toEqual([{ scope: 'session', id: 'other-session', reason: 'access-denied' }])
        expect(registry.snapshot('other-session', 'default')).toBeNull()
        expect(registry.snapshot('session-1', 'default')).toBeNull()
    })

    it('rejects publications from sockets without an authenticated session', () => {
        const { registry, socket, accessErrors } = setup('session-1', false)
        let acked: SessionRuntimeAck | undefined
        socket.trigger('session-runtime', {
            sid: 'session-1',
            publication: { kind: 'snapshot', snapshot: snapshot('e1', 0) }
        }, (result) => { acked = result })

        expect(acked).toEqual({ result: 'error' })
        expect(accessErrors).toHaveLength(1)
        expect(registry.snapshot('session-1', 'default')).toBeNull()
    })

    it('rejects malformed payloads before touching the registry', () => {
        const { registry, socket } = setup()
        let acked: SessionRuntimeAck | undefined
        socket.trigger('session-runtime', { sid: 'session-1', publication: { kind: 'patch', patch: { seq: 'nope' } } }, (result) => { acked = result })
        socket.trigger('session-runtime', 'garbage', (result) => { acked = result })
        socket.trigger('session-runtime', null)

        expect(acked).toEqual({ result: 'error' })
        expect(registry.snapshot('session-1', 'default')).toBeNull()
    })

    it('acks resync on a patch gap so the CLI replays its snapshot', () => {
        const { socket } = setup()
        const acks: SessionRuntimeAck[] = []
        socket.trigger('session-runtime', {
            sid: 'session-1',
            publication: { kind: 'snapshot', snapshot: snapshot('e1', 0) }
        }, (result) => acks.push(result))
        socket.trigger('session-runtime', {
            sid: 'session-1',
            publication: { kind: 'patch', patch: { version: 1, epoch: 'e1', seq: 7, changes: [], updatedAt: 1 } }
        }, (result) => acks.push(result))

        expect(acks).toEqual([{ result: 'ok' }, { result: 'resync' }])
    })

    it('emits session-runtime:resync when the producer passes no ack callback', () => {
        const { socket } = setup()
        socket.trigger('session-runtime', {
            sid: 'session-1',
            publication: { kind: 'patch', patch: { version: 1, epoch: 'e1', seq: 1, changes: [], updatedAt: 1 } }
        })

        expect(socket.emitted).toEqual([{ event: 'session-runtime:resync', data: { sid: 'session-1' } }])
    })

    it('retains final rows on session-end and never fabricates run state', () => {
        const { registry, socket } = setup()
        socket.trigger('session-runtime', {
            sid: 'session-1',
            publication: {
                kind: 'snapshot',
                snapshot: {
                    ...snapshot('e1', 0),
                    run: { id: 'run-1', state: 'running', startedAt: 0 }
                }
            }
        })
        socket.trigger('session-end', { sid: 'session-1', time: Date.now() })
        expect(registry.snapshot('session-1', 'default')?.snapshot?.run?.state).toBe('running')
    })

    it('marks the source disconnected on socket disconnect without ending the run', () => {
        const { registry, socket } = setup()
        socket.trigger('session-runtime', {
            sid: 'session-1',
            publication: {
                kind: 'snapshot',
                snapshot: {
                    ...snapshot('e1', 0),
                    run: { id: 'run-1', state: 'running', startedAt: 0 }
                }
            }
        })
        socket.trigger('disconnect', undefined)

        const state = registry.snapshot('session-1', 'default')
        expect(state?.source).toBe('disconnected')
        expect(state?.snapshot?.run?.state).toBe('running')
    })

    it('denies publications once session access is revoked', () => {
        const { socket, registry, session } = setup()
        const store2 = new Store(':memory:')
        // Swap in a resolver that now denies (session deleted / access revoked).
        const socket2 = new FakeSocket('sock-2')
        socket2.handshake.auth = { sessionId: 'session-1' }
        const registry2 = registry
        registerRuntimeHandlers(socket2 as unknown as CliSocketWithData, {
            store: store2,
            registry: registry2,
            resolveSessionAccess: () => ({ ok: false, reason: 'access-denied' }),
            emitAccessError: () => { }
        })

        let acked: SessionRuntimeAck | undefined
        socket2.trigger('session-runtime', {
            sid: 'session-1',
            publication: { kind: 'snapshot', snapshot: snapshot('e1', 0) }
        }, (result) => { acked = result })

        expect(acked).toEqual({ result: 'error' })
        expect(registry2.snapshot('session-1', 'default')).toBeNull()
        store2.close()
        void session
        void socket
    })

    it('denies a matching-sid publication when the principal lacks operate rights', () => {
        const { registry, socket, accessErrors } = setup('session-1', true, () => false)
        let acked: SessionRuntimeAck | undefined
        socket.trigger('session-runtime', {
            sid: 'session-1',
            publication: { kind: 'snapshot', snapshot: snapshot('e1', 0) }
        }, (result) => { acked = result })

        expect(acked).toEqual({ result: 'error' })
        expect(accessErrors).toEqual([{ scope: 'session', id: 'session-1', reason: 'access-denied' }])
        expect(registry.snapshot('session-1', 'default')).toBeNull()
    })

    it('rechecks publisher authorization on every publication', () => {
        let allowed = true
        const { registry, socket } = setup('session-1', true, () => allowed)
        const acks: SessionRuntimeAck[] = []
        socket.trigger('session-runtime', {
            sid: 'session-1',
            publication: { kind: 'snapshot', snapshot: snapshot('e1', 0) }
        }, (r) => acks.push(r))

        allowed = false // grant revoked / token revoked mid-session
        socket.trigger('session-runtime', {
            sid: 'session-1',
            publication: { kind: 'patch', patch: { version: 1, epoch: 'e1', seq: 1, changes: [], updatedAt: 1 } }
        }, (r) => acks.push(r))

        expect(acks).toEqual([{ result: 'ok' }, { result: 'error' }])
        // The patch never reached the projection: seq stayed at the snapshot.
        expect(registry.snapshot('session-1', 'default')?.snapshot?.seq).toBe(0)
    })

    it('denies publications when no authorization dep is wired', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('session-1', {}, null, 'default') as StoredSession
        const registry = new RuntimeTimelineRegistry()
        const socket = new FakeSocket('sock-x')
        socket.handshake.auth = { sessionId: 'session-1' }
        registerRuntimeHandlers(socket as unknown as CliSocketWithData, {
            store,
            registry,
            resolveSessionAccess: () => ({ ok: true, value: session }),
            emitAccessError: () => { }
        })

        let acked: SessionRuntimeAck | undefined
        socket.trigger('session-runtime', {
            sid: 'session-1',
            publication: { kind: 'snapshot', snapshot: snapshot('e1', 0) }
        }, (r) => { acked = r })

        expect(acked).toEqual({ result: 'error' })
        expect(registry.snapshot('session-1', 'default')).toBeNull()
        store.close()
    })
    it('rejects a superseded source even when its principal and generation remain authorized', () => {
        const store = new Store(':memory:')
        try {
            const session = store.sessions.getOrCreateSession('runtime-owned', {}, null, 'default')
            const registry = new RuntimeTimelineRegistry()
            let current = 'old'
            const old = new FakeSocket('old')
            const replacement = new FakeSocket('replacement')
            for (const socket of [old, replacement]) {
                socket.handshake.auth = { sessionId: session.id }
                registerRuntimeHandlers(socket as unknown as CliSocketWithData, {
                    store, registry, resolveSessionAccess: () => ({ ok: true, value: session }), emitAccessError: () => { },
                    authorizeSessionPublication: () => true, isCurrentSessionSource: () => current === socket.id
                })
            }
            const acks: SessionRuntimeAck[] = []
            old.trigger('session-runtime', { sid: session.id, publication: { kind: 'snapshot', snapshot: snapshot('old', 0) } }, result => acks.push(result))
            current = 'replacement'
            replacement.trigger('session-runtime', { sid: session.id, publication: { kind: 'snapshot', snapshot: snapshot('replacement', 0) } }, result => acks.push(result))
            old.trigger('session-runtime', { sid: session.id, publication: { kind: 'snapshot', snapshot: snapshot('late-old', 0) } }, result => acks.push(result))
            old.trigger('session-end', { sid: session.id, time: 100 })
            expect(acks).toEqual([{ result: 'ok' }, { result: 'ok' }, { result: 'error' }])
            expect(registry.snapshot(session.id, 'default')).toMatchObject({ snapshot: { epoch: 'replacement' }, source: 'connected' })
        } finally { store.close() }
    })
})
