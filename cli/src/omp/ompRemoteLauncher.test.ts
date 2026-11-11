import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { OmpInputDeliveryStore } from './OmpInputDeliveryStore';
import { OmpInputQueue } from './OmpInputQueue';
import type { OmpMode, PermissionMode } from './types';
import type {
    OmpCommand,
    OmpAvailableCommand,
    OmpInboundEvent,
    OmpInputReceipt,
    OmpModel,
    OmpOutboundControlFrame,
    OmpResponseDataByCommand,
    OmpSessionState,
    OmpSubagentSnapshot
} from './rpc/types';
import { parseOmpInboundLine } from './rpc/schemas';
import type { RawJSONLines } from '@/claude/types';
import type { AttachmentMetadata, OmpInputMode, OmpNativeSession } from '@hapi/protocol/types';
import type { ForceQueuedMessageAck } from '@hapi/protocol';
import type * as SessionLifecycle from './rpc/sessionLifecycle';
import { OmpRpcConnectionError, OmpRpcRequestError } from './rpc/OmpRpcTransport';
import * as OmpInputContent from './ompInputContent';

type RpcHandler = (params: unknown) => unknown;
type EventListener = (event: OmpInboundEvent) => void;
type ClosedListener = (reason: Error) => void;

function model(provider: string, id: string, name: string = id): OmpModel {
    return {
        id,
        name,
        api: 'openai-completions',
        provider,
        baseUrl: 'http://localhost',
        reasoning: true,
        input: ['text'],
        contextWindow: 128_000,
        maxTokens: 16_384,
        thinking: {
            mode: 'levels',
            efforts: ['low', 'high'],
            defaultLevel: 'high'
        },
        raw: {}
    };
}

function deliveryProof(entryId: string) {
    return { entryId, deliveredAt: '2026-11-07T01:00:00.000Z', deliveredOrder: 1 };
}

function state(currentModel: OmpModel | null): OmpSessionState {
    return {
        capabilities: { inputReceipts: true, nativeOrder: harness.nativeOrderCapability, queuePromotion: harness.queuePromotionCapability },
        ...(currentModel ? { model: currentModel } : {}),
        ...(harness.thinkingLevel ? { thinkingLevel: harness.thinkingLevel } : {}),
        isStreaming: harness.stateStreaming,
        isCompacting: false,
        steeringMode: 'all',
        followUpMode: 'all',
        interruptMode: 'immediate',
        sessionId: harness.sessionId,
        sessionFile: harness.sessionFile ?? `/sessions/${harness.sessionId}.jsonl`,
        ...(harness.sessionName ? { sessionName: harness.sessionName } : {}),
        autoCompactionEnabled: true,
        messageCount: 0,
        queuedMessageCount: harness.queuedMessageCount,
        todoPhases: [],
        dumpTools: harness.dumpTools,
        contextUsage: harness.contextUsage
    };
}

const harness = vi.hoisted(() => ({
    connectArgs: [] as unknown[],
    events: [] as string[],
    prompts: [] as string[],
    requests: [] as OmpCommand[],
    controlFrames: [] as OmpOutboundControlFrame[],
    eventListeners: [] as EventListener[],
    closedListeners: [] as ClosedListener[],
    close: vi.fn(async () => { }),
    exitInfo: null as { pid?: number; code: number | null; signal: string | null } | null,
    connectError: null as Error | null,
    requestError: null as null | ((command: OmpCommand) => Error | null),
    beforeRequest: null as null | ((command: OmpCommand) => Promise<void>),
    abortResponse: null as Promise<void> | null,
    autoFinishPrompt: true,
    receiptDelivered: true,
    promptResponse: { agentInvoked: true } as OmpResponseDataByCommand['prompt'],
    stateStreaming: false,
    queuedMessageCount: 0,
    recoveredReceipts: [] as OmpInputReceipt[],
    sessionFile: null as string | null,
    realPersistence: false,
    nativeOrderCapability: true as boolean | undefined,
    queuePromotionCapability: true as boolean | undefined,
    promotionResponse: null as OmpResponseDataByCommand['promote_queued_message'] | null,
    promotedTokens: new Set<string>(),
    currentModel: null as OmpModel | null,
    availableModels: [] as OmpModel[],
    availableCommands: [] as OmpAvailableCommand[],
    dumpTools: [{ name: 'read', description: 'Read files', parameters: {} }] as NonNullable<OmpSessionState['dumpTools']>,
    thinkingLevel: 'high' as import('./rpc/types').OmpThinkingLevel | undefined,
    configuredThinking: 'high' as import('./rpc/types').OmpConfiguredThinkingLevel | undefined,
    contextUsage: { tokens: 1_024, contextWindow: 128_000, percent: 0.8 },
    sessionId: 'omp-session-1',
    sessionName: 'OMP session one' as string | null,
    resumePaths: {} as Record<string, string>,
    resumeError: null as Error | null,
    subagents: [] as OmpSubagentSnapshot[],
    subagentMessages: {} as Record<string, OmpResponseDataByCommand['get_subagent_messages']>
    , nativeReceipts: new Map<string, OmpInputReceipt>()
}));

vi.mock('./rpc/OmpRpcClient', () => ({
    OmpRpcClient: {
        connect: vi.fn(async (args: unknown) => {
            harness.connectArgs.push(args);
            if (harness.connectError) {
                throw harness.connectError;
            }
            return {
                state: 'ready',
                discovery: {
                    version: '17.0.4',
                    state: state(harness.currentModel),
                    commands: harness.availableCommands,
                    models: harness.availableModels
                },
                request: vi.fn(async (command: OmpCommand) => {
                    harness.requests.push(command);
                    await harness.beforeRequest?.(command);
                    const failure = harness.requestError?.(command);
                    if (failure) {
                        throw failure;
                    }
                    switch (command.type) {
                        case 'recover_inputs':
                            return { receipts: harness.recoveredReceipts };
                        case 'get_input_receipts':
                            return { receipts: (command.tokens ?? []).map(token => harness.nativeReceipts.get(token) ?? { token, sessionId: harness.sessionId, admitted: false, delivered: false }) };
                        case 'remove_queued_message': {
                            const previous = harness.nativeReceipts.get(command.clientToken);
                            if (!previous || previous.delivered || previous.outcome !== undefined) return { removed: false };
                            harness.nativeReceipts.set(command.clientToken, { ...previous, outcome: 'cancelled' });
                            return { removed: true };
                        }
                        case 'promote_queued_message': {
                            if (harness.promotionResponse) return harness.promotionResponse;
                            const receipt = harness.nativeReceipts.get(command.clientToken);
                            if (!receipt || receipt.delivered || receipt.outcome !== undefined) {
                                return { promoted: false, results: [{ token: command.clientToken, status: 'not-found' }] };
                            }
                            const alreadyPriority = receipt.channel === 'steer' || harness.promotedTokens.has(command.clientToken);
                            harness.promotedTokens.add(command.clientToken);
                            return { promoted: !alreadyPriority, results: [{ token: command.clientToken, status: alreadyPriority ? 'already-priority' : 'promoted' }] };
                        }
                        case 'prompt':
                            harness.prompts.push(command.message);
                            harness.events.push(`prompt:${command.message}`);
                            if (harness.autoFinishPrompt) {
                                queueMicrotask(() => {
                                    for (const listener of harness.eventListeners) {
                                        const parsed = parseOmpInboundLine('{"type":"agent_end"}');
                                        if (parsed.kind === 'event') listener(parsed.event);
                                    }
                                });
                            }
                            if (command.clientToken) {
                                const receipt: OmpInputReceipt = { token: command.clientToken, sessionId: harness.sessionId, admitted: true, delivered: harness.receiptDelivered, channel: command.type, ...(harness.receiptDelivered ? deliveryProof(`entry-${command.clientToken}`) : {}) };
                                harness.nativeReceipts.set(command.clientToken, receipt);
                                return { ...harness.promptResponse, receipt };
                            }
                            return harness.promptResponse;
                        case 'steer':
                            harness.events.push(`steer:${command.message}`);
                            if (command.clientToken) {
                                const receipt: OmpInputReceipt = { token: command.clientToken, sessionId: harness.sessionId, admitted: true, delivered: harness.receiptDelivered, channel: command.type, ...(harness.receiptDelivered ? deliveryProof(`entry-${command.clientToken}`) : {}) };
                                harness.nativeReceipts.set(command.clientToken, receipt);
                                return { receipt };
                            }
                            return undefined;
                        case 'follow_up':
                            harness.events.push(`follow_up:${command.message}`);
                            if (command.clientToken) {
                                const receipt: OmpInputReceipt = { token: command.clientToken, sessionId: harness.sessionId, admitted: true, delivered: harness.receiptDelivered, channel: command.type, ...(harness.receiptDelivered ? deliveryProof(`entry-${command.clientToken}`) : {}) };
                                harness.nativeReceipts.set(command.clientToken, receipt);
                                return { receipt };
                            }
                            return undefined;
                        case 'abort_and_prompt':
                            harness.events.push(`abort_and_prompt:${command.message}`);
                            if (command.clientToken) {
                                const receipt: OmpInputReceipt = { token: command.clientToken, sessionId: harness.sessionId, admitted: true, delivered: harness.receiptDelivered, channel: command.type, ...(harness.receiptDelivered ? deliveryProof(`entry-${command.clientToken}`) : {}) };
                                harness.nativeReceipts.set(command.clientToken, receipt);
                                return { receipt };
                            }
                            return undefined;
                        case 'set_model': {
                            const next = harness.availableModels.find((candidate) => (
                                candidate.provider === command.provider && candidate.id === command.modelId
                            ));
                            if (!next) {
                                throw new Error(`missing fake model ${command.provider}/${command.modelId}`);
                            }
                            harness.events.push(`set_model:${command.provider}/${command.modelId}`);
                            harness.currentModel = next;
                            return next;
                        }
                        case 'cycle_model': {
                            const currentIndex = harness.currentModel
                                ? harness.availableModels.findIndex((candidate) => (
                                    candidate.provider === harness.currentModel?.provider
                                    && candidate.id === harness.currentModel.id
                                ))
                                : -1;
                            const next = harness.availableModels[(currentIndex + 1) % harness.availableModels.length];
                            if (!next) return null;
                            harness.currentModel = next;
                            harness.events.push(`cycle_model:${next.provider}/${next.id}`);
                            return { model: next, thinkingLevel: harness.thinkingLevel, isScoped: false };
                        }
                        case 'get_available_models':
                            return { models: harness.availableModels };
                        case 'set_thinking_level':
                            harness.thinkingLevel = command.level;
                            harness.configuredThinking = command.level;
                            harness.events.push(`set_thinking_level:${command.level}`);
                            return undefined;
                        case 'cycle_thinking_level': {
                            const levels = ['off', 'auto', 'low', 'high'] as const;
                            const index = harness.configuredThinking
                                ? levels.indexOf(harness.configuredThinking as typeof levels[number])
                                : -1;
                            const level = levels[(index + 1) % levels.length];
                            harness.configuredThinking = level;
                            harness.thinkingLevel = level === 'auto' ? 'medium' : level;
                            harness.events.push(`cycle_thinking_level:${level}`);
                            return { level };
                        }
                        case 'get_state':
                            return state(harness.currentModel);
                        case 'set_host_tools':
                            return { toolNames: command.tools.map((tool) => tool.name) };
                        case 'set_host_uri_schemes':
                            return { schemes: command.schemes.map((scheme) => scheme.scheme) };
                        case 'get_login_providers':
                            return { providers: [] };
                        case 'login':
                            return { providerId: command.providerId };
                        case 'set_subagent_subscription':
                            return { level: command.level };
                        case 'get_subagents':
                            return { subagents: harness.subagents };
                        case 'get_subagent_messages': {
                            const result = command.subagentId
                                ? harness.subagentMessages[command.subagentId]
                                : undefined;
                            if (!result) throw new Error(`missing fake subagent transcript ${command.subagentId ?? ''}`);
                            return result;
                        }
                        case 'new_session':
                            harness.sessionId = 'omp-session-2';
                            harness.sessionName = null;
                            return { cancelled: false } satisfies OmpResponseDataByCommand['new_session'];
                        case 'set_session_name':
                            harness.sessionName = command.name;
                            return undefined;
                        case 'switch_session':
                            harness.sessionId = 'omp-session-resumed';
                            harness.sessionName = 'Resumed OMP session';
                            return { cancelled: false } satisfies OmpResponseDataByCommand['switch_session'];
                        case 'handoff':
                            harness.sessionId = 'omp-session-handoff';
                            harness.sessionName = null;
                            return { savedPath: '/sessions/handoff.md' } satisfies OmpResponseDataByCommand['handoff'];
                        case 'abort':
                            harness.events.push('abort');
                            if (harness.abortResponse) {
                                await harness.abortResponse;
                            }
                            return undefined;
                        default:
                            throw new Error(`Unexpected launcher command: ${command.type}`);
                    }
                }),
                sendControlFrame: vi.fn(async (frame: OmpOutboundControlFrame) => {
                    harness.controlFrames.push(frame);
                }),
                onEvent(listener: EventListener) {
                    harness.eventListeners.push(listener);
                    return () => { };
                },
                onDiagnostic() {
                    return () => { };
                },
                onClosed(listener: ClosedListener) {
                    harness.closedListeners.push(listener);
                    return () => { };
                },
                close: harness.close,
                get exitInfo() { return harness.exitInfo; }
            };
        })
    }
}));

