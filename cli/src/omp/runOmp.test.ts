import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OmpShutdownReceipt } from './session';

const harness = vi.hoisted(() => ({
    loopArgs: [] as Array<Record<string, unknown>>,
    loopError: null as Error | null,
    metadata: { path: '/work', host: 'host' } as Record<string, unknown>,
    sessionInfo: { model: null, effort: null } as { model: string | null; effort: string | null },
    resumeResult: { kind: 'resume', sessionFile: '/sessions/native-id.jsonl' } as { kind: 'resume'; sessionFile: string } | { kind: 'empty' },
    session: {
        sessionId: 'hapi-session-id',
        onUserMessage: vi.fn(),
        onCancelQueuedMessage: vi.fn(),
        onForceQueuedMessages: vi.fn(),
        consumeForceMark: vi.fn(() => false),
        updateAgentState: vi.fn(),
        sendSessionEvent: vi.fn(),
        rpcHandlerManager: { registerHandler: vi.fn() }
    },
    wrapper: {
        setPermissionMode: vi.fn(),
        setModel: vi.fn(),
        setEffort: vi.fn(),
        applyRuntimeConfig: vi.fn(),
        getModel: vi.fn(() => undefined as string | undefined),
        getEffort: vi.fn(() => undefined as string | undefined),
        pushKeepAlive: vi.fn(),
        stopKeepAlive: vi.fn(),
        isShutdownRequested: vi.fn(() => false),
        requestShutdown: vi.fn(async (): Promise<OmpShutdownReceipt> => ({ kind: 'omp-rpc', status: 'not-started' })),
        localLaunchFailure: null
    }
}));

vi.mock('@/agent/sessionFactory', () => ({
    bootstrapSession: vi.fn(async () => ({
        api: {},
        session: harness.session,
        metadata: harness.metadata
    })),
    bootstrapExistingSession: vi.fn(async () => ({
        api: {},
        session: harness.session,
        metadata: harness.metadata,
        sessionInfo: harness.sessionInfo,
    }))
}));

vi.mock('./loop', () => ({
    ompLoop: vi.fn(async (options: Record<string, unknown>) => {
        harness.loopArgs.push(options);
        const onSessionReady = options.onSessionReady as ((value: unknown) => void) | undefined;
        onSessionReady?.(harness.wrapper);
        if (harness.loopError) throw harness.loopError;
    })
}));

const lifecycle = vi.hoisted(() => ({
    options: null as null | Record<string, unknown>,
    registerProcessHandlers: vi.fn(),
    cleanupAndExit: vi.fn(async () => undefined),
    markCrash: vi.fn(),
    setExitCode: vi.fn(),
    setArchiveReason: vi.fn(),
    setSessionEndReason: vi.fn(),
    hasExplicitSessionEndReason: vi.fn(() => false)
}));

vi.mock('@/agent/runnerLifecycle', () => ({
    createRunnerLifecycle: vi.fn((options: Record<string, unknown>) => {
        lifecycle.options = options;
        return lifecycle;
    }),
    createModeChangeHandler: vi.fn(() => vi.fn()),
    setControlledByUser: vi.fn()
}));

const registerKillSessionHandler = vi.hoisted(() => vi.fn());
vi.mock('@/claude/registerKillSessionHandler', () => ({ registerKillSessionHandler }));
vi.mock('@/agent/localHandoff', () => ({ registerLocalHandoffHandler: vi.fn() }));
vi.mock('@/ui/logger', () => ({
    logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), getLogPath: vi.fn(() => '/logs/omp.log') }
}));
vi.mock('@/utils/invokedCwd', () => ({ getInvokedCwd: vi.fn(() => '/work') }));
vi.mock('./utils/ompUsageMonitor', () => ({
    createOmpUsageMonitor: vi.fn(() => ({ start: vi.fn(async () => undefined), cleanup: vi.fn(async () => undefined) })),
    ensureOmpUsageExtension: vi.fn(async () => undefined)
}));

const notifyRunnerSessionCleanupVerified = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@/runner/controlClient', () => ({ notifyRunnerSessionCleanupVerified }));
vi.mock('./utils/ompSessionScanner', () => ({
    prepareOmpSessionResume: vi.fn(async () => harness.resumeResult)
}));

