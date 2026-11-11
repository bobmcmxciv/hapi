import type { ApiClient } from '@/api/client'
import { normalizeDecryptedMessage } from '@/chat/normalize'
import type { DecryptedMessage, MessageStatus, MessagesResponse } from '@/types/api'
import { isQueuedForInvocation, mergeMessages } from '@/lib/messages'
import { TURN_PAGE_ROW_LIMIT, compareTurnPosition, isInvokedUserTurn, isUserTurnContent, mergeTurnSegments, type MessageTurnSegment } from '@hapi/protocol/messageTurns'

export type MessageViewMode = 'tail' | 'history'

export type OlderLoadOutcome =
 | {
  kind: 'applied'
  historyVersion: number
  hasMore: boolean
  addedRenderableCount: number
 }
 | {
  kind: 'stopped'
  reason: 'unavailable' | 'busy' | 'invalidated' | 'epoch-reset' | 'exhausted'
 }
 | {
  kind: 'failed'
  error: Error
 }

export type MessageWindowState = {
 sessionId: string
 messages: DecryptedMessage[]
 hasMore: boolean
 oldestSeq: number | null
 newestSeq: number | null
 epoch: number | null
 isSyncingTail: boolean
 isLoadingMore: boolean
 warning: string | null
 viewMode: MessageViewMode
 messagesVersion: number
 historyVersion: number
 turnSegments: MessageTurnSegment[]
}

export const VISIBLE_WINDOW_SIZE = 400
export const HISTORY_WINDOW_SIZE = 600
const AGENT_RUN_WINDOW_SIZE = 800
const OLDER_LOAD_WINDOW_SIZE = 800
const PAGE_SIZE = 200

type MessagePosition = {
 at: number
 order: number
 eventOrder: number
 seq: number
}

type InternalState = MessageWindowState & {
 oldestPositionAt: number | null
 oldestPositionOrder: number
 oldestPositionEventOrder: number
 oldestPositionSeq: number | null
 newestPositionAt: number | null
 newestPositionOrder: number
 newestPositionEventOrder: number
 newestPositionSeq: number | null
 requiresLatestReset: boolean
 syncGeneration: number
 olderGeneration: number
 turnPageSize?: number
}

type PersistedMessageWindowState = {
 messages: DecryptedMessage[]
 hasMore: boolean
 oldestPositionAt: number | null
 oldestPositionOrder?: number
 oldestPositionEventOrder?: number
 oldestPositionSeq: number | null
 newestPositionAt: number | null
 newestPositionOrder?: number
 newestPositionEventOrder?: number
 newestPositionSeq: number | null
 epoch: number | null
}

/** Beta opts in; changing the paging contract invalidates cached row cursors. */
export function configureMessageWindowTurns(sessionId: string, turns?: number): void {
 const nextTurns = turns === undefined ? undefined : Math.max(1, Math.min(20, turns))
 if (getState(sessionId).turnPageSize === nextTurns) return
 const controller = tailSyncControllers.get(sessionId)
 if (controller?.running) controller.trailingRequested = true
 updateState(sessionId, (previous) => previous.turnPageSize === nextTurns ? previous : buildState(previous, {
  turnPageSize: nextTurns,
  turnSegments: [],
  requiresLatestReset: true,
  epoch: null,
  syncGeneration: ++requestGeneration,
  olderGeneration: ++requestGeneration,
  isSyncingTail: false,
  isLoadingMore: false
 }), true)
}

type TailSyncController = {
 api: ApiClient
 running: Promise<void> | null
 trailingRequested: boolean
}

const states = new Map<string, InternalState>()
const listeners = new Map<string, Set<() => void>>()
const tailSyncControllers = new Map<string, TailSyncController>()

const NOTIFY_THROTTLE_MS = 150
const PERSIST_THROTTLE_MS = 200
const STORAGE_KEY_PREFIX = 'hapi:message-window:v2:'
let storageScope = ''
// Unique across cache scopes: a late request from an old account cannot match a new generation.
let scopeGeneration = 0
let requestGeneration = 0
const pendingNotifySessionIds = new Set<string>()
const pendingPersistSessionIds = new Set<string>()
let notifyRafId: ReturnType<typeof requestAnimationFrame> | null = null
let notifyTimerId: ReturnType<typeof setTimeout> | null = null
let persistTimerId: ReturnType<typeof setTimeout> | null = null
let lastNotifyAt = 0

function requestNotifyFrame(): void {
 if (notifyRafId !== null) {
  return
 }
 if (typeof requestAnimationFrame === 'function') {
  notifyRafId = requestAnimationFrame(flushNotifications)
  return
 }
 notifyRafId = setTimeout(flushNotifications, 0) as unknown as ReturnType<typeof requestAnimationFrame>
}

function scheduleNotify(sessionId: string): void {
 pendingNotifySessionIds.add(sessionId)
 if (notifyRafId !== null || notifyTimerId !== null) {
  return
 }
 const remaining = NOTIFY_THROTTLE_MS - (Date.now() - lastNotifyAt)
 if (remaining <= 0) {
  requestNotifyFrame()
  return
 }
 notifyTimerId = setTimeout(() => {
  notifyTimerId = null
  requestNotifyFrame()
 }, remaining)
}

function flushNotifications(): void {
 notifyRafId = null
 lastNotifyAt = Date.now()
 const sessionIds = [...pendingNotifySessionIds]
 pendingNotifySessionIds.clear()
 for (const sessionId of sessionIds) {
  const subscribers = listeners.get(sessionId)
  if (!subscribers) continue
  for (const listener of subscribers) {
   listener()
  }
 }
}

function getStorageKey(sessionId: string): string {
 return `${STORAGE_KEY_PREFIX}${storageScope ? `${encodeURIComponent(storageScope)}:` : ''}${sessionId}`
}

function isSessionStorageAvailable(): boolean {
 try {
  return typeof sessionStorage?.getItem === 'function'
 } catch {
  return false
 }
}

