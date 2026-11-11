import type { Database } from 'bun:sqlite'

export type NativeMessageOrder = {
 sessionId: string
 entryId: string
 entryOrder: number
 eventOrder: number
}
export type NativeDelivery = Omit<NativeMessageOrder, 'eventOrder'> & { deliveredAt: string }
export type DisplayPosition = { at: number; order: number; eventOrder: number }

const initialized = new WeakSet<Database>()
export const POSITION_AT = 'COALESCE(position_at, invoked_at, created_at)'
export const POSITION_ORDER = 'COALESCE(position_order, 0)'
export const POSITION_EVENT = 'COALESCE(position_event, 0)'

/** Metadata-only additive migration: old transcripts are neither decoded nor rewritten. */
export function initializeMessageOrdering(db: Database): void {
 if (initialized.has(db)) return
 const columns = new Set((db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>).map(c => c.name))
 for (const name of ['position_at', 'position_order', 'position_event']) {
  if (!columns.has(name)) db.exec(`ALTER TABLE messages ADD COLUMN ${name} INTEGER`)
 }
 db.exec(`CREATE TABLE IF NOT EXISTS message_native_sources (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        native_session_id TEXT NOT NULL,
        position_at INTEGER NOT NULL,
        PRIMARY KEY(session_id, native_session_id)
    );
    CREATE TABLE IF NOT EXISTS message_native_deliveries (
        message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        native_session_id TEXT NOT NULL,
        entry_id TEXT NOT NULL,
        entry_order INTEGER NOT NULL,
        UNIQUE(session_id, native_session_id, entry_id)
    );
    CREATE INDEX IF NOT EXISTS idx_messages_native_position ON messages
        (session_id, ${POSITION_AT} DESC, ${POSITION_ORDER} DESC, ${POSITION_EVENT} DESC, seq DESC);`)
 initialized.add(db)
}

export function nativeDisplayPosition(db: Database, sessionId: string, origin: NativeMessageOrder): DisplayPosition {
 if (!origin.sessionId || !origin.entryId || !Number.isSafeInteger(origin.entryOrder) || origin.entryOrder < 1
  || !Number.isSafeInteger(origin.eventOrder) || origin.eventOrder < 0) {
  throw new Error('Invalid authoritative native message order')
 }
 let source = db.prepare('SELECT position_at FROM message_native_sources WHERE session_id = ? AND native_session_id = ?')
  .get(sessionId, origin.sessionId) as { position_at: number } | undefined
 if (!source) {
  const head = db.prepare(`SELECT ${POSITION_AT} AS at FROM messages WHERE session_id = ?
            ORDER BY ${POSITION_AT} DESC, ${POSITION_ORDER} DESC, ${POSITION_EVENT} DESC, seq DESC LIMIT 1`)
   .get(sessionId) as { at: number } | undefined
  const at = Math.max(Date.now(), (head?.at ?? 0) + 1)
  db.prepare('INSERT INTO message_native_sources(session_id, native_session_id, position_at) VALUES (?, ?, ?)')
   .run(sessionId, origin.sessionId, at)
  source = { position_at: at }
 }
 return { at: source.position_at, order: origin.entryOrder, eventOrder: origin.eventOrder }
}

export function rowDisplayPosition(row: { position_at?: number | null; position_order?: number | null; position_event?: number | null }): { position?: DisplayPosition } {
 return row.position_at == null ? {} : {
  position: { at: row.position_at, order: row.position_order ?? 0, eventOrder: row.position_event ?? 0 }
 }
}

/** Host-only terminal evidence has no native identity. Append it to the current
 * observed native coordinate, not a wall-time bucket after every future turn. */
export function hostReceiptPosition(db: Database, sessionId: string): DisplayPosition | undefined {
 const source = db.prepare('SELECT position_at FROM message_native_sources WHERE session_id = ? ORDER BY position_at DESC LIMIT 1')
  .get(sessionId) as { position_at: number } | undefined
 if (!source) return undefined
 const head = db.prepare(`SELECT position_order, position_event FROM messages
        WHERE session_id = ? AND position_at = ? ORDER BY position_order DESC, position_event DESC, seq DESC LIMIT 1`)
  .get(sessionId, source.position_at) as { position_order: number; position_event: number } | undefined
 return { at: source.position_at, order: head?.position_order ?? 0, eventOrder: (head?.position_event ?? 0) + 1 }
}
