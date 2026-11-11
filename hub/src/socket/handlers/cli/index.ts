import type { CodexCollaborationMode, PermissionMode } from '@hapi/protocol/types'
import { MetadataSchema } from '@hapi/protocol/schemas'
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
import type { Capability } from '../../../../../fork-features/multi-user/domain'
import type { SessionMachineResolver, SessionPathResolver } from '../../../../../fork-features/multi-user/machineInheritance'
import { cleanupTerminalHandlers, registerTerminalHandlers } from './terminalHandlers'

const RECONNECT_PUBLICATIONS: Record<string, true> = { message: true, 'messages-consumed': true, 'messages-resolved': true, 'session-ready': true, 'session-end': true, 'update-metadata': true, 'update-state': true }
const MAX_RECONNECT_PUBLICATIONS = 256
const MAX_RECONNECT_PUBLICATION_BYTES = 8 * 1024 * 1024
const RECONNECT_REGISTRATION_WAIT_MS = 5000

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
 onMessagesConsumed?: (sessionId: string) => void
 /** fork-features/multi-user: strips injected gateway memory out of CLI-reported titles. */
 sanitizeSessionMetadata?: (metadata: unknown) => unknown
 /** Live runtime timeline registry (beta). Absent => 'session-runtime' not handled. */
 runtimeRegistry?: RuntimeTimelineRegistry
 /** Gateway store + resolvers enable per-publication operate authorization for runtime feeds. */
 gatewayStore?: MultiUserGatewayStore
 resolveSessionMachineId?: SessionMachineResolver
 resolveSessionPath?: SessionPathResolver
 /** Per-account terminal ACL (same dep as the /terminal namespace handlers). */
 resolveTerminalNamespace?: (accountId: number, sessionId: string, capability?: Capability) => string | null
}

