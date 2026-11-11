import type { Database } from 'bun:sqlite'
import type { InputResolution } from '@hapi/protocol/types'
import type { StoredMessage } from './types'
import { nativeDisplayPosition, hostReceiptPosition, type NativeMessageOrder } from './messageOrdering'
import type { DisplayPosition } from './messageOrdering'

const initialized = new WeakSet<Database>()

/** Additive sparse evidence; no transcript scan or schema-version migration. */
export function initializeMessageResolutions(db: Database): void {
 if (initialized.has(db)) return
 db.exec(`
        CREATE TABLE IF NOT EXISTS message_input_resolutions (
            message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
            outcome TEXT NOT NULL CHECK (outcome IN ('handled', 'cancelled')),
            resolved_at INTEGER NOT NULL
        );
        CREATE TRIGGER IF NOT EXISTS message_resolution_requires_uninvoked
        BEFORE INSERT ON message_input_resolutions
        WHEN EXISTS (SELECT 1 FROM messages WHERE id = NEW.message_id AND invoked_at IS NOT NULL)
        BEGIN SELECT RAISE(IGNORE); END;
        CREATE TRIGGER IF NOT EXISTS message_resolution_blocks_invocation
        BEFORE UPDATE OF invoked_at ON messages
        WHEN NEW.invoked_at IS NOT NULL AND EXISTS (
            SELECT 1 FROM message_input_resolutions WHERE message_id = OLD.id
        )
        BEGIN SELECT RAISE(IGNORE); END;
    `)
 initialized.add(db)
}

/** Hydrate only the selected rows, in bounded batches, never a per-row history query. */
export function hydrateMessageResolutions(db: Database, messages: StoredMessage[]): StoredMessage[] {
 for (let offset = 0; offset < messages.length; offset += 400) {
  const batch = messages.slice(offset, offset + 400)
  const rows = db.prepare(`SELECT message_id, outcome, resolved_at FROM message_input_resolutions
            WHERE message_id IN (${batch.map(() => '?').join(',')})`)
   .all(...batch.map(message => message.id)) as Array<{ message_id: string; outcome: InputResolution['outcome']; resolved_at: number }>
  const byId = new Map(rows.map(row => [row.message_id, { outcome: row.outcome, resolvedAt: row.resolved_at }]))
  for (const message of batch) {
   const resolution = byId.get(message.id)
   if (resolution) message.resolution = resolution
  }
 }
 return messages
}

export function resolveMessages(db: Database, sessionId: string,
 resolutions: Array<{ localId: string; outcome: InputResolution['outcome']; nativeOrder?: NativeMessageOrder }>, resolvedAt: number
): Array<{ localId: string; resolution: InputResolution; position?: DisplayPosition }> {
 if (resolutions.length === 0) return []
 return db.transaction(() => {
  const insert = db.prepare(`INSERT OR IGNORE INTO message_input_resolutions (message_id, outcome, resolved_at)
            SELECT id, ?, ? FROM messages
            WHERE session_id = ? AND local_id = ? AND invoked_at IS NULL`)
  let changed = false
  for (const input of resolutions) {
   const inserted = insert.run(input.outcome, resolvedAt, sessionId, input.localId).changes > 0
   if (inserted) {
    const position = input.nativeOrder ? nativeDisplayPosition(db, sessionId, input.nativeOrder) : hostReceiptPosition(db, sessionId)
    if (position) db.prepare(`UPDATE messages SET position_at = ?, position_order = ?, position_event = ?
     WHERE session_id = ? AND local_id = ? AND invoked_at IS NULL`)
     .run(position.at, position.order, position.eventOrder, sessionId, input.localId)
   }
   changed = inserted || changed
  }
  if (changed) db.prepare(`INSERT INTO message_epochs (session_id, epoch) VALUES (?, 1)
            ON CONFLICT(session_id) DO UPDATE SET epoch = epoch + 1`).run(sessionId)
  const result: Array<{ localId: string; resolution: InputResolution; position?: DisplayPosition }> = []
  const ids = [...new Set(resolutions.map(input => input.localId))]
  for (let offset = 0; offset < ids.length; offset += 400) {
   const batch = ids.slice(offset, offset + 400)
   const rows = db.prepare(`SELECT m.local_id, r.outcome, r.resolved_at, m.position_at, m.position_order, m.position_event
                FROM messages m JOIN message_input_resolutions r ON r.message_id = m.id
                WHERE m.session_id = ? AND m.local_id IN (${batch.map(() => '?').join(',')}) ORDER BY m.seq`)
    .all(sessionId, ...batch) as Array<{ local_id: string; outcome: InputResolution['outcome']; resolved_at: number; position_at: number | null; position_order: number | null; position_event: number | null }>
   for (const row of rows) result.push({
    localId: row.local_id, resolution: { outcome: row.outcome, resolvedAt: row.resolved_at },
    ...(row.position_at != null ? { position: { at: row.position_at, order: row.position_order ?? 0, eventOrder: row.position_event ?? 0 } } : {})
   })
  }
  return result
 })()
}

/** Copy evidence verbatim, never turn a terminal admission into invocation. */
export function copyMessageResolution(db: Database, id: string, resolution?: InputResolution): void {
 if (resolution) db.prepare(`INSERT OR IGNORE INTO message_input_resolutions (message_id, outcome, resolved_at)
        VALUES (?, ?, ?)`).run(id, resolution.outcome, resolution.resolvedAt)
}
