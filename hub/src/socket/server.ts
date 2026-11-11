import { Server as Engine } from '@socket.io/bun-engine'
import { Server, type DefaultEventsMap } from 'socket.io'
import { jwtVerify } from 'jose'
import { z } from 'zod'
import type { Store } from '../store'
import { getConfiguration } from '../configuration'
import { constantTimeEquals } from '../utils/crypto'
import { parseAccessToken } from '../utils/accessToken'
import { registerCliHandlers } from './handlers/cli'
import { registerTerminalHandlers } from './handlers/terminal'
import { RpcRegistry } from './rpcRegistry'
import { SOCKET_MAX_HTTP_BUFFER_SIZE } from './socketLimits'
import type { SyncEvent } from '../sync/syncEngine'
import { TerminalRegistry } from './terminalRegistry'
import { clearUserTerminalBuffer } from './userTerminalBuffer'
import type { CliSocketWithData, SocketData, SocketServer, SocketWithData } from './socketTypes'
import type { RuntimeTimelineRegistry } from '../sync/runtimeTimeline'
import type { MultiUserGatewayStore } from '../../../fork-features/multi-user/gatewayStore'
import type { Capability } from '../../../fork-features/multi-user/domain'
import type { SessionMachineResolver, SessionPathResolver } from '../../../fork-features/multi-user/machineInheritance'
import { gatewayCredentialIdentity } from '../../../fork-features/multi-user/socketAdapter'

const jwtPayloadSchema = z.object({
    uid: z.number(),
    ns: z.string()
})

const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60_000
const DEFAULT_MAX_TERMINALS = 4

