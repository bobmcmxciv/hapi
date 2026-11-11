import React from 'react';
import { logger } from '@/ui/logger';
import { convertAgentMessage } from '@/agent/messageConverter';
import {
    RemoteLauncherBase,
    type RemoteLauncherDisplayContext,
    type RemoteLauncherExitReason
} from '@/modules/common/remote/RemoteLauncherBase';
import { OmpDisplay } from '@/ui/ink/OmpDisplay';
import type { OmpSession, OmpShutdownReceipt } from './session';
import type { OmpRuntimeConfigApplied, OmpRuntimeConfigRequest } from './session';
import type { PermissionMode } from './types';
import type { OmpNativeSession } from '@hapi/protocol/types';
import type { ForceQueuedMessageAck } from '@hapi/protocol';
import { RPC_METHODS } from '@hapi/protocol/rpcMethods';
import { buildOmpEnv } from './utils/config';
import { OmpRpcClient } from './rpc/OmpRpcClient';
import { OmpRpcConnectionError, OmpRpcRequestError } from './rpc/OmpRpcTransport';
import { OmpRpcEventAdapter, type OmpNativeOrder } from './rpc/OmpRpcEventAdapter';
import { loadOmpEventAllowlist } from './rpc/eventAllowlist';
import { parseOmpInputReceipt } from './rpc/schemas';
import type {
    OmpCommandByType,
    OmpResponseData,
    OmpContextUsage,
    OmpInboundEvent,
    OmpInputReceipt,
    OmpKnownEventType,
    OmpModel,
    OmpRpcSpawnConfig,
    OmpSubagentSnapshot,
    OmpSessionState
} from './rpc/types';
import type { AgentMessage } from '@/agent/types';
import type {
    ListOmpModelsResponse,
    ListOmpThinkingOptionsResponse,
    CycleOmpModelResponse,
    OmpModelSummary,
    OmpThinkingOption
} from '@hapi/protocol/apiTypes';
import {
    OMP_THINKING_LEVELS,
    type OmpConfiguredThinkingLevel,
    type OmpEffort,
    type OmpThinkingState
} from '@hapi/protocol/omp';
import {
    nativeSessionSnapshotWithPersistence,
    OmpSessionStateReconciler,
    parseOmpSessionMutation,
    runOmpSessionMutation,
    type OmpSessionMutationCommand,
} from './rpc/sessionLifecycle';
import { prepareOmpSessionResume, resolveOmpSessionPath } from './utils/ompSessionScanner';
import type { OmpQueuedInput } from './OmpInputQueue';
import { OmpInputReceiptsUnsupportedError, OmpInputTokenConflictError, OmpUncertainDeliveryError, recoverOmpInputReceipts } from './OmpInputDeliveryStore';
import { prepareOmpInput, type PreparedOmpInput } from './ompInputContent';
import { OmpHostIntegration } from '../../../fork-features/omp-host-integration/cli';
import { startOmpSessionRelay, type OmpSessionRelay } from '../../../fork-features/session-relay/omp';

type PromptLifecycle = {
    phase: 'awaiting-agent' | 'streaming';
    modeHash: string;
    ignoreAgentEnds: number;
};

const DEFAULT_OMP_IDLE_HIBERNATE_MS = 15 * 60 * 1_000;

