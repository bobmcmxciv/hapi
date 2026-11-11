import type { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

import type { StoredMessage } from './types'
import { decodeMessageContent, encodeMessageContent, truncateOversizedMessageContent } from './contentCodec'
import { recordMessageTurnStart } from './messageTurnQueries'
import { copyMessageResolution, hydrateMessageResolutions } from './messageResolutions'
import type { InputResolution } from '@hapi/protocol/types'
import { nativeDisplayPosition, hostReceiptPosition, rowDisplayPosition, type NativeMessageOrder, type NativeDelivery } from './messageOrdering'
import type { DisplayPosition } from './messageOrdering'
import { POSITION_AT, POSITION_ORDER, POSITION_EVENT } from './messageOrdering'

type DbMessageRow = {
 id: string
 session_id: string
 // TEXT (plaintext JSON, legacy rows) or BLOB (zstd-compressed JSON) — see contentCodec.ts
 content: string | Uint8Array
 created_at: number
 seq: number
 local_id: string | null
 invoked_at: number | null
 scheduled_at: number | null
 position_at?: number | null
 position_order?: number | null
 position_event?: number | null
}

export type MessagePosition = {
 at: number
 seq: number
 order?: number
 eventOrder?: number
}

export class ImportedMessageConflictError extends Error {
 constructor(readonly localId: string) {
  super(`Imported message content changed for localId: ${localId}`)
  this.name = 'ImportedMessageConflictError'
 }
}

export function addImportedMessage(
 db: Database,
 sessionId: string,
 content: unknown,
 localId: string,
 createdAt: number
): { message: StoredMessage; inserted: boolean } {
 const existing = db.prepare(
  'SELECT * FROM messages WHERE session_id = ? AND local_id = ? LIMIT 1'
 ).get(sessionId, localId) as DbMessageRow | undefined
 if (existing) {
  const message = hydrateMessageResolutions(db, [toStoredMessage(existing)])[0]
  const canonicalContent = truncateOversizedMessageContent(content)
  if (!isDeepStrictEqual(message.content, canonicalContent)) throw new ImportedMessageConflictError(localId)
  return { message, inserted: false }
 }

 const now = Date.now()
 const stampedAt = Number.isFinite(createdAt) ? Math.min(createdAt, now) : now
 return db.transaction(() => {
  const previousHead = getNewestMessagePosition(db, sessionId)
  const msgSeqRow = db.prepare(
   'SELECT COALESCE(MAX(seq), 0) + 1 AS nextSeq FROM messages WHERE session_id = ?'
  ).get(sessionId) as { nextSeq: number }
  const id = randomUUID()
  db.prepare(`
            INSERT INTO messages (
                id, session_id, content, created_at, seq, local_id, invoked_at, scheduled_at
            ) VALUES (
                @id, @session_id, @content, @created_at, @seq, @local_id, @invoked_at, NULL
            )
        `).run({
   id,
   session_id: sessionId,
   content: encodeMessageContent(truncateOversizedMessageContent(content)),
   created_at: stampedAt,
   seq: msgSeqRow.nextSeq,
   local_id: localId,
   invoked_at: stampedAt
  })
  if (previousHead && stampedAt < previousHead.at) bumpMessageEpoch(db, sessionId)
  const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as DbMessageRow | undefined
  if (!row) throw new Error('Failed to create imported message')
  const message = toStoredMessage(row)
  recordMessageTurnStart(db, message)
  return { message, inserted: true }
 })()
}

function toStoredMessage(row: DbMessageRow): StoredMessage {
 return {
  id: row.id,
  sessionId: row.session_id,
  content: decodeMessageContent(row.content),
  createdAt: row.created_at,
  seq: row.seq,
  localId: row.local_id,
  invokedAt: row.invoked_at ?? null,
  scheduledAt: row.scheduled_at ?? null,
  ...rowDisplayPosition(row)
 }
}

export type CopyStoredMessageInput = Pick<
 StoredMessage,
 'content' | 'createdAt' | 'localId' | 'invokedAt' | 'scheduledAt' | 'resolution' | 'position'
>

export function addMessage(
 db: Database,
 sessionId: string,
 content: unknown,
 localId?: string,
 scheduledAt?: number | null,
 createdAt?: number,
 nativeOrder?: NativeMessageOrder
): StoredMessage {
 const now = Date.now()
 // Client-provided origin timestamp (e.g. a Claude transcript entry's own
 // `timestamp`), falling back to server-receive time when absent. Only
 // agent-message callers (sessionHandlers' `on('message')`) pass this today.
 const stampedAt = Number.isFinite(createdAt)
  ? nativeOrder ? createdAt! : Math.min(createdAt!, now)
  : now

 // Without a localId, invoked_at is stamped immediately below — there is no
 // ack path to flip it later.  A scheduled message in that state would be
 // skipped by the future-emit branch and never picked up by
 // getMatureScheduledMessages (which filters on invoked_at IS NULL), so
 // the schedule would be silently lost.
 if (scheduledAt != null && !localId) {
  throw new Error('addMessage: scheduledAt requires a localId for the ack flow')
 }

 if (localId) {
  const existing = db.prepare(
   'SELECT * FROM messages WHERE session_id = ? AND local_id = ? LIMIT 1'
  ).get(sessionId, localId) as DbMessageRow | undefined
  if (existing) {
   return hydrateMessageResolutions(db, [toStoredMessage(existing)])[0]
  }
 }

 const msgSeqRow = db.prepare(
  'SELECT COALESCE(MAX(seq), 0) + 1 AS nextSeq FROM messages WHERE session_id = ?'
 ).get(sessionId) as { nextSeq: number }
 const msgSeq = msgSeqRow.nextSeq

 const id = randomUUID()
 const encoded = encodeMessageContent(truncateOversizedMessageContent(content))

 // Messages without a localId have no ack path (markMessagesInvoked matches by localId).
 // Treat them as already-invoked at insert time so they land in the thread normally instead
 // of being stuck in the queued floating bar forever. Stamped with `stampedAt` (the
 // client-provided createdAt when present) rather than server-now so getMessagesByPosition's
 // COALESCE(invoked_at, created_at) sort reflects the transcript's own jsonl order instead of
 // hub arrival order.
 const invokedAt = localId ? null : stampedAt

 return db.transaction(() => {
  const position = nativeOrder ? nativeDisplayPosition(db, sessionId, nativeOrder) : !localId ? hostReceiptPosition(db, sessionId) : undefined
  const previousHead = getNewestMessagePosition(db, sessionId)
  db.prepare(`
            INSERT INTO messages (
                id, session_id, content, created_at, seq, local_id, invoked_at, scheduled_at,
                position_at, position_order, position_event
            ) VALUES (
                @id, @session_id, @content, @created_at, @seq, @local_id, @invoked_at, @scheduled_at,
                @position_at, @position_order, @position_event
            )
        `).run({
   id,
   session_id: sessionId,
   content: encoded,
   created_at: stampedAt,
   seq: msgSeq,
   local_id: localId ?? null,
   invoked_at: invokedAt,
   scheduled_at: scheduledAt ?? null,
   position_at: position?.at ?? null,
   position_order: position?.order ?? null,
   position_event: position?.eventOrder ?? null
  })

  const positionAt = position?.at ?? invokedAt ?? stampedAt
  if (previousHead && (positionAt < previousHead.at || (positionAt === previousHead.at &&
   ((position?.order ?? 0) < (previousHead.order ?? 0) || ((position?.order ?? 0) === (previousHead.order ?? 0)
    && (position?.eventOrder ?? 0) < (previousHead.eventOrder ?? 0)))))) bumpMessageEpoch(db, sessionId)
  const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as DbMessageRow | undefined
  if (!row) throw new Error('Failed to create message')
  const message = toStoredMessage(row)
  recordMessageTurnStart(db, message)
  return message
 })()
}

export function copyMessageToSession(
 db: Database,
 sessionId: string,
 message: CopyStoredMessageInput
): StoredMessage {
 return db.transaction(() => {
  const createdAt = Number.isFinite(message.createdAt) ? message.createdAt : Date.now()
  const nextSeq = getMaxSeq(db, sessionId) + 1

  let localId = message.localId
  if (localId) {
   const collision = db.prepare(
    'SELECT 1 FROM messages WHERE session_id = ? AND local_id = ? LIMIT 1'
   ).get(sessionId, localId) as { 1: number } | undefined
   if (collision) {
    // 中文注释：重复会话合并时如果 localId 撞车，给复制进目标会话的消息生成一个新 localId，避免误判成同一条已存在消息。
    localId = `${localId}:merged:${randomUUID().slice(0, 8)}`
   }
  }

  if (message.scheduledAt != null && !localId && message.invokedAt === null) {
   // 中文注释：未来计划消息仍需要 ack 路径；异常情况下若源数据缺少 localId，这里补一个稳定可写的新值以保留调度语义。
   localId = `merged-scheduled:${randomUUID()}`
  }

  const invokedAt = message.resolution ? null : localId ? message.invokedAt : (message.invokedAt ?? createdAt)
  const id = randomUUID()
  db.prepare(`
        INSERT INTO messages (
            id, session_id, content, created_at, seq, local_id, invoked_at, scheduled_at,
            position_at, position_order, position_event
        ) VALUES (
            @id, @session_id, @content, @created_at, @seq, @local_id, @invoked_at, @scheduled_at,
            @position_at, @position_order, @position_event
        )
    `).run({
   id,
   session_id: sessionId,
   // Lossless re-encode only — copies move existing history between
   // sessions, so no truncation here even for pre-codec oversized rows.
   content: encodeMessageContent(message.content),
   created_at: createdAt,
   seq: nextSeq,
   local_id: localId ?? null,
   invoked_at: invokedAt ?? null,
   scheduled_at: message.scheduledAt ?? null,
   position_at: message.position?.at ?? null,
   position_order: message.position?.order ?? null,
   position_event: message.position?.eventOrder ?? null
  })

  copyMessageResolution(db, id, message.resolution)
  const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as DbMessageRow | undefined
  if (!row) {
   throw new Error('Failed to copy message into target session')
  }

  // Copies preserve the source display timestamp, so a new high-seq row can
  // still land behind a Web client's cached composite tail cursor. Mark the
  // target history as structurally changed so incremental readers reset.
  bumpMessageEpoch(db, sessionId)
  const copied = hydrateMessageResolutions(db, [toStoredMessage(row)])[0]
  recordMessageTurnStart(db, copied)
  return copied
 })()
}

/**
 * Batch-hydrate a fork child: one transaction, contiguous seq allocation,
 * single epoch bump. Avoids O(n) max-seq lookups and epoch writes.
 */
export function copyMessagesToSession(
 db: Database,
 sessionId: string,
 messages: CopyStoredMessageInput[]
): number {
 if (messages.length === 0) return 0

 return db.transaction(() => {
  let nextSeq = getMaxSeq(db, sessionId) + 1
  const insert = db.prepare(`
            INSERT INTO messages (
                id, session_id, content, created_at, seq, local_id, invoked_at, scheduled_at,
                position_at, position_order, position_event
            ) VALUES (
                @id, @session_id, @content, @created_at, @seq, @local_id, @invoked_at, @scheduled_at,
                @position_at, @position_order, @position_event
            )
        `)
  const collisionCheck = db.prepare(
   'SELECT 1 FROM messages WHERE session_id = ? AND local_id = ? LIMIT 1'
  )

  for (const message of messages) {
   const createdAt = Number.isFinite(message.createdAt) ? message.createdAt : Date.now()
   let localId = message.localId
   if (localId) {
    const collision = collisionCheck.get(sessionId, localId) as { 1: number } | undefined
    if (collision) {
     localId = `${localId}:merged:${randomUUID().slice(0, 8)}`
    }
   }
   if (message.scheduledAt != null && !localId && message.invokedAt === null) {
    localId = `merged-scheduled:${randomUUID()}`
   }
   const invokedAt = message.resolution ? null : localId ? message.invokedAt : (message.invokedAt ?? createdAt)
   const id = randomUUID()
   insert.run({
    id,
    session_id: sessionId,
    content: encodeMessageContent(message.content),
    created_at: createdAt,
    seq: nextSeq,
    local_id: localId ?? null,
    invoked_at: invokedAt ?? null,
    scheduled_at: message.scheduledAt ?? null,
    position_at: message.position?.at ?? null,
    position_order: message.position?.order ?? null,
    position_event: message.position?.eventOrder ?? null
   })
   copyMessageResolution(db, id, message.resolution)
   recordMessageTurnStart(db, {
    id, sessionId, content: message.content, createdAt, seq: nextSeq,
    localId: localId ?? null, invokedAt: invokedAt ?? null,
    scheduledAt: message.scheduledAt ?? null, position: message.position
   })
   nextSeq += 1
  }

  bumpMessageEpoch(db, sessionId)
  return messages.length
 })()
}

export function getMessages(
 db: Database,
 sessionId: string,
 limit: number = 200
): StoredMessage[] {
 const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(200, limit)) : 200

 const rows = db.prepare(
  'SELECT * FROM messages WHERE session_id = ? ORDER BY seq DESC LIMIT ?'
 ).all(sessionId, safeLimit) as DbMessageRow[]

 return hydrateMessageResolutions(db, rows.reverse().map(toStoredMessage))
}

