import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OmpInputQueue } from './OmpInputQueue';
import { OmpSession, type OmpShutdownReceipt } from './session';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OmpInputDeliveryStore } from './OmpInputDeliveryStore';

const config = vi.hoisted(() => ({ runnerStateFile: '' }));
vi.mock('@/configuration', () => ({ configuration: config }));
vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        warn: vi.fn(),
        info: vi.fn()
    }
}));
let receiptRoot: string;
beforeEach(async () => {
    receiptRoot = await mkdtemp(join(tmpdir(), 'hapi-session-receipts-'));
    config.runnerStateFile = join(receiptRoot, 'runner-state');
});
afterEach(async () => { await rm(receiptRoot, { recursive: true, force: true }); });

function createSession() {
    const updateMetadata = vi.fn();
    const client = {
        sessionId: 'test-hapi-session',
        keepAlive: vi.fn(),
        updateMetadata,
        sendAgentMessage: vi.fn(),
        sendUserMessage: vi.fn(),
        sendSessionEvent: vi.fn(),
        emitMessagesConsumed: vi.fn()
    };
    const session = new OmpSession({
        api: {} as never,
        client: client as never,
        path: '/work',
        logPath: '/logs/omp.log',
        sessionId: 'requested-resume-id',
        messageQueue: new OmpInputQueue(() => 'mode'),
        onModeChange: () => undefined,
        startedBy: 'runner',
        startingMode: 'remote'
    });
    return { session, updateMetadata };
}

describe('OmpSession queued input cancellation', () => {
    it('tries the launcher-held queue first and awaits native token cancellation after admission', async () => {
        const { session } = createSession();
        const completion = Promise.withResolvers<boolean>();
        const cancel = vi.fn(() => completion.promise);
        const unregister = session.registerNativeInputCanceller(cancel);
        try {
            session.queue.push({ text: 'local pending', inputMode: 'follow_up', mode: { permissionMode: 'default' }, localId: 'local' });
            expect(await session.cancelQueuedInput('local')).toBe(true);
            expect(cancel).not.toHaveBeenCalled();
            const result = session.cancelQueuedInput('native');
            expect(cancel).toHaveBeenCalledWith('native');
            completion.resolve(true);
            expect(await result).toBe(true);
            unregister();
            expect(await session.cancelQueuedInput('unknown')).toBe(false);
        } finally {
            session.stopKeepAlive();
        }
    });

    it('loads persisted attempts before cancelling a replay from a lazily initialized session', async () => {
        const persisted = new OmpInputDeliveryStore(config.runnerStateFile, 'test-hapi-session');
        persisted.begin('replayed', 'native-original', 'replayed');
        const { session } = createSession();
        const cancelled = Promise.withResolvers<boolean>();
        const native = vi.fn(() => cancelled.promise);
        session.registerNativeInputCanceller(native);
        try {
            session.queue.push({ text: 'same text replay', inputMode: 'follow_up', mode: { permissionMode: 'default' }, localId: 'replayed' });
            const cancellation = session.cancelQueuedInput('replayed');
            expect(native).toHaveBeenCalledWith('replayed');
            cancelled.resolve(false);
            expect(await cancellation).toBe(false);
            expect(persisted.hasNativeAttempt('replayed')).toBe(true);
        } finally {
            session.stopKeepAlive();
        }
    });
});

describe('OmpSession native shutdown ownership', () => {
    it('waits for the active local owner and deduplicates concurrent shutdowns', async () => {
        const { session } = createSession();
        const exited = Promise.withResolvers<OmpShutdownReceipt>();
        const requestExit = vi.fn();
        session.registerShutdownHandle({ requestExit, waitForExit: () => exited.promise });
        try {
            const first = session.requestShutdown();
            const second = session.requestShutdown();
            expect(first).toBe(second);
            expect(requestExit).toHaveBeenCalledOnce();
            exited.resolve({ kind: 'omp-local', status: 'disposed', pid: 123, exitCode: 0, signal: null });
            expect(await first).toMatchObject({ kind: 'omp-local', status: 'disposed' });
        } finally {
            session.stopKeepAlive();
        }
    });

    it('does not mistake a completed unverified launcher for a never-started runtime', async () => {
        const { session } = createSession();
        session.recordShutdownReceipt({ kind: 'omp-local', status: 'unverified', pid: 123 });
        try {
            expect(await session.requestShutdown()).toMatchObject({ status: 'unverified' });
            session.recordShutdownReceipt({ kind: 'omp-local', status: 'disposed', pid: 123, exitCode: 0, signal: null });
            expect(await session.requestShutdown()).toMatchObject({ status: 'disposed' });
        } finally {
            session.stopKeepAlive();
        }
    });

    it('retains an active handle receipt after the handle is unregistered', async () => {
        const { session } = createSession();
        const unregister = session.registerShutdownHandle({
            requestExit: () => undefined,
            waitForExit: async () => ({ kind: 'omp-rpc', status: 'unverified', pid: 456 })
        });
        try {
            expect((await session.requestShutdown()).status).toBe('unverified');
            unregister();
            expect(await session.requestShutdown()).toMatchObject({ status: 'unverified', pid: 456 });
        } finally {
            session.stopKeepAlive();
        }
    });
});