function resolveOmpIdleHibernateMs(): number {
    const raw = process.env.HAPI_OMP_IDLE_HIBERNATE_MS;
    if (raw !== undefined) {
        const parsed = Number(raw);
        if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed);
    }
    if (process.env.VITEST || process.env.NODE_ENV === 'test') return 0;
    return DEFAULT_OMP_IDLE_HIBERNATE_MS;
}
class OmpRemoteLauncher extends RemoteLauncherBase {
    private readonly session: OmpSession;
    private client: OmpRpcClient | null = null;
    #eventAdapter: OmpRpcEventAdapter | null = null;
    private currentPrompt: PromptLifecycle | null = null;
    private heldInput: OmpQueuedInput | null = null;
    private nativeFollowUpOutstanding = false;
    private isStreaming = false;
    private nativeTurnGeneration = 0;
    private dispatching = false;
    private transportFailure: Error | null = null;
    private displayModel: string | null = null;
    private displayPermissionMode: PermissionMode | null = null;
    private currentModel: OmpModel | null = null;
    private defaultModel: OmpModel | null = null;
    private availableModels: OmpModel[] = [];
    private contextUsage: OmpContextUsage | null = null;
    private thinkingState: OmpThinkingState = {
        thinkingLevel: null,
        configured: null,
        resolved: null
    };
    private confirmedConfiguredThinking: OmpConfiguredThinkingLevel | null = null;
    private lastPersistedThinkingKey: string | null = null;
    private pendingModel: { hasValue: boolean; value: string | null | undefined } = {
        hasValue: false,
        value: undefined
    };
    private pendingThinking: OmpConfiguredThinkingLevel | undefined = undefined;
    private readyInFlight: Promise<void> | null = null;
    private readyEmittedForIdleCycle = false;
    private readyCheckedForIdleCycle = false;
    private readonly bufferedInputIds = new Set<number>();
    private readonly pendingNativeInputs = new Map<string, OmpQueuedInput>();
    private readonly undeliveredNativeTokens = new Map<string, OmpInputReceipt['channel']>();
    private preparingInput = false;
    #failedClient: OmpRpcClient | null = null;
    private readonly eventTasks = new Set<Promise<void>>();
    private hostIntegration: OmpHostIntegration | null = null;
    private registeredHostToolNames: string[] = [];
    private lastPersistedToolsKey: string | null = null;
    private lastPersistedCommandsKey: string | null = null;
    private readonly subagentTranscriptCursors = new Map<string, number>();
    private sessionReconciler: OmpSessionStateReconciler | null = null;
    private removeQueueChangeListener: (() => void) | null = null;
    private changeVersion = 0;
    private changeWaiter: (() => void) | null = null;
    // fork(session-relay)
    private sessionRelay: OmpSessionRelay | null = null;
    private readonly nativeExit = Promise.withResolvers<OmpShutdownReceipt>();
    private unregisterShutdown: (() => void) | null = null;
    private unregisterInputCancellation: (() => void) | null = null;
    private unregisterInputForcing: (() => void) | null = null;
    private attemptedNativeLaunch = false;
    private hibernating = false;
    private wakePromise: Promise<OmpRpcClient> | null = null;
    #hibernatePromise: Promise<void> | null = null;
    #lastNativeReceipt: OmpShutdownReceipt | null = null;
    #nativeIdentityVerified = false;
    private eventAllowlist: ReadonlySet<OmpKnownEventType> | null = null;
    #onUserMessageReplay = (localId: string): void => {
        try { this.#replayTerminalInput(localId); }
        catch (error) { this.handleTransportFailure(error instanceof Error ? error : new Error(String(error))); }
    };
    constructor(session: OmpSession) {
        super(process.env.DEBUG ? session.logPath : undefined);
        this.session = session;
        this.unregisterInputCancellation = session.registerNativeInputCanceller(async localId => await this.cancelNativeInput(localId));
        this.unregisterInputForcing = session.registerNativeInputForcer(localId => this.forceNativeInput(localId));
        session.client.on('user-message-replay', this.#onUserMessageReplay);
        this.unregisterShutdown = session.registerShutdownHandle({
            requestExit: () => this.handleExitFromUi(),
            waitForExit: async () => {
                const receipt = await this.nativeExit.promise;
                const client = this.client ?? this.#failedClient;
                if (receipt.status !== 'unverified' || !client) return receipt;
                return await this.closeOwnedNativeClient(client);
            }
        });
    }

    public async launch(): Promise<RemoteLauncherExitReason> {
        return this.start({
            onExit: () => this.handleExitFromUi(),
            onSwitchToLocal: () => this.handleSwitchFromUi()
        });
    }

    protected createDisplay(context: RemoteLauncherDisplayContext): React.ReactElement {
        return React.createElement(OmpDisplay, context);
    }

    protected onLeavingRemote(): void {
        this.session.client.clearSessionReady();
    }

    private async connectNativeClient(): Promise<OmpRpcClient> {
        const eventAllowlist = this.eventAllowlist ?? (await loadOmpEventAllowlist());
        this.eventAllowlist = eventAllowlist;
        const session = this.session;
        const requestedSpawnModel = this.currentModel
            ? `${this.currentModel.provider}/${this.currentModel.id}`
            : session.getModel();
        const spawnBase = {
            cwd: session.path,
            env: {
                ...buildOmpEnv(),
                PI_RPC_EMIT_TITLE: '1'
            },
            model: typeof requestedSpawnModel === 'string' ? requestedSpawnModel : undefined
        };
        let expectedSessionId = session.sessionId;
        let previousNative = session.getNativeSession();
        const deliveryStore = session.getInputDeliveryStore();
        deliveryStore.assertCanStart();
        if (previousNative?.persistence === 'never-persisted') {
            const nativeId = previousNative.id;
            const hasAdmission = deliveryStore.nativeReceiptRecords().some(({ receipt }) => receipt.sessionId === nativeId && receipt.admitted);
            const hasAttempt = deliveryStore.pendingTokenReceipts().some(receipt => receipt.nativeSessionId === nativeId);
            if (hasAdmission || hasAttempt) {
                const { persistence: _persistence, ...identity } = previousNative;
                previousNative = hasAdmission ? { ...identity, persistence: 'persisted' } : identity;
                session.applyNativeSessionSnapshot(previousNative);
            }
        }
        const resume = expectedSessionId
            ? await prepareOmpSessionResume(expectedSessionId, previousNative ?? undefined, session.path)
            : null;
        if (resume?.kind === 'empty') expectedSessionId = null;
        const startupHistory: OmpNativeSession | null = resume?.kind === 'resume' && expectedSessionId
            ? { ...previousNative, id: expectedSessionId, file: resume.sessionFile, persistence: 'persisted' }
            : null;
        const spawnConfig: OmpRpcSpawnConfig = resume?.kind === 'resume'
            ? { ...spawnBase, resumeSessionId: resume.sessionFile }
            : spawnBase;
        if (this.shouldExit || this.session.isShutdownRequested()) {
            throw new Error('OMP session is shutting down');
        }
        this.attemptedNativeLaunch = true;
        this.#lastNativeReceipt = null;
        this.#nativeIdentityVerified = false;
        let client: OmpRpcClient;
        try {
            client = await OmpRpcClient.connect(spawnConfig);
        } catch (error) {
            if (error instanceof OmpRpcConnectionError) {
                this.#lastNativeReceipt = error.shutdownReceipt;
                this.session.recordShutdownReceipt(error.shutdownReceipt);
            }
            throw error;
        }
        this.client = client;
        try {
            if (this.shouldExit || this.session.isShutdownRequested()) {
                throw new Error('OMP session is shutting down');
            }
            if (expectedSessionId && client.discovery.state.sessionId !== expectedSessionId) {
                throw new Error(`OMP resumed a different native session: expected ${expectedSessionId}, received ${client.discovery.state.sessionId}`);
            }
            this.#nativeIdentityVerified = true;
            this.availableModels = client.discovery.models;
            this.currentModel = client.discovery.state.model ?? null;
            if (!this.defaultModel) {
                this.defaultModel = this.currentModel;
            }
            this.isStreaming = client.discovery.state.isStreaming;
            this.contextUsage = client.discovery.state.contextUsage ?? null;
            const persistedConfigured = this.asConfiguredThinking(session.getEffort());
            this.thinkingState = {
                thinkingLevel: client.discovery.state.thinkingLevel ?? null,
                configured: persistedConfigured ?? client.discovery.state.thinkingLevel ?? null,
                resolved: null
            };
            this.confirmedConfiguredThinking = client.discovery.state.thinkingLevel ?? null;
            this.persistRuntimeState(client.discovery.state);

            logger.debug(
                `[omp-remote] RPC ${client.discovery.version} ready; `
                + `session=${client.discovery.state.sessionId} commands=${client.discovery.commands.length} `
                + `models=${client.discovery.models.length}`
            );
            const sessionReconciler = new OmpSessionStateReconciler(
                client,
                (snapshot) => {
                    if (this.client === client && !this.hibernating && !this.shouldExit) {
                        session.applyNativeSessionSnapshot(snapshot);
                    }
                },
                () => session.getNativeSession() ?? startupHistory
            );
            this.sessionReconciler = sessionReconciler;
            const hostIntegration = new OmpHostIntegration({
                client,
                eventAllowlist,
                cwd: session.path,
                sessionClient: session.client,
                onFatal: (error) => this.handleTransportFailure(error)
            });
            this.hostIntegration = hostIntegration;

            const eventAdapter = new OmpRpcEventAdapter({
                onRuntimePublication: (publication) => session.client.publishRuntime(publication),
                onAgentMessage: (message, nativeOrder) => {
                    this.forwardAgentMessage(message, nativeOrder);
                },
                onCanonicalMessage: (message, nativeOrder) => {
                    session.client.sendClaudeSessionMessage(message, { nativeOrder });
                },
                onAgentRunEvent: (event, nativeOrder) => {
                    session.sendAgentMessage(event, { nativeOrder });
                },
                onAgentRunTrace: (scope, message, nativeOrder) => {
                    const converted = convertAgentMessage(message);
                    if (!converted) return;
                    session.sendAgentMessage({
                        type: 'agent-run-trace',
                        ...scope,
                        message: converted
                    }, { nativeOrder });
                },
                onStructuredEvent: (event, nativeOrder) => {
                    session.sendAgentMessage(event, { nativeOrder });
                    if (event.type === 'omp-compaction' && event.phase === 'finished' && event.outcome === 'completed') {
                        this.sessionRelay?.controller.onCompactionCompleted();
                    }
                },
                onInkMessage: (message, type) => this.messageBuffer.addMessage(message, type),
                onUserMessageCommitted: (steering) => {
                    if (!steering) {
                        this.reconcileNativeFollowUpOutstanding();
                        this.signalChange();
                    }
                },
                onTurnStarted: () => {
                    this.nativeTurnGeneration += 1;
                    this.isStreaming = true;
                    this.readyEmittedForIdleCycle = false;
                    this.readyCheckedForIdleCycle = false;
                    if (this.currentPrompt) {
                        this.currentPrompt.phase = 'streaming';
                    }
                    session.onThinkingChange(true);
                    this.signalChange();
                },
                onTurnFinished: () => {
                    this.isStreaming = false;
                    this.readyCheckedForIdleCycle = false;
                    if (this.currentPrompt?.ignoreAgentEnds) {
                        this.currentPrompt.ignoreAgentEnds -= 1;
                    } else {
                        this.clearCurrentPrompt();
                    }
                    this.signalChange();
                    void sessionReconciler.reconcile().catch((error) => {
                        this.handleTransportFailure(error);
                    });
                    void this.sendReadyIfIdle();
                    this.sessionRelay?.controller.onTurnFinished();
                },
                onPromptResult: (agentInvoked, failure) => {
                    if (failure) {
                        logger.warn(`[omp-remote] OMP prompt failed before reaching the agent: ${failure}`);
                        this.reportInputFailure(failure);
                    }
                    if (!agentInvoked) {
                        this.readyCheckedForIdleCycle = false;
                        this.clearCurrentPrompt();
                        this.signalChange();
                        void sessionReconciler.reconcile().catch((error) => {
                            this.handleTransportFailure(error);
                        });
                        void this.sendReadyIfIdle();
                    }
                },
                onSessionInfoUpdate: () => {
                    void sessionReconciler.reconcile().catch((error) => {
                        this.handleTransportFailure(error);
                    });
                    this.trackEventTask(this.refreshRuntimeState());
                },
                onAvailableCommandsChanged: (commands) => {
                    this.persistDiscoveredCapabilities({
                        slashCommands: commands.map((command) => command.name)
                    });
                },
                onThinkingStateChanged: (state) => this.handleThinkingStateChanged(state),
                onDiagnostic: (message) => logger.warn(`[omp-remote] ${message}`),
                onHostEvent: (event) => hostIntegration.handle(event)
            }, eventAllowlist);
            this.#eventAdapter = eventAdapter;
            const bufferedEvents: OmpInboundEvent[] = [];
            let subagentSnapshotApplied = false;
            client.onEvent((event) => {
                if (this.client !== client || this.hibernating || this.shouldExit) return;
                if (event.type === 'input_receipt') {
                    try { this.applyNativeInputReceipt(client, parseOmpInputReceipt(event.raw.receipt)); }
                    catch (error) { this.handleTransportFailure(error); }
                    return;
                }
                if (!subagentSnapshotApplied) {
                    bufferedEvents.push(event);
                    return;
                }
                eventAdapter.handle(event);
            });
            client.onDiagnostic((message) => logger.warn(`[omp-remote] ${message}`));
            client.onClosed((reason) => {
                if (this.shouldExit || this.hibernating || this.client !== client) {
                    return;
                }
                this.handleTransportFailure(reason);
            });

            const { hostToolNames } = await hostIntegration.initialize();
            this.registeredHostToolNames = hostToolNames;
            this.persistDiscoveredCapabilities({
                tools: [
                    ...(client.discovery.state.dumpTools?.map((tool) => tool.name) ?? []),
                    ...hostToolNames
                ],
                slashCommands: client.discovery.commands.map((command) => command.name)
            });
            await client.request({ type: 'set_subagent_subscription', level: 'events' });
            const { subagents } = await client.request({ type: 'get_subagents' });
            // Query committed delivery before publishing any buffered historical output.
            // Recovery itself runs only after host tools, subscriptions and config exist.
            if (persistedConfigured) {
                await this.applyRequestedThinking(persistedConfigured, client);
            }
            await this.#refreshNativeHistoryEvidence(client, startupHistory, client.discovery.state);
            if (this.shouldExit || session.isShutdownRequested()) {
                throw new Error('OMP session is shutting down');
            }
            const publishedDeliveries = new Set<string>();
            const reconcileReceipts = async () => {
                const store = session.getInputDeliveryStore();
                const acceptedIds = await recoverOmpInputReceipts(
                    store, client.discovery.state.sessionId,
                    client.discovery.state.capabilities?.inputReceipts === true && client.discovery.state.capabilities.nativeOrder === true,
                    async tokens => (await client.request({ type: 'get_input_receipts', tokens })).receipts
                );
                for (const { receipt } of store.nativeReceiptRecords()) this.applyNativeInputReceipt(client, receipt);
                for (const id of acceptedIds) {
                    if (publishedDeliveries.has(id)) continue;
                    this.emitNativeDelivery(id, store.nativeReceipt(id)!);
                    publishedDeliveries.add(id);
                }
                session.client.sendMessagesResolved(store.resolvedInputs());
                for (const receipt of store.pendingTokenReceipts()) {
                    this.undeliveredNativeTokens.set(receipt.clientToken, store.nativeReceipt(receipt.localId)?.channel);
                }
                this.reconcileNativeFollowUpOutstanding();
            };
            await reconcileReceipts();
            if (client.discovery.state.capabilities?.inputReceipts === true && client.discovery.state.capabilities.nativeOrder === true) {
                const recovered = await client.request({ type: 'recover_inputs' });
                for (const receipt of recovered.receipts) this.applyNativeInputReceipt(client, receipt);
                await reconcileReceipts();
            }
            if (this.transportFailure) throw this.transportFailure;
            eventAdapter.seedSubagents(subagents);
            for (const event of bufferedEvents.splice(0)) eventAdapter.handle(event);
            subagentSnapshotApplied = true;
            await Promise.all(subagents.map(async snapshot => {
                await this.syncSubagentTranscript(client, eventAdapter, snapshot);
            }));
            if (this.sessionRelay) session.client.emitSessionReady({ replayOnReconnect: true });
            return client;
        } catch (error) {
            // Fence callbacks before disposal, even when a nonfatal model RPC woke us.
            this.client = null;
            this.#nativeIdentityVerified = false;
            this.session.client.clearSessionReady();
            const reconciler = this.sessionReconciler;
            this.sessionReconciler = null;
            const host = this.hostIntegration;
            this.hostIntegration = null;
            this.#eventAdapter?.closeRuntime();
            this.#eventAdapter = null;
            const cleanup = await Promise.allSettled([
                reconciler?.drain(),
                host?.close('OMP native initialization failed'),
                this.closeOwnedNativeClient(client)
            ]);
            this.subagentTranscriptCursors.clear();
            this.registeredHostToolNames = [];
            this.lastPersistedToolsKey = null;
            this.lastPersistedCommandsKey = null;
            const failures = cleanup.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
            if (failures.length > 0) {
                const failure = new AggregateError([error, ...failures.map(result => result.reason)], 'OMP initialization failed and cleanup was incomplete');
                this.handleTransportFailure(failure);
                throw failure;
            }
            throw error;
        }
    }

    // 'disposed' requires a clean EOF disposal (close() only resolves after a
    // code-0, signal-free exit). A nonzero/signal exit does not prove the
    // broker-hosted tools/subagents released their state, so a failed close
    // keeps 'unverified' and remains retryable through #failedClient.
    #receiptForExit(exit: OmpRpcClient['exitInfo']): OmpShutdownReceipt {
        return {
            kind: 'omp-rpc',
            status: 'disposed',
            pid: exit?.pid,
            exitCode: exit?.code,
            signal: exit?.signal
        };
    }

