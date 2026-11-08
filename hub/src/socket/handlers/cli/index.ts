import type { CodexCollaborationMode, PermissionMode } from '@hapi/protocol/types'
import type { Store, StoredMachine, StoredSession } from '../../../store'
import type { RpcRegistry } from '../../rpcRegistry'
import type { SyncEvent } from '../../../sync/syncEngine'
import type { TerminalRegistry } from '../../terminalRegistry'
import type { CliSocketWithData, SocketServer } from '../../socketTypes'
import type { AccessErrorReason, AccessResult } from './types'
import { registerMachineHandlers } from './machineHandlers'
import { registerRpcHandlers } from './rpcHandlers'
import { registerSessionHandlers } from './sessionHandlers'
import { registerRuntimeHandlers } from './runtimeHandlers'
import type { RuntimeTimelineRegistry } from '../../../sync/runtimeTimeline'
import { ExecutionDispatcher } from '../../../../../fork-features/multi-user/executionDispatcher'
import type { MultiUserGatewayStore } from '../../../../../fork-features/multi-user/gatewayStore'
import type { SessionMachineResolver, SessionPathResolver } from '../../../../../fork-features/multi-user/machineInheritance'
import { cleanupTerminalHandlers, registerTerminalHandlers } from './terminalHandlers'

type SessionAlivePayload = {
    sid: string
    time: number
    thinking?: boolean
    mode?: 'local' | 'remote'
    permissionMode?: PermissionMode
    model?: string | null
    modelReasoningEffort?: string | null
    effort?: string | null
    collaborationMode?: CodexCollaborationMode
}

type SessionEndPayload = {
    sid: string
    time: number
}

type SessionReadyPayload = {
    sid: string
    time: number
}

type MachineAlivePayload = {
    machineId: string
    time: number
}

export type CliHandlersDeps = {
    io: SocketServer
    store: Store
    rpcRegistry: RpcRegistry
    terminalRegistry: TerminalRegistry
    onSessionAlive?: (payload: SessionAlivePayload) => void
    onSessionReady?: (payload: SessionReadyPayload) => void
    onSessionEnd?: (payload: SessionEndPayload) => void
    onMachineAlive?: (payload: MachineAlivePayload) => void
    onWebappEvent?: (event: SyncEvent) => void
    onBackgroundTaskDelta?: (sessionId: string, delta: { started: number; completed: number }) => void
    onSessionActivity?: (sessionId: string, updatedAt: number) => void
    onSweepImmediateQueued?: (sessionId: string, now: number) => void
    onMessagesConsumed?: (sessionId: string) => void
    /** fork-features/multi-user: strips injected gateway memory out of CLI-reported titles. */
    sanitizeSessionMetadata?: (metadata: unknown) => unknown
    runtimeRegistry?: RuntimeTimelineRegistry
    gatewayStore?: MultiUserGatewayStore
    resolveSessionMachineId?: SessionMachineResolver
    resolveSessionPath?: SessionPathResolver
}

export function registerCliHandlers(socket: CliSocketWithData, deps: CliHandlersDeps): void {
    const { io, store, rpcRegistry, terminalRegistry, onSessionAlive, onSessionReady, onSessionEnd, onMachineAlive, onWebappEvent, onBackgroundTaskDelta, onSessionActivity, onSweepImmediateQueued, onMessagesConsumed, sanitizeSessionMetadata, runtimeRegistry, gatewayStore, resolveSessionMachineId, resolveSessionPath } = deps
    const terminalNamespace = io.of('/terminal')
    const namespace = typeof socket.data.namespace === 'string' ? socket.data.namespace : null

    const resolveSessionAccess = (sessionId: string): AccessResult<StoredSession> => {
        if (!namespace) {
            return { ok: false, reason: 'namespace-missing' }
        }
        const session = store.sessions.getSessionByNamespace(sessionId, namespace)
        if (session) {
            return { ok: true, value: session }
        }
        if (store.sessions.getSession(sessionId)) {
            return { ok: false, reason: 'access-denied' }
        }
        return { ok: false, reason: 'not-found' }
    }

    const resolveMachineAccess = (machineId: string): AccessResult<StoredMachine> => {
        if (!namespace) {
            return { ok: false, reason: 'namespace-missing' }
        }
        const machine = store.machines.getMachineByNamespace(machineId, namespace)
        if (machine) {
            return { ok: true, value: machine }
        }
        if (store.machines.getMachine(machineId)) {
            return { ok: false, reason: 'access-denied' }
        }
        return { ok: false, reason: 'not-found' }
    }

    const auth = socket.handshake.auth as Record<string, unknown> | undefined
    const sessionId = typeof auth?.sessionId === 'string' ? auth.sessionId : null
    if (sessionId && resolveSessionAccess(sessionId).ok) {
        socket.join(`session:${sessionId}`)
    }

    const machineId = typeof auth?.machineId === 'string' ? auth.machineId : null
    if (machineId && resolveMachineAccess(machineId).ok) {
        socket.join(`machine:${machineId}`)
    }

    const emitAccessError = (scope: 'session' | 'machine', id: string, reason: AccessErrorReason) => {
        const message = reason === 'access-denied'
            ? `${scope} access denied`
            : reason === 'not-found'
                ? `${scope} not found`
                : 'Namespace missing'
        socket.emit('error', { message, code: reason, scope, id })
    }

    registerRpcHandlers(socket, rpcRegistry)
    registerSessionHandlers(socket, {
        store,
        resolveSessionAccess,
        emitAccessError,
        onSessionAlive,
        onSessionReady,
        onSessionEnd,
        onWebappEvent,
        onBackgroundTaskDelta,
        onSessionActivity,
        onSweepImmediateQueued,
        onMessagesConsumed,
        sanitizeSessionMetadata
    })
    registerMachineHandlers(socket, {
        store,
        resolveMachineAccess,
        emitAccessError,
        onMachineAlive,
        onWebappEvent
    })
    registerTerminalHandlers(socket, {
        terminalRegistry,
        terminalNamespace,
        resolveSessionAccess,
        emitAccessError
    })
    if (runtimeRegistry) {
        const runtimeDispatcher = gatewayStore
            ? new ExecutionDispatcher(gatewayStore, resolveSessionMachineId, resolveSessionPath)
            : null
        const authorizeSessionPublication = socket.data.cliTrusted === true
            ? () => true
            : (sessionId: string): boolean => {
                const accountId = socket.data.gatewayAccountId
                const tokenId = socket.data.gatewayTokenId
                if (!runtimeDispatcher || !gatewayStore || typeof accountId !== 'number' || typeof tokenId !== 'number') {
                    return false
                }
                const token = gatewayStore.getToken(tokenId)
                if (!token || token.revokedAt !== null || token.accountId !== accountId) {
                    return false
                }
                return runtimeDispatcher.authorize({
                    accountId,
                    capability: 'operate',
                    resource: { type: 'session', id: sessionId }
                }).kind === 'allow'
            }
        registerRuntimeHandlers(socket, {
            store,
            registry: runtimeRegistry,
            resolveSessionAccess,
            emitAccessError,
            authorizeSessionPublication
        })
    }

    socket.on('ping', (callback: () => void) => {
        callback()
    })

    socket.on('disconnect', () => {
        rpcRegistry.unregisterAll(socket)
        cleanupTerminalHandlers(socket, { terminalRegistry, terminalNamespace })
    })
}
