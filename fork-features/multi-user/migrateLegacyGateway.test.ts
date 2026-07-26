import { describe, expect, it, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MultiUserGatewayStore } from './gatewayStore'
import { alignCoreSchemaVersion, migrateLegacyMultiUser, TARGET_CORE_SCHEMA_VERSION } from './migrateLegacyGateway'

const dirs: string[] = []

afterEach(() => {
    while (dirs.length > 0) {
        const dir = dirs.pop()!
        try { rmSync(dir, { recursive: true, force: true }) } catch { /* Windows 偶发 EBUSY，不影响断言 */ }
    }
})

function makeDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'hapi-migrate-'))
    dirs.push(dir)
    return dir
}

/**
 * 复刻生产库（ECS `/root/.hapi/hapi.db`，2026-07-26 实测）的旧多用户形态：
 * user_version=13、4 个账号、2 个 token、9 条 machine grant + 9 条 session grant，
 * 其中 6 条 session grant 指向已被删除的 session 行。
 */
function seedLegacyCore(path: string, opts: { userVersion?: number; sessionColumns?: boolean } = {}): void {
    const db = new Database(path, { create: true })
    const extraSessionColumns = opts.sessionColumns === false
        ? ''
        : ', service_tier TEXT, resume_with_session_model INTEGER NOT NULL DEFAULT 0'
    db.exec(`
        CREATE TABLE sessions (id TEXT PRIMARY KEY, owner_account_id INTEGER${extraSessionColumns});
        CREATE TABLE machines (id TEXT PRIMARY KEY, owner_account_id INTEGER);
        CREATE TABLE accounts (
            id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, password_hash TEXT,
            auth_provider TEXT NOT NULL DEFAULT 'local', role TEXT NOT NULL DEFAULT 'user',
            default_namespace TEXT NOT NULL DEFAULT 'default', created_at INTEGER NOT NULL,
            disabled_at INTEGER, memory TEXT
        );
        CREATE TABLE api_tokens (
            id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER NOT NULL, name TEXT,
            token_hash TEXT NOT NULL UNIQUE, namespace TEXT NOT NULL DEFAULT 'default',
            created_at INTEGER NOT NULL, last_used_at INTEGER, revoked_at INTEGER
        );
        CREATE TABLE resource_grants (
            id INTEGER PRIMARY KEY AUTOINCREMENT, resource_type TEXT NOT NULL, resource_id TEXT NOT NULL,
            grantee_account_id INTEGER NOT NULL, role TEXT NOT NULL DEFAULT 'viewer', created_at INTEGER NOT NULL,
            UNIQUE(resource_type, resource_id, grantee_account_id)
        );
    `)
    db.exec(`
        INSERT INTO accounts(id,username,password_hash,role,default_namespace,created_at,memory) VALUES
            (1,'admin','h1','admin','default',1,'我的电脑是 vircs'),
            (2,'peter','h2','user','default',2,'我的电脑是 BIG79TP'),
            (3,'bobmcmxciv','h3','user','default',3,'mac'),
            (4,'mnmn66','h4','user','default',4,NULL);
        INSERT INTO api_tokens(id,account_id,name,token_hash,created_at) VALUES
            (1,1,'Legacy shared token','th1',1),
            (2,2,'homeWin','th2',2);
        INSERT INTO sessions(id,owner_account_id) VALUES ('s-owned-1',1),('s-owned-2',1),('s-noowner',NULL);
        INSERT INTO machines(id,owner_account_id) VALUES ('m-1',1),('m-2',2);
        INSERT INTO resource_grants(resource_type,resource_id,grantee_account_id,role,created_at) VALUES
            ('session','s-owned-1',2,'viewer',1),
            ('session','s-owned-2',2,'operator',2),
            ('session','s-deleted-a',2,'operator',3),
            ('session','s-deleted-b',2,'operator',4),
            ('session','s-noowner',2,'operator',5),
            ('machine','m-1',3,'operator',6),
            ('machine','m-2',2,'operator',7);
    `)
    db.exec(`PRAGMA user_version = ${opts.userVersion ?? 13}`)
    db.close()
}

describe('alignCoreSchemaVersion', () => {
    it('列齐全时把领先的 user_version 落回目标版本', () => {
        const dir = makeDir()
        const corePath = join(dir, 'hapi.db')
        seedLegacyCore(corePath)

        const db = new Database(corePath)
        const result = alignCoreSchemaVersion(db)
        db.close()

        expect(result.before).toBe(13)
        expect(result.after).toBe(TARGET_CORE_SCHEMA_VERSION)
        expect(result.missingColumns).toEqual([])
    })

    it('列真的缺时拒绝改版本号，并报出缺哪几列', () => {
        const dir = makeDir()
        const corePath = join(dir, 'hapi.db')
        seedLegacyCore(corePath, { sessionColumns: false })

        const db = new Database(corePath)
        const result = alignCoreSchemaVersion(db)
        const persisted = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
        db.close()

        expect(result.missingColumns.sort()).toEqual(['resume_with_session_model', 'service_tier'])
        expect(result.after).toBe(13)
        expect(persisted).toBe(13)
    })

    it('版本号不领先时不动它（交给 upstream 自己的 step migration）', () => {
        const dir = makeDir()
        const corePath = join(dir, 'hapi.db')
        seedLegacyCore(corePath, { userVersion: 9 })

        const db = new Database(corePath)
        const result = alignCoreSchemaVersion(db)
        db.close()

        expect(result.before).toBe(9)
        expect(result.after).toBe(9)
    })
})