    private async closeOwnedNativeClient(client: OmpRpcClient): Promise<OmpShutdownReceipt> {
        try {
            await client.close();
        } catch (error) {
            this.#failedClient = client;
            this.#lastNativeReceipt = { kind: 'omp-rpc', status: 'unverified' };
            this.session.recordShutdownReceipt(this.#lastNativeReceipt);
            throw error;
        }
        if (this.#failedClient === client) this.#failedClient = null;
        this.#lastNativeReceipt = this.#receiptForExit(client.exitInfo);
        this.session.recordShutdownReceipt(this.#lastNativeReceipt);
        return this.#lastNativeReceipt;
    }

    private async ensureClient(): Promise<OmpRpcClient> {
        // EOF disposal and full native initialization are ownership barriers, not
        // merely spawn barriers. Never expose a closing or half-initialized writer.
        if (this.#hibernatePromise) await this.#hibernatePromise;
        if (this.wakePromise) return await this.wakePromise;
        if (this.shouldExit || this.session.isShutdownRequested()) {
            throw new Error('OMP session is shutting down');
        }
        if (this.transportFailure) throw this.transportFailure;
        if (this.#lastNativeReceipt?.status === 'unverified') throw new Error('OMP native writer disposal is unverified');
        if (this.client) return this.client;
        const promise = this.connectNativeClient().finally(() => {
            if (this.wakePromise === promise) {
                this.wakePromise = null;
                this.signalChange();
            }
        });
        this.wakePromise = promise;
        return await promise;
    }

    private async tryHibernateIdleClient(): Promise<void> {
        if (this.#hibernatePromise) return await this.#hibernatePromise;
        const promise = this.hibernateIdleClient().finally(() => {
            if (this.#hibernatePromise === promise) this.#hibernatePromise = null;
        });
        this.#hibernatePromise = promise;
        return await promise;
    }

    private async hibernateIdleClient(): Promise<void> {
        const client = this.client;
        if (!client || client.state !== 'ready' || this.shouldExit || this.hasUnfinishedNativeInput() || this.hasLocalPendingInput()) {
            return;
        }
        try {
            const state = await client.request({ type: 'get_state' });
            this.persistRuntimeState(state);
            if (state.isStreaming || state.queuedMessageCount > 0) return;
            const { subagents } = await client.request({ type: 'get_subagents' });
            if (subagents.some((s) => s.status === 'running')) return;
            if (this.shouldExit || this.client !== client || this.hasUnfinishedNativeInput() || this.hasLocalPendingInput()) {
                return;
            }
            this.hibernating = true;
            await this.#refreshNativeHistoryEvidence(client, undefined, state);
            await this.sessionReconciler?.drain();
            this.sessionReconciler = null;
            const hostIntegration = this.hostIntegration;
            this.hostIntegration = null;
            if (hostIntegration) {
                await hostIntegration.close('OMP remote session hibernated while idle');
            }
            await client.close();
            this.#lastNativeReceipt = this.#receiptForExit(client.exitInfo);
            this.session.recordShutdownReceipt(this.#lastNativeReceipt);
            this.client = null;
            this.#eventAdapter?.closeRuntime();
            this.#eventAdapter = null;
            logger.debug('[omp-remote] Hibernated idle OMP RPC subprocess to reclaim memory');
        } catch (error) {
            if (this.hibernating) this.handleTransportFailure(error);
            logger.debug('[omp-remote] Idle hibernate check skipped', error);
        } finally {
            this.hibernating = false;
        }
    }

    protected async runMainLoop(): Promise<void> {
        this.session.client.clearSessionReady();
        this.session.getInputDeliveryStore().assertCanStart();
        if (this.session.isShutdownRequested()) return;
        const session = this.session;
        await this.ensureClient();
        this.removeQueueChangeListener = session.queue.onChange(() => this.signalChange());
        session.client.rpcHandlerManager.registerHandler<Record<string, never>, ListOmpModelsResponse>(
            RPC_METHODS.ListOmpModels,
            async () => await this.listModels()
        );
        session.client.rpcHandlerManager.registerHandler<Record<string, never>, ListOmpThinkingOptionsResponse>(
            RPC_METHODS.ListOmpThinkingOptions,
            async () => await this.listThinkingOptions()
        );
        session.client.rpcHandlerManager.registerHandler<Record<string, never>, CycleOmpModelResponse>(
            RPC_METHODS.CycleOmpModel,
            async () => await this.cycleModel()
        );
        session.setRuntimeConfigApplier(async (config) => await this.applyRuntimeConfig(config));

        // connectNativeClient restores configured thinking before exposing readiness.

        this.setupAbortHandlers(session.client.rpcHandlerManager, {
            onAbort: () => this.handleAbort(),
            onSwitch: () => this.handleSwitchRequest()
        });

        this.applyDisplayMode(
            session.getPermissionMode() as PermissionMode | undefined,
            this.currentModel?.id
        );
        // Native startup readiness is a socket barrier, distinct from the idle chat event.
        session.client.emitSessionReady({ replayOnReconnect: true });
        await this.sendReadyIfIdle();
        this.sessionRelay = await startOmpSessionRelay({
            cwd: session.path,
            hubSessionId: session.client.sessionId,
            launchSettings: () => {
                const machineId = session.client.getMetadata()?.machineId;
                if (!machineId) return null;
                const model = this.currentModel ? `${this.currentModel.provider}/${this.currentModel.id}` : undefined;
                const effort = this.thinkingState.configured ?? undefined;
                const permissionMode = session.getPermissionMode() as string | undefined;
                return { machineId, model, effort, permissionMode };
            },
            readContextUsage: async () => {
                if (!this.client) {
                    return this.contextUsage
                        ? { tokens: this.contextUsage.tokens, contextWindow: this.contextUsage.contextWindow }
                        : null;
                }
                const state = await this.client.request({ type: 'get_state' });
                const usage = state.contextUsage;
                return usage ? { tokens: usage.tokens, contextWindow: usage.contextWindow } : null;
            },
            isIdle: () => !this.hasUnfinishedNativeInput() && !this.hasLocalPendingInput(),
            abortRun: () => this.handleAbort(),
            notify: (message) => {
                session.sendSessionEvent({ type: 'message', message });
                this.messageBuffer.addMessage(message, 'status');
            }
        });

        while (!this.shouldExit) {
            if (this.transportFailure) {
                throw this.transportFailure;
            }

            if (this.heldInput && !session.queue.isHeld(this.heldInput)) {
                this.heldInput = null;
                continue;
            }
            if (!this.heldInput) {
                this.heldInput = session.queue.take();
                if (this.heldInput) {
                    continue;
                }
            }

            if (this.heldInput?.localId && session.getInputDeliveryStore().isAdmitted(this.heldInput.localId)) {
                const input = this.heldInput;
                if (session.getInputDeliveryStore().isPendingNativeInput(input.localId!)) this.pendingNativeInputs.set(input.localId!, input);
                if (session.queue.isForced(input)) await this.forceNativeInput(input.localId!);
                session.queue.releaseInvocation(input);
                this.heldInput = null;
                continue;
            }
            if (this.heldInput && this.canDispatch(this.heldInput)) {
                const input = this.heldInput;
                const activeClient = await this.ensureClient();
                await this.dispatchInput(input, activeClient);
                if (this.heldInput?.id === input.id && !session.queue.isHeld(input)) {
                    this.heldInput = null;
                }
                continue;
            }

            if (
                session.queue.isClosed()
                && session.queue.size() === 0
                && session.queue.heldSize() === 0
                && !this.hasUnfinishedNativeInput()
            ) {
                break;
            }

            const observedVersion = this.changeVersion;
            const hibernateMs = this.client && !this.hasUnfinishedNativeInput() && !this.hasLocalPendingInput()
                ? resolveOmpIdleHibernateMs()
                : 0;
            if (hibernateMs > 0) {
                const { promise: timeoutPromise, resolve: resolveTimeout } = Promise.withResolvers<boolean>();
                const timer = setTimeout(() => resolveTimeout(true), hibernateMs);
                timer.unref?.();
                const timedOut = await Promise.race([
                    this.waitForChange(observedVersion).then(() => false),
                    timeoutPromise
                ]).finally(() => {
                    clearTimeout(timer);
                });
                if (timedOut && this.changeVersion === observedVersion) {
                    await this.tryHibernateIdleClient();
                }
            } else {
                await this.waitForChange(observedVersion);
            }
        }
    }

    protected async cleanup(): Promise<void> {
        this.session.client.clearSessionReady();
        // A concurrent model/readiness RPC can be waking a hibernated session.
        // Wait for that generation before collecting its disposal receipt.
        await this.#hibernatePromise;
        await this.wakePromise?.catch(() => undefined);
        this.#eventAdapter?.closeRuntime();
        this.#eventAdapter = null;
        try {
            this.sessionRelay?.stop();
            this.sessionRelay = null;
            this.clearAbortHandlers(this.session.client.rpcHandlerManager);
            this.session.setRuntimeConfigApplier(null);
            this.unregisterInputCancellation?.();
            this.unregisterInputCancellation = null;
            this.unregisterInputForcing?.();
            this.unregisterInputForcing = null;
            this.session.client.off('user-message-replay', this.#onUserMessageReplay);
            this.removeQueueChangeListener?.();
            this.removeQueueChangeListener = null;
            this.session.queue.requeueHeld();
            this.heldInput = null;
            this.clearCurrentPrompt();
            this.signalChange();
            await this.sessionReconciler?.drain();
            this.sessionReconciler = null;
            this.subagentTranscriptCursors.clear();
            this.registeredHostToolNames = [];
            this.lastPersistedToolsKey = null;
            this.lastPersistedCommandsKey = null;
            const hostIntegration = this.hostIntegration;
            this.hostIntegration = null;
            if (hostIntegration) {
                await hostIntegration.close('OMP remote launcher stopped');
            }
            await Promise.allSettled(this.eventTasks);
            const client = this.client ?? this.#failedClient;
            if (client) {
                await this.#refreshNativeHistoryEvidence(client).catch((error) => {
                    logger.warn('[omp-remote] Could not refresh native history evidence before shutdown', error);
                });
                // Keep the client available for shutdown retries after a timeout.
                try {
                    await this.closeOwnedNativeClient(client);
                } catch (error) {
                    const receipt: OmpShutdownReceipt = { kind: 'omp-rpc', status: 'unverified' };
                    this.session.recordShutdownReceipt(receipt);
                    this.nativeExit.resolve(receipt);
                    throw error;
                }
            }
            const receipt: OmpShutdownReceipt = client
                ? this.#receiptForExit(client.exitInfo)
                : this.#lastNativeReceipt ?? { kind: 'omp-rpc', status: this.attemptedNativeLaunch ? 'unverified' : 'not-started' };
            this.session.recordShutdownReceipt(receipt);
            this.nativeExit.resolve(receipt);
            this.unregisterShutdown?.();
            this.unregisterShutdown = null;
            this.client = null;
        } finally {
            // An earlier host/reconciler cleanup failure must not strand KillSession.
            this.nativeExit.resolve({ kind: 'omp-rpc', status: 'unverified' });
        }
    }

    private canDispatch(input: OmpQueuedInput): boolean {
        const mutation = input.inputMode === 'prompt'
            ? parseOmpSessionMutation(input.text)
            : null;
        if (mutation) {
            return !this.hasUnfinishedNativeInput();
        }

        const nativeBusy = this.currentPrompt !== null || this.isStreaming || this.preparingInput || this.undeliveredNativeTokens.size > 0;
        if (!nativeBusy) {
            return true;
        }

        // Forced rows retain their admission command/hash. Admit through the
        // original channel then promote by token, never abort the active run.
        if (this.session.queue.isForced(input)) return true;

        switch (input.inputMode) {
            case 'steer':
                return true;
            case 'abort_and_prompt':
                return !this.nativeFollowUpOutstanding;
            case 'prompt':
            case 'follow_up':
                return !this.nativeFollowUpOutstanding;
            default: {
                const exhaustive: never = input.inputMode;
                return exhaustive;
            }
        }
    }

    #invalidateEmptyHistoryEvidence(): void {
        const native = this.session.getNativeSession();
        if (native?.persistence === 'never-persisted') {
            const { persistence: _persistence, ...identity } = native;
            this.session.applyNativeSessionSnapshot(identity);
        }
    }

    async #refreshNativeHistoryEvidence(
        client: OmpRpcClient,
        initialSnapshot?: OmpNativeSession | null,
        knownState?: OmpSessionState
    ): Promise<void> {
        if (!this.#nativeIdentityVerified || this.client !== client) return;
        const previous = initialSnapshot === undefined ? this.session.getNativeSession() : initialSnapshot;
        const state = knownState ?? await client.request({ type: 'get_state' });
        const snapshot = await nativeSessionSnapshotWithPersistence(state, previous);
        if (this.client === client) this.session.applyNativeSessionSnapshot(snapshot);
    }

    private async dispatchInput(
        input: OmpQueuedInput,
        client: OmpRpcClient
    ): Promise<void> {
        if (!this.session.queue.isHeld(input)) {
            return;
        }

        const mutation = input.inputMode === 'prompt'
            ? parseOmpSessionMutation(input.text)
            : null;
        if (mutation) {
            await this.dispatchMutation(input, mutation, client);
            return;
        }

        let prepared: PreparedOmpInput;
        this.preparingInput = true;
        try {
            prepared = await prepareOmpInput(input.text, input.attachments);
        } catch (error) {
            if (!this.session.queue.beginInvocation(input)) {
                return;
            }
            const detail = error instanceof Error ? error.message : String(error);
            this.reportInputFailure(detail);
            this.preparingInput = false;
            this.session.queue.releaseInvocation(input);
            await this.sendReadyIfIdle();
            return;
        } finally {
            this.preparingInput = false;
            this.signalChange();
        }
        if (!this.session.queue.isHeld(input)) {
            return;
        }

        if (!prepared.message.trim() && !prepared.images?.length) {
            if (!this.session.queue.beginInvocation(input)) {
                return;
            }
            this.reportInputFailure('OMP RPC received no text or attachment');
            this.session.queue.releaseInvocation(input);
            await this.sendReadyIfIdle();
            return;
        }
        if (!this.session.queue.beginInvocation(input)) {
            return;
        }

        this.dispatching = true;
        this.readyEmittedForIdleCycle = false;
        const wasBusy = this.currentPrompt !== null || this.isStreaming || this.undeliveredNativeTokens.size > 0;
        let startedPrompt = false;
        let queuedFollowUp = false;
        try {
            if (!wasBusy) {
                const requestedModel = input.mode.model !== undefined
                    ? input.mode.model
                    : this.pendingModel.hasValue ? this.pendingModel.value : undefined;
                const requestedThinking = input.mode.effort !== undefined
                    ? input.mode.effort
                    : this.pendingThinking;
                await this.applyRequestedModel(requestedModel);
                this.pendingModel = { hasValue: false, value: undefined };
                await this.applyRequestedThinking(requestedThinking);
                this.pendingThinking = undefined;
            } else {
                this.stagePendingRuntimeConfig(input.mode);
            }
            this.applyDisplayMode(input.mode.permissionMode, this.currentModel?.id);
            if (input.localId) this.pendingNativeInputs.set(input.localId, input);
            else this.recordUserMessageOnce(input);
            const message = prepared.message;

            // Already admitted tokens are promoted separately; fresh forced
            // interrupt inputs use a noninterrupting admission instead.
            const inputMode = this.session.queue.isForced(input) && input.inputMode === 'abort_and_prompt'
                ? 'follow_up' : input.inputMode;
            switch (inputMode) {
                case 'prompt': {
                    if (wasBusy) {
                        queuedFollowUp = true;
                        this.nativeFollowUpOutstanding = true;
                        const response = await this.#invokeNativeInput(client, input, {
                            type: 'prompt',
                            message,
                            images: prepared.images,
                            streamingBehavior: 'followUp'
                        });
                        if (response?.agentInvoked === false) {
                            this.nativeFollowUpOutstanding = false;
                        }
                    } else {
                        startedPrompt = true;
                        this.beginPrompt(input.modeHash, 0);
                        const response = await this.#invokeNativeInput(client, input, {
                            type: 'prompt',
                            message,
                            images: prepared.images
                        });
                        if (response?.agentInvoked === false) {
                            this.clearCurrentPrompt();
                        }
                    }
                    break;
                }
                case 'steer':
                    if (!wasBusy) {
                        startedPrompt = true;
                        this.beginPrompt(input.modeHash, 0);
                    }
                    await this.#invokeNativeInput(client, input, { type: 'steer', message, images: prepared.images });
                    break;
                case 'follow_up':
                    if (wasBusy) {
                        queuedFollowUp = true;
                        this.nativeFollowUpOutstanding = true;
                    } else {
                        startedPrompt = true;
                        this.beginPrompt(input.modeHash, 0);
                    }
                    await this.#invokeNativeInput(client, input, { type: 'follow_up', message, images: prepared.images });
                    break;
                case 'abort_and_prompt':
                    startedPrompt = true;
                    this.nativeFollowUpOutstanding = false;
                    this.beginPrompt(input.modeHash, wasBusy ? 1 : 0);
                    await this.#invokeNativeInput(client, input, { type: 'abort_and_prompt', message, images: prepared.images });
                    break;
                default: {
                    const exhaustive: never = inputMode;
                    return exhaustive;
                }
            }
            if (input.localId && this.session.queue.isForced(input) && wasBusy) {
                await this.forceNativeInput(input.localId);
            }
            if (!input.localId) this.bufferedInputIds.delete(input.id);
            this.session.queue.releaseInvocation(input);
        } catch (error) {
            if (error instanceof OmpUncertainDeliveryError) {
                this.#quarantineUncertainInput(input, error);
                return;
            }
            if (this.isAlreadyProcessingError(error)) {
                await this.recoverFromBusyDispatchRace(input, prepared, client, startedPrompt, queuedFollowUp);
                return;
            }
            if (startedPrompt) {
                this.clearCurrentPrompt();
            }
            if (queuedFollowUp) {
                this.nativeFollowUpOutstanding = false;
            }
            const detail = error instanceof Error ? error.message : String(error);
            logger.warn(`[omp-remote] RPC ${input.inputMode} failed`, error);
            this.reportInputFailure(detail);
            this.bufferedInputIds.delete(input.id);
            this.session.queue.releaseInvocation(input);
        } finally {
            this.dispatching = false;
            this.signalChange();
            await this.sendReadyIfIdle();
        }
    }

    async #invokeNativeInput<C extends 'prompt' | 'steer' | 'follow_up' | 'abort_and_prompt'>(
        client: OmpRpcClient,
        input: OmpQueuedInput,
        command: OmpCommandByType<C>
    ): Promise<OmpResponseData<C>> {
        if (!input.localId) {
            this.#invalidateEmptyHistoryEvidence();
            return await client.request<C>(command);
        }
        if (client.discovery.state.capabilities?.inputReceipts !== true || client.discovery.state.capabilities.nativeOrder !== true) {
            throw new OmpInputReceiptsUnsupportedError(input.localId);
        }
        const receipts = this.session.getInputDeliveryStore();
        try {
            receipts.begin(input.localId, this.session.sessionId!, input.localId);
        } catch (error) {
            throw new OmpUncertainDeliveryError(input.localId, { cause: error });
        }
        const previousNative = this.session.getNativeSession();
        this.#invalidateEmptyHistoryEvidence();
        try {
            const response = await client.request<C>({ ...command, clientToken: input.localId });
            if (!response || !('receipt' in response) || response.receipt?.token !== input.localId || !response.receipt.admitted) {
                throw new OmpUncertainDeliveryError(input.localId);
            }
            this.applyNativeInputReceipt(client, response.receipt);
            return response;
        } catch (error) {
            if (error instanceof OmpRpcRequestError && error.code === 'client_token_conflict') {
                receipts.quarantineConflict(input.localId);
                throw new OmpInputTokenConflictError(input.localId, { cause: error });
            }
            if (error instanceof OmpRpcRequestError && this.isAlreadyProcessingError(error)) {
                try {
                    const { receipts: queried } = await client.request({ type: 'get_input_receipts', tokens: [input.localId] });
                    const proof = queried.find(receipt => receipt.token === input.localId);
                    if (!proof || proof.sessionId !== this.session.sessionId) throw new OmpUncertainDeliveryError(input.localId);
                    if (proof.admitted) {
                        this.applyNativeInputReceipt(client, proof);
                        return { receipt: proof } as OmpResponseData<C>;
                    }
                    // A different queue channel is safe only after the same
                    // journal explicitly proves this attempt never admitted.
                    receipts.rejectBeforeAdmission(input.localId);
                    await this.#refreshNativeHistoryEvidence(client, previousNative);
                } catch (recoveryError) {
                    throw new OmpUncertainDeliveryError(input.localId, { cause: recoveryError });
                }
                throw error;
            }
            throw new OmpUncertainDeliveryError(input.localId, { cause: error });
        }
    }

    /** A Hub replay can mean its receipt was lost, not that native input was lost. */
    #replayTerminalInput(localId: string): boolean {
        if (!this.client || !this.#nativeIdentityVerified || this.hibernating || this.shouldExit) return false;
        const store = this.session.getInputDeliveryStore();
        const receipt = store.nativeReceipt(localId);
        if (receipt && receipt.sessionId !== this.session.sessionId) return false;
        if (receipt?.delivered && store.isAccepted(localId)) {
            this.emitNativeDelivery(localId, receipt);
            return true;
        }
        const resolution = store.resolvedInput(localId);
        if (!resolution) return false;
        this.session.client.sendMessagesResolved([resolution]);
        return true;
    }

    private async forceNativeInput(localId: string): Promise<ForceQueuedMessageAck> {
        try {
            this.#replayTerminalInput(localId);
            const store = this.session.getInputDeliveryStore();
            if (store.isAccepted(localId) || store.nativeReceipt(localId)?.outcome !== undefined) {
                return { localId, status: 'not-found' };
            }
            const client = await this.ensureClient();
            if (client.discovery.state.capabilities?.queuePromotion !== true) {
                return { localId, status: 'unsupported', error: 'native process does not support token queue promotion' };
            }
            // Identity-only operation: legacy text selection is ambiguous in
            // sessions with extension or other native producers. Never guess.
            const result = await client.request({ type: 'promote_queued_message', clientToken: localId });
            const entry = result.results?.find(entry => entry.token === localId);
            if (!entry) return { localId, status: 'unsupported', error: 'native returned no token promotion result' };
            if (entry.status !== 'not-found') {
                if (this.undeliveredNativeTokens.has(localId)) {
                    this.undeliveredNativeTokens.set(localId, 'steer');
                    this.reconcileNativeFollowUpOutstanding();
                    this.signalChange();
                }
                return { localId, status: 'promoted' };
            }
            return { localId, status: 'not-found', error: 'native input unavailable for token promotion' };
        } catch (error) {
            return { localId, status: 'unsupported', error: error instanceof Error ? error.message : String(error) };
        }
    }

    private async cancelNativeInput(localId: string): Promise<boolean> {
        const store = this.session.getInputDeliveryStore();
        if (!store.isPendingNativeInput(localId) && !this.pendingNativeInputs.has(localId)) return false;
        const client = await this.ensureClient();
        if (client.discovery.state.capabilities?.inputReceipts !== true || client.discovery.state.capabilities.nativeOrder !== true) throw new OmpInputReceiptsUnsupportedError(localId);
        await client.request({ type: 'remove_queued_message', clientToken: localId });
        const result = await client.request({ type: 'get_input_receipts', tokens: [localId] });
        const proof = result.receipts.find(receipt => receipt.token === localId);
        if (!proof || proof.sessionId !== this.session.sessionId) throw new OmpUncertainDeliveryError(localId);
        if (!proof.admitted) return false;
        this.applyNativeInputReceipt(client, proof);
        return !proof.delivered && proof.outcome === 'cancelled';
    }

    private applyNativeInputReceipt(client: OmpRpcClient, receipt: OmpInputReceipt): void {
        if (this.client !== client || this.hibernating || this.shouldExit) return;
        if (receipt.sessionId !== this.session.sessionId) throw new OmpUncertainDeliveryError(receipt.token);
        const store = this.session.getInputDeliveryStore();
        const wasDelivered = store.isAccepted(receipt.token);
        const delivered = store.recordNativeReceipt(receipt);
        receipt = store.nativeReceipt(receipt.token) ?? receipt;
        // Native recovery can expose journal-owned tokens absent from this wrapper's
        // sidecar. They still gate dispatch, but cannot acknowledge a Hub localId.
        this.markNativeHistoryPersisted(receipt);
        if (receipt.admitted && !receipt.delivered && receipt.outcome === undefined) this.undeliveredNativeTokens.set(receipt.token, receipt.channel);
        else this.undeliveredNativeTokens.delete(receipt.token);
        this.reconcileNativeFollowUpOutstanding();
        if (delivered === undefined) { this.signalChange(); return; }
        if (delivered) {
            const input = this.pendingNativeInputs.get(receipt.token);
            if (input && !wasDelivered) {
                this.recordUserMessageOnce(input);
                this.bufferedInputIds.delete(input.id);
            }
            this.pendingNativeInputs.delete(receipt.token);
            if (!wasDelivered) this.emitNativeDelivery(receipt.token, receipt);
        } else if (receipt.outcome !== undefined) {
            this.pendingNativeInputs.delete(receipt.token);
            this.session.client.sendMessagesResolved([{
                localId: receipt.token, outcome: receipt.outcome === 'cancelled' ? 'cancelled' : 'handled',
                ...(receipt.nativeOrder ? { nativeOrder: receipt.nativeOrder } : {})
            }]);
            this.session.sendSessionEvent({ type: 'message', message: `OMP input ${receipt.token} resolved as ${receipt.outcome} without entering a native turn; its Hub message was not marked invoked.` });
        }
        this.signalChange();
    }

    private markNativeHistoryPersisted(receipt: OmpInputReceipt): void {
        const native = this.session.getNativeSession();
        if (receipt.admitted && native?.id === receipt.sessionId && native.persistence !== 'persisted') {
            this.session.applyNativeSessionSnapshot({ ...native, persistence: 'persisted' });
        }
    }

    private reconcileNativeFollowUpOutstanding(): void {
        this.nativeFollowUpOutstanding = false;
        for (const channel of this.undeliveredNativeTokens.values()) {
            if (channel !== 'steer') { this.nativeFollowUpOutstanding = true; break; }
        }
    }

    private emitNativeDelivery(localId: string, receipt: OmpInputReceipt): void {
        if (!receipt.delivered || !receipt.entryId || !receipt.deliveredAt || !Number.isFinite(Date.parse(receipt.deliveredAt))
            || !Number.isSafeInteger(receipt.deliveredOrder) || receipt.deliveredOrder! < 1) {
            throw new OmpUncertainDeliveryError(localId);
        }
        this.session.client.emitMessagesConsumed([localId], {
            nativeDelivery: { sessionId: receipt.sessionId, entryId: receipt.entryId, deliveredAt: receipt.deliveredAt, entryOrder: receipt.deliveredOrder! }
        });
    }

    #quarantineUncertainInput(input: OmpQueuedInput, error: OmpUncertainDeliveryError): void {
        this.session.queue.requeueInvocation(input);
        this.reportInputFailure(error.message);
        this.handleTransportFailure(error);
    }

