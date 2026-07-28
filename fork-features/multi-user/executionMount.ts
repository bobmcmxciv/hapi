import type { Hono, MiddlewareHandler } from 'hono'
import { jwtVerify } from 'jose'
import { toSessionSummary } from '../../shared/src/sessionSummary'
import type { Session, SyncEngine } from '../../hub/src/sync/syncEngine'
import type { SSEManager } from '../../hub/src/sse/sseManager'
import type { Store } from '../../hub/src/store'
import type { WebAppEnv } from '../../hub/src/web/middleware/auth'
import type { MultiUserGatewayStore } from './gatewayStore'
import { ExecutionDispatcher } from './executionDispatcher'
import type { Account, Capability, ResourceType } from './domain'
import { buildUsageSummaryResponse, parseIsoParam } from '../usage/usageAggregate'
import { createSessionMachineResolver } from './machineInheritance'
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
    getSyncEngine?: () => SyncEngine | null
}): MiddlewareHandler<WebAppEnv> {
    // 会话继承所在机器的授权：被授权某台机器的人不必再对每个新会话单独授权一次。
    const dispatcher = new ExecutionDispatcher(
        deps.store,
        deps.getSyncEngine ? createSessionMachineResolver(deps.getSyncEngine) : undefined
    )
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

/**
 * 一个账号可见的会话集合，`GET /api/sessions` 与 `/api/usage/summary` 共用。
 *
 * 三个来源：
 *   1. 自己 namespace 里尚未绑定的会话（bind-on-view 认领，`claimUnbound` 时）
 *   2. gateway_resources 里拥有 + 被授权的会话
 *   3. **被授权机器上的会话** —— 机器授权向下继承（machineInheritance）。
 *      这一支是修「机器授权了但机器上新建的会话看不见」的关键：新会话的
 *      owner 是创建者，不会自动带上被授权人的 grant。
 *
 * 第 3 支扫到的未绑定会话按**机器主人**落绑定，不是当前查看者 —— 被授权者
 * 刷一下列表不该把别人机器上的会话变成自己的。
 */
function collectVisibleSessions(
    store: MultiUserGatewayStore,
    engine: SyncEngine,
    account: Account,
    options: { claimUnbound: boolean }
): Session[] {
    if (options.claimUnbound) {
        for (const session of engine.getSessionsByNamespace(account.defaultNamespace)) {
            if (!store.getResource('session', session.id)) {
                store.bindResource({
                    resourceType: 'session',
                    resourceId: session.id,
                    ownerAccountId: account.id,
                    coreNamespace: account.defaultNamespace
                })
            }
        }
    }

    const visible = new Map<string, Session>()
    for (const binding of store.listAccessibleResources('session', account.id)) {
        const session = engine.getSession(binding.resourceId)
        if (session) visible.set(session.id, session)
    }

    const machineBindings = store.listAccessibleResources('machine', account.id)
    const machineOwners = new Map(machineBindings.map(binding => [binding.resourceId, binding.ownerAccountId]))
    for (const namespace of new Set(machineBindings.map(binding => binding.coreNamespace))) {
        for (const session of engine.getSessionsByNamespace(namespace)) {
            const machineId = session.metadata?.machineId
            if (!machineId || !machineOwners.has(machineId) || visible.has(session.id)) continue
            if (options.claimUnbound && !store.getResource('session', session.id)) {
                store.bindResource({
                    resourceType: 'session',
                    resourceId: session.id,
                    ownerAccountId: machineOwners.get(machineId)!,
                    coreNamespace: session.namespace
                })
            }
            visible.set(session.id, session)
        }
    }
    return [...visible.values()]
}

export function mountExecutionRoutes(app: Hono<WebAppEnv>, deps: {
    store: MultiUserGatewayStore
    jwtSecret: Uint8Array
    getSyncEngine: () => SyncEngine | null
    getSseManager: () => SSEManager | null
    getStore: () => Store | null
}): void {
    app.get('/api/events', async (c) => {
        const accountId = await gatewayAccountId(c.req.raw, deps.jwtSecret)
        const account = accountId === null ? null : deps.store.getAccount(accountId)
        const manager = deps.getSseManager()
        if (!account || !manager) return c.json({ error: 'Not connected' }, account ? 503 : 401)
        const groupId = randomUUID()
        // 订阅按 **namespace** 铺开，不再按资源逐条订阅：机器授权下「哪些会话可见」
        // 是随时会变的（机器上随时会新建会话），逐条订阅只能覆盖连接建立那一刻
        // 已存在的资源，新会话的事件永远进不来。改成覆盖所有相关 namespace，
        // 由 canDeliver 谓词逐事件判权。
        const reachableNamespaces = new Set([
            account.defaultNamespace,
            ...deps.store.listAccessibleResources('session', account.id).map(binding => binding.coreNamespace),
            ...deps.store.listAccessibleResources('machine', account.id).map(binding => binding.coreNamespace)
        ])
        // 账号可读集谓词：`all: true` 的订阅覆盖整个 core namespace，而网关下
        // 多个账号共享同一个 namespace（历史账号都是 `default`），仅靠 namespace
        // 匹配会把未授权会话的事件——包括完成提醒——投给同 namespace 的其他账号。
        const canDeliver = createSseEventFilterFactory(
            deps.store,
            createSessionMachineResolver(deps.getSyncEngine)
        )(account.id) ?? undefined
        return streamSSE(c, async stream => {
            const ids: string[] = []
            const subscribe = (namespace: string) => {
                const index = ids.length
                const id = `${groupId}:${index}`
                ids.push(id)
                manager.subscribe({
                    id,
                    namespace,
                    all: true,
                    // 只有首条（账号自己的 namespace）算 visible：sendToast 只投给
                    // visible 连接，借此避免把别人 namespace 的 toast 串给本账号。
                    visibility: index === 0 ? 'visible' : 'hidden',
                    canDeliver,
                    send: event => stream.writeSSE({ data: JSON.stringify(event) }),
                    // index 在订阅时定死。此前写的是 `ids.length === 1`，而它在心跳
                    // 触发时才求值——只要账号有任何跨 namespace 授权（ids.length > 1），
                    // 所有连接的心跳就一起停摆。
                    sendHeartbeat: () => index === 0
                        ? stream.writeSSE({ data: JSON.stringify({ type: 'heartbeat', namespace: account.defaultNamespace, data: { timestamp: Date.now() } }) })
                        : Promise.resolve()
                })
            }
            for (const namespace of reachableNamespaces) subscribe(namespace)
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
        const sessions = collectVisibleSessions(deps.store, engine, account, { claimUnbound: true })
            .map(toSessionSummary)
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

        // 与 GET /api/sessions 共用同一个可见集解析器（含机器授权继承的那一支），
        // 区别只有这里不认领未绑定会话 —— 只读端点不该改写资源归属。
        const visible = collectVisibleSessions(deps.store, engine, account, { claimUnbound: false })

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
