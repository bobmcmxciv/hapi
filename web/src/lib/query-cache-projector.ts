import type { QueryClient } from '@tanstack/react-query'
import {
 computePendingRequestKinds,
 computePendingRequests,
 computePendingRequestsCount,
 computeTodoProgress,
 toSessionSummary,
 toSessionSummaryMetadata
} from '@hapi/protocol'
import { MachinePatchSchema, MachineSchema, SessionPatchSchema, SessionSchema } from '@hapi/protocol/schemas'
import type {
 Machine,
 MachinesResponse,
 MachineWithOwner,
 Session,
 SessionPatch,
 SessionResponse,
 SessionsResponse,
 SessionSummary,
 SyncEvent
} from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

export type ProjectorScope = 'global' | 'full'

const INVALIDATION_BATCH_MS = 16

/**
 * True when `eventType` must force a session-list refetch on this scope.
 * `messages-invalidated` means the hub rewrote history (delete/fork/rewind);
 * only the global connection owns list-level resync so a session-scoped
 * connection does not duplicate the refetch.
 */
export function shouldInvalidateSessionListForEvent(scope: ProjectorScope, eventType: SyncEvent['type']): boolean {
 return scope === 'global' && eventType === 'messages-invalidated'
}

// Version-monotonicity gate for structured patches carrying metadata or
// agentState. SSE reconnects + per-query invalidation can leave the cache
// holding state that's NEWER than a buffered older patch about to replay;
// applying that older patch would regress resume / session-id / pending-
// requests state. Mirrors the CLI room handler contract: strictly newer
// only. Exported so the rule is unit-testable in isolation from the hook.
export function isNewerVersionedPatch(patchVersion: number, currentVersion: number): boolean {
 return patchVersion > currentVersion
}

function sortSessionSummaries(left: SessionSummary, right: SessionSummary): number {
 if (left.active !== right.active) {
  return left.active ? -1 : 1
 }
 if (left.active && left.pendingRequestsCount !== right.pendingRequestsCount) {
  return right.pendingRequestsCount - left.pendingRequestsCount
 }
 return right.updatedAt - left.updatedAt
}

/**
 * True when applying `patch` to `session` would change nothing that renders.
 *
 * Keep-alive patches re-send fields about every ~10s. SessionHeader reads
 * `activeAt` for relative age, but `formatRelativeTime` only changes at
 * minute boundaries (`just now` while delta < 60s). Sub-minute `activeAt`
 * moves are therefore skipped here so the detail cache does not replace the
 * Session object (and re-render SessionChat / HappyThread) six times a
 * minute for an invisible label change. A delta of ≥60s is still
 * render-relevant so the header stays on `just now` for live sessions.
 * The session-list path still uses {@link isRenderIrrelevantPatch}, which
 * ignores `activeAt` entirely.
 */
export function isRenderIrrelevantSessionPatch(session: Session, patch: SessionPatch): boolean {
 const current = session as unknown as Record<string, unknown>
 for (const [key, value] of Object.entries(patch)) {
  if (
   key === 'activeAt'
   && typeof value === 'number'
   && Math.abs(value - session.activeAt) < 60_000
  ) {
   continue
  }
  if (current[key] !== value) {
   return false
  }
 }
 return true
}

/**
 * Apply a validated SessionPatch onto a detail Session. Returns null when
 * nothing render-relevant changed (keep prior object identity). Field-by-field
 * only — never wholesale-spread versioned `{ version, value }` wrappers.
 * Exported for unit tests (Copilot mode keep-alive must not be dropped).
 */
