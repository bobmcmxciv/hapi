import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { RPC_METHODS } from '@hapi/protocol/rpcMethods';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { Session } from './session';
import type { EnhancedMode } from './loop';

// Observed on four fleet machines (WIN-GVHSJ7B378A, Mac173Index.local,
// WudeMacBook-Air.local, FA608_INDEX). Real runner log, session 7477373c,
// spawned with `--model fable[1m]`, user then switched to opus[1m]:
//
//   [06:42:04.766] [remote]: mode has changed, pending message
//   [06:42:04.768] nextMessage resolved null fetchId=1; input ended
//   [06:42:05.798] response stream error {}
//   [06:42:05.801] [remote]: launch error {}
//   -> hub message: "Process exited unexpectedly: Claude Code process exited with code 1"
//
// Parking the message ends the SDK input stream on purpose so the next attempt
// can respawn under the new mode. Claude commonly exits non-zero when its stdin
// closes mid-session, so that throw is our own teardown -- not a crash the user
// can act on, and not something to alarm them with.
//
// The launcher takes ~6s to settle on this platform, past vitest's 5s default,
// so every test here carries an explicit timeout.
const TEST_TIMEOUT_MS = 20_000;
const claudeRemoteMock = vi.fn();

vi.mock('./claudeRemote', () => ({
    claudeRemote: (opts: unknown) => claudeRemoteMock(opts)
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        debugLargeJson: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
    }
}));

type RpcHandler = (params: unknown) => Promise<unknown> | unknown;

function makeClient() {
    const handlers = new Map<string, RpcHandler>();
    let agentState: Record<string, unknown> = {};
    return {
        handlers,
        rpcHandlerManager: {
            registerHandler: vi.fn((method: string, handler: RpcHandler) => {
                handlers.set(method, handler);
            })
        },
        updateMetadata: vi.fn(),
        updateAgentState: vi.fn((handler: (state: any) => any) => {
            agentState = handler(agentState);
        }),
        sendSessionEvent: vi.fn(),
        sendClaudeSessionMessage: vi.fn(),
        sendAgentMessage: vi.fn(),
        keepAlive: vi.fn(),
        emitMessagesConsumed: vi.fn()
    };
}

function makeSession(queue: MessageQueue2<EnhancedMode>, client: ReturnType<typeof makeClient>): Session {
    return new Session({
        api: {} as never,
        client: client as never,
        path: '/tmp/project',
        logPath: '/tmp/log',
        sessionId: null,
        mcpServers: {},
        messageQueue: queue,
        onModeChange: vi.fn(),
        mode: 'remote',
        startedBy: 'runner',
        startingMode: 'remote',
        hookSettingsPath: '/tmp/hooks.json'
    });
}

function triggerSwitch(client: ReturnType<typeof makeClient>): void {
    const handler = client.handlers.get(RPC_METHODS.Switch);
    void handler?.(undefined);
}

function sessionEventMessages(client: ReturnType<typeof makeClient>): string[] {
    return client.sendSessionEvent.mock.calls
        .map(([event]: any[]) => event?.message)
        .filter((message: unknown): message is string => typeof message === 'string');
}

