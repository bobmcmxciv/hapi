import { Hono } from 'hono'
import { OmpUsageResponseSchema } from '@hapi/protocol/ompUsage'
import type { SyncEngine } from '../../hub/src/sync/syncEngine'
import { requireMachine } from '../../hub/src/web/routes/guards'
import type { WebAppEnv } from '../../hub/src/web/middleware/auth'
import type { MultiUserGatewayStore } from '../multi-user/gatewayStore'
import { gatewayAccountId, validateGatewayCredential } from '../multi-user/executionMount'
import { ExecutionDispatcher } from '../multi-user/executionDispatcher'
import type { SubscriptionStore } from './subscriptionStore'
import type { SubscriptionReportRequest, SubscriptionSnapshot, SubscriptionSummaryResponse } from './domain'

/**
 * 订阅/API 余额快照和 OMP 原生用量 HTTP 路由。都是**admin-only**——采集器和查看端都是 hub 主人自己
 * (Bob),`admin` 角色以外的账号既不能写也不能读,免得后来加的 grant 逻辑意外把某个用户
 * 的 3 家 provider key 曝给同一 gateway 下的其他账号。
 *
 * - `POST /api/subscription/report`: vircs collector 用 admin token 定期推快照。
 *   一次可以推多条(不同 provider 一起 flush),body: { snapshots: SubscriptionSnapshot[] }。
 * - `GET /api/subscription/summary`: 前端 UsagePage 拿全量当前快照渲染卡片。
 * - `GET /api/subscription/omp/:machineId`: 按机器读取 OMP 原生用量，不写外部采集快照。
 *
 * 外部采集快照不接 namespace 参数——每 provider × 机器 × 账号 一行。
 * OMP 查询沿用管理员的机器 namespace 可见性，逐请求检查有效凭据和当前角色。
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
 getSyncEngine?: () => SyncEngine | null
}): Hono<WebAppEnv> {
 const app = new Hono<WebAppEnv>()

 async function requireAdmin(request: Request): Promise<{ ok: true; accountId: number } | { ok: false; status: 401 | 403; error: string }> {
  const accountId = await gatewayAccountId(request, deps.jwtSecret)
  if (accountId === null) return { ok: false, status: 401, error: 'Invalid gateway identity' }
  const account = deps.gatewayStore.getAccount(accountId)
  if (!account) return { ok: false, status: 401, error: 'Unknown account' }
  if (account.role !== 'admin') return { ok: false, status: 403, error: 'Admin only' }
  return { ok: true, accountId: account.id }
 }

 async function requireOmpAdmin(request: Request): Promise<
  { ok: true; accountId: number } | { ok: false; status: 401 | 403; error: string }
 > {
  const credential = await validateGatewayCredential(request, deps.gatewayStore, deps.jwtSecret, { allowQueryToken: false })
  if (!credential.ok) return { ok: false, status: 401, error: 'Invalid gateway identity' }
  const account = deps.gatewayStore.getAccount(credential.accountId)
  if (!account || account.disabledAt !== null) return { ok: false, status: 401, error: 'Unknown account' }
  if (account.role !== 'admin') return { ok: false, status: 403, error: 'Admin only' }
  return { ok: true, accountId: account.id }
 }

 app.get('/subscription/omp/:machineId', async (c) => {
  c.header('Cache-Control', 'no-store')
  const auth = await requireOmpAdmin(c.req.raw)
  if (!auth.ok) return c.json({ error: auth.error }, auth.status)

  const engine = deps.getSyncEngine?.()
  if (!engine) return c.json({ error: 'Not connected' }, 503)
  const machineId = c.req.param('machineId')
  if (!engine.getMachine(machineId)) return c.json({ error: 'Machine not found' }, 404)
  const dispatcher = new ExecutionDispatcher(deps.gatewayStore, undefined, undefined,
   (_type, id) => engine.getMachine(id)?.namespace ?? null)
  const decision = dispatcher.authorize({ accountId: auth.accountId, capability: 'read', resource: { type: 'machine', id: machineId } })
  if (decision.kind === 'deny') return c.json({ error: 'Machine access denied' }, 403)
  c.set('namespace', decision.context.namespace)
  const machine = requireMachine(c, engine, machineId)
  if (machine instanceof Response) return machine
  if (!machine.active) return c.json({ error: 'Machine is offline' }, 409)
  if (machine.metadata?.capabilities?.omp !== true) {
   return c.json({ success: false, source: 'omp-native', errorCode: 'unsupported', error: 'OMP is not available on this runner' }, 409)
  }

  deps.gatewayStore.setAccountUsagePreference?.(auth.accountId, {
   source: 'omp-native',
   ompMachineId: machineId,
   ompMachineHost: machine.metadata?.host ?? null
  })
  let result: unknown
  try {
   result = await engine.getOmpUsageForMachine(machineId)
  } catch {
   // Never forward runner exceptions: stderr can contain credential metadata.
   result = { success: false, source: 'omp-native', errorCode: 'unavailable', error: 'OMP native usage is unavailable' }
  }
  // Revocation or demotion while the runner was fetching must not disclose its result.
  const current = await requireOmpAdmin(c.req.raw)
  if (!current.ok) return c.json({ error: current.error }, current.status)

  // Parse, do not merely validate: recursively strip raw metadata and notes.
  const parsed = OmpUsageResponseSchema.safeParse(result)
  if (!parsed.success) {
   return c.json({ success: false, source: 'omp-native', errorCode: 'invalid_output', error: 'Invalid OMP native usage response' }, 502)
  }
  return c.json(parsed.data)
 })

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
  deps.gatewayStore.setAccountUsagePreference?.(auth.accountId, { source: 'external' })

  const response: SubscriptionSummaryResponse = {
   snapshots: deps.subscriptionStore.listAll(),
   generatedAt: Date.now()
  }
  c.header('Cache-Control', 'no-store')
  return c.json(response)
 })

 return app
}
