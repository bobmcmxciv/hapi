import { describe, expect, it } from 'bun:test'
import type { RuntimeItem, RuntimePatch, RuntimePublication, RuntimeRun, RuntimeSnapshot } from '@hapi/protocol/runtimeTimeline'
import { RuntimeTimelineRegistry } from './runtimeTimeline'

const item = (id: string, state: RuntimeItem['state'] = 'running', text = ''): RuntimeItem => ({
    id,
    kind: 'assistant',
    runId: 'run-1',
    createdAt: 0,
    updatedAt: 1,
    state,
    text
})

const run = (state: RuntimeRun['state'] = 'running'): RuntimeRun => ({
    id: 'run-1',
    state,
    startedAt: 0
})

const snapshot = (epoch: string, seq: number, items: RuntimeItem[] = [], runState: RuntimeRun | null = run()): RuntimeSnapshot => ({
    version: 1,
    epoch,
    seq,
    items,
    run: runState,
    updatedAt: seq
})

const patch = (epoch: string, seq: number, changes: RuntimePatch['changes']): RuntimePatch => ({
    version: 1,
    epoch,
    seq,
    changes,
    updatedAt: seq
})

const publish = (
    registry: RuntimeTimelineRegistry,
    socketId: string,
    publication: RuntimePublication,
    sessionId = 's1',
    namespace = 'default'
) => registry.publish(sessionId, namespace, socketId, publication)

