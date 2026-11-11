import { ApiClient, ApiSessionClient } from '@/lib';
import { AgentSessionBase } from '@/agent/sessionBase';
import type { OmpMode, PermissionMode } from './types';
import type { LocalLaunchExitReason } from '@/agent/localLaunchPolicy';
import type { OmpNativeSession } from '@hapi/protocol/types';
import type { OmpConfiguredThinkingLevel, OmpThinkingState } from '@hapi/protocol/omp';
import type { OmpInputQueue } from './OmpInputQueue';
import { configuration } from '@/configuration';
import { OmpInputDeliveryStore } from './OmpInputDeliveryStore';
import type { OmpNativeOrder } from './rpc/OmpRpcEventAdapter';
import type { ForceQueuedMessageAck } from '@hapi/protocol';

type LocalLaunchFailure = {
    message: string;
    exitReason: LocalLaunchExitReason;
};

export type OmpRuntimeConfigRequest = {
    model?: string | null;
    effort?: OmpConfiguredThinkingLevel;
};

export type OmpRuntimeConfigApplied = {
    model?: string;
    effort?: OmpConfiguredThinkingLevel;
};

type OmpRuntimeConfigApplier = (
    config: OmpRuntimeConfigRequest
) => Promise<OmpRuntimeConfigApplied>;

export type OmpShutdownReceipt = {
    kind: 'omp-rpc' | 'omp-local';
    status: 'disposed' | 'not-started' | 'unverified';
    pid?: number;
    exitCode?: number | null;
    signal?: string | null;
};

type OmpShutdownHandle = {
    requestExit: () => void | Promise<void>;
    waitForExit: () => Promise<OmpShutdownReceipt>;
};

export class OmpSession extends AgentSessionBase<OmpMode, OmpInputQueue> {
    readonly startedBy: 'runner' | 'terminal';
    readonly startingMode: 'local' | 'remote';
    localLaunchFailure: LocalLaunchFailure | null = null;
    private nativeSession: OmpNativeSession | null;
    private runtimeConfigApplier: OmpRuntimeConfigApplier | null = null;
    private shutdownHandle: OmpShutdownHandle | null = null;
    private shutdownPromise: Promise<OmpShutdownReceipt> | null = null;
    private shutdownRequested = false;
    private lastShutdownReceipt: OmpShutdownReceipt = { kind: 'omp-rpc', status: 'not-started' };
    #inputDeliveryStore: OmpInputDeliveryStore | null = null;
    private nativeInputCanceller: ((localId: string) => Promise<boolean>) | null = null;
    private nativeInputForcer: ((localId: string) => Promise<ForceQueuedMessageAck>) | null = null;

    registerNativeInputForcer(handler: (localId: string) => Promise<ForceQueuedMessageAck>): () => void {
        this.nativeInputForcer = handler;
        return () => { if (this.nativeInputForcer === handler) this.nativeInputForcer = null; };
    }

    async forceQueuedInputs(localIds: string[]): Promise<ForceQueuedMessageAck[]> {
        return await Promise.all(localIds.map(async localId => {
            if (this.getInputDeliveryStore().hasNativeAttempt(localId) && this.nativeInputForcer) {
                return await this.nativeInputForcer(localId);
            }
            if (this.queue.markForced(localId)) return { localId, status: 'accepted' as const };
            return { localId, status: 'not-found' as const };
        }));
    }

    registerNativeInputCanceller(handler: (localId: string) => Promise<boolean>): () => void {
        this.nativeInputCanceller = handler;
        return () => { if (this.nativeInputCanceller === handler) this.nativeInputCanceller = null; };
    }

    async cancelQueuedInput(localId: string): Promise<boolean> {
        const hasNativeAttempt = this.getInputDeliveryStore().hasNativeAttempt(localId);
        const removedLocally = this.queue.cancelByLocalId(localId);
        if (removedLocally && !hasNativeAttempt) return true;
        return this.nativeInputCanceller ? await this.nativeInputCanceller(localId) : false;
    }

    getInputDeliveryStore(): OmpInputDeliveryStore {
        return this.#inputDeliveryStore ??= new OmpInputDeliveryStore(configuration.runnerStateFile, this.client.sessionId);
    }

    isShutdownRequested = (): boolean => this.shutdownRequested;

    registerShutdownHandle = (handle: OmpShutdownHandle): (() => void) => {
        this.shutdownHandle = handle;
        return () => {
            if (this.shutdownHandle === handle) this.shutdownHandle = null;
        };
    };

    recordShutdownReceipt = (receipt: OmpShutdownReceipt): void => {
        this.lastShutdownReceipt = receipt;
    };

