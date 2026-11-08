import { describe, expect, it, beforeEach, spyOn } from 'bun:test'
import type { Session } from '@hapi/protocol/types'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import { SyncEngine } from './syncEngine'
import type { RpcGateway } from './rpcGateway'
import type { SessionCache } from './sessionCache'

/**
 * Reopening an archived PTY session must reuse the SAME hub session id.
 *
 * Before the fix `resumeSession` always went through `spawn-in-directory`,
 * which mints a brand-new hub session id; the old row was then deleted by
 * `mergeSessions(oldId, newId, { deleteOldSession: true })`. That made the
 * stable id 404 and surfaced a second (new-id) row in the list.
 *
 * The fix threads the existing hub session id into the spawn RPC for the PTY
 * resume path (via the CLI `existingSessionId` bootstrap), so the runner
 * reuses the row instead of minting a new one — no new id, no merge, no delete.
 *
 * These tests inject a fake `rpcGateway.spawnSession` that faithfully models
 * the runner contract: when an existing hub session id is handed to it the
 * runner reuses that id (same row); otherwise it mints a new hub session id
 * (a fresh row), reproducing the legacy behavior.
 */
describe('SyncEngine reopen/resume PTY session id preservation', () => {
    let store: Store
    let engine: SyncEngine
    let mintedNewId: string | undefined

    const NAMESPACE = 'default'

    function baseMetadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
        return {
            path: '/tmp/proj',
            host: 'localhost',
            machineId: 'machine-x',
            flavor: 'agy',
            agySessionId: 'agy-conv-1',
            ...overrides
        }
    }

    /** existingSessionId follows claudeLaunch and ccSwitchProviderId in rpcGateway.spawnSession. */
    function readExistingSessionId(args: unknown[]): string | undefined {
        const value = args[14]
        return typeof value === 'string' && value.length > 0 ? value : undefined
    }

    let capturedExistingSessionId: string | undefined
    let staleReadyPresentAtSpawn = false

    function installFakeRunner(): void {
        const cache = (engine as unknown as { sessionCache: import('./sessionCache').SessionCache }).sessionCache
        ;(engine as unknown as { machineCache: unknown }).machineCache = {
            // CI 慢机上 syncEngine 的 5s inactivity tick 会在测试中开火，
            // 残缺 mock 缺 expireInactive 直接 TypeError（上游 flake，非本地可见）。
            expireInactive: () => {},
            getOnlineMachinesByNamespace: () => [
                { id: 'machine-x', metadata: { host: 'localhost' } }
            ]
        }
        ;(engine as unknown as { waitForSessionActive: unknown }).waitForSessionActive = async () => true
        ;(engine as unknown as { waitForSessionReady: unknown }).waitForSessionReady = async () => 'ready'
        ;(engine as unknown as { rpcGateway: { spawnSession: unknown } }).rpcGateway.spawnSession =
            async (...args: unknown[]) => {
                const existingSessionId = readExistingSessionId(args)
                capturedExistingSessionId = existingSessionId
                staleReadyPresentAtSpawn = existingSessionId
                    ? (engine as unknown as { sessionReadyIds: Set<string> }).sessionReadyIds.has(existingSessionId)
                    : false
                if (existingSessionId) {
                    // Runner honored the existing hub id — reuse the row.
                    return { type: 'success', sessionId: existingSessionId }
                }
                // Legacy: runner mints a brand-new hub session id (new row).
                const created = cache.getOrCreateSession(
                    'runner-minted-new-tag',
                    baseMetadata(),
                    { startingMode: 'pty' },
                    NAMESPACE
                )
                mintedNewId = created.id
                return { type: 'success', sessionId: created.id }
            }
    }

    function insertSession(
        sessionId: string,
        metadata: Record<string, unknown>,
        agentState: Record<string, unknown>
    ): Session {
        const cache = (engine as unknown as { sessionCache: import('./sessionCache').SessionCache }).sessionCache
        return cache.getOrCreateSession(sessionId, metadata, agentState, NAMESPACE)
    }

    beforeEach(() => {
        store = new Store(':memory:')
        engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
        capturedExistingSessionId = undefined
        mintedNewId = undefined
        staleReadyPresentAtSpawn = false
        installFakeRunner()
    })

    it.each(['omp', 'agy'] as const)('recovers %s archive after bootstrap and Hub restart without respawning an uncertain child', async (flavor) => {
        const sessionId = insertSession('native-reopen-checkpoint', baseMetadata({
            flavor, lifecycleState: 'archived', archivedAt: 100, lifecycleStateSince: 90,
            archivedBy: 'hub', archiveReason: 'User exited', cursorSessionId: 'legacy-cursor', cursorSessionProtocol: 'stream-json',
            ...(flavor === 'omp' ? { ompSession: { id: 'native-id', file: '/tmp/native-id.jsonl' } } : {}),
        }), { startingMode: flavor === 'omp' ? 'remote' : 'pty' }).id
        store.messages.addMessage(sessionId, { type: 'text', text: 'preserve pre-reopen history' })
        // Only the runner boundary is fake; SQLite checkpoints and Hub reconstruction are real.
        const first = engine as unknown as { rpcGateway: RpcGateway; sessionCache: SessionCache }
        first.rpcGateway.killSession = async () => {}
        first.rpcGateway.stopRunnerSession = async () => 'still_alive'
        first.rpcGateway.spawnSession = async () => {
            await first.sessionCache.clearSessionArchiveMetadata(sessionId)
            engine.handleSessionAlive({ sid: sessionId, time: Date.now() })
            return { type: 'error', message: 'webhook timeout' }
        }
        expect(await engine.reopenSession(sessionId, NAMESPACE)).toMatchObject({ type: 'error', rollbackSafe: false })
        expect(engine.getSession(sessionId)?.metadata?.reopenArchiveSnapshot?.archivedAt).toBe(100)
        engine.stop()

        engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
        installFakeRunner()
        const restarted = engine as unknown as { rpcGateway: RpcGateway; sessionCache: SessionCache }
        restarted.rpcGateway.killSession = async () => {}
        let spawns = 0
        const spawn = restarted.rpcGateway.spawnSession.bind(restarted.rpcGateway)
        restarted.rpcGateway.spawnSession = async (...args) => {
            spawns += 1
            expect(engine.getSession(sessionId)?.metadata).toMatchObject({
                archivedAt: 100, archiveReason: 'User exited', name: 'Concurrent user rename', cursorSessionProtocol: 'stream-json',
            })
            await restarted.sessionCache.clearSessionArchiveMetadata(sessionId)
            engine.handleSessionAlive({ sid: sessionId, time: Date.now() })
            return spawn(...args)
        }
        const proof: string[] = []
        restarted.rpcGateway.stopRunnerSession = async (machineId, sid) => {
            proof.push(`${machineId}:${sid}`)
            return 'still_alive'
        }
        try {
            expect(await engine.reopenSession(sessionId, NAMESPACE)).toMatchObject({ type: 'error', rollbackSafe: false })
            expect(spawns).toBe(0)
            expect(engine.getSession(sessionId)?.metadata?.reopenArchiveSnapshot?.archivedAt).toBe(100)
            restarted.rpcGateway.stopRunnerSession = async (machineId, sid) => {
                proof.push(`${machineId}:${sid}`)
                // Race a user rename against archive restoration without refreshing
                // the Hub cache: version retries must preserve that unrelated edit.
                const current = engine.getSession(sessionId)!
                expect(store.sessions.updateSessionMetadata(sessionId, { ...current.metadata!, name: 'Concurrent user rename' }, current.metadataVersion, NAMESPACE).result).toBe('success')
                return 'already_gone'
            }
            expect(await engine.reopenSession(sessionId, NAMESPACE)).toMatchObject({ type: 'success', sessionId })
            expect(spawns).toBe(1)
            expect(proof).toEqual([`machine-x:${sessionId}`, `machine-x:${sessionId}`])
            expect(engine.getSession(sessionId)?.metadata?.reopenArchiveSnapshot).toBeUndefined()
            expect(engine.getSession(sessionId)?.metadata?.archivedAt).toBeUndefined()
            expect(engine.getSession(sessionId)?.metadata?.name).toBe('Concurrent user rename')
            expect(engine.getSession(sessionId)?.metadata?.cursorSessionProtocol).toBe('stream-json')
            expect(store.messages.getFirstMessages(sessionId, 10)).toHaveLength(1)
        } finally { engine.stop() }
    })

    it.each(['ready', 'ended'] as const)('waits for native OMP readiness before reporting reopen success (%s)', async (readyResult) => {
        const sessionId = insertSession(
            'omp-session-native-readiness',
            baseMetadata({
                flavor: 'omp', lifecycleState: 'archived', archivedBy: 'hub',
                ompSession: { id: 'native-omp-id', file: '/tmp/native-omp-id.jsonl' }
            }),
            { startingMode: 'remote' }
        ).id
        let waited = false
        engine.waitForSessionReady = async (id) => {
            expect(id).toBe(sessionId)
            waited = true
            return readyResult
        }
        engine.handleSessionReady({ sid: sessionId, time: Date.now() })
        const result = await engine.reopenSession(sessionId, NAMESPACE)
        expect(waited).toBe(true)
        expect(staleReadyPresentAtSpawn).toBe(false)
        expect(capturedExistingSessionId).toBe(sessionId)
        expect(result.type).toBe(readyResult === 'ready' ? 'success' : 'error')
        expect(mintedNewId).toBeUndefined()
    })

    it('does not report an active OMP wrapper as native-ready', async () => {
        const sessionId = insertSession('omp-active-not-ready', baseMetadata({
            flavor: 'omp', ompSession: { id: 'native-id', file: '/tmp/native-id.jsonl' }
        }), { startingMode: 'remote' }).id
        engine.handleSessionAlive({ sid: sessionId, time: Date.now() })
        engine.waitForSessionReady = async () => 'timeout'
        const result = await engine.reopenSession(sessionId, NAMESPACE)
        expect(result).toMatchObject({ type: 'error', code: 'resume_failed', rollbackSafe: false })
        expect(capturedExistingSessionId).toBeUndefined()
        expect(engine.getSession(sessionId)?.active).toBe(true)
        engine.stop()
    })

    it('coalesces reopen clicks and serializes resume behind native readiness', async () => {
        const sessionId = insertSession('omp-concurrent-reopen', baseMetadata({
            flavor: 'omp', lifecycleState: 'archived',
            ompSession: { id: 'native-id', file: '/tmp/native-id.jsonl' }
        }), { startingMode: 'remote' }).id
        const { promise: nativeReady, resolve: ready } = Promise.withResolvers<'ready'>()
        const { promise: waiting, resolve: reachedReady } = Promise.withResolvers<void>()
        engine.waitForSessionReady = async () => { reachedReady(); return nativeReady }
        // Capture the real test RPC seam while retaining its typed signature.
        const internals = engine as unknown as { rpcGateway: RpcGateway }
        const spawn = internals.rpcGateway.spawnSession.bind(internals.rpcGateway)
        let spawns = 0
        internals.rpcGateway.spawnSession = async (...args) => { spawns += 1; return spawn(...args) }

        const first = engine.reopenSession(sessionId, NAMESPACE)
        const repeated = engine.reopenSession(sessionId, NAMESPACE)
        const resume = engine.resumeSession(sessionId, NAMESPACE)
        await waiting
        expect(spawns).toBe(1)
        expect(engine.getSession(sessionId)?.metadata?.reopenArchiveSnapshot?.lifecycleState).toBe('archived')
        ready('ready')
        expect(await first).toMatchObject({ type: 'success', sessionId })
        expect(await repeated).toMatchObject({ type: 'success', sessionId })
        expect(await resume).toEqual({ type: 'success', sessionId })
        expect(spawns).toBe(1)
        expect(engine.getSession(sessionId)?.metadata?.ompSession?.id).toBe('native-id')
        expect(engine.getSession(sessionId)?.metadata?.reopenArchiveSnapshot).toBeUndefined()
        engine.stop()
    })

    it.each(['already_gone', 'still_alive'] as const)('dedupes OMP restart and requires cleanup before spawn (%s)', async (status) => {
        const sessionId = insertSession('omp-restart-cleanup', baseMetadata({
            flavor: 'omp', lifecycleState: 'archived',
            ompSession: { id: 'native-id', file: '/tmp/native-id.jsonl' }
        }), { startingMode: 'remote' }).id
        const internals = engine as unknown as { rpcGateway: RpcGateway }
        const spawn = internals.rpcGateway.spawnSession.bind(internals.rpcGateway)
        const calls: string[] = []
        internals.rpcGateway.killSession = async () => { calls.push('native-cleanup') }
        internals.rpcGateway.stopRunnerSession = async () => { calls.push('runner-verify'); return status }
        internals.rpcGateway.spawnSession = async (...args) => { calls.push('spawn'); return spawn(...args) }
        const first = engine.restartSession(sessionId, NAMESPACE)
        const repeated = engine.restartSession(sessionId, NAMESPACE)
        expect(await first).toMatchObject({ type: status === 'still_alive' ? 'error' : 'success' })
        expect(await repeated).toEqual(await first)
        expect(calls).toEqual(status === 'still_alive'
            ? ['native-cleanup', 'runner-verify']
            : ['native-cleanup', 'runner-verify', 'spawn'])
        engine.stop()
    })

    it.each(['already_gone', 'still_alive'] as const)('stops timed-out OMP resume before archive rollback (%s)', async (stopResult) => {
        const sessionId = insertSession(
            'omp-session-timeout-cleanup',
            baseMetadata({ flavor: 'omp', lifecycleState: 'archived', ompSession: { id: 'native-id', file: '/tmp/native-id.jsonl' } }),
            { startingMode: 'remote' }
        ).id
        engine.waitForSessionReady = async () => 'timeout'
        // Internal RPC seam: the fake runner must report whether its timed-out child actually exited.
        const internals = engine as unknown as { rpcGateway: { stopRunnerSession: (machineId: string, sid: string) => Promise<string> } }
        let stoppedId: string | undefined
        internals.rpcGateway.stopRunnerSession = async (_machineId, sid) => {
            stoppedId = sid
            return stopResult
        }
        const result = await engine.reopenSession(sessionId, NAMESPACE)
        expect(stoppedId).toBe(sessionId)
        expect(result.type).toBe('error')
        if (stopResult === 'still_alive' && result.type === 'error') {
            expect(result.rollbackSafe).toBe(false)
        }
    })

    it.each([
        ['error', 'already_gone'], ['throw', 'stopped'],
        ['error', 'still_alive'], ['throw', 'offline'],
    ] as const)('verifies OMP spawn failure cleanup before archive rollback (%s/%s)', async (failure, status) => {
        const sessionId = insertSession('omp-spawn-failure', baseMetadata({
            flavor: 'omp', lifecycleState: 'archived', archivedAt: 100,
            archivedBy: 'hub', archiveReason: 'User exited', lifecycleStateSince: 90,
            ompSession: { id: 'native-id', file: '/tmp/native-id.jsonl' },
        }), { startingMode: 'remote' }).id
        const internals = engine as unknown as { rpcGateway: RpcGateway; sessionCache: SessionCache }
        const calls: string[] = []
        internals.rpcGateway.spawnSession = async () => {
            calls.push('spawn')
            // The wrapper bootstrapped the original row, but the RPC response
            // timed out before its session-alive/native-ready reached the Hub.
            await internals.sessionCache.clearSessionArchiveMetadata(sessionId)
            if (failure === 'throw') throw new Error('webhook timeout')
            return { type: 'error', message: 'webhook timeout' }
        }
        internals.rpcGateway.killSession = async (sid) => { expect(sid).toBe(sessionId); calls.push('wrapper-cleanup') }
        internals.rpcGateway.stopRunnerSession = async (_machineId, sid) => {
            expect(sid).toBe(sessionId)
            calls.push('runner-proof')
            if (status === 'offline') throw new Error('runner offline')
            return status
        }
        try {
            const [first, repeated] = await Promise.all([
                engine.reopenSession(sessionId, NAMESPACE), engine.reopenSession(sessionId, NAMESPACE),
            ])
            expect(first).toEqual(repeated)
            expect(first).toMatchObject({ type: 'error', message: expect.stringContaining('webhook timeout') })
            expect(calls).toEqual(['spawn', 'wrapper-cleanup', 'runner-proof'])
            const metadata = engine.getSession(sessionId)?.metadata
            if (status === 'already_gone' || status === 'stopped') {
                expect(metadata).toMatchObject({ lifecycleState: 'archived', archivedAt: 100, archiveReason: 'User exited', lifecycleStateSince: 90 })
            } else {
                expect(first).toMatchObject({ rollbackSafe: false })
                expect(metadata?.lifecycleState).not.toBe('archived')
                expect(metadata?.archivedAt).toBeUndefined()
            }
            expect(metadata?.ompSession?.id).toBe('native-id')
        } finally { engine.stop() }
    })

    it.each(['already_gone', 'still_alive'] as const)('handles exceptions after OMP spawn without unsafe archive rollback (%s)', async (status) => {
        const sessionId = insertSession('omp-ready-exception', baseMetadata({
            flavor: 'omp', lifecycleState: 'archived', archivedAt: 100,
            ompSession: { id: 'native-id', file: '/tmp/native-id.jsonl' },
        }), { startingMode: 'remote' }).id
        const internals = engine as unknown as { rpcGateway: RpcGateway; sessionCache: SessionCache }
        const spawn = internals.rpcGateway.spawnSession.bind(internals.rpcGateway)
        let spawns = 0
        internals.rpcGateway.spawnSession = async (...args) => {
            spawns += 1
            await internals.sessionCache.clearSessionArchiveMetadata(sessionId)
            engine.handleSessionAlive({ sid: sessionId, time: Date.now() })
            return spawn(...args)
        }
        engine.waitForSessionReady = async () => { throw new Error('readiness failed') }
        internals.rpcGateway.killSession = async () => {}
        internals.rpcGateway.stopRunnerSession = async () => status
        try {
            const result = await engine.reopenSession(sessionId, NAMESPACE)
            expect(result).toMatchObject({ type: 'error', message: expect.stringContaining('readiness failed'), rollbackSafe: status === 'already_gone' })
            expect(engine.getSession(sessionId)?.active).toBe(status === 'still_alive')
            expect(engine.getSession(sessionId)?.metadata?.archivedAt).toBe(status === 'already_gone' ? 100 : undefined)
            if (status === 'still_alive') {
                // An active uncertain child must not trigger another spawn.
                engine.waitForSessionReady = async () => 'timeout'
                expect(await engine.reopenSession(sessionId, NAMESPACE)).toMatchObject({ type: 'error' })
            }
            expect(spawns).toBe(1)
        } finally { engine.stop() }
    })

    it.each([
        { kind: 'missing', failDiagnostic: false },
        { kind: 'preexisting', failDiagnostic: false },
        { kind: 'foreign', failDiagnostic: false },
        { kind: 'missing', failDiagnostic: true },
    ] as const)('persists unowned OMP mismatch quarantine across repeat/reconstructed Hub (%j)', async ({ kind, failDiagnostic }) => {
        const sessionId = insertSession('omp-wrong-id', baseMetadata({
            flavor: 'omp', lifecycleState: 'archived', archivedAt: 100,
            ompSession: { id: 'native-id', file: '/tmp/native-id.jsonl' },
        }), { startingMode: 'remote' }).id
        store.messages.addMessage(sessionId, { type: 'text', text: 'preserve original history' })
        const returnedId = kind === 'missing' ? 'unexpected-row' : insertSession('unowned-returned-row', baseMetadata({
            flavor: 'omp', startedBy: 'runner', machineId: kind === 'foreign' ? 'other-machine' : 'machine-x',
            ompSession: { id: 'native-id', file: '/tmp/native-id.jsonl' },
        }), { startingMode: 'remote' }).id
        // Observe the private RPC boundary while reconstructing the real SQLite Hub.
        const first = engine as unknown as { rpcGateway: RpcGateway }
        let spawns = 0
        const stopped: string[] = []
        const killed: string[] = []
        first.rpcGateway.spawnSession = async () => { spawns++; return { type: 'success', sessionId: returnedId } }
        first.rpcGateway.killSession = async (sid) => { killed.push(sid) }
        first.rpcGateway.stopRunnerSession = async (_machineId, sid) => { stopped.push(sid); return 'already_gone' }
        const update = store.sessions.updateSessionMetadata.bind(store.sessions)
        const failure = spyOn(store.sessions, 'updateSessionMetadata').mockImplementation((...args) => {
            const metadata = args[1]
            if (failDiagnostic && metadata && typeof metadata === 'object' && 'reopenArchiveSnapshot' in metadata) {
                const snapshot = metadata.reopenArchiveSnapshot
                if (snapshot && typeof snapshot === 'object' && 'unverifiedChildSessionId' in snapshot && snapshot.unverifiedChildSessionId === returnedId) return { result: 'error' }
            }
            return update(...args)
        })
        try {
            expect(await engine.reopenSession(sessionId, NAMESPACE)).toMatchObject({ type: 'error', rollbackSafe: false })
            expect(engine.getSession(sessionId)?.metadata?.reopenArchiveSnapshot?.unverifiedChildSessionId).toBe(failDiagnostic ? '' : returnedId)
            expect(await engine.reopenSession(sessionId, NAMESPACE)).toMatchObject({ type: 'error', rollbackSafe: false })
            expect(spawns).toBe(1)
            failure.mockRestore()
            engine.stop()
            engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
            installFakeRunner()
            const restarted = engine as unknown as { rpcGateway: RpcGateway }
            restarted.rpcGateway.spawnSession = async () => { spawns++; return { type: 'error', message: 'must not respawn' } }
            restarted.rpcGateway.killSession = async (sid) => { killed.push(sid) }
            restarted.rpcGateway.stopRunnerSession = async (_machineId, sid) => { stopped.push(sid); return 'already_gone' }
            const retry = await engine.reopenSession(sessionId, NAMESPACE)
            expect(retry).toMatchObject({ type: 'error', rollbackSafe: false })
            if (retry.type === 'error') expect(retry.message).toContain('inspect this spawn\'s processes on target Runner machine-x')
            expect(await engine.archiveSession(sessionId)).toMatchObject({ type: 'error', code: 'archive_failed' })
            const cache = (engine as unknown as { sessionCache: SessionCache }).sessionCache
            await cache.deduplicateByAgentSessionId(sessionId)
            await cache.deduplicateByAgentSessionId(returnedId)
            expect(spawns).toBe(1)
            expect(stopped).toEqual([])
            expect(killed).toEqual([])
            expect(store.sessions.getSession(sessionId)).not.toBeNull()
            expect(store.messages.getFirstMessages(sessionId, 10).map(message => message.content)).toEqual([{ type: 'text', text: 'preserve original history' }])
            expect(engine.getSession(sessionId)?.metadata?.ompSession?.id).toBe('native-id')
            if (kind !== 'missing') expect(store.sessions.getSession(returnedId)).not.toBeNull()
        } finally { failure.mockRestore(); engine.stop() }
    })

    it.each([
        { childStatus: 'already_gone', originalStatus: 'already_gone' },
        { childStatus: 'already_gone', originalStatus: 'still_alive' },
        { childStatus: 'still_alive', originalStatus: 'already_gone' },
    ] as const)('verifies both attributed OMP IDs before rollback (%j)', async ({ childStatus, originalStatus }) => {
        const sessionId = insertSession('omp-attributed-id', baseMetadata({
            flavor: 'omp', lifecycleState: 'archived', archivedAt: 100,
            ompSession: { id: 'native-id', file: '/tmp/native-id.jsonl' },
        }), { startingMode: 'remote' }).id
        store.messages.addMessage(sessionId, { type: 'text', text: 'original history' })
        // Inject only the private RPC boundary; lifecycle/store behavior stays real.
        const internals = engine as unknown as { rpcGateway: RpcGateway }
        const gateway = internals.rpcGateway
        let childId = ''
        const calls: string[] = []
        gateway.spawnSession = async () => {
            const child = insertSession('attributed-child', baseMetadata({
                flavor: 'omp', startedBy: 'runner',
                ompSession: { id: 'native-id', file: '/tmp/native-id.jsonl' },
            }), { startingMode: 'remote' })
            childId = child.id
            return { type: 'success', sessionId: child.id }
        }
        gateway.killSession = async (sid) => { calls.push(`kill:${sid}`) }
        gateway.stopRunnerSession = async (_machineId, sid) => {
            calls.push(`stop:${sid}`)
            return sid === sessionId ? originalStatus : childStatus
        }
        try {
            const result = await engine.reopenSession(sessionId, NAMESPACE)
            const cache = (engine as unknown as { sessionCache: SessionCache }).sessionCache
            await cache.deduplicateByAgentSessionId(sessionId)
            await cache.deduplicateByAgentSessionId(childId)
            const safe = childStatus === 'already_gone' && originalStatus === 'already_gone'
            expect(result).toMatchObject({ type: 'error', rollbackSafe: safe })
            expect(calls).toEqual(childStatus === 'still_alive'
                ? [`kill:${childId}`, `stop:${childId}`]
                : [`kill:${childId}`, `stop:${childId}`, `kill:${sessionId}`, `stop:${sessionId}`])
            expect(store.sessions.getSession(sessionId)).not.toBeNull()
            expect(store.messages.getFirstMessages(sessionId, 10).map(message => message.content)).toEqual([{ type: 'text', text: 'original history' }])
            if (childStatus === 'already_gone') expect(store.sessions.getSession(childId)).toBeNull()
            else expect(store.sessions.getSession(childId)).not.toBeNull()
            expect(engine.getSession(sessionId)?.metadata?.ompSession?.id).toBe('native-id')
            expect(engine.getSession(sessionId)?.metadata?.reopenArchiveSnapshot?.childSessionId).toBe(safe ? undefined : childId)
            expect(engine.getSession(sessionId)?.metadata?.archivedAt).toBe(100)
        } finally { engine.stop() }
    })

    it('does not kill a preexisting OMP row even when its native token matches', async () => {
        const metadata = baseMetadata({ flavor: 'omp', startedBy: 'runner', ompSession: { id: 'native-id', file: '/tmp/native-id.jsonl' } })
        const original = insertSession('omp-original', { ...metadata, lifecycleState: 'archived', archivedAt: 100 }, { startingMode: 'remote' })
        const other = insertSession('omp-preexisting', metadata, { startingMode: 'remote' })
        // Inject only the private RPC boundary; lifecycle/store behavior stays real.
        const internals = engine as unknown as { rpcGateway: RpcGateway }
        const gateway = internals.rpcGateway
        const killed: string[] = []
        gateway.spawnSession = async () => ({ type: 'success', sessionId: other.id })
        gateway.killSession = async (sid) => { killed.push(sid) }
        try {
            expect(await engine.reopenSession(original.id, NAMESPACE)).toMatchObject({ type: 'error', rollbackSafe: false })
            expect(killed).toEqual([])
            expect(store.sessions.getSession(other.id)).not.toBeNull()
        } finally { engine.stop() }
    })

    it('returns a structured PTY checkpoint failure before spawning and releases its guard', async () => {
        const session = insertSession('pty-checkpoint-error', baseMetadata({ lifecycleState: 'archived', archivedAt: 100 }), { startingMode: 'pty' })
        // Inject only the RPC boundary; observe the real lifecycle guard.
        const internals = engine as unknown as { rpcGateway: RpcGateway; ptyResumeInFlightIds: Set<string> }
        let spawns = 0
        internals.rpcGateway.spawnSession = async () => { spawns++; return { type: 'success', sessionId: session.id } }
        const failure = spyOn(store.sessions, 'updateSessionMetadata').mockReturnValue({ result: 'error' })
        try {
            expect(await engine.reopenSession(session.id, NAMESPACE)).toMatchObject({ type: 'error', code: 'resume_failed' })
            expect(spawns).toBe(0)
            expect(internals.ptyResumeInFlightIds.has(session.id)).toBe(false)
            expect(engine.getSession(session.id)?.metadata?.archivedAt).toBe(100)
            expect(engine.getSession(session.id)?.metadata?.ptyResumeAttempt).toBeUndefined()
        } finally { failure.mockRestore(); engine.stop() }
    })

    it('retries a ready PTY commit without stopping or respawning the live child', async () => {
        const session = insertSession('pty-commit-error', baseMetadata({ lifecycleState: 'archived', archivedAt: 100 }), { startingMode: 'pty' })
        // Inject readiness while retaining the real metadata CAS.
        const internals = engine as unknown as { rpcGateway: RpcGateway; waitForSessionReady: (id: string) => Promise<'ready'> }
        let spawns = 0
        let stops = 0
        internals.rpcGateway.spawnSession = async () => { spawns++; return { type: 'success', sessionId: session.id } }
        internals.rpcGateway.stopRunnerSession = async () => { stops++; return 'already_gone' }
        internals.waitForSessionReady = async (sid) => { engine.handleSessionReady({ sid, time: Date.now() }); return 'ready' }
        const update = store.sessions.updateSessionMetadata.bind(store.sessions)
        let failCommit = true
        const failure = spyOn(store.sessions, 'updateSessionMetadata').mockImplementation((...args) => {
            const metadata = args[1]
            if (failCommit && metadata && typeof metadata === 'object' && !('archivedAt' in metadata) && !('reopenArchiveSnapshot' in metadata)) {
                failCommit = false
                return { result: 'error' }
            }
            return update(...args)
        })
        try {
            expect(await engine.reopenSession(session.id, NAMESPACE)).toMatchObject({ type: 'error', rollbackSafe: false })
            expect(engine.getSession(session.id)?.metadata?.reopenArchiveSnapshot?.archivedAt).toBe(100)
            expect(engine.getSession(session.id)?.metadata?.ptyResumeAttempt).toBeDefined()
            expect(await engine.reopenSession(session.id, NAMESPACE)).toMatchObject({ type: 'success', sessionId: session.id })
            expect(engine.getSession(session.id)?.metadata?.archivedAt).toBeUndefined()
            expect(engine.getSession(session.id)?.metadata?.reopenArchiveSnapshot).toBeUndefined()
            expect(engine.getSession(session.id)?.metadata?.ptyResumeAttempt).toBeUndefined()
            expect(spawns).toBe(1)
            expect(stops).toBe(0)
        } finally { failure.mockRestore(); engine.stop() }
    })

    it('restores archive and removes both checkpoints in one metadata write', async () => {
        const session = insertSession('pty-atomic-rollback', baseMetadata({
            name: 'concurrent rename', lifecycleState: 'running',
            reopenArchiveSnapshot: { machineId: 'machine-x', lifecycleState: 'archived', archivedAt: 100, archivedBy: 'hub' },
            ptyResumeAttempt: { machineId: 'machine-x', state: 'resuming', startedAt: 1 },
        }), { startingMode: 'pty' })
        // Exercise SQLite completion after cleanup has been established.
        const internals = engine as unknown as { finishReopenArchiveSnapshot: (id: string, restore: boolean) => Promise<void> }
        const failure = spyOn(store.sessions, 'updateSessionMetadata').mockReturnValue({ result: 'error' })
        try {
            await expect(internals.finishReopenArchiveSnapshot(session.id, true)).rejects.toThrow()
            expect(engine.getSession(session.id)?.metadata?.lifecycleState).toBe('running')
            expect(engine.getSession(session.id)?.metadata?.ptyResumeAttempt).toBeDefined()
            failure.mockRestore()
            const writes = spyOn(store.sessions, 'updateSessionMetadata')
            try {
                await internals.finishReopenArchiveSnapshot(session.id, true)
                expect(writes).toHaveBeenCalledTimes(1)
                expect(store.sessions.getSession(session.id)?.metadata).toMatchObject({ lifecycleState: 'archived', archivedAt: 100, name: 'concurrent rename' })
                expect(engine.getSession(session.id)?.metadata?.ptyResumeAttempt).toBeUndefined()
                expect(engine.getSession(session.id)?.metadata?.reopenArchiveSnapshot).toBeUndefined()
            } finally { writes.mockRestore() }
        } finally { failure.mockRestore(); engine.stop() }
    })

    it.each(['stopped', 'already_gone', 'still_alive'] as const)('verifies runner exit after PTY early end (%s)', async (status) => {
        const session = insertSession('pty-ended', baseMetadata({ lifecycleState: 'archived', archivedAt: 100 }), { startingMode: 'pty' })
        // A dead Windows wrapper cannot reliably deliver a session-end event.
        const internals = engine as unknown as { rpcGateway: RpcGateway; waitForSessionReady: () => Promise<'ended'>; waitForSessionInactive: () => Promise<boolean> }
        const stopped: string[] = []
        internals.rpcGateway.spawnSession = async () => {
            engine.handleSessionAlive({ sid: session.id, time: Date.now(), thinking: false })
            return { type: 'success', sessionId: session.id }
        }
        internals.rpcGateway.stopRunnerSession = async (_machineId, sid) => { stopped.push(sid); return status }
        internals.waitForSessionReady = async () => 'ended'
        internals.waitForSessionInactive = async () => { throw new Error('must not await a dead wrapper') }
        try {
            expect(await engine.reopenSession(session.id, NAMESPACE)).toMatchObject({ type: 'error', ...(status === 'still_alive' ? { rollbackSafe: false } : {}) })
            expect(stopped).toEqual([session.id])
            expect(engine.getSession(session.id)?.active).toBe(status === 'still_alive')
            expect(engine.getSession(session.id)?.metadata?.reopenArchiveSnapshot !== undefined).toBe(status === 'still_alive')
            expect(engine.getSession(session.id)?.metadata?.ptyResumeAttempt !== undefined).toBe(status === 'still_alive')
        } finally { engine.stop() }
    })

    it('clears stale readiness before spawning the same-id PTY replacement', async () => {
        const sessionId = insertSession(
            'pty-session-stale-ready',
            baseMetadata({ lifecycleState: 'archived', archivedBy: 'hub', archiveReason: 'inactivity' }),
            { startingMode: 'pty' }
        ).id
        ;(engine as unknown as { sessionReadyIds: Set<string> }).sessionReadyIds.add(sessionId)

        await engine.reopenSession(sessionId, NAMESPACE)

        expect(staleReadyPresentAtSpawn).toBe(false)
    })

    it('reopening an archived PTY session keeps the same hub session id (no new row, old row intact)', async () => {
        const sessionId = insertSession(
            'pty-session-stable',
            baseMetadata({ lifecycleState: 'archived', archivedBy: 'hub', archiveReason: 'inactivity' }),
            { startingMode: 'pty' }
        ).id

        const result = await engine.reopenSession(sessionId, NAMESPACE)

        expect(result).toEqual({ type: 'success', sessionId, resumed: true })
        expect(capturedExistingSessionId).toBe(sessionId)
        // Old row still exists (not deleted by a merge).
        expect(store.sessions.getSession(sessionId)).not.toBeNull()
        // The runner was never asked to mint a brand-new row.
        expect(mintedNewId).toBeUndefined()
    })




    it('stops a same-id PTY child when the active-state barrier times out', async () => {
        const sessionId = insertSession(
            'pty-session-active-timeout',
            baseMetadata({ lifecycleState: 'archived', archivedBy: 'hub', archiveReason: 'inactivity' }),
            { startingMode: 'pty' }
        ).id
        ;(engine as any).rpcGateway.spawnSession = async () => ({ type: 'success', sessionId })
        ;(engine as any).waitForSessionActive = async () => false
        let stoppedSessionId: string | undefined
        ;(engine as any).rpcGateway.stopRunnerSession = async (_machineId: string, sid: string) => {
            stoppedSessionId = sid
            return 'stopped'
        }

        const result = await engine.reopenSession(sessionId, NAMESPACE)

        expect(result).toMatchObject({ type: 'error', code: 'resume_failed' })
        expect(stoppedSessionId).toBe(sessionId)
        expect((engine.getSessionByNamespace(sessionId, NAMESPACE)?.metadata as any)?.ptyResumeAttempt).toBeUndefined()
    })

    it('stops a same-id PTY child when readiness times out', async () => {
        const sessionId = insertSession(
            'pty-session-ready-timeout',
            baseMetadata({ lifecycleState: 'archived', archivedBy: 'hub', archiveReason: 'inactivity' }),
            { startingMode: 'pty' }
        ).id
        ;(engine as any).rpcGateway.spawnSession = async () => {
            engine.handleSessionAlive({ sid: sessionId, time: Date.now() })
            return { type: 'success', sessionId }
        }
        ;(engine as any).waitForSessionReady = async () => 'timeout'
        let stoppedSessionId: string | undefined
        ;(engine as any).rpcGateway.stopRunnerSession = async (_machineId: string, sid: string) => {
            stoppedSessionId = sid
            engine.handleSessionEnd({ sid, time: Date.now(), reason: 'error' })
            return 'stopped'
        }

        const result = await engine.reopenSession(sessionId, NAMESPACE)

        expect(result).toMatchObject({ type: 'error', code: 'resume_failed' })
        expect(stoppedSessionId).toBe(sessionId)
        expect(engine.getSessionByNamespace(sessionId, NAMESPACE)?.active).toBe(false)
    })

    it('persists a quarantine and rejects an immediate retry when the timed-out child stays alive', async () => {
        const sessionId = insertSession(
            'pty-session-still-alive',
            baseMetadata({ lifecycleState: 'archived', archivedBy: 'hub', archiveReason: 'inactivity' }),
            { startingMode: 'pty' }
        ).id
        let spawnCalls = 0
        ;(engine as any).rpcGateway.spawnSession = async () => {
            spawnCalls += 1
            engine.handleSessionAlive({ sid: sessionId, time: Date.now() })
            return { type: 'success', sessionId }
        }
        ;(engine as any).waitForSessionReady = async () => 'timeout'
        ;(engine as any).rpcGateway.stopRunnerSession = async () => 'still_alive'

        const first = await engine.reopenSession(sessionId, NAMESPACE)
        const second = await engine.reopenSession(sessionId, NAMESPACE)

        expect(first).toMatchObject({ type: 'error', code: 'resume_failed', rollbackSafe: false })
        expect(second).toMatchObject({ type: 'error', code: 'resume_failed' })
        expect(spawnCalls).toBe(1)
        expect((engine.getSessionByNamespace(sessionId, NAMESPACE)?.metadata as any)?.ptyResumeAttempt)
            .toMatchObject({ state: 'quarantined', machineId: 'machine-x' })
    })

    it('keeps a persisted PTY quarantine fail-closed across hub restart when the child is still alive', async () => {
        const sessionId = insertSession(
            'pty-session-restart-still-alive',
            baseMetadata({
                lifecycleState: 'running',
                ptyResumeAttempt: { state: 'quarantined', machineId: 'machine-x', startedAt: 1 },
            }),
            { startingMode: 'pty' }
        ).id
        engine.handleSessionAlive({ sid: sessionId, time: Date.now() })

        const restarted = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
        ;(restarted as any).machineCache = {
            // CI 慢机上 syncEngine 的 5s inactivity tick 会在测试中开火，
            // 残缺 mock 缺 expireInactive 直接 TypeError（上游 flake，非本地可见）。
            expireInactive: () => {},
            getOnlineMachinesByNamespace: () => [{ id: 'machine-x', metadata: { host: 'localhost' } }]
        }
        ;(restarted as any).rpcGateway.stopRunnerSession = async () => 'still_alive'

        const result = await restarted.reopenSession(sessionId, NAMESPACE)

        expect(result).toMatchObject({ type: 'error', code: 'resume_failed' })
        expect((restarted.getSessionByNamespace(sessionId, NAMESPACE)?.metadata as any)?.ptyResumeAttempt)
            .toBeDefined()
        restarted.stop()
    })

    it('reconciles a persisted PTY quarantine after restart when the old child is already gone', async () => {
        const sessionId = insertSession(
            'pty-session-restart-gone',
            baseMetadata({
                lifecycleState: 'running',
                ptyResumeAttempt: { state: 'quarantined', machineId: 'machine-x', startedAt: 1 },
            }),
            { startingMode: 'pty' }
        ).id
        engine.handleSessionAlive({ sid: sessionId, time: Date.now() })

        const restarted = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
        ;(restarted as any).machineCache = {
            // CI 慢机上 syncEngine 的 5s inactivity tick 会在测试中开火，
            // 残缺 mock 缺 expireInactive 直接 TypeError（上游 flake，非本地可见）。
            expireInactive: () => {},
            getOnlineMachinesByNamespace: () => [{ id: 'machine-x', metadata: { host: 'localhost' } }]
        }
        ;(restarted as any).rpcGateway.stopRunnerSession = async () => 'already_gone'
        ;(restarted as any).rpcGateway.spawnSession = async () => {
            restarted.handleSessionAlive({ sid: sessionId, time: Date.now() })
            restarted.handleSessionReady({ sid: sessionId, time: Date.now() })
            return { type: 'success', sessionId }
        }

        const result = await restarted.reopenSession(sessionId, NAMESPACE)

        expect(result).toEqual({ type: 'success', sessionId, resumed: true })
        expect((restarted.getSessionByNamespace(sessionId, NAMESPACE)?.metadata as any)?.ptyResumeAttempt)
            .toBeUndefined()
        restarted.stop()
    })



    it('does not spawn when the durable pre-spawn PTY attempt cannot be written', async () => {
        const sessionId = insertSession(
            'pty-session-attempt-write-fails',
            baseMetadata({ lifecycleState: 'archived', archivedBy: 'hub', archiveReason: 'inactivity' }),
            { startingMode: 'pty' }
        ).id
        let spawnCalls = 0
        ;(engine as any).rpcGateway.spawnSession = async () => {
            spawnCalls += 1
            return { type: 'success', sessionId }
        }
        const originalUpdate = store.sessions.updateSessionMetadata.bind(store.sessions)
        ;(store.sessions as any).updateSessionMetadata = (...args: any[]) => {
            if (args[1]?.ptyResumeAttempt?.state === 'resuming') return { result: 'not-found' }
            return (originalUpdate as any)(...args)
        }

        const result = await engine.reopenSession(sessionId, NAMESPACE)

        expect(result).toMatchObject({ type: 'error', code: 'resume_failed' })
        expect(spawnCalls).toBe(0)
    })

    it('does not spawn after pre-spawn marker CAS retries are exhausted', async () => {
        const sessionId = insertSession(
            'pty-session-attempt-cas-exhausted',
            baseMetadata({ lifecycleState: 'archived', archivedBy: 'hub', archiveReason: 'inactivity' }),
            { startingMode: 'pty' }
        ).id
        let spawnCalls = 0
        ;(engine as any).rpcGateway.spawnSession = async () => {
            spawnCalls += 1
            return { type: 'success', sessionId }
        }
        const originalUpdate = store.sessions.updateSessionMetadata.bind(store.sessions)
        ;(store.sessions as any).updateSessionMetadata = (...args: any[]) => {
            if (args[1]?.ptyResumeAttempt?.state === 'resuming') return { result: 'version-mismatch' }
            return (originalUpdate as any)(...args)
        }

        const result = await engine.reopenSession(sessionId, NAMESPACE)

        expect(result).toMatchObject({ type: 'error', code: 'resume_failed' })
        expect(spawnCalls).toBe(0)
    })

    it('keeps the durable resuming marker when quarantine transition fails', async () => {
        const sessionId = insertSession(
            'pty-session-transition-fails',
            baseMetadata({ lifecycleState: 'archived', archivedBy: 'hub', archiveReason: 'inactivity' }),
            { startingMode: 'pty' }
        ).id
        ;(engine as any).rpcGateway.spawnSession = async () => {
            engine.handleSessionAlive({ sid: sessionId, time: Date.now() })
            return { type: 'success', sessionId }
        }
        ;(engine as any).waitForSessionReady = async () => 'timeout'
        ;(engine as any).rpcGateway.stopRunnerSession = async () => 'still_alive'
        const originalUpdate = store.sessions.updateSessionMetadata.bind(store.sessions)
        ;(store.sessions as any).updateSessionMetadata = (...args: any[]) => {
            if (args[1]?.ptyResumeAttempt?.state === 'quarantined') return { result: 'not-found' }
            return (originalUpdate as any)(...args)
        }

        const first = await engine.reopenSession(sessionId, NAMESPACE)

        expect(first).toMatchObject({ type: 'error', code: 'resume_failed', rollbackSafe: false })
        expect((engine.getSessionByNamespace(sessionId, NAMESPACE)?.metadata as any)?.ptyResumeAttempt)
            .toMatchObject({ state: 'resuming' })

        const restarted = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
        ;(restarted as any).rpcGateway.stopRunnerSession = async () => 'still_alive'
        let spawnCalls = 0
        ;(restarted as any).rpcGateway.spawnSession = async () => {
            spawnCalls += 1
            return { type: 'success', sessionId }
        }
        const retry = await restarted.reopenSession(sessionId, NAMESPACE)
        expect(retry).toMatchObject({ type: 'error', code: 'resume_failed' })
        expect(spawnCalls).toBe(0)
        restarted.stop()
    })

    it('does not spawn when clearing a reconciled durable PTY marker fails', async () => {
        const sessionId = insertSession(
            'pty-session-clear-fails',
            baseMetadata({
                lifecycleState: 'running',
                ptyResumeAttempt: { state: 'resuming', machineId: 'machine-x', startedAt: 1 },
            }),
            { startingMode: 'pty' }
        ).id
        engine.handleSessionAlive({ sid: sessionId, time: Date.now() })
        ;(engine as any).rpcGateway.stopRunnerSession = async () => 'already_gone'
        let spawnCalls = 0
        ;(engine as any).rpcGateway.spawnSession = async () => {
            spawnCalls += 1
            return { type: 'success', sessionId }
        }
        const originalUpdate = store.sessions.updateSessionMetadata.bind(store.sessions)
        ;(store.sessions as any).updateSessionMetadata = (...args: any[]) => {
            if (args[1]?.ptyResumeAttempt === undefined) return { result: 'not-found' }
            return (originalUpdate as any)(...args)
        }

        const result = await engine.reopenSession(sessionId, NAMESPACE)

        expect(result).toMatchObject({ type: 'error', code: 'resume_failed' })
        expect(spawnCalls).toBe(0)
    })

    it('does not spawn after marker-clear CAS retries are exhausted', async () => {
        const sessionId = insertSession(
            'pty-session-clear-cas-exhausted',
            baseMetadata({
                lifecycleState: 'running',
                ptyResumeAttempt: { state: 'resuming', machineId: 'machine-x', startedAt: 1 },
            }),
            { startingMode: 'pty' }
        ).id
        engine.handleSessionAlive({ sid: sessionId, time: Date.now() })
        ;(engine as any).rpcGateway.stopRunnerSession = async () => 'already_gone'
        let spawnCalls = 0
        ;(engine as any).rpcGateway.spawnSession = async () => {
            spawnCalls += 1
            return { type: 'success', sessionId }
        }
        const originalUpdate = store.sessions.updateSessionMetadata.bind(store.sessions)
        ;(store.sessions as any).updateSessionMetadata = (...args: any[]) => {
            if (args[1]?.ptyResumeAttempt === undefined) return { result: 'version-mismatch' }
            return (originalUpdate as any)(...args)
        }

        const result = await engine.reopenSession(sessionId, NAMESPACE)

        expect(result).toMatchObject({ type: 'error', code: 'resume_failed' })
        expect(spawnCalls).toBe(0)
    })

    it('does not reconcile the durable marker owned by a concurrent direct resume', async () => {
        const sessionId = insertSession(
            'pty-session-resume-then-reopen',
            baseMetadata({ lifecycleState: 'archived', archivedBy: 'hub', archiveReason: 'inactivity' }),
            { startingMode: 'pty' }
        ).id
        let releaseSpawn!: () => void
        const spawnGate = new Promise<void>((resolve) => { releaseSpawn = resolve })
        let spawnCalls = 0
        let stopCalls = 0
        ;(engine as any).rpcGateway.spawnSession = async () => {
            spawnCalls += 1
            await spawnGate
            engine.handleSessionAlive({ sid: sessionId, time: Date.now() })
            engine.handleSessionReady({ sid: sessionId, time: Date.now() })
            return { type: 'success', sessionId }
        }
        ;(engine as any).rpcGateway.stopRunnerSession = async () => {
            stopCalls += 1
            return 'still_alive'
        }

        const resume = engine.resumeSession(sessionId, NAMESPACE)
        for (let i = 0; i < 20 && spawnCalls === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
        const reopenResult = await engine.reopenSession(sessionId, NAMESPACE)
        releaseSpawn()
        const resumeResult = await resume

        expect(reopenResult).toMatchObject({ type: 'error', code: 'resume_failed' })
        expect(resumeResult).toMatchObject({ type: 'success', sessionId })
        expect(spawnCalls).toBe(1)
        expect(stopCalls).toBe(0)
    })

    it('serializes concurrent PTY reopen requests without reconciling the owner marker', async () => {
        const sessionId = insertSession(
            'pty-session-reopen-twice',
            baseMetadata({ lifecycleState: 'archived', archivedBy: 'hub', archiveReason: 'inactivity' }),
            { startingMode: 'pty' }
        ).id
        let releaseSpawn!: () => void
        const spawnGate = new Promise<void>((resolve) => { releaseSpawn = resolve })
        let spawnCalls = 0
        let stopCalls = 0
        ;(engine as any).rpcGateway.spawnSession = async () => {
            spawnCalls += 1
            await spawnGate
            engine.handleSessionAlive({ sid: sessionId, time: Date.now() })
            engine.handleSessionReady({ sid: sessionId, time: Date.now() })
            return { type: 'success', sessionId }
        }
        ;(engine as any).rpcGateway.stopRunnerSession = async () => {
            stopCalls += 1
            return 'still_alive'
        }

        const first = engine.reopenSession(sessionId, NAMESPACE)
        for (let i = 0; i < 20 && spawnCalls === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
        const secondResult = await engine.reopenSession(sessionId, NAMESPACE)
        releaseSpawn()
        const firstResult = await first

        expect(secondResult).toMatchObject({ type: 'error', code: 'resume_failed' })
        expect(firstResult).toMatchObject({ type: 'success', sessionId })
        expect(spawnCalls).toBe(1)
        expect(stopCalls).toBe(0)
    })

    it('serializes concurrent PTY reopen and resume requests before spawning', async () => {
        const sessionId = insertSession(
            'pty-session-concurrent',
            baseMetadata({ lifecycleState: 'archived', archivedBy: 'hub', archiveReason: 'inactivity' }),
            { startingMode: 'pty' }
        ).id
        let releaseSpawn!: () => void
        const spawnGate = new Promise<void>((resolve) => { releaseSpawn = resolve })
        let spawnCalls = 0
        ;(engine as any).rpcGateway.spawnSession = async () => {
            spawnCalls += 1
            await spawnGate
            engine.handleSessionAlive({ sid: sessionId, time: Date.now() })
            engine.handleSessionReady({ sid: sessionId, time: Date.now() })
            return { type: 'success', sessionId }
        }

        const reopen = engine.reopenSession(sessionId, NAMESPACE)
        for (let i = 0; i < 20 && spawnCalls === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
        const resume = engine.resumeSession(sessionId, NAMESPACE)
        releaseSpawn()
        const [reopenResult, resumeResult] = await Promise.all([reopen, resume])

        expect(spawnCalls).toBe(1)
        expect([reopenResult.type, resumeResult.type].sort()).toEqual(['error', 'success'])
    })


})