function resolveEnvNumber(name: string, fallback: number): number {
    const raw = process.env[name]
    if (!raw) {
        return fallback
    }
    const parsed = Number.parseInt(raw, 10)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export type SocketServerDeps = {
    store: Store
    jwtSecret: Uint8Array
    corsOrigins?: string[]
    getSession?: (sessionId: string) => { active: boolean; namespace: string } | null
    onWebappEvent?: (event: SyncEvent) => void
    onSessionAlive?: (payload: { sid: string; time: number; thinking?: boolean; mode?: 'local' | 'remote' }) => void
    onSessionReady?: (payload: { sid: string; time: number }) => void
    onSessionEnd?: (payload: { sid: string; time: number }) => void
    onMachineAlive?: (payload: { machineId: string; time: number; health?: unknown }) => void
    onBackgroundTaskDelta?: (sessionId: string, delta: { started: number; completed: number }) => void
    onSessionActivity?: (sessionId: string, updatedAt: number) => void
    onMessagesConsumed?: (sessionId: string) => void
    resolveTerminalNamespace?: (accountId: number, sessionId: string, capability?: Capability) => string | null
    resolveCliNamespace?: (token: string) => string | null
    sanitizeSessionMetadata?: (metadata: unknown) => unknown
    /** Live runtime timeline registry (beta); wired through to CLI session-runtime handler. */
    runtimeRegistry?: RuntimeTimelineRegistry
    /** Resolves a gateway API token to its principal (account + token row), not just namespace. */
    resolveCliIdentity?: (token: string) => { accountId: number; tokenId: number; namespace: string } | null
    /** Multi-user authorization context for runtime publisher checks. */
    gatewayStore?: MultiUserGatewayStore
    resolveSessionMachineId?: SessionMachineResolver
    resolveSessionPath?: SessionPathResolver
}

export function createSocketServer(deps: SocketServerDeps): {
    io: SocketServer
    engine: Engine
    rpcRegistry: RpcRegistry
} {
    const configuration = getConfiguration()
    const corsOrigins = deps.corsOrigins ?? configuration.corsOrigins
    const allowAllOrigins = corsOrigins.includes('*')
    const corsOriginOption = allowAllOrigins ? '*' : corsOrigins
    const corsOptions = {
        origin: corsOriginOption,
        methods: ['GET', 'POST'],
        credentials: false
    }

    const io = new Server<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, SocketData>({
        cors: corsOptions,
        maxHttpBufferSize: SOCKET_MAX_HTTP_BUFFER_SIZE
    })

    const engine = new Engine({
        path: '/socket.io/',
        cors: corsOptions,
        maxHttpBufferSize: SOCKET_MAX_HTTP_BUFFER_SIZE,
        allowRequest: async (req) => {
            const origin = req.headers.get('origin')
            if (!origin || allowAllOrigins || corsOrigins.includes(origin)) {
                return
            }
            throw 'Origin not allowed'
        }
    })
    io.bind(engine)

    const rpcRegistry = new RpcRegistry()
    const idleTimeoutMs = resolveEnvNumber('HAPI_TERMINAL_IDLE_TIMEOUT_MS', DEFAULT_IDLE_TIMEOUT_MS)
    const maxTerminals = resolveEnvNumber('HAPI_TERMINAL_MAX_TERMINALS', DEFAULT_MAX_TERMINALS)
    const maxTerminalsPerSocket = maxTerminals
    const maxTerminalsPerSession = maxTerminals
    const cliNs = io.of('/cli')
    const terminalNs = io.of('/terminal')
    const terminalRegistry = new TerminalRegistry({
        idleTimeoutMs,
        // Release the per-terminal scrollback buffer whenever a terminal is
        // genuinely removed (close / idle / CLI gone) so it
        // doesn't accumulate in the hub for the process's life. Reconnect
        // re-registers skip this (remove(id, false)) to keep their buffer.
        onRemove: (entry) => clearUserTerminalBuffer(entry.sessionId, entry.terminalId),
        onIdle: (entry) => {
            const terminalSocket = terminalNs.sockets.get(entry.socketId)
            terminalSocket?.emit('terminal:error', {
                terminalId: entry.terminalId,
                message: 'Terminal closed due to inactivity.'
            })
            const cliSocket = cliNs.sockets.get(entry.cliSocketId)
            cliSocket?.emit('terminal:close', {
                sessionId: entry.sessionId,
                terminalId: entry.terminalId
            })
        }
    })

    cliNs.use((socket, next) => {
        const auth = socket.handshake.auth as Record<string, unknown> | undefined
        const token = typeof auth?.token === 'string' ? auth.token : null
        // A configured gateway is authoritative, including rejection/revocation.
        // Never let the legacy shared key bypass its token inventory.
        if (deps.resolveCliIdentity) {
            const identity = token ? deps.resolveCliIdentity(token) : null
            if (!identity) return next(new Error('Invalid token'))
            socket.data.namespace = identity.namespace
            socket.data.gatewayAccountId = identity.accountId
            socket.data.gatewayTokenId = identity.tokenId
            next()
            return
        }
        if (deps.resolveCliNamespace) {
            const namespace = token ? deps.resolveCliNamespace(token) : null
            if (!namespace) return next(new Error('Invalid token'))
            socket.data.namespace = namespace
            next()
            return
        }
        const parsedToken = token ? parseAccessToken(token) : null
        if (!parsedToken || !constantTimeEquals(parsedToken.baseToken, configuration.cliApiToken)) {
            return next(new Error('Invalid token'))
        }
        socket.data.namespace = parsedToken.namespace
        socket.data.cliTrusted = true
        next()
    })
    cliNs.on('connection', (socket) => registerCliHandlers(socket as CliSocketWithData, {
        io,
        store: deps.store,
        rpcRegistry,
        terminalRegistry,
        onSessionAlive: deps.onSessionAlive,
        onSessionReady: deps.onSessionReady,
        onSessionEnd: deps.onSessionEnd,
        onMachineAlive: deps.onMachineAlive,
        onWebappEvent: deps.onWebappEvent,
        onBackgroundTaskDelta: deps.onBackgroundTaskDelta,
        onSessionActivity: deps.onSessionActivity,
        onMessagesConsumed: deps.onMessagesConsumed,
        sanitizeSessionMetadata: deps.sanitizeSessionMetadata,
        runtimeRegistry: deps.runtimeRegistry,
        gatewayStore: deps.gatewayStore,
        resolveSessionMachineId: deps.resolveSessionMachineId,
        resolveSessionPath: deps.resolveSessionPath,
        resolveTerminalNamespace: deps.resolveTerminalNamespace
    }))

    terminalNs.use(async (socket, next) => {
        const auth = socket.handshake.auth as Record<string, unknown> | undefined
        const token = typeof auth?.token === 'string' ? auth.token : null
        if (!token) {
            return next(new Error('Missing token'))
        }

        try {
            const verified = await jwtVerify(token, deps.jwtSecret, { algorithms: ['HS256'] })
            const parsed = jwtPayloadSchema.safeParse(verified.payload)
            if (!parsed.success) {
                return next(new Error('Invalid token payload'))
            }
            socket.data.userId = parsed.data.uid
            socket.data.namespace = parsed.data.ns
            // A gateway-issued token must still be backed by the live account/
            // API-token inventory — a valid signature alone must not reconnect
            // a disabled account or a revoked token. Fail closed when no
            // gateway store exists to answer the check.
            if (typeof verified.payload.gaid === 'number') {
                const identity = deps.gatewayStore
                    ? gatewayCredentialIdentity(deps.gatewayStore, { gaid: verified.payload.gaid, tid: verified.payload.tid })
                    : null
                if (!identity) {
                    return next(new Error('Invalid token'))
                }
                socket.data.gatewayAccountId = identity.accountId
                socket.data.gatewayTokenId = identity.tokenId
            }
            next()
            return
        } catch {
            return next(new Error('Invalid token'))
        }
    })
    const getSessionForTerminal = (sessionId: string) => {
        return deps.getSession?.(sessionId) ?? deps.store.sessions.getSession(sessionId)
    }
    // Authoritative per-account ACL for everything a /terminal socket may do to
    // a session. A configured gateway resolver's denial is final: there is no
    // same-namespace fallback that would let a denied account back in. Legacy
    // (non-gateway) sockets keep the same-namespace rule. `read` covers
    // subscribe/replay/output; `operate` is required to spawn or drive a PTY.
    const authorizeTerminalSocket = (
        terminalSocket: SocketWithData,
        sessionId: string,
        capability: Capability
    ): string | null => {
        const accountId = terminalSocket.data.gatewayAccountId
        if (typeof accountId !== 'number') {
            const session = getSessionForTerminal(sessionId)
            const namespace = terminalSocket.data.namespace
            return typeof namespace === 'string' && session?.namespace === namespace ? namespace : null
        }
        return deps.resolveTerminalNamespace?.(accountId, sessionId, capability) ?? null
    }
    terminalNs.on('connection', (socket) => registerTerminalHandlers(socket, {
        io,
        getSession: getSessionForTerminal,
        terminalRegistry,
        maxTerminalsPerSocket,
        maxTerminalsPerSession,
        resolveNamespaceForSession: (s, sessionId, capability) =>
            authorizeTerminalSocket(s, sessionId, capability ?? 'operate')
    }))

    return { io, engine, rpcRegistry }
}
