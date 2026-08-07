import type { Hono, MiddlewareHandler } from 'hono'
import { jwtVerify } from 'jose'
import { toSessionSummary } from '../../shared/src/sessionSummary'
import type { SyncEngine } from '../../hub/src/sync/syncEngine'
import type { SSEManager } from '../../hub/src/sse/sseManager'
import type { Store } from '../../hub/src/store'
import type { WebAppEnv } from '../../hub/src/web/middleware/auth'
import type { MultiUserGatewayStore } from './gatewayStore'
import { ExecutionDispatcher } from './executionDispatcher'
import type { Capability, ResourceType } from './domain'
import { buildUsageSummaryResponse, parseIsoParam } from '../usage/usageAggregate'
import { createSseEventFilterFactory } from './sseVisibility'
import { streamSSE } from 'hono/streaming'
import { randomUUID } from 'node:crypto'

export async function gatewayAccountId(request: Request, secret: Uint8Array): Promise<number | null> {
    const authorization = request.headers.get('authorization')
    const queryToken = new URL(request.url).searchParams.get('token')
    const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : queryToken
    if (!token) return null
    try {
        const verified = await jwtVerify(token, secret, { algorithms: ['HS256'] })
        return typeof verified.payload.gaid === 'number' ? verified.payload.gaid : null
    } catch {
        return null
    }
}

const resourceFromPath = (path: string): { type: ResourceType; id: string } | null => {
    const match = path.match(/^\/api\/(sessions|machines)\/([^/]+)/)
    if (!match?.[1] || !match[2]) return null
    return { type: match[1] === 'machines' ? 'machine' : 'session', id: decodeURIComponent(match[2]) }
}

const capabilityFor = (method: string): Capability => method === 'GET' ? 'read' : 'operate'

export function createExecutionMiddleware(deps: {
    store: MultiUserGatewayStore
    jwtSecret: Uint8Array
}): MiddlewareHandler<WebAppEnv> {
    const dispatcher = new ExecutionDispatcher(deps.store)
    return async (c, next) => {
        const resource = resourceFromPath(c.req.path)
        if (!resource) { await next(); return }
        const accountId = await gatewayAccountId(c.req.raw, deps.jwtSecret)
        if (accountId === null) return c.json({ error: 'Invalid gateway identity' }, 401)
        const decision = dispatcher.authorize({ accountId, capability: capabilityFor(c.req.method), resource })
        if (decision.kind === 'deny') return c.json({ error: 'Insufficient permissions' }, 403)
        c.set('namespace', decision.context.namespace)
        c.set('deliveryMetadata', { gatewayAccountId: accountId })
        c.set('registerCreatedSession' as never, ((sessionId: string) => deps.store.bindResource({
            resourceType: 'session',
            resourceId: sessionId,
            ownerAccountId: accountId,
            coreNamespace: decision.context.namespace
        })) as never)
        await next()
        const isMachineSpawn = resource.type === 'machine' && c.req.method === 'POST' && c.req.path.endsWith('/spawn')
        const sessionCreatesReplacement = resource.type === 'session'
            && c.req.method === 'POST'
            && ['/fork', '/resume', '/reopen', '/restart'].some(suffix => c.req.path.endsWith(suffix))
        if ((isMachineSpawn || sessionCreatesReplacement) && c.res.ok) {
            const body = await c.res.clone().json().catch(() => null) as { sessionId?: unknown } | null
            const createdSessionId = c.req.path.endsWith('/fork')
                ? (body as { newSessionId?: unknown } | null)?.newSessionId
                : body?.sessionId
            if (typeof createdSessionId === 'string') {
                deps.store.bindResource({
                    resourceType: 'session', resourceId: createdSessionId,
                    ownerAccountId: accountId, coreNamespace: decision.context.namespace
                })
            }
        }
        return
    }
}

const CLIENT_ERROR_WINDOW_MS = 10 * 60 * 1000
const CLIENT_ERROR_MAX_PER_WINDOW = 30

