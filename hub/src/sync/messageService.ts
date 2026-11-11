import {
 HAPI_SESSION_EXPORT_SCHEMA_VERSION,
 SESSION_EXPORT_MESSAGE_LIMIT,
 type HapiSessionExportResult
} from '@hapi/protocol/sessionExport'
import type { AttachmentMetadata, DecryptedMessage, OmpInputMode, Session } from '@hapi/protocol/types'
import {
 isClaudeChatVisibleMessage,
 isRedundantGoalStatusEventContent,
 unwrapRoleWrappedRecordEnvelope
} from '@hapi/protocol/messages'
import { isObject } from '@hapi/protocol'
import type { MessageDeliveryMode, MessagesResponse, QueuedStateResponse, ForceSendQueuedResponse, ForceSendResult } from '@hapi/protocol/apiTypes'
import { ForceQueuedMessagesAckSchema, type ForceQueuedMessageAck } from '@hapi/protocol'
import type { Server } from 'socket.io'
import { randomUUID } from 'node:crypto'
import type { Store, CancelQueuedMessageResult } from '../store'
import { EventPublisher } from './eventPublisher'
import { TURN_PAGE_ROW_LIMIT, isInvokedUserTurn, type MessageTurnSegment } from '@hapi/protocol/messageTurns'

type StoredMessageForDelivery = ReturnType<Store['messages']['getMessages']>[number]
type MessagePosition = { at: number; seq: number; order?: number; eventOrder?: number }

const TURN_PAGE_BYTE_BUDGET = 1024 * 1024

/** Bound decoded history as well as row count. Always include one intact row
 * so an individually oversized record cannot stall a continuation cursor. */
function turnPageLength(rows: readonly StoredMessageForDelivery[], fromEnd = false): number {
 let bytes = 0
 let count = 0
 while (count < rows.length && count < TURN_PAGE_ROW_LIMIT) {
  const row = rows[fromEnd ? rows.length - 1 - count : count]
  const size = Buffer.byteLength(JSON.stringify(row))
  if (count > 0 && bytes + size > TURN_PAGE_BYTE_BUDGET) break
  bytes += size
  count++
 }
 return count
}

export class MessageTurnQueryError extends Error {
 constructor(message: string, readonly status: 400 | 404) {
  super(message)
  this.name = 'MessageTurnQueryError'
 }
}

function messagePosition(message: StoredMessageForDelivery, legacyPosition = false): MessagePosition {
 const position = legacyPosition ? undefined : message.position
 return {
  at: position?.at ?? message.invokedAt ?? message.createdAt,
  ...(position?.order || position?.eventOrder ? { order: position.order, eventOrder: position.eventOrder } : {}),
  seq: message.seq
 }
}

function comparePosition(a: MessagePosition, b: MessagePosition): number {
 return a.at - b.at || (a.order ?? 0) - (b.order ?? 0) || (a.eventOrder ?? 0) - (b.eventOrder ?? 0) || a.seq - b.seq
}

function pageOrderFields(prefix: 'nextBefore' | 'nextAfter' | 'snapshotHead', position?: MessagePosition | null) {
 return position?.order || position?.eventOrder
  ? { [`${prefix}Order`]: position.order ?? 0, [`${prefix}EventOrder`]: position.eventOrder ?? 0 }
  : {}
}
function isWebVisibleStoredMessage(message: StoredMessageForDelivery): boolean {
 return !isRedundantGoalStatusEventContent(message.content)
}

function toDecryptedMessage(message: StoredMessageForDelivery, legacyPosition = false): DecryptedMessage {
 return {
  id: message.id,
  seq: message.seq,
  localId: message.localId,
  content: message.content,
  createdAt: message.createdAt,
  invokedAt: message.invokedAt,
  scheduledAt: message.scheduledAt,
  ...(!legacyPosition && message.position ? { position: message.position } : {}),
  ...(message.resolution ? { resolution: message.resolution } : {})
 }
}

function toVisibleDecryptedMessages(messages: StoredMessageForDelivery[], legacyPosition = false): DecryptedMessage[] {
 return messages.filter(isWebVisibleStoredMessage).map((message) => toDecryptedMessage(message, legacyPosition))
}

function isQueuedUserMessage(message: StoredMessageForDelivery): boolean {
 const record = unwrapRoleWrappedRecordEnvelope(message.content)
 return record?.role === 'user' && message.invokedAt === null && !message.resolution
}

function isExportVisibleStoredMessage(message: StoredMessageForDelivery): boolean {
 if (!isWebVisibleStoredMessage(message) || isQueuedUserMessage(message)) {
  return false
 }

 const record = unwrapRoleWrappedRecordEnvelope(message.content)
 if (record?.role !== 'agent') {
  return true
 }

 if (!isObject(record.content) || record.content.type !== 'output') {
  return true
 }

 const data = isObject(record.content.data) ? record.content.data : null
 if (!data) {
  return true
 }

 if (Boolean(data.isMeta) || Boolean(data.isCompactSummary)) {
  return false
 }

 return isClaudeChatVisibleMessage({ type: data.type, subtype: data.subtype })
}

function extractExportAgentData(message: StoredMessageForDelivery): Record<string, unknown> | null {
 const record = unwrapRoleWrappedRecordEnvelope(message.content)
 if (record?.role !== 'agent' || !isObject(record.content)) return null
 if (record.content.type !== 'codex' || !isObject(record.content.data)) return null
 return record.content.data
}

function collapseSupersededExportMessages(messages: StoredMessageForDelivery[]): StoredMessageForDelivery[] {
 const lastAgentRunUpdateIndexByCard = new Map<string, number>()
 for (let index = 0; index < messages.length; index += 1) {
  const data = extractExportAgentData(messages[index])
  if (!data || data.type !== 'agent-run-update') continue
  const cardKey = typeof data.cardId === 'string' && data.cardId
   ? data.cardId
   : typeof data.agentId === 'string' && data.agentId
    ? data.agentId
    : null
  if (cardKey) {
   lastAgentRunUpdateIndexByCard.set(cardKey, index)
  }
 }

 const seenInProgressToolCallIds = new Set<string>()
 const collapsed: StoredMessageForDelivery[] = []
 for (let index = 0; index < messages.length; index += 1) {
  const message = messages[index]
  const data = extractExportAgentData(message)
  if (data?.type === 'agent-run-update') {
   const cardKey = typeof data.cardId === 'string' && data.cardId
    ? data.cardId
    : typeof data.agentId === 'string' && data.agentId
     ? data.agentId
     : null
   const status = typeof data.status === 'string' ? data.status : 'running'
   const lastIndex = cardKey ? lastAgentRunUpdateIndexByCard.get(cardKey) : undefined
   if (
    lastIndex !== undefined
    && index < lastIndex
    && (status === 'running' || status === 'pending')
   ) {
    continue
   }
  } else if (data?.type === 'tool-call' && typeof data.callId === 'string' && data.callId) {
   const status = typeof data.status === 'string' ? data.status : 'in_progress'
   if (status === 'in_progress' || status === 'pending') {
    if (seenInProgressToolCallIds.has(data.callId) && data.progress === undefined) {
     continue
    }
    seenInProgressToolCallIds.add(data.callId)
   } else if (
    (status === 'completed' || status === 'failed')
    && seenInProgressToolCallIds.delete(data.callId)
    && data.progress === undefined
   ) {
    continue
   }
  }
  collapsed.push(message)
 }
 return collapsed
}