vi.mock('./utils/ompSessionScanner', () => ({
    prepareOmpSessionResume: vi.fn(async (id: string, native?: OmpNativeSession) => {
        if (harness.resumeError) throw harness.resumeError;
        return native?.persistence === 'never-persisted'
            ? { kind: 'empty' as const }
            : { kind: 'resume' as const, sessionFile: `/sessions/${id}.jsonl` };
    }),
    resolveOmpSessionPath: vi.fn(async (sessionArg: string) => harness.resumePaths[sessionArg] ?? null)
}));

vi.mock('./rpc/sessionLifecycle', async (importOriginal) => {
    const actual = await importOriginal<typeof SessionLifecycle>();
    return {
        ...actual,
        nativeSessionSnapshotWithPersistence: async (nativeState: OmpSessionState, previous?: OmpNativeSession | null) => harness.realPersistence
            ? actual.nativeSessionSnapshotWithPersistence(nativeState, previous)
            : actual.nativeSessionSnapshotFromState(nativeState)
    };
});

vi.mock('@/ui/ink/OmpDisplay', () => ({
    OmpDisplay: () => null
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        warn: vi.fn(),
        info: vi.fn()
    }
}));

import { ompRemoteLauncher } from './ompRemoteLauncher';

function createMode(modelId?: string): OmpMode {
    return {
        permissionMode: 'default' as PermissionMode,
        model: modelId
    };
}

function createResetMode(): OmpMode {
    return {
        permissionMode: 'default' as PermissionMode,
        model: null
    };
}

function createSessionStub(
    items: Array<{
        message: string;
        mode: OmpMode;
        inputMode?: OmpInputMode;
        attachments?: AttachmentMetadata[];
        localId?: string;
    }>,
    options: {
        launchModel?: string | null;
        launchEffort?: import('./rpc/types').OmpConfiguredThinkingLevel;
        sessionId?: string | null;
        closeQueue?: boolean;
        nativePersistence?: OmpNativeSession['persistence'];
    } = {}
) {
    const queue = new OmpInputQueue((mode) => JSON.stringify(mode));
    const receiptRoot = mkdtempSync(join(tmpdir(), 'hapi-omp-launcher-receipts-'));
    createdDirectories.push(receiptRoot);
    const inputDelivery = new OmpInputDeliveryStore(join(receiptRoot, 'runner-state'), 'test-hapi-session');
    items.forEach(({ message, mode, inputMode, attachments, localId }) => {
        queue.push({
            text: message,
            mode,
            inputMode: inputMode ?? 'prompt',
            attachments,
            localId
        });
    });
    if (options.closeQueue !== false) {
        queue.close();
    }

    const sessionEvents: Array<{ type: string;[key: string]: unknown }> = [];
    const snapshots: OmpNativeSession[] = [];
    let nativeSession: OmpNativeSession | null = options.sessionId
        ? { id: options.sessionId, file: `/sessions/${options.sessionId}.jsonl`, ...(options.nativePersistence ? { persistence: options.nativePersistence } : {}) }
        : null;
    let configuredModel = options.launchModel;
    const consumedLocalIds: string[][] = [];
    const deliveryCalls: Array<{ localIds: string[]; options: unknown }> = [];
    const publications: string[] = [];
    const agentMessages: unknown[] = [];
    const canonicalMessages: RawJSONLines[] = [];
    const thinkingStates: import('@hapi/protocol/omp').OmpThinkingState[] = [];
    const capabilityUpdates: Array<{ tools?: string[]; slashCommands?: string[] }> = [];
    let agentState: import('@/api/types').AgentState = {};
    const rpcHandlers = new Map<string, RpcHandler>();
    let runtimeConfigApplier: ((config: import('./session').OmpRuntimeConfigRequest) => Promise<import('./session').OmpRuntimeConfigApplied>) | null = null;
    let nativeInputCanceller: ((localId: string) => Promise<boolean>) | null = null;
    let nativeInputForcer: ((localId: string) => Promise<ForceQueuedMessageAck>) | null = null;
    let shutdownHandle: { requestExit: () => void | Promise<void>; waitForExit: () => Promise<unknown> } | null = null;
    const clientEvents = new EventEmitter();
    const client = {
        on: clientEvents.on.bind(clientEvents),
        off: clientEvents.off.bind(clientEvents),
        emit: clientEvents.emit.bind(clientEvents),
        sessionId: 'test-hapi-session',
        emitMessagesConsumed(localIds: string[], options?: unknown) {
            if (localIds.length > 0) { consumedLocalIds.push(localIds); deliveryCalls.push({ localIds, options }); publications.push(`consumed:${localIds.join(',')}`); }
        },
        sendMessagesResolved: vi.fn(),
        emitSessionReady: vi.fn(),
        clearSessionReady: vi.fn(),
        publishRuntime: vi.fn(),
        rpcHandlerManager: {
            registerHandler(method: string, handler: RpcHandler) {
                rpcHandlers.set(method, handler);
            }
        },
        sendAgentMessage(message: unknown) {
            agentMessages.push(message);
        },
        sendClaudeSessionMessage(message: RawJSONLines) {
            canonicalMessages.push(message);
            publications.push('canonical');
        },
        sendUserMessage(_text: string) { },
        sendSessionEvent(event: { type: string;[key: string]: unknown }) {
            sessionEvents.push(event);
        },
        updateAgentState(handler: (state: import('@/api/types').AgentState) => import('@/api/types').AgentState) {
            agentState = handler(agentState);
        }
    };

    const session = {
        getInputDeliveryStore: () => inputDelivery,
        registerNativeInputForcer(handler: (localId: string) => Promise<ForceQueuedMessageAck>) {
            nativeInputForcer = handler;
            return () => { if (nativeInputForcer === handler) nativeInputForcer = null; };
        },
        registerNativeInputCanceller(handler: (localId: string) => Promise<boolean>) {
            nativeInputCanceller = handler;
            return () => { if (nativeInputCanceller === handler) nativeInputCanceller = null; };
        },
        async cancelQueuedInput(localId: string) {
            const hasNativeAttempt = inputDelivery.hasNativeAttempt(localId);
            const removedLocally = queue.cancelByLocalId(localId);
            return (removedLocally && !hasNativeAttempt) || (nativeInputCanceller ? await nativeInputCanceller(localId) : false);
        },
        registerShutdownHandle: vi.fn((handle: { requestExit: () => void | Promise<void>; waitForExit: () => Promise<unknown> }) => {
            shutdownHandle = handle;
            return () => { if (shutdownHandle === handle) shutdownHandle = null; };
        }),
        recordShutdownReceipt: vi.fn(),
        isShutdownRequested: vi.fn(() => false),
        path: '/tmp/hapi-omp-test',
        logPath: '/tmp/hapi-omp-test/test.log',
        client,
        queue,
        sessionId: options.sessionId ?? null,
        thinking: false,
        getModel() {
            return configuredModel;
        },
        getEffort() {
            return options.launchEffort;
        },
        getPermissionMode() {
            return 'default' as const;
        },
        setModel(value: string | null) { configuredModel = value; },
        setEffort(_effort: import('./rpc/types').OmpConfiguredThinkingLevel) { },
        setRuntimeConfigApplier(applier: typeof runtimeConfigApplier) {
            runtimeConfigApplier = applier;
        },
        async applyRuntimeConfig(config: import('./session').OmpRuntimeConfigRequest) {
            if (!runtimeConfigApplier) throw new Error('runtime config applier unavailable');
            return await runtimeConfigApplier(config);
        },
        updateThinkingState(state: import('@hapi/protocol/omp').OmpThinkingState) {
            thinkingStates.push(state);
        },
        updateDiscoveredCapabilities(capabilities: { tools?: string[]; slashCommands?: string[] }) {
            capabilityUpdates.push(capabilities);
        },
        onThinkingChange(thinking: boolean) {
            session.thinking = thinking;
        },
        getNativeSession: () => nativeSession,
        applyNativeSessionSnapshot(snapshot: OmpNativeSession) {
            nativeSession = nativeSession?.id === snapshot.id && nativeSession.persistence === 'persisted'
                ? { ...snapshot, persistence: 'persisted' } : snapshot;
            snapshots.push(nativeSession);
            session.sessionId = snapshot.id;
        },
        sendAgentMessage(message: unknown) {
            agentMessages.push(message);
        },
        sendSessionEvent(event: { type: string;[key: string]: unknown }) {
            client.sendSessionEvent(event);
        },
        sendUserMessage(_text: string) { }
    };
    queue.onBatchConsumed = (localIds) => consumedLocalIds.push(localIds);

    return {
        session,
        sessionEvents,
        rpcHandlers,
        snapshots,
        consumedLocalIds,
        deliveryCalls,
        publications,
        agentMessages,
        canonicalMessages,
        thinkingStates,
        capabilityUpdates,
        getShutdownHandle: () => shutdownHandle,
        getAgentState: () => agentState,
        getNativeInputForcer: () => nativeInputForcer,
        getRuntimeConfigApplier: () => runtimeConfigApplier
    };
}

function resolvePendingNativeInputs(): void {
    for (const receipt of harness.nativeReceipts.values()) {
        if (receipt.delivered || receipt.outcome !== undefined) continue;
        const resolved = { ...receipt, outcome: 'cancelled' as const };
        harness.nativeReceipts.set(receipt.token, resolved);
        emitEvent('input_receipt', { receipt: resolved });
    }
}

async function waitForRequest(type: OmpCommand['type']): Promise<void> {
    await vi.waitFor(() => {
        expect(harness.requests.some((request) => request.type === type)).toBe(true);
    });
}

async function waitForRequestCount(type: OmpCommand['type'], count: number): Promise<void> {
    await vi.waitFor(() => {
        expect(harness.requests.filter((request) => request.type === type)).toHaveLength(count);
    });
}

function emitEvent(type: string, raw: Record<string, unknown> = {}): void {
    const parsed = parseOmpInboundLine(JSON.stringify({ type, ...raw }));
    if (parsed.kind !== 'event') throw new Error(`Expected OMP event, received ${parsed.kind}`);
    for (const listener of harness.eventListeners) {
        listener(parsed.event);
    }
}

const createdDirectories: string[] = [];