    private async dispatchMutation(
        input: OmpQueuedInput,
        mutation: ReturnType<typeof parseOmpSessionMutation> & {},
        client: OmpRpcClient
    ): Promise<void> {
        if (!this.session.queue.beginInvocation(input)) {
            return;
        }
        this.dispatching = true;
        this.readyEmittedForIdleCycle = false;
        this.session.onThinkingChange(true);
        this.messageBuffer.addMessage(input.text, 'user');
        if (input.attachments.length > 0) {
            const warning = 'OMP session commands ignore attachments';
            this.session.sendSessionEvent({ type: 'message', message: warning });
            this.messageBuffer.addMessage(warning, 'status');
        }
        let dispatched = false;
        let uncertain = false;
        try {
            await this.applyRequestedModel(input.mode.model);
            await this.applyRequestedThinking(input.mode.effort);
            this.applyDisplayMode(input.mode.permissionMode, this.currentModel?.id);
            if (mutation.type === 'invalid_session_command') {
                throw new Error(mutation.message);
            }
            if (mutation.type === 'resume_session_picker') {
                throw new Error('Use /resume <session id> when controlling OMP remotely');
            }
            let rpcMutation: OmpSessionMutationCommand;
            if (mutation.type === 'resume_session') {
                const sessionPath = await resolveOmpSessionPath(mutation.sessionArg, this.session.path);
                if (sessionPath === null) {
                    throw new Error(`Session "${mutation.sessionArg}" not found`);
                }
                rpcMutation = { type: 'switch_session', sessionPath };
            } else {
                rpcMutation = mutation;
            }
            if (input.localId) {
                dispatched = true;
                this.session.getInputDeliveryStore().begin(input.localId, this.session.sessionId!);
            }
            this.#invalidateEmptyHistoryEvidence();
            await runOmpSessionMutation(client, rpcMutation, this.session.applyNativeSessionSnapshot, this.session.getNativeSession());
            if (input.localId) {
                this.session.getInputDeliveryStore().resolveHostInput(input.localId);
                this.session.client.sendMessagesResolved([{ localId: input.localId, outcome: 'handled' }]);
            }
        } catch (error) {
            if (dispatched && input.localId) {
                uncertain = true;
                this.#quarantineUncertainInput(input, new OmpUncertainDeliveryError(input.localId, { cause: error }));
                return;
            }
            const detail = error instanceof Error ? error.message : String(error);
            logger.warn('[omp-remote] RPC session mutation failed', error);
            this.session.sendSessionEvent({
                type: 'message',
                message: `Oh My Pi RPC session mutation failed: ${detail}`
            });
            this.messageBuffer.addMessage(`Oh My Pi RPC session mutation failed: ${detail}`, 'status');
        } finally {
            if (!uncertain) this.session.queue.releaseInvocation(input);
            this.dispatching = false;
            this.session.onThinkingChange(false);
            this.signalChange();
            await this.sendReadyIfIdle();
        }
    }

