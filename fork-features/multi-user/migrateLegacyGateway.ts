import { Database } from 'bun:sqlite'
import { MultiUserGatewayStore } from './gatewayStore'

/**
 * One-shot migration from the fork's pre-gateway multi-user schema into the
 * gateway store.
 *
 *背景：本 fork 早期把多用户直接做在 hub 主库里（`accounts` / `api_tokens` /
 * `resource_grants` 三张表 + `sessions.owner_account_id` / `machines.owner_account_id`
 * 两列），并把 SCHEMA_VERSION 推到 13。upstream 后来把整套重写成独立的
 * `multi-user-gateway.sqlite`（`gateway_*` 四张表），主库 SCHEMA_VERSION 停在 11。
 *
 * 两个后果，本模块各治一个：
 *
 * 1. **主库版本号**：upstream 的 `hub/src/store/index.ts` 在
 *    `currentVersion !== SCHEMA_VERSION` 时直接抛错拒绝启动。而 fork 的
 *    v12→v13 与 upstream 的 v10→v11 加的是**同一组列**
 *    （`service_tier` + `resume_with_session_model`），所以 13 号库的**列**
 *    已经满足 v11 的要求，差的只是数字。→ 校验列存在后改写 `PRAGMA user_version`。
 *    旧的 `accounts` 等表保留不删：upstream 的 `assertRequiredTablesPresent()`
 *    只检查白名单**存在**、不禁止多余表，留着还能当回滚安全网。
 *
 * 2. **账号数据**：旧三张表的内容搬进 gateway 库。account id 原样保留，
 *    这样 `sessions.owner_account_id` 里的历史值仍然指向同一个人。
 *
 * 有损的地方（旧列在新 schema 里不存在，明确记录而不是静默丢弃）：
 *   - `accounts.auth_provider` / `accounts.created_at`
 *   - `api_tokens.namespace` / `api_tokens.last_used_at`
 *   - `resource_grants.id` / `resource_grants.created_at`
 *
 * 孤儿授权：`gateway_grants` 有外键指向 `gateway_resources`，而
 * `gateway_resources.owner_account_id` 是 NOT NULL。指向"已被删除的 session 行"
 * 或"owner 为 NULL 的资源"的旧 grant 无法表达，只能跳过——但**必须逐条报告**，
 * 由 operator 判断是无害孤儿还是真实数据丢失。
 *
 * 幂等：gateway 库已有账号时直接返回 `skipped`，不会重复导入。
 */

/** upstream SCHEMA_VERSION=11 要求 sessions 表上必须存在的列。 */
const REQUIRED_SESSION_COLUMNS = ['service_tier', 'resume_with_session_model'] as const

/** 目标主库版本号（= upstream `hub/src/store/index.ts` 的 SCHEMA_VERSION）。 */
export const TARGET_CORE_SCHEMA_VERSION = 11

export type SkippedGrant = {
    resourceType: string
    resourceId: string
    granteeAccountId: number
    role: string
    reason: 'resource-row-missing' | 'owner-null'
}

export type LegacyMigrationReport = {
    status: 'migrated' | 'skipped-gateway-not-empty' | 'skipped-no-legacy-tables'
    core: {
        userVersionBefore: number
        userVersionAfter: number
        missingColumns: string[]
    }
    accounts: number
    tokens: number
    resources: { sessions: number; machines: number }
    grants: { migrated: number; skipped: SkippedGrant[] }
}

type LegacyAccount = {
    id: number
    username: string
    password_hash: string | null
    role: string
    default_namespace: string
    disabled_at: number | null
    memory: string | null
}

type LegacyToken = {
    id: number
    account_id: number
    name: string | null
    token_hash: string
    created_at: number
    revoked_at: number | null
}

type LegacyGrant = {
    resource_type: string
    resource_id: string
    grantee_account_id: number
    role: string
}

function tableExists(db: Database, name: string): boolean {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)
    return row != null
}

function columnNames(db: Database, table: string): Set<string> {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    return new Set(rows.map((row) => row.name))
}

