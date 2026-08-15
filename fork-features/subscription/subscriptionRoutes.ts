import { Hono } from 'hono'
import type { WebAppEnv } from '../../hub/src/web/middleware/auth'
import type { MultiUserGatewayStore } from '../multi-user/gatewayStore'
import { gatewayAccountId } from '../multi-user/executionMount'
import type { SubscriptionStore } from './subscriptionStore'
import type { SubscriptionReportRequest, SubscriptionSnapshot, SubscriptionSummaryResponse } from './domain'

/**
 * 订阅/API 余额快照的两条 HTTP 路由。都是**admin-only**——采集器和查看端都是 hub 主人自己
 * (Bob),`admin` 角色以外的账号既不能写也不能读,免得后来加的 grant 逻辑意外把某个用户
 * 的 3 家 provider key 曝给同一 gateway 下的其他账号。
 *
 * - `POST /api/subscription/report`: vircs collector 用 admin token 定期推快照。
 *   一次可以推多条(不同 provider 一起 flush),body: { snapshots: SubscriptionSnapshot[] }。
 * - `GET /api/subscription/summary`: 前端 UsagePage 拿全量当前快照渲染卡片。
 *
 * 都不接 namespace 参数——subscription 是全局(每 provider × 机器 × 账号 一行),
 * 不做 namespace 隔离。
 */

const MAX_SNAPSHOTS_PER_REQUEST = 100

function isValidWindow(raw: unknown): boolean {
    if (!raw || typeof raw !== 'object') return false
    const w = raw as Record<string, unknown>
    return typeof w.key === 'string' && w.key.length > 0 && w.key.length <= 128
        && typeof w.label === 'string' && w.label.length > 0 && w.label.length <= 128
        && (typeof w.used_percent === 'number' || typeof w.used_percent === 'string')
        && (w.reset_at === null || typeof w.reset_at === 'number')
        && (w.severity === 'normal' || w.severity === 'warning' || w.severity === 'critical' || w.severity === undefined)
        && typeof w.is_active === 'boolean'
}

function isValidSnapshot(raw: unknown): raw is SubscriptionSnapshot {
    if (!raw || typeof raw !== 'object') return false
    const s = raw as Record<string, unknown>
    if (typeof s.machine !== 'string' || !s.machine || s.machine.length > 128) return false
    if (typeof s.provider !== 'string' || !s.provider || s.provider.length > 64) return false
    if (typeof s.account_key !== 'string' || !s.account_key || s.account_key.length > 256) return false
    if (s.plan_name !== null && typeof s.plan_name !== 'string') return false
    if (!Array.isArray(s.windows)) return false
    if (s.windows.length > 32) return false
    if (!s.windows.every(isValidWindow)) return false
    if (s.balance !== null && (typeof s.balance !== 'object' || s.balance === undefined)) return false
    if (s.error !== null && typeof s.error !== 'string') return false
    if (typeof s.reported_at !== 'number' || !Number.isFinite(s.reported_at) || s.reported_at <= 0) return false
    return true
}

export function createSubscriptionRoutes(deps: {
    gatewayStore: MultiUserGatewayStore
    subscriptionStore: SubscriptionStore
    jwtSecret: Uint8Array
}): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    async function requireAdmin(request: Request): Promise<{ ok: true } | { ok: false; status: 401 | 403; error: string }> {
        const accountId = await gatewayAccountId(request, deps.jwtSecret)
        if (accountId === null) return { ok: false, status: 401, error: 'Invalid gateway identity' }
        const account = deps.gatewayStore.getAccount(accountId)
        if (!account) return { ok: false, status: 401, error: 'Unknown account' }
        if (account.role !== 'admin') return { ok: false, status: 403, error: 'Admin only' }
        return { ok: true }
    }

    app.post('/subscription/report', async (c) => {
        const auth = await requireAdmin(c.req.raw)
        if (!auth.ok) return c.json({ error: auth.error }, auth.status)

        let parsed: unknown
        try { parsed = await c.req.json() } catch { return c.json({ error: 'Invalid JSON body' }, 400) }
        if (!parsed || typeof parsed !== 'object') return c.json({ error: 'Body must be an object' }, 400)
        const body = parsed as SubscriptionReportRequest
        if (!Array.isArray(body.snapshots)) return c.json({ error: 'Missing snapshots array' }, 400)
        if (body.snapshots.length === 0) return c.json({ accepted: 0 })
        if (body.snapshots.length > MAX_SNAPSHOTS_PER_REQUEST) {
            return c.json({ error: `Too many snapshots (max ${MAX_SNAPSHOTS_PER_REQUEST})` }, 400)
        }
        const invalid = body.snapshots.findIndex(s => !isValidSnapshot(s))
        if (invalid >= 0) return c.json({ error: `snapshots[${invalid}] failed validation` }, 400)

        deps.subscriptionStore.upsertSnapshots(body.snapshots)
        c.header('Cache-Control', 'no-store')
        return c.json({ accepted: body.snapshots.length })
    })

    app.get('/subscription/summary', async (c) => {
        const auth = await requireAdmin(c.req.raw)
        if (!auth.ok) return c.json({ error: auth.error }, auth.status)

        const response: SubscriptionSummaryResponse = {
            snapshots: deps.subscriptionStore.listAll(),
            generatedAt: Date.now()
        }
        c.header('Cache-Control', 'no-store')
        return c.json(response)
    })

    return app
}
