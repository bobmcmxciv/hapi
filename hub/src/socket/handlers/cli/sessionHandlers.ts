import type { ClientToServerEvents } from '@hapi/protocol'
import { MetadataSchema, NativeInputDeliverySchema, NativeMessageOrderSchema } from '@hapi/protocol/schemas'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import type { CopilotAgentMode } from '@hapi/protocol'
import type { AgentState, CodexCollaborationMode, Metadata, PermissionMode } from '@hapi/protocol/types'
import { isRedundantGoalStatusEventContent } from '@hapi/protocol/messages'
import type { Store, StoredMessage, StoredSession } from '../../../store'
import type { SyncEvent } from '../../../sync/syncEngine'
import { TodosSchema } from '../../../sync/todos'
import { applyTodoMessageContent } from '../../../fork-features/task-panel/taskProjection'
import { extractTeamStateFromMessageContent, applyTeamStateDelta } from '../../../sync/teams'
import { extractBackgroundTaskDelta } from '../../../sync/backgroundTasks'
import { shouldRecordSessionActivity } from '../../../sync/sessionActivity'
import type { CliSocketWithData } from '../../socketTypes'
import type { SessionEndReason } from '@hapi/protocol'
import type { AccessErrorReason, AccessResult } from './types'

type SessionAlivePayload = {
 sid: string
 time: number
 thinking?: boolean
 mode?: 'local' | 'remote'
 permissionMode?: PermissionMode
 model?: string | null
 modelReasoningEffort?: string | null
 effort?: string | null
 serviceTier?: string | null
 collaborationMode?: CodexCollaborationMode
 copilotAgentMode?: CopilotAgentMode
}

type SessionEndPayload = {
 sid: string
 time: number
 reason?: SessionEndReason
}

type SessionReadyPayload = {
 sid: string
 time: number
}

type ResolveSessionAccess = (sessionId: string) => AccessResult<StoredSession>

type EmitAccessError = (scope: 'session' | 'machine', id: string, reason: AccessErrorReason) => void

type UpdateMetadataHandler = ClientToServerEvents['update-metadata']
type UpdateStateHandler = ClientToServerEvents['update-state']

const messageSchema = z.object({
 sid: z.string(),
 message: z.union([z.string(), z.unknown()]),
 localId: z.string().optional(),
 // Client-provided origin timestamp (epoch ms) — e.g. a Claude transcript
 // entry's own `timestamp`. Only honored for agent messages (no localId);
 // see addMessage in messages.ts.
 createdAt: z.number().optional(),
 nativeOrder: NativeMessageOrderSchema.optional()
})

const updateMetadataSchema = z.object({
 sid: z.string(),
 expectedVersion: z.number().int(),
 metadata: z.unknown()
})

const updateStateSchema = z.object({
 sid: z.string(),
 expectedVersion: z.number().int(),
 agentState: z.unknown().nullable()
})

const HUB_OWNED_METADATA_KEYS = ['supersededBySessionId', 'opencodeClearOperation', 'reopenArchiveSnapshot', 'ompResumeAttempt', 'ompRuntimeAttemptId'] as const

function preserveHubOwnedMetadata(incoming: unknown, current: unknown): unknown {
 if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return isOmpMetadata(current) ? current : incoming
 const next = { ...(incoming as Record<string, unknown>) }
 const existing = current && typeof current === 'object' && !Array.isArray(current)
  ? current as Record<string, unknown>
  : {}
 for (const key of HUB_OWNED_METADATA_KEYS) {
  if (Object.prototype.hasOwnProperty.call(existing, key)) next[key] = existing[key]
  else delete next[key]
 }
 if (isOmpMetadata(current)) {
  for (const key of ['flavor', 'machineId', 'path'] as const) {
   if (Object.prototype.hasOwnProperty.call(existing, key)) next[key] = existing[key]
   else delete next[key]
  }
 }
 return next
}

