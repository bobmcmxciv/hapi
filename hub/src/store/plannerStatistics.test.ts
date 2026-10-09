import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { Store } from './index'

const dirs: string[] = []
const stores: Store[] = []

function seededStore(): { store: Store; path: string } {
    const dir = mkdtempSync(join(tmpdir(), 'hapi-planner-stats-'))
    dirs.push(dir)
    const path = join(dir, 'hapi.db')
    const store = new Store(path)
    stores.push(store)
    for (let s = 0; s < 20; s += 1) {
        const session = store.sessions.getOrCreateSession(`stats-${s}`, { path: '/tmp', host: 'h' }, null, 'default')
        for (let m = 0; m < 50; m += 1) {
            store.messages.addMessage(session.id, { role: 'agent', content: { type: 'text', text: `m${m}` } }, `local-${s}-${m}`)
        }
    }
    return { store, path }
}

function messageStatRows(path: string): number {
    const db = new Database(path, { readonly: true })
    try {
        const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_stat1'").get()
        if (!table) return 0
        return (db.prepare("SELECT COUNT(*) AS n FROM sqlite_stat1 WHERE tbl = 'messages'").get() as { n: number }).n
    } finally {
        db.close()
    }
}

afterEach(() => {
    for (const store of stores.splice(0)) {
        store.close()
    }
    if (process.platform === 'win32') {
        Bun.gc(true)
    }
    for (const dir of dirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true })
    }
})

describe('Store planner statistics', () => {
    it('rebuilds missing statistics once and then leaves them alone', () => {
        const { store, path } = seededStore()
        expect(messageStatRows(path)).toBe(0)

        const first = store.ensurePlannerStatistics()
        expect(first.rebuilt).toBe(true)
        expect(messageStatRows(path)).toBeGreaterThan(0)

        const second = store.ensurePlannerStatistics()
        expect(second).toEqual({ rebuilt: false, ms: 0 })
        expect(store.optimize()).toBeGreaterThanOrEqual(0)
    })

    it('caps the WAL size kept after checkpoints', () => {
        const { store } = seededStore()
        // journal_size_limit is per connection; read it from the Store's own handle.
        const limit = (store as unknown as { db: Database }).db.prepare('PRAGMA journal_size_limit').get() as Record<string, number>
        expect(Object.values(limit)[0]).toBe(67108864)
    })
})