export function applySessionDetailPatch(session: Session, patch: SessionPatch): Session | null {
 if (isRenderIrrelevantSessionPatch(session, patch)) {
  return null
 }
 let changed = false
 const nextSession: Session = { ...session }
 const assign = <K extends keyof Session>(key: K, value: Session[K]) => {
  if (nextSession[key] !== value) {
   nextSession[key] = value
   changed = true
  }
 }
 if (patch.active !== undefined) assign('active', patch.active)
 if (patch.thinking !== undefined) assign('thinking', patch.thinking)
 if (patch.activeAt !== undefined) assign('activeAt', patch.activeAt)
 // Health metadata: the running-turn anchor drives SessionChat's
 // pending-turn placeholder and running duration. The hub clears it on
 // session-end — dropping it here would pin a phantom "still running"
 // turn onto an ended session.
 if (patch.activeTurnStartedAt !== undefined) assign('activeTurnStartedAt', patch.activeTurnStartedAt)
 // Monotonic with hub applySessionPatch: a rejected stale
 // metadata/agentState replay must not rewind updatedAt.
 if (patch.updatedAt !== undefined) {
  const nextUpdatedAt = Math.max(nextSession.updatedAt, patch.updatedAt)
  assign('updatedAt', nextUpdatedAt)
 }
 if (patch.model !== undefined) assign('model', patch.model)
 if (patch.modelReasoningEffort !== undefined) assign('modelReasoningEffort', patch.modelReasoningEffort)
 if (patch.effort !== undefined) assign('effort', patch.effort)
 if (Object.prototype.hasOwnProperty.call(patch, 'serviceTier')) {
  assign('serviceTier', patch.serviceTier ?? null)
 }
 if (patch.resumeWithSessionModel !== undefined) assign('resumeWithSessionModel', patch.resumeWithSessionModel)
 if (patch.permissionMode !== undefined) assign('permissionMode', patch.permissionMode)
 if (patch.collaborationMode !== undefined) assign('collaborationMode', patch.collaborationMode)
 if (patch.copilotAgentMode !== undefined) assign('copilotAgentMode', patch.copilotAgentMode)
 if (patch.backgroundTaskCount !== undefined) assign('backgroundTaskCount', patch.backgroundTaskCount)
 // Version gates: dual SSE can deliver duplicates out of order.
 // Only mark changed when a strictly newer version lands —
 // otherwise keep previous object identity (no redundant render).
 if (patch.todos !== undefined && isNewerVersionedPatch(patch.todos.version, nextSession.todosUpdatedAt ?? 0)) {
  nextSession.todos = patch.todos.value
  nextSession.todosUpdatedAt = patch.todos.version
  changed = true
 }
 if (patch.teamState !== undefined && isNewerVersionedPatch(patch.teamState.version, nextSession.teamStateUpdatedAt ?? 0)) {
  nextSession.teamState = patch.teamState.value ?? undefined
  nextSession.teamStateUpdatedAt = patch.teamState.version
  changed = true
 }
 if (patch.metadata !== undefined && isNewerVersionedPatch(patch.metadata.version, nextSession.metadataVersion)) {
  nextSession.metadata = patch.metadata.value
  nextSession.metadataVersion = patch.metadata.version
  changed = true
 }
 if (patch.agentState !== undefined && isNewerVersionedPatch(patch.agentState.version, nextSession.agentStateVersion)) {
  nextSession.agentState = patch.agentState.value
  nextSession.agentStateVersion = patch.agentState.version
  changed = true
 }
 return changed ? nextSession : null
}

function isSessionRecord(value: unknown): value is Session {
 return SessionSchema.safeParse(value).success
}

/**
 * True when the only difference between two summaries is `activeAt`.
 *
 * The CLI keep-alive makes the hub re-broadcast a full session patch about
 * every 10s per active session even when nothing changed, and `activeAt` is
 * the sole field that moves. No component reads `activeAt` - the list shows
 * `updatedAt` and sorts on active/pendingRequestsCount/updatedAt - so storing
 * it costs a new object identity and a full list re-render for nothing.
 */
export function sameSessionSummaryMetadata(
 current: SessionSummary['metadata'],
 next: SessionSummary['metadata']
): boolean {
 if (current === next) {
  return true
 }
 if (current == null || next == null) {
  return current == null && next == null
 }
 return current.name === next.name
  && current.path === next.path
  && current.machineId === next.machineId
  && current.summary?.text === next.summary?.text
  && current.flavor === next.flavor
  && current.agentSessionId === next.agentSessionId
  && current.lifecycleState === next.lifecycleState
  && current.worktree?.basePath === next.worktree?.basePath
  && current.worktree?.branch === next.worktree?.branch
  && current.worktree?.name === next.worktree?.name
  && current.worktree?.worktreePath === next.worktree?.worktreePath
  && current.worktree?.createdAt === next.worktree?.createdAt
}