export function mountExecutionRoutes(app: Hono<WebAppEnv>, deps: {
    store: MultiUserGatewayStore
    jwtSecret: Uint8Array
    getSyncEngine: () => SyncEngine | null
    getSseManager: () => SSEManager | null
    getStore: () => Store | null
}): void {
    // 前端崩溃上报。此前客户端 JS 错误只落浏览器 console，hub 侧对线上
    // 崩溃完全盲。写进 console（→ journald）即可，不进库；trunk 的
    // createAuthMiddleware 已挡在前面，这里只做限量与字段裁剪。
    const clientErrorBuckets = new Map<number, { count: number; resetAt: number }>()
    app.post('/api/client-errors', async (c) => {
        const body = await c.req.json().catch(() => null) as Record<string, unknown> | null
        const message = typeof body?.message === 'string' ? body.message : null
        if (!message) return c.json({ error: 'Invalid report' }, 400)
        const userId = c.get('userId')
        const now = Date.now()
        const bucket = clientErrorBuckets.get(userId)
        if (!bucket || bucket.resetAt <= now) {
            clientErrorBuckets.set(userId, { count: 1, resetAt: now + CLIENT_ERROR_WINDOW_MS })
        } else if (bucket.count >= CLIENT_ERROR_MAX_PER_WINDOW) {
            // 打满即静默丢弃：上报是尽力而为的诊断通道，不值得让客户端重试。
            return c.json({ ok: true })
        } else {
            bucket.count += 1
        }
        const gaid = await gatewayAccountId(c.req.raw, deps.jwtSecret)
        const clip = (value: unknown, max: number): string | undefined =>
            typeof value === 'string' ? value.slice(0, max) : undefined
        console.error('[ClientError]', JSON.stringify({
            uid: userId,
            gaid,
            source: clip(body?.source, 40),
            message: message.slice(0, 500),
            stack: clip(body?.stack, 4000),
            url: clip(body?.url, 300),
            userAgent: clip(body?.userAgent, 300),
            appVersion: clip(body?.appVersion, 60),
            occurredAt: typeof body?.occurredAt === 'number' ? body.occurredAt : undefined
        }))
        return c.json({ ok: true })
    })

    app.get('/api/events', async (c) => {
        const accountId = await gatewayAccountId(c.req.raw, deps.jwtSecret)
        const account = accountId === null ? null : deps.store.getAccount(accountId)
        const manager = deps.getSseManager()
        if (!account || !manager) return c.json({ error: 'Not connected' }, account ? 503 : 401)
        const groupId = randomUUID()
        const bindings = [
            ...deps.store.listAccessibleResources('session', account.id),
            ...deps.store.listAccessibleResources('machine', account.id)
        ].filter(binding => binding.ownerAccountId !== account.id)
        // 账号可读集谓词：`all: true` 的那条订阅覆盖整个 core namespace，而网关下
        // 多个账号共享同一个 namespace（历史账号都是 `default`），仅靠 namespace
        // 匹配会把未授权会话的事件——包括完成提醒——投给同 namespace 的其他账号。
        // 明确按 (sessionId|machineId) 绑定的那些订阅本身已是精确目标，谓词对它们
        // 是恒真，不影响被授权资源的投递。
        const canDeliver = createSseEventFilterFactory(deps.store)(account.id) ?? undefined
        return streamSSE(c, async stream => {
            const ids: string[] = []
            const subscribe = (input: { namespace: string; all?: boolean; sessionId?: string; machineId?: string }) => {
                const id = `${groupId}:${ids.length}`
                ids.push(id)
                manager.subscribe({
                    id,
                    namespace: input.namespace,
                    all: input.all,
                    sessionId: input.sessionId,
                    machineId: input.machineId,
                    visibility: ids.length === 1 ? 'visible' : 'hidden',
                    canDeliver,
                    send: event => stream.writeSSE({ data: JSON.stringify(event) }),
                    sendHeartbeat: () => ids.length === 1
                        ? stream.writeSSE({ data: JSON.stringify({ type: 'heartbeat', namespace: account.defaultNamespace, data: { timestamp: Date.now() } }) })
                        : Promise.resolve()
                })
            }
            subscribe({ namespace: account.defaultNamespace, all: true })
            for (const binding of bindings) {
                subscribe({
                    namespace: binding.coreNamespace,
                    sessionId: binding.resourceType === 'session' ? binding.resourceId : undefined,
                    machineId: binding.resourceType === 'machine' ? binding.resourceId : undefined
                })
            }
            await stream.writeSSE({ data: JSON.stringify({ type: 'connection-changed', data: { status: 'connected', subscriptionId: ids[0] } }) })
            await new Promise<void>(resolve => {
                const done = () => resolve()
                c.req.raw.signal.addEventListener('abort', done, { once: true })
                stream.onAbort(done)
            })
            for (const id of ids) manager.unsubscribe(id)
        })
    })

    app.get('/api/sessions', async (c) => {
        const accountId = await gatewayAccountId(c.req.raw, deps.jwtSecret)
        const account = accountId === null ? null : deps.store.getAccount(accountId)
        const engine = deps.getSyncEngine()
        if (!account || !engine) return c.json({ error: 'Not connected' }, account ? 503 : 401)
        for (const session of engine.getSessionsByNamespace(account.defaultNamespace)) {
            if (!deps.store.getResource('session', session.id)) deps.store.bindResource({ resourceType: 'session', resourceId: session.id, ownerAccountId: account.id, coreNamespace: account.defaultNamespace })
        }
        const sessions = deps.store.listAccessibleResources('session', account.id)
            .map(binding => engine.getSession(binding.resourceId))
            .filter(session => session != null)
            .map(session => toSessionSummary(session!))
        return c.json({ sessions })
    })

    // fork-features/usage：token 用量统计。数据本就随实时同步/导入写进了
    // messages.content，这里只做“读取+聚合”，不新增采集逻辑。
    // 可见集与上面 GET /api/sessions 完全同构：admin 看整个 namespace，普通
    // 用户只统计自己拥有的 + 被授权的会话 —— 不泄漏他人用量。与列表不同的是
    // 这里**不做** bind-on-view 副作用（只读端点不该改写资源归属）。
    app.get('/api/usage/summary', async (c) => {
        const accountId = await gatewayAccountId(c.req.raw, deps.jwtSecret)
        const account = accountId === null ? null : deps.store.getAccount(accountId)
        const engine = deps.getSyncEngine()
        const store = deps.getStore()
        if (!account || !engine || !store) return c.json({ error: 'Not connected' }, account ? 503 : 401)

        // listAccessibleResources 对 admin 返回全部绑定，普通用户返回拥有+被授权，
        // 与 GET /api/sessions 的可见集共用同一条查询。
        const visible = deps.store.listAccessibleResources('session', account.id)
            .map(binding => engine.getSession(binding.resourceId))
            .filter(session => session != null)
            .map(session => session!)

        // 机器下拉列表基于鉴权后的会话集合，不会泄漏用户无权访问的机器。
        const hosts = Array.from(new Set(
            visible
                .map(session => session.metadata?.host)
                .filter((host): host is string => typeof host === 'string' && host.length > 0)
        )).sort()

        const hostParam = c.req.query('host')?.trim() || null
        const scoped = hostParam ? visible.filter(session => session.metadata?.host === hostParam) : visible
        const sinceIso = parseIsoParam(c.req.query('since'))
        const untilIso = parseIsoParam(c.req.query('until'))
        const rows = store.messages.aggregateUsageForSessions(
            scoped.map(session => session.id),
            { sinceIso, untilIso }
        )
        return c.json(buildUsageSummaryResponse(rows, hosts, { since: sinceIso, until: untilIso, host: hostParam }, Date.now()))
    })

    app.get('/api/machines', async (c) => {
        const accountId = await gatewayAccountId(c.req.raw, deps.jwtSecret)
        const account = accountId === null ? null : deps.store.getAccount(accountId)
        const engine = deps.getSyncEngine()
        if (!account || !engine) return c.json({ error: 'Not connected' }, account ? 503 : 401)
        for (const machine of engine.getOnlineMachinesByNamespace(account.defaultNamespace)) {
            if (!deps.store.getResource('machine', machine.id)) deps.store.bindResource({ resourceType: 'machine', resourceId: machine.id, ownerAccountId: account.id, coreNamespace: account.defaultNamespace })
        }
        const machines = deps.store.listAccessibleResources('machine', account.id)
            .map(binding => engine.getMachine(binding.resourceId))
            .filter(machine => machine !== null)
        return c.json({ machines })
    })
}