function getNormalizedDeliveryMode(
 metadata: unknown,
 requestedDeliveryMode: MessageDeliveryMode | undefined,
 scheduledAt: number | null | undefined
): MessageDeliveryMode {
 if (requestedDeliveryMode !== 'steer' || scheduledAt != null) {
  return 'queue'
 }

 return isObject(metadata) && metadata.flavor === 'pi' ? 'steer' : 'queue'
}

/**
 * Native steer is scoped to the Pi turn active at the initial live emit. Once
 * a durable row is delivered through reconnect, backfill, a clear gate, or a
 * scheduled scan, that turn identity is no longer provable. Preserve stored
 * provenance for Web diagnostics, but make deferred CLI delivery an ordinary
 * queue item so it cannot steer a later generation.
 */
function contentForDeferredDelivery(content: unknown): unknown {
 if (!isObject(content) || content.role !== 'user' || !isObject(content.meta)) {
  return content
 }
 if (content.meta.deliveryMode !== 'steer') return content
 return {
  ...content,
  meta: {
   ...content.meta,
   deliveryMode: 'queue' as const
  }
 }
}

export class MessageService {
 /** One scheduled-matured SSE per localId per hub process (cleared on cancel/consume paths here). */
 private readonly scheduledMatureNotifiedLocalIds = new Set<string>()

 constructor(
  private readonly store: Store,
  private readonly io: Server,
  private readonly publisher: EventPublisher,
  private readonly onSessionActivity?: (sessionId: string, updatedAt: number) => void,
  private readonly decorateForCli: (
   content: unknown,
   sessionContext?: { host?: string | null; path?: string | null; machineId?: string | null }
  ) => unknown = content => content,
  private readonly canDeliverToSession?: (sessionId: string) => boolean
 ) {
 }

 private getCliDecorationContext(
  sessionId: string
 ): { host?: string | null; path?: string | null; machineId?: string | null } | undefined {
  const stored = this.store.sessions.getSession(sessionId)
  const metadata = isObject(stored?.metadata) ? stored.metadata : null
  const host = typeof metadata?.host === 'string' && metadata.host.trim() ? metadata.host.trim() : null
  const path = typeof metadata?.path === 'string' && metadata.path.trim() ? metadata.path.trim() : null
  const machineId = typeof metadata?.machineId === 'string' && metadata.machineId.trim()
   ? metadata.machineId.trim()
   : typeof stored?.machineId === 'string' && stored.machineId.trim()
    ? stored.machineId.trim()
    : null
  if (!host && !path && !machineId) return undefined
  return { host, path, machineId }
 }

 private forgetScheduledMatureNotified(localIds: Iterable<string>): void {
  for (const localId of localIds) {
   this.scheduledMatureNotifiedLocalIds.delete(localId)
  }
 }

 clearResolvedDeliveryBookkeeping(localIds: Iterable<string>): void {
  this.forgetScheduledMatureNotified(localIds)
 }

 getMessages(sessionId: string, limit: number = 200): DecryptedMessage[] {
  const stored = this.store.messages.getMessages(sessionId, limit)
  return toVisibleDecryptedMessages(stored)
 }

 getQueuedState(sessionId: string, localIds: string[]): QueuedStateResponse {
  const states = this.store.messages.getLocalMessageStates(sessionId, localIds)
  const resolvedLocalMessages = states.flatMap((state) => state.resolution
   ? [{ localId: state.localId, resolution: state.resolution, ...(state.position ? { position: state.position } : {}) }] : [])
  return {
   queuedLocalIds: states
    .filter((state) => state.invokedAt === null && !state.resolution)
    .map((state) => state.localId),
   invokedLocalMessages: states.flatMap((state) => state.invokedAt === null
    ? []
    : [{ localId: state.localId, invokedAt: state.invokedAt, ...(state.position ? { position: state.position } : {}) }]),
   ...(resolvedLocalMessages.length ? { resolvedLocalMessages } : {})
  }
 }

