import { Database } from 'bun:sqlite'
import type { SubscriptionSnapshot, SubscriptionWindow, SubscriptionBalance } from './domain'

/**
 * 订阅/余额快照的**独立存储**。跟多用户 gateway 库物理分离(单独一份 .sqlite),
 * 因为它跟账号/授权无关,是一张纯粹的「provider × 机器 × 账号 → 当前状态」表;
 * 混进 gateway 库反而让权限模块变复杂。
 *
 * 主键(machine, provider, account_key)上直接 upsert——历史不留,前端只关心「现在」。
 * 需要看历史用 hub 的 message.usage 聚合(那才是消费明细),这里的角色是「配额剩多少」。
 *
 * SQLite 表 shape 稳定后追加字段用 ALTER TABLE + 列存在性检查(与 gatewayStore.ts 同风格),
 * 不做整表重建,便于换芯回滚。
 */

const CURRENT_SCHEMA_VERSION = 1

type SnapshotRow = {
    machine: string
    provider: string
    account_key: string
    plan_name: string | null
    windows_json: string
    balance_json: string | null
    error: string | null
    reported_at: number
}

function columnNames(db: Database, table: string): Set<string> {
    return new Set(
        (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(row => row.name)
    )
}

export function applySubscriptionSchema(db: Database): void {
    db.exec('PRAGMA journal_mode = WAL')
    db.exec(`
        CREATE TABLE IF NOT EXISTS subscription_snapshots (
            machine TEXT NOT NULL,
            provider TEXT NOT NULL,
            account_key TEXT NOT NULL,
            plan_name TEXT,
            windows_json TEXT NOT NULL DEFAULT '[]',
            balance_json TEXT,
            error TEXT,
            reported_at INTEGER NOT NULL,
            PRIMARY KEY(machine, provider, account_key)
        );
        CREATE TABLE IF NOT EXISTS subscription_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
    `)
    // 保留写迁移的通路——将来加列走同一模式(见 gatewayStore.applyGatewaySchema)。
    const cols = columnNames(db, 'subscription_snapshots')
    if (!cols.has('reported_at')) db.exec('ALTER TABLE subscription_snapshots ADD COLUMN reported_at INTEGER NOT NULL DEFAULT 0')

    db.prepare('INSERT OR REPLACE INTO subscription_meta(key,value) VALUES(?,?)')
        .run('schema_version', String(CURRENT_SCHEMA_VERSION))
}

/** 采集侧不小心把 undefined 塞进 JSON 会变成缺字段;这里做一次严格归一化,
 *  保证读回来的形状永远和 domain.ts 声明一致(前端就不用兼容缺字段)。 */
function normalizeWindow(raw: unknown): SubscriptionWindow | null {
    if (!raw || typeof raw !== 'object') return null
    const w = raw as Record<string, unknown>
    const key = typeof w.key === 'string' && w.key ? w.key : null
    const label = typeof w.label === 'string' && w.label ? w.label : null
    const usedPercentRaw = typeof w.used_percent === 'number' ? w.used_percent : Number(w.used_percent)
    if (!key || !label || !Number.isFinite(usedPercentRaw)) return null
    const used_percent = Math.max(0, Math.min(100, Math.round(usedPercentRaw * 10) / 10))
    const reset_at = typeof w.reset_at === 'number' && Number.isFinite(w.reset_at) ? w.reset_at : null
    const severity: 'normal' | 'warning' | 'critical' =
        w.severity === 'critical' ? 'critical' : w.severity === 'warning' ? 'warning' : 'normal'
    const is_active = Boolean(w.is_active)
    return { key, label, used_percent, reset_at, severity, is_active }
}

function normalizeBalance(raw: unknown): SubscriptionBalance | null {
    if (!raw || typeof raw !== 'object') return null
    const b = raw as Record<string, unknown>
    const amountRaw = typeof b.amount === 'number' ? b.amount : Number(b.amount)
    const currency = typeof b.currency === 'string' && b.currency ? b.currency : null
    if (!currency || !Number.isFinite(amountRaw)) return null
    const granted = typeof b.granted === 'number' && Number.isFinite(b.granted) ? b.granted : null
    const topped_up = typeof b.topped_up === 'number' && Number.isFinite(b.topped_up) ? b.topped_up : null
    return { amount: amountRaw, currency, granted, topped_up }
}

function rowToSnapshot(row: SnapshotRow): SubscriptionSnapshot {
    // JSON.parse 失败或不是数组就当空,不 throw——采集器有 bug 也别把整个 summary 端点带崩。
    let windows: SubscriptionWindow[] = []
    try {
        const parsed = JSON.parse(row.windows_json)
        if (Array.isArray(parsed)) {
            windows = parsed.map(normalizeWindow).filter((w): w is SubscriptionWindow => w !== null)
        }
    } catch { /* keep [] */ }

    let balance: SubscriptionBalance | null = null
    if (row.balance_json) {
        try { balance = normalizeBalance(JSON.parse(row.balance_json)) } catch { /* null */ }
    }

    return {
        machine: row.machine,
        provider: row.provider,
        account_key: row.account_key,
        plan_name: row.plan_name,
        windows,
        balance,
        error: row.error,
        reported_at: row.reported_at
    }
}

export class SubscriptionStore {
    private readonly db: Database

    constructor(path: string) {
        this.db = new Database(path, { create: true })
        applySubscriptionSchema(this.db)
    }

    close(): void { this.db.close() }

    /**
     * 写入一批快照(通常来自单次 POST /api/subscription/report)。
     * 主键冲突就 upsert——同一 (machine, provider, account_key) 只保留最后一份。
     *
     * 采集器可能给出「错误快照」(error 非空、windows 为空)——照写不误,前端才能
     * 看见「10 分钟前采集失败」而不是让整个卡片消失,更好归因。
     */
    upsertSnapshots(snapshots: SubscriptionSnapshot[]): void {
        const stmt = this.db.prepare(
            `INSERT INTO subscription_snapshots
                (machine, provider, account_key, plan_name, windows_json, balance_json, error, reported_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(machine, provider, account_key) DO UPDATE SET
                plan_name = excluded.plan_name,
                windows_json = excluded.windows_json,
                balance_json = excluded.balance_json,
                error = excluded.error,
                reported_at = excluded.reported_at`
        )
        this.db.transaction((batch: SubscriptionSnapshot[]) => {
            for (const snap of batch) {
                // 写入前也做一次归一化,防止采集器传进多余字段/异形值污染 DB。
                const windows = snap.windows.map(normalizeWindow).filter((w): w is SubscriptionWindow => w !== null)
                const balance = snap.balance ? normalizeBalance(snap.balance) : null
                stmt.run(
                    snap.machine,
                    snap.provider,
                    snap.account_key,
                    snap.plan_name,
                    JSON.stringify(windows),
                    balance ? JSON.stringify(balance) : null,
                    snap.error,
                    snap.reported_at
                )
            }
        })(snapshots)
    }

    listAll(): SubscriptionSnapshot[] {
        const rows = this.db
            .prepare('SELECT machine, provider, account_key, plan_name, windows_json, balance_json, error, reported_at FROM subscription_snapshots ORDER BY machine, provider, account_key')
            .all() as SnapshotRow[]
        return rows.map(rowToSnapshot)
    }

    /** 主要给测试和运维用。生产 API 走 listAll。 */
    getByKey(machine: string, provider: string, accountKey: string): SubscriptionSnapshot | null {
        const row = this.db
            .prepare('SELECT machine, provider, account_key, plan_name, windows_json, balance_json, error, reported_at FROM subscription_snapshots WHERE machine=? AND provider=? AND account_key=?')
            .get(machine, provider, accountKey) as SnapshotRow | null
        return row ? rowToSnapshot(row) : null
    }

    /** 删掉某台机器所有 provider 的快照。机器下线/换名时用。 */
    deleteByMachine(machine: string): number {
        return Number(this.db.prepare('DELETE FROM subscription_snapshots WHERE machine=?').run(machine).changes)
    }
}