describe('RuntimeTimelineRegistry', () => {
    it('establishes an epoch from a snapshot and applies adjacent patches', () => {
        const registry = new RuntimeTimelineRegistry()
        expect(publish(registry, 'sock-a', { kind: 'patch', patch: patch('e1', 1, []) })).toEqual({ result: 'resync' })

        expect(publish(registry, 'sock-a', { kind: 'snapshot', snapshot: snapshot('e1', 0, [item('m1')]) })).toEqual({ result: 'ok' })
        expect(publish(registry, 'sock-a', { kind: 'patch', patch: patch('e1', 1, [{ type: 'item', item: item('m1', 'completed', 'done') }]) }))
            .toEqual({ result: 'ok' })

        const state = registry.snapshot('s1', 'default')
        expect(state?.snapshot?.seq).toBe(1)
        expect(state?.snapshot?.items[0]).toMatchObject({ id: 'm1', state: 'completed', text: 'done' })
    })

    it('rejects patch sequence gaps with a resync request and ignores duplicates', () => {
        const registry = new RuntimeTimelineRegistry()
        publish(registry, 'sock-a', { kind: 'snapshot', snapshot: snapshot('e1', 0) })

        expect(publish(registry, 'sock-a', { kind: 'patch', patch: patch('e1', 2, []) })).toEqual({ result: 'resync' })
        expect(registry.snapshot('s1', 'default')?.snapshot?.seq).toBe(0)

        expect(publish(registry, 'sock-a', { kind: 'patch', patch: patch('e1', 1, [{ type: 'run', run: run('idle') }]) })).toEqual({ result: 'ok' })
        // Duplicate/replayed seq is a safe no-op, not an error.
        expect(publish(registry, 'sock-a', { kind: 'patch', patch: patch('e1', 1, [{ type: 'run', run: run('error') }]) })).toEqual({ result: 'ok' })
        expect(registry.snapshot('s1', 'default')?.snapshot?.run?.state).toBe('idle')
    })

    it('evicts down to the shared retained cap instead of resync-looping, and caps wire at 4MiB', () => {
        // Shared policy (producer agreement): wire ≤ MAX_RUNTIME_PUBLICATION_BYTES
        // for both kinds; retained state ≤ MAX_RUNTIME_RETAINED_BYTES enforced by
        // projection-side eviction (completed first, then terminal, then oldest).
        const registry = new RuntimeTimelineRegistry()
        const big = 'x'.repeat(90 * 1024)
        // ~2.6MiB retained → admitted whole.
        const okItems = Array.from({ length: 28 }, (_, i) => item(`m${i}`, 'completed', big))
        expect(publish(registry, 'sock-a', { kind: 'snapshot', snapshot: snapshot('e1', 0, okItems) })).toEqual({ result: 'ok' })
        // After a gap, a fresh snapshot (new epoch) still restores.
        expect(publish(registry, 'sock-a', { kind: 'patch', patch: patch('e1', 9, []) })).toEqual({ result: 'resync' })
        expect(publish(registry, 'sock-a', { kind: 'snapshot', snapshot: snapshot('e2', 0, okItems) })).toEqual({ result: 'ok' })

        // ~3.7MiB retained: projection evicts completed items down to the cap
        // rather than reject — admission uses projected retained bytes.
        const overItems = Array.from({ length: 40 }, (_, i) => item(`o${i}`, 'completed', big))
        expect(publish(registry, 'sock-b', { kind: 'snapshot', snapshot: snapshot('e3', 0, overItems) }, 's2')).toEqual({ result: 'ok' })
        const retained = registry.snapshot('s2', 'default')?.snapshot
        expect(retained!.items.length).toBeLessThan(40)
        expect(retained!.items.every(i => i.id !== 'o0')).toBe(true) // oldest evicted first

        // Eviction also applies on the patch path: a fat running item pushes
        // completed siblings out but is retained itself.
        const fatRunning = item('live-1', 'running', 'z'.repeat(2500 * 1024))
        expect(publish(registry, 'sock-a', { kind: 'patch', patch: patch('e2', 1, [{ type: 'item', item: fatRunning }]) })).toEqual({ result: 'ok' })
        const live = registry.snapshot('s1', 'default')?.snapshot
        expect(live!.items.some(i => i.id === 'live-1')).toBe(true)
        expect(live!.items.filter(i => i.id.startsWith('m')).length).toBeLessThan(28)

        // 'delete' changes shrink the projection and the retained ledger.
        publish(registry, 'sock-a', { kind: 'patch', patch: patch('e2', 2, [{ type: 'delete', id: 'live-1' }]) })
        expect(registry.snapshot('s1', 'default')?.snapshot?.items.some(i => i.id === 'live-1')).toBe(false)

        // A single item larger than the retained cap is evicted whole — the
        // shared policy never slices entity content; with no room left after
        // evicting completed items, the monster evicts even itself.
        const monster = item('monster', 'running', 'z'.repeat(3 * 1024 * 1024))
        expect(publish(registry, 'sock-a', { kind: 'patch', patch: patch('e2', 3, [{ type: 'item', item: monster }]) })).toEqual({ result: 'ok' })
        expect(registry.snapshot('s1', 'default')?.snapshot?.items.some(i => i.id === 'monster')).toBe(false)

        // Wire cap applies to both kinds: a >4MiB publication is rejected even
        // when its content would fit retained bytes after eviction.
        const fatPatch = patch('e2', 4, [{ type: 'item', item: item('m0', 'running', 'y'.repeat(5 * 1024 * 1024)) }])
        expect(publish(registry, 'sock-a', { kind: 'patch', patch: fatPatch })).toEqual({ result: 'error', reason: 'too-large' })
    })

    it('rejects oversized non-evictable run metadata without advancing or retiring state', () => {
        const registry = new RuntimeTimelineRegistry()
        expect(publish(registry, 'sock-a', { kind: 'snapshot', snapshot: snapshot('e1', 0) })).toEqual({ result: 'ok' })
        const oversizedRun: RuntimeRun = { ...run('error'), errorMessage: 'x'.repeat(3 * 1024 * 1024) }
        expect(publish(registry, 'sock-a', {
            kind: 'patch', patch: patch('e1', 1, [{ type: 'run', run: oversizedRun }])
        })).toEqual({ result: 'error', reason: 'too-large' })
        expect(registry.snapshot('s1', 'default')?.snapshot?.seq).toBe(0)
        expect(publish(registry, 'sock-a', {
            kind: 'snapshot', snapshot: snapshot('e2', 0, [], oversizedRun)
        })).toEqual({ result: 'error', reason: 'too-large' })
        expect(registry.snapshot('s1', 'default')?.snapshot?.epoch).toBe('e1')
        expect(publish(registry, 'sock-a', {
            kind: 'patch', patch: patch('e1', 1, [{ type: 'run', run: run('idle') }])
        })).toEqual({ result: 'ok' })
    })

    it('rejects foreign-epoch patches and accepts epoch replacement only via snapshot', () => {
        const registry = new RuntimeTimelineRegistry()
        publish(registry, 'sock-a', { kind: 'snapshot', snapshot: snapshot('e1', 3) })

        expect(publish(registry, 'sock-a', { kind: 'patch', patch: patch('e2', 1, []) })).toEqual({ result: 'resync' })
        expect(publish(registry, 'sock-a', { kind: 'snapshot', snapshot: snapshot('e2', 0) })).toEqual({ result: 'ok' })
        expect(registry.snapshot('s1', 'default')?.snapshot?.epoch).toBe('e2')
    })

    it('retires the previous source socket after a takeover and rejects its patches', () => {
        const registry = new RuntimeTimelineRegistry()
        publish(registry, 'sock-a', { kind: 'snapshot', snapshot: snapshot('e1', 0) })
        publish(registry, 'sock-b', { kind: 'snapshot', snapshot: snapshot('e1', 0) })

        expect(publish(registry, 'sock-a', { kind: 'patch', patch: patch('e1', 1, []) }))
            .toEqual({ result: 'error', reason: 'retired-source' })
        // A superseded connection cannot reclaim authority even with a snapshot.
        expect(publish(registry, 'sock-a', { kind: 'snapshot', snapshot: snapshot('e1', 0) }))
            .toEqual({ result: 'error', reason: 'retired-source' })
        expect(publish(registry, 'sock-b', { kind: 'patch', patch: patch('e1', 1, []) })).toEqual({ result: 'ok' })
    })

    it('requires a reconnecting socket to replay a snapshot before patches', () => {
        const registry = new RuntimeTimelineRegistry()
        publish(registry, 'sock-a', { kind: 'snapshot', snapshot: snapshot('e1', 0) })
        registry.disconnectSocket('sock-a')

        // Reconnect path 1: CLI re-sends the authoritative snapshot first.
        expect(publish(registry, 'sock-b', { kind: 'snapshot', snapshot: snapshot('e1', 0) })).toEqual({ result: 'ok' })
        expect(registry.snapshot('s1', 'default')?.source).toBe('connected')

        registry.disconnectSocket('sock-b')
        expect(publish(registry, 'sock-c', { kind: 'patch', patch: patch('e1', 1, [{ type: 'item', item: item('m1') }]) }))
            .toEqual({ result: 'resync' })
        expect(publish(registry, 'sock-c', { kind: 'snapshot', snapshot: snapshot('e1', 1, [item('m1')]) })).toEqual({ result: 'ok' })
        expect(registry.snapshot('s1', 'default')?.snapshot?.seq).toBe(1)
    })

    it('marks source disconnected without finalizing the agent run', () => {
        const registry = new RuntimeTimelineRegistry()
        publish(registry, 'sock-a', { kind: 'snapshot', snapshot: snapshot('e1', 0, [item('m1')], run('running')) })

        const sub = registry.subscribe('s1', 'default')
        expect(sub?.source).toBe('connected')
        sub?.pending.splice(0)

        registry.disconnectSocket('sock-a')
        expect(registry.snapshot('s1', 'default')?.snapshot?.run?.state).toBe('running')
        expect(registry.snapshot('s1', 'default')?.source).toBe('disconnected')
        expect(sub?.pending).toEqual([{ kind: 'runtime-source', source: 'disconnected' }])
    })

    it('subscribes atomically: snapshot first, then every later frame in order', async () => {
        const registry = new RuntimeTimelineRegistry()
        const sub = registry.subscribe('s1', 'default')
        expect(sub?.initial).toEqual({ kind: 'unavailable' })
        expect(sub?.source).toBe('none')

        publish(registry, 'sock-a', { kind: 'snapshot', snapshot: snapshot('e1', 0, [item('m1')]) })
        publish(registry, 'sock-a', { kind: 'patch', patch: patch('e1', 1, [{ type: 'item', item: item('m1', 'completed') }]) })

        const frames = sub?.pending.splice(0) ?? []
        expect(frames.map(f => (f as RuntimePublication).kind)).toEqual(['snapshot', 'patch'])
        expect((frames[0] as { snapshot: RuntimeSnapshot }).snapshot.items).toHaveLength(1)

        // wait() resolves on new frames and null after close.
        const waiter = sub!.wait()
        publish(registry, 'sock-a', { kind: 'patch', patch: patch('e1', 2, []) })
        expect(await waiter).toBe(true)
        sub!.close()
        expect(await sub!.wait()).toBeNull()
    })

    it('returns the current snapshot to late subscribers', () => {
        const registry = new RuntimeTimelineRegistry()
        publish(registry, 'sock-a', { kind: 'snapshot', snapshot: snapshot('e1', 0, [item('m1')]) })
        publish(registry, 'sock-a', { kind: 'patch', patch: patch('e1', 1, [{ type: 'item', item: item('m1', 'completed', 'final') }]) })

        const sub = registry.subscribe('s1', 'default')
        const initial = sub?.initial as { kind: 'snapshot'; snapshot: RuntimeSnapshot }
        expect(initial.kind).toBe('snapshot')
        expect(initial.snapshot.seq).toBe(1)
        expect(initial.snapshot.items[0].text).toBe('final')
        expect(sub?.pending).toHaveLength(0)
    })

    it('enforces the namespace guard on publish, subscribe, and read', () => {
        const registry = new RuntimeTimelineRegistry()
        publish(registry, 'sock-a', { kind: 'snapshot', snapshot: snapshot('e1', 0) }, 's1', 'ns-a')

        expect(publish(registry, 'sock-b', { kind: 'snapshot', snapshot: snapshot('e9', 0) }, 's1', 'ns-b'))
            .toEqual({ result: 'error', reason: 'namespace-mismatch' })
        expect(registry.subscribe('s1', 'ns-b')).toBeNull()
        expect(registry.snapshot('s1', 'ns-b')).toBeNull()
        expect(registry.snapshot('s1', 'ns-a')?.snapshot?.epoch).toBe('e1')
    })

    it('drops a session and closes its subscribers', async () => {
        const registry = new RuntimeTimelineRegistry()
        publish(registry, 'sock-a', { kind: 'snapshot', snapshot: snapshot('e1', 0) })
        const sub = registry.subscribe('s1', 'default')!

        const waiter = sub.wait()
        registry.drop('s1')
        expect(await waiter).toBeNull()
        expect(registry.snapshot('s1', 'default')).toBeNull()
    })

    it('evicts LRU idle sessions but never live subscriptions or connected publishers', () => {
        const registry = new RuntimeTimelineRegistry({ maxSessions: 2 })
        publish(registry, 'a', { kind: 'snapshot', snapshot: snapshot('e1', 0) }, 's1')
        const sub = registry.subscribe('s2', 'default')
        registry.disconnectSocket('a')
        // s3's creation must evict s1 (idle), not s2 (live subscriber).
        publish(registry, 'c', { kind: 'snapshot', snapshot: snapshot('e1', 0) }, 's3')
        expect(registry.snapshot('s1', 'default')).toBeNull()
        expect(sub?.initial).toBeDefined()

        // Everything protected → refuse to grow past the bound silently.
        const registry2 = new RuntimeTimelineRegistry({ maxSessions: 1 })
        registry2.subscribe('only', 'default')
        publish(registry2, 'x', { kind: 'snapshot', snapshot: snapshot('e1', 0) }, 'other')
        expect(registry2.snapshot('other', 'default')).toBeNull()
    })

    it('bounds subscriber queues: a stuck consumer is dropped, not buffered forever', async () => {
        const registry = new RuntimeTimelineRegistry({ maxPendingFrames: 2 })
        publish(registry, 'sock-a', { kind: 'snapshot', snapshot: snapshot('e1', 0) })
        const sub = registry.subscribe('s1', 'default')!
        sub.pending.splice(0)

        publish(registry, 'sock-a', { kind: 'patch', patch: patch('e1', 1, []) })
        publish(registry, 'sock-a', { kind: 'patch', patch: patch('e1', 2, []) })
        publish(registry, 'sock-a', { kind: 'patch', patch: patch('e1', 3, []) }) // overflows the bound
        expect(await sub.wait()).toBeNull()
        expect(sub.pending.length).toBeLessThanOrEqual(2)
    })

    it('keeps final rows after session-end and still accepts a new epoch', () => {
        const registry = new RuntimeTimelineRegistry()
        publish(registry, 'sock-a', { kind: 'snapshot', snapshot: snapshot('e1', 0, [item('m1', 'completed')]) })
        registry.markSessionEnded('s1', 'sock-a')
        expect(registry.snapshot('s1', 'default')?.snapshot?.items).toHaveLength(1)

        publish(registry, 'sock-b', { kind: 'snapshot', snapshot: snapshot('e2', 0) })
        expect(registry.snapshot('s1', 'default')?.snapshot?.epoch).toBe('e2')
    })
    it('fences by connection order even when an old socket first publishes late', () => {
        const registry = new RuntimeTimelineRegistry()
        registry.connectSource('old')
        registry.connectSource('new')
        expect(publish(registry, 'new', { kind: 'snapshot', snapshot: snapshot('new-epoch', 0) })).toEqual({ result: 'ok' })
        expect(publish(registry, 'old', { kind: 'snapshot', snapshot: snapshot('old-epoch', 99) }))
            .toEqual({ result: 'error', reason: 'retired-source' })
        registry.markSessionEnded('s1', 'old')
        registry.disconnectSocket('old')
        expect(registry.snapshot('s1', 'default')?.source).toBe('connected')
        expect(registry.snapshot('s1', 'default')?.snapshot?.epoch).toBe('new-epoch')
    })

    it('rejects retired epochs and same-epoch stale snapshots without rollback', () => {
        const registry = new RuntimeTimelineRegistry()
        publish(registry, 'sock', { kind: 'snapshot', snapshot: snapshot('e1', 4) })
        expect(publish(registry, 'sock', { kind: 'snapshot', snapshot: snapshot('e1', 3) })).toEqual({ result: 'resync' })
        publish(registry, 'sock', { kind: 'snapshot', snapshot: snapshot('e2', 0) })
        expect(publish(registry, 'sock', { kind: 'snapshot', snapshot: snapshot('e1', 5) }))
            .toEqual({ result: 'error', reason: 'retired-source' })
        expect(registry.snapshot('s1', 'default')?.snapshot?.epoch).toBe('e2')
    })

    it('ignores duplicate snapshots instead of reviving completed items', () => {
        const registry = new RuntimeTimelineRegistry()
        publish(registry, 'a', { kind: 'snapshot', snapshot: snapshot('e1', 1, [item('m1', 'completed', 'done')]) })
        publish(registry, 'b', { kind: 'snapshot', snapshot: snapshot('e1', 1, [item('m1', 'running', 'old')]) })
        expect(registry.snapshot('s1', 'default')?.snapshot?.items[0].state).toBe('completed')
    })

    it('rejects oversized publications without truncating the authoritative timeline', () => {
        const registry = new RuntimeTimelineRegistry({ maxPublicationBytes: 1024 })
        publish(registry, 'a', { kind: 'snapshot', snapshot: snapshot('e1', 0) })
        expect(publish(registry, 'a', { kind: 'patch', patch: patch('e1', 1, [{ type: 'item', item: item('large', 'completed', 'x'.repeat(2048)) }]) }))
            .toEqual({ result: 'error', reason: 'too-large' })
        expect(registry.snapshot('s1', 'default')?.snapshot?.seq).toBe(0)
        expect(registry.snapshot('s1', 'default')?.snapshot?.items).toEqual([])
    })
})