 getSessionExport(
  sessionId: string,
  session: Session,
  options: number | { limit?: number; offset?: number } = SESSION_EXPORT_MESSAGE_LIMIT
 ): HapiSessionExportResult {
  const isPaged = typeof options === 'object' && options !== null
  const limit = typeof options === 'number'
   ? options
   : options.limit ?? SESSION_EXPORT_MESSAGE_LIMIT
  const offset = isPaged ? Math.max(0, options.offset ?? 0) : 0

  const sorted = collapseSupersededExportMessages(
   this.store.messages.getAllMessages(sessionId)
    .filter(isExportVisibleStoredMessage)
    .sort((a, b) => comparePosition(messagePosition(a), messagePosition(b)))
  )

  if (!isPaged && sorted.length > limit) {
   return {
    type: 'too-large',
    count: sorted.length,
    limit
   }
  }

  const messages = (isPaged ? sorted.slice(offset, offset + limit) : sorted)
   .map(message => toDecryptedMessage(message))
  // Chronological ASC for archive readability (store list is DESC).
  const scratchlist = this.store.scratchlist.list(sessionId)
   .slice()
   .sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt
    return a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0
   })
   .map((row) => ({
    entryId: row.entryId,
    text: row.text,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    attachments: row.attachments
   }))

  return {
   type: 'success',
   payload: {
    schemaVersion: HAPI_SESSION_EXPORT_SCHEMA_VERSION,
    exportedAt: Date.now(),
    session,
    messages,
    scratchlist
   }
  }
 }

 prepareTurnIndex(sessionId: string): Promise<void> {
  return this.store.messages.prepareTurnIndex(sessionId)
 }

 getMessagesPage(
  sessionId: string,
  options: {
   limit: number
   turns?: number
   turnId?: string
   before?: MessagePosition | null
   after?: MessagePosition | null
   until?: MessagePosition | null
   epoch?: number | null
   orderVersion?: number | null
  }
 ): MessagesResponse {
  const epoch = this.store.messages.getMessageEpoch(sessionId)
  const legacyPosition = options.orderVersion !== 1 && options.turns === undefined && options.turnId === undefined
  if (options.turnId !== undefined) {
   this.store.messages.requireTurnIndex(sessionId)
   return this.getSelectedTurnMessagesPage(sessionId, { ...options, turnId: options.turnId }, epoch)
  }
  if (options.turns !== undefined) {
   this.store.messages.requireTurnIndex(sessionId)
   const reset = options.epoch != null && options.epoch !== epoch
   return this.getTurnMessagesPage(sessionId, {
    ...options,
    turns: Math.max(1, Math.min(20, options.turns)),
    before: reset ? null : options.before,
    after: reset ? null : options.after,
    until: reset ? null : options.until
   }, epoch, reset)
  }
  if (options.after) {
   if (options.epoch !== undefined && options.epoch !== null && options.epoch !== epoch) {
    return this.getLatestOrBeforeMessagesPage(sessionId, options.limit, null, epoch, true, legacyPosition)
   }
   return this.getAfterMessagesPage(
    sessionId,
    options.limit,
    options.after,
    options.until ?? null,
    epoch,
    legacyPosition
   )
  }
  return this.getLatestOrBeforeMessagesPage(
   sessionId,
   options.limit,
   options.before ?? null,
   epoch,
   false,
   legacyPosition
  )
 }

 private getSelectedTurnMessagesPage(sessionId: string, options: {
  limit: number
  turnId: string
  after?: MessagePosition | null
  until?: MessagePosition | null
  epoch?: number | null
 }, epoch: number): MessagesResponse {
  const query = this.store.messages
  const bounds = query.getSelectedTurnBounds(sessionId, options.turnId)
  if (!bounds) throw new MessageTurnQueryError('Invoked user turn not found in this session', 404)
  const reset = options.epoch != null && options.epoch !== epoch
  const after = reset ? null : options.after
  const until = reset ? null : options.until
  if (after && (comparePosition(after, bounds.start) < 0
   || (bounds.next && comparePosition(after, bounds.next) >= 0))) {
   throw new MessageTurnQueryError('Cursor is outside the selected turn', 400)
  }
  if (until && comparePosition(until, bounds.start) < 0) {
   throw new MessageTurnQueryError('Snapshot is before the selected turn', 400)
  }
  const head = query.getTurnHistoryRows(sessionId, {
   from: bounds.start, before: bounds.next, until, limit: 1, descending: true
  })[0]
  const snapshotHead = head ? messagePosition(head) : bounds.start
  const found = query.getTurnHistoryRows(sessionId, {
   from: bounds.start, before: bounds.next, after, until: snapshotHead,
   limit: TURN_PAGE_ROW_LIMIT + 1, descending: false
  })
  const count = turnPageLength(found)
  const hasMoreAfter = found.length > count
  const rows = hasMoreAfter ? found.slice(0, count) : found
  const first = rows[0]
  const last = rows.at(-1)
  return {
   messages: toVisibleDecryptedMessages(rows),
   page: {
    direction: after ? 'after' : 'latest', limit: options.limit, epoch, reset,
    nextBeforeAt: first ? messagePosition(first).at : null,
    nextBeforeSeq: first?.seq ?? null,
    ...pageOrderFields('nextBefore', first ? messagePosition(first) : null),
    nextAfterAt: last ? messagePosition(last).at : after?.at ?? null,
    nextAfterSeq: last?.seq ?? after?.seq ?? null,
    ...pageOrderFields('nextAfter', last ? messagePosition(last) : after),
    snapshotHeadAt: snapshotHead.at, snapshotHeadSeq: snapshotHead.seq,
    ...pageOrderFields('snapshotHead', snapshotHead),
    hasMore: hasMoreAfter, hasMoreAfter,
    turns: {
     requested: 1, rowLimit: TURN_PAGE_ROW_LIMIT, segments: first && last ? [{
      turnId: bounds.start.id, from: messagePosition(first), to: messagePosition(last),
      completeBefore: first.id === bounds.start.id, completeAfter: !hasMoreAfter
     }] : []
    }
   }
  }
 }

 private getTurnMessagesPage(sessionId: string, options: {
  limit: number
  turns: number
  before?: MessagePosition | null
  after?: MessagePosition | null
  until?: MessagePosition | null
 }, epoch: number, reset: boolean): MessagesResponse {
  const query = this.store.messages
  const headRow = query.getTurnHistoryRows(sessionId, { limit: 1, descending: true })[0]
  const currentHead = headRow ? messagePosition(headRow) : null
  const snapshotHead = currentHead && options.after && options.until
   && comparePosition(options.until, currentHead) < 0 ? options.until : currentHead
  const direction = options.after ? 'after' : options.before ? 'before' : 'latest'
  let rows: StoredMessageForDelivery[]
  if (options.after) {
   rows = query.getTurnHistoryRows(sessionId, {
    after: options.after, until: snapshotHead, limit: TURN_PAGE_ROW_LIMIT + 1, descending: false
   })
   let count = 0
   let end = turnPageLength(rows)
   for (let i = 0; i < end; i++) {
    if (i === 0 || isInvokedUserTurn(rows[i])) count++
    if (count > options.turns) { end = i; break }
   }
   // When several ordinary turns exceed the page budget, stop before the
   // final turn rather than splitting it. Only a turn too large to fit by
   // itself uses the explicit continuation contract.
   if (rows.length > end && !isInvokedUserTurn(rows[end])) {
    for (let index = end - 1; index > 0; index--) {
     if (isInvokedUserTurn(rows[index])) { end = index; break }
    }
   }
   rows = rows.slice(0, end)
  } else {
   const edge = options.before ?? snapshotHead
   const starts = edge ? query.getTurnStartsBefore(sessionId, edge, options.turns,
    !options.before) : []
   const from = starts.length === options.turns ? starts.at(-1) : null
   rows = query.getTurnHistoryRows(sessionId, {
    before: options.before, from, until: snapshotHead,
    limit: TURN_PAGE_ROW_LIMIT, descending: true
   })
   const count = turnPageLength(rows, true)
   const bounded = count < rows.length || rows.length === TURN_PAGE_ROW_LIMIT
   if (count < rows.length) rows = rows.slice(rows.length - count)
   if (bounded && !isInvokedUserTurn(rows[0])) {
    const firstBoundary = rows.findIndex(isInvokedUserTurn)
    if (firstBoundary > 0) rows = rows.slice(firstBoundary)
   }
  }
  const first = rows[0]
  const last = rows.at(-1)
  const beforeRow = first ? query.getTurnHistoryRows(sessionId, {
   before: messagePosition(first), limit: 1, descending: true
  })[0] : undefined
  const afterRow = last ? query.getTurnHistoryRows(sessionId, {
   after: messagePosition(last), limit: 1, descending: false
  })[0] : undefined
  const segments: MessageTurnSegment[] = []
  if (first && last) {
   const owner = query.getTurnStartsBefore(sessionId, messagePosition(first), 1, true)[0]
   let segment: MessageTurnSegment = {
    turnId: owner?.id ?? null,
    from: messagePosition(first), to: messagePosition(first),
    completeBefore: owner ? owner.id === first.id : !beforeRow,
    completeAfter: false
   }
   for (let i = 1; i < rows.length; i++) {
    const row = rows[i]
    if (isInvokedUserTurn(row)) {
     segment.completeAfter = true
     segments.push(segment)
     segment = {
      turnId: row.id, from: messagePosition(row), to: messagePosition(row),
      completeBefore: true, completeAfter: false
     }
    } else {
     segment.to = messagePosition(row)
    }
   }
   segment.completeAfter = !afterRow || isInvokedUserTurn(afterRow)
   segments.push(segment)
  }
  const queued = direction === 'latest' ? query.getUninvokedLocalMessages(sessionId) : []
  return {
   messages: toVisibleDecryptedMessages([...rows, ...queued].sort((a, b) =>
    comparePosition(messagePosition(a), messagePosition(b)))),
   page: {
    direction, limit: options.limit, epoch, reset,
    nextBeforeAt: first ? messagePosition(first).at : null,
    nextBeforeSeq: first?.seq ?? null,
    ...pageOrderFields('nextBefore', first ? messagePosition(first) : null),
    nextAfterAt: last ? messagePosition(last).at : options.after?.at ?? null,
    nextAfterSeq: last?.seq ?? options.after?.seq ?? null,
    ...pageOrderFields('nextAfter', last ? messagePosition(last) : options.after),
    snapshotHeadAt: snapshotHead?.at ?? null,
    snapshotHeadSeq: snapshotHead?.seq ?? null,
    ...pageOrderFields('snapshotHead', snapshotHead),
    hasMore: direction === 'after'
     ? Boolean(afterRow && snapshotHead && comparePosition(messagePosition(afterRow), snapshotHead) <= 0)
     : Boolean(beforeRow),
    turns: { requested: options.turns, rowLimit: TURN_PAGE_ROW_LIMIT, segments }
   }
  }
 }

 private getLatestOrBeforeMessagesPage(
  sessionId: string,
  limit: number,
  requestedBefore: MessagePosition | null,
  epoch: number,
  reset: boolean,
  legacyPosition = false
 ): MessagesResponse {
  const direction = requestedBefore ? 'before' as const : 'latest' as const
  const snapshotHead = this.store.messages.getNewestMessagePosition(sessionId, legacyPosition)
  let before = requestedBefore ?? undefined
  let pageRows = this.store.messages.getMessagesByPosition(sessionId, limit, requestedBefore ?? undefined, legacyPosition)

  // Latest-page request (no cursor): also include uninvoked local user messages
  // out-of-band, so refresh / secondary clients can still see queued rows even
  // when their position key (createdAt) places them outside the latest page.
  // The cursor stays anchored to pageRows so out-of-band rows don't affect
  // pagination of older pages.
  let queuedRows = requestedBefore === null
   ? this.store.messages.getUninvokedLocalMessages(sessionId)
   : []

  let byId = new Map<string, typeof pageRows[number]>()
  for (const row of pageRows) byId.set(row.id, row)
  for (const row of queuedRows) byId.set(row.id, row)

  let stored = [...byId.values()].sort((a, b) => comparePosition(messagePosition(a, legacyPosition), messagePosition(b, legacyPosition)))

  let messages = toVisibleDecryptedMessages(stored, legacyPosition)

  // The cursor is the oldest row in the actual position-ordered page (pageRows[0]).
  // Out-of-band queued rows are not part of the cursor — they are pinned to
  // every latest-page response.
  let oldest = pageRows[0] ?? null
  let oldestSeq: number | null = oldest?.seq ?? null
  let oldestPositionAt: number | null = oldest
   ? messagePosition(oldest, legacyPosition).at
   : null

  let hasMore = oldestSeq !== null && oldestPositionAt !== null
   && this.store.messages.getMessagesByPosition(
    sessionId,
    1,
    messagePosition(oldest!, legacyPosition),
    legacyPosition
   ).length > 0

  while (messages.length === 0 && hasMore && oldestSeq !== null && oldestPositionAt !== null) {
   before = messagePosition(oldest!, legacyPosition)
   pageRows = this.store.messages.getMessagesByPosition(sessionId, limit, before, legacyPosition)
   queuedRows = []

   byId = new Map<string, typeof pageRows[number]>()
   for (const row of pageRows) byId.set(row.id, row)
   for (const row of queuedRows) byId.set(row.id, row)

   stored = [...byId.values()].sort((a, b) => comparePosition(messagePosition(a, legacyPosition), messagePosition(b, legacyPosition)))
   messages = toVisibleDecryptedMessages(stored, legacyPosition)

   oldest = pageRows[0] ?? null
   oldestSeq = oldest?.seq ?? null
   oldestPositionAt = oldest
    ? messagePosition(oldest, legacyPosition).at
    : null
   hasMore = oldestSeq !== null && oldestPositionAt !== null
    && this.store.messages.getMessagesByPosition(
     sessionId,
     1,
     messagePosition(oldest!, legacyPosition),
     legacyPosition
    ).length > 0
  }

  return {
   messages,
   page: {
    direction,
    limit,
    epoch,
    reset,
    nextBeforeSeq: oldestSeq,
    nextBeforeAt: oldestPositionAt,
    ...pageOrderFields('nextBefore', oldest ? messagePosition(oldest, legacyPosition) : null),
    nextAfterSeq: null,
    nextAfterAt: null,
    snapshotHeadSeq: snapshotHead?.seq ?? null,
    snapshotHeadAt: snapshotHead?.at ?? null,
    ...pageOrderFields('snapshotHead', snapshotHead),
    hasMore
   }
  }
 }

 private getAfterMessagesPage(
  sessionId: string,
  limit: number,
  after: MessagePosition,
  requestedUntil: MessagePosition | null,
  epoch: number,
  legacyPosition = false
 ): MessagesResponse {
  const currentHead = this.store.messages.getNewestMessagePosition(sessionId, legacyPosition)
  const snapshotHead = currentHead && requestedUntil
   ? (comparePosition(requestedUntil, currentHead) <= 0 ? requestedUntil : currentHead)
   : requestedUntil ?? currentHead

  if (!snapshotHead || comparePosition(snapshotHead, after) <= 0) {
   return {
    messages: [],
    page: {
     direction: 'after',
     limit,
     epoch,
     reset: false,
     nextBeforeSeq: null,
     nextBeforeAt: null,
     nextAfterSeq: after.seq,
     nextAfterAt: after.at,
     ...pageOrderFields('nextAfter', legacyPosition ? { at: after.at, seq: after.seq } : after),
     snapshotHeadSeq: snapshotHead?.seq ?? null,
     snapshotHeadAt: snapshotHead?.at ?? null,
     ...pageOrderFields('snapshotHead', snapshotHead),
     hasMore: false
    }
   }
  }

  const pageRows = this.store.messages.getMessagesAfterPosition(
   sessionId,
   limit,
   after,
   snapshotHead,
   legacyPosition
  )
  const last = pageRows[pageRows.length - 1] ?? null
  const nextAfter = last ? messagePosition(last, legacyPosition) : snapshotHead
  const hasMore = last !== null && comparePosition(nextAfter, snapshotHead) < 0

  return {
   messages: toVisibleDecryptedMessages(pageRows, legacyPosition),
   page: {
    direction: 'after',
    limit,
    epoch,
    reset: false,
    nextBeforeSeq: null,
    nextBeforeAt: null,
    nextAfterSeq: nextAfter.seq,
    nextAfterAt: nextAfter.at,
    ...pageOrderFields('nextAfter', nextAfter),
    snapshotHeadSeq: snapshotHead.seq,
    snapshotHeadAt: snapshotHead.at,
    ...pageOrderFields('snapshotHead', snapshotHead),
    hasMore
   }
  }
 }

 /** CLI reconnect backfill — excludes future-scheduled rows so the runner does
  *  not consume them ahead of their scheduled_at.  See messages.ts:getDeliverableMessagesAfter. */
 getDeliverableMessagesAfter(sessionId: string, options: { afterSeq: number; limit: number; now: number }): DecryptedMessage[] {
  const stored = this.store.messages.getDeliverableMessagesAfter(
   sessionId,
   options.afterSeq,
   options.now,
   options.limit
  )
  const deliverable = this.canDeliverToSession?.(sessionId) === false
   ? stored.filter(message => !isQueuedUserMessage(message))
   : stored
  const decorationContext = this.getCliDecorationContext(sessionId)
  return deliverable.map((message) => ({
   id: message.id,
   seq: message.seq,
   localId: message.localId,
   content: this.decorateForCli(contentForDeferredDelivery(message.content), decorationContext),
   createdAt: message.createdAt,
   invokedAt: message.invokedAt,
   scheduledAt: message.scheduledAt
  }))
 }

 async cancelQueuedMessage(
  sessionId: string,
  messageId: string
 ): Promise<CancelQueuedMessageResult> {
  // Phase 1: look up the row WITHOUT deleting it.
  // This lets us ask the CLI first and only DELETE if the CLI confirms removal.
  const lookup = this.store.messages.lookupQueuedMessage(sessionId, messageId)

  if (lookup.status === 'absent') {
   // Row not found — already cancelled or wrong id.
   return { status: 'cancelled', localId: null }
  }

  if (lookup.status === 'invoked' || lookup.status === 'resolved') {
   // DB row already has invoked_at — CLI consumed it before we arrived.
   // Return the full invoked row so the web client can restore authoritative
   // state (with correct invokedAt) instead of a stale queued snapshot.
   return lookup
  }

  // Phase 2: row is still queued.  Ask the CLI whether it already shifted the item
  // (race window between collectBatch() shift and messages-consumed ack).
  const { localId, resolvedId, scheduledAt } = lookup

  if (!localId) {
   // No localId — row exists but has no cancel path; treat as cancelled.
   this.store.messages.deleteQueuedMessageById(sessionId, resolvedId)
   this.publisher.emit({ type: 'message-cancelled', sessionId, messageId })
   return { status: 'cancelled', localId: null }
  }

  // Phase 2b: future-scheduled messages were never emitted to the CLI, so they
  // are not in the CLI's in-memory queue.  Asking the CLI whether it can remove
  // the item would always return 'not-found', which the normal ack path
  // misinterprets as "CLI already consumed it" and stamps invoked_at.
  // Short-circuit: delete the row directly without a CLI ack round-trip.
  //
  // Single event loop turn: the scheduledAt > now check and the
  // deleteQueuedMessageById call execute atomically with no await between
  // them, so the offline-CLI path's re-check pattern is unnecessary here.
  // The offline path needs the re-check because it awaits the
  // markInvoked between the lookup and the delete.
  const now = Date.now()
  if (scheduledAt !== null && scheduledAt > now) {
   this.store.messages.deleteQueuedMessageById(sessionId, resolvedId)
   this.forgetScheduledMatureNotified([localId])
   this.publisher.emit({
    type: 'message-cancelled',
    sessionId,
    messageId,
    localId,
   })
   return { status: 'cancelled', localId }
  }

  // Phase 2a: if no CLI socket is currently in the session room, the CLI is
  // offline and there is nobody to ack with.  Delete the row immediately so a
  // later CLI reconnect cannot pick it up via seq-backfill and re-enqueue the
  // cancelled message.
  //
  // TOCTOU note: deleteQueuedMessageById already has an invoked_at IS NULL guard,
  // so if a CLI socket joins between the cliCount read and the DELETE and wins the
  // race by calling markMessagesInvoked first, the DELETE becomes a no-op.
  // We re-read the row after the delete to detect that case and handle it exactly
  // like Race-B (ack returned removed:false).
  const roomName = `session:${sessionId}`
  const cliCount = this.io.of('/cli').adapter.rooms.get(roomName)?.size ?? 0
  if (cliCount === 0) {
   this.store.messages.deleteQueuedMessageById(sessionId, resolvedId)
   // Re-check: if CLI joined and invoked the message between our cliCount read
   // and the DELETE, the delete was a no-op and the row now has invoked_at set.
   const recheck = this.store.messages.lookupQueuedMessage(sessionId, resolvedId)
   if (recheck.status === 'resolved') return recheck
   if (recheck.status === 'invoked') {
    // CLI beat us — treat identically to Race-B (ack returned not-found).
    this.forgetScheduledMatureNotified([localId])
    this.publisher.emit({
     type: 'messages-consumed',
     sessionId,
     localIds: [localId],
     invokedAt: recheck.message.invokedAt!,
    })
    return recheck
   }
   // Row is gone (absent) — clean cancel.
   this.forgetScheduledMatureNotified([localId])
   this.publisher.emit({
    type: 'message-cancelled',
    sessionId,
    messageId,
    localId,
   })
   return { status: 'cancelled', localId }
  }

  const ackResult = await this.requestCliCancelAck(sessionId, localId, messageId, 500)
  // A terminal native receipt can win while the cancellation acknowledgement is in flight.
  const afterAck = this.store.messages.lookupQueuedMessage(sessionId, resolvedId)
  if (afterAck.status === 'resolved') {
   this.forgetScheduledMatureNotified([localId])
   return afterAck
  }

  if (ackResult === 'not-found' || ackResult === 'timeout') {
   const metadata = this.store.sessions.getSession(sessionId)?.metadata
   if (isObject(metadata) && metadata.flavor === 'omp') {
    if (afterAck.status === 'invoked') return afterAck
    if (afterAck.status === 'absent') return { status: 'cancelled', localId }
    return { status: 'unconfirmed', message: afterAck.message }
   }
   // CLI could not remove the item — it was already shift()-ed or CLI is
   // offline.  Stamp invoked_at immediately so the message lands in the thread
   // as 'sent' instead of disappearing.  The agent's later assistant message
   // (if it produced one) joins the same thread normally.
   const invokedAt = Date.now()
   try {
    this.store.messages.markMessagesInvoked(sessionId, [localId], invokedAt)
   } catch (err) {
    console.error('cancelQueuedMessage: markMessagesInvoked failed', err)
    // DB write failed — let the HTTP 500 surface to the caller.
    throw err
   }
   this.forgetScheduledMatureNotified([localId])
   // Notify all SSE subscribers (other open tabs) that this queued row is now
   // invoked so they remove it from the floating bar.  Without this emit, only
   // the tab that sent the DELETE request learns about the status change via the
   // HTTP response; every other subscriber keeps the row in the queued bar until
   // a refresh or a later event.  Mirrors the identical publish in the normal
   // CLI-driven path (sessionHandlers.ts messages-consumed handler).
   this.publisher.emit({
    type: 'messages-consumed',
    sessionId,
    localIds: [localId],
    invokedAt,
   })
   // Re-fetch the single row via lookupQueuedMessage to avoid the 200-row
   // pagination cap of getMessages.  After markMessagesInvoked the row will
   // have invoked_at set, so lookupQueuedMessage returns status='invoked'.
   const recheck = this.store.messages.lookupQueuedMessage(sessionId, localId)
   if (recheck.status === 'invoked') {
    return recheck
   }
   // Row absent from DB after markMessagesInvoked — edge case, treat as cancelled
   return { status: 'cancelled', localId }
  }

  // Phase 3: CLI confirmed removal.  Now DELETE the DB row and broadcast SSE.
  this.store.messages.deleteQueuedMessageById(sessionId, resolvedId)
  this.forgetScheduledMatureNotified([localId])
  this.publisher.emit({
   type: 'message-cancelled',
   sessionId,
   messageId
  })

  return { status: 'cancelled', localId }
 }

 /**
  * Ask the CLI (via socket.io ack) whether it removed the in-memory queue item.
  * Returns 'removed', 'not-found', or 'timeout'.
  *
  * Re-uses the existing 'update' event channel with a cancel-queued-message body,
  * matching the ack pattern already used by rpcGateway
  * (socket.timeout(ms).emitWithAck / BroadcastOperator.timeout(ms).emit + ack cb).
  */
 private requestCliCancelAck(
  sessionId: string,
  localId: string,
  messageId: string,
  timeoutMs: number
 ): Promise<'removed' | 'not-found' | 'timeout'> {
  return new Promise((resolve) => {
   const room = this.io.of('/cli').to(`session:${sessionId}`)
   // socket.io v4 BroadcastOperator: .timeout(ms).emit(event, data, ackCb)
   // ack signature: (err: Error | null, responses: T[])
   room.timeout(timeoutMs).emit(
    'update',
    {
     id: randomUUID(),
     seq: 0,
     createdAt: Date.now(),
     body: {
      t: 'cancel-queued-message' as const,
      sid: sessionId,
      messageId,
      localId
     }
    },
    (err: Error | null, responses: Array<{ removed: boolean }>) => {
     // Check responses before err: in a reconnect overlap or any room with
     // multiple CLI sockets, Socket.IO may set err (one socket timed out)
     // while still delivering successful responses from the sockets that did
     // ack. Any confirmed removal wins over the partial timeout.
     const removed = responses?.some((r) => r.removed === true) ?? false
     if (removed) {
      resolve('removed')
      return
     }
     if (err) {
      resolve('timeout')
      return
     }
     resolve('not-found')
    }
   )
  })
 }

 async sendMessage(
  sessionId: string,
  payload: {
   text: string
   localId?: string | null
   attachments?: AttachmentMetadata[]
   ompInputMode?: OmpInputMode
   sentFrom?: 'telegram-bot' | 'webapp'
   scheduledAt?: number | null
   deliveryMetadata?: Record<string, unknown>
   deliveryMode?: MessageDeliveryMode
  }
 ): Promise<{ actualSessionId: string; createdAt: number }> {
  // Defence-in-depth invariant for non-REST callers (Telegram bot, MCP,
  // internal callers).  Attachment paths live under the CLI session's
  // upload directory which `cleanupUploadDir` purges on session end; a
  // mature scheduled emit after the CLI exits would dereference deleted
  // files via the @path attachment formatter.  REST already rejects this
  // combination at the Zod layer, but enforcing it here keeps the rule in
  // one structural place — same pattern as `addMessage`'s scheduledAt +
  // !localId throw.
  if (payload.scheduledAt != null && (payload.attachments?.length ?? 0) > 0) {
   throw new Error('sendMessage: scheduled messages with attachments are not supported')
  }

  const sentFrom = payload.sentFrom ?? 'webapp'
  const deliveryMode = getNormalizedDeliveryMode(
   this.store.sessions.getSession(sessionId)?.metadata,
   payload.deliveryMode,
   payload.scheduledAt
  )

  const content = {
   role: 'user',
   content: {
    type: 'text',
    text: payload.text,
    attachments: payload.attachments
   },
   meta: {
    sentFrom,
    ...payload.deliveryMetadata,
    ...(payload.ompInputMode ? { ompInputMode: payload.ompInputMode } : {}),
    deliveryMode
   }
  }

  const inserted = this.store.addMessageForCurrentSession(
   sessionId,
   content,
   payload.localId ?? undefined,
   payload.scheduledAt ?? null
  )
  const actualSessionId = inserted.sessionId
  const msg = inserted.message
  // A duplicate localId is an idempotent retry, not proof that the
  // original Pi turn still exists. Its stored row may retain steer
  // provenance from a POST whose response was lost, so deliver the
  // duplicate through the same turn-safe deferred view as reconnect.
  const cliContent = inserted.inserted
   ? msg.content
   : contentForDeferredDelivery(msg.content)
  this.onSessionActivity?.(actualSessionId, msg.createdAt)

  // Only emit to CLI if the message is not scheduled for the future.
  // Mature or non-scheduled messages go through immediately; future scheduled
  // messages wait for the 5-second tick in releaseMatureScheduledMessages.
  // Re-measure Date.now() after addMessage to avoid a TOCTOU window where
  // the pre-insert `now` capture could misclassify a borderline scheduledAt
  // as future when it has already become past by the time we check.
  const isFutureScheduled = msg.scheduledAt !== null && msg.scheduledAt > Date.now()
  if (!msg.resolution && !isFutureScheduled && this.canDeliverToSession?.(actualSessionId) !== false && !this.store.isOpenCodeClearDeliveryGated(actualSessionId)) {
   const update = {
    id: msg.id,
    seq: msg.seq,
    createdAt: msg.createdAt,
    body: {
     t: 'new-message' as const,
     sid: actualSessionId,
     message: {
      id: msg.id,
      seq: msg.seq,
      createdAt: msg.createdAt,
      localId: msg.localId,
      content: this.decorateForCli(cliContent, this.getCliDecorationContext(actualSessionId))
     }
    }
   }
   this.io.of('/cli').to(`session:${actualSessionId}`).emit('update', update)
  }

  // Always emit message-received to Web SSE so the floating bar renders.
  this.publisher.emit({
   type: 'message-received',
   sessionId: actualSessionId,
   message: {
    id: msg.id,
    seq: msg.seq,
    localId: msg.localId,
    content: msg.content,
    createdAt: msg.createdAt,
    invokedAt: msg.invokedAt,
    scheduledAt: msg.scheduledAt,
    ...(msg.resolution ? { resolution: msg.resolution } : {})
   }
  })
  return { actualSessionId, createdAt: msg.createdAt }
 }

 /** Emit one queued row to its CLI session room as a 'new-message' update.
  *  `decorate` matches the caller context: replay/backfill rows are already
  *  normalized by contentForDeferredDelivery (un-decorated), while mature-scan
  *  and sendMessage rows carry the live decoration. */
 private emitQueuedRowToCli(msg: StoredMessageForDelivery, decorate: boolean): void {
  const update = {
   id: msg.id,
   seq: msg.seq,
   createdAt: msg.createdAt,
   body: {
    t: 'new-message' as const,
    sid: msg.sessionId,
    message: {
     id: msg.id,
     seq: msg.seq,
     createdAt: msg.createdAt,
     localId: msg.localId,
     content: decorate
      ? this.decorateForCli(contentForDeferredDelivery(msg.content), this.getCliDecorationContext(msg.sessionId))
      : contentForDeferredDelivery(msg.content)
    }
   }
  }
  this.io.of('/cli').to(`session:${msg.sessionId}`).emit('update', update)
 }

 /** Emit a 'force-queued-messages' control frame so the CLI registers the
  *  force flag before the per-row 'new-message' re-emits it may dedupe. */
 private emitForceQueuedFrame(sessionId: string, localIds: string[]): void {
  if (localIds.length === 0) return
  if (localIds.length > 1000) {
   for (let i = 0; i < localIds.length; i += 1000) this.emitForceQueuedFrame(sessionId, localIds.slice(i, i + 1000))
   return
  }
  this.io.of('/cli').to(`session:${sessionId}`).emit('update', {
   id: randomUUID(),
   seq: 0,
   createdAt: Date.now(),
   body: {
    t: 'force-queued-messages' as const,
    sid: sessionId,
    localIds
   }
  })
 }

 /** True when the stored row carries the persisted force-request marker. */
 private isForceRequestedContent(content: unknown): boolean {
  if (!isObject(content)) return false
  const meta = content.meta
  return isObject(meta) && typeof meta.forceSendRequestedAt === 'number'
 }

 /** Replay durable immediate prompts whenever their CLI session attaches. */
 replayImmediateQueuedMessages(sessionId: string): number {
  // Native readiness is an admission boundary, not permission to consume or discard the queue.
  if (this.canDeliverToSession?.(sessionId) === false) return 0
  const queued = this.store.messages.getImmediateQueuedLocalMessages(sessionId)
  if (queued.length === 0) return 0
  if (this.store.isOpenCodeClearDeliveryGated(sessionId)) return 0
  const forcedLocalIds = queued
   .filter((msg) => this.isForceRequestedContent(msg.content))
   .map((msg) => msg.localId)
   .filter((id): id is string => typeof id === 'string')
  this.emitForceQueuedFrame(sessionId, forcedLocalIds)
  for (const msg of queued) {
   this.emitQueuedRowToCli(msg, false)
  }
  return queued.length
 }

 /** Release a completed clear handoff in finalized seq order. */
 releaseDeliverableQueuedMessages(sessionId: string, now: number = Date.now()): number {
  if (this.canDeliverToSession?.(sessionId) === false || this.store.isOpenCodeClearDeliveryGated(sessionId)) return 0
  const queued = this.store.messages.getUninvokedLocalMessages(sessionId)
   .filter((msg) => msg.scheduledAt === null || msg.scheduledAt <= now)
  const forcedLocalIds = queued
   .filter((msg) => this.isForceRequestedContent(msg.content))
   .map((msg) => msg.localId)
   .filter((id): id is string => typeof id === 'string')
  this.emitForceQueuedFrame(sessionId, forcedLocalIds)
  for (const msg of queued) {
   this.emitQueuedRowToCli(msg, false)
  }
  return queued.length
 }

 /**
  * Force-send-all-queued: snapshot (or explicit) pending local inputs, stamp
  * content.meta.forceSendRequestedAt durably, and immediately request
  * dispatch/promotion on the CLI room. Rows stay queued — only a real CLI
  * consumption receipt stamps invoked_at. Truthful per-row statuses:
  *  - invoked / resolved: already consumed or settled before this request
  *  - dispatched: the force frame + row re-emit was sent to the CLI and the
  *    ack reported accepted/promoted
  *  - pending: row is durable but nothing could act on it (CLI offline or
  *    gated, unknown localId, ack said not-found, or ack timed out)
  *  - failed: the runner answered 'unsupported' for that row
  */
 async forceSendQueuedMessages(
  sessionId: string,
  options: { localIds?: string[]; includeScheduled?: boolean } = {},
  canDeliver?: boolean
 ): Promise<ForceSendQueuedResponse> {
  const includeScheduled = options.includeScheduled === true
  const now = Date.now()

  // Snapshot rows: explicit identities keep request order; a full snapshot
  // covers every durable local row (invoked/resolved rows surface as their
  // truthful terminal status rather than silently dropping).
  const rows = options.localIds !== undefined
   ? this.store.messages.getLocalMessagesByLocalIds(sessionId, options.localIds)
   : this.store.messages.getUninvokedLocalMessages(sessionId)

  const resultByLocalId = new Map<string, ForceSendResult>()
  const actionables: StoredMessageForDelivery[] = []
  for (const msg of rows) {
   const localId = msg.localId
   if (typeof localId !== 'string' || localId.length === 0) continue
   if (msg.invokedAt !== null) {
    resultByLocalId.set(localId, { localId, status: 'invoked' })
    continue
   }
   if (msg.resolution) {
    resultByLocalId.set(localId, { localId, status: 'resolved' })
    continue
   }
   const content = msg.content as { role?: string } | null
   if (content?.role === 'agent') {
    resultByLocalId.set(localId, { localId, status: 'pending', error: 'not a queued input' })
    continue
   }
   if (!includeScheduled && msg.scheduledAt !== null && msg.scheduledAt > now) {
    resultByLocalId.set(localId, { localId, status: 'pending', error: 'scheduled' })
    continue
   }
   resultByLocalId.set(localId, { localId, status: 'pending', error: 'awaiting runner' })
   actionables.push(msg)
  }
  // Explicit requests also report identities that matched no row at all.
  if (options.localIds !== undefined) {
   const seen = new Set(rows.map((m) => m.localId).filter((id): id is string => typeof id === 'string'))
   for (const localId of options.localIds) {
    if (!seen.has(localId) && !resultByLocalId.has(localId)) {
     resultByLocalId.set(localId, { localId, status: 'pending', error: 'unknown localId' })
    }
   }
  }

  const actionableIds = actionables
   .map((m) => m.localId)
   .filter((id): id is string => typeof id === 'string')

  // Persist the force marker before any emit so re-attaching CLIs replay it.
  const stamped = this.store.messages.markForceSendRequested(sessionId, actionableIds, now)
  const stampedLocalIds = stamped
   .map((m) => m.localId)
   .filter((id): id is string => typeof id === 'string')
  // Make the persisted request visible even when an old/offline runner takes
  // the full acknowledgement timeout. This is pending input, not consumption.
  for (const message of stamped) {
   this.publisher.emit({ type: 'message-received', sessionId, message: toDecryptedMessage(message) })
  }

  const deliveryGated =
   (canDeliver ?? this.canDeliverToSession?.(sessionId)) === false ||
   this.store.isOpenCodeClearDeliveryGated(sessionId)

  if (!deliveryGated && stampedLocalIds.length > 0) {
   const ack = await this.requestCliForceAck(sessionId, stampedLocalIds)
   const ackByLocalId = new Map(ack.map((r) => [r.localId, r]))
   for (const localId of stampedLocalIds) {
    const entry = ackByLocalId.get(localId)
    if (!entry) {
     resultByLocalId.set(localId, { localId, status: 'pending', error: 'runner unreachable' })
     continue
    }
    if (entry.status === 'accepted' || entry.status === 'promoted') {
     resultByLocalId.set(localId, { localId, status: 'dispatched' })
    } else if (entry.status === 'unsupported') {
     resultByLocalId.set(localId, {
      localId,
      status: 'failed',
      error: entry.error ?? 'runner cannot promote queued input'
     })
    } else {
     resultByLocalId.set(localId, { localId, status: 'pending', error: entry.error ?? 'not queued on runner' })
    }
   }
   // Re-emit the actual rows regardless of ack coverage: a duplicate-aware CLI
   // may have dropped the original emit, which is the reported input-loss bug.
   for (const msg of stamped) {
    this.emitQueuedRowToCli(msg, true)
   }
  } else if (stampedLocalIds.length > 0) {
   for (const localId of stampedLocalIds) {
    resultByLocalId.set(localId, { localId, status: 'pending', error: 'session delivery gated or runner offline' })
   }
  }

  // Consumption can race the asynchronous runner ack. Re-read authoritative
  // rows before SSE/HTTP replies so a fresh receipt cannot regress to queued.
  const latestRows = this.store.messages.getLocalMessagesByLocalIds(sessionId,
   rows.map(msg => msg.localId).filter((id): id is string => typeof id === 'string'))
  const stampedIds = new Set(stampedLocalIds)
  for (const msg of latestRows) {
   if (!msg.localId || !stampedIds.has(msg.localId)) continue
   this.publisher.emit({
    type: 'message-received',
    sessionId,
    message: toDecryptedMessage(msg)
   })
  }

  const messages: DecryptedMessage[] = latestRows
  for (const msg of latestRows) {
   if (!msg.localId) continue
   if (msg.invokedAt !== null) resultByLocalId.set(msg.localId, { localId: msg.localId, status: 'invoked' })
   else if (msg.resolution) resultByLocalId.set(msg.localId, { localId: msg.localId, status: 'resolved' })
  }
  // Order results like the request (or like the snapshot order).
  const results: ForceSendResult[] = []
  for (const msg of rows) {
   const localId = msg.localId
   if (typeof localId === 'string') {
    const r = resultByLocalId.get(localId)
    if (r) results.push(r)
   }
  }
  if (options.localIds !== undefined) {
   for (const localId of options.localIds) {
    if (!rows.some((m) => m.localId === localId)) {
     const r = resultByLocalId.get(localId)
     if (r) results.push(r)
    }
   }
  }
  return { results, messages }
 }

 /** Await per-localId force acks from every socket in the session room.
  *  Deterministic merge: promoted > accepted > not-found > unsupported —
  *  a socket that knows the row wins over partial responses. */
 private requestCliForceAck(
  sessionId: string,
  localIds: string[],
  timeoutMs = 5000
 ): Promise<ForceQueuedMessageAck[]> {
  if (localIds.length > 1000) {
   const batches: Array<Promise<ForceQueuedMessageAck[]>> = []
   for (let i = 0; i < localIds.length; i += 1000) batches.push(this.requestCliForceAck(sessionId, localIds.slice(i, i + 1000), timeoutMs))
   return Promise.all(batches).then(results => results.flat())
  }
  const { promise, resolve } = Promise.withResolvers<ForceQueuedMessageAck[]>()
  const room = this.io.of('/cli').to(`session:${sessionId}`)
  room.timeout(timeoutMs).emit('update', {
   id: randomUUID(),
   seq: 0,
   createdAt: Date.now(),
   body: {
    t: 'force-queued-messages' as const,
    sid: sessionId,
    localIds
   }
  }, (_err: Error | null, responses: unknown[]) => {
   const byLocalId = new Map<string, ForceQueuedMessageAck>()
   const rank: Record<ForceQueuedMessageAck['status'], number> = {
    'promoted': 3,
    'accepted': 2,
    'not-found': 1,
    'unsupported': 0
   }
   for (const response of responses ?? []) {
    const parsed = ForceQueuedMessagesAckSchema.safeParse(response)
    if (!parsed.success) continue
    for (const r of parsed.data.results) {
     const existing = byLocalId.get(r.localId)
     if (!existing || rank[r.status] > rank[existing.status]) {
      byLocalId.set(r.localId, r)
     }
    }
   }
   resolve(localIds.map((localId) => byLocalId.get(localId)).filter((r): r is ForceQueuedMessageAck => r !== undefined))
  })
  return promise
 }


 /** Called by the hub 5-second tick (syncEngine.expireInactive).
  *
  * Finds all scheduled messages whose scheduled_at <= now and emits them to
  * the CLI via socket.io.  Does NOT call markMessagesInvoked — the CLI ack
  * (messages-consumed) handles that.  This means a message is re-emitted on
  * each tick until the CLI acks it, which is the correct behaviour for hub
  * restart scenarios (pitfall #2 guard).
  *
  * Race window with cancel: this tick widens the cancel race to 5 s for
  * scheduled messages (vs near-zero for immediate-queued ones).  If the CLI
  * has already shift()-ed the row when cancel arrives, cancelQueuedMessage
  * gets 'not-found' from the CLI ack and stamps invoked_at (PR #568 contract
  * preserved).  Web client surfaces this as 'sent' in the thread.
  * See messageService.test.ts "cancel × mature race" for the documented
  * expected behaviour. */
 releaseMatureScheduledMessages(now: number, skipSessionIds?: ReadonlySet<string>): void {
  const mature = this.store.messages.getMatureScheduledMessages(now)
  const maturedSessionIds = new Set<string>()
  const deliveryGateBySession = new Map<string, boolean>()
  for (const msg of mature) {
   let deliveryGated = deliveryGateBySession.get(msg.sessionId)
   if (deliveryGated === undefined) {
    deliveryGated = this.canDeliverToSession?.(msg.sessionId) === false || this.store.isOpenCodeClearDeliveryGated(msg.sessionId)
    deliveryGateBySession.set(msg.sessionId, deliveryGated)
   }
   if (skipSessionIds?.has(msg.sessionId) || deliveryGated) {
    continue
   }
   const localId = msg.localId
   if (typeof localId === 'string' && !this.scheduledMatureNotifiedLocalIds.has(localId)) {
    this.scheduledMatureNotifiedLocalIds.add(localId)
    maturedSessionIds.add(msg.sessionId)
   }
   const update = {
    id: msg.id,
    seq: msg.seq,
    createdAt: msg.createdAt,
    body: {
     t: 'new-message' as const,
     sid: msg.sessionId,
     message: {
      id: msg.id,
      seq: msg.seq,
      createdAt: msg.createdAt,
      localId: msg.localId,
      content: this.decorateForCli(contentForDeferredDelivery(msg.content), this.getCliDecorationContext(msg.sessionId))
     }
    }
   }
   this.io.of('/cli').to(`session:${msg.sessionId}`).emit('update', update)
   // NOTE: do NOT call markMessagesInvoked here (pitfall #2).
   // CLI ack (messages-consumed) will handle invoked_at stamping.
  }
  for (const sessionId of maturedSessionIds) {
   this.publisher.emit({ type: 'scheduled-matured', sessionId })
  }
 }
}