function readUserVersion(db: Database): number {
    const row = db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined
    return row?.user_version ?? 0
}

/**
 * 校验主库的**列**是否已满足目标 schema 版本，满足则改写 `user_version`。
 *
 * 只在当前版本 > 目标版本时改写（fork 跑在前面的情况）。当前版本 <= 目标时
 * 不动，交给 upstream 自己的 step migration 正常爬升。
 */
export function alignCoreSchemaVersion(db: Database): { before: number; after: number; missingColumns: string[] } {
    const before = readUserVersion(db)
    if (!tableExists(db, 'sessions')) {
        return { before, after: before, missingColumns: [] }
    }
    const columns = columnNames(db, 'sessions')
    const missingColumns = REQUIRED_SESSION_COLUMNS.filter((column) => !columns.has(column))
    if (missingColumns.length > 0) {
        // 列真的缺 → 这不是版本号漂移，是实打实的 schema 落后。不许硬改数字
        // 骗过启动检查，那样 hub 会在运行期读到不存在的列上崩。
        return { before, after: before, missingColumns: [...missingColumns] }
    }
    if (before <= TARGET_CORE_SCHEMA_VERSION) {
        return { before, after: before, missingColumns: [] }
    }
    db.exec(`PRAGMA user_version = ${TARGET_CORE_SCHEMA_VERSION}`)
    return { before, after: readUserVersion(db), missingColumns: [] }
}

/**
 * 把旧多用户表搬进 gateway 库，并对齐主库版本号。
 *
 * @param coreDbPath    hub 主库（`~/.hapi/hapi.db`）
 * @param gatewayDbPath gateway 库（`<dataDir>/multi-user-gateway.sqlite`）
 */
