import type { Database } from 'bun:sqlite'
import { isUserTurnContent, type TurnPosition } from '@hapi/protocol/messageTurns'
import { decodeMessageContent } from './contentCodec'
import type { StoredMessage } from './types'
import { hydrateMessageResolutions, initializeMessageResolutions } from './messageResolutions'
import { initializeMessageOrdering, rowDisplayPosition } from './messageOrdering'

const initialized = new WeakSet<Database>()
const preparations = new WeakMap<Database, Map<string, Promise<void>>>()
const INDEX_BATCH_SIZE = 128

/** Sparse, lazily populated user-boundary index. No transcript decoding at startup. */
export function initializeMessageTurnIndex(db: Database): void {
 initializeMessageOrdering(db)
 initializeMessageResolutions(db)
 if (initialized.has(db)) return
 db.exec(`
        CREATE TABLE IF NOT EXISTS message_turn_starts (
            message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
            session_id TEXT NOT NULL,
            position_at INTEGER NOT NULL,
            seq INTEGER NOT NULL,
            invoked INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_message_turn_starts_position
            ON message_turn_starts(session_id, position_at DESC, seq DESC) WHERE invoked = 1;
        CREATE TABLE IF NOT EXISTS message_turn_coverage (
            session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
            cursor_seq INTEGER NOT NULL DEFAULT 0,
            complete INTEGER NOT NULL DEFAULT 0
        );
        CREATE TRIGGER IF NOT EXISTS message_turn_update AFTER UPDATE OF session_id, seq, invoked_at ON messages
        BEGIN
            UPDATE message_turn_starts SET session_id = NEW.session_id,
                position_at = COALESCE(NEW.invoked_at, NEW.created_at), seq = NEW.seq,
                invoked = (NEW.invoked_at IS NOT NULL)
                WHERE message_id = NEW.id;
            DELETE FROM message_turn_coverage
                WHERE OLD.session_id != NEW.session_id AND session_id IN (OLD.session_id, NEW.session_id);
        END;
        CREATE TRIGGER IF NOT EXISTS message_turn_delete AFTER DELETE ON messages
        BEGIN
            DELETE FROM message_turn_starts WHERE message_id = OLD.id;
        END;
    `)
 const columns = new Set((db.prepare('PRAGMA table_info(message_turn_starts)').all() as Array<{ name: string }>).map(c => c.name))
 for (const name of ['position_order', 'position_event']) {
  if (!columns.has(name)) db.exec(`ALTER TABLE message_turn_starts ADD COLUMN ${name} INTEGER NOT NULL DEFAULT 0`)
 }
 db.exec(`DROP TRIGGER IF EXISTS message_turn_update;
 CREATE TRIGGER message_turn_update AFTER UPDATE OF session_id, seq, invoked_at, position_at, position_order, position_event ON messages
 BEGIN
  UPDATE message_turn_starts SET session_id = NEW.session_id,
   position_at = COALESCE(NEW.position_at, NEW.invoked_at, NEW.created_at),
   position_order = COALESCE(NEW.position_order, 0), position_event = COALESCE(NEW.position_event, 0),
   seq = NEW.seq, invoked = (NEW.invoked_at IS NOT NULL) WHERE message_id = NEW.id;
  DELETE FROM message_turn_coverage WHERE OLD.session_id != NEW.session_id AND session_id IN (OLD.session_id, NEW.session_id);
 END;
 CREATE INDEX IF NOT EXISTS idx_message_turn_starts_native_position ON message_turn_starts
 (session_id, position_at DESC, position_order DESC, position_event DESC, seq DESC) WHERE invoked = 1;`)
 initialized.add(db)
}