export function isRenderIrrelevantPatch(current: SessionSummary, next: SessionSummary): boolean {
 return current.active === next.active
  && current.thinking === next.thinking
  && current.updatedAt === next.updatedAt
  && current.backgroundTaskCount === next.backgroundTaskCount
  && current.model === next.model
  && current.modelReasoningEffort === next.modelReasoningEffort
  && current.effort === next.effort
  && current.pendingRequestsCount === next.pendingRequestsCount
  // Structured SSE patches (#897) can move these without touching the
  // keep-alive fields above; omit them and a todos/metadata/agentState
  // patch would be dropped as "activeAt-only" churn.
  && current.todoProgress?.completed === next.todoProgress?.completed
  && current.todoProgress?.total === next.todoProgress?.total
  && (current.todoProgress == null) === (next.todoProgress == null)
  && current.pendingRequestKinds.length === next.pendingRequestKinds.length
  && current.pendingRequestKinds.every((kind, i) => kind === next.pendingRequestKinds[i])
  && current.pendingRequests.length === next.pendingRequests.length
  && current.pendingRequests.every((req, i) => {
   const nextReq = next.pendingRequests[i]
   return req.id === nextReq?.id
    && req.kind === nextReq.kind
    && req.tool === nextReq.tool
  })
  && sameSessionSummaryMetadata(current.metadata, next.metadata)
  && current.metadataVersion === next.metadataVersion
  && current.agentStateVersion === next.agentStateVersion
  && current.todosUpdatedAt === next.todosUpdatedAt
}

function getSessionPatch(value: unknown): SessionPatch | null {
 const parsed = SessionPatchSchema.safeParse(value)
 if (!parsed.success) {
  return null
 }
 return Object.keys(parsed.data).length > 0 ? parsed.data : null
}

function isMachineRecord(value: unknown): value is Machine {
 return MachineSchema.safeParse(value).success
}

/**
 * Fold a `machine-updated` payload into the cached machines list.
 *
 * Merge, never replace. The event carries the sync engine's bare `Machine`,
 * while the cached entry is the `/api/machines` projection — which additionally
 * carries the multi-user gateway's `ownerUsername` and a fully populated
 * metadata object. Replacing the entry outright stripped the owner off one
 * machine per heartbeat, and since the filter bar only groups once it sees two
 * or more owners, the bar collapsed from per-owner sections to a flat list as
 * soon as enough machines had been overwritten. The next refetch re-decorated
 * them and it flipped back: the layout visibly oscillated between the two.
 */
export function mergeCachedMachine(previous: MachineWithOwner, incoming: Machine): MachineWithOwner {
 return {
  ...previous,
  ...incoming,
  // Keys the event omits keep their previous value; keys it actually sets
  // still win. A metadata-less event leaves cached metadata untouched
  // rather than nulling out the machine's alias and platform.
  metadata: incoming.metadata
   ? { ...previous.metadata, ...incoming.metadata }
   : previous.metadata,
  // Ownership never travels on the event, so it can only be preserved.
  ownerUsername: previous.ownerUsername
 }
}

function getMachinePatch(value: unknown): { active?: boolean; activeAt?: number; updatedAt?: number } | null {
 const parsed = MachinePatchSchema.safeParse(value)
 if (!parsed.success) {
  return null
 }
 return Object.keys(parsed.data).length > 0 ? parsed.data : null
}

type PendingInvalidations = {
 sessions: boolean
 machines: boolean
 sessionIds: Set<string>
 scratchlistSessionIds: Set<string>
}

/**
 * Query-cache projection of the sync stream. Owns every React Query cache
 * write the event stream used to perform inline in `useSSE`:
 *
 * - full `Session`/`Machine` upserts and `SessionPatch`/`MachinePatch` folds
 *   for `session-added` / `session-updated` / `session-removed` /
 *   `session-ended` / `machine-updated`;
 * - list-level invalidations for message-ownership changes
 *   (`messages-invalidated`, scheduled send/consume/mature lifecycle events);
 * - batched invalidation fallback (16 ms window) when a payload cannot be
 *   patched in place.
 *
 * Everything the projection writes is referentially stable: unchanged
 * summaries and detail sessions keep their object identity, so heartbeats and
 * keep-alive churn never fan out to list/detail re-renders.
 *
 * Message-window store writes are NOT this module's job — see
 * `message-store-feeder.ts`.
 */
export class QueryCacheProjector {
 readonly #queryClient: QueryClient
 readonly #scope: ProjectorScope

