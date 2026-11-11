import { logger } from '@/ui/logger';
import { ompLoop } from './loop';
import { hashObject } from '@/utils/deterministicJson';
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler';
import type { AgentState } from '@/api/types';
import type { OmpSession } from './session';
import type { OmpMode, PermissionMode } from './types';
import { bootstrapExistingSession, bootstrapSession } from '@/agent/sessionFactory';
import { registerLocalHandoffHandler } from '@/agent/localHandoff';
import { createModeChangeHandler, createRunnerLifecycle, setControlledByUser } from '@/agent/runnerLifecycle';
import { isPermissionModeAllowedForFlavor } from '@hapi/protocol';
import { PermissionModeSchema } from '@hapi/protocol/schemas';
import { getInvokedCwd } from '@/utils/invokedCwd';
import { resolveOmpRuntimeConfig } from './utils/config';
import { OmpInputQueue } from './OmpInputQueue';
import { loadOmpEventAllowlist } from './rpc/eventAllowlist';
import { createOmpUsageMonitor, ensureOmpUsageExtension } from './utils/ompUsageMonitor';
import { notifyRunnerSessionCleanupVerified } from '@/runner/controlClient';
import { ensureCx2ccUsageExtension } from '../../../fork-features/omp-host-integration/cx2ccUsageExtension';
import { prepareOmpSessionResume } from './utils/ompSessionScanner';
import {
    OMP_THINKING_LEVELS,
    type OmpConfiguredThinkingLevel
} from '@hapi/protocol/omp';

function parseConfiguredThinking(value: string): OmpConfiguredThinkingLevel {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'auto') {
        return 'auto';
    }
    if ((OMP_THINKING_LEVELS as readonly string[]).includes(normalized)) {
        return normalized as OmpConfiguredThinkingLevel;
    }
    throw new Error(`Invalid OMP thinking level: ${value}`);
}

function resolveConfiguredThinking(
    value: string | undefined
): OmpConfiguredThinkingLevel | undefined {
    return value === undefined ? undefined : parseConfiguredThinking(value);
}