describe('OmpSession native snapshot metadata', () => {
    it('does not persist the requested resume id before native validation', () => {
        const { session, updateMetadata } = createSession();
        try {
            expect(session.sessionId).toBe('requested-resume-id');
            expect(updateMetadata).not.toHaveBeenCalled();
        } finally {
            session.stopKeepAlive();
        }
    });

    it('writes id, file, and name atomically after get_state validation', () => {
        const { session, updateMetadata } = createSession();
        try {
            session.applyNativeSessionSnapshot({
                id: 'validated-id',
                file: '/sessions/validated-id.jsonl',
                name: 'Validated title'
            });

            expect(session.sessionId).toBe('validated-id');
            expect(session.getNativeSession()).toEqual({
                id: 'validated-id',
                file: '/sessions/validated-id.jsonl',
                name: 'Validated title'
            });
            expect(updateMetadata).toHaveBeenCalledOnce();
            const update = updateMetadata.mock.calls[0]?.[0] as (
                metadata: Record<string, unknown>
            ) => Record<string, unknown>;
            expect(update({ path: '/work', host: 'host' })).toEqual({
                path: '/work',
                host: 'host',
                name: 'Validated title',
                ompSession: {
                    id: 'validated-id',
                    file: '/sessions/validated-id.jsonl',
                    name: 'Validated title'
                }
            });
        } finally {
            session.stopKeepAlive();
        }
    });

    it('clears the prior native title when a new snapshot is unnamed', () => {
        const { session, updateMetadata } = createSession();
        try {
            session.applyNativeSessionSnapshot({
                id: 'new-session-id',
                file: '/sessions/new-session-id.jsonl'
            });

            const update = updateMetadata.mock.calls[0]?.[0] as (
                metadata: Record<string, unknown>
            ) => Record<string, unknown>;
            expect(update({
                path: '/work',
                host: 'host',
                name: 'Previous native title',
                ompSession: {
                    id: 'old-session-id',
                    file: '/sessions/old-session-id.jsonl',
                    name: 'Previous native title'
                }
            })).toEqual({
                path: '/work',
                host: 'host',
                ompSession: {
                    id: 'new-session-id',
                    file: '/sessions/new-session-id.jsonl'
                }
            });
        } finally {
            session.stopKeepAlive();
        }
    });

    it('preserves a Hub-renamed or digest-updated title when the same native session reconciles with an unchanged native name', () => {
        const { session, updateMetadata } = createSession();
        try {
            session.applyNativeSessionSnapshot({
                id: 'same-session-id',
                file: '/sessions/same-session-id.jsonl',
                name: 'Initial turn-1 title'
            });

            const update = updateMetadata.mock.calls[0]?.[0] as (
                metadata: Record<string, unknown>
            ) => Record<string, unknown>;
            expect(update({
                path: '/work',
                host: 'host',
                name: 'Digest updated title',
                ompSession: {
                    id: 'same-session-id',
                    file: '/sessions/same-session-id.jsonl',
                    name: 'Initial turn-1 title'
                }
            })).toEqual({
                path: '/work',
                host: 'host',
                name: 'Digest updated title',
                ompSession: {
                    id: 'same-session-id',
                    file: '/sessions/same-session-id.jsonl',
                    name: 'Initial turn-1 title'
                }
            });
        } finally {
            session.stopKeepAlive();
        }
    });

    it('never downgrades persisted same-ID native history through a sync reconciliation', () => {
        const { session } = createSession();
        try {
            session.applyNativeSessionSnapshot({ id: 'native-id', file: '/native.jsonl', persistence: 'persisted' });
            session.applyNativeSessionSnapshot({ id: 'native-id', file: '/native.jsonl', persistence: 'never-persisted' });
            expect(session.getNativeSession()?.persistence).toBe('persisted');
            session.applyNativeSessionSnapshot({ id: 'new-id', file: '/new.jsonl' });
            expect(session.getNativeSession()?.persistence).toBeUndefined();
        } finally {
            session.stopKeepAlive();
        }
    });

    it('persists effective, configured, and resolved OMP thinking independently', () => {
        const { session, updateMetadata } = createSession();
        try {
            session.updateThinkingState({
                thinkingLevel: 'high',
                configured: 'auto',
                resolved: 'high'
            });
            const update = updateMetadata.mock.calls[0]?.[0] as (
                metadata: Record<string, unknown>
            ) => Record<string, unknown>;
            expect(update({ path: '/work', host: 'host' })).toEqual({
                path: '/work',
                host: 'host',
                ompThinking: {
                    thinkingLevel: 'high',
                    configured: 'auto',
                    resolved: 'high'
                }
            });
        } finally {
            session.stopKeepAlive();
        }
    });
});