export function recordMessageTurnStart(db: Database, message: StoredMessage): void {
 if (!isUserTurnContent(message.content)) return
 initializeMessageTurnIndex(db)
 db.prepare(`INSERT OR REPLACE INTO message_turn_starts
        (message_id, session_id, position_at, position_order, position_event, seq, invoked) VALUES (?, ?, ?, ?, ?, ?, ?)`)
  .run(message.id, message.sessionId, message.position?.at ?? message.invokedAt ?? message.createdAt,
   message.position?.order ?? 0, message.position?.eventOrder ?? 0, message.seq, message.invokedAt === null ? 0 : 1)
}

type IndexedRow = {
 id: string
 session_id: string
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

function decodeRow(row: IndexedRow): StoredMessage {
 return {
  id: row.id, sessionId: row.session_id, content: decodeMessageContent(row.content),
  createdAt: row.created_at, seq: row.seq, localId: row.local_id,
  invokedAt: row.invoked_at, scheduledAt: row.scheduled_at, ...rowDisplayPosition(row)
 }
}

/** The first requested session is indexed in bounded batches, yielding between
 * them. Completed coverage is reused; normal writes maintain sparse boundaries.
 * Concurrent callers share one promise, and moves invalidate persisted coverage. */
export function prepareMessageTurnIndex(db: Database, sessionId: string): Promise<void> {
 initializeMessageTurnIndex(db)
 let pending = preparations.get(db)
 if (!pending) {
  pending = new Map()
  preparations.set(db, pending)
 }
 const existing = pending.get(sessionId)
 if (existing) return existing
 const task = (async () => {
  while (true) {
   const complete = db.transaction(() => {
    const coverage = db.prepare('SELECT cursor_seq, complete FROM message_turn_coverage WHERE session_id = ?')
     .get(sessionId) as { cursor_seq: number; complete: number } | undefined
    if (coverage?.complete) return true
    const rows = db.prepare(`SELECT * FROM messages WHERE session_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`)
     .all(sessionId, coverage?.cursor_seq ?? 0, INDEX_BATCH_SIZE) as IndexedRow[]
    for (const row of rows) recordMessageTurnStart(db, decodeRow(row))
    const done = rows.length < INDEX_BATCH_SIZE
    db.prepare(`INSERT INTO message_turn_coverage (session_id, cursor_seq, complete) VALUES (?, ?, ?)
                    ON CONFLICT(session_id) DO UPDATE SET cursor_seq = excluded.cursor_seq, complete = excluded.complete`)
     .run(sessionId, rows.at(-1)?.seq ?? coverage?.cursor_seq ?? 0, done ? 1 : 0)
    return done
   })()
   if (complete) return
   const { promise, resolve } = Promise.withResolvers<void>()
   setTimeout(resolve, 0)
   await promise
  }
 })().finally(() => pending.delete(sessionId))
 pending.set(sessionId, task)
 return task
}

export function requireMessageTurnIndex(db: Database, sessionId: string): void {
 const coverage = db.prepare('SELECT complete FROM message_turn_coverage WHERE session_id = ?')
  .get(sessionId) as { complete: number } | undefined
 if (!coverage?.complete) throw new Error('Turn history index is not ready; await prepareMessageTurnIndex first')
}

export type StoredTurnStart = TurnPosition & { id: string }
type TurnRow = { message_id: string; position_at: number; position_order: number; position_event: number; seq: number }
const turnPosition = (row: Omit<TurnRow, 'message_id'>): TurnPosition => ({
 at: row.position_at,
 ...(row.position_order || row.position_event ? { order: row.position_order, eventOrder: row.position_event } : {}),
 seq: row.seq
})

export function getTurnStartsBefore(db: Database, sessionId: string, before: TurnPosition, limit: number, inclusive = false): StoredTurnStart[] {
 const rows = db.prepare(`SELECT message_id, position_at, position_order, position_event, seq FROM message_turn_starts
        WHERE session_id = ? AND invoked = 1 AND (position_at, position_order, position_event, seq) ${inclusive ? '<=' : '<'} (?, ?, ?, ?)
        ORDER BY position_at DESC, position_order DESC, position_event DESC, seq DESC LIMIT ?`)
  .all(sessionId, before.at, before.order ?? 0, before.eventOrder ?? 0, before.seq, limit) as TurnRow[]
 return rows.map((row) => ({ id: row.message_id, ...turnPosition(row) }))
}

export function getSelectedTurnBounds(db: Database, sessionId: string, turnId: string): {
 start: StoredTurnStart
 next: TurnPosition | null
} | null {
 const start = db.prepare(`SELECT message_id, position_at, position_order, position_event, seq FROM message_turn_starts
        WHERE message_id = ? AND session_id = ? AND invoked = 1`).get(turnId, sessionId) as TurnRow | undefined
 if (!start) return null
 const next = db.prepare(`SELECT position_at, position_order, position_event, seq FROM message_turn_starts
        WHERE session_id = ? AND invoked = 1 AND (position_at, position_order, position_event, seq) > (?, ?, ?, ?)
        ORDER BY position_at ASC, position_order ASC, position_event ASC, seq ASC LIMIT 1`)
  .get(sessionId, start.position_at, start.position_order, start.position_event, start.seq) as TurnRow | undefined
 return {
  start: { id: start.message_id, ...turnPosition(start) },
  next: next ? turnPosition(next) : null
 }
}

/** Seek on the existing display-position index; queued user rows are not history. */
export function getTurnHistoryRows(db: Database, sessionId: string, options: {
 before?: TurnPosition | null
 after?: TurnPosition | null
 from?: TurnPosition | null
 until?: TurnPosition | null
 limit: number
 descending: boolean
}): StoredMessage[] {
 const clauses = ['m.session_id = @sessionId', `NOT EXISTS (
        SELECT 1 FROM message_turn_starts t WHERE t.message_id = m.id AND t.invoked = 0
            AND NOT EXISTS (SELECT 1 FROM message_input_resolutions r WHERE r.message_id = m.id)
    )`]
 const tuple = '(COALESCE(m.position_at, m.invoked_at, m.created_at), COALESCE(m.position_order, 0), COALESCE(m.position_event, 0), m.seq)'
 if (options.before) clauses.push(`${tuple} < (@beforeAt, @beforeOrder, @beforeEvent, @beforeSeq)`)
 if (options.after) clauses.push(`${tuple} > (@afterAt, @afterOrder, @afterEvent, @afterSeq)`)
 if (options.from) clauses.push(`${tuple} >= (@fromAt, @fromOrder, @fromEvent, @fromSeq)`)
 if (options.until) clauses.push(`${tuple} <= (@untilAt, @untilOrder, @untilEvent, @untilSeq)`)
 const order = options.descending ? 'DESC' : 'ASC'
 const rows = db.prepare(`SELECT m.* FROM messages m INDEXED BY idx_messages_native_position
        WHERE ${clauses.join(' AND ')}
        ORDER BY COALESCE(m.position_at, m.invoked_at, m.created_at) ${order}, COALESCE(m.position_order, 0) ${order}, COALESCE(m.position_event, 0) ${order}, m.seq ${order} LIMIT @limit`)
  .all({
   sessionId,
   beforeAt: options.before?.at ?? null, beforeSeq: options.before?.seq ?? null,
   afterAt: options.after?.at ?? null, afterSeq: options.after?.seq ?? null,
   fromAt: options.from?.at ?? null, fromSeq: options.from?.seq ?? null,
   untilAt: options.until?.at ?? null, untilSeq: options.until?.seq ?? null,
   beforeOrder: options.before?.order ?? 0, beforeEvent: options.before?.eventOrder ?? 0,
   afterOrder: options.after?.order ?? 0, afterEvent: options.after?.eventOrder ?? 0,
   fromOrder: options.from?.order ?? 0, fromEvent: options.from?.eventOrder ?? 0,
   untilOrder: options.until?.order ?? 0, untilEvent: options.until?.eventOrder ?? 0,
   limit: options.limit
  }) as IndexedRow[]
 if (options.descending) rows.reverse()
 return hydrateMessageResolutions(db, rows.map(decodeRow))
}
