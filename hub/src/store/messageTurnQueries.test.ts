import { describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { encodeMessageContent } from './contentCodec'
import {
    initializeMessageTurnIndex,
    prepareMessageTurnIndex,
    getTurnStartsBefore,
    getTurnHistoryRows
} from './messageTurnQueries'

function legacyDatabase() {
    const db = new Database(':memory:')
    db.exec(`PRAGMA foreign_keys = ON;
        CREATE TABLE sessions (id TEXT PRIMARY KEY);
        INSERT INTO sessions VALUES ('session');
        CREATE TABLE messages (
            id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
            content BLOB, created_at INTEGER NOT NULL, seq INTEGER NOT NULL,
            local_id TEXT, invoked_at INTEGER, scheduled_at INTEGER
        );
        CREATE INDEX idx_messages_session ON messages(session_id, seq);
        CREATE INDEX idx_messages_session_position ON messages(session_id, COALESCE(invoked_at, created_at) DESC, seq DESC);
    `)
    return db
}

describe('lazy sparse turn index', () => {
    it('does not decode history at initialization; prepares a single session in yielding batches and reuses coverage', async () => {
        const db = legacyDatabase()
        const insert = db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, NULL, ?, NULL)')
        for (let seq = 1; seq <= 300; seq++) {
            const role = seq % 100 === 1 ? 'user' : 'agent'
            insert.run(`m${seq}`, 'session', encodeMessageContent({ message: { role, content: 'x'.repeat(1000) } }), seq, seq, seq)
        }
        initializeMessageTurnIndex(db)
        expect(db.prepare('SELECT COUNT(*) AS count FROM message_turn_starts').get()).toEqual({ count: 0 })
        const preparation = prepareMessageTurnIndex(db, 'session')
        expect(prepareMessageTurnIndex(db, 'session')).toBe(preparation)
        const partial = db.prepare('SELECT cursor_seq, complete FROM message_turn_coverage').get() as { cursor_seq: number; complete: number }
        expect(partial.cursor_seq).toBeLessThan(300)
        expect(partial.complete).toBe(0)
        await preparation
        expect(getTurnStartsBefore(db, 'session', { at: 301, seq: 301 }, 3).map((row) => row.id)).toEqual(['m201', 'm101', 'm1'])
        const coverage = db.prepare('SELECT cursor_seq, complete FROM message_turn_coverage').get()
        await prepareMessageTurnIndex(db, 'session')
        expect(db.prepare('SELECT cursor_seq, complete FROM message_turn_coverage').get()).toEqual(coverage)
        db.close()
    })

    it('updates consumed/moved boundary positions and removes deleted starts without rebuilding completed sessions', async () => {
        const db = legacyDatabase()
        db.prepare('INSERT INTO messages VALUES (?, ?, ?, 100, 1, ?, NULL, NULL)')
            .run('queued', 'session', encodeMessageContent({ role: 'user', content: 'held' }), 'local')
        initializeMessageTurnIndex(db)
        await prepareMessageTurnIndex(db, 'session')
        expect(getTurnHistoryRows(db, 'session', { limit: 10, descending: true })).toEqual([])
        db.prepare('UPDATE messages SET invoked_at = 200 WHERE id = ?').run('queued')
        expect(getTurnStartsBefore(db, 'session', { at: 201, seq: 1 }, 1)[0]).toEqual({ id: 'queued', at: 200, seq: 1 })
        db.exec("INSERT INTO sessions VALUES ('target')")
        db.prepare('UPDATE messages SET session_id = ?, seq = 10 WHERE id = ?').run('target', 'queued')
        expect(db.prepare('SELECT * FROM message_turn_coverage WHERE session_id = ?').get('session')).toBeNull()
        await prepareMessageTurnIndex(db, 'target')
        expect(getTurnStartsBefore(db, 'target', { at: 201, seq: 20 }, 1)[0]).toEqual({ id: 'queued', at: 200, seq: 10 })
        db.prepare('DELETE FROM messages WHERE id = ?').run('queued')
        expect(getTurnStartsBefore(db, 'target', { at: 201, seq: 20 }, 1)).toEqual([])
        db.close()
    })
})