describe('migrateLegacyMultiUser', () => {
    it('把账号/令牌/所有权/授权搬进 gateway 库并保留 account id', () => {
        const dir = makeDir()
        const corePath = join(dir, 'hapi.db')
        const gatewayPath = join(dir, 'multi-user-gateway.sqlite')
        seedLegacyCore(corePath)

        const report = migrateLegacyMultiUser(corePath, gatewayPath)

        expect(report.status).toBe('migrated')
        expect(report.core.userVersionBefore).toBe(13)
        expect(report.core.userVersionAfter).toBe(TARGET_CORE_SCHEMA_VERSION)
        expect(report.accounts).toBe(4)
        expect(report.tokens).toBe(2)
        expect(report.resources).toEqual({ sessions: 2, machines: 2 })

        const store = new MultiUserGatewayStore(gatewayPath)
        try {
            const peter = store.getAccountByUsername('peter')
            expect(peter?.id).toBe(2)
            expect(peter?.role).toBe('user')
            // 每用户记忆必须跟着搬，否则 CLI 侧的上下文注入会静默变空
            expect(peter?.memory).toBe('我的电脑是 BIG79TP')
            expect(store.getAccountByUsername('admin')?.role).toBe('admin')
            expect(store.countAccounts()).toBe(4)

            const binding = store.getResource('session', 's-owned-1')
            expect(binding?.ownerAccountId).toBe(1)
            expect(binding?.coreNamespace).toBe('default')
        } finally {
            store.close()
        }
    })

    it('跳过指向已删除资源的孤儿授权，并逐条报告而不是静默丢弃', () => {
        const dir = makeDir()
        const corePath = join(dir, 'hapi.db')
        const gatewayPath = join(dir, 'multi-user-gateway.sqlite')
        seedLegacyCore(corePath)

        const report = migrateLegacyMultiUser(corePath, gatewayPath)

        // 7 条 grant：4 条资源有主可迁，3 条指向已删除/无主资源
        expect(report.grants.migrated).toBe(4)
        expect(report.grants.skipped).toHaveLength(3)
        expect(report.grants.skipped.map((grant) => grant.resourceId).sort())
            .toEqual(['s-deleted-a', 's-deleted-b', 's-noowner'])
        for (const skipped of report.grants.skipped) {
            expect(skipped.granteeAccountId).toBe(2)
            expect(skipped.reason).toBe('resource-row-missing')
        }
    })

    it('迁移后的授权在 gateway 库里真的生效（peter 能读到被共享的会话）', () => {
        const dir = makeDir()
        const corePath = join(dir, 'hapi.db')
        const gatewayPath = join(dir, 'multi-user-gateway.sqlite')
        seedLegacyCore(corePath)

        migrateLegacyMultiUser(corePath, gatewayPath)

        const gateway = new Database(gatewayPath)
        try {
            const rows = gateway.prepare(
                'SELECT resource_type, resource_id, role FROM gateway_grants WHERE grantee_account_id = 2 ORDER BY resource_id'
            ).all() as Array<{ resource_type: string; resource_id: string; role: string }>
            expect(rows).toEqual([
                { resource_type: 'machine', resource_id: 'm-2', role: 'operator' },
                { resource_type: 'session', resource_id: 's-owned-1', role: 'viewer' },
                { resource_type: 'session', resource_id: 's-owned-2', role: 'operator' }
            ])
        } finally {
            gateway.close()
        }
    })

    it('先 bootstrap 再迁移会把生产账号挡在门外 —— 固化 startHub 的调用顺序约束', () => {
        const dir = makeDir()
        const corePath = join(dir, 'hapi.db')
        const gatewayPath = join(dir, 'multi-user-gateway.sqlite')
        seedLegacyCore(corePath)

        // 模拟 createMultiUserGatewayStore 在迁移之前跑：空库 → 造一个全新 admin
        const bootstrapped = new MultiUserGatewayStore(gatewayPath)
        bootstrapped.createAccount('admin', 'admin', 'default')
        bootstrapped.close()

        const report = migrateLegacyMultiUser(corePath, gatewayPath)

        // 这正是必须避免的结果：迁移判非空跳过，peter/bobmcmxciv/mnmn66 永久丢失
        expect(report.status).toBe('skipped-gateway-not-empty')
        const store = new MultiUserGatewayStore(gatewayPath)
        try {
            expect(store.countAccounts()).toBe(1)
            expect(store.getAccountByUsername('peter')).toBeNull()
        } finally {
            store.close()
        }
    })

    it('重复执行不会二次导入', () => {
        const dir = makeDir()
        const corePath = join(dir, 'hapi.db')
        const gatewayPath = join(dir, 'multi-user-gateway.sqlite')
        seedLegacyCore(corePath)

        const first = migrateLegacyMultiUser(corePath, gatewayPath)
        const second = migrateLegacyMultiUser(corePath, gatewayPath)

        expect(first.status).toBe('migrated')
        expect(second.status).toBe('skipped-gateway-not-empty')

        const store = new MultiUserGatewayStore(gatewayPath)
        try {
            expect(store.countAccounts()).toBe(4)
        } finally {
            store.close()
        }
    })
})