export function getAllMessages(
 db: Database,
 sessionId: string
): StoredMessage[] {
 const rows = db.prepare(
  'SELECT * FROM messages WHERE session_id = ? ORDER BY seq ASC'
 ).all(sessionId) as DbMessageRow[]

 return hydrateMessageResolutions(db, rows.map(toStoredMessage))
}

export function getMessagesAfterSeq(
 db: Database,
 sessionId: string,
 afterSeq: number
): StoredMessage[] {
 const rows = db.prepare(
  'SELECT * FROM messages WHERE session_id = ? AND seq > ? ORDER BY seq ASC'
 ).all(sessionId, afterSeq) as DbMessageRow[]

 return hydrateMessageResolutions(db, rows.map(toStoredMessage))
}

export function getFirstMessages(
 db: Database,
 sessionId: string,
 limit: number = 50
): StoredMessage[] {
 const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(200, limit)) : 50

 const rows = db.prepare(
  'SELECT * FROM messages WHERE session_id = ? ORDER BY seq ASC LIMIT ?'
 ).all(sessionId, safeLimit) as DbMessageRow[]

 return hydrateMessageResolutions(db, rows.map(toStoredMessage))
}

/** CLI reconnect backfill: returns messages above the seq cursor that are
 *  deliverable now, i.e. excludes future-scheduled rows (scheduled_at > now).
 *  Without this filter, a CLI reconnect between schedule time and release time
 *  would replay future-scheduled rows via the normal message stream and the
 *  runner would consume them immediately, bypassing the mature-scan path.
 *  Only the CLI backfill route should use this; the Web thread API still calls
 *  byPosition / getMessages and needs the full set so scheduled rows surface in
 *  the queued floating bar. */