    private resolveTargetModel(requested: string | null | undefined): OmpModel | null {
        if (requested === undefined) {
            return this.currentModel;
        }
        const target = requested === null
            ? this.defaultModel
            : this.availableModels.find((model) => (
                model.id === requested || `${model.provider}/${model.id}` === requested
            )) ?? null;
        if (!target) {
            throw new Error(`OMP model is not available: ${requested ?? 'default'}`);
        }
        return target;
    }

    private async applyRequestedModel(requested: string | null | undefined): Promise<void> {
        if (requested === undefined) {
            return;
        }
        const target = this.resolveTargetModel(requested);
        if (!target) {
            return;
        }
        if (target.provider === this.currentModel?.provider && target.id === this.currentModel.id) {
            return;
        }

        const client = await this.ensureClient();
        await client.request({
            type: 'set_model',
            provider: target.provider,
            modelId: target.id
        });
        const state = await client.request({ type: 'get_state' });
        this.persistRuntimeState(state);
        if (
            state.model?.provider !== target.provider
            || state.model.id !== target.id
        ) {
            throw new Error(
                `OMP did not apply model ${target.provider}/${target.id}; `
                + `active model is ${state.model ? `${state.model.provider}/${state.model.id}` : 'unknown'}`
            );
        }
    }

    private asConfiguredThinking(value: unknown): OmpConfiguredThinkingLevel | null {
        if (typeof value !== 'string') {
            return null;
        }
        const normalized = value.trim().toLowerCase();
        if (normalized === 'auto') {
            return 'auto';
        }
        return (OMP_THINKING_LEVELS as readonly string[]).includes(normalized)
            ? normalized as OmpConfiguredThinkingLevel
            : null;
    }

