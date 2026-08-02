import { describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from './index'

describe('Store V12/V13→V16 schema reconciliation', () => {
    it('fresh DB has both reconciled tables', async () => {
        const store = new Store(':memory:')
        expect(tableExists(store, 'message_epochs')).toBe(true)
        expect(tableExists(store, 'session_scratchlist')).toBe(true)
        expect(getUserVersion(store)).toBe(20)
        store.close()
    })

    it('scratchlist V12 DB migrates to V16 and preserves existing messages', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-migration-v16-test-'))
        const dbPath = join(dir, 'test.db')
        let store: Store | undefined
        try {
            const db = new Database(dbPath, { create: true, readwrite: true, strict: true })
            db.exec('PRAGMA journal_mode = WAL')
            db.exec('PRAGMA foreign_keys = ON')
            createV12Schema(db)
            db.exec(`
                INSERT INTO sessions (id, created_at, updated_at) VALUES ('session-1', 1, 1);
                INSERT INTO messages (id, session_id, content, created_at, seq, invoked_at)
                VALUES ('message-1', 'session-1', '{}', 1, 1, 1);
                PRAGMA user_version = 12;
            `)
            db.close()

            store = new Store(dbPath)
            expect(tableExists(store, 'message_epochs')).toBe(true)
            expect(tableExists(store, 'session_scratchlist')).toBe(true)
            expect(getUserVersion(store)).toBe(20)
            expect(store.messages.getMessageEpoch('session-1')).toBe(0)
            expect(store.messages.getMessages('session-1')).toHaveLength(1)
        } finally {
            store?.close()
            // 释放对子 store 缓存 prepared statements 的最后一个可达引用，
            // 否则 sqlite3_close_v2 永不真正关闭文件，Windows 下 rm 恒 EBUSY。
            store = undefined
            await rmDirWithRetry(dir)
        }
    })

    it.each([
        ['V12', 12],
        ['V13', 13]
    ] as const)('repairs divergent %s DB missing session_scratchlist', async (_label, version) => {
        const dir = mkdtempSync(join(tmpdir(), `hapi-migration-v${version}-repair-test-`))
        const dbPath = join(dir, 'test.db')
        let store: Store | undefined
        try {
            const db = new Database(dbPath, { create: true, readwrite: true, strict: true })
            db.exec('PRAGMA journal_mode = WAL')
            db.exec('PRAGMA foreign_keys = ON')
            createV12Schema(db)
            db.exec(`
                DROP TABLE session_scratchlist;
                CREATE TABLE message_epochs (
                    session_id TEXT PRIMARY KEY,
                    epoch INTEGER NOT NULL DEFAULT 0,
                    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
                );
                INSERT INTO sessions (id, created_at, updated_at) VALUES ('session-1', 1, 1);
                INSERT INTO messages (id, session_id, content, created_at, seq, invoked_at)
                VALUES ('message-1', 'session-1', '{}', 1, 1, 1);
                PRAGMA user_version = ${version};
            `)
            db.close()

            store = new Store(dbPath)
            expect(tableExists(store, 'message_epochs')).toBe(true)
            expect(tableExists(store, 'session_scratchlist')).toBe(true)
            expect(getUserVersion(store)).toBe(20)
            expect(store.messages.getMessages('session-1')).toHaveLength(1)
        } finally {
            store?.close()
            // 释放对子 store 缓存 prepared statements 的最后一个可达引用，
            // 否则 sqlite3_close_v2 永不真正关闭文件，Windows 下 rm 恒 EBUSY。
            store = undefined
            await rmDirWithRetry(dir)
        }
    })
})

function tableExists(store: Store, name: string): boolean {
    const db: Database = (store as unknown as { db: Database }).db
    const row = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
    ).get(name) as { name: string } | null
    return row !== null
}

function getUserVersion(store: Store): number {
    const db: Database = (store as unknown as { db: Database }).db
    const row = db.prepare('PRAGMA user_version').get() as { user_version: number }
    return row.user_version
}

function createV12Schema(db: Database): void {
    db.exec(`
        CREATE TABLE sessions (
            id TEXT PRIMARY KEY,
            tag TEXT,
            namespace TEXT NOT NULL DEFAULT 'default',
            machine_id TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            metadata TEXT,
            metadata_version INTEGER DEFAULT 1,
            agent_state TEXT,
            agent_state_version INTEGER DEFAULT 1,
            model TEXT,
            model_reasoning_effort TEXT,
            effort TEXT,
            service_tier TEXT,
            todos TEXT,
            todos_updated_at INTEGER,
            team_state TEXT,
            team_state_updated_at INTEGER,
            active INTEGER DEFAULT 0,
            active_at INTEGER,
            seq INTEGER DEFAULT 0
        );
        CREATE TABLE machines (
            id TEXT PRIMARY KEY,
            namespace TEXT NOT NULL DEFAULT 'default',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            metadata TEXT,
            metadata_version INTEGER DEFAULT 1,
            runner_state TEXT,
            runner_state_version INTEGER DEFAULT 1,
            active INTEGER DEFAULT 0,
            active_at INTEGER,
            seq INTEGER DEFAULT 0
        );
        CREATE TABLE messages (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            seq INTEGER NOT NULL,
            local_id TEXT,
            invoked_at INTEGER,
            scheduled_at INTEGER,
            FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
        );
        CREATE TABLE users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            platform TEXT NOT NULL,
            platform_user_id TEXT NOT NULL,
            namespace TEXT NOT NULL DEFAULT 'default',
            created_at INTEGER NOT NULL,
            UNIQUE(platform, platform_user_id)
        );
        CREATE TABLE push_subscriptions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            namespace TEXT NOT NULL,
            endpoint TEXT NOT NULL,
            p256dh TEXT NOT NULL,
            auth TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            UNIQUE(namespace, endpoint)
        );
        CREATE TABLE fcm_devices (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            namespace TEXT NOT NULL,
            token TEXT NOT NULL,
            platform TEXT NOT NULL,
            device_id TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            UNIQUE(namespace, device_id, platform)
        );
        CREATE TABLE session_scratchlist (
            session_id TEXT NOT NULL,
            entry_id TEXT NOT NULL,
            text TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (session_id, entry_id),
            FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
        );
    `)
}

// bun 的 rmSync 不实现 maxRetries；sqlite3_close_v2 把文件句柄挂到 GC 上，
// Windows 上目录删除会 EBUSY。强制回收后重试（与 Store.close 同一模式）。
async function rmDirWithRetry(dir: string): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
        try {
            rmSync(dir, { recursive: true, force: true })
            return
        } catch (error) {
            if (attempt >= 50) throw error
            Bun.gc(true)
            // 必须真正让出事件循环：bun:sqlite 的句柄 finalize 挂在 loop 上，
            // sleepSync 会把它饿死，重试永远打不中。
            await Bun.sleep(100)
        }
    }
}
