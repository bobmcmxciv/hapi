import { describe, expect, it } from 'bun:test'
import {
    MAX_RUNTIME_PUBLICATION_BYTES,
    MAX_RUNTIME_RETAINED_BYTES,
    runtimeSerializedBytes,
    RuntimeTimelineProjection,
    RuntimeSnapshotSchema,
    applyRuntimePatch,
    createRuntimeSnapshot,
    type RuntimeItem,
    type RuntimePatch,
} from './runtimeTimeline'

function item(overrides: Partial<RuntimeItem> = {}): RuntimeItem {
    return { id: 'reply', kind: 'assistant', runId: 'run-1', createdAt: 1, updatedAt: 1, state: 'running', text: 'first', ...overrides }
}
function patch(seq: number, changes: RuntimePatch['changes'], epoch = 'launch-1'): RuntimePatch {
    return { version: 1, epoch, seq, changes, updatedAt: seq }
}

describe('runtime timeline revisions', () => {
    it('keeps the last committed state intact when a revision gap or foreign epoch arrives', () => {
        const projection = new RuntimeTimelineProjection('launch-1')
        projection.apply(patch(1, [{ type: 'item', item: item() }]))
        expect(() => projection.apply(patch(3, [{ type: 'item', item: item({ text: 'missing revision' }) }]))).toThrow('sequence gap')
        expect(() => projection.apply(patch(2, [{ type: 'clear' }], 'launch-2'))).toThrow('epoch changed')
        expect(projection.snapshot().items.map(row => row.text)).toEqual(['first'])
        expect(projection.seq).toBe(1)
        projection.apply(patch(2, [{ type: 'item', item: item({ text: 'second', updatedAt: 2 }) }]))
        expect(projection.snapshot().items.map(row => row.text)).toEqual(['second'])
    })

    it('does not replay a duplicate commit or resurrect a finished entity and run', () => {
        const projection = new RuntimeTimelineProjection('launch-1')
        projection.apply(patch(1, [
            { type: 'item', item: item({ state: 'aborted', stopReason: 'aborted', updatedAt: 3 }) },
            { type: 'run', run: { id: 'run-1', state: 'aborted', startedAt: 1, endedAt: 3, stopReason: 'aborted' } },
        ]))
        expect(projection.apply(patch(1, [{ type: 'clear' }]))).toBe(false)
        projection.apply(patch(2, [
            { type: 'item', item: item({ text: 'late data', updatedAt: 4 }) },
            { type: 'run', run: { id: 'run-1', state: 'running', startedAt: 1 } },
        ]))
        const snapshot = projection.snapshot()
        expect(snapshot.items[0]).toMatchObject({ text: 'first', state: 'aborted', stopReason: 'aborted' })
        expect(snapshot.run).toMatchObject({ state: 'aborted', endedAt: 3 })
    })

    it('commits the last reply and terminal state together while preserving model stop reasons', () => {
        const initial = createRuntimeSnapshot('launch-1')
        const next = applyRuntimePatch(initial, patch(1, [
            { type: 'item', item: item({ text: 'output before limit', state: 'completed', stopReason: 'length', updatedAt: 5 }) },
            { type: 'run', run: { id: 'run-1', state: 'idle', startedAt: 1, endedAt: 5, stopReason: 'length' } },
        ]))
        expect(initial.items).toEqual([])
        expect(next.items[0]).toMatchObject({ text: 'output before limit', stopReason: 'length' })
        expect(next.run?.stopReason).toBe('length')
        const reset = applyRuntimePatch(next, patch(2, [{ type: 'clear' }]))
        expect(reset.items).toEqual([])
        expect(reset.run).toBeNull()
    })

    it('rejects ambiguous snapshots containing duplicate entity identities', () => {
        const parsed = RuntimeSnapshotSchema.safeParse({ ...createRuntimeSnapshot('launch-1'), items: [item(), item({ text: 'conflicting' })] })
        expect(parsed.success).toBe(false)
        if (!parsed.success) expect(parsed.error.issues.map(issue => issue.message)).toContain('Duplicate runtime item: reply')
    })

    it('evicts whole completed rows before live rows and keeps snapshots replayable in UTF-8', () => {
        const projection = new RuntimeTimelineProjection('launch-1')
        const fullText = '测'.repeat(600_000)
        projection.apply(patch(1, [
            { type: 'item', item: item({ id: 'old', state: 'completed', text: fullText }) },
            { type: 'item', item: item({ id: 'live', text: fullText }) },
        ]))
        expect(projection.takeEvictedIds()).toEqual(['old'])
        expect(projection.retainedBytes).toBeLessThanOrEqual(MAX_RUNTIME_RETAINED_BYTES)
        const snapshot = projection.snapshot()
        expect(snapshot.items.map(row => row.id)).toEqual(['live'])
        expect(snapshot.items[0].text).toBe(fullText)
        expect(runtimeSerializedBytes({ kind: 'snapshot', snapshot })).toBeLessThan(MAX_RUNTIME_PUBLICATION_BYTES)
        const recovered = new RuntimeTimelineProjection('launch-1')
        recovered.replace(snapshot)
        expect(recovered.retainedBytes).toBe(projection.retainedBytes)
        recovered.apply(patch(2, [{ type: 'delete', id: 'live' }]))
        expect(recovered.snapshot().items).toEqual([])
    })

    it('rejects oversized run metadata before partially applying an atomic commit', () => {
        const projection = new RuntimeTimelineProjection('launch-1')
        projection.apply(patch(1, [{ type: 'item', item: item() }]))
        expect(() => projection.apply(patch(2, [
            { type: 'clear' },
            { type: 'run', run: { id: 'r', state: 'error', startedAt: 1, errorMessage: 'x'.repeat(MAX_RUNTIME_RETAINED_BYTES) } },
        ]))).toThrow('retention budget')
        expect(projection.snapshot().items.map(row => row.text)).toEqual(['first'])
        expect(projection.seq).toBe(1)
    })
})