export function migrateLegacyMultiUser(coreDbPath: string, gatewayDbPath: string): LegacyMigrationReport {
    const core = new Database(coreDbPath)
    try {
        const coreResult = alignCoreSchemaVersion(core)
        const empty: LegacyMigrationReport = {
            status: 'skipped-no-legacy-tables',
            core: { userVersionBefore: coreResult.before, userVersionAfter: coreResult.after, missingColumns: coreResult.missingColumns },
            accounts: 0,
            tokens: 0,
            resources: { sessions: 0, machines: 0 },
            grants: { migrated: 0, skipped: [] }
        }

        if (!tableExists(core, 'accounts')) return empty

        const store = new MultiUserGatewayStore(gatewayDbPath)
        try {
            if (store.countAccounts() > 0) return { ...empty, status: 'skipped-gateway-not-empty' }
        } finally {
            store.close()
        }

        // MultiUserGatewayStore 的构造函数已经把 gateway_* 四张表建好了，这里
        // 重开裸连接是为了带显式 id 插入（保留 account id）并统一进一个事务。
        const gateway = new Database(gatewayDbPath)
        try {
            gateway.exec('PRAGMA foreign_keys = ON')

            const accounts = core.prepare(
                'SELECT id, username, password_hash, role, default_namespace, disabled_at, memory FROM accounts ORDER BY id'
            ).all() as LegacyAccount[]

            const tokens = tableExists(core, 'api_tokens')
                ? core.prepare('SELECT id, account_id, name, token_hash, created_at, revoked_at FROM api_tokens ORDER BY id').all() as LegacyToken[]
                : []

            const grants = tableExists(core, 'resource_grants')
                ? core.prepare('SELECT resource_type, resource_id, grantee_account_id, role FROM resource_grants ORDER BY id').all() as LegacyGrant[]
                : []

            // 资源所有权：旧模型是 sessions/machines 行上的一列，新模型是
            // gateway_resources 绑定表。core_namespace 取 owner 账号的
            // default_namespace —— 与 executionMount.ts 首次 bindResource 的取值一致。
            const namespaceOf = new Map(accounts.map((account) => [account.id, account.default_namespace]))
            const ownedSessions = columnNames(core, 'sessions').has('owner_account_id')
                ? core.prepare('SELECT id, owner_account_id FROM sessions WHERE owner_account_id IS NOT NULL').all() as Array<{ id: string; owner_account_id: number }>
                : []
            const ownedMachines = columnNames(core, 'machines').has('owner_account_id')
                ? core.prepare('SELECT id, owner_account_id FROM machines WHERE owner_account_id IS NOT NULL').all() as Array<{ id: string; owner_account_id: number }>
                : []

            const knownAccounts = new Set(accounts.map((account) => account.id))
            const bound = new Set<string>()
            const skipped: SkippedGrant[] = []

            const insertAccount = gateway.prepare(
                'INSERT INTO gateway_accounts(id, username, password_hash, role, default_namespace, disabled_at, memory) VALUES(?,?,?,?,?,?,?)'
            )
            const insertToken = gateway.prepare(
                'INSERT INTO gateway_api_tokens(id, account_id, name, token_hash, created_at, revoked_at) VALUES(?,?,?,?,?,?)'
            )
            const insertResource = gateway.prepare(
                'INSERT INTO gateway_resources(resource_type, resource_id, owner_account_id, core_namespace) VALUES(?,?,?,?)'
            )
            const insertGrant = gateway.prepare(
                'INSERT INTO gateway_grants(resource_type, resource_id, grantee_account_id, role) VALUES(?,?,?,?)'
            )

            let migratedGrants = 0

            gateway.transaction(() => {
                for (const account of accounts) {
                    // gateway_accounts.role 有 CHECK(role IN ('admin','user'))，
                    // 旧表是自由文本 DEFAULT 'user'，非 admin 一律落到 'user'。
                    insertAccount.run(
                        account.id,
                        account.username,
                        account.password_hash,
                        account.role === 'admin' ? 'admin' : 'user',
                        account.default_namespace || 'default',
                        account.disabled_at,
                        account.memory
                    )
                }

                for (const token of tokens) {
                    if (!knownAccounts.has(token.account_id)) continue
                    insertToken.run(token.id, token.account_id, token.name, token.token_hash, token.created_at, token.revoked_at)
                }

                for (const [resourceType, rows] of [['session', ownedSessions], ['machine', ownedMachines]] as const) {
                    for (const row of rows) {
                        if (!knownAccounts.has(row.owner_account_id)) continue
                        insertResource.run(resourceType, row.id, row.owner_account_id, namespaceOf.get(row.owner_account_id) || 'default')
                        bound.add(`${resourceType}:${row.id}`)
                    }
                }

                for (const grant of grants) {
                    // 外键要求资源必须先在 gateway_resources 里有绑定。没绑定
                    // 意味着资源行已被删、或 owner 是 NULL —— 两种都无法表达。
                    if (!bound.has(`${grant.resource_type}:${grant.resource_id}`)) {
                        skipped.push({
                            resourceType: grant.resource_type,
                            resourceId: grant.resource_id,
                            granteeAccountId: grant.grantee_account_id,
                            role: grant.role,
                            reason: 'resource-row-missing'
                        })
                        continue
                    }
                    if (!knownAccounts.has(grant.grantee_account_id)) {
                        skipped.push({
                            resourceType: grant.resource_type,
                            resourceId: grant.resource_id,
                            granteeAccountId: grant.grantee_account_id,
                            role: grant.role,
                            reason: 'owner-null'
                        })
                        continue
                    }
                    insertGrant.run(
                        grant.resource_type,
                        grant.resource_id,
                        grant.grantee_account_id,
                        grant.role === 'operator' ? 'operator' : 'viewer'
                    )
                    migratedGrants += 1
                }
            })()

            return {
                status: 'migrated',
                core: { userVersionBefore: coreResult.before, userVersionAfter: coreResult.after, missingColumns: coreResult.missingColumns },
                accounts: accounts.length,
                tokens: tokens.filter((token) => knownAccounts.has(token.account_id)).length,
                resources: { sessions: ownedSessions.length, machines: ownedMachines.length },
                grants: { migrated: migratedGrants, skipped }
            }
        } finally {
            gateway.close()
        }
    } finally {
        core.close()
    }
}
