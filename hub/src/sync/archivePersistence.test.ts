import { describe, expect, it, spyOn } from 'bun:test'
import { toSessionSummary } from '@hapi/protocol'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import { SyncEngine } from './syncEngine'
import type { RpcGateway } from './rpcGateway'

function gatewayForTest(engine: SyncEngine): RpcGateway {
    // Inspect the engine's real private gateway solely to stub its RPC boundary.
    const runtime = engine as unknown as { rpcGateway: RpcGateway }
    return runtime.rpcGateway
}

// Integration coverage for issue #4 Feature A: explicit archive must persist an
// `archivedAt` marker (distinct from natural session end / timeout) so the web
// can hide user-archived sessions. Uses a real in-memory SQLite Store so the
// full archiveSession → updateSessionMetadata → SQLite → reload path is exercised.

function createEngine(store: Store): SyncEngine {
    const engine = new SyncEngine(
        store,
        {} as never,
        new RpcRegistry(),
        { broadcast() {} } as never
    )
    // archiveSession calls rpcGateway.killSession; the gateway is stubbed in
    // this harness, so provide a no-op.
    gatewayForTest(engine).killSession = async () => {}
    engine.stop()
    return engine
}

function newSession(engine: SyncEngine, tag: string) {
    return engine.getOrCreateSession(
        tag,
        { path: '/tmp/project', host: 'localhost', flavor: 'claude' },
        { requests: {}, completedRequests: {} },
        'default'
    )
}