export function getDeliverableMessagesAfter(
 db: Database,
 sessionId: string,
 afterSeq: number,
 now: number,
 limit: number = 200
): StoredMessage[] {
 const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(200, limit)) : 200
 const safeAfterSeq = Number.isFinite(afterSeq) ? afterSeq : 0

 const rows = db.prepare(`
        SELECT * FROM messages
        WHERE session_id = ?
          AND seq > ?
          AND (scheduled_at IS NULL OR scheduled_at <= ?)
          AND NOT EXISTS (SELECT 1 FROM message_input_resolutions r WHERE r.message_id = messages.id)
        ORDER BY seq ASC
        LIMIT ?
    `).all(sessionId, safeAfterSeq, now, safeLimit) as DbMessageRow[]

 return hydrateMessageResolutions(db, rows.map(toStoredMessage))
}

/** Paginate messages by COALESCE(invoked_at, created_at) DESC, seq DESC.
 *  Results are returned in ascending display order. */
export function getMessagesByPosition(
 db: Database,
 sessionId: string,
 limit: number,
 before?: MessagePosition,
 legacyPosition = false
): StoredMessage[] {
 const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(200, limit)) : 200
 const at = legacyPosition ? 'COALESCE(invoked_at, created_at)' : POSITION_AT
 const order = legacyPosition ? 'CAST(0 AS INTEGER)' : POSITION_ORDER
 const event = legacyPosition ? 'CAST(0 AS INTEGER)' : POSITION_EVENT
 const beforeClause = before
  ? `AND (${at}, ${order}, ${event}, seq) < (@beforeAt, @beforeOrder, @beforeEvent, @beforeSeq)`
  : ''
 const rows = db.prepare(`
        SELECT *
        FROM messages
        WHERE session_id = @sessionId
          ${beforeClause}
        ORDER BY ${at} DESC, ${order} DESC, ${event} DESC, seq DESC
        LIMIT @limit
    `).all({
  sessionId,
  beforeAt: before?.at ?? null,
  beforeSeq: before?.seq ?? null,
  beforeOrder: before?.order ?? 0,
  beforeEvent: before?.eventOrder ?? 0,
  limit: safeLimit
 }) as DbMessageRow[]
 // Reverse so results are in ascending display order (oldest first)
 const messages = hydrateMessageResolutions(db, rows.reverse().map(toStoredMessage))
 if (legacyPosition) for (const message of messages) delete message.position
 return messages
}

/** Return messages strictly after a display-position cursor in ascending order.
 *  `until`, when supplied, is an inclusive fixed snapshot head so a catch-up
 *  loop does not chase messages appended while it is running. */
export function getMessagesAfterPosition(
 db: Database,
 sessionId: string,
 limit: number,
 after: MessagePosition,
 until?: MessagePosition,
 legacyPosition = false
): StoredMessage[] {
 const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(200, limit)) : 200
 const at = legacyPosition ? 'COALESCE(invoked_at, created_at)' : POSITION_AT
 const order = legacyPosition ? 'CAST(0 AS INTEGER)' : POSITION_ORDER
 const event = legacyPosition ? 'CAST(0 AS INTEGER)' : POSITION_EVENT
 const untilClause = until
  ? `AND (${at}, ${order}, ${event}, seq) <= (@untilAt, @untilOrder, @untilEvent, @untilSeq)`
  : ''
 const rows = db.prepare(`
        SELECT *
        FROM messages
        WHERE session_id = @sessionId
          AND (${at}, ${order}, ${event}, seq) > (@afterAt, @afterOrder, @afterEvent, @afterSeq)
          ${untilClause}
        ORDER BY ${at} ASC, ${order} ASC, ${event} ASC, seq ASC
        LIMIT @limit
    `).all({
  sessionId,
  afterAt: after.at,
  afterSeq: after.seq,
  afterOrder: after.order ?? 0,
  afterEvent: after.eventOrder ?? 0,
  untilAt: until?.at ?? null,
  untilSeq: until?.seq ?? null,
  untilOrder: until?.order ?? 0,
  untilEvent: until?.eventOrder ?? 0,
  limit: safeLimit
 }) as DbMessageRow[]
 const messages = hydrateMessageResolutions(db, rows.map(toStoredMessage))
 if (legacyPosition) for (const message of messages) delete message.position
 return messages
}