    private persistRuntimeState(state: OmpSessionState): void {
        this.currentModel = state.model ?? null;
        if (this.currentModel) {
            this.session.setModel(`${this.currentModel.provider}/${this.currentModel.id}`);
        }
        this.contextUsage = state.contextUsage ?? null;
        this.isStreaming = state.isStreaming;
        this.thinkingState = {
            ...this.thinkingState,
            thinkingLevel: state.thinkingLevel ?? null
        };

        const thinkingKey = JSON.stringify(this.thinkingState);
        if (thinkingKey !== this.lastPersistedThinkingKey) {
            this.lastPersistedThinkingKey = thinkingKey;
            this.session.updateThinkingState(this.thinkingState);
        }
        if (state.dumpTools) {
            this.persistDiscoveredCapabilities({
                tools: [
                    ...state.dumpTools.map((tool) => tool.name),
                    ...this.registeredHostToolNames
                ]
            });
        }
    }

    private persistDiscoveredCapabilities(capabilities: {
        tools?: string[];
        slashCommands?: string[];
    }): void {
        const update: { tools?: string[]; slashCommands?: string[] } = {};
        if (capabilities.tools) {
            const tools = Array.from(new Set(capabilities.tools));
            const key = JSON.stringify(tools);
            if (key !== this.lastPersistedToolsKey) {
                this.lastPersistedToolsKey = key;
                update.tools = tools;
            }
        }
        if (capabilities.slashCommands) {
            const slashCommands = Array.from(new Set(capabilities.slashCommands));
            const key = JSON.stringify(slashCommands);
            if (key !== this.lastPersistedCommandsKey) {
                this.lastPersistedCommandsKey = key;
                update.slashCommands = slashCommands;
            }
        }
        if (update.tools || update.slashCommands) {
            this.session.updateDiscoveredCapabilities(update);
        }
    }

