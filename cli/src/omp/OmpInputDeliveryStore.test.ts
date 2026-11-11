import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OmpInputDeliveryStore, OmpInputReceiptsUnsupportedError, OmpInputTokenConflictError, OmpUncertainDeliveryError, recoverOmpInputReceipts } from './OmpInputDeliveryStore';
import { parseOmpInboundLine, parseOmpResponseData } from './rpc/schemas';

describe('native journal receipt recovery', () => {
    let directory: string;
    let root: string;
    beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'hapi-durable-input-')); root = join(directory, 'runner-state'); });
    afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
    const open = (root: string) => new OmpInputDeliveryStore(root, 'original-hapi-id');

    it('recovers journal admission without consuming until committed native delivery', async () => {
        open(root).begin('stable-local-id', 'original-native-id', 'stable-local-id');
        const restored = open(root);
        const queries: string[][] = [];
        const consumed = await recoverOmpInputReceipts(restored, 'original-native-id', true, async tokens => {
            queries.push(tokens);
            return tokens.map(token => ({ token, sessionId: 'original-native-id', admitted: true, delivered: false }));
        });
        expect(queries).toEqual([['stable-local-id']]);
        expect(consumed).toEqual([]);
        expect(open(root).isAccepted('stable-local-id')).toBe(false);
        expect(open(root).isAdmitted('stable-local-id')).toBe(true);
        expect(open(root).pendingTokenReceipts()).toHaveLength(1);
        expect(await recoverOmpInputReceipts(open(root), 'original-native-id', true, async tokens => tokens.map(token => ({
            token, sessionId: 'original-native-id', admitted: true, delivered: true, entryId: 'native-user-entry', deliveredAt: '2026-11-07T01:00:00.000Z', deliveredOrder: 1
        })))).toEqual(['stable-local-id']);
        expect(open(root).isAccepted('stable-local-id')).toBe(true);
        expect(open(root).pendingTokenReceipts()).toEqual([]);
        // Reconnection repeats only the acknowledgment, never a native input command.
        expect(await recoverOmpInputReceipts(open(root), 'original-native-id', true, async () => { throw new Error('unexpected replay/query'); })).toEqual(['stable-local-id']);
    });

    it('permits retry only after native journal explicitly proves token absence', async () => {
        open(root).begin('not-admitted', 'native', 'not-admitted');
        expect(await recoverOmpInputReceipts(open(root), 'native', true, async tokens => tokens.map(token => ({ token, sessionId: 'native', admitted: false, delivered: false })))).toEqual([]);
        expect(() => open(root).begin('not-admitted', 'native', 'not-admitted')).not.toThrow();
    });

    it('quarantines ambiguous legacy delivery instead of matching identical text', async () => {
        open(root).begin('legacy', 'native');
        let queried = false;
        await expect(recoverOmpInputReceipts(open(root), 'native', true, async () => { queried = true; return []; })).rejects.toBeInstanceOf(OmpUncertainDeliveryError);
        expect(queried).toBe(false);
        expect(() => open(root).assertCanStart()).toThrow(OmpUncertainDeliveryError);
    });

    it('does not promote a legacy accepted sidecar into native user-turn proof', async () => {
        open(root).begin('legacy-accepted', 'native');
        const [sessionDirectory] = await readdir(`${root}.omp-input-receipts`);
        const directory = join(`${root}.omp-input-receipts`, sessionDirectory!);
        const [file] = await readdir(directory);
        const path = join(directory, file!);
        const legacy = JSON.parse(await readFile(path, 'utf8'));
        await writeFile(path, JSON.stringify({ ...legacy, status: 'accepted' }));
        const restored = open(root);
        expect(restored.acceptedLocalIds()).toEqual([]);
        await expect(recoverOmpInputReceipts(restored, 'native', true, async () => [])).rejects.toBeInstanceOf(OmpUncertainDeliveryError);
    });

    it('recovers acknowledged host session commands as handled without native delivery proof', async () => {
        const store = open(root);
        store.begin('rename-session', 'native');
        store.resolveHostInput('rename-session');
        const restored = open(root);
        expect(() => restored.assertCanStart()).not.toThrow();
        expect(restored.isAdmitted('rename-session')).toBe(true);
        expect(restored.isAccepted('rename-session')).toBe(false);
        expect(restored.isPendingNativeInput('rename-session')).toBe(false);
        expect(restored.resolvedInputs()).toEqual([{ localId: 'rename-session', outcome: 'handled' }]);
        expect(restored.nativeReceiptRecords()).toEqual([]);
        expect(await recoverOmpInputReceipts(restored, 'native', true, async () => { throw new Error('host command must not query or replay'); })).toEqual([]);
    });

    it('requires advertised native support rather than trusting the native version number', async () => {
        open(root).begin('token-aware-attempt', 'native', 'token-aware-attempt');
        await expect(recoverOmpInputReceipts(open(root), 'native', false, async () => [])).rejects.toBeInstanceOf(OmpInputReceiptsUnsupportedError);
        expect(open(root).pendingTokenReceipts()).toHaveLength(1);
    });

    it('does not transfer input ownership to a different native history', async () => {
        open(root).begin('message', 'original-native', 'message');
        let queried = false;
        await expect(recoverOmpInputReceipts(open(root), 'wrong-native', true, async () => { queried = true; return []; })).rejects.toBeInstanceOf(OmpUncertainDeliveryError);
        expect(queried).toBe(false);
        expect(open(root).isAccepted('message')).toBe(false);
    });

    it('retains uncertain input when a query is incomplete', async () => {
        open(root).begin('message', 'native', 'message');
        await expect(recoverOmpInputReceipts(open(root), 'native', true, async () => [])).rejects.toBeInstanceOf(OmpUncertainDeliveryError);
        expect(open(root).pendingTokenReceipts()).toHaveLength(1);
    });

    it('keeps receipts session-scoped even for identical local identifiers', async () => {
        open(root).begin('same', 'native', 'same');
        const other = new OmpInputDeliveryStore(root, 'other-hapi-id');
        expect(other.pendingTokenReceipts()).toEqual([]);
        other.begin('same', 'other-native', 'same');
        await recoverOmpInputReceipts(other, 'other-native', true, async tokens => tokens.map(token => ({ token, sessionId: 'other-native', admitted: true, delivered: true, entryId: 'other-user-entry', deliveredAt: '2026-11-07T01:00:00.000Z', deliveredOrder: 1 })));
        expect(open(root).isAccepted('same')).toBe(false);
        expect(other.isAccepted('same')).toBe(true);
    });

    it('retains explicit token conflicts as quarantine rather than consuming another payload receipt', async () => {
        const store = open(root);
        store.begin('message', 'native', 'message');
        store.quarantineConflict('message');
        expect(parseOmpInboundLine(JSON.stringify({ type: 'response', id: 'request', command: 'prompt', success: false, error: 'conflict', code: 'client_token_conflict' }))).toMatchObject({ kind: 'response', response: { code: 'client_token_conflict' } });
        const query = async () => [{ token: 'message', sessionId: 'native', admitted: true, delivered: true, entryId: 'native-entry', deliveredAt: '2026-11-07T01:00:00.000Z', deliveredOrder: 1 }];
        await expect(recoverOmpInputReceipts(open(root), 'native', true, query)).rejects.toBeInstanceOf(OmpInputTokenConflictError);
        expect(open(root).isAccepted('message')).toBe(false);
    });

    it('retains complete non-consumed terminal receipts across wrapper restart', async () => {
        for (const outcome of ['local', 'builtin-agent', 'cancelled'] as const) {
            const store = open(root);
            store.begin(outcome, 'native', outcome);
            const receipt = { token: outcome, sessionId: 'native', admitted: true, delivered: false, channel: 'prompt', outcome } as const;
            expect(store.recordNativeReceipt(receipt)).toBe(false);
            const restored = open(root);
            expect(restored.nativeReceiptRecords()).toContainEqual({ localId: outcome, receipt });
            expect(restored.isAdmitted(outcome)).toBe(true);
            expect(restored.isAccepted(outcome)).toBe(false);
            expect(restored.isPendingNativeInput(outcome)).toBe(false);
        }
        expect(open(root).acceptedLocalIds()).toEqual([]);
        expect(open(root).pendingTokenReceipts()).toEqual([]);
    });

    it('does not downgrade a durable terminal receipt when a delayed admission response arrives', () => {
        const store = open(root);
        store.begin('token', 'native', 'token');
        const admission = { token: 'token', sessionId: 'native', admitted: true, delivered: false };
        store.recordNativeReceipt({ ...admission, outcome: 'cancelled' });
        expect(store.recordNativeReceipt(admission)).toBe(false);
        expect(open(root).nativeReceipt('token')).toMatchObject({ outcome: 'cancelled', delivered: false });
        expect(open(root).pendingTokenReceipts()).toEqual([]);
        expect(open(root).acceptedLocalIds()).toEqual([]);
    });

    it('rejects mismatched-native and missing-message-entry delivery proofs', async () => {
        open(root).begin('message', 'native', 'message');
        for (const proof of [
            { token: 'message', sessionId: 'wrong-native', admitted: true, delivered: true, entryId: 'entry' },
            { token: 'message', sessionId: 'native', admitted: true, delivered: true },
            { token: 'message', sessionId: 'native', admitted: true, delivered: true, entryId: 'entry' },
            { token: 'message', sessionId: 'native', admitted: true, delivered: true, entryId: 'entry', deliveredAt: 'not-a-date', deliveredOrder: 1 },
            { token: 'message', sessionId: 'native', admitted: true, delivered: true, entryId: 'entry', deliveredAt: '2026-11-07T01:00:00.000Z' }
        ]) {
            await expect(recoverOmpInputReceipts(open(root), 'native', true, async () => [proof])).rejects.toBeInstanceOf(OmpUncertainDeliveryError);
            expect(open(root).isAccepted('message')).toBe(false);
        }
    });

    it('preserves queryable and echoed consumer receipts through the RPC decoder', () => {
        const receipt = { token: 'local', sessionId: 'native', admitted: true, delivered: true, channel: 'steer', admittedAt: '2026-11-07T00:00:00Z', entryId: 'entry', deliveredAt: '2026-11-07T01:00:00.000Z', deliveredOrder: 3, nativeOrder: { sessionId: 'native', entryId: 'entry', entryOrder: 3, eventOrder: 0 } } as const;
        expect(parseOmpResponseData('get_input_receipts', { receipts: [receipt] })).toEqual({ receipts: [receipt] });
        expect(parseOmpResponseData('recover_inputs', { receipts: [receipt] })).toEqual({ receipts: [receipt] });
        for (const command of ['prompt', 'steer', 'follow_up', 'abort_and_prompt'] as const) {
            expect(parseOmpResponseData(command, { receipt })).toEqual({ receipt });
        }
        expect(parseOmpResponseData('prompt', undefined)).toBeUndefined();
        expect(parseOmpResponseData('steer', undefined)).toBeUndefined();
    });
    it('reconciles an older accepted sidecar instead of consuming it without complete native provenance', async () => {
        const store = open(root);
        store.begin('old-delivered', 'native', 'old-delivered');
        const [sessionDirectory] = await readdir(`${root}.omp-input-receipts`);
        const receiptDirectory = join(`${root}.omp-input-receipts`, sessionDirectory!);
        const [file] = await readdir(receiptDirectory);
        const path = join(receiptDirectory, file!);
        const previous = JSON.parse(await readFile(path, 'utf8'));
        const proof = { token: 'old-delivered', sessionId: 'native', admitted: true, delivered: true, entryId: 'committed-user' };
        await writeFile(path, JSON.stringify({ ...previous, status: 'accepted', nativeReceipt: proof }));
        expect(open(root).acceptedLocalIds()).toEqual([]);
        expect(open(root).pendingTokenReceipts()).toHaveLength(1);
        const recovered = { ...proof, deliveredAt: '2026-11-07T01:00:00.000Z', deliveredOrder: 7 };
        expect(await recoverOmpInputReceipts(open(root), 'native', true, async () => [recovered])).toEqual(['old-delivered']);
        expect(open(root).nativeReceipt('old-delivered')).toEqual(recovered);
    });

    it('retains committed non-invocation ordering separately from delivery', () => {
        const store = open(root);
        store.begin('handled', 'native', 'handled');
        const nativeOrder = { sessionId: 'native', entryId: 'resolution', entryOrder: 8, eventOrder: 0 };
        store.recordNativeReceipt({ token: 'handled', sessionId: 'native', admitted: true, delivered: false, outcome: 'local', nativeOrder });
        expect(open(root).resolvedInputs()).toEqual([{ localId: 'handled', outcome: 'handled', nativeOrder }]);
        expect(open(root).acceptedLocalIds()).toEqual([]);
        expect(open(root).isPendingNativeInput('handled')).toBe(false);
    });
});