import { runOmp } from './runOmp';
import type { OmpInputQueue } from './OmpInputQueue';

describe('runOmp lifecycle', () => {
    beforeEach(() => {
        harness.loopArgs.length = 0;
        harness.loopError = null;
        harness.metadata = { path: '/work', host: 'host' };
        harness.sessionInfo = { model: null, effort: null };
        harness.resumeResult = { kind: 'resume', sessionFile: '/sessions/native-id.jsonl' };
        harness.wrapper.getModel.mockReturnValue(undefined);
        harness.wrapper.getEffort.mockReturnValue(undefined);
        harness.session.onUserMessage.mockReset();
        harness.session.onCancelQueuedMessage.mockReset();
        harness.session.onForceQueuedMessages.mockReset();
        harness.session.consumeForceMark.mockReset();
        harness.session.updateAgentState.mockReset();
        harness.session.sendSessionEvent.mockReset();
        harness.session.rpcHandlerManager.registerHandler.mockReset();
        harness.wrapper.setPermissionMode.mockReset();
        harness.wrapper.setModel.mockReset();
        harness.wrapper.setEffort.mockReset();
        harness.wrapper.applyRuntimeConfig.mockReset();
        registerKillSessionHandler.mockReset();
        lifecycle.registerProcessHandlers.mockReset();
        lifecycle.cleanupAndExit.mockReset();
        lifecycle.cleanupAndExit.mockResolvedValue(undefined);
        lifecycle.markCrash.mockReset();
        lifecycle.setExitCode.mockReset();
        lifecycle.setArchiveReason.mockReset();
        lifecycle.setSessionEndReason.mockReset();
        lifecycle.options = null;
        notifyRunnerSessionCleanupVerified.mockClear();
        harness.wrapper.requestShutdown.mockReset();
        harness.wrapper.requestShutdown.mockResolvedValue({ kind: 'omp-rpc', status: 'not-started' });
    });

    it('forces a runner-owned launch away from terminal local mode', async () => {
        await runOmp({ startedBy: 'runner', startingMode: 'local', workingDirectory: '/work' });
        expect(harness.loopArgs[0]?.startingMode).toBe('remote');
    });

    it('registers the full lifecycle so user kill is classified as terminated', async () => {
        await runOmp({ startedBy: 'runner', startingMode: 'remote', workingDirectory: '/work' });
        expect(registerKillSessionHandler).toHaveBeenCalledWith(
            harness.session.rpcHandlerManager,
            lifecycle
        );
    });

    it('passes an existing snapshot only when it matches the requested native id', async () => {
        harness.metadata = {
            path: '/work',
            host: 'host',
            ompSession: { id: 'native-id', file: '/sessions/native-id.jsonl' }
        };
        await runOmp({
            existingSessionId: 'hapi-id',
            resumeSessionId: 'native-id',
            workingDirectory: '/work',
            startingMode: 'remote'
        });
        expect(harness.loopArgs[0]?.nativeSession).toEqual({
            id: 'native-id',
            file: '/sessions/native-id.jsonl'
        });
    });

    it('restores an existing row native identity, model and configured auto when launch arguments are omitted', async () => {
        harness.metadata.ompSession = { id: 'native-id', file: '/sessions/native-id.jsonl' };
        harness.metadata.ompThinking = { configured: 'auto', thinkingLevel: 'high', resolved: 'high' };
        harness.sessionInfo = { model: 'provider/existing-model', effort: 'low' };
        await runOmp({ existingSessionId: 'hapi-id', startingMode: 'remote' });
        expect(harness.loopArgs[0]).toMatchObject({
            resumeSessionId: 'native-id', model: 'provider/existing-model', effort: 'auto'
        });
        const onMessage = harness.session.onUserMessage.mock.calls[0][0];
        onMessage({ content: { text: 'continue original work' } }, 'message-id');
        const queue = harness.loopArgs[0].messageQueue as OmpInputQueue;
        expect(queue.queue[0].mode).toMatchObject({ model: 'provider/existing-model', effort: 'auto' });
    });

    it('does not override native resume defaults with machine environment defaults', async () => {
        vi.stubEnv('OMP_MODEL', 'machine/default');
        try {
            await runOmp({ existingSessionId: 'hapi-id', startingMode: 'remote' });
            expect(harness.loopArgs[0].model).toBeUndefined();
            expect(harness.wrapper.setModel).toHaveBeenLastCalledWith(null);
        } finally {
            vi.unstubAllEnvs();
        }
    });

    it('uses explicit restore configuration over row selectors and rejects invalid persisted effort honestly', async () => {
        harness.sessionInfo = { model: 'old/model', effort: 'unsupported-effort' };
        harness.metadata.ompThinking = { configured: 'auto', thinkingLevel: 'high', resolved: 'high' };
        await runOmp({ existingSessionId: 'hapi-id', model: 'new/model', effort: 'low' });
        expect(harness.loopArgs[0]).toMatchObject({ model: 'new/model', effort: 'low' });
        harness.loopArgs.length = 0;
        delete harness.metadata.ompThinking;
        await runOmp({ existingSessionId: 'hapi-id' });
        expect(harness.loopArgs).toHaveLength(0);
        expect(lifecycle.markCrash).toHaveBeenCalledWith(expect.objectContaining({
            message: 'Invalid OMP thinking level: unsupported-effort'
        }));
        expect(lifecycle.cleanupAndExit).toHaveBeenCalledTimes(2);
    });

    it('clears native resume only after explicit empty preflight while retaining the HAPI row', async () => {
        harness.metadata.ompSession = { id: 'empty-id', file: '/sessions/empty-id.jsonl', persistence: 'never-persisted' };
        harness.resumeResult = { kind: 'empty' };
        await runOmp({ existingSessionId: 'hapi-id', startingMode: 'remote' });
        expect(harness.loopArgs[0].session).toBe(harness.session);
        expect(harness.loopArgs[0].resumeSessionId).toBeUndefined();
        expect(harness.loopArgs[0].nativeSession).toBeUndefined();
    });

    it('rejects native identity mismatch without starting the loop', async () => {
        harness.metadata.ompSession = { id: 'original-id', file: '/sessions/original.jsonl' };
        await runOmp({ existingSessionId: 'hapi-id', resumeSessionId: 'different-id' });
        expect(harness.loopArgs).toHaveLength(0);
        expect(lifecycle.markCrash).toHaveBeenCalledWith(expect.objectContaining({
            message: 'Requested OMP native session does not match the existing HAPI row'
        }));
    });

    it('uses native-confirmed model and configured effort for subsequent queued input', async () => {
        await runOmp({ startingMode: 'remote' });
        harness.wrapper.getModel.mockReturnValue('native/changed-model');
        harness.wrapper.getEffort.mockReturnValue('auto');
        harness.session.onUserMessage.mock.calls[0][0]({ content: { text: 'next' } }, 'next-id');
        const queue = harness.loopArgs[0].messageQueue as OmpInputQueue;
        expect(queue.queue[0].mode).toMatchObject({ model: 'native/changed-model', effort: 'auto' });
    });

    it('isolates every user message so HAPI turns stay aligned with native branch entries', async () => {
        await runOmp({ startingMode: 'remote', workingDirectory: '/work' });
        const onUserMessage = harness.session.onUserMessage.mock.calls[0]?.[0] as (
            message: { content: { text: string } },
            localId: string
        ) => void;
        onUserMessage({ content: { text: '/clear' } }, 'clear-id');
        onUserMessage({ content: { text: '/handoff focus' } }, 'handoff-id');
        onUserMessage({ content: { text: '/resume native-id' } }, 'resume-id');
        onUserMessage({ content: { text: 'next prompt' } }, 'prompt-id');

        const queue = harness.loopArgs[0]?.messageQueue as OmpInputQueue;
        expect(queue.queue.map(({ text, inputMode, localId }) => ({ text, inputMode, localId }))).toEqual([
            { text: '/clear', inputMode: 'prompt', localId: 'clear-id' },
            { text: '/handoff focus', inputMode: 'prompt', localId: 'handoff-id' },
            { text: '/resume native-id', inputMode: 'prompt', localId: 'resume-id' },
            { text: 'next prompt', inputMode: 'prompt', localId: 'prompt-id' }
        ]);
    });

    it('retains native attachment metadata and explicit OMP input command type', async () => {
        await runOmp({ startingMode: 'remote', workingDirectory: '/work' });
        const onUserMessage = harness.session.onUserMessage.mock.calls[0]?.[0] as (
            message: {
                content: { text: string; attachments: Array<Record<string, unknown>> };
                meta?: { ompInputMode?: 'steer' };
            },
            localId: string
        ) => void;
        const attachment = {
            id: 'image-1',
            filename: 'image.png',
            mimeType: 'image/png',
            size: 12,
            path: '/uploads/image.png'
        };
        onUserMessage({
            content: { text: 'look here', attachments: [attachment] },
            meta: { ompInputMode: 'steer' }
        }, 'steer-id');

        const queue = harness.loopArgs[0]?.messageQueue as OmpInputQueue;
        expect(queue.queue[0]).toEqual(expect.objectContaining({
            text: 'look here',
            attachments: [attachment],
            inputMode: 'steer',
            localId: 'steer-id'
        }));
    });

    it('reports an explicit error and classifies a native crash separately from user termination', async () => {
        harness.loopError = new Error('native process crashed');
        await runOmp({ startedBy: 'runner', startingMode: 'remote', workingDirectory: '/work' });
        expect(lifecycle.markCrash).toHaveBeenCalledWith(harness.loopError);
        expect(harness.session.sendSessionEvent).toHaveBeenCalledWith({
            type: 'message',
            message: 'OMP session failed: native process crashed'
        });
        expect(lifecycle.setSessionEndReason).not.toHaveBeenCalledWith('completed');
    });

    it('reports model and auto effort as applied only after the native launcher confirms them', async () => {
        harness.wrapper.applyRuntimeConfig.mockResolvedValue({
            model: 'mlx/qwen3:0.6b',
            effort: 'auto'
        });
        await runOmp({ startingMode: 'remote', workingDirectory: '/work' });
        const registration = harness.session.rpcHandlerManager.registerHandler.mock.calls.find(
            ([method]) => method === 'set-session-config'
        );
        const handler = registration?.[1] as ((payload: unknown) => Promise<unknown>) | undefined;
        expect(handler).toBeDefined();

        await expect(handler!({
            model: { provider: 'mlx', modelId: 'qwen3:0.6b' },
            effort: null
        })).resolves.toEqual({
            applied: {
                model: 'mlx/qwen3:0.6b',
                effort: 'auto'
            }
        });
        expect(harness.wrapper.applyRuntimeConfig).toHaveBeenCalledWith({
            model: 'mlx/qwen3:0.6b',
            effort: 'auto'
        });
        expect(harness.wrapper.setModel).toHaveBeenLastCalledWith('mlx/qwen3:0.6b');
        expect(harness.wrapper.setEffort).toHaveBeenLastCalledWith('auto');
    });

    it('gates the archive confirmation on the native disposal receipt and lets a retry converge', async () => {
        await runOmp({ startedBy: 'runner', startingMode: 'remote', workingDirectory: '/work' });
        const onShutdownRequest = lifecycle.options?.onShutdownRequest as (() => Promise<void>) | undefined;
        expect(onShutdownRequest).toBeDefined();

        // Native process may still be running → refuse the kill RPC success,
        // and the runner must not be told cleanup is verified.
        harness.wrapper.requestShutdown.mockResolvedValueOnce({ kind: 'omp-rpc', status: 'unverified' });
        await expect(onShutdownRequest!()).rejects.toThrow('OMP native cleanup was not confirmed');
        expect(notifyRunnerSessionCleanupVerified).not.toHaveBeenCalled();

        // Retry once the receipt confirms clean EOF disposal (code 0, no
        // signal — see closeOwnedNativeClient): archive proceeds and the
        // durable cleanup proof is written exactly once.
        harness.wrapper.requestShutdown.mockResolvedValue({ kind: 'omp-rpc', status: 'disposed', exitCode: 0, signal: null });
        await onShutdownRequest!();
        expect(notifyRunnerSessionCleanupVerified).toHaveBeenCalledWith('hapi-session-id');

        // A native that never launched is equally safe to archive.
        harness.wrapper.requestShutdown.mockResolvedValue({ kind: 'omp-rpc', status: 'not-started' });
        await onShutdownRequest!();
        expect(notifyRunnerSessionCleanupVerified).toHaveBeenCalledTimes(2);
    });
});