function toNullableNumber(value: unknown): number | null {
 return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readPosition(at: unknown, seq: unknown, order: unknown = 0, eventOrder: unknown = 0): MessagePosition | null {
 const positionAt = toNullableNumber(at)
 const positionSeq = toNullableNumber(seq)
 return positionAt !== null && positionSeq !== null
  ? {
   at: positionAt,
   order: toNullableNumber(order) ?? 0,
   eventOrder: toNullableNumber(eventOrder) ?? 0,
   seq: positionSeq
  }
  : null
}

function cursorRequestFields<P extends 'before' | 'after' | 'until'>(
 prefix: P,
 position: MessagePosition | null | undefined
): Record<string, number | null> {
 if (!position) {
  return prefix === 'until'
   ? { untilAt: null, untilSeq: null }
   : {}
 }
 return {
  [`${prefix}At`]: position.at,
  [`${prefix}Seq`]: position.seq,
  ...(position.order !== 0 ? { [`${prefix}Order`]: position.order } : {}),
  ...(position.eventOrder !== 0 ? { [`${prefix}EventOrder`]: position.eventOrder } : {})
 }
}

function shouldPersistState(state: InternalState): boolean {
 return state.messages.length > 0
  || state.hasMore
  || state.epoch !== null
  || state.oldestPositionAt !== null
  || state.newestPositionAt !== null
}

function persistState(sessionId: string, state: InternalState): void {
 if (!isSessionStorageAvailable()) {
  return
 }
 try {
  if (!shouldPersistState(state)) {
   sessionStorage.removeItem(getStorageKey(sessionId))
   return
  }
  const persisted: PersistedMessageWindowState = {
   messages: state.messages,
   hasMore: state.hasMore,
   oldestPositionAt: state.oldestPositionAt,
   ...(state.oldestPositionOrder !== 0 ? { oldestPositionOrder: state.oldestPositionOrder } : {}),
   ...(state.oldestPositionEventOrder !== 0 ? { oldestPositionEventOrder: state.oldestPositionEventOrder } : {}),
   oldestPositionSeq: state.oldestPositionSeq,
   newestPositionAt: state.newestPositionAt,
   ...(state.newestPositionOrder !== 0 ? { newestPositionOrder: state.newestPositionOrder } : {}),
   ...(state.newestPositionEventOrder !== 0 ? { newestPositionEventOrder: state.newestPositionEventOrder } : {}),
   newestPositionSeq: state.newestPositionSeq,
   epoch: state.epoch
  }
  sessionStorage.setItem(getStorageKey(sessionId), JSON.stringify(persisted))
 } catch {
 }
}

function clearPersistedState(sessionId: string): void {
 pendingPersistSessionIds.delete(sessionId)
 if (!isSessionStorageAvailable()) {
  return
 }
 try {
  sessionStorage.removeItem(getStorageKey(sessionId))
 } catch {
 }
}

function flushPersistedStates(): void {
 persistTimerId = null
 const sessionIds = [...pendingPersistSessionIds]
 pendingPersistSessionIds.clear()
 for (const sessionId of sessionIds) {
  const state = states.get(sessionId)
  if (state) {
   persistState(sessionId, state)
  } else {
   clearPersistedState(sessionId)
  }
 }
}

function schedulePersist(sessionId: string): void {
 if (!isSessionStorageAvailable()) {
  return
 }
 pendingPersistSessionIds.add(sessionId)
 if (persistTimerId === null) {
  persistTimerId = setTimeout(flushPersistedStates, PERSIST_THROTTLE_MS)
 }
}

function createState(sessionId: string): InternalState {
 return {
  sessionId,
  messages: [],
  hasMore: false,
  oldestSeq: null,
  newestSeq: null,
  epoch: null,
  isSyncingTail: false,
  isLoadingMore: false,
  warning: null,
  viewMode: 'tail',
  messagesVersion: 0,
  historyVersion: 0,
  turnSegments: [],
  oldestPositionAt: null,
  oldestPositionOrder: 0,
  oldestPositionEventOrder: 0,
  oldestPositionSeq: null,
  newestPositionAt: null,
  newestPositionOrder: 0,
  newestPositionEventOrder: 0,
  newestPositionSeq: null,
  requiresLatestReset: false,
  syncGeneration: 0,
  olderGeneration: 0
 }
}

function hydrateState(sessionId: string): InternalState | null {
 if (!isSessionStorageAvailable()) {
  return null
 }
 try {
  const raw = sessionStorage.getItem(getStorageKey(sessionId))
  if (!raw) {
   return null
  }
  const parsed = JSON.parse(raw) as Partial<PersistedMessageWindowState> | null
  if (!parsed || !Array.isArray(parsed.messages)) {
   clearPersistedState(sessionId)
   return null
  }
  const restoreMessage = (message: DecryptedMessage): DecryptedMessage => {
   if (message.status !== 'sending') {
    return message
   }
   return {
    ...message,
    status: message.invokedAt === null ? 'queued' : 'sent'
   }
  }
  const oldest = readPosition(
   parsed.oldestPositionAt,
   parsed.oldestPositionSeq,
   parsed.oldestPositionOrder,
   parsed.oldestPositionEventOrder
  )
  const newest = readPosition(
   parsed.newestPositionAt,
   parsed.newestPositionSeq,
   parsed.newestPositionOrder,
   parsed.newestPositionEventOrder
  )
  const epoch = typeof parsed.epoch === 'number' && Number.isInteger(parsed.epoch) && parsed.epoch >= 0
   ? parsed.epoch
   : null
  return buildState(createState(sessionId), {
   messages: mergeMessages([], parsed.messages.map(restoreMessage)),
   hasMore: parsed.hasMore === true,
   oldestPositionAt: oldest?.at ?? null,
   oldestPositionOrder: oldest?.order ?? 0,
   oldestPositionEventOrder: oldest?.eventOrder ?? 0,
   oldestPositionSeq: oldest?.seq ?? null,
   newestPositionAt: newest?.at ?? null,
   newestPositionOrder: newest?.order ?? 0,
   newestPositionEventOrder: newest?.eventOrder ?? 0,
   newestPositionSeq: newest?.seq ?? null,
   epoch,
   requiresLatestReset: parsed.messages.length > 0 && (newest === null || epoch === null)
  })
 } catch {
  clearPersistedState(sessionId)
  return null
 }
}

function getState(sessionId: string): InternalState {
 const existing = states.get(sessionId)
 if (existing) {
  return existing
 }
 const created = hydrateState(sessionId) ?? createState(sessionId)
 states.set(sessionId, created)
 return created
}

function notifyImmediate(sessionId: string): void {
 const subscribers = listeners.get(sessionId)
 if (!subscribers) return
 for (const listener of subscribers) {
  listener()
 }
}

function setState(sessionId: string, next: InternalState, immediate = false): void {
 const previous = states.get(sessionId)
 states.set(sessionId, next)
 // View/loading transitions do not change the reload checkpoint. Serializing
 // a multi-megabyte transcript here stalls scrolling and tail jumps.
 if (!previous || previous.messages !== next.messages
  || previous.hasMore !== next.hasMore || previous.epoch !== next.epoch
  || previous.oldestPositionAt !== next.oldestPositionAt
  || previous.oldestPositionOrder !== next.oldestPositionOrder
  || previous.oldestPositionEventOrder !== next.oldestPositionEventOrder
  || previous.oldestPositionSeq !== next.oldestPositionSeq
  || previous.newestPositionAt !== next.newestPositionAt
  || previous.newestPositionOrder !== next.newestPositionOrder
  || previous.newestPositionEventOrder !== next.newestPositionEventOrder
  || previous.newestPositionSeq !== next.newestPositionSeq) {
  schedulePersist(sessionId)
 }
 if (immediate) {
  notifyImmediate(sessionId)
 } else {
  scheduleNotify(sessionId)
 }
}

function updateState(
 sessionId: string,
 updater: (previous: InternalState) => InternalState,
 immediate = false
): void {
 const previous = getState(sessionId)
 const next = updater(previous)
 if (next !== previous) {
  setState(sessionId, next, immediate)
 }
}

function deriveSeqBounds(messages: DecryptedMessage[]): { oldestSeq: number | null; newestSeq: number | null } {
 let oldestSeq: number | null = null
 let newestSeq: number | null = null
 for (const message of messages) {
  if (typeof message.seq !== 'number') continue
  oldestSeq = oldestSeq === null ? message.seq : Math.min(oldestSeq, message.seq)
  newestSeq = newestSeq === null ? message.seq : Math.max(newestSeq, message.seq)
 }
 return { oldestSeq, newestSeq }
}

function messagePosition(message: DecryptedMessage): MessagePosition | null {
 return typeof message.seq === 'number'
  ? {
   at: message.position?.at ?? message.invokedAt ?? message.createdAt,
   order: message.position?.order ?? 0,
   eventOrder: message.position?.eventOrder ?? 0,
   seq: message.seq
  }
  : null
}

function derivePosition(
 messages: DecryptedMessage[],
 direction: 'oldest' | 'newest',
 excludeUninvokedUsers = false
): MessagePosition | null {
 let selected: MessagePosition | null = null
 for (const message of messages) {
  if (excludeUninvokedUsers && !message.resolution && message.invokedAt === null && isUserTurnContent(message.content)) continue
  const candidate = messagePosition(message)
  if (!candidate) continue
  if (!selected) {
   selected = candidate
   continue
  }
  const comparison = compareTurnPosition(candidate, selected)
  if ((direction === 'oldest' && comparison < 0) || (direction === 'newest' && comparison > 0)) {
   selected = candidate
  }
 }
 return selected
}

function getOldestCursor(state: InternalState): MessagePosition | null {
 return readPosition(
  state.oldestPositionAt,
  state.oldestPositionSeq,
  state.oldestPositionOrder,
  state.oldestPositionEventOrder
 )
}

function getNewestCursor(state: InternalState): MessagePosition | null {
 return readPosition(
  state.newestPositionAt,
  state.newestPositionSeq,
  state.newestPositionOrder,
  state.newestPositionEventOrder
 )
}

function buildState(
 previous: InternalState,
 updates: Partial<Pick<InternalState,
  | 'messages'
  | 'hasMore'
  | 'epoch'
  | 'isSyncingTail'
  | 'isLoadingMore'
  | 'warning'
  | 'viewMode'
  | 'oldestPositionAt'
  | 'oldestPositionOrder'
  | 'oldestPositionEventOrder'
  | 'oldestPositionSeq'
  | 'newestPositionAt'
  | 'newestPositionOrder'
  | 'newestPositionEventOrder'
  | 'newestPositionSeq'
  | 'requiresLatestReset'
  | 'syncGeneration'
  | 'olderGeneration'
  | 'historyVersion'
  | 'turnPageSize'
  | 'turnSegments'
 >>
): InternalState {
 const messages = updates.messages ?? previous.messages
 const bounds = deriveSeqBounds(messages)
 return {
  ...previous,
  ...updates,
  messages,
  oldestSeq: bounds.oldestSeq,
  newestSeq: bounds.newestSeq,
  messagesVersion: messages === previous.messages
   ? previous.messagesVersion
   : previous.messagesVersion + 1
 }
}

function sliceForTrim<T>(
 items: T[],
 limit: number,
 mode: 'append' | 'prepend'
): { kept: T[]; dropped: T[] } {
 if (items.length <= limit) {
  return { kept: items, dropped: [] }
 }
 if (limit <= 0) {
  return { kept: [], dropped: items }
 }
 return mode === 'prepend'
  ? { kept: items.slice(0, limit), dropped: items.slice(limit) }
  : { kept: items.slice(items.length - limit), dropped: items.slice(0, items.length - limit) }
}

function isCodexAgentRunMessage(message: DecryptedMessage): boolean {
 const outer = message.content
 if (!outer || typeof outer !== 'object' || (outer as { role?: unknown }).role !== 'agent') {
  return false
 }
 const content = (outer as { content?: unknown }).content
 if (!content || typeof content !== 'object') return false
 const payload = content as { type?: unknown; data?: unknown }
 if (payload.type !== 'codex' || !payload.data || typeof payload.data !== 'object') {
  return false
 }
 const type = (payload.data as { type?: unknown }).type
 return type === 'agent-run-start' || type === 'agent-run-update' || type === 'agent-run-trace'
}

function trimPreservingQueued(
 messages: DecryptedMessage[],
 regularLimit: number,
 mode: 'append' | 'prepend',
 turnMode = false
): { kept: DecryptedMessage[]; dropped: DecryptedMessage[] } {
 const queued = messages.filter(isQueuedForInvocation)
 const queuedIds = new Set(queued.map((message) => message.id))
 const nonQueued = messages.filter((message) => !queuedIds.has(message.id))
 if (turnMode) {
  // Retain whole turns, rather than independently clipping tool/run records.
  // A single exceptional turn still has a hard memory bound; its coverage is
  // marked incomplete below instead of claiming it is fully shareable.
  const limit = TURN_PAGE_ROW_LIMIT * 4
  if (nonQueued.length <= limit) return { kept: messages, dropped: [] }
  if (mode === 'append') {
   let start = nonQueued.length - limit
   const boundary = nonQueued.findIndex((message, index) => index >= start && isInvokedUserTurn(message))
   if (boundary >= 0) start = boundary
   return { kept: mergeMessages(nonQueued.slice(start), queued), dropped: nonQueued.slice(0, start) }
  }
  let end = limit
  for (let index = end; index > 0; index--) {
   if (isInvokedUserTurn(nonQueued[index])) { end = index; break }
  }
  return { kept: mergeMessages(nonQueued.slice(0, end), queued), dropped: nonQueued.slice(end) }
 }
 const agentRuns = nonQueued.filter(isCodexAgentRunMessage)
 const regular = nonQueued.filter((message) => !isCodexAgentRunMessage(message))
 const regularTrim = sliceForTrim(regular, Math.max(0, regularLimit - queued.length), mode)
 const agentRunTrim = sliceForTrim(agentRuns, AGENT_RUN_WINDOW_SIZE, mode)
 return {
  kept: mergeMessages([...regularTrim.kept, ...agentRunTrim.kept], queued),
  dropped: [...regularTrim.dropped, ...agentRunTrim.dropped]
 }
}

function clipTurnSegments(segments: MessageTurnSegment[], kept: DecryptedMessage[], dropped: DecryptedMessage[]): MessageTurnSegment[] {
 if (segments.length === 0 || dropped.length === 0) return segments
 const oldest = derivePosition(kept, 'oldest', true)
 const newest = derivePosition(kept, 'newest', true)
 if (!oldest || !newest) return []
 return segments.flatMap((segment) => {
  if (compareTurnPosition(segment.to, oldest) < 0 || compareTurnPosition(segment.from, newest) > 0) return []
  const clippedBefore = compareTurnPosition(segment.from, oldest) < 0
  const clippedAfter = compareTurnPosition(segment.to, newest) > 0
  return [{
   ...segment,
   from: clippedBefore ? oldest : segment.from,
   to: clippedAfter ? newest : segment.to,
   completeBefore: segment.completeBefore && !clippedBefore,
   completeAfter: segment.completeAfter && !clippedAfter
  }]
 })
}

/** Extend only the small coverage list and the incoming batch, not the history.
 * Live events are provisional until the next authoritative page revalidates it. */
function extendTurnCoverage(held: MessageTurnSegment[], incoming: DecryptedMessage[]): MessageTurnSegment[] {
 const segments = held.slice()
 for (const message of incoming) {
  if (isQueuedForInvocation(message)) continue
  const position = messagePosition(message)
  if (!position) continue
  const last = segments.at(-1)
  if (last && compareTurnPosition(position, last.to) <= 0) continue
  if (!last || isInvokedUserTurn(message)) {
   if (last) segments[segments.length - 1] = { ...last, completeAfter: true }
   segments.push({
    turnId: isInvokedUserTurn(message) ? message.id : null,
    from: position, to: position, completeBefore: isInvokedUserTurn(message), completeAfter: false
   })
  } else {
   segments[segments.length - 1] = { ...last, to: position, completeAfter: false }
  }
 }
 return segments
}

function optimisticMessage(message: DecryptedMessage): boolean {
 return Boolean(message.localId && message.id === message.localId)
}

function shouldRetainWindowMessage(message: DecryptedMessage): boolean {
 return isQueuedForInvocation(message) || normalizeDecryptedMessage(message) !== null
}

function countNewRenderableMessages(
 previous: InternalState,
 incoming: DecryptedMessage[]
): number {
 const representedIds = new Set(previous.messages.map((message) => message.id))
 const representedLocalIds = new Set(
  previous.messages.flatMap((message) => message.localId ? [message.localId] : [])
 )
 let count = 0
 for (const message of incoming) {
  if (!shouldRetainWindowMessage(message)) continue
  if (representedIds.has(message.id)) continue
  if (message.localId && representedLocalIds.has(message.localId)) continue
  count += 1
  representedIds.add(message.id)
  if (message.localId) representedLocalIds.add(message.localId)
 }
 return count
}

function mergeIntoWindow(
 previous: InternalState,
 incoming: DecryptedMessage[],
 options: {
  mode?: 'append' | 'prepend'
  regularLimit?: number
 } = {}
): InternalState {
 const retainedIncoming = incoming.filter(shouldRetainWindowMessage)
 if (retainedIncoming.length === 0) {
  return previous
 }
 const mode = options.mode ?? (previous.viewMode === 'history' ? 'prepend' : 'append')
 const regularLimit = options.regularLimit
  ?? (previous.viewMode === 'history' ? HISTORY_WINDOW_SIZE : VISIBLE_WINDOW_SIZE)
 const merged = mergeMessages(previous.messages, retainedIncoming)
 const { kept, dropped } = trimPreservingQueued(merged, regularLimit, mode, previous.turnPageSize !== undefined)
 let next = buildState(previous, {
  messages: kept,
  turnSegments: clipTurnSegments(previous.turnPageSize === undefined ? previous.turnSegments
   : extendTurnCoverage(previous.turnSegments, retainedIncoming), kept, dropped)
 })
 if (dropped.length === 0) {
  return next
 }
 if (mode === 'append') {
  const oldest = derivePosition(kept, 'oldest', previous.turnPageSize !== undefined)
  return buildState(next, {
   hasMore: true,
   oldestPositionAt: oldest?.at ?? next.oldestPositionAt,
   oldestPositionOrder: oldest?.order ?? next.oldestPositionOrder,
   oldestPositionEventOrder: oldest?.eventOrder ?? next.oldestPositionEventOrder,
   oldestPositionSeq: oldest?.seq ?? next.oldestPositionSeq
  })
 }
 const newest = derivePosition(kept, 'newest', previous.turnPageSize !== undefined)
 next = buildState(next, {
  requiresLatestReset: true,
  newestPositionAt: newest?.at ?? null,
  newestPositionOrder: newest?.order ?? 0,
  newestPositionEventOrder: newest?.eventOrder ?? 0,
  newestPositionSeq: newest?.seq ?? null
 })
 return next
}

function pagePosition(
 at: number | null,
 seq: number | null,
 order = 0,
 eventOrder = 0
): MessagePosition | null {
 return at !== null && seq !== null ? { at, order, eventOrder, seq } : null
}

function applyLatestResponse(
 previous: InternalState,
 response: MessagesResponse,
 options: {
  replaceServerRows: boolean
  requestBaseline: Map<string, DecryptedMessage>
 }
): InternalState {
 const retainedResponseMessages = response.messages.filter(shouldRetainWindowMessage)
 const responseIds = new Set(retainedResponseMessages.map((message) => message.id))
 const concurrentServerRows = previous.messages.filter((message) => (
  !optimisticMessage(message)
  && options.requestBaseline.get(message.id) !== message
 ))
 const preserved = options.replaceServerRows
  ? previous.messages.filter((message) => (
   optimisticMessage(message)
   || options.requestBaseline.get(message.id) !== message
   || (Boolean(message.resolution) && responseIds.has(message.id))
  ))
  : previous.messages
 const authoritative = mergeMessages(preserved, retainedResponseMessages)
 const incoming = mergeMessages(authoritative, concurrentServerRows)
 const { kept, dropped } = trimPreservingQueued(incoming, VISIBLE_WINDOW_SIZE, 'append', previous.turnPageSize !== undefined)
 const snapshotHead = pagePosition(
  response.page.snapshotHeadAt,
  response.page.snapshotHeadSeq,
  response.page.snapshotHeadOrder,
  response.page.snapshotHeadEventOrder
 )
  ?? derivePosition(response.messages, 'newest', previous.turnPageSize !== undefined)
 const newestKept = derivePosition(kept, 'newest', previous.turnPageSize !== undefined)
 const newest = snapshotHead && newestKept
  ? (compareTurnPosition(snapshotHead, newestKept) >= 0 ? snapshotHead : newestKept)
  : snapshotHead ?? newestKept
 const responseOldest = pagePosition(
  response.page.nextBeforeAt,
  response.page.nextBeforeSeq,
  response.page.nextBeforeOrder,
  response.page.nextBeforeEventOrder
 )
 const previousOldest = getOldestCursor(previous)
 const oldest = dropped.length > 0
  ? derivePosition(kept, 'oldest', previous.turnPageSize !== undefined)
  : options.replaceServerRows
   ? responseOldest
   : responseOldest ?? previousOldest
 return buildState(previous, {
  messages: kept,
  turnSegments: clipTurnSegments(options.replaceServerRows ? response.page.turns?.segments ?? []
   : mergeTurnSegments(previous.turnSegments, response.page.turns?.segments ?? [], true), kept, dropped),
  hasMore: response.page.hasMore || (!options.replaceServerRows && previous.hasMore) || dropped.length > 0,
  epoch: response.page.epoch,
  oldestPositionAt: oldest?.at ?? null,
  oldestPositionOrder: oldest?.order ?? 0,
  oldestPositionEventOrder: oldest?.eventOrder ?? 0,
  oldestPositionSeq: oldest?.seq ?? null,
  newestPositionAt: newest?.at ?? null,
  newestPositionOrder: newest?.order ?? 0,
  newestPositionEventOrder: newest?.eventOrder ?? 0,
  newestPositionSeq: newest?.seq ?? null,
  requiresLatestReset: false,
  isLoadingMore: options.replaceServerRows ? false : previous.isLoadingMore,
  olderGeneration: options.replaceServerRows
   ? ++requestGeneration
   : previous.olderGeneration,
  warning: null
 })
}

type HeldRange = {
 /** Exclusive lower bound: strictly before the oldest retained server row. */
 after: MessagePosition
 /** Inclusive upper bound: the newest position this window claims to cover. */
 until: MessagePosition
}

/**
 * The position interval the window currently claims as continuous coverage.
 * An epoch change only says that rows were inserted before the head or
 * removed (rewind); re-reading this interval under the new epoch lets the
 * window learn what changed without discarding what the user is reading.
 */
function getHeldRange(state: InternalState): HeldRange | null {
 const oldest = getOldestCursor(state)
  ?? derivePosition(state.messages, 'oldest', state.turnPageSize !== undefined)
 const newest = getNewestCursor(state) ?? derivePosition(state.messages, 'newest', state.turnPageSize !== undefined)
 if (!oldest || !newest || compareTurnPosition(newest, oldest) < 0) {
  return null
 }
 return { after: { ...oldest, seq: oldest.seq - 1 }, until: newest }
}

type HeldRangeRevalidation =
 | { kind: 'ok'; epoch: number; rows: DecryptedMessage[]; segments: MessageTurnSegment[] }
 | { kind: 'stale' }
 | { kind: 'unavailable' }

const MAX_REVALIDATION_PAGES = 12

/**
 * Re-reads `range` page by page. The request carries no epoch on purpose:
 * that keeps the hub on the positional path, so it answers with the rows it
 * has now instead of escalating to a latest-page reset.
 */
async function fetchHeldRangeRows(
 api: ApiClient,
 sessionId: string,
 range: HeldRange,
 isCurrent: () => boolean
): Promise<HeldRangeRevalidation> {
 let rows: DecryptedMessage[] = []
 let segments: MessageTurnSegment[] = []
 let after = range.after
 let epoch: number | null = null
 let restarts = 0
 const turns = getState(sessionId).turnPageSize === undefined ? undefined : 20
 // Tiny turns may contain one record each. Size the bounded revalidation
 // budget for the actual Beta window, not the legacy 200-record page size.
 const maxPages = turns === undefined ? MAX_REVALIDATION_PAGES
  : Math.ceil((TURN_PAGE_ROW_LIMIT * 4) / turns) + MAX_REVALIDATION_PAGES
 for (let page = 0; page < maxPages; page++) {
  const response = await api.getMessages(sessionId, {
   ...cursorRequestFields('after', after),
   ...cursorRequestFields('until', range.until),
   limit: PAGE_SIZE,
   ...(turns ? { turns } : {}),
  })
  if (!isCurrent()) {
   return { kind: 'stale' }
  }
  if (response.page.direction !== 'after' || response.page.reset) {
   return { kind: 'unavailable' }
  }
  if (epoch !== null && response.page.epoch !== epoch) {
   if (restarts >= 2) return { kind: 'unavailable' }
   // The epoch moved again while we were reading: start over so the
   // pages we keep all describe one epoch.
   restarts += 1
   rows = []
   segments = []
   after = range.after
   epoch = null
   page = -1
   continue
  }
  epoch = response.page.epoch
  rows.push(...response.messages)
  segments = mergeTurnSegments(segments, response.page.turns?.segments ?? [], true)
  const nextAfter = pagePosition(
   response.page.nextAfterAt,
   response.page.nextAfterSeq,
   response.page.nextAfterOrder,
   response.page.nextAfterEventOrder
  )
  if (!response.page.hasMore || !nextAfter || compareTurnPosition(nextAfter, after) <= 0) {
   return { kind: 'ok', epoch, rows, segments }
  }
  after = nextAfter
 }
 return { kind: 'unavailable' }
}

/**
 * Applies a re-read of `range`: server rows inside the interval that the hub
 * no longer returns were deleted (rewind / clear) and leave the window;
 * everything the hub returned is merged in. Trimming is prepend-sided so
 * inserted rows can only evict the tail, never the side being read.
 */
function applyRevalidatedRange(
 previous: InternalState,
 range: HeldRange,
 rows: DecryptedMessage[],
 epoch: number,
 regularLimit: number,
 segments: MessageTurnSegment[] = []
): InternalState {
 const serverIds = new Set(rows.map((row) => row.id))
 const insideRange = (message: DecryptedMessage): boolean => {
  const position = messagePosition(message)
  return position !== null
   && compareTurnPosition(position, range.after) > 0
   && compareTurnPosition(position, range.until) <= 0
 }
 const survivors = previous.messages.filter((message) => (
  optimisticMessage(message)
  || isQueuedForInvocation(message)
  || !insideRange(message)
  || serverIds.has(message.id)
 ))
 const merged = mergeMessages(survivors, rows.filter(shouldRetainWindowMessage))
 const { kept, dropped } = trimPreservingQueued(merged, regularLimit, 'prepend', previous.turnPageSize !== undefined)
 const newestKept = derivePosition(kept, 'newest', previous.turnPageSize !== undefined)
 const tailEvicted = previous.requiresLatestReset || dropped.length > 0
 const newest = tailEvicted
  ? newestKept
  : (newestKept && compareTurnPosition(newestKept, range.until) > 0 ? newestKept : range.until)
 return buildState(previous, {
  messages: kept,
  turnSegments: clipTurnSegments(segments, kept, dropped),
  epoch,
  newestPositionAt: newest?.at ?? null,
  newestPositionOrder: newest?.order ?? 0,
  newestPositionEventOrder: newest?.eventOrder ?? 0,
  newestPositionSeq: newest?.seq ?? null,
  requiresLatestReset: tailEvicted,
  warning: null
 })
}

function beginTailSync(sessionId: string): number {
 let generation = 0
 updateState(sessionId, (previous) => {
  generation = ++requestGeneration
  return buildState(previous, {
   syncGeneration: generation,
   // Tail reconciliation owns the authoritative epoch. An older-page
   // response captured before this point must not commit while the tail
   // request is in flight, or a reset can mistake it for concurrent SSE.
   olderGeneration: ++requestGeneration,
   isSyncingTail: true,
   isLoadingMore: false,
   warning: null
  })
 })
 return generation
}

function isCurrentTailSync(sessionId: string, generation: number): boolean {
 return getState(sessionId).syncGeneration === generation
}

function finishTailSync(sessionId: string, generation: number, warning: string | null): void {
 updateState(sessionId, (previous) => {
  if (previous.syncGeneration !== generation) {
   return previous
  }
  return buildState(previous, { isSyncingTail: false, warning })
 })
}

async function runTailSync(api: ApiClient, sessionId: string): Promise<void> {
 const preflight = getState(sessionId)
 // While the user is reading history, requiresLatestReset only records that
 // the tail was evicted from the bounded window — the epoch is still valid.
 // Running the latest-page reset here would replace the loaded history with
 // the newest page and snap the view back to the bottom. Defer it until the
 // window returns to tail mode (enterTailMode clears the cursor, and
 // setViewMode('tail') schedules the sync). An epoch of null means history
 // itself is invalid, so the reset must still run.
 if (preflight.viewMode === 'history' && preflight.requiresLatestReset && preflight.epoch !== null) {
  return
 }
 const generation = beginTailSync(sessionId)
 try {
  const initial = getState(sessionId)
  const initialCursor = getNewestCursor(initial)
  const canIncrement = initialCursor !== null
   && initial.epoch !== null
   && !initial.requiresLatestReset

  if (!canIncrement) {
   const requestBaseline = new Map(getState(sessionId).messages.map((message) => [message.id, message]))
   const response = await api.getMessages(sessionId, { limit: PAGE_SIZE, ...(initial.turnPageSize ? { turns: initial.turnPageSize } : {}) })
   if (!isCurrentTailSync(sessionId, generation)) return
   updateState(sessionId, (previous) => {
    if (previous.syncGeneration !== generation) return previous
    return applyLatestResponse(previous, response, {
     replaceServerRows: initial.requiresLatestReset || response.page.reset,
     requestBaseline
    })
   })
   finishTailSync(sessionId, generation, null)
   return
  }

  let after = initialCursor
  let until: MessagePosition | null = null
  while (true) {
   const requestBaseline = new Map(getState(sessionId).messages.map((message) => [message.id, message]))
   const response = await api.getMessages(sessionId, {
    ...cursorRequestFields('after', after),
    ...cursorRequestFields('until', until),
    epoch: initial.epoch,
    limit: PAGE_SIZE,
    ...(initial.turnPageSize ? { turns: initial.turnPageSize } : {}),
   })
   if (!isCurrentTailSync(sessionId, generation)) return

   if (response.page.reset || response.page.direction === 'latest') {
    const current = getState(sessionId)
    const heldRange = current.viewMode === 'history' ? getHeldRange(current) : null
    if (heldRange) {
     // Reading history: the epoch moved, but replacing the window
     // with the latest page would throw away the rows the user is
     // on (#323). Merge the snapshot we were handed, then re-read
     // the covered interval under the new epoch.
     updateState(sessionId, (previous) => {
      if (previous.syncGeneration !== generation) return previous
      return mergeIntoWindow(previous, response.messages)
     })
     const revalidation = await fetchHeldRangeRows(
      api,
      sessionId,
      heldRange,
      () => isCurrentTailSync(sessionId, generation)
     )
     if (revalidation.kind === 'stale') return
     updateState(sessionId, (previous) => {
      if (previous.syncGeneration !== generation) return previous
      if (revalidation.kind !== 'ok') {
       // Could not re-read the interval: history is unverifiable,
       // fall back to the latest-page reset on the next sync.
       return buildState(previous, {
        epoch: null,
        newestPositionAt: null,
        newestPositionOrder: 0,
        newestPositionEventOrder: 0,
        newestPositionSeq: null,
        requiresLatestReset: true
       })
      }
      return applyRevalidatedRange(
       previous,
       heldRange,
       revalidation.rows,
       revalidation.epoch,
       HISTORY_WINDOW_SIZE,
       revalidation.segments
      )
     })
     break
    }
    updateState(sessionId, (previous) => {
     if (previous.syncGeneration !== generation) return previous
     return applyLatestResponse(previous, response, {
      replaceServerRows: true,
      requestBaseline
     })
    })
    break
   }

   const nextAfter = pagePosition(
    response.page.nextAfterAt,
    response.page.nextAfterSeq,
    response.page.nextAfterOrder,
    response.page.nextAfterEventOrder
   )
   const snapshotHead = pagePosition(
    response.page.snapshotHeadAt,
    response.page.snapshotHeadSeq,
    response.page.snapshotHeadOrder,
    response.page.snapshotHeadEventOrder
   )
   if (until === null) {
    until = snapshotHead
   }

   updateState(sessionId, (previous) => {
    if (previous.syncGeneration !== generation) return previous
    const window = mergeIntoWindow(previous, response.messages)
    const keptIds = new Set(window.messages.map((message) => message.id))
    const dropped = mergeMessages(previous.messages, response.messages).filter((message) => !keptIds.has(message.id))
    const merged = buildState(window, {
     turnSegments: clipTurnSegments(mergeTurnSegments(previous.turnSegments, response.page.turns?.segments ?? [], true), window.messages, dropped)
    })
    if (merged.requiresLatestReset) {
     return buildState(merged, {
      epoch: response.page.epoch,
      warning: null
     })
    }
    const currentNewest = getNewestCursor(merged)
    const newest = nextAfter && currentNewest
     ? (compareTurnPosition(nextAfter, currentNewest) >= 0 ? nextAfter : currentNewest)
     : nextAfter ?? currentNewest
    return buildState(merged, {
     epoch: response.page.epoch,
     newestPositionAt: newest?.at ?? null,
     newestPositionOrder: newest?.order ?? 0,
     newestPositionEventOrder: newest?.eventOrder ?? 0,
     newestPositionSeq: newest?.seq ?? null,
     warning: null
    })
   })

   const current = getState(sessionId)
   if (current.requiresLatestReset || !response.page.hasMore || !nextAfter) {
    break
   }
   if (compareTurnPosition(nextAfter, after) <= 0) {
    throw new Error('Message tail cursor did not advance')
   }
   after = nextAfter
  }

  finishTailSync(sessionId, generation, null)
 } catch (error) {
  if (!isCurrentTailSync(sessionId, generation)) return
  finishTailSync(
   sessionId,
   generation,
   error instanceof Error ? error.message : 'Failed to synchronize messages'
  )
 }
}

function startTailSync(sessionId: string, controller: TailSyncController): Promise<void> {
 const running = runTailSync(controller.api, sessionId)
 controller.running = running
 const finish = () => {
  if (tailSyncControllers.get(sessionId) !== controller || controller.running !== running) {
   return
  }
  controller.running = null
  if (!controller.trailingRequested) {
   return
  }
  controller.trailingRequested = false
  startTailSync(sessionId, controller)
 }
 void running.then(finish, finish)
 return running
}

async function waitForTailSyncDrain(
 sessionId: string,
 controller: TailSyncController,
 observed: Promise<void>
): Promise<void> {
 await observed
 if (tailSyncControllers.get(sessionId) !== controller) {
  return
 }
 const current = controller.running
 if (current && current !== observed) {
  await waitForTailSyncDrain(sessionId, controller, current)
 }
}

function enterTailMode(previous: InternalState): InternalState {
 const { kept, dropped } = trimPreservingQueued(previous.messages, VISIBLE_WINDOW_SIZE, 'append', previous.turnPageSize !== undefined)
 const forceLatest = previous.requiresLatestReset
 const oldest = dropped.length > 0
  ? derivePosition(kept, 'oldest', previous.turnPageSize !== undefined)
  : getOldestCursor(previous)
 return buildState(previous, {
  messages: kept,
  turnSegments: clipTurnSegments(previous.turnSegments, kept, dropped),
  hasMore: previous.hasMore || dropped.length > 0,
  viewMode: 'tail',
  epoch: forceLatest ? null : previous.epoch,
  oldestPositionAt: oldest?.at ?? null,
  oldestPositionOrder: oldest?.order ?? 0,
  oldestPositionEventOrder: oldest?.eventOrder ?? 0,
  oldestPositionSeq: oldest?.seq ?? null,
  newestPositionAt: forceLatest ? null : previous.newestPositionAt,
  newestPositionOrder: forceLatest ? 0 : previous.newestPositionOrder,
  newestPositionEventOrder: forceLatest ? 0 : previous.newestPositionEventOrder,
  newestPositionSeq: forceLatest ? null : previous.newestPositionSeq
 })
}

export function activateMessageWindow(sessionId: string): void {
 updateState(sessionId, (previous) => {
  const { kept } = trimPreservingQueued(previous.messages, VISIBLE_WINDOW_SIZE, 'append', previous.turnPageSize !== undefined)
  const forceLatest = previous.requiresLatestReset
  if (
   previous.viewMode === 'tail'
   && kept.length === previous.messages.length
   && !forceLatest
  ) {
   return previous
  }
  return enterTailMode(previous)
 }, true)
}

export function syncTailMessages(
 api: ApiClient,
 sessionId: string,
 options: { ensureAfterCurrent?: boolean } = {}
): Promise<void> {
 let controller = tailSyncControllers.get(sessionId)
 if (!controller) {
  controller = { api, running: null, trailingRequested: false }
  tailSyncControllers.set(sessionId, controller)
 }
 controller.api = api
 if (!controller.running) {
  return startTailSync(sessionId, controller)
 }
 const observed = controller.running
 if (!options.ensureAfterCurrent) {
  return observed
 }
 controller.trailingRequested = true
 return waitForTailSyncDrain(sessionId, controller, observed)
}

export async function fetchOlderMessages(
 api: ApiClient,
 sessionId: string,
 options: {
  onBeforeApply?: (historyVersion: number) => boolean
 } = {}
): Promise<OlderLoadOutcome> {
 const initial = getState(sessionId)
 const before = getOldestCursor(initial)
 if (initial.isSyncingTail || initial.isLoadingMore) {
  return { kind: 'stopped', reason: 'busy' }
 }
 if (!initial.hasMore) {
  return { kind: 'stopped', reason: 'exhausted' }
 }
 if (!before) {
  return { kind: 'stopped', reason: 'unavailable' }
 }
 const generation = ++requestGeneration
 updateState(sessionId, (previous) => buildState(previous, {
  olderGeneration: generation,
  isLoadingMore: true,
  warning: null
 }))

 try {
  const response = await api.getMessages(sessionId, {
   ...cursorRequestFields('before', before),
   limit: PAGE_SIZE,
   ...(initial.turnPageSize ? { turns: initial.turnPageSize } : {}),
  })
  if (getState(sessionId).olderGeneration !== generation) {
   return { kind: 'stopped', reason: 'invalidated' }
  }

  let revalidated: { range: HeldRange; rows: DecryptedMessage[]; epoch: number; segments: MessageTurnSegment[] } | null = null
  if (initial.epoch !== null && response.page.epoch !== initial.epoch) {
   // The hub's epoch moved while this page was in flight: rows were
   // inserted before the head or removed (rewind). The page itself is a
   // valid slice by position, so keep it and re-read the interval this
   // window already holds instead of discarding the user's reading
   // range for the latest page (#323).
   const heldRange = getHeldRange(initial)
   const revalidation = heldRange
    ? await fetchHeldRangeRows(
     api,
     sessionId,
     heldRange,
     () => getState(sessionId).olderGeneration === generation
    )
    : { kind: 'unavailable' as const }
   if (revalidation.kind === 'stale') {
    return { kind: 'stopped', reason: 'invalidated' }
   }
   if (revalidation.kind !== 'ok' || !heldRange) {
    updateState(sessionId, (previous) => {
     if (previous.olderGeneration !== generation) return previous
     return buildState(previous, {
      isLoadingMore: false,
      epoch: null,
      newestPositionAt: null,
      newestPositionOrder: 0,
      newestPositionEventOrder: 0,
      newestPositionSeq: null,
      requiresLatestReset: true
     })
    })
    await syncTailMessages(api, sessionId, { ensureAfterCurrent: true })
    return { kind: 'stopped', reason: 'epoch-reset' }
   }
   revalidated = { range: heldRange, rows: revalidation.rows, epoch: revalidation.epoch, segments: revalidation.segments }
  }

  let historyVersion = 0
  let addedRenderableCount = 0
  let applyRejected = false
  // Prepend trimming and its prepared scroll restore must reach the UI
  // in one publication; the normal 150ms notification throttle would
  // expose rows that this state has already evicted.
  updateState(sessionId, (previous) => {
   if (previous.olderGeneration !== generation) return previous
   // Revalidated rows and the older page land in one publication so the
   // scroll anchor restore sees a single history version.
   const base = revalidated
    ? applyRevalidatedRange(previous, revalidated.range, revalidated.rows, revalidated.epoch, OLDER_LOAD_WINDOW_SIZE, revalidated.segments)
    : previous
   addedRenderableCount = countNewRenderableMessages(base, response.messages)
   const nextHistoryVersion = previous.historyVersion + 1
   if (options.onBeforeApply && !options.onBeforeApply(nextHistoryVersion)) {
    applyRejected = true
    return buildState(previous, {
     olderGeneration: ++requestGeneration,
     isLoadingMore: false,
     warning: null
    })
   }
   const merged = mergeIntoWindow(base, response.messages, {
    mode: 'prepend',
    regularLimit: OLDER_LOAD_WINDOW_SIZE
   })
   const keptIds = new Set(merged.messages.map((row) => row.id))
   historyVersion = nextHistoryVersion
   const nextOldest = pagePosition(
    response.page.nextBeforeAt,
    response.page.nextBeforeSeq,
    response.page.nextBeforeOrder,
    response.page.nextBeforeEventOrder
   )
   return buildState(merged, {
    hasMore: response.page.hasMore,
    epoch: revalidated ? revalidated.epoch : response.page.epoch,
    turnSegments: clipTurnSegments(mergeTurnSegments(base.turnSegments, response.page.turns?.segments ?? [], true), merged.messages,
     mergeMessages(base.messages, response.messages).filter((message) => !keptIds.has(message.id))),
    oldestPositionAt: nextOldest?.at ?? null,
    oldestPositionOrder: nextOldest?.order ?? 0,
    oldestPositionEventOrder: nextOldest?.eventOrder ?? 0,
    oldestPositionSeq: nextOldest?.seq ?? null,
    isLoadingMore: false,
    historyVersion,
    warning: null
   })
  }, true)
  if (applyRejected || historyVersion === 0) {
   return { kind: 'stopped', reason: 'invalidated' }
  }
  return {
   kind: 'applied',
   historyVersion,
   hasMore: response.page.hasMore,
   addedRenderableCount
  }
 } catch (error) {
  if (getState(sessionId).olderGeneration !== generation) {
   return { kind: 'stopped', reason: 'invalidated' }
  }
  const loadError = error instanceof Error
   ? error
   : new Error('Failed to load older messages')
  updateState(sessionId, (previous) => {
   if (previous.olderGeneration !== generation) return previous
   return buildState(previous, {
    isLoadingMore: false,
    warning: loadError.message
   })
  })
  return { kind: 'failed', error: loadError }
 }
}

export function cancelOlderMessageLoad(sessionId: string): void {
 updateState(sessionId, (previous) => {
  if (!previous.isLoadingMore) {
   return previous
  }
  return buildState(previous, {
   olderGeneration: ++requestGeneration,
   isLoadingMore: false,
   warning: null
  })
 }, true)
}

export function setMessageViewMode(sessionId: string, mode: MessageViewMode): void {
 updateState(sessionId, (previous) => {
  if (previous.viewMode === mode) {
   return previous
  }
  if (mode === 'history') {
   return buildState(previous, { viewMode: 'history' })
  }
  return enterTailMode(previous)
 }, true)
}

export function ingestIncomingMessages(sessionId: string, incoming: DecryptedMessage[]): void {
 if (incoming.length === 0) return
 updateState(sessionId, (previous) => {
  let merged = mergeIntoWindow(previous, incoming)
  if (merged.epoch === null || merged.requiresLatestReset) {
   return merged
  }
  const incomingNewest = derivePosition(incoming, 'newest', previous.turnPageSize !== undefined)
  const currentNewest = getNewestCursor(merged)
  const newest = incomingNewest && (!currentNewest || compareTurnPosition(incomingNewest, currentNewest) > 0)
   ? incomingNewest
   : currentNewest
  merged = buildState(merged, {
   newestPositionAt: newest?.at ?? null,
   newestPositionOrder: newest?.order ?? 0,
   newestPositionEventOrder: newest?.eventOrder ?? 0,
   newestPositionSeq: newest?.seq ?? null
  })
  return merged
 })
}

export function getMessageWindowState(sessionId: string): MessageWindowState {
 return getState(sessionId)
}

export function subscribeMessageWindow(sessionId: string, listener: () => void): () => void {
 const subscribers = listeners.get(sessionId) ?? new Set()
 subscribers.add(listener)
 listeners.set(sessionId, subscribers)
 return () => {
  const current = listeners.get(sessionId)
  if (!current) return
  current.delete(listener)
  if (current.size === 0) {
   listeners.delete(sessionId)
  }
 }
}

export function clearMessageWindow(sessionId: string): void {
 tailSyncControllers.delete(sessionId)
 clearPersistedState(sessionId)
 const previous = states.get(sessionId)
 if (!previous) return
 setState(sessionId, {
  ...createState(sessionId),
  turnPageSize: previous.turnPageSize,
  syncGeneration: ++requestGeneration,
  olderGeneration: ++requestGeneration
 }, true)
}

/** Switch identity before mounting a Beta session; stale async generations cannot commit. */
export function setMessageWindowScope(scope: string): void {
 if (storageScope === scope) return
 clearTimeout(persistTimerId ?? undefined)
 flushPersistedStates()
 tailSyncControllers.clear()
 pendingNotifySessionIds.clear()
 const observedIds = [...states.keys()].filter(sessionId => listeners.has(sessionId))
 const observedTurns = new Map(observedIds.map((sessionId) => [sessionId, states.get(sessionId)?.turnPageSize]))
 states.clear()
 storageScope = scope
 scopeGeneration += 1
 for (const sessionId of observedIds) {
  const next = hydrateState(sessionId) ?? createState(sessionId)
  const turnPageSize = observedTurns.get(sessionId)
  states.set(sessionId, {
   ...next, turnPageSize,
   ...(turnPageSize ? { requiresLatestReset: true, epoch: null, turnSegments: [] } : {}),
   syncGeneration: ++requestGeneration, olderGeneration: ++requestGeneration
  })
  notifyImmediate(sessionId)
 }
}

export function seedMessageWindowFromSession(fromSessionId: string, toSessionId: string): void {
 if (!fromSessionId || !toSessionId || fromSessionId === toSessionId) return
 const source = getState(fromSessionId)
 const target = getState(toSessionId)
 const seeded = buildState(createState(toSessionId), {
  messages: [...source.messages],
  turnPageSize: target.turnPageSize ?? source.turnPageSize,
  hasMore: source.hasMore,
  oldestPositionAt: source.oldestPositionAt,
  oldestPositionOrder: source.oldestPositionOrder,
  oldestPositionEventOrder: source.oldestPositionEventOrder,
  oldestPositionSeq: source.oldestPositionSeq,
  requiresLatestReset: true,
  syncGeneration: ++requestGeneration,
  olderGeneration: ++requestGeneration
 })
 tailSyncControllers.delete(toSessionId)
 setState(toSessionId, seeded, true)
}

function isQueuedReconcileCandidate(message: DecryptedMessage): boolean {
 if (!message.localId || !isQueuedForInvocation(message)) return false
 if (!optimisticMessage(message)) return true
 return message.status === 'queued' || message.status === 'sent'
}

export function getQueuedReconcileCandidateLocalIds(sessionId: string): string[] {
 const localIds = new Set<string>()
 for (const message of getState(sessionId).messages) {
  if (isQueuedReconcileCandidate(message)) {
   localIds.add(message.localId!)
  }
 }
 return [...localIds]
}

export function reconcileQueuedLocalIds(
 sessionId: string,
 candidateLocalIds: string[],
 queuedLocalIds: string[]
): void {
 if (candidateLocalIds.length === 0) return
 const candidates = new Set(candidateLocalIds)
 const queued = new Set(queuedLocalIds)
 updateState(sessionId, (previous) => {
  const messages = previous.messages.filter((message) => {
   if (!message.localId || !candidates.has(message.localId)) return true
   return queued.has(message.localId) || !isQueuedReconcileCandidate(message)
  })
  return messages.length === previous.messages.length
   ? previous
   : buildState(previous, { messages })
 }, true)
}

export function appendOptimisticMessage(sessionId: string, message: DecryptedMessage): void {
 updateState(sessionId, (previous) => {
  return mergeIntoWindow(previous, [message], {
   mode: previous.viewMode === 'history' ? 'prepend' : 'append'
  })
 }, true)
}

export function updateMessageStatus(sessionId: string, localId: string, status: MessageStatus): void {
 if (!localId) return
 updateState(sessionId, (previous) => {
  let changed = false
  const messages = previous.messages.map((message) => {
   if (message.localId !== localId || message.status === status) return message
   changed = true
   return { ...message, status }
  })
  return changed ? buildState(previous, { messages }) : previous
 })
}

export function removeOptimisticMessage(sessionId: string, localId: string): void {
 if (!localId) return
 updateState(sessionId, (previous) => {
  const messages = previous.messages.filter(
   (message) => message.localId !== localId && message.id !== localId
  )
  return messages.length === previous.messages.length
   ? previous
   : buildState(previous, { messages })
 }, true)
}

/** Terminal admission is durable history, never evidence of a native turn. */
export function markMessagesResolved(
 sessionId: string,
 resolutions: Array<{
  localId: string
  resolution: NonNullable<DecryptedMessage['resolution']>
  position?: DecryptedMessage['position']
 }>
): void {
 if (resolutions.length === 0 || !states.has(sessionId)) return
 const byLocalId = new Map(resolutions.map((item) => [item.localId, item]))
 updateState(sessionId, (previous) => {
  let changed = false
  const messages = previous.messages.map((message) => {
   const entry = message.localId ? byLocalId.get(message.localId) : undefined
   if (!entry || message.invokedAt != null) return message
   const needsResolution = !message.resolution
   const needsPosition = Boolean(entry.position && (
    !message.position
    || message.position.at !== entry.position.at
    || message.position.order !== entry.position.order
    || message.position.eventOrder !== entry.position.eventOrder
   ))
   if (!needsResolution && !needsPosition) return message
   changed = true
   return {
    ...message,
    ...(needsResolution ? { resolution: entry.resolution } : {}),
    ...(needsPosition ? { position: entry.position } : {}),
    invokedAt: null,
    status: 'sent' as const
   }
  })
  return changed ? buildState(previous, { messages: mergeMessages([], messages) }) : previous
 }, true)
}

/** Capture account identity across reconnect requests and SSE lifetimes. */
export function captureMessageWindowScope(): () => boolean {
 const scope = storageScope
 const generation = scopeGeneration
 return () => storageScope === scope && scopeGeneration === generation
}

export function markMessagesConsumed(
 sessionId: string,
 localIds: string[],
 invokedAt: number,
 positions?: Array<{ localId: string; position: NonNullable<DecryptedMessage['position']> }>
): void {
 if (localIds.length === 0 && (!positions || positions.length === 0)) return
 const idSet = new Set(localIds)
 const positionByLocalId = new Map(positions?.map((item) => [item.localId, item.position]))
 updateState(sessionId, (previous) => {
  let changed = false
  const updated = previous.messages.map((message) => {
   if (!message.localId || message.resolution) {
    return message
   }
   const position = positionByLocalId.get(message.localId)
   if (!idSet.has(message.localId) && !position) {
    return message
   }
   const needsStatus = message.status !== 'sent'
   const needsInvokedAt = message.invokedAt === null
   const needsPosition = Boolean(position && (
    !message.position
    || message.position.at !== position.at
    || message.position.order !== position.order
    || message.position.eventOrder !== position.eventOrder
   ))
   if (!needsStatus && !needsInvokedAt && !needsPosition) return message
   changed = true
   return {
    ...message,
    ...(needsStatus ? { status: 'sent' as MessageStatus } : {}),
    ...(needsInvokedAt ? { invokedAt } : {}),
    ...(needsPosition ? { position } : {})
   }
  })
  if (!changed) return previous
  return buildState(previous, { messages: mergeMessages([], updated) })
 })
}
