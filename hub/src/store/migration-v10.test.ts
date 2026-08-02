import { describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from './index'

describe('Store V10→V11 migration: fcm_devices', async () => {
    it('fresh DB has fcm_devices table', async () => {
        const store = new Store(':memory:')
        expect(tableExists(store, 'fcm_devices')).toBe(true)
    })

    it('V10 DB migrates to V11: fcm_devices created', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-migration-v11-test-'))
        const dbPath = join(dir, 'test.db')
        let store: Store | undefined
        try {
            const db = new Database(dbPath, { create: true, readwrite: true, strict: true })
            db.exec('PRAGMA journal_mode = WAL')
            db.exec('PRAGMA foreign_keys = ON')
            createV10Schema(db)
            db.exec('PRAGMA user_version = 10')
            db.close()

            store = new Store(dbPath)
            expect(tableExists(store, 'fcm_devices')).toBe(true)
        } finally {
            store?.close()
            // 释放对子 store 缓存 prepared statements 的最后一个可达引用，
            // 否则 sqlite3_close_v2 永不真正关闭文件，Windows 下 rm 恒 EBUSY。
            store = undefined
            await rmDirWithRetry(dir)
        }
    })

    it('repairs a V11 DB missing fcm_devices before committing the latest version', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-migration-v11-repair-test-'))
        const dbPath = join(dir, 'test.db')
        let store: Store | undefined
        try {
            const db = new Database(dbPath, { create: true, readwrite: true, strict: true })
            createV10Schema(db)
            db.exec('PRAGMA user_version = 11')
            db.close()

            store = new Store(dbPath)
            expect(tableExists(store, 'fcm_devices')).toBe(true)
            store.close()
            store = undefined

            const migrated = new Database(dbPath, { readonly: true, strict: true })
            try {
                // 必须等于 store/index.ts 的 SCHEMA_VERSION（私有常量未导出）。
                // 旧值 15 在 converge-0.25.1 提到 16 后过期，且一直被 finally 里的
                // EBUSY 清理异常掩盖——bun 每个测试只报最后一个错误。
                expect(readUserVersion(migrated)).toBe(16)
            } finally {
                migrated.close()
            }
        } finally {
            store?.close()
            // 释放对子 store 缓存 prepared statements 的最后一个可达引用，
            // 否则 sqlite3_close_v2 永不真正关闭文件，Windows 下 rm 恒 EBUSY。
            store = undefined
            await rmDirWithRetry(dir)
        }
    })

    it('rolls back repaired tables and version when final schema validation fails', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-migration-v11-rollback-test-'))
        const dbPath = join(dir, 'test.db')
        try {
            const db = new Database(dbPath, { create: true, readwrite: true, strict: true })
            createV10Schema(db)
            db.exec('DROP TABLE machines; PRAGMA user_version = 11')
            db.close()

            expect(() => new Store(dbPath)).toThrow('SQLite schema is missing required tables (machines)')

            const rolledBack = new Database(dbPath, { readonly: true, strict: true })
            try {
                expect(readUserVersion(rolledBack)).toBe(11)
                expect(databaseTableExists(rolledBack, 'fcm_devices')).toBe(false)
            } finally {
                rolledBack.close()
            }
        } finally {
            await rmDirWithRetry(dir)
        }
    })

    it('upsert replaces token for same namespace+deviceId+platform', async () => {
        const store = new Store(':memory:')
        store.fcm.upsertDevice('default', {
            token: 'tok-a',
            platform: 'phone',
            deviceId: 'pixel-1'
        })
        store.fcm.upsertDevice('default', {
            token: 'tok-b',
            platform: 'phone',
            deviceId: 'pixel-1'
        })
        const devices = store.fcm.getDevicesByNamespace('default')
        expect(devices).toHaveLength(1)
        expect(devices[0].token).toBe('tok-b')
    })
})

// bun 的 rmSync 不实现 maxRetries/retryDelay；Windows 上 sqlite 句柄释放有滞后，
// 显式重试直到 EBUSY 消失（断言早已完成，这里只是临时目录清理）。
async function rmDirWithRetry(dir: string): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
        try {
            rmSync(dir, { recursive: true, force: true })
            return
        } catch (error) {
            if (attempt >= 50) throw error
            // 测试自开的 readonly 连接与 prepared statements 走 sqlite3_close_v2，
            // 文件句柄挂在 GC 上；强制回收后 EBUSY 才会消失（与 Store.close 同理）。
            Bun.gc(true)
            await Bun.sleep(100)
        }
    }
}

function tableExists(store: Store, name: string): boolean {
    const db: Database = (store as unknown as { db: Database }).db
    const row = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
    ).get(name) as { name: string } | null
    return row !== null
}

function readUserVersion(db: Database): number {
    const row = db.prepare('PRAGMA user_version').get()
    if (!row || typeof row !== 'object' || !('user_version' in row) || typeof row.user_version !== 'number') {
        throw new Error('PRAGMA user_version did not return a numeric value')
    }
    return row.user_version
}

function databaseTableExists(db: Database, name: string): boolean {
    return db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
    ).get(name) !== null
}

function createV10Schema(db: Database): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
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

        CREATE TABLE IF NOT EXISTS machines (
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

        CREATE TABLE IF NOT EXISTS messages (
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

        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            platform TEXT NOT NULL,
            platform_user_id TEXT NOT NULL,
            namespace TEXT NOT NULL DEFAULT 'default',
            created_at INTEGER NOT NULL,
            UNIQUE(platform, platform_user_id)
        );

        CREATE TABLE IF NOT EXISTS push_subscriptions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            namespace TEXT NOT NULL,
            endpoint TEXT NOT NULL,
            p256dh TEXT NOT NULL,
            auth TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            UNIQUE(namespace, endpoint)
        );
    `)
}