 #invalidationTimer: ReturnType<typeof setTimeout> | null = null
 readonly #pending: PendingInvalidations = {
  sessions: false,
  machines: false,
  sessionIds: new Set(),
  scratchlistSessionIds: new Set()
 }

 constructor(options: { queryClient: QueryClient; scope: ProjectorScope }) {
  this.#queryClient = options.queryClient
  this.#scope = options.scope
 }

 /**
  * Project one sync event into the query cache. Message-stream events are
  * consumed here only for their list-invalidation side effects; window
  * feeding is delegated to the caller's MessageStoreFeeder.
  */
 project(event: SyncEvent): void {
  if (shouldInvalidateSessionListForEvent(this.#scope, event.type)) {
   this.#queueSessionListInvalidation()
  }

  if (this.#scope === 'global') {
   // Scheduled-message lifecycle changes the sidebar's future-count
   // badges even though the stream payload itself is fed to the
   // message window by the session connection.
   if (event.type === 'message-received' && event.message.scheduledAt != null) {
    this.#queueSessionListInvalidation()
   }
   if (
    event.type === 'message-cancelled'
    || event.type === 'messages-consumed'
    || event.type === 'messages-resolved'
    || event.type === 'scheduled-matured'
   ) {
    this.#queueSessionListInvalidation()
   }
  }

  switch (event.type) {
   case 'session-added':
   case 'session-updated':
    this.#projectSessionChanged(event)
    break
   case 'session-removed': {
    this.#removeSessionSummary(event.sessionId)
    void this.#queryClient.removeQueries({ queryKey: queryKeys.session(event.sessionId) })
    break
   }
   case 'session-ended':
    this.#projectSessionEnded(event.sessionId)
    break
   case 'machine-updated':
    this.#projectMachineUpdated(event)
    break
   default:
    break
  }
 }

 /** Cancel pending invalidation work; called when the transport is disposed. */
 dispose(): void {
  if (this.#invalidationTimer) {
   clearTimeout(this.#invalidationTimer)
   this.#invalidationTimer = null
  }
  this.#pending.sessions = false
  this.#pending.machines = false
  this.#pending.sessionIds.clear()
  this.#pending.scratchlistSessionIds.clear()
 }

 #projectSessionChanged(event: Extract<SyncEvent, { type: 'session-added' | 'session-updated' }>): void {
  if (isSessionRecord(event.data) && event.data.id === event.sessionId) {
   this.#queryClient.setQueryData<SessionResponse>(queryKeys.session(event.sessionId), { session: event.data })
   this.#upsertSessionSummary(event.data)
   return
  }

  const patch = getSessionPatch(event.data)
  if (patch) {
   const detailPatched = this.#patchSessionDetail(event.sessionId, patch)
   const summaryPatched = this.#patchSessionSummary(event.sessionId, patch)

   if (!detailPatched) {
    this.#queueSessionDetailInvalidation(event.sessionId)
   }
   if (!summaryPatched) {
    this.#queueSessionListInvalidation()
   }
   // tiann/hapi#893: piggybacked scratchlist token.
   // The patch itself does not carry the entries -
   // the timestamp is the change-detection signal,
   // which triggers the dedicated query refetch.
   if (Object.prototype.hasOwnProperty.call(patch, 'scratchlistUpdatedAt')) {
    this.#queueScratchlistInvalidation(event.sessionId)
   }
   return
  }

  this.#queueSessionDetailInvalidation(event.sessionId)
  this.#queueSessionListInvalidation()
 }

 /**
  * End has no timestamp, version or generation. A replay from an old native
  * writer can arrive after REST has hydrated a resumed same-ID session, so
  * it cannot safely overwrite cached activity or running-turn state. Ask the
  * authoritative queries instead; window history and queued prompts remain
  * untouched while revalidation runs (end is not removal).
  */
 #projectSessionEnded(sessionId: string): void {
  this.#queueSessionDetailInvalidation(sessionId)
  this.#queueSessionListInvalidation()
 }

 #projectMachineUpdated(event: Extract<SyncEvent, { type: 'machine-updated' }>): void {
  if (isMachineRecord(event.data)) {
   this.#upsertMachine(event.data)
  } else if (event.data === null) {
   this.#removeMachine(event.machineId)
  } else {
   const patch = getMachinePatch(event.data)
   if (patch?.active === false) {
    this.#removeMachine(event.machineId)
   } else {
    this.#queueMachinesInvalidation()
   }
  }
  if (event.data === undefined) {
   this.#queueMachinesInvalidation()
  }
 }

 #upsertSessionSummary(session: Session): void {
  this.#queryClient.setQueryData<SessionsResponse | undefined>(queryKeys.sessions, (previous) => {
   if (!previous) {
    return previous
   }

   const existingIndex = previous.sessions.findIndex((item) => item.id === session.id)
   const existing = existingIndex >= 0 ? previous.sessions[existingIndex] : undefined
   const summary = {
    ...toSessionSummary(session),
    futureScheduledMessageCount: existing?.futureScheduledMessageCount ?? 0,
    nextScheduledAt: existing?.nextScheduledAt ?? null
   }
   const nextSessions = previous.sessions.slice()
   if (existingIndex >= 0) {
    nextSessions[existingIndex] = summary
   } else {
    nextSessions.push(summary)
   }
   nextSessions.sort(sortSessionSummaries)
   return { ...previous, sessions: nextSessions }
  })
 }

 #patchSessionSummary(sessionId: string, patch: SessionPatch): boolean {
  let patched = false
  this.#queryClient.setQueryData<SessionsResponse | undefined>(queryKeys.sessions, (previous) => {
   if (!previous) {
    return previous
   }

   const nextSessions = previous.sessions.slice()
   const index = nextSessions.findIndex((item) => item.id === sessionId)
   if (index < 0) {
    return previous
   }

   const current = nextSessions[index]
   if (!current) {
    return previous
   }

   const nextSummary: SessionSummary = {
    ...current,
    active: patch.active ?? current.active,
    thinking: patch.thinking ?? current.thinking,
    activeAt: patch.activeAt ?? current.activeAt,
    // Monotonic: stale versioned-patch replays can carry an
    // older updatedAt; never move the list clock backward.
    updatedAt: patch.updatedAt !== undefined
     ? Math.max(current.updatedAt, patch.updatedAt)
     : current.updatedAt,
    backgroundTaskCount: Object.prototype.hasOwnProperty.call(patch, 'backgroundTaskCount')
     ? patch.backgroundTaskCount ?? 0
     : current.backgroundTaskCount,
    model: Object.prototype.hasOwnProperty.call(patch, 'model') ? patch.model ?? null : current.model,
    modelReasoningEffort: Object.prototype.hasOwnProperty.call(patch, 'modelReasoningEffort')
     ? patch.modelReasoningEffort ?? null
     : current.modelReasoningEffort,
    effort: Object.prototype.hasOwnProperty.call(patch, 'effort') ? patch.effort ?? null : current.effort
   }

   // Gate versioned fields against THIS summary's watermarks —
   // not the detail query. Global SSE covers every session;
   // requiring detail would force O(N) /sessions invalidation.
   // teamState is a summary no-op (not rendered on the list).
   if (patch.todos !== undefined && patch.todos.version >= current.todosUpdatedAt) {
    nextSummary.todoProgress = computeTodoProgress(patch.todos.value)
    nextSummary.todosUpdatedAt = patch.todos.version
   }
   if (patch.agentState !== undefined && patch.agentState.version >= current.agentStateVersion) {
    nextSummary.pendingRequestsCount = computePendingRequestsCount(patch.agentState.value)
    nextSummary.pendingRequestKinds = computePendingRequestKinds(patch.agentState.value)
    nextSummary.pendingRequests = computePendingRequests(patch.agentState.value, nextSummary.updatedAt)
    nextSummary.agentStateVersion = patch.agentState.version
   }
   if (patch.metadata !== undefined && patch.metadata.version >= current.metadataVersion) {
    nextSummary.metadata = toSessionSummaryMetadata(patch.metadata.value)
    nextSummary.metadataVersion = patch.metadata.version
   }

   patched = true
   // The keep-alive patch repeats every field every ~10s per active
   // session, and `activeAt` is the only one that actually moves.
   // Nothing renders `activeAt`, so writing a new object for it just
   // hands React Query a fresh reference and re-renders the list.
   if (isRenderIrrelevantPatch(current, nextSummary)) {
    return previous
   }
   nextSessions[index] = nextSummary
   nextSessions.sort(sortSessionSummaries)
   return { ...previous, sessions: nextSessions }
  })
  return patched
 }

 #patchSessionDetail(sessionId: string, patch: SessionPatch): boolean {
  let patched = false
  this.#queryClient.setQueryData<SessionResponse | undefined>(queryKeys.session(sessionId), (previous) => {
   if (!previous?.session) {
    return previous
   }
   patched = true
   const nextSession = applySessionDetailPatch(previous.session, patch)
   if (!nextSession) {
    return previous
   }
   return {
    ...previous,
    session: nextSession
   }
  })
  return patched
 }

 #removeSessionSummary(sessionId: string): void {
  this.#queryClient.setQueryData<SessionsResponse | undefined>(queryKeys.sessions, (previous) => {
   if (!previous) {
    return previous
   }
   const nextSessions = previous.sessions.filter((item) => item.id !== sessionId)
   if (nextSessions.length === previous.sessions.length) {
    return previous
   }
   return { ...previous, sessions: nextSessions }
  })
 }

 #upsertMachine(machine: Machine): void {
  this.#queryClient.setQueryData<MachinesResponse | undefined>(queryKeys.machines, (previous) => {
   if (!previous) {
    return previous
   }

   const nextMachines = previous.machines.slice()
   const index = nextMachines.findIndex((item) => item.id === machine.id)
   if (!machine.active) {
    if (index >= 0) {
     nextMachines.splice(index, 1)
     return { ...previous, machines: nextMachines }
    }
    return previous
   }

   if (index >= 0) {
    nextMachines[index] = mergeCachedMachine(nextMachines[index], machine)
   } else {
    nextMachines.push(machine)
   }
   return { ...previous, machines: nextMachines }
  })
 }

 #removeMachine(machineId: string): void {
  this.#queryClient.setQueryData<MachinesResponse | undefined>(queryKeys.machines, (previous) => {
   if (!previous) {
    return previous
   }
   const nextMachines = previous.machines.filter((item) => item.id !== machineId)
   if (nextMachines.length === previous.machines.length) {
    return previous
   }
   return { ...previous, machines: nextMachines }
  })
 }

 #queueSessionListInvalidation(): void {
  this.#pending.sessions = true
  this.#scheduleInvalidationFlush()
 }

 #queueSessionDetailInvalidation(sessionId: string): void {
  this.#pending.sessionIds.add(sessionId)
  this.#scheduleInvalidationFlush()
 }

 #queueScratchlistInvalidation(sessionId: string): void {
  this.#pending.scratchlistSessionIds.add(sessionId)
  this.#scheduleInvalidationFlush()
 }

 #queueMachinesInvalidation(): void {
  this.#pending.machines = true
  this.#scheduleInvalidationFlush()
 }

 #scheduleInvalidationFlush(): void {
  if (this.#invalidationTimer) {
   return
  }
  this.#invalidationTimer = setTimeout(() => {
   this.#invalidationTimer = null
   this.#flushInvalidations()
  }, INVALIDATION_BATCH_MS)
 }

 #flushInvalidations(): void {
  const pending = this.#pending
  if (
   !pending.sessions
   && !pending.machines
   && pending.sessionIds.size === 0
   && pending.scratchlistSessionIds.size === 0
  ) {
   return
  }

  const shouldInvalidateSessions = pending.sessions
  const shouldInvalidateMachines = pending.machines
  const sessionIds = Array.from(pending.sessionIds)
  const scratchlistSessionIds = Array.from(pending.scratchlistSessionIds)

  pending.sessions = false
  pending.machines = false
  pending.sessionIds.clear()
  pending.scratchlistSessionIds.clear()

  const tasks: Array<Promise<unknown>> = []
  if (shouldInvalidateSessions) {
   tasks.push(this.#queryClient.invalidateQueries({ queryKey: queryKeys.sessions }))
  }
  for (const sessionId of sessionIds) {
   tasks.push(this.#queryClient.invalidateQueries({ queryKey: queryKeys.session(sessionId) }))
  }
  for (const sessionId of scratchlistSessionIds) {
   tasks.push(this.#queryClient.invalidateQueries({ queryKey: queryKeys.scratchlist(sessionId) }))
  }
  if (shouldInvalidateMachines) {
   tasks.push(this.#queryClient.invalidateQueries({ queryKey: queryKeys.machines }))
  }

  if (tasks.length === 0) {
   return
  }
  void Promise.all(tasks).catch(() => { })
 }
}
