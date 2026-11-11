import { describe, expect, it } from 'bun:test'
import type { Socket } from 'socket.io'
import { RpcRegistry } from './rpcRegistry'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../store'

const source = (id: string) => ({ id }) as Socket

describe('native RPC source succession', () => {
    it('permits one process per attempt, preserves reconnect identity, and permanently retires superseded processes', () => {
        const registry = new RpcRegistry()
        const first = source('socket-first')
        const firstOrder = registry.nextSourceConnectionOrder()
        expect(registry.canInitializeSessionSource('session', 'process-first', firstOrder)).toBe(true)
        expect(registry.claimSessionSource(first, 'session', 'process-first', 'attempt-one', firstOrder)).toBe(true)
        registry.register(first, 'session:killSession')
        registry.register(first, 'session:abort')
        const duplicate = source('socket-duplicate')
        const duplicateOrder = registry.nextSourceConnectionOrder()
        expect(registry.canInitializeSessionSource('session', 'process-duplicate', duplicateOrder)).toBe(false)
        expect(registry.claimSessionSource(duplicate, 'session', 'process-duplicate', 'attempt-one', duplicateOrder)).toBe(false)
        expect(registry.getSocketIdForMethod('session:killSession')).toBe(first.id)

        const reconnect = source('socket-reconnect')
        const reconnectOrder = registry.nextSourceConnectionOrder()
        expect(registry.claimSessionSource(reconnect, 'session', 'process-first', 'attempt-one', reconnectOrder)).toBe(true)
        registry.register(reconnect, 'session:killSession')
        expect(registry.getSocketIdForMethod('session:abort')).toBeNull()
        expect(registry.claimSessionSource(first, 'session', 'process-first', 'attempt-one', firstOrder)).toBe(false)
        registry.unregisterAll(first)
        expect(registry.getSocketIdForMethod('session:killSession')).toBe(reconnect.id)

        const replacement = source('socket-new-attempt')
        const replacementOrder = registry.nextSourceConnectionOrder()
        expect(registry.claimSessionSource(replacement, 'session', 'process-replacement', 'attempt-two', replacementOrder)).toBe(true)
        registry.register(replacement, 'session:killSession')
        expect(registry.getSocketIdForMethod('session:abort')).toBeNull()
        registry.unregisterAll(replacement)
        expect(registry.canInitializeSessionSource('session', 'process-first', registry.nextSourceConnectionOrder())).toBe(false)
        expect(registry.claimSessionSource(source('late-first'), 'session', 'process-first', 'attempt-two', registry.nextSourceConnectionOrder())).toBe(false)
        expect(registry.canInitializeSessionSource('session', 'process-replacement', registry.nextSourceConnectionOrder())).toBe(true)
    })

    it('requires a new authoritative attempt before replacing a disconnected modern process', () => {
        const registry = new RpcRegistry()
        const first = source('first')
        registry.claimSessionSource(first, 'session', 'first-process', null, registry.nextSourceConnectionOrder())
        registry.register(first, 'session:killSession')
        registry.unregisterAll(first)
        const replacement = source('replacement')
        expect(registry.claimSessionSource(replacement, 'session', 'replacement-process', null, registry.nextSourceConnectionOrder())).toBe(false)
        expect(registry.claimSessionSource(replacement, 'session', 'replacement-process', 'next-attempt', registry.nextSourceConnectionOrder())).toBe(true)
        registry.register(replacement, 'session:killSession')
        expect(registry.claimSessionSource(source('old-reconnected'), 'session', 'first-process', null, registry.nextSourceConnectionOrder())).toBe(false)
        expect(registry.getSocketIdForMethod('session:killSession')).toBe(replacement.id)
    })

    it('preserves legacy active reconnects but permanently closes compatibility after modern takeover', () => {
        const store = new Store(':memory:')
        try {
            const session = store.sessions.getOrCreateSession('legacy-active', { flavor: 'omp' }, null, 'default')
            const registry = new RpcRegistry()
            registry.bindSourceStore(store.sessions.ompSources)
            const old = source('legacy-before-reconnect')
            const order = registry.nextSourceConnectionOrder()
            expect(registry.claimLegacySessionSource(old, session.id, order)).toBe(true)
            registry.register(old, `${session.id}:abort`)
            registry.register(old, `${session.id}:killSession`)
            const reconnect = source('legacy-reconnected')
            expect(registry.claimLegacySessionSource(reconnect, session.id, registry.nextSourceConnectionOrder())).toBe(true)
            registry.register(reconnect, `${session.id}:killSession`)
            expect(registry.getSocketIdForMethod(`${session.id}:abort`)).toBeNull()
            expect(registry.claimLegacySessionSource(old, session.id, order)).toBe(false)
            const modern = source('modern-takeover')
            expect(registry.claimSessionSource(modern, session.id, 'modern-process', null, registry.nextSourceConnectionOrder())).toBe(true)
            registry.register(modern, `${session.id}:killSession`)
            expect(registry.canUseLegacySessionSource(session.id)).toBe(false)
            registry.unregisterAll(modern)
            expect(registry.claimLegacySessionSource(source('late-legacy'), session.id, registry.nextSourceConnectionOrder())).toBe(false)
            expect(registry.canInitializeSessionSource(session.id, null, registry.nextSourceConnectionOrder())).toBe(false)
        } finally { store.close() }
    })

    it('persists modern bindings, retired nonces and generation-only legacy fences across Hub restart', () => {
        const directory = mkdtempSync(join(tmpdir(), 'hapi-source-fence-'))
        const database = join(directory, 'hub.db')
        let store = new Store(database)
        let closed = false
        try {
            const session = store.sessions.getOrCreateSession('durable-modern', { flavor: 'omp' }, null, 'default')
            const generated = store.sessions.getOrCreateSession('generation-only', { flavor: 'omp' }, null, 'default')
            store.sessions.ompSources.observeGeneration(generated.id, 'generation-one')
            let registry = new RpcRegistry()
            registry.bindSourceStore(store.sessions.ompSources)
            expect(registry.claimSessionSource(source('first'), session.id, 'first-process', null, registry.nextSourceConnectionOrder())).toBe(true)
            store.close()
            closed = true
            store = new Store(database)
            closed = false
            registry = new RpcRegistry()
            registry.bindSourceStore(store.sessions.ompSources)
            expect(registry.canUseLegacySessionSource(session.id)).toBe(false)
            expect(registry.canUseLegacySessionSource(generated.id)).toBe(false)
            expect(registry.claimLegacySessionSource(source('legacy'), session.id, registry.nextSourceConnectionOrder())).toBe(false)
            expect(registry.claimSessionSource(source('impostor'), session.id, 'different-process', null, registry.nextSourceConnectionOrder())).toBe(false)
            expect(registry.claimSessionSource(source('first-reconnected'), session.id, 'first-process', null, registry.nextSourceConnectionOrder())).toBe(true)
            expect(registry.claimSessionSource(source('replacement'), session.id, 'replacement-process', 'attempt-two', registry.nextSourceConnectionOrder())).toBe(true)
            store.close()
            closed = true
            store = new Store(database)
            closed = false
            registry = new RpcRegistry()
            registry.bindSourceStore(store.sessions.ompSources)
            expect(registry.claimSessionSource(source('late-first'), session.id, 'first-process', 'attempt-three', registry.nextSourceConnectionOrder())).toBe(false)
            expect(registry.claimSessionSource(source('replacement-reconnected'), session.id, 'replacement-process', 'attempt-two', registry.nextSourceConnectionOrder())).toBe(true)
            store.sessions.deleteSession(session.id, 'default')
            expect(store.sessions.ompSources.get(session.id)).toBeNull()
            expect(store.sessions.ompSources.isRetired(session.id, 'first-process')).toBe(false)
        } finally {
            if (!closed) store.close()
            rmSync(directory, { recursive: true, force: true })
        }
    })

    it('never treats cleanup-only killSession registrations as publication owners and retires their nonce at cutover', () => {
        const store = new Store(':memory:')
        try {
            const session = store.sessions.getOrCreateSession('quarantined-exit', { flavor: 'omp' }, null, 'default')
            const registry = new RpcRegistry()
            registry.bindSourceStore(store.sessions.ompSources)
            const cleanup = source('cleanup-socket')
            const cleanupOrder = registry.nextSourceConnectionOrder()
            registry.registerCleanupSource(cleanup, session.id, 'cleanup-process', cleanupOrder)

            // Cleanup routes killSession but is not a source: it may not
            // publish, and it cannot pin bootstrap for a replacement.
            expect(registry.isClaimedSessionSource(session.id, cleanup.id)).toBe(false)
            expect(registry.canInitializeSessionSource(session.id, 'new-process', registry.nextSourceConnectionOrder(), 'attempt-two')).toBe(true)
            const replacement = source('replacement')
            expect(registry.claimSessionSource(replacement, session.id, 'new-process', 'attempt-two', registry.nextSourceConnectionOrder())).toBe(true)
            registry.register(replacement, `${session.id}:killSession`)

            registry.retireSessionSources(session.id)
            expect(store.sessions.ompSources.isRetired(session.id, 'cleanup-process')).toBe(true)
            expect(store.sessions.ompSources.isRetired(session.id, 'new-process')).toBe(true)
            expect(registry.getSocketIdForMethod(`${session.id}:killSession`)).toBeNull()
            expect(registry.isClaimedSessionSource(session.id, replacement.id)).toBe(false)
            expect(registry.isClaimedSessionSource(session.id, cleanup.id)).toBe(false)
            expect(registry.canInitializeSessionSource(session.id, 'next-process', registry.nextSourceConnectionOrder(), 'attempt-three')).toBe(true)
            expect(registry.claimSessionSource(source('late'), session.id, 'new-process', 'attempt-three', registry.nextSourceConnectionOrder())).toBe(false)

            const next = source('next-generation')
            expect(registry.claimSessionSource(next, session.id, 'next-process', 'attempt-three', registry.nextSourceConnectionOrder())).toBe(true)
            registry.register(next, `${session.id}:killSession`)
            expect(registry.isClaimedSessionSource(session.id, next.id)).toBe(true)
        } finally { store.close() }
    })

    it('blocks bootstrap only for claimed owners and closes legacy compatibility on cutover', () => {
        const store = new Store(':memory:')
        try {
            const session = store.sessions.getOrCreateSession('cutover-window', { flavor: 'omp' }, null, 'default')
            const registry = new RpcRegistry()
            registry.bindSourceStore(store.sessions.ompSources)
            const first = source('first')
            registry.claimSessionSource(first, session.id, 'first-process', 'attempt-one', registry.nextSourceConnectionOrder())
            registry.register(first, `${session.id}:killSession`)
            // A claimed owner still blocks any bootstrap frame.
            expect(registry.canInitializeSessionSource(session.id, 'impostor', registry.nextSourceConnectionOrder(), 'attempt-two')).toBe(false)
            registry.retireSessionSources(session.id)
            // After cutover the closed generation pins nothing: bootstrap for
            // the next attempt proceeds even while the stale socket lingers.
            expect(registry.canInitializeSessionSource(session.id, 'impostor', registry.nextSourceConnectionOrder(), 'attempt-two')).toBe(true)
            expect(registry.canUseLegacySessionSource(session.id)).toBe(false)
            expect(registry.claimLegacySessionSource(source('legacy'), session.id, registry.nextSourceConnectionOrder())).toBe(false)
        } finally { store.close() }
    })

    it('keeps retired cutover nonces fenced across a Hub restart', () => {
        const directory = mkdtempSync(join(tmpdir(), 'hapi-cutover-fence-'))
        const database = join(directory, 'hub.db')
        let store = new Store(database)
        let closed = false
        try {
            const session = store.sessions.getOrCreateSession('durable-cutover', { flavor: 'omp' }, null, 'default')
            let registry = new RpcRegistry()
            registry.bindSourceStore(store.sessions.ompSources)
            const stale = source('stale-owner')
            registry.claimSessionSource(stale, session.id, 'stale-process', 'attempt-one', registry.nextSourceConnectionOrder())
            registry.register(stale, `${session.id}:killSession`)
            registry.registerCleanupSource(source('stale-cleanup'), session.id, 'cleanup-process', registry.nextSourceConnectionOrder())
            registry.retireSessionSources(session.id)
            store.close()
            closed = true
            store = new Store(database)
            closed = false
            registry = new RpcRegistry()
            registry.bindSourceStore(store.sessions.ompSources)
            // The restarted registry has no memory of the cutover; only the
            // durable retired rows keep the dead generation fenced.
            expect(registry.canInitializeSessionSource(session.id, 'stale-process', registry.nextSourceConnectionOrder(), 'attempt-two')).toBe(false)
            expect(registry.canInitializeSessionSource(session.id, 'cleanup-process', registry.nextSourceConnectionOrder(), 'attempt-two')).toBe(false)
            expect(registry.claimSessionSource(source('revived'), session.id, 'stale-process', 'attempt-two', registry.nextSourceConnectionOrder())).toBe(false)
            expect(registry.claimSessionSource(source('revived-cleanup'), session.id, 'cleanup-process', 'attempt-two', registry.nextSourceConnectionOrder())).toBe(false)
            expect(registry.claimSessionSource(source('new'), session.id, 'new-process', 'attempt-two', registry.nextSourceConnectionOrder())).toBe(true)
            // Cleanup after restart must fence even a durable owner that
            // has not reconnected and therefore has no in-memory claim.
            registry = new RpcRegistry()
            registry.bindSourceStore(store.sessions.ompSources)
            registry.retireSessionSources(session.id)
            expect(store.sessions.ompSources.isRetired(session.id, 'new-process')).toBe(true)
            const legacy = store.sessions.getOrCreateSession('legacy-cutover', { flavor: 'omp' }, null, 'default')
            registry.retireSessionSources(legacy.id)
            registry = new RpcRegistry()
            registry.bindSourceStore(store.sessions.ompSources)
            expect(registry.canUseLegacySessionSource(legacy.id)).toBe(false)
            expect(registry.claimLegacySessionSource(source('legacy-revived'), legacy.id, registry.nextSourceConnectionOrder())).toBe(false)
        } finally {
            if (!closed) store.close()
            rmSync(directory, { recursive: true, force: true })
        }
    })
})