    private trackEventTask(task: Promise<void>): void {
        let tracked: Promise<void>;
        tracked = task
            .catch((error) => this.handleTransportFailure(error))
            .finally(() => this.eventTasks.delete(tracked));
        this.eventTasks.add(tracked);
    }

    private async syncSubagentTranscript(
        client: OmpRpcClient,
        eventAdapter: OmpRpcEventAdapter,
        snapshot: OmpSubagentSnapshot
    ): Promise<void> {
        if (!snapshot.sessionFile) return;
        const fromByte = this.subagentTranscriptCursors.get(snapshot.id) ?? 0;
        const transcript = await client.request({
            type: 'get_subagent_messages',
            subagentId: snapshot.id,
            fromByte
        });
        if (this.client !== client || this.hibernating || this.shouldExit) return;
        this.subagentTranscriptCursors.set(snapshot.id, transcript.nextByte);
        eventAdapter.seedSubagentMessages(
            snapshot.id,
            transcript.messages.map((message) => message.raw)
        );
    }

    private forwardAgentMessage(message: AgentMessage, nativeOrder?: OmpNativeOrder): void {
        if (message.type !== 'usage') {
            const converted = convertAgentMessage(message);
            if (converted) {
                this.session.sendAgentMessage(converted, { nativeOrder });
            }
            return;
        }

        this.trackEventTask((async () => {
            const client = await this.ensureClient();
            const state = await client.request({ type: 'get_state' });
            if (this.client !== client || this.hibernating || this.shouldExit) return;
            this.persistRuntimeState(state);
            const resolvedModel = state.model ?? this.currentModel;
            const modelId = resolvedModel ? `${resolvedModel.provider}/${resolvedModel.id}` : null;
            const converted = convertAgentMessage({
                ...message,
                contextTokens: state.contextUsage?.tokens,
                contextWindow: state.contextUsage?.contextWindow
            }, modelId);
            if (converted) {
                this.session.sendAgentMessage(converted, { nativeOrder });
            }
        })());
    }

    private async refreshRuntimeState(): Promise<void> {
        const client = await this.ensureClient();
        const state = await client.request({ type: 'get_state' });
        if (this.client !== client || this.hibernating || this.shouldExit) return;
        this.persistRuntimeState(state);
    }

    private handleThinkingStateChanged(state: {
        thinkingLevel?: import('./rpc/types').OmpThinkingLevel;
        configured?: OmpConfiguredThinkingLevel;
        resolved?: OmpEffort;
    }): void {
        const configured = state.configured ?? this.thinkingState.configured;
        this.thinkingState = {
            thinkingLevel: state.thinkingLevel ?? this.thinkingState.thinkingLevel,
            configured,
            resolved: configured === 'auto' ? state.resolved ?? null : null
        };
        if (state.configured) {
            this.confirmedConfiguredThinking = state.configured;
        }
        const thinkingKey = JSON.stringify(this.thinkingState);
        if (thinkingKey !== this.lastPersistedThinkingKey) {
            this.lastPersistedThinkingKey = thinkingKey;
            this.session.updateThinkingState(this.thinkingState);
        }
    }