export function registerCliHandlers(socket: CliSocketWithData, deps: CliHandlersDeps): void {
 const { io, store, rpcRegistry, terminalRegistry, onSessionAlive, onSessionReady, onSessionEnd, onMachineAlive, onWebappEvent, onBackgroundTaskDelta, onSessionActivity, onMessagesConsumed, sanitizeSessionMetadata, runtimeRegistry, gatewayStore, resolveSessionMachineId, resolveSessionPath, resolveTerminalNamespace } = deps
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
 const sourceId = typeof auth?.ompSourceId === 'string' && auth.ompSourceId.length > 0 ? auth.ompSourceId : null
 rpcRegistry.bindSourceStore(store.sessions.ompSources)
 const sourceOrder = rpcRegistry.nextSourceConnectionOrder()
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

 // Server-bound runtime publisher authorization. Trusted runner tokens
 // always may; gateway API tokens need an unrevoked live token row plus
 // 'operate' on the session (machine/path inheritance included).
 const runtimeDispatcher = gatewayStore
  ? new ExecutionDispatcher(gatewayStore, resolveSessionMachineId, resolveSessionPath,
   (type, id) => (type === 'session'
    ? store.sessions.getSession(id) : store.machines.getMachine(id))?.namespace ?? null)
  : null
 const authorizeResourcePublication = socket.data.cliTrusted === true
  ? (_type: 'session' | 'machine', _id: string) => true
  : (type: 'session' | 'machine', id: string): boolean => {
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
    resource: { type, id }
   }).kind === 'allow'
  }
 const authorizeSessionPublication = (sid: string) => authorizeResourcePublication('session', sid)
 const isCurrentSessionSource = (sid: string) => rpcRegistry.isClaimedSessionSource(sid, socket.id)
 const authorizeOmpSource = (sid: string): boolean => {
  if (!resolveSessionAccess(sid).ok || !authorizeSessionPublication(sid)) return false
  const raw = store.sessions.getSession(sid)?.metadata
  if (!raw || typeof raw !== 'object' || !('flavor' in raw) || raw.flavor !== 'omp') return true
  const parsed = MetadataSchema.safeParse(raw)
  if (!parsed.success || auth?.sessionId !== sid) return false
  const attempt = parsed.data.ompResumeAttempt
  const expectedId = attempt?.attemptId ?? parsed.data.ompRuntimeAttemptId
  if (expectedId !== undefined) store.sessions.ompSources.observeGeneration(sid, expectedId)
  if (!sourceId && (expectedId !== undefined || !rpcRegistry.canUseLegacySessionSource(sid))) return false
  return attempt?.state !== 'quarantined' && (expectedId === undefined || auth.ompResumeAttemptId === expectedId)
 }
 // Old Socket.IO clients flush sendBuffer before their connect callback
 // re-registers killSession. Only an already recorded nonce may wait here;
 // fresh/retired/unauthorized sources still go straight through the fences.
 const deferredPublications: Array<() => void> = []
 let deferredBytes = 0
 let registrationTimer: NodeJS.Timeout | null = null
 const releaseDeferred = () => {
  if (registrationTimer) clearTimeout(registrationTimer)
  registrationTimer = null
  deferredBytes = 0
  for (const next of deferredPublications.splice(0)) next()
 }
 socket.use((packet, next) => {
  const payload = packet[1] as { sid?: unknown } | null
  if (!sessionId || !sourceId || !Object.hasOwn(RECONNECT_PUBLICATIONS, packet[0])
   || !payload || typeof payload !== 'object' || payload.sid !== sessionId
   || isCurrentSessionSource(sessionId) || !authorizeOmpSource(sessionId)) {
   next()
   return
  }
  const metadata = MetadataSchema.safeParse(store.sessions.getSession(sessionId)?.metadata)
  const recorded = store.sessions.ompSources.get(sessionId)
  if (!metadata.success || metadata.data.flavor !== 'omp'
   || recorded?.sourceId !== sourceId || store.sessions.ompSources.isRetired(sessionId, sourceId)) {
   next()
   return
  }
  const bytes = Buffer.byteLength(JSON.stringify(payload))
  if (deferredPublications.length >= MAX_RECONNECT_PUBLICATIONS || deferredBytes + bytes > MAX_RECONNECT_PUBLICATION_BYTES) {
   // Existing handlers reject this unregistered packet; never stamp it consumed.
   next()
   return
  }
  deferredPublications.push(next)
  deferredBytes += bytes
  registrationTimer ??= setTimeout(releaseDeferred, RECONNECT_REGISTRATION_WAIT_MS)
 })
 registerRpcHandlers(socket, rpcRegistry, (method) => {
  const separator = method.indexOf(':')
  if (separator <= 0) return false
  const sid = method.slice(0, separator)
  const session = store.sessions.getSession(sid)
  if (!session) return auth?.machineId === sid && resolveMachineAccess(sid).ok && authorizeResourcePublication('machine', sid)
  const metadata = MetadataSchema.safeParse(session.metadata)
  if (method === `${sid}:killSession` && metadata.success && metadata.data.flavor === 'omp'
   && metadata.data.ompResumeAttempt?.state === 'quarantined') {
   // Quarantine blocks publication, not self-disposal. A failed starter
   // may lack its attempt id, but must still close its native process
   // and produce the runner's generation-bound cleanup receipt.
   // This route neither claims a source nor replaces a current owner.
   const attemptId = metadata.data.ompResumeAttempt.attemptId
   const durable = store.sessions.ompSources.get(sid)
   const current = rpcRegistry.getSocketIdForMethod(method)
   const allowed = auth?.sessionId === sid && sourceId !== null && resolveSessionAccess(sid).ok
    && authorizeSessionPublication(sid) && !store.sessions.ompSources.isRetired(sid, sourceId)
    && (current === null || current === socket.id)
    // An explicit wrong generation is always rejected; a missing
    // attempt is only the failed-starter case where no durable
    // source already owns the quarantined attempt.
    && (auth?.ompResumeAttemptId === undefined
     ? !(durable?.sourceId && durable.attemptId === attemptId)
     : auth.ompResumeAttemptId === attemptId)
    // The durable owner of an older attempt may not self-dispose;
    // while the quarantined attempt has a durable owner, other
    // nonces may not take its disposal route.
    && !(durable?.sourceId === sourceId && durable.attemptId !== attemptId)
    && !(durable?.sourceId && durable.sourceId !== sourceId && durable.attemptId === attemptId)
   if (!allowed) return false
   rpcRegistry.registerCleanupSource(socket, sid, sourceId, sourceOrder)
   return true
  }
  if (!authorizeOmpSource(sid)) return false
  if (!metadata.success || metadata.data.flavor !== 'omp') return true
  if (!sourceId) return rpcRegistry.claimLegacySessionSource(socket, sid, sourceOrder)
  if (method !== `${sid}:killSession`) return isCurrentSessionSource(sid)
  const claimed = rpcRegistry.claimSessionSource(socket, sid, sourceId!,
   metadata.data.ompResumeAttempt?.attemptId ?? metadata.data.ompRuntimeAttemptId ?? null, sourceOrder)
  // Run the normal handlers only after registerRpcHandlers installs the route.
  // They re-check live grants, source ownership, generation and archive state.
  if (claimed) queueMicrotask(releaseDeferred)
  return claimed
 })
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
  onMessagesConsumed,
  sanitizeSessionMetadata,
  authorizeSessionPublication: authorizeOmpSource,
  isCurrentSessionSource,
  canInitializeSessionSource: (sid) => {
   if (!authorizeOmpSource(sid)) return false
   const metadata = MetadataSchema.safeParse(store.sessions.getSession(sid)?.metadata)
   return metadata.success && rpcRegistry.canInitializeSessionSource(sid, sourceId, sourceOrder,
    metadata.data.ompResumeAttempt?.attemptId ?? metadata.data.ompRuntimeAttemptId ?? null)
  }
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
  emitAccessError,
  // Live per-viewer ACL for output fan-out: the same gateway verdict the
  // /terminal handlers enforce. A denied socket is evicted rather than
  // skipped silently, so a narrowed grant stops output mid-stream. 'read'
  // suffices to watch; viewer accounts keep receiving output.
  authorizeTerminalViewer: resolveTerminalNamespace
   ? (viewerSocket, sessionId) => {
    const accountId = viewerSocket.data.gatewayAccountId
    if (typeof accountId === 'number') {
     return resolveTerminalNamespace(accountId, sessionId, 'read') !== null
    }
    const session = store.sessions.getSession(sessionId)
    return Boolean(session && viewerSocket.data.namespace === session.namespace)
   }
   : undefined,
  authorizeTerminalOwnerKey: resolveTerminalNamespace
   ? (ownerKey, sessionId) => {
    if (ownerKey?.startsWith('account:')) {
     const accountId = Number(ownerKey.slice('account:'.length))
     return Number.isInteger(accountId) && resolveTerminalNamespace(accountId, sessionId, 'read') !== null
    }
    return true
   }
   : undefined
 })
 if (runtimeRegistry) {

  registerRuntimeHandlers(socket, {
   store,
   registry: runtimeRegistry,
   resolveSessionAccess,
   emitAccessError,
   authorizeSessionPublication: authorizeOmpSource,
   isCurrentSessionSource,
  })
 }

 socket.on('ping', (callback: () => void) => {
  callback()
 })

 socket.on('disconnect', () => {
  if (registrationTimer) clearTimeout(registrationTimer)
  registrationTimer = null
  deferredPublications.length = 0
  deferredBytes = 0
  rpcRegistry.unregisterAll(socket)
  cleanupTerminalHandlers(socket, { terminalRegistry, terminalNamespace })
 })
}
