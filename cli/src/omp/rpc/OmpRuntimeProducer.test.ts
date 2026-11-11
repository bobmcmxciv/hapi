import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_RUNTIME_PUBLICATION_BYTES, MAX_RUNTIME_RETAINED_BYTES, RuntimeTimelineProjection, runtimeSerializedBytes, type RuntimeChange, type RuntimeItem, type RuntimePublication } from '@hapi/protocol/runtimeTimeline';
import { OmpRuntimeProducer } from './OmpRuntimeProducer';

function item(text: string, state: RuntimeItem['state'] = 'running'): RuntimeChange {
    return { type: 'item', item: { id: 'assistant-1', canonicalId: 'assistant-1', kind: 'assistant', runId: 'run-1', createdAt: 100, updatedAt: Date.now(), state, text } };
}

afterEach(() => vi.useRealTimers());

describe('OmpRuntimeProducer', () => {
    it('bootstraps one epoch and coalesces live item state for 50ms into adjacent revisions', () => {
        vi.useFakeTimers();
        const publications: RuntimePublication[] = [];
        const producer = new OmpRuntimeProducer(p => publications.push(p), { epoch: 'launch-1' });
        expect(publications).toEqual([{ kind: 'snapshot', snapshot: { version: 1, epoch: 'launch-1', seq: 0, items: [], run: null, updatedAt: 0 } }]);
        producer.push([item('a')]);
        producer.push([item('ab')]);
        vi.advanceTimersByTime(49);
        expect(publications).toHaveLength(1);
        vi.advanceTimersByTime(1);
        expect(publications[1]).toMatchObject({ kind: 'patch', patch: { epoch: 'launch-1', seq: 1, changes: [{ type: 'item', item: { text: 'ab' } }] } });
        producer.push([item('abc')]);
        vi.advanceTimersByTime(50);
        expect(publications[2]).toMatchObject({ kind: 'patch', patch: { seq: 2 } });
        expect(producer.snapshot()).toMatchObject({ epoch: 'launch-1', seq: 2, items: [{ text: 'abc' }] });
        producer.dispose();
    });

    it('immediately flushes a final item and its coalesced tail without truncating text', () => {
        vi.useFakeTimers();
        const publications: RuntimePublication[] = [];
        const producer = new OmpRuntimeProducer(p => publications.push(p));
        producer.push([item('part')]);
        const text = 'x'.repeat(100_000);
        producer.push([item(text, 'completed')]);
        expect(publications).toHaveLength(2);
        expect(producer.snapshot().items[0].text).toBe(text);
        vi.advanceTimersByTime(500);
        expect(publications).toHaveLength(2);
        producer.dispose();
    });

    it('keeps final abort immutable against delayed callbacks and stops timers on dispose', () => {
        vi.useFakeTimers();
        const publications: RuntimePublication[] = [];
        const producer = new OmpRuntimeProducer(p => publications.push(p));
        producer.push([item('partial'), { type: 'run', run: { id: 'run-1', startedAt: 100, state: 'running' } }]);
        producer.push([item('partial', 'aborted'), { type: 'run', run: { id: 'run-1', startedAt: 100, endedAt: 150, state: 'aborted', stopReason: 'aborted' } }]);
        const final = producer.snapshot();
        producer.push([item('late', 'completed'), { type: 'run', run: { id: 'run-1', startedAt: 100, endedAt: 151, state: 'idle' } }]);
        producer.dispose();
        vi.advanceTimersByTime(500);
        expect(producer.snapshot()).toEqual(final);
        expect(publications).toHaveLength(2);
        producer.push([item('after disposal')]);
        expect(publications).toHaveLength(2);
    });

    it('flushes pending state once at disposal and ignores further pushes', () => {
        vi.useFakeTimers();
        const publications: RuntimePublication[] = [];
        const producer = new OmpRuntimeProducer(p => publications.push(p));
        producer.push([item('tail')]);
        producer.dispose();
        expect(producer.snapshot().seq).toBe(1);
        vi.advanceTimersByTime(500);
        producer.push([item('ignored')]);
        expect(publications).toHaveLength(2);
    });

    it('admits final items in the same batch as a terminal run and publishes the terminal last', () => {
        const publications: RuntimePublication[] = [];
        const producer = new OmpRuntimeProducer(p => publications.push(p));
        producer.push([{ type: 'run', run: { id: 'run-1', startedAt: 100, state: 'running' } }]);
        producer.push([
            { type: 'run', run: { id: 'run-1', startedAt: 100, state: 'idle', endedAt: 110 } },
            item('complete tail', 'completed'),
        ]);
        const emitted = publications.at(-1);
        expect(emitted?.kind).toBe('patch');
        if (emitted?.kind === 'patch') expect(emitted.patch.changes.map(change => change.type)).toEqual(['item', 'run']);
        expect(producer.snapshot()).toMatchObject({ items: [{ text: 'complete tail', state: 'completed' }], run: { state: 'idle' } });
        producer.dispose();
    });

    it('splits large commits and replays every admitted state below the snapshot limit', () => {
        const publications: RuntimePublication[] = [];
        const producer = new OmpRuntimeProducer(p => publications.push(p), { epoch: 'bounded' });
        const first = item('a'.repeat(2 * 1024 * 1024), 'completed');
        const second = item('b'.repeat(2 * 1024 * 1024), 'completed');
        if (second.type !== 'item') throw new Error('Expected item fixture');
        second.item.id = 'assistant-2';
        producer.push([first, second]);
        const replay = new RuntimeTimelineProjection('bounded');
        for (const publication of publications) {
            expect(runtimeSerializedBytes(publication)).toBeLessThanOrEqual(MAX_RUNTIME_PUBLICATION_BYTES);
            if (publication.kind === 'snapshot') replay.replace(publication.snapshot);
            else replay.apply(publication.patch);
            expect(replay.retainedBytes).toBeLessThanOrEqual(MAX_RUNTIME_RETAINED_BYTES);
        }
        expect(replay.snapshot()).toEqual(producer.snapshot());
        expect(replay.snapshot().items.map(row => row.id)).toEqual(['assistant-2']);
        producer.dispose();
    });

    it('marks an oversized live preview omitted without mutating the native payload', () => {
        const producer = new OmpRuntimeProducer(() => { });
        const original = item('x'.repeat(MAX_RUNTIME_PUBLICATION_BYTES), 'completed');
        producer.push([original]);
        expect(producer.snapshot().items[0]).toMatchObject({ id: 'assistant-1', state: 'completed', previewOmitted: true });
        expect(producer.snapshot().items[0].text).toBeUndefined();
        if (original.type === 'item') expect(original.item.text).toBe('x'.repeat(MAX_RUNTIME_PUBLICATION_BYTES));
        producer.dispose();
    });
});