    private async listModels(): Promise<ListOmpModelsResponse> {
        try {
            const client = await this.ensureClient();
            const catalog = await client.request({ type: 'get_available_models' });
            this.availableModels = catalog.models;
            const state = await client.request({ type: 'get_state' });
            this.persistRuntimeState(state);
            return {
                success: true,
                availableModels: catalog.models.map((model): OmpModelSummary => ({
                    provider: model.provider,
                    modelId: model.id,
                    name: model.name,
                    reasoning: model.reasoning,
                    contextWindow: model.contextWindow,
                    maxTokens: model.maxTokens,
                    thinkingLevels: model.thinking?.efforts ?? []
                })),
                currentModel: state.model
                    ? { provider: state.model.provider, modelId: state.model.id }
                    : null
            };
        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to list OMP models'
            };
        }
    }

    private async listThinkingOptions(): Promise<ListOmpThinkingOptionsResponse> {
        try {
            const state = await (await this.ensureClient()).request({ type: 'get_state' });
            this.persistRuntimeState(state);
            const values: OmpConfiguredThinkingLevel[] = state.model?.reasoning
                ? ['auto', 'off', ...(state.model.thinking?.efforts ?? [])]
                : ['off'];
            const seen = new Set<OmpConfiguredThinkingLevel>();
            const options = values
                .filter((value) => !seen.has(value) && seen.add(value))
                .map((value): OmpThinkingOption => ({ value, name: value }));
            return { success: true, options, state: this.thinkingState };
        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to list OMP thinking options'
            };
        }
    }

    private async cycleModel(): Promise<CycleOmpModelResponse> {
        if (this.hasUnfinishedNativeInput()) {
            return { success: false, error: 'OMP model can only be cycled while the session is idle' };
        }
        try {
            const client = await this.ensureClient();
            const cycled = await client.request({ type: 'cycle_model' });
            if (!cycled) {
                return { success: false, error: 'OMP has no other available model' };
            }
            const state = await client.request({ type: 'get_state' });
            this.persistRuntimeState(state);
            if (
                state.model?.provider !== cycled.model.provider
                || state.model.id !== cycled.model.id
            ) {
                throw new Error('OMP cycle_model response did not match get_state');
            }
            return {
                success: true,
                currentModel: { provider: state.model.provider, modelId: state.model.id }
            };
        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to cycle OMP model'
            };
        }
    }

    private async applyRequestedThinking(
        requested: OmpConfiguredThinkingLevel | undefined,
        connectedClient?: OmpRpcClient
    ): Promise<void> {
        if (requested === undefined || requested === this.confirmedConfiguredThinking) {
            return;
        }

        const client = connectedClient ?? await this.ensureClient();
        if (requested === 'auto') {
            let selectedAuto = false;
            for (let attempt = 0; attempt < OMP_THINKING_LEVELS.length + 2; attempt += 1) {
                const cycled = await client.request({ type: 'cycle_thinking_level' });
                if (cycled?.level === 'auto') {
                    selectedAuto = true;
                    break;
                }
            }
            if (!selectedAuto) {
                throw new Error('OMP did not expose the auto thinking selector while cycling');
            }
        } else {
            await client.request({ type: 'set_thinking_level', level: requested });
        }

        const state = await client.request({ type: 'get_state' });
        if (requested !== 'auto' && (state.thinkingLevel ?? null) !== requested) {
            throw new Error(
                `OMP did not apply thinking level ${requested}; `
                + `effective level is ${state.thinkingLevel ?? 'unset'}`
            );
        }
        this.confirmedConfiguredThinking = requested;
        this.thinkingState = {
            thinkingLevel: state.thinkingLevel ?? null,
            configured: requested,
            resolved: null
        };
        this.persistRuntimeState(state);
    }

    private async applyRuntimeConfig(
        config: OmpRuntimeConfigRequest
    ): Promise<OmpRuntimeConfigApplied> {
        if (this.hasUnfinishedNativeInput()) {
            const applied: OmpRuntimeConfigApplied = {};
            if (config.model !== undefined) {
                const target = this.resolveTargetModel(config.model);
                if (!target) {
                    throw new Error('OMP did not report an active model after configuration');
                }
                this.pendingModel = { hasValue: true, value: config.model };
                applied.model = `${target.provider}/${target.id}`;
            }
            if (config.effort !== undefined) {
                this.pendingThinking = config.effort;
                applied.effort = config.effort;
            }
            return applied;
        }

        const applied: OmpRuntimeConfigApplied = {};
        if (config.model !== undefined) {
            await this.applyRequestedModel(config.model);
            this.pendingModel = { hasValue: false, value: undefined };
            if (!this.currentModel) {
                throw new Error('OMP did not report an active model after configuration');
            }
            applied.model = `${this.currentModel.provider}/${this.currentModel.id}`;
        }
        if (config.effort !== undefined) {
            await this.applyRequestedThinking(config.effort);
            this.pendingThinking = undefined;
            applied.effort = config.effort;
        }
        return applied;
    }

    private stagePendingRuntimeConfig(mode: OmpQueuedInput['mode']): void {
        if (mode.model !== undefined) {
            const target = this.resolveTargetModel(mode.model);
            if (target && (target.provider !== this.currentModel?.provider || target.id !== this.currentModel?.id)) {
                this.pendingModel = { hasValue: true, value: mode.model };
            }
        }
        if (mode.effort !== undefined && mode.effort !== this.confirmedConfiguredThinking) {
            this.pendingThinking = mode.effort;
        }
    }

    private async flushPendingRuntimeConfig(): Promise<void> {
        if (this.pendingModel.hasValue) {
            const requestedModel = this.pendingModel.value;
            this.pendingModel = { hasValue: false, value: undefined };
            await this.applyRequestedModel(requestedModel);
        }
        if (this.pendingThinking !== undefined) {
            const requestedThinking = this.pendingThinking;
            this.pendingThinking = undefined;
            await this.applyRequestedThinking(requestedThinking);
        }
    }

    private isAlreadyProcessingError(error: unknown): boolean {
        const detail = error instanceof Error ? error.message : String(error);
        return /agent is already processing/i.test(detail);
    }

    private recordUserMessageOnce(input: OmpQueuedInput): void {
        if (this.bufferedInputIds.has(input.id)) {
            return;
        }
        this.bufferedInputIds.add(input.id);
        this.messageBuffer.addMessage(input.text, 'user');
    }

    private async recoverFromBusyDispatchRace(
        input: OmpQueuedInput,
        prepared: PreparedOmpInput,
        client: OmpRpcClient,
        startedPrompt: boolean,
        queuedFollowUp: boolean
    ): Promise<void> {
        this.isStreaming = true;
        if (!this.currentPrompt) {
            this.beginPrompt(input.modeHash, 0);
        }
        if (this.currentPrompt) {
            this.currentPrompt.phase = 'streaming';
        }
        this.session.onThinkingChange(true);
        this.stagePendingRuntimeConfig(input.mode);
        this.applyDisplayMode(input.mode.permissionMode, this.currentModel?.id);
        if (!input.localId) this.recordUserMessageOnce(input);

        if (queuedFollowUp) {
            this.nativeFollowUpOutstanding = false;
        }

        try {
            if ((input.inputMode === 'prompt' || input.inputMode === 'follow_up') && !this.nativeFollowUpOutstanding) {
                this.nativeFollowUpOutstanding = true;
                if (input.inputMode === 'prompt') {
                    const response = await this.#invokeNativeInput(client, input, {
                        type: 'prompt',
                        message: prepared.message,
                        images: prepared.images,
                        streamingBehavior: 'followUp'
                    });
                    if (response?.agentInvoked === false) {
                        this.nativeFollowUpOutstanding = false;
                    }
                } else {
                    await this.#invokeNativeInput(client, input, {
                        type: 'follow_up',
                        message: prepared.message,
                        images: prepared.images
                    });
                }
                if (!input.localId) this.bufferedInputIds.delete(input.id);
                this.session.queue.releaseInvocation(input);
                return;
            }
            if (input.inputMode === 'steer') {
                await this.#invokeNativeInput(client, input, {
                    type: 'steer',
                    message: prepared.message,
                    images: prepared.images
                });
                if (!input.localId) this.bufferedInputIds.delete(input.id);
                this.session.queue.releaseInvocation(input);
                return;
            }
        } catch (fallbackError) {
            if (fallbackError instanceof OmpUncertainDeliveryError) {
                this.#quarantineUncertainInput(input, fallbackError);
                return;
            }
            this.nativeFollowUpOutstanding = false;
            if (!this.isAlreadyProcessingError(fallbackError)) {
                if (startedPrompt) {
                    this.clearCurrentPrompt();
                }
                const detail = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
                logger.warn(`[omp-remote] RPC ${input.inputMode} busy-fallback failed`, fallbackError);
                this.reportInputFailure(detail);
                this.bufferedInputIds.delete(input.id);
                this.session.queue.releaseInvocation(input);
                return;
            }
        }

        logger.debug(`[omp-remote] Requeueing held input ${input.id} (${input.inputMode}) while native agent is processing`);
        this.session.queue.requeueInvocation(input);
    }

    private async sendReadyIfIdle(): Promise<void> {
        while (!this.shouldExit && !this.hasLocalPendingInput() && !this.readyEmittedForIdleCycle) {
            if (this.readyInFlight) {
                await this.readyInFlight;
                if (this.readyCheckedForIdleCycle) {
                    return;
                }
                continue;
            }
            const client = this.client;
            if (!client || client.state !== 'ready') {
                return;
            }
            this.readyCheckedForIdleCycle = true;
            let task: Promise<void>;
            task = (async () => {
                try {
                    const state = await client.request({ type: 'get_state' });
                    this.persistRuntimeState(state);
                    if (
                        !state.isStreaming
                        && state.queuedMessageCount === 0
                        && !this.hasLocalPendingInput()
                        && !this.shouldExit
                    ) {
                        await this.flushPendingRuntimeConfig();
                        if (
                            !this.isStreaming
                            && !this.hasLocalPendingInput()
                            && !this.readyEmittedForIdleCycle
                            && !this.shouldExit
                        ) {
                            this.readyEmittedForIdleCycle = true;
                            this.session.sendSessionEvent({ type: 'ready' });
                        }
                    }
                } catch (error) {
                    logger.debug('[omp-remote] failed checking ready state', error);
                }
            })().finally(() => {
                if (this.readyInFlight === task) {
                    this.readyInFlight = null;
                }
            });
            this.readyInFlight = task;
            await task;
            if (this.readyCheckedForIdleCycle) {
                return;
            }
        }
    }

    private hasLocalPendingInput(): boolean {
        return (
            this.dispatching
            || this.preparingInput
            || this.wakePromise !== null
            || this.currentPrompt !== null
            || this.nativeFollowUpOutstanding
            || this.undeliveredNativeTokens.size > 0
            || this.session.queue.size() > 0
            || this.session.queue.heldSize() > 0
        );
    }

    private hasUnfinishedNativeInput(): boolean {
        return (
            this.dispatching
            || this.preparingInput
            || this.wakePromise !== null
            || this.currentPrompt !== null
            || this.nativeFollowUpOutstanding
            || this.isStreaming
            || this.undeliveredNativeTokens.size > 0
        );
    }

    private applyDisplayMode(permissionMode: PermissionMode | undefined, model?: string): void {
        if (permissionMode && permissionMode !== this.displayPermissionMode) {
            this.displayPermissionMode = permissionMode;
            this.messageBuffer.addMessage(`[MODE:${permissionMode}]`, 'system');
        }
        if (model && model !== this.displayModel) {
            this.displayModel = model;
            this.messageBuffer.addMessage(`[MODEL:${model}]`, 'system');
        }
    }

    private beginPrompt(modeHash: string, ignoreAgentEnds: number): void {
        this.readyEmittedForIdleCycle = false;
        this.currentPrompt = {
            phase: 'awaiting-agent',
            modeHash,
            ignoreAgentEnds
        };
        this.session.onThinkingChange(true);
        this.signalChange();
    }

    private clearCurrentPrompt(): void {
        if (!this.currentPrompt) {
            this.session.onThinkingChange(false);
            return;
        }
        this.currentPrompt = null;
        this.session.onThinkingChange(false);
        this.signalChange();
    }

    private reportInputFailure(detail: string): void {
        const message = `Oh My Pi RPC input failed: ${detail}`;
        this.session.sendSessionEvent({ type: 'message', message });
        this.messageBuffer.addMessage(message, 'status');
    }

    private handleTransportFailure(error: unknown): void {
        this.session.client.clearSessionReady();
        const failure = error instanceof Error ? error : new Error(String(error));
        this.#eventAdapter?.noteRuntimeFailure(failure.message);
        this.transportFailure = failure;
        this.clearCurrentPrompt();
        this.signalChange();
    }

    private signalChange(): void {
        this.changeVersion += 1;
        const waiter = this.changeWaiter;
        this.changeWaiter = null;
        waiter?.();
    }

    private waitForChange(observedVersion: number): Promise<void> {
        if (this.changeVersion !== observedVersion) {
            return Promise.resolve();
        }
        return new Promise((resolve) => {
            this.changeWaiter = resolve;
            if (this.changeVersion !== observedVersion) {
                this.changeWaiter = null;
                resolve();
            }
        });
    }

    private requireClient(): OmpRpcClient {
        if (!this.client) {
            throw new Error('OMP RPC client is not connected');
        }
        return this.client;
    }

    private async handleAbort(): Promise<void> {
        const abortedTurnGeneration = this.nativeTurnGeneration;
        const client = this.client;
        this.#eventAdapter?.noteExternalAbort();
        if (client?.state === 'ready') {
            await client.request({ type: 'abort' }, { timeoutMs: 5_000 });
        }
        const newerTurnIsActive = (
            this.nativeTurnGeneration !== abortedTurnGeneration
            && this.isStreaming
        );
        if (!newerTurnIsActive) {
            this.isStreaming = false;
            this.clearCurrentPrompt();
        }
        this.signalChange();
        this.session.sendSessionEvent({ type: 'message', message: 'Session aborted' });
        this.messageBuffer.addMessage('Turn aborted', 'status');
    }

    private async handleExitFromUi(): Promise<void> {
        await this.requestExit('exit', async () => {
            try {
                await this.handleAbort();
            } catch (error) {
                // EOF below still asks OMP to dispose when abort could not reply.
                logger.warn('[omp-remote] Abort before shutdown failed', error);
            } finally {
                this.signalChange();
            }
        });
    }

    private async handleSwitchFromUi(): Promise<void> {
        await this.requestExit('switch', async () => {
            this.session.queue.requeueHeld();
            this.heldInput = null;
            this.clearCurrentPrompt();
            this.signalChange();
        });
    }

    private async handleSwitchRequest(): Promise<void> {
        await this.handleSwitchFromUi();
    }
}

export async function ompRemoteLauncher(
    session: OmpSession
): Promise<'switch' | 'exit'> {
    const launcher = new OmpRemoteLauncher(session);
    return launcher.launch();
}