export function getNewestMessagePosition(db: Database, sessionId: string, legacyPosition = false): MessagePosition | null {
 const at = legacyPosition ? 'COALESCE(invoked_at, created_at)' : POSITION_AT
 const order = legacyPosition ? 'CAST(0 AS INTEGER)' : POSITION_ORDER
 const event = legacyPosition ? 'CAST(0 AS INTEGER)' : POSITION_EVENT
 const row = db.prepare(`
        SELECT ${at} AS at, ${order} AS ordering, ${event} AS event, seq
        FROM messages
        WHERE session_id = ?
        ORDER BY ${at} DESC, ${order} DESC, ${event} DESC, seq DESC
        LIMIT 1
    `).get(sessionId) as { at: number; ordering: number; event: number; seq: number } | undefined
 return row ? { at: row.at, ...(row.ordering || row.event ? { order: row.ordering, eventOrder: row.event } : {}), seq: row.seq } : null
}

export function getMessageEpoch(db: Database, sessionId: string): number {
 const row = db.prepare(
  'SELECT epoch FROM message_epochs WHERE session_id = ?'
 ).get(sessionId) as { epoch: number } | undefined
 return row?.epoch ?? 0
}

export function bumpMessageEpoch(db: Database, sessionId: string): number {
 db.prepare(`
        INSERT INTO message_epochs (session_id, epoch)
        VALUES (?, 1)
        ON CONFLICT(session_id) DO UPDATE SET epoch = epoch + 1
    `).run(sessionId)
 return getMessageEpoch(db, sessionId)
}

/** Returns user messages that have a localId but no invoked_at.
 *  Includes future scheduled messages — used to surface all queued messages
 *  (including scheduled) for the Web floating bar on refresh / secondary clients. */
export function getUninvokedLocalMessages(
 db: Database,
 sessionId: string
): StoredMessage[] {
 const rows = db.prepare(
  // INDEXED BY: without sqlite_stat1 the planner picks idx_messages_session and walks the
  // whole session history (171k rows / ~1s on prod) for what is almost always zero rows.
  'SELECT * FROM messages INDEXED BY idx_messages_local_id WHERE session_id = ? AND invoked_at IS NULL AND local_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM message_input_resolutions r WHERE r.message_id = messages.id) ORDER BY seq ASC'
 ).all(sessionId) as DbMessageRow[]
 return rows.map(toStoredMessage)
}

export type LocalMessageState = {
 localId: string
 invokedAt: number | null
 resolution?: InputResolution
 position?: DisplayPosition
}

export function getLocalMessageStates(
 db: Database,
 sessionId: string,
 localIds: string[]
): LocalMessageState[] {
 if (localIds.length === 0) {
  return []
 }
 const placeholders = localIds.map(() => '?').join(', ')
 const rows = db.prepare(`
        SELECT m.local_id, m.invoked_at, m.position_at, m.position_order, m.position_event, r.outcome, r.resolved_at
        FROM messages m LEFT JOIN message_input_resolutions r ON r.message_id = m.id
        WHERE m.session_id = ? AND m.local_id IN (${placeholders})
        ORDER BY m.seq ASC
    `).all(sessionId, ...localIds) as Array<{
  local_id: string
  invoked_at: number | null
  outcome: InputResolution['outcome'] | null
  resolved_at: number | null
  position_at: number | null
  position_order: number | null
  position_event: number | null
 }>
 return rows.map((row) => ({
  localId: row.local_id,
  invokedAt: row.invoked_at,
  ...(row.outcome !== null ? { resolution: { outcome: row.outcome, resolvedAt: row.resolved_at! } } : {}),
  ...rowDisplayPosition(row)
 }))
}

/** Returns scheduled messages across all sessions whose scheduled_at <= beforeTime
 *  and have not yet been invoked.  Used by the hub tick to emit mature messages to CLI.
 *  Ordered by scheduled_at ASC (oldest first). */
export function getMatureScheduledMessages(
 db: Database,
 beforeTime: number
): StoredMessage[] {
 const rows = db.prepare(
  'SELECT * FROM messages WHERE scheduled_at IS NOT NULL AND scheduled_at <= ? AND invoked_at IS NULL AND NOT EXISTS (SELECT 1 FROM message_input_resolutions r WHERE r.message_id = messages.id) ORDER BY scheduled_at ASC'
 ).all(beforeTime) as DbMessageRow[]
 return rows.map(toStoredMessage)
}

/** Durable immediate pending rows replayed when a CLI reattaches. Session end
 * never consumes these rows; only a real native delivery receipt may do so.
 * Scheduled rows use the mature scan unless explicitly forced (unscheduled). */
export function getImmediateQueuedLocalMessages(
 db: Database,
 sessionId: string
): StoredMessage[] {
 const rows = db.prepare(`
        SELECT * FROM messages INDEXED BY idx_messages_local_id
        WHERE session_id = ?
          AND invoked_at IS NULL
          AND local_id IS NOT NULL
          AND scheduled_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM message_input_resolutions r WHERE r.message_id = messages.id)
        ORDER BY seq ASC
    `).all(sessionId) as DbMessageRow[]
 return rows
  .map(toStoredMessage)
  .filter((msg) => (msg.content as { role?: string } | null)?.role !== 'agent')
}

/** Fetch local messages (local_id IS NOT NULL) for an explicit localId list,
 *  preserving request order. Used by the force-send endpoint when the caller
 *  passes an explicit set of identities. */
export function getLocalMessagesByLocalIds(
 db: Database,
 sessionId: string,
 localIds: string[]
): StoredMessage[] {
 if (localIds.length === 0) return []
 const messages = new Map<string, StoredMessage>()
 const placeholders = localIds.map(() => '?').join(',')
 const rows = db.prepare(
  `SELECT * FROM messages WHERE session_id = ? AND local_id IN (${placeholders})`
 ).all(sessionId, ...localIds) as DbMessageRow[]
 for (const stored of hydrateMessageResolutions(db, rows.map(toStoredMessage))) {
  if (stored.localId) messages.set(stored.localId, stored)
 }
 return localIds
  .map((localId) => messages.get(localId))
  .filter((msg): msg is StoredMessage => msg !== undefined)
}

