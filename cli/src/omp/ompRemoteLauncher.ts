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
import { RPC_METHODS } from '@hapi/protocol/rpcMethods';
import { buildOmpEnv } from './utils/config';
import { OmpRpcClient } from './rpc/OmpRpcClient';
import { OmpRpcEventAdapter } from './rpc/OmpRpcEventAdapter';
import { loadOmpEventAllowlist } from './rpc/eventAllowlist';
import type {
    OmpContextUsage,
    OmpInboundEvent,
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
    nativeSessionSnapshotFromState,
    OmpSessionStateReconciler,
    parseOmpSessionMutation,
    runOmpSessionMutation,
    type OmpSessionMutationCommand,
} from './rpc/sessionLifecycle';
import { resolveOmpSessionPath } from './utils/ompSessionScanner';
import type { OmpQueuedInput } from './OmpInputQueue';
import { describeIgnoredOmpAttachments, prepareOmpInput, type PreparedOmpInput } from './ompInputContent';
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
    private attemptedNativeLaunch = false;
    private hibernating = false;
    private wakePromise: Promise<OmpRpcClient> | null = null;
    private eventAllowlist: ReadonlySet<OmpKnownEventType> | null = null;
    constructor(session: OmpSession) {
        super(process.env.DEBUG ? session.logPath : undefined);
        this.session = session;
        this.unregisterShutdown = session.registerShutdownHandle({
            requestExit: () => this.handleExitFromUi(),
            waitForExit: async () => {
                const receipt = await this.nativeExit.promise;
                if (receipt.status !== 'unverified' || !this.client) return receipt;
                await this.client.close();
                const exit = this.client.exitInfo;
                return { kind: 'omp-rpc', status: 'disposed', pid: exit?.pid, exitCode: exit?.code, signal: exit?.signal };
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
        const spawnConfig: OmpRpcSpawnConfig = session.sessionId
            ? { ...spawnBase, resumeSessionId: session.sessionId }
            : spawnBase;
        this.attemptedNativeLaunch = true;
        const client = await OmpRpcClient.connect(spawnConfig);
        this.client = client;
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
        session.applyNativeSessionSnapshot(nativeSessionSnapshotFromState(client.discovery.state));
        const sessionReconciler = new OmpSessionStateReconciler(
            client,
            session.applyNativeSessionSnapshot
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
            onAgentMessage: (message) => {
                this.forwardAgentMessage(message);
            },
            onCanonicalMessage: (message) => {
                session.client.sendClaudeSessionMessage(message);
            },
            onAgentRunEvent: (event) => {
                session.sendAgentMessage(event);
            },
            onAgentRunTrace: (scope, message) => {
                const converted = convertAgentMessage(message);
                if (!converted) return;
                session.sendAgentMessage({
                    type: 'agent-run-trace',
                    ...scope,
                    message: converted
                });
            },
            onStructuredEvent: (event) => {
                session.sendAgentMessage(event);
                if (event.type === 'omp-compaction' && event.phase === 'finished' && event.outcome === 'completed') {
                    this.sessionRelay?.controller.onCompactionCompleted();
                }
            },
            onInkMessage: (message, type) => this.messageBuffer.addMessage(message, type),
            onUserMessageCommitted: (steering) => {
                if (!steering && this.nativeFollowUpOutstanding) {
                    this.nativeFollowUpOutstanding = false;
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
        const bufferedEvents: OmpInboundEvent[] = [];
        let subagentSnapshotApplied = false;
        client.onEvent((event) => {
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
        eventAdapter.seedSubagents(subagents);
        for (const event of bufferedEvents.splice(0)) {
            eventAdapter.handle(event);
        }
        subagentSnapshotApplied = true;
        await Promise.all(subagents.map(async (snapshot) => {
            await this.syncSubagentTranscript(client, eventAdapter, snapshot);
        }));
        return client;
    }

    private async ensureClient(): Promise<OmpRpcClient> {
        if (this.client) return this.client;
        if (this.wakePromise) return await this.wakePromise;
        const promise = this.connectNativeClient().finally(() => {
            if (this.wakePromise === promise) this.wakePromise = null;
        });
        this.wakePromise = promise;
        return await promise;
    }

    private async tryHibernateIdleClient(): Promise<void> {
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
            this.client = null;
            await this.sessionReconciler?.drain();
            this.sessionReconciler = null;
            const hostIntegration = this.hostIntegration;
            this.hostIntegration = null;
            if (hostIntegration) {
                await hostIntegration.close('OMP remote session hibernated while idle');
            }
            await client.close().catch(() => { });
            logger.debug('[omp-remote] Hibernated idle OMP RPC subprocess to reclaim memory');
        } catch (error) {
            logger.debug('[omp-remote] Idle hibernate check skipped', error);
        } finally {
            this.hibernating = false;
        }
    }

    protected async runMainLoop(): Promise<void> {
        this.session.client.clearSessionReady();
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

        const requestedThinking = this.asConfiguredThinking(session.getEffort());
        if (requestedThinking) {
            await this.applyRequestedThinking(requestedThinking);
        }

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
        try {
            this.sessionRelay?.stop();
            this.sessionRelay = null;
            this.clearAbortHandlers(this.session.client.rpcHandlerManager);
            this.session.setRuntimeConfigApplier(null);
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
            const client = this.client;
            if (client) {
                // Keep the client available for shutdown retries after a timeout.
                try {
                    await client.close();
                } catch (error) {
                    const receipt: OmpShutdownReceipt = { kind: 'omp-rpc', status: 'unverified' };
                    this.session.recordShutdownReceipt(receipt);
                    this.nativeExit.resolve(receipt);
                    throw error;
                }
            }
            const exit = client?.exitInfo;
            const receipt: OmpShutdownReceipt = client
                ? { kind: 'omp-rpc', status: 'disposed', pid: exit?.pid, exitCode: exit?.code, signal: exit?.signal }
                : { kind: 'omp-rpc', status: this.attemptedNativeLaunch ? 'unverified' : 'not-started' };
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

        const nativeBusy = this.currentPrompt !== null || this.isStreaming;
        if (!nativeBusy) {
            return true;
        }

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
        try {
            prepared = await prepareOmpInput(input.text, input.attachments);
        } catch (error) {
            if (!this.session.queue.beginInvocation(input)) {
                return;
            }
            const detail = error instanceof Error ? error.message : String(error);
            this.reportInputFailure(detail);
            this.session.queue.completeInvocation(input);
            await this.sendReadyIfIdle();
            return;
        }
        if (!this.session.queue.isHeld(input)) {
            return;
        }

        const ignored = describeIgnoredOmpAttachments(prepared.ignoredAttachments);
        if (ignored) {
            this.session.sendSessionEvent({ type: 'message', message: ignored });
            this.messageBuffer.addMessage(ignored, 'status');
        }
        if (!prepared.message.trim() && !prepared.images?.length) {
            if (!this.session.queue.beginInvocation(input)) {
                return;
            }
            this.reportInputFailure('OMP RPC received no text or supported image attachment');
            this.session.queue.completeInvocation(input);
            await this.sendReadyIfIdle();
            return;
        }
        if (!this.session.queue.beginInvocation(input)) {
            return;
        }

        this.dispatching = true;
        this.readyEmittedForIdleCycle = false;
        const wasBusy = this.currentPrompt !== null || this.isStreaming;
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
            this.recordUserMessageOnce(input);
            const message = prepared.message;

            switch (input.inputMode) {
                case 'prompt': {
                    if (wasBusy) {
                        queuedFollowUp = true;
                        this.nativeFollowUpOutstanding = true;
                        const response = await client.request({
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
                        const response = await client.request({
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
                    await client.request({ type: 'steer', message, images: prepared.images });
                    break;
                case 'follow_up':
                    if (wasBusy) {
                        queuedFollowUp = true;
                        this.nativeFollowUpOutstanding = true;
                    } else {
                        startedPrompt = true;
                        this.beginPrompt(input.modeHash, 0);
                    }
                    await client.request({ type: 'follow_up', message, images: prepared.images });
                    break;
                case 'abort_and_prompt':
                    startedPrompt = true;
                    this.nativeFollowUpOutstanding = false;
                    this.beginPrompt(input.modeHash, wasBusy ? 1 : 0);
                    await client.request({ type: 'abort_and_prompt', message, images: prepared.images });
                    break;
                default: {
                    const exhaustive: never = input.inputMode;
                    return exhaustive;
                }
            }
            this.bufferedInputIds.delete(input.id);
            this.session.queue.completeInvocation(input);
        } catch (error) {
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
            this.session.queue.completeInvocation(input);
        } finally {
            this.dispatching = false;
            this.signalChange();
            await this.sendReadyIfIdle();
        }
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
            await runOmpSessionMutation(client, rpcMutation, this.session.applyNativeSessionSnapshot);
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            logger.warn('[omp-remote] RPC session mutation failed', error);
            this.session.sendSessionEvent({
                type: 'message',
                message: `Oh My Pi RPC session mutation failed: ${detail}`
            });
            this.messageBuffer.addMessage(`Oh My Pi RPC session mutation failed: ${detail}`, 'status');
        } finally {
            this.session.queue.completeInvocation(input);
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
        this.subagentTranscriptCursors.set(snapshot.id, transcript.nextByte);
        eventAdapter.seedSubagentMessages(
            snapshot.id,
            transcript.messages.map((message) => message.raw)
        );
    }

    private forwardAgentMessage(message: AgentMessage): void {
        if (message.type !== 'usage') {
            const converted = convertAgentMessage(message);
            if (converted) {
                this.session.sendAgentMessage(converted);
            }
            return;
        }

        this.trackEventTask((async () => {
            const state = await (await this.ensureClient()).request({ type: 'get_state' });
            this.persistRuntimeState(state);
            const resolvedModel = state.model ?? this.currentModel;
            const modelId = resolvedModel ? `${resolvedModel.provider}/${resolvedModel.id}` : null;
            const converted = convertAgentMessage({
                ...message,
                contextTokens: state.contextUsage?.tokens,
                contextWindow: state.contextUsage?.contextWindow
            }, modelId);
            if (converted) {
                this.session.sendAgentMessage(converted);
            }
        })());
    }

    private async refreshRuntimeState(): Promise<void> {
        const state = await (await this.ensureClient()).request({ type: 'get_state' });
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
        requested: OmpConfiguredThinkingLevel | undefined
    ): Promise<void> {
        if (requested === undefined || requested === this.confirmedConfiguredThinking) {
            return;
        }

        const client = await this.ensureClient();
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
        this.recordUserMessageOnce(input);

        if (queuedFollowUp) {
            this.nativeFollowUpOutstanding = false;
        }

        try {
            if ((input.inputMode === 'prompt' || input.inputMode === 'follow_up') && !this.nativeFollowUpOutstanding) {
                this.nativeFollowUpOutstanding = true;
                if (input.inputMode === 'prompt') {
                    const response = await client.request({
                        type: 'prompt',
                        message: prepared.message,
                        images: prepared.images,
                        streamingBehavior: 'followUp'
                    });
                    if (response?.agentInvoked === false) {
                        this.nativeFollowUpOutstanding = false;
                    }
                } else {
                    await client.request({
                        type: 'follow_up',
                        message: prepared.message,
                        images: prepared.images
                    });
                }
                this.bufferedInputIds.delete(input.id);
                this.session.queue.completeInvocation(input);
                return;
            }
            if (input.inputMode === 'steer') {
                await client.request({
                    type: 'steer',
                    message: prepared.message,
                    images: prepared.images
                });
                this.bufferedInputIds.delete(input.id);
                this.session.queue.completeInvocation(input);
                return;
            }
        } catch (fallbackError) {
            this.nativeFollowUpOutstanding = false;
            if (!this.isAlreadyProcessingError(fallbackError)) {
                if (startedPrompt) {
                    this.clearCurrentPrompt();
                }
                const detail = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
                logger.warn(`[omp-remote] RPC ${input.inputMode} busy-fallback failed`, fallbackError);
                this.reportInputFailure(detail);
                this.bufferedInputIds.delete(input.id);
                this.session.queue.completeInvocation(input);
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
            || this.currentPrompt !== null
            || this.nativeFollowUpOutstanding
            || this.session.queue.size() > 0
            || this.session.queue.heldSize() > 0
        );
    }

    private hasUnfinishedNativeInput(): boolean {
        return (
            this.dispatching
            || this.currentPrompt !== null
            || this.nativeFollowUpOutstanding
            || this.isStreaming
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