export async function runOmp(opts: {
    startedBy?: 'runner' | 'terminal';
    startingMode?: 'local' | 'remote';
    permissionMode?: PermissionMode;
    model?: string;
    effort?: string;
    resumeSessionId?: string;
    existingSessionId?: string;
    workingDirectory?: string;
} = {}): Promise<void> {
    // Reject invalid presentation configuration before creating a hub session.
    // The remote launcher reads it again on every remote entry.
    await loadOmpEventAllowlist();
    const workingDirectory = opts.workingDirectory ?? getInvokedCwd();
    const startedBy = opts.startedBy ?? 'terminal';

    logger.debug(`[omp] Starting with options: startedBy=${startedBy}, startingMode=${opts.startingMode}`);

    if (startedBy === 'runner' && opts.startingMode === 'local') {
        logger.debug('[omp] Runner spawn requested with local mode; forcing remote mode');
        opts.startingMode = 'remote';
    }

    const initialState: AgentState = {
        controlledByUser: false
    };

    const machineDefault = resolveOmpRuntimeConfig().model;
    const runtimeConfig = resolveOmpRuntimeConfig({ model: opts.model });
    const persistedModel = runtimeConfig.modelSource === 'default'
        ? undefined
        : runtimeConfig.model;
    let configuredThinking = resolveConfiguredThinking(opts.effort);

    const bootstrap = opts.existingSessionId
        ? await bootstrapExistingSession({
            sessionId: opts.existingSessionId,
            flavor: 'omp',
            startedBy,
            workingDirectory
        })
        : await bootstrapSession({
            flavor: 'omp',
            startedBy,
            workingDirectory,
            agentState: initialState,
            model: persistedModel,
            effort: configuredThinking
        });
    const { api, session } = bootstrap;
    const restoring = Boolean(opts.existingSessionId || opts.resumeSessionId);
    const restoredModel = opts.model !== undefined
        ? runtimeConfig.model
        : restoring ? bootstrap.sessionInfo?.model ?? undefined : persistedModel;
    configuredThinking ??= bootstrap.metadata.ompThinking?.configured ?? undefined;
    let resumeSessionId = opts.resumeSessionId ?? bootstrap.metadata.ompSession?.id;
    let nativeSession = bootstrap.metadata.ompSession;

    const startingMode: 'local' | 'remote' = opts.startingMode
        ?? (startedBy === 'runner' ? 'remote' : 'local');

    setControlledByUser(session, startingMode);

    const messageQueue = new OmpInputQueue((mode) => hashObject({
        permissionMode: mode.permissionMode,
        model: mode.model,
        effort: mode.effort
    }));

    const sessionWrapperRef: { current: OmpSession | null } = { current: null };
    let currentPermissionMode: PermissionMode = opts.permissionMode ?? 'default';
    let sessionModel: string | null = restoredModel ?? null;
    let resolvedModel = sessionModel ?? (restoring ? undefined : machineDefault);
    const usageMonitor = createOmpUsageMonitor({
        sessionId: session.sessionId,
        getPrimarySessionFile: () => sessionWrapperRef.current?.getNativeSession()?.file
            ?? session.getMetadata()?.ompSession?.file ?? null,
        onUsage: (event) => session.sendClaudeSessionMessage(event)
    });

    const lifecycle = createRunnerLifecycle({
        session,
        logTag: 'omp',
        stopKeepAlive: () => sessionWrapperRef.current?.stopKeepAlive(),
        onShutdownRequest: async () => {
            const receipt = await sessionWrapperRef.current?.requestShutdown();
            if (receipt?.status === 'unverified') {
                throw new Error('OMP native cleanup was not confirmed; session resources may still be running');
            }
            await notifyRunnerSessionCleanupVerified(session.sessionId);
        },
        onBeforeClose: () => usageMonitor.cleanup()
    });

    lifecycle.registerProcessHandlers();
    registerKillSessionHandler(session.rpcHandlerManager, lifecycle);
    registerLocalHandoffHandler(session.rpcHandlerManager, lifecycle);

    const syncSessionMode = () => {
        const sessionInstance = sessionWrapperRef.current;
        if (!sessionInstance) {
            return;
        }
        sessionInstance.setPermissionMode(currentPermissionMode);
        sessionInstance.setModel(sessionModel);
        if (configuredThinking) {
            sessionInstance.setEffort(configuredThinking);
        }
        sessionInstance.pushKeepAlive();

        logger.debug(
            `[omp] Synced session config for keepalive: permissionMode=${currentPermissionMode}, `
            + `model=${resolvedModel ?? 'default'}, effort=${configuredThinking ?? 'native-default'}`
        );
    };

    session.onUserMessage((message, localId) => {
        const mode: OmpMode = {
            permissionMode: currentPermissionMode,
            model: sessionWrapperRef.current?.getModel() ?? resolvedModel,
            effort: sessionWrapperRef.current?.getEffort() ?? configuredThinking
        };
        messageQueue.push({
            forced: session.consumeForceMark?.(localId) ?? false,
            text: message.content.text,
            attachments: message.content.attachments,
            inputMode: message.meta?.ompInputMode ?? (message.meta?.deliveryMode === 'steer' ? 'steer' : 'prompt'),
            mode,
            localId
        });
    });

    session.onCancelQueuedMessage(async (localId) => {
        const wrapper = sessionWrapperRef.current;
        const removed = wrapper ? await wrapper.cancelQueuedInput(localId) : messageQueue.cancelByLocalId(localId);
        logger.debug(`[omp] cancelByLocalId(${localId}): ${removed ? 'removed' : 'not confirmed'}`);
        return removed;
    });

    session.onForceQueuedMessages?.(async localIds => {
        const wrapper = sessionWrapperRef.current;
        if (wrapper) return await wrapper.forceQueuedInputs(localIds);
        return localIds.map(localId => ({ localId, status: messageQueue.markForced(localId) ? 'accepted' as const : 'not-found' as const }));
    });

    const resolvePermissionMode = (value: unknown): PermissionMode => {
        const parsed = PermissionModeSchema.safeParse(value);
        if (!parsed.success || !isPermissionModeAllowedForFlavor(parsed.data, 'omp')) {
            throw new Error('Invalid permission mode');
        }
        return parsed.data as PermissionMode;
    };

    const resolveModel = (value: unknown): string | null => {
        if (value === null) {
            return null;
        }
        if (typeof value === 'string' && value.trim().length > 0) {
            return value.trim();
        }
        if (
            value
            && typeof value === 'object'
            && 'provider' in value
            && 'modelId' in value
            && typeof value.provider === 'string'
            && value.provider.trim().length > 0
            && typeof value.modelId === 'string'
            && value.modelId.trim().length > 0
        ) {
            return `${value.provider.trim()}/${value.modelId.trim()}`;
        }
        throw new Error('Invalid model');
    };

    const resolveEffort = (value: unknown): OmpConfiguredThinkingLevel => {
        if (value === null) {
            return 'auto';
        }
        if (typeof value !== 'string') {
            throw new Error('Invalid effort');
        }
        return parseConfiguredThinking(value);
    };

    session.rpcHandlerManager.registerHandler('set-session-config', async (payload: unknown) => {
        if (!payload || typeof payload !== 'object') {
            throw new Error('Invalid session config payload');
        }
        const config = payload as { permissionMode?: unknown; model?: unknown; effort?: unknown };
        const applied: Record<string, unknown> = {};

        if (config.permissionMode !== undefined) {
            currentPermissionMode = resolvePermissionMode(config.permissionMode);
            applied.permissionMode = currentPermissionMode;
        }

        const requestedModel = config.model === undefined
            ? undefined
            : resolveModel(config.model);
        const requestedEffort = config.effort === undefined
            ? undefined
            : resolveEffort(config.effort);

        if (requestedModel !== undefined || requestedEffort !== undefined) {
            const sessionInstance = sessionWrapperRef.current;
            if (!sessionInstance) {
                throw new Error('OMP native runtime is not ready for configuration changes');
            }
            const confirmed = await sessionInstance.applyRuntimeConfig({
                ...(requestedModel !== undefined ? { model: requestedModel } : {}),
                ...(requestedEffort !== undefined ? { effort: requestedEffort } : {})
            });
            if (requestedModel !== undefined) {
                if (!confirmed.model) {
                    throw new Error('OMP did not confirm the requested model');
                }
                sessionModel = confirmed.model;
                resolvedModel = confirmed.model;
                applied.model = confirmed.model;
            }
            if (requestedEffort !== undefined) {
                if (!confirmed.effort) {
                    throw new Error('OMP did not confirm the requested effort');
                }
                configuredThinking = confirmed.effort;
                applied.effort = confirmed.effort;
            }
        }

        syncSessionMode();
        return { applied };
    });

    let crashed = false;

    try {
        if (configuredThinking === undefined && bootstrap.sessionInfo?.effort) {
            configuredThinking = parseConfiguredThinking(bootstrap.sessionInfo.effort);
        }
        if (nativeSession && resumeSessionId !== nativeSession.id) {
            throw new Error('Requested OMP native session does not match the existing HAPI row');
        }
        if (resumeSessionId) {
            const resume = await prepareOmpSessionResume(resumeSessionId, nativeSession, workingDirectory);
            if (resume.kind === 'empty') {
                resumeSessionId = undefined;
                nativeSession = undefined;
            }
        }
        await ensureOmpUsageExtension();
        try {
            await ensureCx2ccUsageExtension();
        } catch (error) {
            logger.debug('[OMP] Unable to install cx2cc usage extension', error);
        }
        await usageMonitor.start();
        await ompLoop({
            path: workingDirectory,
            startingMode,
            startedBy,
            messageQueue,
            session,
            api,
            permissionMode: currentPermissionMode,
            model: restoredModel,
            effort: configuredThinking,
            resumeSessionId,
            nativeSession,
            onModeChange: createModeChangeHandler(session),
            onSessionReady: (instance) => {
                sessionWrapperRef.current = instance;
                syncSessionMode();
            }
        });
    } catch (error) {
        crashed = true;
        lifecycle.markCrash(error);
        const detail = error instanceof Error ? error.message : String(error);
        session.sendSessionEvent({ type: 'message', message: `OMP session failed: ${detail}` });
        logger.debug('[omp] Loop error:', error);
    } finally {
        const localFailure = sessionWrapperRef.current?.localLaunchFailure;
        if (localFailure?.exitReason === 'exit') {
            lifecycle.setExitCode(1);
            lifecycle.setArchiveReason(`Local launch failed: ${localFailure.message.slice(0, 200)}`);
            lifecycle.setSessionEndReason('error');
        } else if (!crashed && !lifecycle.hasExplicitSessionEndReason()) {
            lifecycle.setSessionEndReason(sessionWrapperRef.current?.isShutdownRequested() ? 'terminated' : 'completed');
        }
        await lifecycle.cleanupAndExit();
    }
}
