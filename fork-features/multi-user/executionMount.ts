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
import { buildUsageSummaryResponse, parseIsoParam, summarizeUsageHosts } from '../usage/usageAggregate'
import { createSessionMachineResolver, createSessionPathResolver, pathWithinScope } from './machineInheritance'
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

const machineRouteSuffix = (path: string): string => path.match(/^\/api\/machines\/[^/]+\/(.+)$/)?.[1] ?? ''

/**
 * 机器写操作请求里**待校验的路径**。返回 `null` = 这条路由没有可校验的路径
 * （改机器名、omp 之类），目录限定下一律拒。
 *
 * 只列白名单，新增机器路由默认落到 `null` 分支被拒 —— 宁可把新功能挡在限定授权
 * 之外，也不要默认放行一条没人想过的写路径。
 */
const requestedMachinePaths = (suffix: string, body: unknown): string[] | null => {
    const record = body !== null && typeof body === 'object' ? body as Record<string, unknown> : {}
    const one = (value: unknown): string[] | null => typeof value === 'string' && value !== '' ? [value] : null
    switch (suffix) {
        case 'spawn': return one(record.directory)
        case 'list-directory': return one(record.path)
        case 'create-directory': return one(record.parentPath)
        default: return null
    }
}

export function createExecutionMiddleware(deps: {
    store: MultiUserGatewayStore
    jwtSecret: Uint8Array
    getSyncEngine?: () => SyncEngine | null
}): MiddlewareHandler<WebAppEnv> {
    // 会话继承所在机器的授权：被授权某台机器的人不必再对每个新会话单独授权一次。
    const dispatcher = new ExecutionDispatcher(
        deps.store,
        deps.getSyncEngine ? createSessionMachineResolver(deps.getSyncEngine) : undefined,
        deps.getSyncEngine ? createSessionPathResolver(deps.getSyncEngine) : undefined
    )
    return async (c, next) => {
        const resource = resourceFromPath(c.req.path)
        if (!resource) { await next(); return }
        const accountId = await gatewayAccountId(c.req.raw, deps.jwtSecret)
        if (accountId === null) return c.json({ error: 'Invalid gateway identity' }, 401)
        const decision = dispatcher.authorize({ accountId, capability: capabilityFor(c.req.method), resource })
        if (decision.kind === 'deny') return c.json({ error: 'Insufficient permissions' }, 403)
        // 目录限定的机器授权：机器级写操作要逐条校验请求里的路径。会话级路由不走
        // 这里 —— 它们的限定已经由 sessionAccessLevel 在上面那句 authorize 里判掉。
        if (resource.type === 'machine' && c.req.method !== 'GET') {
            const scope = deps.store.machineGrantScope(resource.id, accountId)
            if (scope !== null) {
                c.set('machinePathScope', scope)
                // `paths/exists` 例外：它是纯存在性探测，由路由按 scope 把越界项过滤成
                // 「不存在」。整批拒会被一条陈旧的越界路径带崩 —— 前端最近目录列表是
                // 批量探的，一崩就整列消失（2026-08-11 生产实测撞到）。
                if (machineRouteSuffix(c.req.path) !== 'paths/exists') {
                    const body = await c.req.json().catch(() => null)
                    const targets = requestedMachinePaths(machineRouteSuffix(c.req.path), body)
                    if (targets === null || !targets.every(target => pathWithinScope(target, scope))) {
                        return c.json({ error: 'Insufficient permissions' }, 403)
                    }
                }
            }
        }
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
 *   1. 自己 namespace 里尚未绑定的会话（bind-on-view 认领，`claimUnbound` 时）。
 *      **不含别人机器上的**——那些留给机器主人或第 3 支落归属
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
            if (store.getResource('session', session.id)) continue
            // 别抢别人机器上的会话。生产库里历史账号的 default_namespace 全是
            // `default`，无条件认领等于「谁先拉一次列表就归谁」——peter 名下曾这么
            // 攒出 15 条 vircs 会话（2026-08-10 数据清理记录）。机器已绑定且主人
            // 不是自己时跳过：主人自己的下一次列表（本分支）或被授权者的机器继承
            // （第 3 支，按机器主人落绑定）会把归属落对。机器未注册时保持原行为，
            // 否则真孤儿会话永远没人认领。
            const machineId = session.metadata?.machineId
            if (typeof machineId === 'string' && machineId.length > 0) {
                const machineBinding = store.getResource('machine', machineId)
                if (machineBinding && machineBinding.ownerAccountId !== account.id) continue
            }
            store.bindResource({
                resourceType: 'session',
                resourceId: session.id,
                ownerAccountId: account.id,
                coreNamespace: account.defaultNamespace
            })
        }
    }

    const visible = new Map<string, Session>()
    for (const binding of store.listAccessibleResources('session', account.id)) {
        const session = engine.getSession(binding.resourceId)
        if (session) visible.set(session.id, session)
    }

    const machineBindings = store.listAccessibleResources('machine', account.id)
    const machineOwners = new Map(machineBindings.map(binding => [binding.resourceId, binding.ownerAccountId]))
    // 目录限定只是 grant 的属性：机器主人（以及 admin，压根没有 grant 行）恒为 null，
    // 照旧看得到整机。逐机器算一次，别在会话循环里逐条查库。
    const machineScopes = new Map(machineBindings.map(binding => [
        binding.resourceId,
        binding.ownerAccountId === account.id ? null : store.machineGrantScope(binding.resourceId, account.id)
    ]))
    for (const namespace of new Set(machineBindings.map(binding => binding.coreNamespace))) {
        for (const session of engine.getSessionsByNamespace(namespace)) {
            const machineId = session.metadata?.machineId
            if (!machineId || !machineOwners.has(machineId) || visible.has(session.id)) continue
            if (!pathWithinScope(session.metadata?.path, machineScopes.get(machineId) ?? null)) continue
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
            createSessionMachineResolver(deps.getSyncEngine),
            createSessionPathResolver(deps.getSyncEngine)
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

        // peer 发现（list_peers / ping-peer --list，upstream #1372）带 ?order=updatedAt
        // 和 ?limit=N 拉一个只读短名单。这两个参数一出现就判为**发现模式**：
        //   - claimUnbound: false —— 只读发现不该有 bind-on-view 副作用，不把
        //     未绑定会话认领到调用者账号（与 /api/usage/summary 只读端点同理）；
        //   - 服务端按 updatedAt 排序 + 截断，避免为 30 行短名单回传整个账号会话集。
        // Web 会话列表两个参数都不带 → 完全走原路径（claimUnbound、不排序不截断），
        // 字节不变。无论哪种模式，可见集始终是账号维度（collectVisibleSessions 按
        // gaid 解析 owned+granted+机器继承），绝不返回裸 namespace。
        const order = c.req.query('order')
        const limitRaw = c.req.query('limit')
        const parsedLimit = limitRaw === undefined ? null : Number(limitRaw)
        const limit = parsedLimit !== null && Number.isFinite(parsedLimit)
            ? Math.min(500, Math.max(1, Math.floor(parsedLimit)))
            : null
        const discovery = order === 'updatedAt' || limit !== null

        let visible = collectVisibleSessions(deps.store, engine, account, { claimUnbound: !discovery })
        if (order === 'updatedAt') {
            visible = [...visible].sort((a, b) => b.updatedAt - a.updatedAt)
        }
        if (limit !== null) {
            visible = visible.slice(0, limit)
        }
        return c.json({ sessions: visible.map(toSessionSummary) })
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

        const hostParam = c.req.query('host')?.trim() || null
        const scoped = hostParam ? visible.filter(session => session.metadata?.host === hostParam) : visible
        const sinceIso = parseIsoParam(c.req.query('since'))
        const untilIso = parseIsoParam(c.req.query('until'))
        const rows = store.messages.aggregateUsageForSessions(
            scoped.map(session => session.id),
            { sinceIso, untilIso }
        )

        // 机器榜基于鉴权后的会话集合，不会泄漏用户无权访问的机器。归属与
        // /api/machines 同源（gateway_resources.owner_account_id）——生产上所有
        // 账号共用一个 namespace，机器对象自带的 namespace 区分不了人。
        const ownerByMachineId = new Map<string, string | null>()
        const usernameByAccountId = new Map<number, string | null>()
        for (const binding of deps.store.listAccessibleResources('machine', account.id)) {
            if (!usernameByAccountId.has(binding.ownerAccountId)) {
                usernameByAccountId.set(binding.ownerAccountId, deps.store.getAccount(binding.ownerAccountId)?.username ?? null)
            }
            ownerByMachineId.set(binding.resourceId, usernameByAccountId.get(binding.ownerAccountId) ?? null)
        }
        // 统计对全部可见会话算，**不套 host 筛选**：选中一台之后其余机器也要
        // 还能比较，否则这张榜在筛选态下全是零。
        const hosts = summarizeUsageHosts(
            visible.map(session => ({
                id: session.id,
                host: session.metadata?.host ?? null,
                platform: session.metadata?.os ?? null,
                owner: session.metadata?.machineId
                    ? ownerByMachineId.get(session.metadata.machineId) ?? null
                    : null
            })),
            sessionIds => store.messages.aggregateUsageForSessions(sessionIds, { sinceIso, untilIso })
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
        // 归属人随机器下发：生产上所有账号共用一个 namespace，机器对象自带的
        // namespace 区分不了人，真正的归属在 gateway_resources.owner_account_id。
        const usernameByAccountId = new Map<number, string | null>()
        const ownerUsernameOf = (accountId: number): string | undefined => {
            if (!usernameByAccountId.has(accountId)) {
                usernameByAccountId.set(accountId, deps.store.getAccount(accountId)?.username ?? null)
            }
            return usernameByAccountId.get(accountId) ?? undefined
        }
        const machines = deps.store.listAccessibleResources('machine', account.id)
            .map(binding => {
                const machine = engine.getMachine(binding.resourceId)
                return machine ? { ...machine, ownerUsername: ownerUsernameOf(binding.ownerAccountId) } : null
            })
            .filter(machine => machine !== null)
        return c.json({ machines })
    })
}