    requestShutdown = (): Promise<OmpShutdownReceipt> => {
        this.shutdownRequested = true;
        if (!this.shutdownPromise) {
            const handle = this.shutdownHandle;
            if (!handle) return Promise.resolve(this.lastShutdownReceipt);
            this.shutdownPromise = (async () => {
                try {
                    await handle.requestExit();
                    const receipt = await handle.waitForExit();
                    this.recordShutdownReceipt(receipt);
                    if (receipt.status === 'unverified') this.shutdownPromise = null;
                    return receipt;
                } catch (error) {
                    this.shutdownPromise = null;
                    throw error;
                }
            })();
        }
        return this.shutdownPromise;
    };

    constructor(opts: {
        api: ApiClient;
        client: ApiSessionClient;
        path: string;
        logPath: string;
        sessionId: string | null;
        messageQueue: OmpInputQueue;
        onModeChange: (mode: 'local' | 'remote') => void;
        mode?: 'local' | 'remote';
        startedBy: 'runner' | 'terminal';
        startingMode: 'local' | 'remote';
        permissionMode?: PermissionMode;
        model?: string | null;
        effort?: OmpConfiguredThinkingLevel;
        nativeSession?: OmpNativeSession;
    }) {
        super({
            api: opts.api,
            client: opts.client,
            path: opts.path,
            logPath: opts.logPath,
            sessionId: opts.sessionId,
            messageQueue: opts.messageQueue,
            onModeChange: opts.onModeChange,
            mode: opts.mode,
            sessionLabel: 'OmpSession',
            sessionIdLabel: 'Omp',
            applySessionIdToMetadata: (metadata, sessionId, extras) => {
                const nativeSession = extras?.ompSession;
                if (!nativeSession || nativeSession.id !== sessionId) {
                    throw new Error('OMP native session snapshot must accompany its session ID');
                }
                const previousNative = metadata.ompSession;
                const sameNativeSession = previousNative?.id === nativeSession.id;
                const nativeNameChanged = !sameNativeSession || previousNative?.name !== nativeSession.name;
                const next = {
                    ...metadata,
                    ompSession: nativeSession
                };
                if (nativeSession.name && (nativeNameChanged || !metadata.name)) {
                    next.name = nativeSession.name;
                } else if (!sameNativeSession && !nativeSession.name) {
                    delete next.name;
                }
                return next;
            },
            permissionMode: opts.permissionMode,
            model: opts.model,
            effort: opts.effort
        });

        this.startedBy = opts.startedBy;
        this.startingMode = opts.startingMode;
        this.permissionMode = opts.permissionMode;
        this.nativeSession = opts.nativeSession ?? null;
    }

    setPermissionMode = (mode: PermissionMode): void => {
        this.permissionMode = mode;
    };

    setModel = (model: string | null): void => {
        this.model = model;
    };

    setEffort = (effort: OmpConfiguredThinkingLevel): void => {
        this.effort = effort;
    };

    override getEffort(): OmpConfiguredThinkingLevel | undefined {
        return this.effort as OmpConfiguredThinkingLevel | undefined;
    }

    setRuntimeConfigApplier = (applier: OmpRuntimeConfigApplier | null): void => {
        this.runtimeConfigApplier = applier;
    };

    applyRuntimeConfig = async (
        config: OmpRuntimeConfigRequest
    ): Promise<OmpRuntimeConfigApplied> => {
        if (!this.runtimeConfigApplier) {
            throw new Error('OMP native runtime is not ready for configuration changes');
        }
        return await this.runtimeConfigApplier(config);
    };

    updateThinkingState = (state: OmpThinkingState): void => {
        if (state.configured !== null) this.effort = state.configured;
        this.client.updateMetadata((metadata) => ({
            ...metadata,
            ompThinking: state
        }));
    };

    updateDiscoveredCapabilities = (capabilities: {
        tools?: string[];
        slashCommands?: string[];
    }): void => {
        this.client.updateMetadata((metadata) => ({
            ...metadata,
            ...(capabilities.tools ? { tools: capabilities.tools } : {}),
            ...(capabilities.slashCommands ? { slashCommands: capabilities.slashCommands } : {})
        }));
    };

    applyNativeSessionSnapshot = (snapshot: OmpNativeSession): void => {
        const next: OmpNativeSession = this.nativeSession?.id === snapshot.id
            && this.nativeSession.persistence === 'persisted'
            ? { ...snapshot, persistence: 'persisted' }
            : snapshot;
        this.nativeSession = next;
        this.onSessionFound(next.id, { ompSession: next });
    };

    getNativeSession = (): OmpNativeSession | null => this.nativeSession;

    recordLocalLaunchFailure = (message: string, exitReason: LocalLaunchExitReason): void => {
        this.localLaunchFailure = { message, exitReason };
    };

    sendAgentMessage = (message: unknown, options?: { nativeOrder?: OmpNativeOrder }): void => {
        this.client.sendAgentMessage(message, options);
    };

    sendUserMessage = (text: string): void => {
        this.client.sendUserMessage(text);
    };

    sendSessionEvent = (event: Parameters<ApiSessionClient['sendSessionEvent']>[0]): void => {
        this.client.sendSessionEvent(event);
    };
}