/**
 * Persist `content.meta.forceSendRequestedAt` on each supplied queued row
 * (skips rows that are invoked, resolved, or not locally-queued). The flag is
 * authoritative metadata: the conversation renders it as a force-requested
 * pending row while real consumption receipts still own invoked_at.
 * Runs in a single transaction; bumps the message epoch once and returns the
 * updated rows in input order (skipped rows are absent).
 */
export function markForceSendRequested(
 db: Database,
 sessionId: string,
 localIds: string[],
 requestedAt: number
): StoredMessage[] {
 if (localIds.length === 0) return []
 const updated = new Map<string, StoredMessage>()
 const txn = db.transaction((ids: string[]) => {
  for (const localId of ids) {
   const row = db.prepare(
    `SELECT * FROM messages
           WHERE session_id = ?
             AND local_id = ?
             AND invoked_at IS NULL
             AND NOT EXISTS (SELECT 1 FROM message_input_resolutions r WHERE r.message_id = messages.id)
           LIMIT 1`
   ).get(sessionId, localId) as DbMessageRow | undefined
   if (!row) continue
   const content = decodeMessageContent(row.content)
   if (!isObjectRecord(content)) continue
   const nextContent = {
    ...content,
    meta: {
     ...(isObjectRecord(content.meta) ? content.meta : {}),
     forceSendRequestedAt: requestedAt
    }
   }
   db.prepare('UPDATE messages SET content = ?, scheduled_at = NULL WHERE id = ?').run(
    encodeMessageContent(nextContent),
    row.id
   )
   const hydrated = hydrateMessageResolutions(db, [toStoredMessage({ ...row, scheduled_at: null, content: JSON.stringify(nextContent) })])
   const stored = hydrated[0]
   if (stored?.localId) updated.set(stored.localId, stored)
  }
 })
 txn(localIds)
 const ordered = localIds
  .map((localId) => updated.get(localId))
  .filter((msg): msg is StoredMessage => msg !== undefined)
 if (ordered.length > 0) {
  bumpMessageEpoch(db, sessionId)
 }
 return ordered
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
 return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Total messages persisted for a session - any role, any state (including
 * future-scheduled and never-invoked queued rows). Used as the
 * "is this session non-trivial?" signal for the cursor migrator's size
 * sanity check; intentionally broad so a session with 6 000 unread agent
 * outputs and zero invoked user turns still counts as non-trivial.
 * tiann/hapi#872.
 */
export function countMessages(db: Database, sessionId: string): number {
 const row = db.prepare(
  'SELECT COUNT(*) AS count FROM messages WHERE session_id = ?'
 ).get(sessionId) as { count: number } | undefined
 return row?.count ?? 0
}

/** Count uninvoked local messages scheduled for a future time (session list indicator). */
export function countFutureScheduledLocalMessages(
 db: Database,
 sessionId: string,
 now: number
): number {
 const row = db.prepare(`
        SELECT COUNT(*) AS count
        FROM messages
        WHERE session_id = ?
          AND invoked_at IS NULL
          AND local_id IS NOT NULL
          AND scheduled_at IS NOT NULL
          AND scheduled_at > ?
          AND NOT EXISTS (SELECT 1 FROM message_input_resolutions r WHERE r.message_id = messages.id)
    `).get(sessionId, now) as { count: number } | undefined
 return row?.count ?? 0
}

/** Batch variant for GET /sessions — one query for all session IDs in a namespace. */
export function countFutureScheduledBySessionIds(
 db: Database,
 sessionIds: string[],
 now: number
): Map<string, number> {
 const counts = new Map<string, number>()
 if (sessionIds.length === 0) {
  return counts
 }

 const placeholders = sessionIds.map(() => '?').join(',')
 const rows = db.prepare(`
        SELECT session_id, COUNT(*) AS count
        FROM messages
        WHERE session_id IN (${placeholders})
          AND invoked_at IS NULL
          AND local_id IS NOT NULL
          AND scheduled_at IS NOT NULL
          AND scheduled_at > ?
          AND NOT EXISTS (SELECT 1 FROM message_input_resolutions r WHERE r.message_id = messages.id)
        GROUP BY session_id
    `).all(...sessionIds, now) as { session_id: string; count: number }[]

 for (const row of rows) {
  counts.set(row.session_id, row.count)
 }
 return counts
}

/** Earliest future scheduled_at per session (session-list clock tooltip). */
export function minFutureScheduledAtBySessionIds(
 db: Database,
 sessionIds: string[],
 now: number
): Map<string, number> {
 const nextAt = new Map<string, number>()
 if (sessionIds.length === 0) {
  return nextAt
 }

 const placeholders = sessionIds.map(() => '?').join(',')
 const rows = db.prepare(`
        SELECT session_id, MIN(scheduled_at) AS next_at
        FROM messages
        WHERE session_id IN (${placeholders})
          AND invoked_at IS NULL
          AND local_id IS NOT NULL
          AND scheduled_at IS NOT NULL
          AND scheduled_at > ?
          AND NOT EXISTS (SELECT 1 FROM message_input_resolutions r WHERE r.message_id = messages.id)
        GROUP BY session_id
    `).all(...sessionIds, now) as { session_id: string; next_at: number }[]

 for (const row of rows) {
  nextAt.set(row.session_id, row.next_at)
 }
 return nextAt
}

export function getMaxSeq(db: Database, sessionId: string): number {
 const row = db.prepare(
  'SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM messages WHERE session_id = ?'
 ).get(sessionId) as { maxSeq: number } | undefined
 return row?.maxSeq ?? 0
}

export type CancelQueuedMessageResult =
 | { status: 'cancelled'; localId: string | null }
 | { status: 'invoked'; message: StoredMessage }
 | { status: 'resolved'; message: StoredMessage }
 | { status: 'unconfirmed'; message: StoredMessage }
/** Delete a queued (invoked_at IS NULL) message by session + message id.
 *
 * Runs inside a transaction to eliminate the SELECT-then-DELETE race window.
 * Returns a discriminated union so callers can distinguish two zero-delete cases:
 *   - 'cancelled': row was absent (already cancelled, or wrong id/session) — treat as success.
 *   - 'invoked':   row exists but invoked_at IS NOT NULL (CLI consumed it first) —
 *                  caller must revert any optimistic removal using the returned row,
 *                  not a stale client-side snapshot, so invokedAt is authoritative.
 *
 * The invoked_at IS NULL guard ensures cancel and invoke are mutually exclusive at
 * the DB level (first-write-wins, mirrors markMessagesInvoked). */
export function cancelQueuedMessage(
 db: Database,
 sessionId: string,
 messageId: string
): CancelQueuedMessageResult {
 return db.transaction(() => {
  // Accept either the server-assigned uuid (id) or the client localId.
  // This handles the pre-echo window where the web client still holds
  // msg.id === localId and passes that as the messageId parameter.
  // Note: local_id = ? evaluates to NULL (no match) when local_id IS NULL,
  // which is safe — messages without a localId are inserted with invoked_at set
  // and are never queued, so they cannot reach this code path anyway.
  const row = db.prepare(`
            SELECT * FROM messages
            WHERE session_id = ? AND (id = ? OR local_id = ?)
            LIMIT 1
        `).get(sessionId, messageId, messageId) as DbMessageRow | undefined

  if (!row) {
   // Row absent: already cancelled or wrong id — fold into 'cancelled'
   return { status: 'cancelled' as const, localId: null }
  }

  const message = hydrateMessageResolutions(db, [toStoredMessage(row)])[0]
  if (message.resolution) return { status: 'resolved' as const, message }
  if (row.invoked_at !== null) {
   // CLI already consumed this message before the cancel arrived.
   // Return the full row so the web client can restore authoritative invoked state
   // rather than reverting to a stale queued snapshot (invokedAt: null).
   return { status: 'invoked' as const, message: toStoredMessage(row) }
  }

  const deleted = db.prepare(`
            DELETE FROM messages
            WHERE session_id = ? AND (id = ? OR local_id = ?) AND invoked_at IS NULL
              AND NOT EXISTS (SELECT 1 FROM message_input_resolutions r WHERE r.message_id = messages.id)
        `).run(sessionId, messageId, messageId)

  if (deleted.changes > 0) {
   bumpMessageEpoch(db, sessionId)
  }

  return { status: 'cancelled' as const, localId: row.local_id }
 })()
}

export type LookupQueuedMessageResult =
 | { status: 'absent' }
 | { status: 'invoked'; message: StoredMessage }
 | { status: 'queued'; localId: string | null; resolvedId: string; scheduledAt: number | null; message: StoredMessage }
 | { status: 'resolved'; message: StoredMessage }

/** Look up a queued message without deleting it.
 *
 * Returns one of three discriminated states:
 *   - 'absent':  row not found (already cancelled or wrong id).
 *   - 'invoked': row exists but invoked_at IS NOT NULL (CLI consumed it first).
 *   - 'queued':  row exists and is cancellable; resolvedId is the server-assigned uuid.
 *
 * Used by the service layer to inspect state before issuing a CLI ack round-trip.
 * The actual DELETE (after CLI ack) is performed by deleteQueuedMessageById. */
export function lookupQueuedMessage(
 db: Database,
 sessionId: string,
 messageId: string
): LookupQueuedMessageResult {
 const row = db.prepare(`
        SELECT * FROM messages
        WHERE session_id = ? AND (id = ? OR local_id = ?)
        LIMIT 1
    `).get(sessionId, messageId, messageId) as DbMessageRow | undefined

 if (!row) {
  return { status: 'absent' as const }
 }

 const message = hydrateMessageResolutions(db, [toStoredMessage(row)])[0]
 if (message.resolution) return { status: 'resolved' as const, message }
 if (row.invoked_at !== null) {
  return { status: 'invoked' as const, message: toStoredMessage(row) }
 }

 return { status: 'queued' as const, localId: row.local_id, resolvedId: row.id, scheduledAt: row.scheduled_at, message }
}

/** Delete a queued (invoked_at IS NULL) message by id or local_id.
 *
 * This is the "confirmed DELETE" step after the service layer has received a
 * CLI ack with removed:true.  Uses the same first-write-wins guard as the
 * original cancelQueuedMessage. */
export function deleteQueuedMessageById(
 db: Database,
 sessionId: string,
 messageId: string
): boolean {
 return db.transaction(() => {
  const deleted = db.prepare(`
            DELETE FROM messages
            WHERE session_id = ? AND (id = ? OR local_id = ?) AND invoked_at IS NULL
              AND NOT EXISTS (SELECT 1 FROM message_input_resolutions r WHERE r.message_id = messages.id)
        `).run(sessionId, messageId, messageId)
  if (deleted.changes > 0) {
   bumpMessageEpoch(db, sessionId)
   return true
  }
  return false
 })()
}

/** Mark messages as invoked at the given server timestamp.
 *  Only updates rows whose local_id is in localIds.
 *  First-write-wins: rows with a non-NULL invoked_at are not updated.  A duplicate
 *  ack (e.g. a CLI re-emit) would otherwise re-stamp the timestamp and shuffle
 *  the message's position in the byPosition-ordered thread. */
export function markMessagesInvoked(
 db: Database,
 sessionId: string,
 localIds: string[],
 invokedAt: number,
 nativeDelivery?: NativeDelivery
): number {
 if (localIds.length === 0) return 0
 const placeholders = localIds.map(() => '?').join(', ')
 return db.transaction(() => {
  if (nativeDelivery) {
   if (localIds.length !== 1 || !nativeDelivery.sessionId || !nativeDelivery.entryId
    || !Number.isSafeInteger(nativeDelivery.entryOrder) || nativeDelivery.entryOrder < 1
    || !Number.isFinite(Date.parse(nativeDelivery.deliveredAt))) {
    throw new Error('Native delivery requires one exact token and committed timestamp/order')
   }
   const row = db.prepare(`SELECT m.id, m.invoked_at, m.position_at, d.native_session_id, d.entry_id, d.entry_order,
    (SELECT message_id FROM message_native_deliveries WHERE session_id = m.session_id AND native_session_id = ? AND entry_id = ?) AS entry_owner
    FROM messages m LEFT JOIN message_native_deliveries d ON d.message_id = m.id
    WHERE m.session_id = ? AND m.local_id = ?
    AND NOT EXISTS (SELECT 1 FROM message_input_resolutions r WHERE r.message_id = m.id)`)
    .get(nativeDelivery.sessionId, nativeDelivery.entryId, sessionId, localIds[0]) as { id: string; invoked_at: number | null; position_at: number | null; native_session_id: string | null; entry_id: string | null; entry_order: number | null; entry_owner: string | null } | undefined
   if (!row) return 0
   if ((row.entry_owner && row.entry_owner !== row.id) || (row.entry_id && (row.native_session_id !== nativeDelivery.sessionId
    || row.entry_id !== nativeDelivery.entryId || row.entry_order !== nativeDelivery.entryOrder))) {
    throw new Error('Native delivery identity conflict')
   }
   if (row.entry_id) return 0
   db.prepare('INSERT INTO message_native_deliveries(message_id, session_id, native_session_id, entry_id, entry_order) VALUES (?, ?, ?, ?, ?)')
    .run(row.id, sessionId, nativeDelivery.sessionId, nativeDelivery.entryId, nativeDelivery.entryOrder)
   // A legacy user already has a settled position alongside untagged replies.
   // Register proof without migrating just that row into a new native epoch.
   if (row.invoked_at !== null) return 0
   const position = nativeDisplayPosition(db, sessionId, { ...nativeDelivery, eventOrder: 0 })
   db.prepare('UPDATE messages SET invoked_at = ?, position_at = ?, position_order = ?, position_event = 0 WHERE id = ?')
    .run(Date.parse(nativeDelivery.deliveredAt), position.at, position.order, row.id)
   bumpMessageEpoch(db, sessionId)
   return 1
  }
  const position = hostReceiptPosition(db, sessionId)
  const changes = db.prepare(
   `UPDATE messages
             SET invoked_at = ?, position_at = ?, position_order = ?, position_event = ?
             WHERE session_id = ?
               AND local_id IN (${placeholders})
               AND invoked_at IS NULL
               AND NOT EXISTS (SELECT 1 FROM message_input_resolutions r WHERE r.message_id = messages.id)`
  ).run(invokedAt, position?.at ?? null, position?.order ?? null, position?.eventOrder ?? null, sessionId, ...localIds).changes
  // An acknowledgement can insert an executed prompt behind a tail cursor.
  // First-write-wins also prevents duplicate acks from invalidating again.
  if (changes > 0) bumpMessageEpoch(db, sessionId)
  return changes
 })()
}

/** Settle immediate queued rows on an archived clear source without touching
 * scheduled rows, which must remain uninvoked for transfer to the replacement. */
export function markUninvokedImmediateMessages(
 db: Database,
 sessionId: string,
 invokedAt: number
): string[] {
 // INDEXED BY (here and below in the /clear helpers): same reason as the
 // queued lookups above - without sqlite_stat1 the planner walks the whole
 // session history through idx_messages_session.
 const rows = db.prepare(`
        SELECT local_id FROM messages INDEXED BY idx_messages_local_id
        WHERE session_id = ?
          AND local_id IS NOT NULL
          AND scheduled_at IS NULL
          AND invoked_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM message_input_resolutions r WHERE r.message_id = messages.id)
        ORDER BY seq ASC
    `).all(sessionId) as Array<{ local_id: string }>
 if (rows.length === 0) return []

 db.prepare(`
        UPDATE messages INDEXED BY idx_messages_local_id
        SET invoked_at = ?
        WHERE session_id = ?
          AND local_id IS NOT NULL
          AND scheduled_at IS NULL
          AND invoked_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM message_input_resolutions r WHERE r.message_id = messages.id)
    `).run(invokedAt, sessionId)
 bumpMessageEpoch(db, sessionId)
 return rows.map((row) => row.local_id)
}

/**
 * Reassign only uninvoked scheduled rows when an archived OpenCode session
 * is replaced by /clear. The transaction preserves ids/localIds so the normal
 * scheduled-message ack path continues on the replacement session.
 */
export function moveUninvokedScheduledMessages(
 db: Database,
 fromSessionId: string,
 toSessionId: string
): number {
 if (fromSessionId === toSessionId) return 0

 const rows = db.prepare(`
        SELECT id FROM messages INDEXED BY idx_messages_scheduled_pending
        WHERE session_id = ?
          AND scheduled_at IS NOT NULL
          AND invoked_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM message_input_resolutions r WHERE r.message_id = messages.id)
        ORDER BY seq ASC
    `).all(fromSessionId) as Array<{ id: string }>
 if (rows.length === 0) return 0

 try {
  db.exec('BEGIN')
  let nextSeq = getMaxSeq(db, toSessionId)
  const update = db.prepare('UPDATE messages SET session_id = ?, seq = ? WHERE id = ?')
  for (const row of rows) {
   nextSeq += 1
   update.run(toSessionId, nextSeq, row.id)
  }
  bumpMessageEpoch(db, fromSessionId)
  bumpMessageEpoch(db, toSessionId)
  db.exec('COMMIT')
  return rows.length
 } catch (error) {
  db.exec('ROLLBACK')
  throw error
 }
}

/**
 * Move every still-held prompt to a reserved replacement, preserving FIFO.
 * If both sessions already contain the same non-null localId, the replacement
 * row is authoritative (it represents the retry/new owner) and only the
 * uninvoked source duplicate is discarded.
 */
export function moveUninvokedMessages(db: Database, fromSessionId: string, toSessionId: string): number {
 if (fromSessionId === toSessionId) return 0
 return db.transaction(() => {
  const discarded = db.prepare(`
            DELETE FROM messages INDEXED BY idx_messages_local_id
            WHERE session_id = ?
              AND invoked_at IS NULL
              AND local_id IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM message_input_resolutions r WHERE r.message_id = messages.id)
              AND EXISTS (
                  SELECT 1 FROM messages AS target
                  WHERE target.session_id = ?
                    AND target.local_id = messages.local_id
              )
        `).run(fromSessionId, toSessionId).changes
  const rows = db.prepare(`
            SELECT id, session_id FROM messages
            WHERE session_id IN (?, ?) AND invoked_at IS NULL
              AND NOT EXISTS (SELECT 1 FROM message_input_resolutions r WHERE r.message_id = messages.id)
            -- created_at is millisecond-granularity; rowid is the durable
            -- cross-session insertion order for ties within this database.
            ORDER BY created_at ASC,
                     rowid ASC,
                     seq ASC,
                     id ASC
        `).all(fromSessionId, toSessionId) as Array<{ id: string; session_id: string }>
  const moved = rows.filter((row) => row.session_id === fromSessionId).length
  if (discarded === 0 && moved === 0) return 0
  const invokedMax = db.prepare(`
            SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM messages
            WHERE session_id = ? AND (invoked_at IS NOT NULL
              OR EXISTS (SELECT 1 FROM message_input_resolutions r WHERE r.message_id = messages.id))
        `).get(toSessionId) as { maxSeq: number }
  let nextSeq = invokedMax.maxSeq
  const update = db.prepare('UPDATE messages SET session_id = ?, seq = ? WHERE id = ?')
  for (const row of rows) update.run(toSessionId, ++nextSeq, row.id)
  bumpMessageEpoch(db, fromSessionId)
  bumpMessageEpoch(db, toSessionId)
  return discarded + moved
 })()
}

export function mergeSessionMessages(
 db: Database,
 fromSessionId: string,
 toSessionId: string
): { moved: number; oldMaxSeq: number; newMaxSeq: number } {
 if (fromSessionId === toSessionId) {
  return { moved: 0, oldMaxSeq: 0, newMaxSeq: 0 }
 }

 const oldMaxSeq = getMaxSeq(db, fromSessionId)
 const newMaxSeq = getMaxSeq(db, toSessionId)

 try {
  db.exec('BEGIN')

  if (newMaxSeq > 0 && oldMaxSeq > 0) {
   db.prepare(
    'UPDATE messages SET seq = seq + ? WHERE session_id = ?'
   ).run(oldMaxSeq, toSessionId)
  }

  const collisions = db.prepare(`
            SELECT local_id FROM messages
            WHERE session_id = ? AND local_id IS NOT NULL
            INTERSECT
            SELECT local_id FROM messages
            WHERE session_id = ? AND local_id IS NOT NULL
        `).all(toSessionId, fromSessionId) as Array<{ local_id: string }>

  if (collisions.length > 0) {
   const localIds = collisions.map((row) => row.local_id)
   const placeholders = localIds.map(() => '?').join(', ')
   // Force-invoke the older copy: clearing local_id severs its ack path
   // (markMessagesInvoked matches by local_id), so leaving invoked_at
   // NULL would strand the row in the queued floating bar forever.
   // Use COALESCE so an already-invoked row keeps its server timestamp.
   db.prepare(
    `UPDATE messages
                 SET local_id = NULL,
                     invoked_at = COALESCE(invoked_at, created_at)
                 WHERE session_id = ? AND local_id IN (${placeholders})
                   AND NOT EXISTS (SELECT 1 FROM message_input_resolutions r WHERE r.message_id = messages.id)`
   ).run(fromSessionId, ...localIds)
   // Keep terminal evidence while disambiguating the target-owned localId.
   db.prepare(`UPDATE messages SET local_id = local_id || ':merged:' || id
            WHERE session_id = ? AND local_id IN (${placeholders})
              AND EXISTS (SELECT 1 FROM message_input_resolutions r WHERE r.message_id = messages.id)`)
    .run(fromSessionId, ...localIds)
  }

  const result = db.prepare(
   'UPDATE messages SET session_id = ? WHERE session_id = ?'
  ).run(toSessionId, fromSessionId)

  if (result.changes > 0) {
   bumpMessageEpoch(db, fromSessionId)
   bumpMessageEpoch(db, toSessionId)
  }

  db.exec('COMMIT')
  return { moved: result.changes, oldMaxSeq, newMaxSeq }
 } catch (error) {
  db.exec('ROLLBACK')
  throw error
 }
}

/**
 * Truncate transcript at/after the message with `localId`, optionally replacing
 * the removed suffix with `replacement` messages. Bumps message epoch so web
 * clients reset their window.
 */
export function truncateMessagesFromLocalId(
 db: Database,
 sessionId: string,
 localId: string,
 replacement: Array<{
  content: unknown
  localId?: string | null
  createdAt?: number
  invokedAt?: number | null
  resolution?: InputResolution
 }> = []
): { deleted: number; inserted: number; epoch: number } {
 return db.transaction(() => {
  const target = db.prepare(`
            SELECT id, seq, COALESCE(invoked_at, created_at) AS position_at
            FROM messages
            WHERE session_id = ? AND local_id = ?
            LIMIT 1
        `).get(sessionId, localId) as { id: string; seq: number; position_at: number } | undefined

  if (!target) {
   throw new Error(`Message not found for localId: ${localId}`)
  }

  const deleted = db.prepare(`
            DELETE FROM messages
            WHERE session_id = ?
              AND (
                COALESCE(invoked_at, created_at) > ?
                OR (COALESCE(invoked_at, created_at) = ? AND seq >= ?)
              )
        `).run(sessionId, target.position_at, target.position_at, target.seq)

  let inserted = 0
  for (const message of replacement) {
   const now = Date.now()
   const msgSeqRow = db.prepare(
    'SELECT COALESCE(MAX(seq), 0) + 1 AS nextSeq FROM messages WHERE session_id = ?'
   ).get(sessionId) as { nextSeq: number }
   const id = randomUUID()
   const createdAt = message.createdAt ?? now
   const invokedAt = message.resolution ? null : message.invokedAt === undefined ? createdAt : message.invokedAt
   const rowLocalId = message.localId ?? null
   db.prepare(`
                INSERT INTO messages (id, session_id, content, created_at, seq, local_id, invoked_at, scheduled_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
            `).run(
    id,
    sessionId,
    encodeMessageContent(message.content),
    createdAt,
    msgSeqRow.nextSeq,
    rowLocalId,
    invokedAt
   )
   copyMessageResolution(db, id, message.resolution)
   recordMessageTurnStart(db, {
    id, sessionId, content: message.content, createdAt, seq: msgSeqRow.nextSeq,
    localId: rowLocalId, invokedAt, scheduledAt: null
   })
   inserted += 1
  }

  const epoch = bumpMessageEpoch(db, sessionId)
  return { deleted: deleted.changes, inserted, epoch }
 })()
}