describe('ompRemoteLauncher RPC lifecycle', () => {
    afterEach(async () => {
        harness.connectArgs = [];
        harness.events = [];
        harness.prompts = [];
        harness.requests = [];
        harness.controlFrames = [];
        harness.eventListeners = [];
        harness.closedListeners = [];
        harness.close.mockReset();
        harness.close.mockResolvedValue(undefined);
        harness.exitInfo = null;
        harness.connectError = null;
        harness.requestError = null;
        harness.beforeRequest = null;
        vi.unstubAllEnvs();
        harness.abortResponse = null;
        harness.autoFinishPrompt = true;
        harness.receiptDelivered = true;
        harness.promptResponse = { agentInvoked: true };
        harness.nativeReceipts.clear();
        harness.stateStreaming = false;
        harness.queuedMessageCount = 0;
        harness.recoveredReceipts = [];
        harness.sessionFile = null;
        harness.nativeOrderCapability = true;
        harness.queuePromotionCapability = true;
        harness.promotionResponse = null;
        harness.promotedTokens.clear();
        harness.realPersistence = false;
        harness.currentModel = model('ollama', 'launch-default', 'Launch default');
        harness.availableModels = [
            harness.currentModel,
            model('ollama', 'a', 'Model A'),
            model('ollama', 'b', 'Model B'),
            model('mlx', 'qwen3:0.6b', 'MLX Qwen3')
        ];
        harness.sessionId = 'omp-session-1';
        harness.sessionName = 'OMP session one';
        harness.resumeError = null;
        harness.thinkingLevel = 'high';
        harness.configuredThinking = 'high';
        harness.contextUsage = { tokens: 1_024, contextWindow: 128_000, percent: 0.8 };
        harness.resumePaths = {};
        harness.subagents = [];
        harness.subagentMessages = {};
        harness.availableCommands = [];
        harness.dumpTools = [{ name: 'read', description: 'Read files', parameters: {} }];
        await Promise.all(createdDirectories.splice(0).map((directory) => (
            rm(directory, { recursive: true, force: true })
        )));
    });

    it('connects through native RPC with launch model and resume session', async () => {
        harness.sessionId = 'resume-me';
        const { session, snapshots } = createSessionStub(
            [{ message: 'first', mode: createMode() }],
            { launchModel: 'ollama/a', sessionId: 'resume-me' }
        );

        await ompRemoteLauncher(session as never);

        expect(harness.connectArgs).toEqual([expect.objectContaining({
            cwd: '/tmp/hapi-omp-test',
            model: 'ollama/a',
            resumeSessionId: '/sessions/resume-me.jsonl',
            env: expect.objectContaining({ PI_RPC_EMIT_TITLE: '1' })
        })]);
        expect(session.sessionId).toBe('resume-me');
        expect(session.client.emitSessionReady).toHaveBeenCalledOnce();
        expect(snapshots[0]).toEqual({
            id: 'resume-me',
            file: '/sessions/resume-me.jsonl',
            name: 'OMP session one'
        });
        expect(harness.close).toHaveBeenCalledOnce();
    });

    it('syncs native tools, HAPI host tools, and dynamic commands into session metadata', async () => {
        harness.availableCommands = [{ name: 'review', description: 'Review changes', source: 'extension' }];
        const { session, capabilityUpdates } = createSessionStub([], { closeQueue: false });
        const launch = ompRemoteLauncher(session as never);
        await waitForRequest('get_subagents');

        emitEvent('available_commands_update', {
            commands: [{ name: 'inspect', description: 'Inspect state', source: 'extension' }]
        });
        harness.dumpTools = [{ name: 'read', description: 'Read files', parameters: {} }, {
            name: 'mcp__example_probe',
            description: 'MCP probe',
            parameters: {}
        }];
        emitEvent('session_info_update');
        await vi.waitFor(() => {
            expect(capabilityUpdates).toContainEqual({
                tools: [
                    'read',
                    'mcp__example_probe',
                    'change_title',
                    'display_image',
                    'display_video',
                    'send_file',
                    'skill_lookup'
                ]
            });
        });
        session.queue.close();
        await launch;

        expect(capabilityUpdates).toContainEqual({ tools: ['read'] });
        expect(capabilityUpdates).toContainEqual({
            tools: ['read', 'change_title', 'display_image', 'display_video', 'send_file', 'skill_lookup'],
            slashCommands: ['review']
        });
        expect(capabilityUpdates).toContainEqual({ slashCommands: ['inspect'] });
    });

    it('reconciles native session_info_update events through get_state', async () => {
        harness.autoFinishPrompt = false;
        const { session, snapshots } = createSessionStub([
            { message: 'wait for rename', mode: createMode() }
        ]);
        const launch = ompRemoteLauncher(session as never);
        await waitForRequest('prompt');

        emitEvent('session_info_update');
        await vi.waitFor(() => {
            expect(harness.requests.filter((request) => request.type === 'get_state').length).toBeGreaterThan(0);
            expect(snapshots.length).toBeGreaterThan(1);
        });
        emitEvent('agent_end');
        await launch;
    });

    it('reconciles state after every prompt without depending on session_info_update', async () => {
        const { session, snapshots } = createSessionStub([
            { message: 'ordinary turn', mode: createMode() }
        ]);

        await ompRemoteLauncher(session as never);

        expect(harness.requests.map((request) => request.type)).toEqual([
            'set_host_tools',
            'set_host_uri_schemes',
            'set_subagent_subscription',
            'get_subagents',
            'recover_inputs',
            'prompt',
            'get_state',
            'get_state',
            'get_state',
        ]);
        expect(snapshots).toHaveLength(3);
    });

    it('restores active subagents before transcript replay and deduplicates a repeated live message', async () => {
        const childMessage = {
            role: 'assistant',
            content: [{ type: 'text', text: 'restored child answer' }],
            provider: 'ollama',
            model: 'qwen3',
            responseId: 'child-response-1',
            usage: {
                input: 11,
                output: 7,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 18,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
            },
            stopReason: 'stop'
        };
        harness.subagents = [{
            id: 'child-1',
            index: 0,
            agent: 'task',
            agentSource: 'bundled',
            description: 'restored worker',
            status: 'running',
            sessionFile: '/sessions/child-1.jsonl',
            lastUpdate: 123456,
            parentToolCallId: 'parent-tool'
        }];
        harness.subagentMessages = {
            'child-1': {
                sessionFile: '/sessions/child-1.jsonl',
                fromByte: 0,
                nextByte: 256,
                reset: false,
                entries: [],
                messages: [{ role: 'assistant', raw: childMessage }]
            }
        };
        const { session, agentMessages } = createSessionStub([], { closeQueue: false });
        const launch = ompRemoteLauncher(session as never);

        await vi.waitFor(() => {
            expect(agentMessages).toContainEqual(expect.objectContaining({
                type: 'agent-run-trace',
                agentId: 'child-1',
                cardId: 'omp-subagent:child-1',
                parentToolCallId: 'parent-tool',
                message: expect.objectContaining({
                    type: 'message',
                    message: 'restored child answer'
                })
            }));
        });
        emitEvent('subagent_event', {
            payload: {
                id: 'child-1',
                event: { type: 'message_end', message: childMessage }
            }
        });
        emitEvent('subagent_lifecycle', {
            payload: {
                id: 'child-1',
                index: 0,
                agent: 'task',
                agentSource: 'bundled',
                description: 'restored worker',
                status: 'completed',
                parentToolCallId: 'parent-tool'
            }
        });

        const childStarts = agentMessages.filter((message) => (
            typeof message === 'object'
            && message !== null
            && 'type' in message
            && message.type === 'agent-run-start'
        ));
        const childTraces = agentMessages.filter((message) => (
            typeof message === 'object'
            && message !== null
            && 'type' in message
            && message.type === 'agent-run-trace'
        ));
        expect(childStarts).toHaveLength(1);
        expect(childTraces).toHaveLength(1);
        expect(harness.requests.filter((request) => (
            request.type === 'set_subagent_subscription'
            || request.type === 'get_subagents'
            || request.type === 'get_subagent_messages'
        ))).toEqual([
            { type: 'set_subagent_subscription', level: 'events' },
            { type: 'get_subagents' },
            { type: 'get_subagent_messages', subagentId: 'child-1', fromByte: 0 }
        ]);

        session.queue.close();
        await launch;
    });

    it('routes clear and rename through native mutations with immediate snapshots', async () => {
        const { session, snapshots } = createSessionStub([
            { message: '/rename Renamed session', mode: createMode() },
            { message: '/clear', mode: createMode() }
        ]);

        await ompRemoteLauncher(session as never);

        expect(harness.requests.filter((request) => (
            request.type === 'set_session_name' || request.type === 'new_session'
        ))).toEqual([
            { type: 'set_session_name', name: 'Renamed session' },
            { type: 'new_session' }
        ]);
        expect(harness.requests.some((request) => request.type === 'prompt')).toBe(false);
        expect(snapshots).toContainEqual(expect.objectContaining({
            id: 'omp-session-1',
            file: '/sessions/omp-session-1.jsonl',
            name: 'Renamed session'
        }));
        expect(snapshots).toContainEqual(expect.objectContaining({
            id: 'omp-session-2',
            file: '/sessions/omp-session-2.jsonl'
        }));
    });

    it('resolves acknowledged host commands as handled and replays only their resolution after reconnect', async () => {
        const { session, consumedLocalIds } = createSessionStub([
            { message: '/rename Host handled', mode: createMode(), localId: 'host-command' }
        ]);
        await ompRemoteLauncher(session as never);
        expect(session.client.sendMessagesResolved).toHaveBeenCalledWith([{ localId: 'host-command', outcome: 'handled' }]);
        expect(consumedLocalIds.flat()).toEqual([]);
        expect(session.getInputDeliveryStore().nativeReceiptRecords()).toEqual([]);
        const mutationCount = harness.requests.filter(request => request.type === 'set_session_name').length;
        session.client.sendMessagesResolved.mockClear();
        await ompRemoteLauncher(session as never);
        expect(harness.requests.filter(request => request.type === 'set_session_name')).toHaveLength(mutationCount);
        expect(session.client.sendMessagesResolved).toHaveBeenCalledWith([{ localId: 'host-command', outcome: 'handled' }]);
        expect(consumedLocalIds.flat()).toEqual([]);
    });

    it('does not consume invalid host commands or empty input that never entered native execution', async () => {
        const { session, consumedLocalIds, sessionEvents } = createSessionStub([
            { message: '/resume', mode: createMode(), localId: 'invalid-command' },
            { message: '   ', mode: createMode(), localId: 'empty-message' }
        ]);
        await ompRemoteLauncher(session as never);
        expect(harness.requests.some(request => request.type === 'prompt' || request.type === 'switch_session')).toBe(false);
        expect(consumedLocalIds.flat()).toEqual([]);
        expect(session.client.sendMessagesResolved.mock.calls.flatMap(([items]) => items)).toEqual([]);
        expect(sessionEvents).toContainEqual({ type: 'message', message: expect.stringContaining('no text or attachment') });
    });

    it('routes handoff and resume through native mutations with immediate snapshots', async () => {
        harness.resumePaths['native-prefix'] = '/sessions/native-target.jsonl';
        const { session, snapshots } = createSessionStub([
            { message: '/handoff focus on verification', mode: createMode() },
            { message: '/resume native-prefix', mode: createMode() }
        ]);

        await ompRemoteLauncher(session as never);

        expect(harness.requests.filter((request) => (
            request.type === 'handoff' || request.type === 'switch_session'
        ))).toEqual([
            { type: 'handoff', customInstructions: 'focus on verification' },
            { type: 'switch_session', sessionPath: '/sessions/native-target.jsonl' }
        ]);
        expect(harness.requests.some((request) => request.type === 'prompt')).toBe(false);
        expect(snapshots).toContainEqual(expect.objectContaining({
            id: 'omp-session-handoff',
            file: '/sessions/omp-session-handoff.jsonl'
        }));
        expect(snapshots).toContainEqual(expect.objectContaining({
            id: 'omp-session-resumed',
            file: '/sessions/omp-session-resumed.jsonl',
            name: 'Resumed OMP session'
        }));
    });

    it('reports remote resume picker and unknown session requests without prompting the model', async () => {
        const { session, sessionEvents } = createSessionStub([
            { message: '/resume', mode: createMode() },
            { message: '/resume missing-id', mode: createMode() }
        ]);

        await ompRemoteLauncher(session as never);

        expect(harness.requests.some((request) => (
            request.type === 'prompt' || request.type === 'switch_session'
        ))).toBe(false);
        expect(sessionEvents).toContainEqual({
            type: 'message',
            message: 'Oh My Pi RPC session mutation failed: Use /resume <session id> when controlling OMP remotely'
        });
        expect(sessionEvents).toContainEqual({
            type: 'message',
            message: 'Oh My Pi RPC session mutation failed: Session "missing-id" not found'
        });
    });

    it('serializes native model switching between completed turns', async () => {
        harness.currentModel = model('ollama', 'a', 'Model A');
        harness.availableModels[0] = harness.currentModel;
        const { session } = createSessionStub([
            { message: 'first', mode: createMode('ollama/a') },
            { message: 'second', mode: createMode('mlx/qwen3:0.6b') }
        ]);

        await ompRemoteLauncher(session as never);

        expect(harness.events).toEqual([
            'prompt:first',
            'set_model:mlx/qwen3:0.6b',
            'prompt:second'
        ]);
        expect(harness.requests.filter((request) => request.type === 'set_model')).toEqual([
            { type: 'set_model', provider: 'mlx', modelId: 'qwen3:0.6b' }
        ]);
    });

    it('dispatches follow-up input with a different modeHash immediately while deferring model switch until idle', async () => {
        harness.autoFinishPrompt = false;
        harness.currentModel = model('ollama', 'a', 'Model A');
        harness.availableModels[0] = harness.currentModel;
        const { session } = createSessionStub([
            { message: 'first', mode: createMode('ollama/a') },
            { message: 'second', mode: createMode('mlx/qwen3:0.6b') }
        ], { closeQueue: false });
        const launch = ompRemoteLauncher(session as never);
        await waitForRequestCount('prompt', 2);

        const prompts = harness.requests.filter((request): request is Extract<OmpCommand, { type: 'prompt' }> => (
            request.type === 'prompt'
        ));
        expect(prompts).toEqual([
            expect.objectContaining({ type: 'prompt', message: 'first' }),
            expect.objectContaining({ type: 'prompt', message: 'second', streamingBehavior: 'followUp' })
        ]);
        expect(harness.requests.some((request) => request.type === 'set_model')).toBe(false);

        emitEvent('agent_start');
        emitEvent('message_end', {
            message: { role: 'user', content: [{ type: 'text', text: 'second' }] }
        });
        session.queue.close();
        emitEvent('agent_end');
        await launch;

        expect(harness.events).toEqual([
            'prompt:first',
            'prompt:second',
            'set_model:mlx/qwen3:0.6b'
        ]);
    });

    it('does not switch when the requested model is already active', async () => {
        harness.currentModel = model('ollama', 'a', 'Model A');
        harness.availableModels[0] = harness.currentModel;
        const { session } = createSessionStub([
            { message: 'first', mode: createMode('ollama/a') },
            { message: 'second', mode: createMode('ollama/a') }
        ]);

        await ompRemoteLauncher(session as never);

        expect(harness.requests.some((request) => request.type === 'set_model')).toBe(false);
        expect(harness.prompts).toEqual(['first', 'second']);
    });

    it('resets to the launch-time native model', async () => {
        const { session } = createSessionStub([
            { message: 'first', mode: createMode('ollama/a') },
            { message: 'second', mode: createResetMode() }
        ]);

        await ompRemoteLauncher(session as never);

        expect(harness.requests.filter((request) => request.type === 'set_model')).toEqual([
            { type: 'set_model', provider: 'ollama', modelId: 'a' },
            { type: 'set_model', provider: 'ollama', modelId: 'launch-default' }
        ]);
    });

    it('forwards prompts without synthetic permission instructions', async () => {
        const { session } = createSessionStub([
            { message: 'design the fix', mode: createMode() }
        ]);

        await ompRemoteLauncher(session as never);

        expect(harness.prompts).toEqual(['design the fix']);
    });

    it('serves a provider-qualified native OMP model catalog', async () => {
        const { session, rpcHandlers } = createSessionStub([
            { message: 'first', mode: createMode() }
        ], { closeQueue: false });
        const launch = ompRemoteLauncher(session as never);
        await waitForRequest('prompt');
        await vi.waitFor(() => expect(rpcHandlers.has('listOmpModels')).toBe(true));

        const handler = rpcHandlers.get('listOmpModels');
        expect(handler).toBeDefined();
        await expect(handler!(undefined)).resolves.toEqual({
            success: true,
            availableModels: harness.availableModels.map((candidate) => ({
                provider: candidate.provider,
                modelId: candidate.id,
                name: candidate.name,
                reasoning: true,
                contextWindow: 128_000,
                maxTokens: 16_384,
                thinkingLevels: ['low', 'high']
            })),
            currentModel: { provider: 'ollama', modelId: 'launch-default' }
        });
        expect(rpcHandlers.has('listOpencodeModels')).toBe(false);
        session.queue.close();
        await launch;
    });

    it('cycles the native OMP model and confirms it through get_state', async () => {
        const { session, rpcHandlers } = createSessionStub([], { closeQueue: false });
        const launch = ompRemoteLauncher(session as never);
        await vi.waitFor(() => expect(rpcHandlers.has('cycleOmpModel')).toBe(true));

        await expect(rpcHandlers.get('cycleOmpModel')!(undefined)).resolves.toEqual({
            success: true,
            currentModel: { provider: 'ollama', modelId: 'a' }
        });
        expect(harness.requests.some((request) => request.type === 'cycle_model')).toBe(true);
        expect(harness.requests.some((request) => request.type === 'get_state')).toBe(true);

        session.queue.close();
        await launch;
    });

    it('applies low, high, and auto thinking only after native state confirmation', async () => {
        const { session, thinkingStates, getRuntimeConfigApplier } = createSessionStub([], { closeQueue: false });
        const launch = ompRemoteLauncher(session as never);
        await vi.waitFor(() => expect(getRuntimeConfigApplier()).not.toBeNull());
        const apply = getRuntimeConfigApplier()!;

        await expect(apply({ effort: 'low' })).resolves.toEqual({ effort: 'low' });
        await expect(apply({ effort: 'high' })).resolves.toEqual({ effort: 'high' });
        await expect(apply({ effort: 'auto' })).resolves.toEqual({ effort: 'auto' });

        expect(harness.requests.filter((request) => request.type === 'set_thinking_level')).toEqual([
            { type: 'set_thinking_level', level: 'low' },
            { type: 'set_thinking_level', level: 'high' }
        ]);
        expect(harness.requests.filter((request) => request.type === 'cycle_thinking_level')).toHaveLength(2);
        expect(thinkingStates.at(-1)).toEqual({
            thinkingLevel: 'medium',
            configured: 'auto',
            resolved: null
        });

        emitEvent('thinking_level_changed', {
            thinkingLevel: 'low',
            configured: 'auto',
            resolved: 'low'
        });
        expect(thinkingStates.at(-1)).toEqual({
            thinkingLevel: 'low',
            configured: 'auto',
            resolved: 'low'
        });

        session.queue.close();
        await launch;
    });

    it('restores persisted auto thinking on RPC reconnect despite get_state exposing only effective thinking', async () => {
        harness.thinkingLevel = 'high';
        harness.configuredThinking = 'high';
        const { session, thinkingStates } = createSessionStub([], {
            closeQueue: false,
            launchEffort: 'auto'
        });
        const launch = ompRemoteLauncher(session as never);

        await vi.waitFor(() => {
            expect(harness.configuredThinking).toBe('auto');
            expect(thinkingStates.at(-1)?.configured).toBe('auto');
        });
        expect(harness.requests.some((request) => request.type === 'cycle_thinking_level')).toBe(true);

        session.queue.close();
        await launch;
    });

    it('forwards OMP model, tokens, authoritative context, and cost', async () => {
        harness.contextUsage = { tokens: 4_096, contextWindow: 128_000, percent: 3.2 };
        const { session, agentMessages, canonicalMessages } = createSessionStub([], { closeQueue: false });
        const launch = ompRemoteLauncher(session as never);
        await vi.waitFor(() => expect(harness.eventListeners.length).toBeGreaterThan(0));

        emitEvent('message_end', {
            message: {
                role: 'assistant',
                content: [
                    { type: 'thinking', thinking: 'native reasoning' },
                    { type: 'text', text: 'native answer' }
                ],
                provider: 'ollama',
                model: 'launch-default',
                usage: {
                    input: 120,
                    output: 30,
                    cacheRead: 10,
                    cacheWrite: 0,
                    totalTokens: 160,
                    reasoningTokens: 5,
                    cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0, total: 0.031 }
                },
                stopReason: 'stop'
            }
        });

        await vi.waitFor(() => expect(agentMessages).toContainEqual(expect.objectContaining({
            type: 'token_count',
            info: {
                total: {
                    inputTokens: 130,
                    outputTokens: 30,
                    totalTokens: 160,
                    thoughtTokens: 5,
                    cachedInputTokens: 10,
                    cacheWriteInputTokens: 0,
                },
                contextTokens: 4_096,
                modelContextWindow: 128_000,
                costUsd: 0.031
            }
        })));
        expect(canonicalMessages).toContainEqual(expect.objectContaining({
            type: 'assistant',
            uuid: expect.any(String),
            providerMessageId: undefined,
            message: expect.objectContaining({
                role: 'assistant',
                model: 'ollama/launch-default',
                content: [
                    { type: 'thinking', thinking: 'native reasoning' },
                    { type: 'text', text: 'native answer' }
                ],
                usage: expect.objectContaining({
                    input_tokens: 120,
                    output_tokens: 30,
                    reasoning_output_tokens: 5,
                    cost_usd: 0.031
                })
            })
        }));

        session.queue.close();
        await launch;
    });

    it('does not translate Claude-only prompt/tool fields into OMP RPC commands', async () => {
        const mode = {
            ...createMode(),
            fallbackModel: 'fallback',
            customSystemPrompt: 'custom',
            appendSystemPrompt: 'append',
            allowedTools: ['Read'],
            disallowedTools: ['Bash']
        } as OmpMode;
        const { session } = createSessionStub([{ message: 'plain turn', mode }]);

        await ompRemoteLauncher(session as never);

        expect(harness.requests.filter((request) => request.type === 'set_host_tools')).toHaveLength(1);
        expect(harness.requests.some((request) => (
            'type' in request && ![
                'set_host_tools', 'set_host_uri_schemes', 'get_login_providers',
                'prompt', 'get_state', 'set_subagent_subscription', 'get_subagents', 'recover_inputs'
            ].includes(request.type)
        ))).toBe(false);
        expect(harness.prompts).toEqual(['plain turn']);
    });

    it('routes remote abort through the native abort command', async () => {
        harness.autoFinishPrompt = false;
        const { session, rpcHandlers } = createSessionStub([
            { message: 'wait for abort', mode: createMode() }
        ]);
        const launch = ompRemoteLauncher(session as never);
        await waitForRequest('prompt');

        const abort = rpcHandlers.get('abort');
        expect(abort).toBeDefined();
        await abort!(undefined);
        await launch;

        expect(harness.requests.some((request) => request.type === 'abort')).toBe(true);
        expect(session.thinking).toBe(false);
    });

    it('preserves a queued-steer turn that starts before the abort response', async () => {
        harness.autoFinishPrompt = false;
        const abortGate = Promise.withResolvers<void>();
        harness.abortResponse = abortGate.promise;
        const { session, rpcHandlers, sessionEvents } = createSessionStub([
            { message: 'long turn', mode: createMode() }
        ], { closeQueue: false });
        const launch = ompRemoteLauncher(session as never);
        await waitForRequest('prompt');
        emitEvent('agent_start');

        session.queue.push({
            text: 'keep going',
            mode: createMode(),
            inputMode: 'steer'
        });
        await waitForRequest('steer');
        session.queue.push({
            text: 'next task',
            mode: createMode(),
            inputMode: 'follow_up'
        });
        await waitForRequest('follow_up');

        sessionEvents.splice(0);
        const abort = rpcHandlers.get('abort');
        expect(abort).toBeDefined();
        const abortRequest = Promise.resolve(abort!(undefined));
        await waitForRequest('abort');
        emitEvent('agent_end');
        emitEvent('agent_start');
        abortGate.resolve();
        await abortRequest;

        expect(session.thinking).toBe(true);
        expect(sessionEvents.some((event) => event.type === 'ready')).toBe(false);

        emitEvent('message_end', {
            message: {
                role: 'user',
                content: [{ type: 'text', text: 'keep going' }],
                steering: true
            }
        });
        emitEvent('agent_end');
        await Promise.resolve();
        expect(session.thinking).toBe(false);
        expect(sessionEvents.some((event) => event.type === 'ready')).toBe(false);

        emitEvent('message_end', {
            message: {
                role: 'user',
                content: [{ type: 'text', text: 'next task' }]
            }
        });
        emitEvent('agent_start');
        session.queue.close();
        emitEvent('agent_end');
        await launch;

        expect(sessionEvents.some((event) => event.type === 'ready')).toBe(true);
    });

    it('dispatches streaming prompt, steer, follow-up, and abort-and-prompt as distinct native commands', async () => {
        harness.autoFinishPrompt = false;
        harness.receiptDelivered = false;
        const { session, consumedLocalIds, sessionEvents } = createSessionStub([
            { message: 'long turn', mode: createMode(), localId: 'initial' }
        ], { closeQueue: false });
        const launch = ompRemoteLauncher(session as never);
        await waitForRequest('prompt');
        // Starting a native turn commits its initial input; admission alone is
        // deliberately not enough to unblock another non-steering input.
        expect(consumedLocalIds).toEqual([]);
        emitEvent('input_receipt', { receipt: { ...harness.nativeReceipts.get('initial')!, delivered: true, ...deliveryProof('entry-initial') } });
        expect(consumedLocalIds).toEqual([['initial']]);
        emitEvent('agent_start');

        session.queue.push({
            text: 'correct direction',
            mode: createMode(),
            inputMode: 'steer',
            localId: 'steer'
        });
        await waitForRequest('steer');
        session.queue.push({
            text: 'next task',
            mode: createMode(),
            inputMode: 'follow_up',
            localId: 'follow-up-one'
        });
        session.queue.push({
            text: 'cancel me',
            mode: createMode(),
            inputMode: 'follow_up',
            localId: 'follow-up-two'
        });
        await waitForRequest('follow_up');
        await vi.waitFor(() => expect(session.queue.heldSize()).toBe(1));
        expect(sessionEvents.some((event) => event.type === 'ready')).toBe(false);
        expect(session.queue.cancelByLocalId('follow-up-two')).toBe(true);

        session.queue.push({
            text: 'replace the turn',
            mode: createMode(),
            inputMode: 'abort_and_prompt',
            localId: 'replace'
        });
        await Promise.resolve();
        expect(harness.requests.some((request) => request.type === 'abort_and_prompt')).toBe(false);
        emitEvent('message_end', {
            message: { role: 'user', content: [{ type: 'text', text: 'next task' }] }
        });
        for (const token of ['steer', 'follow-up-one']) {
            emitEvent('input_receipt', { receipt: { ...harness.nativeReceipts.get(token)!, delivered: true, ...deliveryProof(`entry-${token}`) } });
        }
        harness.receiptDelivered = true;
        await waitForRequest('abort_and_prompt');
        session.queue.close();
        emitEvent('agent_end');
        emitEvent('agent_start');
        emitEvent('agent_end');
        await launch;

        expect(harness.requests.filter((request) => (
            request.type === 'prompt'
            || request.type === 'steer'
            || request.type === 'follow_up'
            || request.type === 'abort_and_prompt'
        ))).toEqual([
            expect.objectContaining({ type: 'prompt', message: 'long turn' }),
            expect.objectContaining({ type: 'steer', message: 'correct direction' }),
            expect.objectContaining({ type: 'follow_up', message: 'next task' }),
            expect.objectContaining({ type: 'abort_and_prompt', message: 'replace the turn' })
        ]);
        expect(harness.requests.some((request) => (
            'message' in request && request.message === 'cancel me'
        ))).toBe(false);
        expect(consumedLocalIds.flat()).toEqual([
            'initial',
            'steer',
            'follow-up-one',
            'replace'
        ]);
        expect(sessionEvents.some((event) => event.type === 'ready')).toBe(true);
    });

    it('marks ordinary streaming prompts with an explicit followUp behavior', async () => {
        harness.autoFinishPrompt = false;
        const { session } = createSessionStub([
            { message: 'active', mode: createMode() }
        ], { closeQueue: false });
        const launch = ompRemoteLauncher(session as never);
        await waitForRequest('prompt');
        emitEvent('agent_start');
        session.queue.push({ text: 'queued ordinary prompt', mode: createMode(), inputMode: 'prompt' });

        await waitForRequestCount('prompt', 2);
        const prompts = harness.requests.filter((request): request is Extract<OmpCommand, { type: 'prompt' }> => (
            request.type === 'prompt'
        ));
        expect(prompts[1]).toEqual(expect.objectContaining({
            type: 'prompt',
            message: 'queued ordinary prompt',
            streamingBehavior: 'followUp'
        }));
        session.queue.close();
        emitEvent('message_end', {
            message: { role: 'user', content: [{ type: 'text', text: 'queued ordinary prompt' }] }
        });
        emitEvent('agent_end');
        await launch;
    });

    it('waits for prompt_result when prompt response omits agentInvoked', async () => {
        harness.autoFinishPrompt = false;
        harness.promptResponse = undefined;
        const { session, sessionEvents } = createSessionStub([
            { message: '/local-only-command', mode: createMode() }
        ]);
        const launch = ompRemoteLauncher(session as never);
        let finished = false;
        void launch.then(() => {
            finished = true;
        });
        await waitForRequest('prompt');
        await Promise.resolve();
        expect(finished).toBe(false);

        emitEvent('prompt_result', { agentInvoked: false });
        await launch;
        expect(sessionEvents.some((event) => event.type === 'ready')).toBe(true);
    });

    it('surfaces a prompt that OMP admitted and then failed before reaching the agent', async () => {
        harness.autoFinishPrompt = false;
        harness.promptResponse = undefined;
        const { session, sessionEvents } = createSessionStub([
            { message: 'are you there?', mode: createMode() }
        ]);
        const launch = ompRemoteLauncher(session as never);
        await waitForRequest('prompt');
        emitEvent('prompt_result', {
            agentInvoked: false,
            status: 'error',
            error: { message: 'Session file is locked by another OMP process', retryable: false }
        });
        await launch;
        expect(sessionEvents).toContainEqual({
            type: 'message',
            message: 'Oh My Pi RPC input failed: Session file is locked by another OMP process'
        });
        expect(sessionEvents.some((event) => event.type === 'ready')).toBe(true);
    });

    it('recovers an admitted follow-up during a prior run without consuming it on the prior assistant finish', async () => {
        harness.autoFinishPrompt = false;
        harness.receiptDelivered = false;
        harness.stateStreaming = true;
        const { session, consumedLocalIds } = createSessionStub([
            { message: 'same text', mode: createMode(), inputMode: 'follow_up', localId: 'admitted-before-reconnect' },
            { message: 'same text', mode: createMode(), inputMode: 'follow_up', localId: 'new-equal-text' }
        ], { sessionId: harness.sessionId, closeQueue: false });
        const receipt: OmpInputReceipt = { token: 'admitted-before-reconnect', sessionId: harness.sessionId, admitted: true, delivered: false, channel: 'follow_up' };
        session.getInputDeliveryStore().begin(receipt.token, harness.sessionId, receipt.token);
        harness.nativeReceipts.set(receipt.token, receipt);
        const launch = ompRemoteLauncher(session as never);
        await vi.waitFor(() => expect(session.client.emitSessionReady).toHaveBeenCalled());
        expect(harness.requests.filter(request => request.type === 'follow_up')).toEqual([]);
        await vi.waitFor(() => expect(session.queue.heldSize()).toBe(1));
        expect(consumedLocalIds.flat()).toEqual([]);
        harness.stateStreaming = false;
        emitEvent('agent_end');
        await vi.waitFor(() => expect(harness.requests.some(request => request.type === 'get_state')).toBe(true));
        expect(consumedLocalIds.flat()).toEqual([]);
        emitEvent('input_receipt', { receipt: { ...receipt, delivered: true, ...deliveryProof('first-user-entry') } });
        expect(consumedLocalIds.flat()).toEqual(['admitted-before-reconnect']);
        await waitForRequest('follow_up');
        await vi.waitFor(() => expect(session.queue.heldSize()).toBe(0));
        expect(session.getInputDeliveryStore().isAccepted('new-equal-text')).toBe(false);
        emitEvent('input_receipt', { receipt: { token: 'new-equal-text', sessionId: harness.sessionId, admitted: true, delivered: true, ...deliveryProof('second-user-entry'), channel: 'follow_up' } });
        emitEvent('input_receipt', { receipt: { ...receipt, delivered: true, ...deliveryProof('first-user-entry') } });
        expect(consumedLocalIds.flat()).toEqual(['admitted-before-reconnect', 'new-equal-text']);
        session.queue.close();
        emitEvent('agent_end');
        await launch;
    });

    it('publishes new and recovered terminal non-invocations without consumed acknowledgements', async () => {
        harness.autoFinishPrompt = false;
        harness.receiptDelivered = false;
        const { session, consumedLocalIds } = createSessionStub([
            { message: 'cancelled locally', mode: createMode(), localId: 'new-terminal' }
        ], { sessionId: harness.sessionId, closeQueue: false });
        const nativeOrder = { sessionId: harness.sessionId, entryId: 'resolved-local', entryOrder: 2, eventOrder: 0 };
        const terminal: OmpInputReceipt = { token: 'restored-terminal', sessionId: harness.sessionId, admitted: true, delivered: false, channel: 'prompt', outcome: 'local', nativeOrder };
        session.getInputDeliveryStore().begin(terminal.token, harness.sessionId, terminal.token);
        session.getInputDeliveryStore().recordNativeReceipt(terminal);
        const launch = ompRemoteLauncher(session as never);
        await waitForRequest('prompt');
        await vi.waitFor(() => expect(session.getInputDeliveryStore().isAdmitted('new-terminal')).toBe(true));
        expect(session.client.sendMessagesResolved).toHaveBeenCalledWith([{ localId: 'restored-terminal', outcome: 'handled', nativeOrder }]);
        const cancelledOrder = { ...nativeOrder, entryId: 'resolved-cancelled', entryOrder: 3 };
        emitEvent('input_receipt', { receipt: { token: 'new-terminal', sessionId: harness.sessionId, admitted: true, delivered: false, channel: 'prompt', outcome: 'cancelled', nativeOrder: cancelledOrder } });
        expect(session.client.sendMessagesResolved).toHaveBeenCalledWith([{ localId: 'new-terminal', outcome: 'cancelled', nativeOrder: cancelledOrder }]);
        expect(session.getInputDeliveryStore().nativeReceiptRecords()).toContainEqual({ localId: 'restored-terminal', receipt: terminal });
        expect(consumedLocalIds.flat()).toEqual([]);
        session.queue.close();
        emitEvent('agent_end');
        await launch;
    });

    it('cancels admitted native input by token without touching equal-text input or inventing invocation on not-found', async () => {
        harness.autoFinishPrompt = false;
        harness.receiptDelivered = false;
        harness.stateStreaming = true;
        const { session, consumedLocalIds } = createSessionStub([
            { message: 'same text', mode: createMode(), inputMode: 'follow_up', localId: 'native-first' },
            { message: 'same text', mode: createMode(), inputMode: 'steer', localId: 'native-second' }
        ], { sessionId: harness.sessionId, closeQueue: false });
        const launch = ompRemoteLauncher(session as never);
        await waitForRequest('steer');
        await vi.waitFor(() => expect(session.queue.heldSize()).toBe(0));
        session.queue.push({ text: 'same text', mode: createMode(), inputMode: 'steer', localId: 'native-second' });
        expect(await session.cancelQueuedInput('native-second')).toBe(true);
        expect(await session.cancelQueuedInput('native-second')).toBe(false);
        expect(harness.nativeReceipts.get('native-first')?.outcome).toBeUndefined();
        expect(session.client.sendMessagesResolved).toHaveBeenCalledWith([{ localId: 'native-second', outcome: 'cancelled' }]);
        expect(consumedLocalIds.flat()).toEqual([]);
        expect(await session.cancelQueuedInput('unknown')).toBe(false);
        expect(harness.requests.filter(request => request.type === 'remove_queued_message')).toEqual([
            { type: 'remove_queued_message', clientToken: 'native-second' }
        ]);
        harness.nativeReceipts.set('native-first', { token: 'native-first', sessionId: harness.sessionId, admitted: true, delivered: true, ...deliveryProof('actual-native-user'), channel: 'follow_up' });
        expect(await session.cancelQueuedInput('native-first')).toBe(false);
        expect(consumedLocalIds.flat()).toEqual(['native-first']);
        harness.stateStreaming = false;
        session.queue.close();
        emitEvent('agent_end');
        await launch;
    });

    it('republishes committed native receipts on Hub replay but never replays or promotes the input', async () => {
        const { session, deliveryCalls, getNativeInputForcer } = createSessionStub([
            { message: 'already executed once', mode: createMode(), localId: 'lost-ack' }
        ], { closeQueue: false });
        const launch = ompRemoteLauncher(session as never);
        try {
            await vi.waitFor(() => expect(deliveryCalls).toHaveLength(1));
            const originalDelivery = structuredClone(deliveryCalls[0]);
            const inputRequests = structuredClone(harness.requests);
            session.client.emit('user-message-replay', 'lost-ack');
            expect(deliveryCalls.slice(1)).toEqual([originalDelivery]);
            expect(harness.requests).toEqual(inputRequests);
            expect(await getNativeInputForcer()!('lost-ack')).toEqual({ localId: 'lost-ack', status: 'not-found' });
            expect(deliveryCalls.at(-1)).toEqual(originalDelivery);
            expect(harness.requests).toEqual(inputRequests);
            session.client.emit('user-message-replay', 'unknown');
            expect(harness.prompts).toEqual(['already executed once']);
        } finally {
            session.queue.close();
            emitEvent('agent_end');
            await launch;
        }
    });

    it('forces native input by its original token only, without text replay or synthetic delivery', async () => {
        harness.autoFinishPrompt = false;
        harness.receiptDelivered = false;
        harness.stateStreaming = true;
        const { session, consumedLocalIds, getNativeInputForcer } = createSessionStub([
            { message: '/review same text', mode: createMode(), inputMode: 'follow_up', localId: 'native-first' },
            { message: '/review same text', mode: createMode(), inputMode: 'steer', localId: 'native-second' }
        ], { sessionId: harness.sessionId, closeQueue: false });
        const launch = ompRemoteLauncher(session as never);
        try {
            await waitForRequest('steer');
            await vi.waitFor(() => expect(session.queue.heldSize()).toBe(0));
            const force = getNativeInputForcer()!;
            const originalReceipts = structuredClone([...harness.nativeReceipts.values()]);
            expect(await force('native-first')).toEqual({ localId: 'native-first', status: 'promoted' });
            expect(await force('native-first')).toEqual({ localId: 'native-first', status: 'promoted' });
            expect(await force('native-second')).toEqual({ localId: 'native-second', status: 'promoted' });
            expect([...harness.nativeReceipts.values()]).toEqual(originalReceipts);
            expect(consumedLocalIds.flat()).toEqual([]);
            expect(harness.requests.filter(request => request.type === 'promote_queued_message')).toEqual([
                { type: 'promote_queued_message', clientToken: 'native-first' },
                { type: 'promote_queued_message', clientToken: 'native-first' },
                { type: 'promote_queued_message', clientToken: 'native-second' }
            ]);
            emitEvent('input_receipt', { receipt: { ...originalReceipts[0]!, delivered: true, ...deliveryProof('actual-delivery') } });
            emitEvent('input_receipt', { receipt: { ...originalReceipts[1]!, outcome: 'cancelled' } });
            expect(await force('native-first')).toEqual({ localId: 'native-first', status: 'not-found' });
            expect(await force('native-second')).toEqual({ localId: 'native-second', status: 'not-found' });
            expect(harness.requests.filter(request => request.type === 'promote_queued_message')).toHaveLength(3);
            expect(harness.requests.filter(request => ['prompt', 'steer', 'follow_up', 'abort_and_prompt', 'abort', 'remove_queued_message'].includes(request.type))).toEqual([
                { type: 'follow_up', message: '/review same text', clientToken: 'native-first' },
                { type: 'steer', message: '/review same text', clientToken: 'native-second' }
            ]);
        } finally {
            resolvePendingNativeInputs();
            harness.stateStreaming = false;
            session.queue.close();
            emitEvent('agent_end');
            await launch;
        }
    });

    it.each([false, undefined])('does not send a promotion RPC to legacy queuePromotion=%s peers', async capability => {
        harness.queuePromotionCapability = capability;
        harness.autoFinishPrompt = false;
        harness.receiptDelivered = false;
        harness.stateStreaming = true;
        const { session, consumedLocalIds, getNativeInputForcer } = createSessionStub([
            { message: 'same text', mode: createMode(), inputMode: 'follow_up', localId: 'legacy-token' }
        ], { closeQueue: false });
        const launch = ompRemoteLauncher(session as never);
        try {
            await waitForRequest('follow_up');
            const requestCount = harness.requests.length;
            expect(await getNativeInputForcer()!('legacy-token')).toMatchObject({ localId: 'legacy-token', status: 'unsupported' });
            expect(harness.requests.slice(requestCount)).toEqual([]);
            expect(consumedLocalIds.flat()).toEqual([]);
            expect(session.getInputDeliveryStore().nativeReceipt('legacy-token')).toMatchObject({ admitted: true, delivered: false, channel: 'follow_up' });
        } finally {
            resolvePendingNativeInputs();
            harness.stateStreaming = false;
            session.queue.close();
            emitEvent('agent_end');
            await launch;
        }
    });

    it.each([
        { promoted: true },
        { promoted: true, results: [{ token: 'different-token', status: 'promoted' as const }] }
    ])('refuses unproven legacy promotion results without text selection or re-enqueue: %j', async response => {
        harness.promotionResponse = response;
        harness.autoFinishPrompt = false;
        harness.receiptDelivered = false;
        harness.stateStreaming = true;
        const { session, consumedLocalIds, getNativeInputForcer } = createSessionStub([
            { message: '/review same text', mode: createMode(), inputMode: 'follow_up', localId: 'pending-token' }
        ], { closeQueue: false });
        const launch = ompRemoteLauncher(session as never);
        try {
            await waitForRequest('follow_up');
            const requestCount = harness.requests.length;
            expect(await getNativeInputForcer()!('pending-token')).toMatchObject({ localId: 'pending-token', status: 'unsupported' });
            expect(harness.requests.slice(requestCount)).toEqual([{ type: 'promote_queued_message', clientToken: 'pending-token' }]);
            expect(consumedLocalIds.flat()).toEqual([]);
        } finally {
            resolvePendingNativeInputs();
            harness.stateStreaming = false;
            session.queue.close();
            emitEvent('agent_end');
            await launch;
        }
    });

    it('reports rejected token promotion as unsupported without falling back to text or interrupting the run', async () => {
        harness.autoFinishPrompt = false;
        harness.receiptDelivered = false;
        harness.stateStreaming = true;
        const { session, consumedLocalIds, getNativeInputForcer } = createSessionStub([
            { message: 'same text', mode: createMode(), inputMode: 'follow_up', localId: 'pending-token' }
        ], { closeQueue: false });
        const launch = ompRemoteLauncher(session as never);
        try {
            await waitForRequest('follow_up');
            harness.requestError = command => command.type === 'promote_queued_message' ? new Error('message must be a string') : null;
            const requestCount = harness.requests.length;
            expect(await getNativeInputForcer()!('pending-token')).toEqual({ localId: 'pending-token', status: 'unsupported', error: 'message must be a string' });
            expect(harness.requests.slice(requestCount)).toEqual([{ type: 'promote_queued_message', clientToken: 'pending-token' }]);
            expect(consumedLocalIds.flat()).toEqual([]);
        } finally {
            resolvePendingNativeInputs();
            harness.stateStreaming = false;
            session.queue.close();
            emitEvent('agent_end');
            await launch;
        }
    });

    it('suppresses ready while OMP reports streaming or queued native work', async () => {
        harness.autoFinishPrompt = false;
        const { session, sessionEvents } = createSessionStub([
            { message: 'native queue check', mode: createMode() }
        ], { closeQueue: false });
        const launch = ompRemoteLauncher(session as never);
        await waitForRequest('prompt');
        emitEvent('agent_start');
        harness.queuedMessageCount = 1;
        emitEvent('agent_end');
        await vi.waitFor(() => {
            expect(harness.requests.filter((request) => request.type === 'get_state').length).toBeGreaterThan(0);
        });
        expect(sessionEvents.some((event) => event.type === 'ready')).toBe(false);

        harness.queuedMessageCount = 0;
        emitEvent('agent_start');
        emitEvent('agent_end');
        await vi.waitFor(() => {
            expect(sessionEvents.some((event) => event.type === 'ready')).toBe(true);
        });
        expect(session.thinking).toBe(false);
        session.queue.close();
        await launch;
    });

    it('sends image bytes through native ImageContent and never inserts @path text', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'hapi-omp-launcher-image-'));
        createdDirectories.push(directory);
        const path = join(directory, 'sample.png');
        const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
        await writeFile(path, bytes);
        const { session } = createSessionStub([{
            message: 'describe this image',
            mode: createMode(),
            attachments: [{
                id: 'image',
                filename: 'sample.png',
                mimeType: 'image/png',
                size: bytes.length,
                path
            }]
        }]);

        await ompRemoteLauncher(session as never);

        const prompt = harness.requests.find((request) => request.type === 'prompt');
        expect(prompt).toEqual(expect.objectContaining({
            type: 'prompt',
            message: 'describe this image',
            images: [{
                type: 'image',
                data: bytes.toString('base64'),
                mimeType: 'image/png'
            }]
        }));
        expect(harness.prompts[0]).not.toContain(path);
        expect(harness.prompts[0]).not.toContain('@');
    });

    it('prompts OMP with every document reference when an input contains only files', async () => {
        const { session, sessionEvents, consumedLocalIds } = createSessionStub([{
            message: '',
            mode: createMode(),
            localId: 'document-only',
            attachments: [{
                id: 'document',
                filename: 'notes.txt',
                mimeType: 'text/plain',
                size: 5,
                path: '/uploads/notes.txt'
            }, {
                id: 'pdf',
                filename: '数学 1试卷.pdf',
                mimeType: 'application/pdf',
                size: 100,
                path: 'C:/uploads/数学 1试卷.pdf'
            }]
        }]);

        await ompRemoteLauncher(session as never);

        expect(harness.requests.find((request) => request.type === 'prompt')).toEqual(expect.objectContaining({
            type: 'prompt',
            message: '@/uploads/notes.txt @C:/uploads/数学 1试卷.pdf'
        }));
        expect(sessionEvents.filter((event) => event.type === 'message')).toEqual([]);
        expect(consumedLocalIds).toEqual([['document-only']]);
    });

    it('keeps the session usable for a new prompt after native abort', async () => {
        harness.autoFinishPrompt = false;
        const { session, rpcHandlers } = createSessionStub([
            { message: 'abort this', mode: createMode() }
        ], { closeQueue: false });
        const launch = ompRemoteLauncher(session as never);
        await waitForRequest('prompt');
        emitEvent('agent_start');
        const abort = rpcHandlers.get('abort');
        await abort!(undefined);

        session.queue.push({ text: 'works after abort', mode: createMode(), inputMode: 'prompt' });
        await waitForRequestCount('prompt', 2);
        session.queue.close();
        emitEvent('agent_start');
        emitEvent('agent_end');
        await launch;

        expect(harness.prompts).toEqual(['abort this', 'works after abort']);
    });

    it('switches launchers without aborting the native turn or clearing queued input', async () => {
        harness.autoFinishPrompt = false;
        const { session, rpcHandlers } = createSessionStub([
            { message: 'active turn', mode: createMode() }
        ], { closeQueue: false });
        const launch = ompRemoteLauncher(session as never);
        await waitForRequest('prompt');
        session.queue.push({
            text: 'queued for local',
            mode: createMode(),
            inputMode: 'prompt'
        });

        const switchHandler = rpcHandlers.get('switch');
        expect(switchHandler).toBeDefined();
        await switchHandler!(undefined);
        await launch;

        expect(harness.requests.some((request) => request.type === 'abort')).toBe(false);
        expect(session.queue.size()).toBe(1);
    });

    it('propagates native RPC connection failure without an ACP fallback', async () => {
        harness.connectError = new Error('OMP RPC discovery failed');
        const { session } = createSessionStub([
            { message: 'first', mode: createMode() }
        ]);

        await expect(ompRemoteLauncher(session as never)).rejects.toThrow('OMP RPC discovery failed');
        expect(harness.connectArgs).toHaveLength(1);
    });

    it('propagates transport closure while a turn is active', async () => {
        harness.autoFinishPrompt = false;
        const { session } = createSessionStub([
            { message: 'first', mode: createMode() }
        ]);
        const launch = ompRemoteLauncher(session as never);
        await waitForRequest('prompt');

        for (const listener of harness.closedListeners) {
            listener(new Error('OMP RPC transport crashed'));
        }

        await expect(launch).rejects.toThrow('OMP RPC transport crashed');
    });

    it('propagates cleanup failure', async () => {
        harness.close.mockRejectedValueOnce(new Error('OMP RPC close failed'));
        const { session } = createSessionStub([
            { message: 'first', mode: createMode() }
        ]);

        await expect(ompRemoteLauncher(session as never)).rejects.toThrow('OMP RPC close failed');
    });

    it('allows switching model while busy, delivers multiple follow-up messages, and recovers from busy race without losing messages', async () => {
        harness.autoFinishPrompt = false;
        harness.currentModel = model('ollama', 'a', 'Model A');
        harness.availableModels[0] = harness.currentModel;
        const { session, consumedLocalIds, sessionEvents, getRuntimeConfigApplier } = createSessionStub([
            { message: 'turn-4', mode: createMode('ollama/a'), localId: 'local-4' }
        ], { closeQueue: false });
        const launch = ompRemoteLauncher(session as never);
        await waitForRequest('prompt');
        emitEvent('agent_start');

        // User switches model in Web UI while turn-4 is running
        const applier = getRuntimeConfigApplier();
        expect(applier).not.toBeNull();
        await expect(applier!({ model: 'mlx/qwen3:0.6b', effort: 'low' })).resolves.toEqual({
            model: 'mlx/qwen3:0.6b',
            effort: 'low'
        });
        expect(harness.requests.some((request) => request.type === 'set_model')).toBe(false);

        harness.receiptDelivered = false;
        // User appends turn-6 and turn-7 with the new model while turn-4 is still running
        session.queue.push({
            text: 'turn-6-js-bridge',
            mode: { permissionMode: 'default', model: 'mlx/qwen3:0.6b', effort: 'low' },
            inputMode: 'prompt',
            localId: 'local-6'
        });
        session.queue.push({
            text: 'turn-7-enterprise-news',
            mode: { permissionMode: 'default', model: 'mlx/qwen3:0.6b', effort: 'low' },
            inputMode: 'prompt',
            localId: 'local-7'
        });

        // turn-6 is sent immediately as followUp; turn-7 stays held until turn-6 commits
        await waitForRequestCount('prompt', 2);
        expect(consumedLocalIds.flat()).toEqual(['local-4']);
        await vi.waitFor(() => expect(session.queue.heldSize()).toBe(1));

        // Simulate turn-6 user message committed, followed by a busy race when turn-7 is dispatched:
        // launcher briefly sees isStreaming=false after agent_end, so it tries plain prompt/set_model,
        // which OMP rejects with "Agent is already processing..."
        let rejectedBusyOnce = false;
        harness.requestError = (command) => {
            if (
                !rejectedBusyOnce
                && command.type === 'prompt'
                && command.message === 'turn-7-enterprise-news'
                && command.streamingBehavior === undefined
            ) {
                rejectedBusyOnce = true;
                return new OmpRpcRequestError(command.type, 'Agent is already processing. Use steer() or followUp() to queue messages, or wait for completion.');
            }
            return null;
        };

        emitEvent('agent_end');
        harness.receiptDelivered = true;
        emitEvent('input_receipt', { receipt: { ...harness.nativeReceipts.get('local-6')!, delivered: true, ...deliveryProof('entry-local-6') } });
        emitEvent('message_end', {
            message: { role: 'user', content: [{ type: 'text', text: 'turn-6-js-bridge' }] }
        });

        // turn-7 hits the busy race on plain prompt and automatically falls back to followUp!
        await vi.waitFor(() => {
            expect(consumedLocalIds.flat()).toEqual(['local-4', 'local-6', 'local-7']);
        });
        const turn7FollowUp = harness.requests.find((request) => (
            request.type === 'prompt'
            && request.message === 'turn-7-enterprise-news'
            && request.streamingBehavior === 'followUp'
        ));
        expect(turn7FollowUp).toBeDefined();
        expect(sessionEvents.some((event) => (
            event.type === 'message' && String(event.message).includes('Agent is already processing')
        ))).toBe(false);

        emitEvent('message_end', {
            message: { role: 'user', content: [{ type: 'text', text: 'turn-7-enterprise-news' }] }
        });
        session.queue.close();
        emitEvent('agent_end');
        await launch;

        const readyEvents = sessionEvents.filter((event) => event.type === 'ready');
        expect(readyEvents).toHaveLength(1);
    });

    it('requeues a second message instead of dropping it when a busy race occurs while a followUp is already outstanding', async () => {
        harness.autoFinishPrompt = false;
        harness.receiptDelivered = false;
        const { session, consumedLocalIds, sessionEvents } = createSessionStub([], { closeQueue: false });
        const launch = ompRemoteLauncher(session as never);
        await waitForRequest('get_subagents');
        await vi.waitFor(() => expect(sessionEvents.some((event) => event.type === 'ready')).toBe(true));
        sessionEvents.splice(0);
        // Simulate OMP already processing natively when launcher thought it was idle:
        // First prompt fails plain prompt -> falls back to followUp (setting nativeFollowUpOutstanding = true).
        harness.requestError = (command) => {
            if (command.type === 'prompt' && command.streamingBehavior === undefined) {
                return new OmpRpcRequestError(command.type, 'Agent is already processing. Use steer() or followUp() to queue messages, or wait for completion.');
            }
            return null;
        };

        session.queue.push({ text: 'msg-1', mode: createMode(), inputMode: 'prompt', localId: 'l-1' });
        session.queue.push({ text: 'msg-2', mode: createMode(), inputMode: 'prompt', localId: 'l-2' });

        await vi.waitFor(() => expect(session.getInputDeliveryStore().isAdmitted('l-1')).toBe(true));
        expect(consumedLocalIds.flat()).toEqual([]);
        // Native owns msg-1, but it is not invoked and msg-2 stays cancelable.
        await vi.waitFor(() => expect(session.queue.heldSize()).toBe(1));

        // Once msg-1 is committed by OMP, msg-2 can now be dispatched as followUp
        harness.receiptDelivered = true;
        emitEvent('input_receipt', { receipt: { ...harness.nativeReceipts.get('l-1')!, delivered: true, ...deliveryProof('entry-l-1') } });
        emitEvent('message_end', {
            message: { role: 'user', content: [{ type: 'text', text: 'msg-1' }] }
        });
        await vi.waitFor(() => {
            expect(consumedLocalIds.flat()).toEqual(['l-1', 'l-2']);
        });

        emitEvent('message_end', {
            message: { role: 'user', content: [{ type: 'text', text: 'msg-2' }] }
        });
        session.queue.close();
        emitEvent('agent_end');
        await launch;

        expect(sessionEvents.filter((event) => event.type === 'ready')).toHaveLength(1);
    });

    it('recovers a busy response already admitted by native without changing channel or replaying payload', async () => {
        harness.autoFinishPrompt = false;
        harness.receiptDelivered = false;
        harness.requestError = command => {
            if (command.type !== 'prompt' || command.clientToken !== 'busy-owned') return null;
            harness.nativeReceipts.set('busy-owned', { token: 'busy-owned', sessionId: harness.sessionId, admitted: true, delivered: false, channel: 'prompt' });
            return new OmpRpcRequestError('prompt', 'Agent is already processing');
        };
        const { session, consumedLocalIds } = createSessionStub([
            { message: 'native owns this', mode: createMode(), localId: 'busy-owned' }
        ], { closeQueue: false });
        const launch = ompRemoteLauncher(session as never);
        await vi.waitFor(() => expect(session.getInputDeliveryStore().isAdmitted('busy-owned')).toBe(true));
        expect(harness.requests.filter(request => request.type === 'prompt')).toHaveLength(1);
        expect(harness.requests).toContainEqual({ type: 'get_input_receipts', tokens: ['busy-owned'] });
        expect(consumedLocalIds.flat()).toEqual([]);
        emitEvent('input_receipt', { receipt: { ...harness.nativeReceipts.get('busy-owned')!, delivered: true, ...deliveryProof('native-busy-owned-user') } });
        expect(consumedLocalIds.flat()).toEqual(['busy-owned']);
        session.queue.close();
        emitEvent('agent_end');
        await launch;
    });

    it('hibernates the idle OMP RPC subprocess after HAPI_OMP_IDLE_HIBERNATE_MS and wakes it with --resume on the next prompt', async () => {
        const prevEnv = process.env.HAPI_OMP_IDLE_HIBERNATE_MS;
        process.env.HAPI_OMP_IDLE_HIBERNATE_MS = '30';
        try {
            const { session, sessionEvents } = createSessionStub([], { closeQueue: false });
            const launch = ompRemoteLauncher(session as never);
            await vi.waitFor(() => expect(sessionEvents.some((event) => event.type === 'ready')).toBe(true));
            await vi.waitFor(() => expect(harness.close).toHaveBeenCalledTimes(1));
            expect(harness.connectArgs).toHaveLength(1);

            session.queue.push({ text: 'wake up after hibernate', mode: createMode(), inputMode: 'prompt', localId: 'wake-1' });
            await vi.waitFor(() => expect(harness.prompts).toContain('wake up after hibernate'));
            expect(harness.connectArgs).toHaveLength(2);
            expect(harness.connectArgs[1]).toMatchObject({ resumeSessionId: '/sessions/omp-session-1.jsonl' });

            session.queue.close();
            await launch;
        } finally {
            if (prevEnv === undefined) delete process.env.HAPI_OMP_IDLE_HIBERNATE_MS;
            else process.env.HAPI_OMP_IDLE_HIBERNATE_MS = prevEnv;
        }
    });
    it('refuses a different discovered native session without overwriting its original history binding', async () => {
        const { session, snapshots } = createSessionStub([], { sessionId: 'original-native' });
        await expect(ompRemoteLauncher(session as never)).rejects.toThrow('expected original-native');
        expect(session.sessionId).toBe('original-native');
        expect(snapshots).toEqual([]);
        expect(harness.close).toHaveBeenCalledOnce();
        expect(session.client.emitSessionReady).not.toHaveBeenCalled();
    });

    it('does not publish readiness or send new input when native journal recovery fails', async () => {
        const { session } = createSessionStub([{ message: 'retain pending', mode: createMode(), localId: 'pending' }]);
        harness.requestError = command => command.type === 'recover_inputs' ? new Error('journal recovery failed') : null;
        await expect(ompRemoteLauncher(session as never)).rejects.toThrow('journal recovery failed');
        expect(harness.prompts).toEqual([]);
        expect(session.client.emitSessionReady).not.toHaveBeenCalled();
        expect(harness.close).toHaveBeenCalledOnce();
    });

    it('retains verified disposal when archiving an already hibernated wrapper', async () => {
        vi.stubEnv('HAPI_OMP_IDLE_HIBERNATE_MS', '1');
        const { session } = createSessionStub([], { closeQueue: false });
        const launch = ompRemoteLauncher(session as never);
        await vi.waitFor(() => expect(session.recordShutdownReceipt).toHaveBeenCalledWith(expect.objectContaining({ status: 'disposed' })));
        session.queue.close();
        await launch;
        expect(harness.connectArgs).toHaveLength(1);
        expect(harness.close).toHaveBeenCalledOnce();
        expect(session.recordShutdownReceipt).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'disposed' }));
    });

    it('waits for native EOF disposal before concurrent RPC wakes and delivers queued input exactly once', async () => {
        vi.stubEnv('HAPI_OMP_IDLE_HIBERNATE_MS', '1');
        const disposal = Promise.withResolvers<void>();
        harness.close.mockImplementationOnce(() => disposal.promise);
        const { session, rpcHandlers, consumedLocalIds } = createSessionStub([], { closeQueue: false });
        const launch = ompRemoteLauncher(session as never);
        await vi.waitFor(() => expect(harness.close).toHaveBeenCalledOnce());
        const handler = rpcHandlers.get('listOmpModels')!;
        const firstWake = handler(undefined);
        const secondWake = handler(undefined);
        session.queue.push({ text: 'one queued wake', mode: createMode(), inputMode: 'prompt', localId: 'wake-once' });
        await Promise.resolve();
        expect(harness.connectArgs).toHaveLength(1);
        expect(harness.prompts).toEqual([]);
        disposal.resolve();
        await Promise.all([firstWake, secondWake]);
        await vi.waitFor(() => expect(harness.prompts).toEqual(['one queued wake']));
        session.queue.close();
        await launch;
        expect(harness.connectArgs).toHaveLength(2);
        expect(consumedLocalIds.flat()).toEqual(['wake-once']);
    });

    it('does not expose a waking native generation before host and subagent initialization completes', async () => {
        vi.stubEnv('HAPI_OMP_IDLE_HIBERNATE_MS', '1');
        const { session, rpcHandlers } = createSessionStub([], { closeQueue: false });
        const launch = ompRemoteLauncher(session as never);
        await vi.waitFor(() => expect(harness.close).toHaveBeenCalledOnce());
        const initialized = Promise.withResolvers<void>();
        harness.beforeRequest = async (command) => {
            if (command.type === 'get_subagents') await initialized.promise;
        };
        const handler = rpcHandlers.get('listOmpModels')!;
        const first = handler(undefined);
        await waitForRequestCount('get_subagents', 2);
        const second = handler(undefined);
        await Promise.resolve();
        expect(harness.requests.filter((request) => request.type === 'get_available_models')).toHaveLength(0);
        expect(harness.requests.filter((request) => request.type === 'recover_inputs')).toHaveLength(1);
        initialized.resolve();
        await Promise.all([first, second]);
        expect(harness.requests.filter((request) => request.type === 'recover_inputs')).toHaveLength(2);
        session.queue.close();
        await launch;
        expect(harness.connectArgs).toHaveLength(2);
    });

    it('rejects wake after unverified hibernation disposal rather than creating another native writer', async () => {
        vi.stubEnv('HAPI_OMP_IDLE_HIBERNATE_MS', '1');
        harness.close.mockRejectedValueOnce(new Error('native disposal unverified'));
        const { session } = createSessionStub([], { closeQueue: false });
        const launch = ompRemoteLauncher(session as never);
        await expect(launch).rejects.toThrow('native disposal unverified');
        expect(harness.connectArgs).toHaveLength(1);
        expect(harness.close).toHaveBeenCalledTimes(2);
        expect(session.client.clearSessionReady).toHaveBeenCalled();
    });

    it('keeps shutdown retryable after an EOF disposal timeout while the process still runs', async () => {
        // EOF disposal timed out with the process still alive: close() rejects,
        // the receipt stays 'unverified' (fail closed), and the owned client is
        // retained so the runner's archive retry re-attempts EOF instead of
        // dead-ending or spawning a second native writer.
        harness.close.mockRejectedValue(new Error('Timed out waiting for OMP native disposal'));
        const { session, getShutdownHandle } = createSessionStub([]);
        const launch = ompRemoteLauncher(session as never);
        const handle = getShutdownHandle();
        expect(handle).not.toBeNull();
        // The first shutdown attempt fails closed: the cleanup throw surfaces
        // and the recorded receipt is unverified while the process may run.
        await expect(handle!.waitForExit()).rejects.toThrow('Timed out waiting for OMP native disposal');
        await expect(launch).rejects.toThrow('Timed out waiting for OMP native disposal');
        expect(session.recordShutdownReceipt).toHaveBeenLastCalledWith(
            expect.objectContaining({ status: 'unverified' })
        );

        // The process eventually honored the earlier EOF; the retry converges.
        harness.close.mockReset().mockResolvedValue(undefined);
        harness.exitInfo = { pid: 4242, code: 0, signal: null };
        await expect(handle!.waitForExit()).resolves.toMatchObject({
            status: 'disposed',
            pid: 4242,
            exitCode: 0,
            signal: null
        });
        expect(session.recordShutdownReceipt).toHaveBeenLastCalledWith(
            expect.objectContaining({ status: 'disposed', exitCode: 0 })
        );
    });

    it('starts a fresh native identity only for explicitly proven never-persisted history', async () => {
        const { session } = createSessionStub([], {
            sessionId: 'empty-native',
            nativePersistence: 'never-persisted'
        });
        await ompRemoteLauncher(session as never);
        expect(harness.connectArgs).toEqual([expect.not.objectContaining({ resumeSessionId: expect.anything() })]);
        expect(session.sessionId).toBe('omp-session-1');
        expect(session.recordShutdownReceipt).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'disposed' }));
    });

    it.each(['not-started', 'disposed', 'unverified'] as const)('preserves %s startup ownership proof without disguising its error', async (status) => {
        harness.connectError = new OmpRpcConnectionError(new Error('native discovery rejected'), { kind: 'omp-rpc', status });
        const { session } = createSessionStub([]);
        await expect(ompRemoteLauncher(session as never)).rejects.toThrow('native discovery rejected');
        expect(session.recordShutdownReceipt).toHaveBeenLastCalledWith({ kind: 'omp-rpc', status });
        expect(session.client.emitSessionReady).not.toHaveBeenCalled();
    });

    it('ignores late events and closure from the hibernated native generation after wake', async () => {
        vi.stubEnv('HAPI_OMP_IDLE_HIBERNATE_MS', '1');
        const { session } = createSessionStub([], { closeQueue: false });
        const launch = ompRemoteLauncher(session as never);
        await vi.waitFor(() => expect(harness.close).toHaveBeenCalledOnce());
        const staleEvent = harness.eventListeners[0]!;
        const staleClosed = harness.closedListeners[0]!;
        harness.autoFinishPrompt = false;
        session.queue.push({ text: 'new generation turn', mode: createMode(), inputMode: 'prompt', localId: 'generation-2' });
        await waitForRequest('prompt');
        const ended = parseOmpInboundLine('{"type":"agent_end"}');
        if (ended.kind !== 'event') throw new Error('expected native end event');
        staleEvent(ended.event);
        staleClosed(new Error('old native closed late'));
        session.queue.close();
        let finished = false;
        void launch.then(() => { finished = true; });
        await Promise.resolve();
        expect(finished).toBe(false);
        harness.eventListeners[1]!(ended.event);
        await launch;
        expect(harness.connectArgs).toHaveLength(2);
    });

    it('retains an unconsumed queued message when exact history preflight rejects reopen', async () => {
        vi.stubEnv('HAPI_OMP_IDLE_HIBERNATE_MS', '1');
        const { session, consumedLocalIds } = createSessionStub([], { closeQueue: false });
        const launch = ompRemoteLauncher(session as never);
        await vi.waitFor(() => expect(harness.close).toHaveBeenCalledOnce());
        harness.resumeError = new Error('Original OMP journal is missing');
        session.queue.push({ text: 'keep this pending', mode: createMode(), inputMode: 'prompt', localId: 'pending-on-error' });
        await expect(launch).rejects.toThrow('Original OMP journal is missing');
        expect(harness.connectArgs).toHaveLength(1);
        expect(harness.prompts).toEqual([]);
        expect(consumedLocalIds).toEqual([]);
        expect(session.queue.size()).toBe(1);
    });

    it('keeps later queued input configuration on the model actually reported by native state', async () => {
        harness.currentModel = model('ollama', 'native-choice');
        const { session } = createSessionStub([], { launchModel: 'ollama/stale-row-choice' });
        await ompRemoteLauncher(session as never);
        expect(session.getModel()).toBe('ollama/native-choice');
    });
    it.each(['empty', 'invalid-command', 'failed-attachment'] as const)('retains never-persisted proof after %s and wakes empty history', async kind => {
        vi.stubEnv('HAPI_OMP_IDLE_HIBERNATE_MS', '1');
        const directory = await mkdtemp(join(tmpdir(), 'hapi-empty-wake-'));
        createdDirectories.push(directory);
        harness.sessionFile = join(directory, 'lazy.jsonl');
        harness.realPersistence = true;
        const { session, rpcHandlers, consumedLocalIds } = createSessionStub([{
            message: kind === 'empty' ? '   ' : kind === 'invalid-command' ? '/resume' : 'broken image',
            mode: createMode(), localId: kind,
            ...(kind === 'failed-attachment' ? { attachments: [{ id: 'missing', filename: 'missing.png', mimeType: 'image/png', size: 1, path: join(directory, 'missing.png') }] } : {})
        }], { closeQueue: false });
        const launch = ompRemoteLauncher(session as never);
        await vi.waitFor(() => expect(harness.close).toHaveBeenCalledOnce());
        expect(session.getNativeSession()?.persistence).toBe('never-persisted');
        expect(consumedLocalIds).toEqual([]);
        vi.stubEnv('HAPI_OMP_IDLE_HIBERNATE_MS', '100000');
        await rpcHandlers.get('listOmpModels')!(undefined);
        expect(harness.connectArgs).toHaveLength(2);
        expect(harness.connectArgs[1]).not.toHaveProperty('resumeSessionId');
        session.queue.close();
        await launch;
    });

    it('keeps admission evidence persisted even when a later empty state loses its native file', async () => {
        vi.stubEnv('HAPI_OMP_IDLE_HIBERNATE_MS', '1');
        const directory = await mkdtemp(join(tmpdir(), 'hapi-admitted-wake-'));
        createdDirectories.push(directory);
        harness.sessionFile = join(directory, 'lazy.jsonl');
        harness.realPersistence = true;
        const { session } = createSessionStub([{ message: 'native admission', mode: createMode(), localId: 'persisted-admission' }], { closeQueue: false });
        const launch = ompRemoteLauncher(session as never);
        await vi.waitFor(() => expect(harness.close).toHaveBeenCalledOnce());
        expect(session.getNativeSession()?.persistence).toBe('persisted');
        vi.stubEnv('HAPI_OMP_IDLE_HIBERNATE_MS', '100000');
        session.queue.push({ text: 'must resume exact history', mode: createMode(), inputMode: 'prompt', localId: 'second' });
        await waitForRequestCount('prompt', 2);
        expect(harness.connectArgs[1]).toMatchObject({ resumeSessionId: '/sessions/omp-session-1.jsonl' });
        session.queue.close();
        await launch;
    });

    it('disposes a half-initialized nonfatal model wake before allowing another generation', async () => {
        vi.stubEnv('HAPI_OMP_IDLE_HIBERNATE_MS', '1');
        const { session, rpcHandlers } = createSessionStub([], { closeQueue: false });
        const launch = ompRemoteLauncher(session as never);
        await vi.waitFor(() => expect(harness.close).toHaveBeenCalledOnce());
        vi.stubEnv('HAPI_OMP_IDLE_HIBERNATE_MS', '100000');
        const disposed = Promise.withResolvers<void>();
        harness.close.mockImplementationOnce(() => disposed.promise);
        harness.requestError = command => command.type === 'get_subagents' ? new Error('wake host initialization failed') : null;
        const handler = rpcHandlers.get('listOmpModels')!;
        const first = handler(undefined);
        await vi.waitFor(() => expect(harness.close).toHaveBeenCalledTimes(2));
        const concurrent = handler(undefined);
        expect(harness.connectArgs).toHaveLength(2);
        expect(harness.requests.filter(command => command.type === 'get_available_models')).toHaveLength(0);
        disposed.resolve();
        expect(await first).toMatchObject({ success: false, error: expect.stringContaining('initialization failed') });
        expect(await concurrent).toMatchObject({ success: false });
        expect(session.recordShutdownReceipt).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'disposed' }));
        harness.requestError = null;
        expect(await handler(undefined)).toMatchObject({ success: true });
        expect(harness.connectArgs).toHaveLength(3);
        session.queue.close();
        await launch;
    });

    it('gates every future wake after failed initialization has unverified native disposal', async () => {
        vi.stubEnv('HAPI_OMP_IDLE_HIBERNATE_MS', '1');
        const { session, rpcHandlers } = createSessionStub([], { closeQueue: false });
        const launch = ompRemoteLauncher(session as never);
        const rejected = expect(launch).rejects.toThrow();
        await vi.waitFor(() => expect(harness.close).toHaveBeenCalledOnce());
        vi.stubEnv('HAPI_OMP_IDLE_HIBERNATE_MS', '100000');
        harness.close.mockRejectedValue(new Error('EOF unverified'));
        harness.requestError = command => command.type === 'get_subagents' ? new Error('wake initialization failed') : null;
        const handler = rpcHandlers.get('listOmpModels')!;
        expect(await handler(undefined)).toMatchObject({ success: false });
        harness.requestError = null;
        expect(await handler(undefined)).toMatchObject({ success: false });
        expect(harness.connectArgs).toHaveLength(2);
        session.queue.close();
        await rejected;
        expect(session.recordShutdownReceipt).toHaveBeenCalledWith(expect.objectContaining({ status: 'unverified' }));
    });

    it('reports initialized host readiness while recovered admission waits for generation and blocks another idle prompt', async () => {
        harness.autoFinishPrompt = false;
        const recovered: OmpInputReceipt = { token: 'recovering', sessionId: harness.sessionId, admitted: true, delivered: false, channel: 'follow_up' };
        harness.recoveredReceipts = [recovered];
        const { session, sessionEvents } = createSessionStub([{ message: 'new input', mode: createMode(), localId: 'new' }], { closeQueue: false });
        const launch = ompRemoteLauncher(session as never);
        await vi.waitFor(() => expect(session.client.emitSessionReady).toHaveBeenCalled());
        expect(harness.prompts).toEqual([]);
        expect(sessionEvents.some(event => event.type === 'ready')).toBe(false);
        expect(harness.close).not.toHaveBeenCalled();
        emitEvent('input_receipt', { receipt: { ...recovered, delivered: true, ...deliveryProof('recovered-user') } });
        await waitForRequest('prompt');
        session.queue.close();
        emitEvent('agent_end');
        await launch;
        const types = harness.requests.map(command => command.type);
        expect(types.indexOf('set_host_tools')).toBeLessThan(types.indexOf('recover_inputs'));
        expect(types.indexOf('set_subagent_subscription')).toBeLessThan(types.indexOf('recover_inputs'));
    });

    it('uses the busy channel for an ordinary prompt while recovered steering is preparing', async () => {
        const recovered: OmpInputReceipt = { token: 'recovering-steer', sessionId: harness.sessionId, admitted: true, delivered: false, channel: 'steer' };
        harness.recoveredReceipts = [recovered];
        const { session } = createSessionStub([{ message: 'queued behind preparation', mode: createMode(), localId: 'new' }], { closeQueue: false });
        const launch = ompRemoteLauncher(session as never);
        await waitForRequest('prompt');
        expect(harness.requests.find(command => command.type === 'prompt')).toMatchObject({ streamingBehavior: 'followUp' });
        emitEvent('input_receipt', { receipt: { ...recovered, outcome: 'cancelled' } });
        session.queue.close();
        await launch;
    });

    it('clears the final follow-up channel when it is cancelled before the remaining steer', async () => {
        vi.stubEnv('HAPI_OMP_IDLE_HIBERNATE_MS', '1');
        harness.autoFinishPrompt = false;
        harness.receiptDelivered = false;
        harness.stateStreaming = true;
        const { session, sessionEvents } = createSessionStub([
            { message: 'follow up', mode: createMode(), inputMode: 'follow_up', localId: 'follow' },
            { message: 'steer', mode: createMode(), inputMode: 'steer', localId: 'steer' }
        ], { closeQueue: false });
        const launch = ompRemoteLauncher(session as never);
        await waitForRequest('steer');
        await vi.waitFor(() => expect(session.queue.heldSize()).toBe(0));
        expect(await session.cancelQueuedInput('follow')).toBe(true);
        expect(await session.cancelQueuedInput('steer')).toBe(true);
        harness.stateStreaming = false;
        emitEvent('agent_end');
        await vi.waitFor(() => expect(sessionEvents.some(event => event.type === 'ready')).toBe(true));
        await vi.waitFor(() => expect(harness.close).toHaveBeenCalledOnce());
        session.queue.close();
        await launch;
    });

    it('does not retain handled host-command replays or wake native to cancel them', async () => {
        vi.stubEnv('HAPI_OMP_IDLE_HIBERNATE_MS', '1');
        const { session } = createSessionStub([{ message: '/rename old command', mode: createMode(), localId: 'handled' }], { closeQueue: false });
        const store = session.getInputDeliveryStore();
        store.begin('handled', harness.sessionId);
        store.resolveHostInput('handled');
        const launch = ompRemoteLauncher(session as never);
        await vi.waitFor(() => expect(harness.close).toHaveBeenCalledOnce());
        expect(await session.cancelQueuedInput('handled')).toBe(false);
        expect(harness.connectArgs).toHaveLength(1);
        expect(harness.requests.some(command => command.type === 'set_session_name' || command.type === 'remove_queued_message')).toBe(false);
        session.queue.close();
        await launch;
    });

    it('publishes recovered complete delivery proof before buffered native replies', async () => {
        const { session, publications, deliveryCalls } = createSessionStub([], { sessionId: harness.sessionId });
        const proof: OmpInputReceipt = {
            token: 'restored', sessionId: harness.sessionId, admitted: true, delivered: true,
            ...deliveryProof('committed-user'),
            nativeOrder: { sessionId: harness.sessionId, entryId: 'committed-user', entryOrder: 1, eventOrder: 0 }
        };
        session.getInputDeliveryStore().begin('restored', harness.sessionId, 'restored');
        harness.nativeReceipts.set('restored', proof);
        harness.beforeRequest = async command => {
            if (command.type === 'get_subagents') {
                emitEvent('message_end', {
                    nativeOrder: { sessionId: harness.sessionId, entryId: 'recorded-reply', entryOrder: 2, eventOrder: 0 },
                    message: {
                        role: 'assistant', content: [{ type: 'text', text: 'recorded reply' }],
                        provider: 'ollama', model: 'launch-default', stopReason: 'stop',
                        usage: {
                            input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
                            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
                        },
                        timestamp: Date.parse('2026-11-07T01:00:01.000Z')
                    }
                });
                expect(publications).toEqual([]);
            }
            if (command.type === 'recover_inputs') {
                expect(publications).toEqual(['consumed:restored']);
            }
        };
        await ompRemoteLauncher(session as never);
        expect(publications).toEqual(['consumed:restored', 'canonical']);
        expect(deliveryCalls).toEqual([{ localIds: ['restored'], options: { nativeDelivery: { sessionId: harness.sessionId, entryId: 'committed-user', deliveredAt: proof.deliveredAt, entryOrder: proof.deliveredOrder } } }]);
    });
    it('treats asynchronous attachment preparation as busy before any native admission exists', async () => {
        vi.stubEnv('HAPI_OMP_IDLE_HIBERNATE_MS', '100000');
        const { session, rpcHandlers } = createSessionStub([], { closeQueue: false });
        const launch = ompRemoteLauncher(session as never);
        await vi.waitFor(() => expect(session.client.emitSessionReady).toHaveBeenCalled());
        const preparing = Promise.withResolvers<void>();
        const prepared = Promise.withResolvers<void>();
        const original = OmpInputContent.prepareOmpInput;
        const prepare = vi.spyOn(OmpInputContent, 'prepareOmpInput').mockImplementationOnce(async (text, attachments) => {
            preparing.resolve();
            await prepared.promise;
            return await original(text, attachments);
        });
        try {
            session.queue.push({ text: 'preparing input', mode: createMode(), inputMode: 'prompt', localId: 'preparing' });
            await preparing.promise;
            expect(await rpcHandlers.get('cycleOmpModel')!(undefined)).toMatchObject({ success: false, error: expect.stringContaining('idle') });
            expect(harness.requests.some(command => command.type === 'cycle_model')).toBe(false);
            expect(harness.close).not.toHaveBeenCalled();
        } finally {
            prepared.resolve();
            prepare.mockRestore();
            session.queue.close();
            await launch;
        }
    });
    it.each([undefined, false])('rejects token dispatch before execution when nativeOrder capability is %s', async capability => {
        harness.nativeOrderCapability = capability;
        const { session, consumedLocalIds } = createSessionStub([{ message: 'must not execute on receipt-only binary', mode: createMode(), localId: 'unsupported' }]);
        await expect(ompRemoteLauncher(session as never)).rejects.toThrow('nativeOrder');
        expect(harness.requests.some(command => command.type === 'prompt' || command.type === 'recover_inputs' || command.type === 'get_input_receipts')).toBe(false);
        expect(session.getInputDeliveryStore().hasNativeAttempt('unsupported')).toBe(false);
        expect(consumedLocalIds).toEqual([]);
        expect(session.queue.size()).toBe(1);
    });

    it('rejects sidecar recovery on receipt-only binaries without querying or reexecuting native input', async () => {
        harness.nativeOrderCapability = undefined;
        const { session } = createSessionStub([], { sessionId: harness.sessionId });
        session.getInputDeliveryStore().begin('recover-unsupported', harness.sessionId, 'recover-unsupported');
        await expect(ompRemoteLauncher(session as never)).rejects.toThrow('nativeOrder');
        expect(harness.requests.some(command => command.type === 'prompt' || command.type === 'recover_inputs' || command.type === 'get_input_receipts')).toBe(false);
        expect(session.getInputDeliveryStore().pendingTokenReceipts()).toHaveLength(1);
    });

    it('preserves tokenless execution when native does not advertise ordered receipt support', async () => {
        harness.nativeOrderCapability = undefined;
        const { session } = createSessionStub([{ message: 'legacy tokenless input', mode: createMode() }]);
        await ompRemoteLauncher(session as never);
        expect(harness.prompts).toEqual(['legacy tokenless input']);
        expect(harness.requests.some(command => command.type === 'recover_inputs')).toBe(false);
    });
});