describe('archive persistence', () => {
    it('marks an explicitly-archived session with archivedAt and persists it across restart', async () => {
        const store = new Store(':memory:')
        const engine = createEngine(store)

        const session = newSession(engine, 'archive-me')
        await engine.archiveSession(session.id)

        const after = engine.getSession(session.id)
        expect(after?.active).toBe(false)
        expect(after?.metadata?.archivedAt).toBeGreaterThan(0)

        // Persisted to SQLite → survives a hub restart (fresh engine, same store).
        const reloaded = createEngine(store).getSession(session.id)
        expect(reloaded?.metadata?.archivedAt).toBeGreaterThan(0)

        // And it is surfaced on the session summary the web consumes.
        expect(toSessionSummary(reloaded!).metadata?.archivedAt).toBeGreaterThan(0)
    })

    it('does NOT mark naturally-ended sessions as archived', () => {
        const store = new Store(':memory:')
        const engine = createEngine(store)

        const session = newSession(engine, 'end-me')
        engine.handleSessionEnd({ sid: session.id, time: Date.now() })

        const after = engine.getSession(session.id)
        expect(after?.active).toBe(false)
        expect(after?.metadata?.archivedAt).toBeUndefined()
        expect(toSessionSummary(after!).metadata?.archivedAt).toBeUndefined()
    })

    it('ignores stray session-alive heartbeats for an archived session until explicitly resumed', async () => {
        const store = new Store(':memory:')
        const engine = createEngine(store)

        const session = newSession(engine, 'archive-resurrect-guard')
        await engine.archiveSession(session.id)
        expect(engine.getSession(session.id)?.active).toBe(false)
        expect(engine.getSession(session.id)?.metadata?.lifecycleState).toBe('archived')

        engine.handleSessionAlive({ sid: session.id, time: Date.now() + 5_000, thinking: true })
        expect(engine.getSession(session.id)?.active).toBe(false)

        await (engine as any).sessionCache.clearSessionArchiveMetadata(session.id)
        engine.handleSessionAlive({ sid: session.id, time: Date.now() + 10_000, thinking: false })
        expect(engine.getSession(session.id)?.active).toBe(true)
        expect(engine.getSession(session.id)?.metadata?.archivedAt).toBeUndefined()
        expect(engine.getSession(session.id)?.metadata?.lifecycleState).toBeUndefined()
    })

    it('does NOT mark timed-out (expireInactive) sessions as archived', () => {
        const store = new Store(':memory:')
        const engine = createEngine(store)

        const session = newSession(engine, 'expire-me')
        // Make it active, then force expiry by moving activeAt into the past.
        engine.handleSessionAlive({ sid: session.id, time: Date.now() })
        const cached = engine.getSession(session.id)!
        cached.activeAt = Date.now() - 60_000
        ;(engine as any).sessionCache.expireInactive(Date.now())

        const after = engine.getSession(session.id)
        expect(after?.active).toBe(false)
        expect(after?.metadata?.archivedAt).toBeUndefined()
    })
    it('does not mark inactive or archived when runner cleanup is unverified', async () => {
        const store = new Store(':memory:')
        const engine = createEngine(store)
        const session = engine.getOrCreateSession('unverified', {
            path: '/tmp/project', host: 'localhost', flavor: 'omp', machineId: 'machine-1'
        }, { requests: {}, completedRequests: {} }, 'default')
        const gateway = gatewayForTest(engine)
        gateway.stopRunnerSession = async () => 'still_alive'
        engine.handleSessionAlive({ sid: session.id, time: Date.now() })
        expect(engine.getSession(session.id)?.active).toBe(true)
        const beforeActive = engine.getSession(session.id)?.active

        const result = await engine.archiveSession(session.id)

        expect(result.type).toBe('error')
        expect(engine.getSession(session.id)?.active).toBe(beforeActive)
        expect(engine.getSession(session.id)?.metadata?.archivedAt).toBeUndefined()
        expect(engine.getSession(session.id)?.metadata?.lifecycleState).not.toBe('archived')
    })

    it('dedupes concurrent archive requests and retries verification afterwards', async () => {
        const store = new Store(':memory:')
        const engine = createEngine(store)
        const session = engine.getOrCreateSession('dedupe', {
            path: '/tmp/project', host: 'localhost', flavor: 'omp', machineId: 'machine-1'
        }, { requests: {}, completedRequests: {} }, 'default')
        const { promise: barrier, resolve: release } = Promise.withResolvers<void>()
        let kills = 0
        let stops = 0
        const gateway = gatewayForTest(engine)
        gateway.killSession = async () => { kills += 1; await barrier }
        gateway.stopRunnerSession = async () => { stops += 1; return 'already_gone' }

        const first = engine.archiveSession(session.id)
        const second = engine.archiveSession(session.id)
        release()
        expect(await first).toEqual({ type: 'success', alreadyArchived: false })
        expect(await second).toEqual({ type: 'success', alreadyArchived: false })
        expect(kills).toBe(1)
        expect(stops).toBe(1)

        expect(await engine.archiveSession(session.id)).toEqual({ type: 'success', alreadyArchived: true })
        expect(kills).toBe(2)
        expect(stops).toBe(2)
    })

    it('surfaces runner RPC failure without writing archive metadata', async () => {
        const store = new Store(':memory:')
        const engine = createEngine(store)
        const session = engine.getOrCreateSession('offline', {
            path: '/tmp/project', host: 'localhost', flavor: 'omp', machineId: 'machine-1'
        }, { requests: {}, completedRequests: {} }, 'default')
        gatewayForTest(engine).stopRunnerSession = async () => { throw new Error('Runner offline') }
        expect(await engine.archiveSession(session.id)).toEqual({
            type: 'error', message: 'Runner offline', code: 'archive_failed'
        })
        expect(engine.getSession(session.id)?.metadata?.archivedAt).toBeUndefined()
    })

    it.each(['already_gone', 'still_alive'] as const)('archives a pending reopen only on its recorded target after cleanup proof (%s)', async (status) => {
        const store = new Store(':memory:')
        const engine = createEngine(store)
        const session = engine.getOrCreateSession('pending-reopen-archive', {
            path: '/tmp/project', host: 'localhost', flavor: 'omp', machineId: 'old-machine',
            lifecycleState: 'running',
            reopenArchiveSnapshot: { machineId: 'spawn-target', lifecycleState: 'archived', archivedAt: 1, archiveReason: 'Previous archive' },
        }, null, 'default')
        const proof: string[] = []
        gatewayForTest(engine).stopRunnerSession = async (machineId) => { proof.push(machineId); return status }
        const result = await engine.archiveSession(session.id)
        expect(proof).toEqual(['spawn-target'])
        if (status === 'still_alive') {
            expect(result.type).toBe('error')
            expect(engine.getSession(session.id)?.metadata?.reopenArchiveSnapshot).toBeDefined()
            expect(engine.getSession(session.id)?.metadata?.archivedAt).toBeUndefined()
        } else {
            expect(result.type).toBe('success')
            expect(engine.getSession(session.id)?.metadata?.reopenArchiveSnapshot).toBeUndefined()
            expect(engine.getSession(session.id)?.metadata?.archivedAt).toBeGreaterThan(1)
            expect(engine.getSession(session.id)?.metadata?.lifecycleState).toBe('archived')
        }
    })

    it('atomically supersedes a quarantined PTY reopen after verified exit and permits another reopen', async () => {
        const store = new Store(':memory:')
        const engine = createEngine(store)
        const session = engine.getOrCreateSession('quarantined-pty-archive', {
            path: '/tmp/project', host: 'localhost', flavor: 'agy', machineId: 'machine-x', lifecycleState: 'running',
            reopenArchiveSnapshot: { machineId: 'machine-x', lifecycleState: 'archived', archivedAt: 1 },
            ptyResumeAttempt: { machineId: 'machine-x', state: 'quarantined', startedAt: 1 },
        }, { startingMode: 'pty' }, 'default')
        // Preserve the real lifecycle; inject only runner proof and the quarantine.
        const internals = engine as unknown as { ptyResumeQuarantinedIds: Set<string> }
        internals.ptyResumeQuarantinedIds.add(session.id)
        gatewayForTest(engine).stopRunnerSession = async () => 'stopped'
        const failure = spyOn(store.sessions, 'updateSessionMetadata').mockReturnValue({ result: 'error' })
        try {
            expect(await engine.archiveSession(session.id)).toMatchObject({ type: 'error', code: 'archive_failed' })
            expect(engine.getSession(session.id)?.metadata?.reopenArchiveSnapshot).toBeDefined()
            expect(engine.getSession(session.id)?.metadata?.ptyResumeAttempt).toBeDefined()
            expect(engine.getSession(session.id)?.metadata?.archivedAt).toBeUndefined()
            expect(internals.ptyResumeQuarantinedIds.has(session.id)).toBe(true)
            failure.mockRestore()
            const writes = spyOn(store.sessions, 'updateSessionMetadata')
            try {
                expect(await engine.archiveSession(session.id)).toMatchObject({ type: 'success' })
                expect(writes).toHaveBeenCalledTimes(1)
                expect(engine.getSession(session.id)?.metadata?.reopenArchiveSnapshot).toBeUndefined()
                expect(engine.getSession(session.id)?.metadata?.ptyResumeAttempt).toBeUndefined()
                expect(engine.getSession(session.id)?.metadata?.lifecycleState).toBe('archived')
                expect(internals.ptyResumeQuarantinedIds.has(session.id)).toBe(false)
                expect(await engine.reopenSession(session.id, 'default')).toMatchObject({ type: 'error', code: 'no_machine_online' })
            } finally { writes.mockRestore() }
        } finally { failure.mockRestore(); engine.stop() }
    })
})