describe('claudeRemoteLauncher mode-change respawn', () => {
    beforeEach(() => {
        claudeRemoteMock.mockReset();
        process.stdin.isTTY = false;
        process.stdout.isTTY = false;
        process.env.CLAUDE_REMOTE_RESPAWN_BACKOFF_MS = '0';
    });

    afterEach(() => {
        delete process.env.CLAUDE_REMOTE_RESPAWN_BACKOFF_MS;
    });

    it('does not report a crash when the process exits after input closed for a mode switch', async () => {
        const queue = new MessageQueue2<EnhancedMode>((mode) => JSON.stringify(mode));
        queue.push('first', { permissionMode: 'default', model: 'fable[1m]' });

        const client = makeClient();
        const session = makeSession(queue, client);

        let callCount = 0;
        let deliveredOnRespawn: string | undefined;

        claudeRemoteMock.mockImplementation(async (opts: any) => {
            callCount += 1;

            if (callCount === 1) {
                const initial = await opts.nextMessage();
                expect(initial?.message).toBe('first');
                opts.onReady();

                // User switches model in the web UI mid-session: same session,
                // different mode hash.
                queue.push('after switch', { permissionMode: 'default', model: 'opus[1m]' });

                // The launcher parks it and returns null -> claudeRemote ends
                // the input stream -> Claude exits non-zero.
                const parked = await opts.nextMessage();
                expect(parked).toBeNull();
                throw new Error('Claude Code process exited with code 1');
            }

            const resumed = await opts.nextMessage();
            deliveredOnRespawn = resumed?.message;
            triggerSwitch(client);
        });

        const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
        await claudeRemoteLauncher(session);

        expect(callCount).toBe(2);
        // The switched message must actually be delivered by the respawn.
        expect(deliveredOnRespawn).toBe('after switch');
        // ...and the user must not be told their session crashed.
        expect(sessionEventMessages(client).filter((m) => m.includes('Process exited unexpectedly'))).toEqual([]);
    }, TEST_TIMEOUT_MS);

    it('stays quiet and loses nothing across repeated back-to-back mode switches', async () => {
        // A user flipping model/effort several times in a row previously got a
        // "Process exited unexpectedly" banner per flip. Each turn must still
        // reach a respawned process, exactly once and in order.
        const queue = new MessageQueue2<EnhancedMode>((mode) => JSON.stringify(mode));
        queue.push('turn 0', { permissionMode: 'default', model: 'model-0' });

        const client = makeClient();
        const session = makeSession(queue, client);

        let callCount = 0;
        const SWITCHES = 4;
        const delivered: string[] = [];

        claudeRemoteMock.mockImplementation(async (opts: any) => {
            callCount += 1;
            const initial = await opts.nextMessage();
            if (initial) {
                delivered.push(initial.message as string);
            }

            if (callCount > SWITCHES) {
                triggerSwitch(client);
                return;
            }

            // Mirrors production ordering: claudeRemote fires onReady on each
            // result and only then schedules the next nextMessage(), so a park
            // is always preceded by onReady (claudeRemote.ts:328 vs :334).
            opts.onReady();
            queue.push(`turn ${callCount}`, { permissionMode: 'default', model: `model-${callCount}` });
            const parked = await opts.nextMessage();
            expect(parked).toBeNull();
            throw new Error('Claude Code process exited with code 1');
        });

        const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
        await claudeRemoteLauncher(session);

        const messages = sessionEventMessages(client);
        expect(messages.filter((m) => m.includes('Dropping the queued message'))).toEqual([]);
        expect(messages.filter((m) => m.includes('Process exited unexpectedly'))).toEqual([]);
        // Every switched turn was handed to a respawned process, in order and
        // without duplication.
        expect(delivered).toEqual(['turn 0', 'turn 1', 'turn 2', 'turn 3', 'turn 4']);
    }, TEST_TIMEOUT_MS);

    it('still reports genuine launch failures that are not a mode-change teardown', async () => {
        // Guard against over-suppression: the flag must be scoped to attempts
        // that actually parked a message.
        const queue = new MessageQueue2<EnhancedMode>((mode) => JSON.stringify(mode));
        queue.push('hello', { permissionMode: 'default' });

        const client = makeClient();
        const session = makeSession(queue, client);

        let callCount = 0;

        claudeRemoteMock.mockImplementation(async (opts: any) => {
            callCount += 1;
            if (callCount === 1) {
                await opts.nextMessage();
                throw new Error('Claude Code process exited with code 1: Invalid API key');
            }
            triggerSwitch(client);
            throw new Error('ending test');
        });

        const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
        await claudeRemoteLauncher(session);

        const reported = sessionEventMessages(client).filter((m) => m.includes('Process exited unexpectedly'));
        expect(reported.length).toBeGreaterThan(0);
        // The stderr tail added in query.ts is what makes this line actionable.
        expect(reported[0]).toContain('Invalid API key');
    }, TEST_TIMEOUT_MS);
});
