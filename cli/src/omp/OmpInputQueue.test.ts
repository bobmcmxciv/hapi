import { describe, expect, it, vi } from 'vitest';
import { OmpInputQueue } from './OmpInputQueue';

const mode = { permissionMode: 'default' as const, model: 'test-model' };

describe('OmpInputQueue', () => {
    it('marks queued and launcher-held inputs by localId without changing their admission payloads', () => {
        const queue = new OmpInputQueue(() => 'original-mode-hash');
        const consumed = vi.fn();
        queue.onBatchConsumed = consumed;
        const attachments = [{ id: 'image', filename: 'image.png', mimeType: 'image/png', size: 4, path: '/tmp/image.png' }];
        queue.push({ text: '/review identical', attachments, inputMode: 'follow_up', mode, localId: 'held' });
        queue.push({ text: '/review identical', attachments, inputMode: 'abort_and_prompt', mode, localId: 'queued' });
        queue.push({ text: '/review identical', inputMode: 'follow_up', mode, localId: 'untouched' });
        const held = queue.take()!;
        const queued = queue.queue[0]!;
        const untouched = queue.queue[1]!;
        const heldPayload = structuredClone(held);
        const queuedPayload = structuredClone(queued);

        expect(queue.markForced('held')).toBe(true);
        expect(queue.markForced('queued')).toBe(true);
        expect(queue.markForced('queued')).toBe(true);
        expect(queue.isForced(held)).toBe(true);
        expect(queue.isForced(queued)).toBe(true);
        expect(queue.isForced(untouched)).toBe(false);
        expect(held).toEqual(heldPayload);
        expect(queued).toEqual(queuedPayload);
        expect(queue.queue[0]).toBe(queued);
        expect(held.attachments).toBe(attachments);
        expect(queued.attachments).toBe(attachments);
        expect(queue.isHeld(held)).toBe(true);
        expect(queue.heldSize()).toBe(1);
        expect(queue.size()).toBe(2);
        expect(consumed).not.toHaveBeenCalled();

        queue.requeueHeld();
        expect(queue.queue.map(input => input.localId)).toEqual(['held', 'queued', 'untouched']);
        expect(queue.queue[0]).toEqual(heldPayload);
        expect(queue.isForced(queue.queue[0]!)).toBe(true);
        expect(queue.beginInvocation(queue.take()!)).toBe(true);
        expect(queue.isForced(held)).toBe(true);
        expect(consumed).not.toHaveBeenCalled();
    });

    it.each(['prompt', 'follow_up', 'steer', 'abort_and_prompt'] as const)(
        'keeps a persisted force mark separate from the original %s channel', (inputMode) => {
            const queue = new OmpInputQueue(() => 'mode');
            queue.push({ text: '/command original args', inputMode, mode, localId: 'persisted', forced: true });
            const input = queue.take()!;
            expect(queue.isForced(input)).toBe(true);
            expect(input).toMatchObject({ text: '/command original args', inputMode, localId: 'persisted', mode, modeHash: 'mode' });
            expect(queue.beginInvocation(input)).toBe(true);
            queue.releaseInvocation(input);
            expect(queue.markForced('persisted')).toBe(false);
        }
    );

    it('does not reserve force marks for unknown or already withdrawn identities', () => {
        const queue = new OmpInputQueue(() => 'mode');
        expect(queue.markForced('missing')).toBe(false);
        queue.push({ text: 'same', inputMode: 'follow_up', mode, localId: 'missing' });
        const input = queue.take()!;
        expect(queue.isForced(input)).toBe(false);
        expect(queue.cancelByLocalId('missing')).toBe(true);
        expect(queue.markForced('missing')).toBe(false);
        expect(queue.size()).toBe(0);
        expect(queue.heldSize()).toBe(0);
    });

    it('keeps launcher-held input cancelable until native invocation begins', () => {
        const queue = new OmpInputQueue(() => 'mode');
        const consumed = vi.fn();
        queue.onBatchConsumed = consumed;
        queue.push({ text: 'first', inputMode: 'follow_up', mode, localId: 'one' });
        queue.push({ text: 'second', inputMode: 'follow_up', mode, localId: 'two' });

        const first = queue.take();
        const second = queue.take();
        expect(first).not.toBeNull();
        expect(second).not.toBeNull();
        expect(queue.cancelByLocalId('two')).toBe(true);
        expect(queue.beginInvocation(first!)).toBe(true);
        expect(queue.cancelByLocalId('one')).toBe(false);
        expect(consumed).not.toHaveBeenCalled();

        queue.releaseInvocation(first!);
        expect(consumed).not.toHaveBeenCalled();
        expect(queue.heldSize()).toBe(0);
    });

    it('releases journal-owned queued input without claiming that it entered a native turn', () => {
        const queue = new OmpInputQueue(() => 'mode');
        const consumed = vi.fn();
        queue.onBatchConsumed = consumed;
        queue.push({ text: 'next turn', inputMode: 'follow_up', mode, localId: 'native-owned' });
        const input = queue.take()!;
        expect(queue.beginInvocation(input)).toBe(true);
        queue.releaseInvocation(input);
        expect(queue.heldSize()).toBe(0);
        expect(consumed).not.toHaveBeenCalled();
        queue.releaseInvocation(input);
        expect(consumed).not.toHaveBeenCalled();
    });

    it('removes every queued and held replay alias of one local message', () => {
        const queue = new OmpInputQueue(() => 'mode');
        for (let index = 0; index < 3; index++) queue.push({ text: 'same', inputMode: 'follow_up', mode, localId: 'one' });
        queue.push({ text: 'same', inputMode: 'follow_up', mode, localId: 'other' });
        queue.take();
        expect(queue.cancelByLocalId('one')).toBe(true);
        expect(queue.heldSize()).toBe(0);
        expect(queue.queue.map(input => input.localId)).toEqual(['other']);
    });

    it('does not claim cancellation from removing a replay alias while its original is invoking', () => {
        const queue = new OmpInputQueue(() => 'mode');
        queue.push({ text: 'same', inputMode: 'follow_up', mode, localId: 'one' });
        const original = queue.take()!;
        expect(queue.beginInvocation(original)).toBe(true);
        queue.push({ text: 'same', inputMode: 'follow_up', mode, localId: 'one' });
        expect(queue.cancelByLocalId('one')).toBe(false);
        expect(queue.queue).toEqual([]);
        expect(queue.heldSize()).toBe(1);
    });

    it('requeues cancelable launcher-held input in original order on handoff', () => {
        const queue = new OmpInputQueue(() => 'mode');
        queue.push({ text: 'one', inputMode: 'prompt', mode, localId: 'one' });
        queue.push({ text: 'two', inputMode: 'prompt', mode, localId: 'two' });
        queue.take();
        queue.take();

        queue.requeueHeld();

        expect(queue.queue.map((input) => input.localId)).toEqual(['one', 'two']);
        expect(queue.heldSize()).toBe(0);
    });
});
