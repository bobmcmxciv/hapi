import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canConfirmSessionProcessStarted, classifySessionProcessOwnership, SessionCleanupReceiptStore, type SessionProcessOwnership } from './cleanupReceipt';

const ownership = (): SessionProcessOwnership => ({
    requestedSessionId: 'hapi-row',
    confirmedSessionId: 'hapi-row',
    pid: 123,
    processStartMarker: 'original-generation',
    requiresCleanupReceipt: true,
    cleanupVerified: false,
});

describe('durable native cleanup proof', () => {
    let directory: string;
    let stateFile: string;

    beforeEach(() => {
        directory = mkdtempSync(join(tmpdir(), 'hapi-cleanup-receipt-'));
        stateFile = join(directory, 'runner.state.json');
    });

    afterEach(() => rmSync(directory, { recursive: true, force: true }));

    it('recovers offline wrapper disposal before releasing its dead or reused PID', () => {
        const record = ownership();
        new SessionCleanupReceiptStore(stateFile).write({
            sessionId: record.requestedSessionId,
            pid: record.pid,
            processStartMarker: record.processStartMarker,
        });
        const recovered = new SessionCleanupReceiptStore(stateFile);
        const persistedFile = join(directory, 'processes.json');
        expect(recovered.recover(record, () => {
            writeFileSync(persistedFile, JSON.stringify(record));
            return true;
        })).toBe(true);
        const afterRestart: SessionProcessOwnership = JSON.parse(readFileSync(persistedFile, 'utf8'));
        expect(classifySessionProcessOwnership(afterRestart, false, null)).toBe('exited');
        expect(classifySessionProcessOwnership(afterRestart, true, 'replacement-generation')).toBe('exited');
        expect(recovered.has(record)).toBe(false);
    });

    it('retains the receipt and quarantine when persisting runner acknowledgement fails', () => {
        const record = ownership();
        const store = new SessionCleanupReceiptStore(stateFile);
        store.write({ sessionId: 'hapi-row', pid: 123, processStartMarker: 'original-generation' });
        expect(store.recover(record, () => false)).toBe(false);
        expect(record.cleanupVerified).toBe(false);
        expect(store.has(record)).toBe(true);
        expect(classifySessionProcessOwnership(record, false, null)).toBe('blocked');
        expect(new SessionCleanupReceiptStore(stateFile).recover(record, () => true)).toBe(true);
    });

    it('does not use old-generation or wrong-row proof for another native owner', () => {
        const store = new SessionCleanupReceiptStore(stateFile);
        store.write({ sessionId: 'hapi-row', pid: 123, processStartMarker: 'original-generation' });
        const nextGeneration = { ...ownership(), processStartMarker: 'replacement-generation' };
        const otherRow = { ...ownership(), requestedSessionId: 'other-row', confirmedSessionId: 'other-row' };
        expect(store.recover(nextGeneration, () => true)).toBe(false);
        expect(store.recover(otherRow, () => true)).toBe(false);
        expect(classifySessionProcessOwnership(nextGeneration, true, 'replacement-generation')).toBe('blocked');
        expect(classifySessionProcessOwnership(otherRow, false, null)).toBe('blocked');
    });

    it('fails closed for incomplete or corrupted proof', () => {
        const store = new SessionCleanupReceiptStore(stateFile);
        store.write({ sessionId: 'hapi-row', pid: 123, processStartMarker: 'original-generation' });
        const receiptPath = join(directory, readdirSync(directory)[0]!);
        writeFileSync(receiptPath, '{"pid":123}');
        expect(store.has(ownership())).toBe(false);
        writeFileSync(receiptPath, '{');
        expect(store.has(ownership())).toBe(false);
    });

    it('accepts durable attempt-scoped proof for an initially unprobeable dead wrapper, not another attempt', () => {
        const store = new SessionCleanupReceiptStore(stateFile);
        const record = { ...ownership(), processStartMarker: '', ompResumeAttemptId: 'attempt-1' };
        store.write({ sessionId: 'hapi-row', pid: 123, processStartMarker: 'original-generation', ompResumeAttemptId: 'attempt-1' });
        expect(store.has({ ...record, ompResumeAttemptId: 'attempt-2' })).toBe(false);
        expect(store.recover(record, () => true)).toBe(true);
        expect(classifySessionProcessOwnership(record, true, 'original-generation')).toBe('blocked');
        expect(classifySessionProcessOwnership(record, false, null)).toBe('exited');
    });

    it('admits late native startup only for the original row and live generation before disposal', () => {
        expect(canConfirmSessionProcessStarted(ownership(), 'hapi-row', 'original-generation')).toBe(true);
        expect(canConfirmSessionProcessStarted(ownership(), 'other-row', 'original-generation')).toBe(false);
        expect(canConfirmSessionProcessStarted(ownership(), 'hapi-row', 'replacement-generation')).toBe(false);
        expect(canConfirmSessionProcessStarted(ownership(), 'hapi-row', null)).toBe(false);
        expect(canConfirmSessionProcessStarted({ ...ownership(), cleanupVerified: true }, 'hapi-row', 'original-generation')).toBe(false);
        expect(canConfirmSessionProcessStarted({ ...ownership(), requiresCleanupReceipt: false }, 'new-legacy-row', 'original-generation')).toBe(true);
    });

    it('does not treat dead, stale, or unprobeable wrappers as native cleanup proof', () => {
        expect(classifySessionProcessOwnership(ownership(), false, null)).toBe('blocked');
        expect(classifySessionProcessOwnership(ownership(), true, 'replacement-generation')).toBe('blocked');
        const disposed = { ...ownership(), cleanupVerified: true };
        expect(classifySessionProcessOwnership(disposed, true, null)).toBe('blocked');
        expect(classifySessionProcessOwnership(disposed, true, 'original-generation')).toBe('running');
        expect(classifySessionProcessOwnership({ ...ownership(), requiresCleanupReceipt: false }, false, null)).toBe('exited');
    });
});