export type SessionHandlersDeps = {
 store: Store
 resolveSessionAccess: ResolveSessionAccess
 emitAccessError: EmitAccessError
 onSessionAlive?: (payload: SessionAlivePayload) => void
 onSessionReady?: (payload: SessionReadyPayload) => void
 onSessionEnd?: (payload: SessionEndPayload) => void
 onWebappEvent?: (event: SyncEvent) => void
 onBackgroundTaskDelta?: (sessionId: string, delta: { started: number; completed: number }) => void
 onSessionActivity?: (sessionId: string, updatedAt: number) => void
 /** Drops the queued-thinking grace so synchronous CLI handlers (e.g. slash
  *  commands) don't leave the spinner stuck for the full grace window. */
 onMessagesConsumed?: (sessionId: string) => void
 /** fork-features/multi-user: strips injected gateway memory out of CLI-reported titles. */
 sanitizeSessionMetadata?: (metadata: unknown) => unknown
 authorizeSessionPublication?: (sessionId: string) => boolean
 isCurrentSessionSource?: (sessionId: string) => boolean
 /** Metadata/state may initialize before RPC registration, never over a different current source. */
 canInitializeSessionSource?: (sessionId: string) => boolean
}

const publicationAuthSchema = z.object({ sessionId: z.string(), ompResumeAttemptId: z.string().optional() })
const messagesConsumedSchema = z.object({
 sid: z.string(),
 localIds: z.array(z.unknown()).transform(ids => ids.filter((id): id is string => typeof id === 'string')),
 clearQueuedThinkingGrace: z.boolean().optional(),
 nativeDelivery: NativeInputDeliverySchema.optional()
})
const messagesResolvedSchema = z.object({
 sid: z.string().min(1),
 resolutions: z.array(z.object({ localId: z.string().min(1), outcome: z.enum(['handled', 'cancelled']), nativeOrder: NativeMessageOrderSchema.optional() })).min(1)
})

function isOmpMetadata(metadata: unknown): metadata is { flavor: 'omp' } {
 return metadata !== null && typeof metadata === 'object' && 'flavor' in metadata && metadata.flavor === 'omp'
}

