import type { Database } from 'bun:sqlite'

export type OmpSourceBinding = { sourceId: string | null; attemptId: string | null }

/** Sparse nonce/generation evidence; the legacy gate also checks authoritative metadata. No history scan. */
export class OmpSourceStore {
    constructor(private readonly db: Database) {
        db.exec(`
            CREATE TABLE IF NOT EXISTS session_omp_sources (
                session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
                source_id TEXT,
                attempt_id TEXT
            );
            CREATE TABLE IF NOT EXISTS session_omp_retired_sources (
                session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                source_id TEXT NOT NULL,
                PRIMARY KEY (session_id, source_id)
            );
        `)
    }

    get(sessionId: string): OmpSourceBinding | null {
        const row = this.db.prepare('SELECT source_id, attempt_id FROM session_omp_sources WHERE session_id = ?')
            .get(sessionId) as { source_id: string | null; attempt_id: string | null } | null
        return row ? { sourceId: row.source_id, attemptId: row.attempt_id } : null
    }


    /** Generation-only marker: never overwrite a bound row's authoritative attempt. */
    observeGeneration(sessionId: string, attemptId: string): void {
        this.db.prepare(`INSERT INTO session_omp_sources (session_id, source_id, attempt_id) VALUES (?, NULL, ?)
            ON CONFLICT(session_id) DO UPDATE SET attempt_id = excluded.attempt_id
            WHERE session_omp_sources.source_id IS NULL`)
            .run(sessionId, attemptId)
    }

    /** A verified disposal ends legacy compatibility even if no nonce was reported. */
    closeLegacyCompatibility(sessionId: string): void {
        this.db.prepare('INSERT OR IGNORE INTO session_omp_sources (session_id, source_id, attempt_id) VALUES (?, NULL, NULL)')
            .run(sessionId)
    }
    isRetired(sessionId: string, sourceId: string): boolean {
        return this.db.prepare('SELECT 1 FROM session_omp_retired_sources WHERE session_id = ? AND source_id = ?')
            .get(sessionId, sourceId) !== null
    }
    /** Permanently fences a dead generation's nonce; durable across Hub restarts. */
    retire(sessionId: string, sourceId: string): void {
        this.db.prepare('INSERT OR IGNORE INTO session_omp_retired_sources (session_id, source_id) VALUES (?, ?)')
            .run(sessionId, sourceId)
    }


    /** Same-attempt replacement needs an authoritative new resume attempt, even after Hub restart. */
    claim(sessionId: string, sourceId: string, attemptId: string | null): boolean {
        return this.db.transaction(() => {
            if (this.isRetired(sessionId, sourceId)) return false
            const previous = this.get(sessionId)
            if (previous?.sourceId && previous.sourceId !== sourceId) {
                if (previous.attemptId === attemptId) return false
                this.retire(sessionId, previous.sourceId)
            }
            this.db.prepare(`INSERT INTO session_omp_sources (session_id, source_id, attempt_id) VALUES (?, ?, ?)
                ON CONFLICT(session_id) DO UPDATE SET source_id = excluded.source_id, attempt_id = excluded.attempt_id`)
                .run(sessionId, sourceId, attemptId)
            return true
        })()
    }
}