export function registerSessionHandlers(socket: CliSocketWithData, deps: SessionHandlersDeps): void {
 const { store, resolveSessionAccess, emitAccessError, onSessionAlive, onSessionReady, onSessionEnd, onWebappEvent, onBackgroundTaskDelta, onSessionActivity, onMessagesConsumed, sanitizeSessionMetadata } = deps
 const acceptsPublication = (session: StoredSession, requireRpcSource = true): boolean => {
  const authorized = deps.authorizeSessionPublication?.(session.id) ?? socket.data?.cliTrusted === true
  if (deps.authorizeSessionPublication && !authorized) {
   emitAccessError('session', session.id, 'access-denied')
   return false
  }
  if (!isOmpMetadata(session.metadata)) return true
  const parsed = MetadataSchema.safeParse(session.metadata)
  const auth = publicationAuthSchema.safeParse(socket.handshake?.auth)
  if (!parsed.success || !auth.success) return false
  const metadata = parsed.data
  if (auth.data.sessionId !== session.id
   || !authorized
   || (!(deps.isCurrentSessionSource?.(session.id) ?? false)
    && (requireRpcSource || !(deps.canInitializeSessionSource?.(session.id) ?? false)))) {
   emitAccessError('session', session.id, 'access-denied')
   return false
  }
  const attempt = metadata.ompResumeAttempt
  const expectedId = attempt?.attemptId ?? metadata.ompRuntimeAttemptId
  if (attempt?.state === 'quarantined' || (expectedId !== undefined && auth.data.ompResumeAttemptId !== expectedId)) {
   return false
  }
  return true
 }

 socket.on('message', (data: unknown) => {
  const parsed = messageSchema.safeParse(data)
  if (!parsed.success) {
   socket.emit('error', { message: 'Invalid message publication metadata' })
   return
  }

  const { sid, localId, createdAt, nativeOrder } = parsed.data
  const raw = parsed.data.message

  const content = typeof raw === 'string'
   ? (() => {
    try {
     return JSON.parse(raw) as unknown
    } catch {
     return raw
    }
   })()
   : raw

  const sessionAccess = resolveSessionAccess(sid)
  if (!sessionAccess.ok) {
   emitAccessError('session', sid, sessionAccess.reason)
   return
  }
  const session = sessionAccess.value
  if (!acceptsPublication(session)) return
  if (nativeOrder && !isOmpMetadata(session.metadata)) {
   socket.emit('error', { message: 'Native message order requires an OMP source' })
   return
  }

  if (isRedundantGoalStatusEventContent(content)) {
   return
  }

  let msg: StoredMessage
  try {
   msg = store.messages.addMessage(sid, content, localId, undefined, createdAt, nativeOrder)
  } catch (error) {
   console.error('message publication failed', error)
   socket.emit('error', { message: 'Message publication could not be persisted' })
   return
  }
  if (shouldRecordSessionActivity(content)) {
   onSessionActivity?.(sid, msg.createdAt)
  }

  const storedTodos = store.sessions.getSession(sid)?.todos
  const parsedTodos = TodosSchema.safeParse(storedTodos)
  const nextTodos = applyTodoMessageContent(parsedTodos.success ? parsedTodos.data : null, content)
  if (nextTodos) {
   const updated = store.sessions.setSessionTodos(sid, nextTodos, msg.createdAt, session.namespace, { replaceAtSameTimestamp: true })
   if (updated) {
    const stored = store.sessions.getSession(sid)
    onWebappEvent?.({
     type: 'session-updated',
     sessionId: sid,
     data: {
      todos: {
       version: stored?.todosUpdatedAt ?? msg.createdAt,
       value: nextTodos
      },
      updatedAt: stored?.updatedAt ?? msg.createdAt
     }
    })
   }
  }

  const teamDelta = extractTeamStateFromMessageContent(content)
  if (teamDelta) {
   const existingSession = store.sessions.getSession(sid)
   const existingTeamState = existingSession?.teamState as import('@hapi/protocol/types').TeamState | null | undefined
   const newTeamState = applyTeamStateDelta(existingTeamState ?? null, teamDelta)
   const updated = store.sessions.setSessionTeamState(sid, newTeamState, msg.createdAt, session.namespace)
   if (updated) {
    const stored = store.sessions.getSession(sid)
    // Versioned clear: value null = TeamDelete. Consumers gate on
    // version (store team_state_updated_at) so dual SSE cannot
    // resurrect a deleted team from a lagged older event.
    onWebappEvent?.({
     type: 'session-updated',
     sessionId: sid,
     data: {
      teamState: {
       version: stored?.teamStateUpdatedAt ?? msg.createdAt,
       value: newTeamState
      },
      updatedAt: stored?.updatedAt ?? msg.createdAt
     }
    })
   }
  }

  const bgDelta = extractBackgroundTaskDelta(content)
  if (bgDelta) {
   onBackgroundTaskDelta?.(sid, bgDelta)
  }

  const update = {
   id: randomUUID(),
   seq: msg.seq,
   createdAt: Date.now(),
   body: {
    t: 'new-message' as const,
    sid,
    message: {
     id: msg.id,
     seq: msg.seq,
     createdAt: msg.createdAt,
     localId: msg.localId,
     content: msg.content,
     invokedAt: msg.invokedAt,
     ...(msg.position ? { position: msg.position } : {}),
     ...(msg.resolution ? { resolution: msg.resolution } : {})
    }
   }
  }
  if (!msg.resolution) socket.to(`session:${sid}`).emit('update', update)

  onWebappEvent?.({
   type: 'message-received',
   sessionId: sid,
   message: {
    id: msg.id,
    seq: msg.seq,
    localId: msg.localId,
    content: msg.content,
    createdAt: msg.createdAt,
    invokedAt: msg.invokedAt,
    ...(msg.resolution ? { resolution: msg.resolution } : {}),
    ...(msg.position ? { position: msg.position } : {})
   }
  })
 })

 const handleUpdateMetadata: UpdateMetadataHandler = (data, cb) => {
  const parsed = updateMetadataSchema.safeParse(data)
  if (!parsed.success) {
   cb({ result: 'error' })
   return
  }

  const { sid, metadata, expectedVersion } = parsed.data
  const sessionAccess = resolveSessionAccess(sid)
  if (!sessionAccess.ok) {
   cb({ result: 'error', reason: sessionAccess.reason })
   return
  }
  if (!acceptsPublication(sessionAccess.value, false)) {
   cb({ result: 'error', reason: 'access-denied' })
   return
  }

  const result = store.sessions.updateSessionMetadata(
   sid,
   // fork(memory-title)：先清洗（剥掉被 CLI 兜底截成标题的 <hapi_user_context>
   // 记忆块），再走上游的 hub 自有字段保留——两层各管各的，顺序不能反：
   // preserve 在前会把脏标题当成"CLI 想改的值"原样放行。
   preserveHubOwnedMetadata(
    sanitizeSessionMetadata ? sanitizeSessionMetadata(metadata) : metadata,
    sessionAccess.value.metadata
   ),
   expectedVersion,
   sessionAccess.value.namespace
  )
  if (result.result === 'success') {
   cb({ result: 'success', version: result.version, metadata: result.value })
  } else if (result.result === 'version-mismatch') {
   cb({ result: 'version-mismatch', version: result.version, metadata: result.value })
  } else {
   cb({ result: 'error' })
  }

  if (result.result === 'success') {
   const stored = store.sessions.getSession(sid)
   const update = {
    id: randomUUID(),
    seq: Date.now(),
    createdAt: Date.now(),
    body: {
     t: 'update-session' as const,
     sid,
     // Broadcast the persisted (merged) value, not the pre-merge
     // payload — otherwise other CLIs in the session room would
     // overwrite their local cache with a tokenless metadata
     // snapshot even though the DB row was preserved.
     // See store.sessions.mergeSessionMetadata for the merge
     // contract.
     metadata: { version: result.version, value: result.value },
     agentState: null
    }
   }
   socket.to(`session:${sid}`).emit('update', update)
   onWebappEvent?.({
    type: 'session-updated',
    sessionId: sid,
    // The unknown-cast here mirrors the schema's MetadataSchema.nullable()
    // shape: the store returns raw JSON, the wire schema parses it on
    // both ends. Keeping the broadcast shape identical to the socket.io
    // `update-session` body (line ~213) lets the same patch travel
    // through both fan-out channels without divergence.
    data: {
     metadata: { version: result.version, value: result.value as Metadata | null },
     updatedAt: stored?.updatedAt ?? Date.now()
    }
   })
  }
 }

 socket.on('update-metadata', handleUpdateMetadata)

 const handleUpdateState: UpdateStateHandler = (data, cb) => {
  const parsed = updateStateSchema.safeParse(data)
  if (!parsed.success) {
   cb({ result: 'error' })
   return
  }

  const { sid, agentState, expectedVersion } = parsed.data
  const sessionAccess = resolveSessionAccess(sid)
  if (!sessionAccess.ok) {
   cb({ result: 'error', reason: sessionAccess.reason })
   return
  }
  if (!acceptsPublication(sessionAccess.value, false)) {
   cb({ result: 'error', reason: 'access-denied' })
   return
  }

  const result = store.sessions.updateSessionAgentState(
   sid,
   agentState,
   expectedVersion,
   sessionAccess.value.namespace
  )
  if (result.result === 'success') {
   cb({ result: 'success', version: result.version, agentState: result.value })
  } else if (result.result === 'version-mismatch') {
   cb({ result: 'version-mismatch', version: result.version, agentState: result.value })
  } else {
   cb({ result: 'error' })
  }

  if (result.result === 'success') {
   const stored = store.sessions.getSession(sid)
   const update = {
    id: randomUUID(),
    seq: Date.now(),
    createdAt: Date.now(),
    body: {
     t: 'update-session' as const,
     sid,
     metadata: null,
     agentState: { version: result.version, value: agentState }
    }
   }
   socket.to(`session:${sid}`).emit('update', update)
   onWebappEvent?.({
    type: 'session-updated',
    sessionId: sid,
    data: {
     agentState: { version: result.version, value: agentState as AgentState | null },
     updatedAt: stored?.updatedAt ?? Date.now()
    }
   })
  }
 }

 socket.on('update-state', handleUpdateState)

 socket.on('session-alive', (data: SessionAlivePayload) => {
  if (!data || typeof data.sid !== 'string' || typeof data.time !== 'number') {
   return
  }
  const sessionAccess = resolveSessionAccess(data.sid)
  if (!sessionAccess.ok) {
   emitAccessError('session', data.sid, sessionAccess.reason)
   return
  }
  if (!acceptsPublication(sessionAccess.value)) return
  onSessionAlive?.(data)
 })

 socket.on('session-ready', (data: SessionReadyPayload) => {
  if (!data || typeof data.sid !== 'string' || typeof data.time !== 'number') {
   return
  }
  const sessionAccess = resolveSessionAccess(data.sid)
  if (!sessionAccess.ok) {
   emitAccessError('session', data.sid, sessionAccess.reason)
   return
  }
  if (!acceptsPublication(sessionAccess.value)) return
  onSessionReady?.(data)
 })

 socket.on('messages-consumed', (raw: unknown) => {
  const parsed = messagesConsumedSchema.safeParse(raw)
  if (!parsed.success) {
   socket.emit('error', { message: 'Invalid native delivery publication' })
   return
  }
  const data = parsed.data
  const localIds = data.localIds
  if (localIds.length === 0) return
  const sessionAccess = resolveSessionAccess(data.sid)
  if (!sessionAccess.ok) {
   emitAccessError('session', data.sid, sessionAccess.reason)
   return
  }
  if (!acceptsPublication(sessionAccess.value)) return
  if (data.nativeDelivery && (localIds.length !== 1 || !localIds[0] || !isOmpMetadata(sessionAccess.value.metadata))) {
   socket.emit('error', { message: 'Native delivery requires one OMP input identity' })
   return
  }
  // Resolution is terminal without invocation; a late consumed receipt cannot override it.
  const resolvedIds = new Set(store.messages.getLocalMessageStates(data.sid, localIds)
   .filter(state => state.resolution).map(state => state.localId))
  const consumedIds = localIds.filter(localId => !resolvedIds.has(localId))
  if (consumedIds.length === 0) return
  let invokedAt = data.nativeDelivery ? Date.parse(data.nativeDelivery.deliveredAt) : Date.now()
  let sessionUpdatedAt: number
  try {
   sessionUpdatedAt = store.recordMessagesConsumed(
    data.sid,
    consumedIds,
    invokedAt,
    sessionAccess.value.namespace,
    data.nativeDelivery
   )
  } catch (err) {
   console.error('recordMessagesConsumed failed', err)
   socket.emit('error', { message: 'Input delivery could not be persisted or conflicts with prior evidence' })
   return
  }
  const states = store.messages.getLocalMessageStates(data.sid, consumedIds)
  if (data.nativeDelivery) {
   const persisted = states[0]
   if (!persisted || persisted.invokedAt === null || persisted.resolution) return
   invokedAt = persisted.invokedAt
  }
  const positions = states.flatMap(state => state.position ? [{ localId: state.localId, position: state.position }] : [])

  try {
   onSessionActivity?.(data.sid, sessionUpdatedAt)
  } catch (err) {
   console.error('onSessionActivity failed', err)
  }

  // Only drop the queued-thinking grace when the CLI explicitly opts in
  // (synchronous handlers like slash commands that will never send
  // their own `thinking=true` keepalive). Normal queue drains still
  // need the grace so the spinner doesn't flicker between the queue
  // shift and `backend.prompt` start.
  if (data.clearQueuedThinkingGrace === true) {
   onMessagesConsumed?.(data.sid)
  }
  // Native replays publish persisted coordinates; legacy batches retain their ACK timestamp.
  onWebappEvent?.({ type: 'messages-consumed', sessionId: data.sid, localIds: consumedIds, invokedAt, ...(positions.length ? { positions } : {}) })
 })

 socket.on('messages-resolved', (data: unknown) => {
  const parsed = messagesResolvedSchema.safeParse(data)
  if (!parsed.success) {
   socket.emit('error', { message: 'Invalid terminal input publication' })
   return
  }
  const { sid, resolutions } = parsed.data
  const access = resolveSessionAccess(sid)
  if (!access.ok) {
   emitAccessError('session', sid, access.reason)
   return
  }
  if (!acceptsPublication(access.value)) return
  try {
   const persisted = store.messages.resolveMessages(sid, resolutions, Date.now())
   if (persisted.length === 0) return
   onMessagesConsumed?.(sid)
   onWebappEvent?.({ type: 'messages-resolved', sessionId: sid, resolutions: persisted })
  } catch (error) {
   console.error('resolveMessages failed', error)
   socket.emit('error', { message: 'Terminal input resolution could not be persisted' })
  }
 })

 socket.on('session-end', (data: SessionEndPayload) => {
  if (!data || typeof data.sid !== 'string' || typeof data.time !== 'number') {
   return
  }
  const sessionAccess = resolveSessionAccess(data.sid)
  if (!sessionAccess.ok) {
   emitAccessError('session', data.sid, sessionAccess.reason)
   return
  }
  if (!acceptsPublication(sessionAccess.value)) return


  // Queued rows stay durable at session end: nothing may stamp invoked_at
  // without a real CLI consumption receipt. The next CLI attach replays them
  // (replayImmediateQueuedMessages / delivery release) and force-send can still
  // promote them — previously they were fake-invoked here and silently lost.
  onSessionEnd?.(data)
 })
}
