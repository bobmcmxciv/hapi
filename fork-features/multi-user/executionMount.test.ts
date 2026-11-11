import { describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { createExecutionMiddleware, mountExecutionRoutes } from './executionMount'
import type { SyncEngine } from '../../hub/src/sync/syncEngine'
import type { WebAppEnv } from '../../hub/src/web/middleware/auth'
import { MultiUserGatewayStore } from './gatewayStore'
import { Store as HubStore } from '../../hub/src/store'
import { SSEManager } from '../../hub/src/sse/sseManager'
import { VisibilityTracker } from '../../hub/src/visibility/visibilityTracker'

describe('createExecutionMiddleware', () => {
 it('exposes authenticated account identity as opaque delivery metadata', async () => {
  const store = new MultiUserGatewayStore(':memory:')
  const owner = store.createAccount('owner', 'user', 'owner-namespace', null)
  store.bindResource({ resourceType: 'session', resourceId: 'owned', ownerAccountId: owner.id, coreNamespace: owner.defaultNamespace })
  const jwtSecret = new TextEncoder().encode('test-secret-test-secret-test-secret')
  const token = await new SignJWT({ gaid: owner.id }).setProtectedHeader({ alg: 'HS256' }).sign(jwtSecret)
  const app = new Hono<WebAppEnv>()
  app.use('*', createExecutionMiddleware({ store, jwtSecret }))
  app.post('/api/sessions/:id/messages', c => c.json(c.get('deliveryMetadata')))

  const response = await app.request('/api/sessions/owned/messages', {
   method: 'POST', headers: { authorization: `Bearer ${token}` }
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ gatewayAccountId: owner.id })
  store.close()
 })

 it('binds a fork-created session to the source session owner', async () => {
  const store = new MultiUserGatewayStore(':memory:')
  const owner = store.createAccount('owner', 'user', 'owner-namespace', null)
  store.bindResource({
   resourceType: 'session',
   resourceId: 'source-session',
   ownerAccountId: owner.id,
   coreNamespace: owner.defaultNamespace
  })
  const jwtSecret = new TextEncoder().encode('test-secret-test-secret-test-secret')
  const token = await new SignJWT({ gaid: owner.id })
   .setProtectedHeader({ alg: 'HS256' })
   .sign(jwtSecret)
  const app = new Hono()
  app.use('*', createExecutionMiddleware({ store, jwtSecret }))
  app.post('/api/sessions/:id/fork', (c) => c.json({ newSessionId: 'fork-session' }))

  const response = await app.request('/api/sessions/source-session/fork', {
   method: 'POST',
   headers: { authorization: `Bearer ${token}` }
  })

  expect(response.status).toBe(200)
  expect(store.getResource('session', 'fork-session')).toMatchObject({
   ownerAccountId: owner.id,
   coreNamespace: owner.defaultNamespace
  })
  store.close()
 })

 for (const path of ['resume', 'reopen', 'restart'] as const) {
  it(`binds a ${path}-created replacement session to the source session owner`, async () => {
   const store = new MultiUserGatewayStore(':memory:')
   const owner = store.createAccount('owner', 'user', 'owner-namespace', null)
   store.bindResource({
    resourceType: 'session',
    resourceId: 'source-session',
    ownerAccountId: owner.id,
    coreNamespace: owner.defaultNamespace
   })
   const jwtSecret = new TextEncoder().encode('test-secret-test-secret-test-secret')
   const token = await new SignJWT({ gaid: owner.id })
    .setProtectedHeader({ alg: 'HS256' })
    .sign(jwtSecret)
   const app = new Hono()
   app.use('*', createExecutionMiddleware({ store, jwtSecret }))
   app.post(`/api/sessions/:id/${path}`, (c) => c.json({ sessionId: `${path}-session` }))

   const response = await app.request(`/api/sessions/source-session/${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` }
   })

   expect(response.status).toBe(200)
   expect(store.getResource('session', `${path}-session`)).toMatchObject({
    ownerAccountId: owner.id,
    coreNamespace: owner.defaultNamespace
   })
   store.close()
  })
 }

 it('omits stale resource bindings whose core session no longer exists', async () => {
  const store = new MultiUserGatewayStore(':memory:')
  const owner = store.createAccount('owner', 'user', 'owner-namespace', null)
  store.bindResource({
   resourceType: 'session',
   resourceId: 'deleted-source-session',
   ownerAccountId: owner.id,
   coreNamespace: owner.defaultNamespace
  })
  const jwtSecret = new TextEncoder().encode('test-secret-test-secret-test-secret')
  const token = await new SignJWT({ gaid: owner.id })
   .setProtectedHeader({ alg: 'HS256' })
   .sign(jwtSecret)
  const engine = {
   getSessionsByNamespace: () => [],
   getSession: () => undefined
  } as unknown as SyncEngine
  const app = new Hono<WebAppEnv>()
  mountExecutionRoutes(app, {
   store,
   jwtSecret,
   getSyncEngine: () => engine,
   getSseManager: () => null,
   getStore: () => null
  })

  const response = await app.request('/api/sessions', {
   headers: { authorization: `Bearer ${token}` }
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ sessions: [] })
  store.close()
 })
 it('streams only granted cross-namespace session events to a viewer', async () => {
  const store = new MultiUserGatewayStore(':memory:')
  const owner = store.createAccount('owner', 'user', 'owner-namespace', null)
  const viewer = store.createAccount('viewer', 'user', 'viewer-namespace', null)
  store.bindResource({
   resourceType: 'session',
   resourceId: 'shared-session',
   ownerAccountId: owner.id,
   coreNamespace: owner.defaultNamespace
  })
  store.grant('session', 'shared-session', viewer.id, 'viewer')
  const jwtSecret = new TextEncoder().encode('test-secret-test-secret-test-secret')
  const token = await new SignJWT({ gaid: viewer.id })
   .setProtectedHeader({ alg: 'HS256' })
   .sign(jwtSecret)
  const sseManager = new SSEManager(0, new VisibilityTracker())
  const app = new Hono<WebAppEnv>()
  mountExecutionRoutes(app, {
   store,
   jwtSecret,
   getSyncEngine: () => null,
   getSseManager: () => sseManager,
   getStore: () => null
  })
  const controller = new AbortController()
  const response = await app.request('/api/events?allNamespaces=true', {
   headers: { authorization: `Bearer ${token}` },
   signal: controller.signal
  })
  const reader = response.body?.getReader()
  expect(reader).toBeDefined()
  const first = await reader!.read()
  expect(new TextDecoder().decode(first.value)).toContain('"status":"connected"')

  sseManager.broadcast({
   type: 'session-updated',
   sessionId: 'private-session',
   namespace: owner.defaultNamespace
  })
  sseManager.broadcast({
   type: 'session-updated',
   sessionId: 'shared-session',
   namespace: owner.defaultNamespace
  })
  const event = await reader!.read()
  const body = new TextDecoder().decode(event.value)
  expect(body).toContain('"sessionId":"shared-session"')
  expect(body).not.toContain('private-session')

  controller.abort()
  await reader!.cancel()
  sseManager.stop()
  store.close()
 })
})

describe('列表可见性：admin 跨所有 namespace，普通用户看自己的+被授权的', () => {
 const jwtSecret = new TextEncoder().encode('test-secret-test-secret-test-secret')
 const sign = (accountId: number) => new SignJWT({ gaid: accountId }).setProtectedHeader({ alg: 'HS256' }).sign(jwtSecret)

 /** 建一个 namespace 里有 3 个会话、2 台机器的场景：admin 拥有 1 个，peter 拥有 2 个。 */
 function seed() {
  const store = new MultiUserGatewayStore(':memory:')
  const admin = store.createAccount('admin', 'admin', 'default', null)
  const peter = store.createAccount('peter', 'user', 'default', null)
  const other = store.createAccount('mnmn66', 'user', 'default', null)
  const sessions = [
   { id: 's-admin', ownerAccountId: admin.id },
   { id: 's-peter-1', ownerAccountId: peter.id },
   { id: 's-peter-2', ownerAccountId: peter.id }
  ]
  for (const s of sessions) {
   store.bindResource({ resourceType: 'session', resourceId: s.id, ownerAccountId: s.ownerAccountId, coreNamespace: 'default' })
  }
  store.bindResource({ resourceType: 'machine', resourceId: 'm-admin', ownerAccountId: admin.id, coreNamespace: 'default' })
  store.bindResource({ resourceType: 'machine', resourceId: 'm-peter', ownerAccountId: peter.id, coreNamespace: 'default' })

  const records = new Map(sessions.map(s => [s.id, { id: s.id, namespace: 'default', metadata: null, agentState: null, active: false, createdAt: 1, updatedAt: 1, seq: 0 }]))
  const machines = [{ id: 'm-admin', namespace: 'default' }, { id: 'm-peter', namespace: 'default' }]
  const engine = {
   getSessions: () => [...records.values()],
   getMachines: () => machines,
   getSessionsByNamespace: () => [...records.values()],
   getSession: (id: string) => records.get(id),
   getOnlineMachinesByNamespace: () => machines,
   getMachine: (id: string) => machines.find(m => m.id === id) ?? null
  } as unknown as SyncEngine

  const app = new Hono<WebAppEnv>()
  mountExecutionRoutes(app, { store, jwtSecret, getSyncEngine: () => engine, getSseManager: () => null, getStore: () => null })
  return { store, app, admin, peter, other }
 }

 const idsOf = async (response: Response, key: 'sessions' | 'machines') =>
  ((await response.json()) as Record<string, Array<{ id: string }>>)[key]!.map(r => r.id).sort()

 it('admin 的会话列表包含别人拥有的会话（pre-gateway 行为，收敛后曾丢失 56 条）', async () => {
  const { store, app, admin } = seed()
  const response = await app.request('/api/sessions', { headers: { authorization: `Bearer ${await sign(admin.id)}` } })
  expect(response.status).toBe(200)
  expect(await idsOf(response, 'sessions')).toEqual(['s-admin', 's-peter-1', 's-peter-2'])
  store.close()
 })

 it('admin 的机器列表同样是整个 namespace，且每台带归属人用户名', async () => {
  const { store, app, admin } = seed()
  const response = await app.request('/api/machines', { headers: { authorization: `Bearer ${await sign(admin.id)}` } })
  const machines = ((await response.json()) as { machines: Array<{ id: string; ownerUsername?: string }> }).machines
  expect(machines.map(m => m.id).sort()).toEqual(['m-admin', 'm-peter'])
  expect(new Map(machines.map(m => [m.id, m.ownerUsername]))).toEqual(new Map([
   ['m-admin', 'admin'],
   ['m-peter', 'peter']
  ]))
  store.close()
 })

 it('普通用户仍然只看到自己拥有的 —— admin 分支没有放宽别人的可见性', async () => {
  const { store, app, peter } = seed()
  const sessions = await app.request('/api/sessions', { headers: { authorization: `Bearer ${await sign(peter.id)}` } })
  expect(await idsOf(sessions, 'sessions')).toEqual(['s-peter-1', 's-peter-2'])
  const machines = await app.request('/api/machines', { headers: { authorization: `Bearer ${await sign(peter.id)}` } })
  const rows = ((await machines.json()) as { machines: Array<{ id: string; ownerUsername?: string }> }).machines
  expect(rows.map(m => ({ id: m.id, ownerUsername: m.ownerUsername }))).toEqual([{ id: 'm-peter', ownerUsername: 'peter' }])
  store.close()
 })

 it('被授权的资源出现在普通用户列表里，未授权的不出现', async () => {
  const { store, app, other } = seed()
  store.grant('session', 's-peter-1', other.id, 'viewer')
  const response = await app.request('/api/sessions', { headers: { authorization: `Bearer ${await sign(other.id)}` } })
  // mnmn66 自己不拥有任何会话，只应看到被授权的那一条
  expect(await idsOf(response, 'sessions')).toEqual(['s-peter-1'])
  store.close()
 })

 // peer 发现（upstream #1372 list_peers）带 ?order=updatedAt&limit=N。安全不变量：
 // 发现模式仍是账号维度，绝不因为带了 limit/order 就退回裸 namespace 泄漏别人的会话。
 it('peer 发现（?order=updatedAt&limit）仍按账号可见集，不泄漏他人会话', async () => {
  const { store, app, peter } = seed()
  const response = await app.request('/api/sessions?order=updatedAt&limit=32', {
   headers: { authorization: `Bearer ${await sign(peter.id)}` }
  })
  expect(response.status).toBe(200)
  // peter 只应看到自己的两条，绝不含 admin 的 s-admin。
  expect(await idsOf(response, 'sessions')).toEqual(['s-peter-1', 's-peter-2'])
  store.close()
 })

 it('普通用户发现模式只读，列表模式仍认领自己 namespace 的未绑定会话', async () => {
  // 引擎里放一条未绑定的孤儿会话（default namespace，无 resource binding）。
  const store = new MultiUserGatewayStore(':memory:')
  const owner = store.createAccount('owner', 'user', 'default', null)
  const orphan = { id: 's-orphan', namespace: 'default', metadata: null, agentState: null, active: false, createdAt: 1, updatedAt: 5, seq: 0 }
  const engine = {
   getSessions: () => [orphan],
   getSessionsByNamespace: () => [orphan],
   getSession: (id: string) => (id === 's-orphan' ? orphan : null),
   getOnlineMachinesByNamespace: () => [],
   getMachine: () => null
  } as unknown as SyncEngine
  const app = new Hono<WebAppEnv>()
  mountExecutionRoutes(app, { store, jwtSecret, getSyncEngine: () => engine, getSseManager: () => null, getStore: () => null })

  // 发现模式（带 order/limit）：只读，孤儿会话不被认领。
  await app.request('/api/sessions?order=updatedAt&limit=30', { headers: { authorization: `Bearer ${await sign(owner.id)}` } })
  expect(store.getResource('session', 's-orphan')).toBeNull()

  // 普通用户列表模式仍认领自己的孤儿；admin 全局读取不认领。
  await app.request('/api/sessions', { headers: { authorization: `Bearer ${await sign(owner.id)}` } })
  expect(store.getResource('session', 's-orphan')?.ownerAccountId).toBe(owner.id)
  store.close()
 })
})

describe('机器授权向下继承：被授权机器上新建的会话自动出现', () => {
 const jwtSecret = new TextEncoder().encode('test-secret-test-secret-test-secret')
 const sign = (accountId: number) => new SignJWT({ gaid: accountId }).setProtectedHeader({ alg: 'HS256' }).sign(jwtSecret)

 /**
  * 复现生产现象（2026-08-08）：FA608_INDEX 授权给了 mnmn66，admin 在这台机器上
  * 新建会话后 mnmn66 看不到——会话是独立资源，owner=admin 且没有会话级 grant。
  * grantee 的 namespace 故意与机器/会话的 namespace 不同，这样 bind-on-view
  * 的自有 namespace 那一支扫不到它，跑通的只可能是机器继承那一支。
  */
 function seed(options?: { bindNewSession?: boolean }) {
  const store = new MultiUserGatewayStore(':memory:')
  const admin = store.createAccount('admin', 'admin', 'default', null)
  const grantee = store.createAccount('mnmn66', 'user', 'account-mnmn66', null)
  store.bindResource({ resourceType: 'machine', resourceId: 'fa608', ownerAccountId: admin.id, coreNamespace: 'default' })
  store.bindResource({ resourceType: 'machine', resourceId: 'vircs', ownerAccountId: admin.id, coreNamespace: 'default' })
  store.grant('machine', 'fa608', grantee.id, 'viewer')

  const specs = [
   { id: 's-new-on-fa608', machineId: 'fa608', host: 'FA608_INDEX' },
   { id: 's-on-vircs', machineId: 'vircs', host: 'WIN-GVHSJ7B378A' }
  ]
  if (options?.bindNewSession !== false) {
   for (const spec of specs) {
    store.bindResource({ resourceType: 'session', resourceId: spec.id, ownerAccountId: admin.id, coreNamespace: 'default' })
   }
  }
  const records = new Map(specs.map(spec => [spec.id, {
   id: spec.id,
   namespace: 'default',
   metadata: { path: '/tmp', host: spec.host, machineId: spec.machineId },
   agentState: null, active: false, createdAt: 1, updatedAt: 1, seq: 0
  }]))
  const engine = {
   getSessions: () => [...records.values()],
   getSessionsByNamespace: (namespace: string) => namespace === 'default' ? [...records.values()] : [],
   getSession: (id: string) => records.get(id),
   getOnlineMachinesByNamespace: () => [],
   getMachine: (id: string) => ({ id, namespace: 'default' })
  } as unknown as SyncEngine

  const app = new Hono<WebAppEnv>()
  mountExecutionRoutes(app, { store, jwtSecret, getSyncEngine: () => engine, getSseManager: () => null, getStore: () => null })
  return { store, app, admin, grantee, engine }
 }

 const idsOf = async (response: Response) =>
  ((await response.json()) as { sessions: Array<{ id: string }> }).sessions.map(s => s.id).sort()

 it('GET /api/sessions 列出被授权机器上的新会话，且不带出别的机器', async () => {
  const { store, app, grantee } = seed()
  const response = await app.request('/api/sessions', { headers: { authorization: `Bearer ${await sign(grantee.id)}` } })
  expect(response.status).toBe(200)
  expect(await idsOf(response)).toEqual(['s-new-on-fa608'])
  store.close()
 })

 it('机器上尚未绑定的会话按机器主人落绑定，不会被查看者认领', async () => {
  const { store, app, grantee, admin } = seed({ bindNewSession: false })
  const response = await app.request('/api/sessions', { headers: { authorization: `Bearer ${await sign(grantee.id)}` } })
  expect(await idsOf(response)).toEqual(['s-new-on-fa608'])
  expect(store.getResource('session', 's-new-on-fa608')).toMatchObject({
   ownerAccountId: admin.id,
   coreNamespace: 'default'
  })
  expect(store.getResource('session', 's-on-vircs')).toBeNull()
  store.close()
 })

 it('单条会话的读权限同样继承（此前 403）', async () => {
  const { store, grantee, engine } = seed()
  const app = new Hono<WebAppEnv>()
  app.use('*', createExecutionMiddleware({ store, jwtSecret, getSyncEngine: () => engine }))
  app.get('/api/sessions/:id', c => c.json({ ok: true, namespace: c.get('namespace') }))

  const granted = await app.request('/api/sessions/s-new-on-fa608', { headers: { authorization: `Bearer ${await sign(grantee.id)}` } })
  expect(granted.status).toBe(200)
  expect(await granted.json()).toEqual({ ok: true, namespace: 'default' })

  const denied = await app.request('/api/sessions/s-on-vircs', { headers: { authorization: `Bearer ${await sign(grantee.id)}` } })
  expect(denied.status).toBe(403)
  store.close()
 })

 it('SSE：机器上新建会话的 session-added 事件直达被授权人（不必再逐条授权）', async () => {
  const { store, grantee, engine } = seed()
  const sseManager = new SSEManager(0, new VisibilityTracker())
  const app = new Hono<WebAppEnv>()
  mountExecutionRoutes(app, {
   store, jwtSecret,
   getSyncEngine: () => engine,
   getSseManager: () => sseManager,
   getStore: () => null
  })
  const controller = new AbortController()
  const response = await app.request('/api/events', {
   headers: { authorization: `Bearer ${await sign(grantee.id)}` },
   signal: controller.signal
  })
  const reader = response.body!.getReader()
  expect(new TextDecoder().decode((await reader.read()).value)).toContain('"status":"connected"')

  sseManager.broadcast({ type: 'session-added', sessionId: 's-on-vircs', namespace: 'default' } as never)
  sseManager.broadcast({ type: 'session-added', sessionId: 's-new-on-fa608', namespace: 'default' } as never)
  const body = new TextDecoder().decode((await reader.read()).value)
  expect(body).toContain('"sessionId":"s-new-on-fa608"')
  expect(body).not.toContain('s-on-vircs')

  controller.abort()
  await reader.cancel()
  sseManager.stop()
  store.close()
 })
})

describe('/api/events 的订阅铺法与心跳', () => {
 const jwtSecret = new TextEncoder().encode('test-secret-test-secret-test-secret')
 const sign = (accountId: number) => new SignJWT({ gaid: accountId }).setProtectedHeader({ alg: 'HS256' }).sign(jwtSecret)

 /** 记录型 SSEManager 替身：只为数清一次连接到底开了几条订阅、分别落在哪个 namespace。 */
 function recordingManager() {
  const opened: Array<{ id: string; namespace: string; all: boolean }> = []
  const closed: string[] = []
  return {
   opened,
   closed,
   manager: {
    subscribe: (input: { id: string; namespace: string; all?: boolean }) => {
     opened.push({ id: input.id, namespace: input.namespace, all: Boolean(input.all) })
    },
    unsubscribe: (id: string) => { closed.push(id) }
   } as unknown as SSEManager
  }
 }

 /** grantCount 条会话授权 + 1 条机器授权，全部落在同一个外部 namespace。 */
 function seedGrants(grantCount: number) {
  const store = new MultiUserGatewayStore(':memory:')
  const owner = store.createAccount('owner', 'user', 'default', null)
  const grantee = store.createAccount('mnmn66', 'user', 'account-mnmn66', null)
  for (let i = 0; i < grantCount; i += 1) {
   store.bindResource({ resourceType: 'session', resourceId: `s${i}`, ownerAccountId: owner.id, coreNamespace: 'default' })
   store.grant('session', `s${i}`, grantee.id, 'viewer')
  }
  store.bindResource({ resourceType: 'machine', resourceId: 'fa608', ownerAccountId: owner.id, coreNamespace: 'default' })
  store.grant('machine', 'fa608', grantee.id, 'viewer')
  return { store, grantee }
 }

 it('订阅数只随 namespace 数增长，不随授权条数增长', async () => {
  const { store, grantee } = seedGrants(50)
  const { opened, manager } = recordingManager()
  const app = new Hono<WebAppEnv>()
  mountExecutionRoutes(app, {
   store, jwtSecret,
   getSyncEngine: () => null,
   getSseManager: () => manager,
   getStore: () => null
  })
  const controller = new AbortController()
  const response = await app.request('/api/events', {
   headers: { authorization: `Bearer ${await sign(grantee.id)}` },
   signal: controller.signal
  })
  const reader = response.body!.getReader()
  await reader.read()

  // 50 条 session grant + 1 条 machine grant，全落在 'default'；
  // 加上账号自己的 'account-mnmn66'，一共只该开 2 条订阅（此前是 1+51=52 条）。
  expect(opened).toHaveLength(2)
  expect(opened.map(s => s.namespace)).toEqual(['account-mnmn66', 'default'])
  expect(opened.every(s => s.all)).toBe(true)

  controller.abort()
  await reader.cancel()
  store.close()
 })

 it('多条订阅下心跳仍然发得出来（此前 ids.length===1 在心跳时求值，>1 条就全停）', async () => {
  const { store, grantee } = seedGrants(3)
  // heartbeatMs 调到 30ms，真跑 SSEManager 自己的定时器，不做时间替身。
  const sseManager = new SSEManager(30, new VisibilityTracker())
  const app = new Hono<WebAppEnv>()
  mountExecutionRoutes(app, {
   store, jwtSecret,
   getSyncEngine: () => null,
   getSseManager: () => sseManager,
   getStore: () => null
  })
  const controller = new AbortController()
  const response = await app.request('/api/events', {
   headers: { authorization: `Bearer ${await sign(grantee.id)}` },
   signal: controller.signal
  })
  const reader = response.body!.getReader()
  expect(new TextDecoder().decode((await reader.read()).value)).toContain('"status":"connected"')

  // 下一帧必须是心跳，而且只来一份（只有 index 0 那条订阅发）
  const frame = new TextDecoder().decode((await reader.read()).value)
  expect(frame).toContain('"type":"heartbeat"')
  expect(frame.match(/"type":"heartbeat"/g)).toHaveLength(1)

  controller.abort()
  await reader.cancel()
  sseManager.stop()
  store.close()
 })
})

describe('/api/usage/summary：可见性与会话列表同构，聚合走真实 hub Store', () => {
 const jwtSecret = new TextEncoder().encode('test-secret-test-secret-test-secret')
 const sign = (accountId: number) => new SignJWT({ gaid: accountId }).setProtectedHeader({ alg: 'HS256' }).sign(jwtSecret)

 function usageEnvelope(messageId: string, inputTokens: number) {
  return {
   role: 'agent',
   content: {
    type: 'output',
    data: {
     type: 'assistant',
     timestamp: '2026-07-20T10:00:00.000Z',
     message: {
      id: messageId,
      model: 'claude-fable-5',
      usage: { input_tokens: inputTokens, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
     }
    }
   }
  }
 }

 /** admin 1 个会话（100 tokens，机器 vircs），peter 2 个会话（各 10 tokens，机器 peter-mac）。 */
 function seedUsage() {
  const gateway = new MultiUserGatewayStore(':memory:')
  const admin = gateway.createAccount('admin', 'admin', 'default', null)
  const peter = gateway.createAccount('peter', 'user', 'default', null)
  const other = gateway.createAccount('mnmn66', 'user', 'default', null)

  const hubStore = new HubStore(':memory:')
  const specs = [
   { id: 's-admin', owner: admin.id, host: 'vircs', tokens: 100 },
   { id: 's-peter-1', owner: peter.id, host: 'peter-mac', tokens: 10 },
   { id: 's-peter-2', owner: peter.id, host: 'peter-mac', tokens: 10 }
  ]
  for (const spec of specs) {
   hubStore.sessions.getOrCreateSession(`tag-${spec.id}`, { path: `/tmp/${spec.id}`, host: spec.host }, null, 'default', undefined, undefined, undefined, spec.id)
   hubStore.messages.addMessage(spec.id, usageEnvelope(`msg-${spec.id}`, spec.tokens), undefined, undefined, Date.parse('2026-07-20T10:00:00.000Z'))
   gateway.bindResource({ resourceType: 'session', resourceId: spec.id, ownerAccountId: spec.owner, coreNamespace: 'default' })
  }

  const records = new Map(specs.map(spec => [spec.id, {
   id: spec.id, namespace: 'default', metadata: { path: `/tmp/${spec.id}`, host: spec.host, machineId: `${spec.host}-machine` }, agentState: null, active: false, createdAt: 1, updatedAt: 1, seq: 0
  }]))
  const engine = {
   getSessions: () => [...records.values()],
   getSessionsByNamespace: (namespace: string) => [...records.values()].filter(record => record.namespace === namespace),
   getSession: (id: string) => records.get(id)
  } as unknown as SyncEngine

  const app = new Hono<WebAppEnv>()
  mountExecutionRoutes(app, { store: gateway, jwtSecret, getSyncEngine: () => engine, getSseManager: () => null, getStore: () => hubStore })
  return { gateway, hubStore, app, admin, peter, other, records }
 }

 type UsageResponse = {
  models: Array<{ model: string; requestCount: number; inputTokens: number }>
  totals: { requestCount: number; inputTokens: number }
  hosts: Array<{ host: string; sessionCount: number; totalTokens: number; requestCount: number; owner: string | null; platform: string | null }>
 }

 it('admin 统计覆盖整个 namespace（含别人拥有的会话）', async () => {
  const { gateway, app, admin } = seedUsage()
  const response = await app.request('/api/usage/summary', { headers: { authorization: `Bearer ${await sign(admin.id)}` } })
  expect(response.status).toBe(200)
  const body = await response.json() as UsageResponse
  expect(body.totals).toMatchObject({ requestCount: 3, inputTokens: 120 })
  expect(body.hosts.map(h => h.host).sort()).toEqual(['peter-mac', 'vircs'])
  gateway.close()
 })

 it('admin summary and timeseries include foreign unbound sessions without claiming them; users do not', async () => {
  const { gateway, hubStore, app, admin, peter, records } = seedUsage()
  try {
   const id = 'foreign-unbound'
   records.set(id, { ...records.get('s-admin')!, id, namespace: 'mnmn66', metadata: { path: '/foreign', host: 'foreign-host', machineId: 'foreign-machine' } })
   hubStore.sessions.getOrCreateSession('foreign-tag', { path: '/foreign', host: 'foreign-host' }, null, 'mnmn66', undefined, undefined, undefined, id)
   hubStore.messages.addMessage(id, usageEnvelope('foreign-message', 7), undefined, undefined, Date.parse('2026-07-20T10:00:00.000Z'))
   const headers = { authorization: `Bearer ${await sign(admin.id)}` }
   const summary = await (await app.request('/api/usage/summary', { headers })).json() as UsageResponse
   expect(summary.totals).toMatchObject({ requestCount: 4, inputTokens: 127 })
   expect(summary.hosts.map(host => host.host)).toContain('foreign-host')
   const timeseriesResponse = await app.request('/api/usage/timeseries?since=2026-01-01T00:00:00.000Z&until=2027-01-01T00:00:00.000Z&bucket=week', { headers })
   expect(timeseriesResponse.status).toBe(200)
   const timeseries = await timeseriesResponse.json() as { series: Array<{ inputTokens: number[] }> }
   expect(timeseries.series.flatMap(series => series.inputTokens).reduce((sum, value) => sum + value, 0)).toBe(127)
   const userSummary = await (await app.request('/api/usage/summary', { headers: { authorization: `Bearer ${await sign(peter.id)}` } })).json() as UsageResponse
   expect(userSummary.totals).toMatchObject({ requestCount: 2, inputTokens: 20 })
   expect(userSummary.hosts.map(host => host.host)).not.toContain('foreign-host')
   expect(gateway.getResource('session', id)).toBeNull()
  } finally {
   gateway.close()
   hubStore.close()
  }
 })

 // 机器列表从裸主机名升级成带统计的榜：每台自带会话数、token 合计、请求数
 // 与归属，用量页据此直接排出「谁在烧」，不必逐台切筛选去比。
 it('机器榜按用量降序，逐台带上会话数与 token 合计', async () => {
  const { gateway, app, admin } = seedUsage()
  const response = await app.request('/api/usage/summary', { headers: { authorization: `Bearer ${await sign(admin.id)}` } })
  const body = await response.json() as UsageResponse

  expect(body.hosts.map(h => h.host)).toEqual(['vircs', 'peter-mac'])
  expect(body.hosts[0]).toMatchObject({ host: 'vircs', sessionCount: 1, totalTokens: 100, requestCount: 1 })
  expect(body.hosts[1]).toMatchObject({ host: 'peter-mac', sessionCount: 2, totalTokens: 20, requestCount: 2 })
  gateway.close()
 })

 it('选中某台机器后，机器榜的统计仍是全量——否则筛选态下无从比较', async () => {
  const { gateway, app, admin } = seedUsage()
  const response = await app.request('/api/usage/summary?host=vircs', { headers: { authorization: `Bearer ${await sign(admin.id)}` } })
  const body = await response.json() as UsageResponse

  // 模型表只剩 vircs 那一条…
  expect(body.totals).toMatchObject({ requestCount: 1, inputTokens: 100 })
  // …但机器榜两台都在，且 peter-mac 的数字没被筛成 0。
  expect(body.hosts.map(h => h.host)).toEqual(['vircs', 'peter-mac'])
  expect(body.hosts[1]).toMatchObject({ host: 'peter-mac', totalTokens: 20 })
  gateway.close()
 })

 it('普通用户只统计自己拥有的会话，机器下拉不泄漏他人机器', async () => {
  const { gateway, app, peter } = seedUsage()
  const response = await app.request('/api/usage/summary', { headers: { authorization: `Bearer ${await sign(peter.id)}` } })
  const body = await response.json() as UsageResponse
  expect(body.totals).toMatchObject({ requestCount: 2, inputTokens: 20 })
  expect(body.hosts.map(h => h.host)).toEqual(['peter-mac'])
  gateway.close()
 })

 it('被授权机器的用户能统计到该机器上的会话用量（继承与列表同构）', async () => {
  const { gateway, app, admin, other } = seedUsage()
  gateway.bindResource({ resourceType: 'machine', resourceId: 'vircs-machine', ownerAccountId: admin.id, coreNamespace: 'default' })
  gateway.grant('machine', 'vircs-machine', other.id, 'viewer')
  const response = await app.request('/api/usage/summary', { headers: { authorization: `Bearer ${await sign(other.id)}` } })
  const body = await response.json() as UsageResponse
  // s-admin 跑在 vircs-machine 上：100 tokens；peter 的两条不在这台机器上
  expect(body.totals).toMatchObject({ requestCount: 1, inputTokens: 100 })
  expect(body.hosts.map(h => h.host)).toEqual(['vircs'])
  gateway.close()
 })

 it('被授权 viewer 能统计到被授权那一条会话的用量', async () => {
  const { gateway, app, other } = seedUsage()
  gateway.grant('session', 's-peter-1', other.id, 'viewer')
  const response = await app.request('/api/usage/summary', { headers: { authorization: `Bearer ${await sign(other.id)}` } })
  const body = await response.json() as UsageResponse
  expect(body.totals).toMatchObject({ requestCount: 1, inputTokens: 10 })
  gateway.close()
 })

 it('host 筛选把统计范围限到该机器的会话', async () => {
  const { gateway, app, admin } = seedUsage()
  const response = await app.request('/api/usage/summary?host=vircs', { headers: { authorization: `Bearer ${await sign(admin.id)}` } })
  const body = await response.json() as UsageResponse
  expect(body.totals).toMatchObject({ requestCount: 1, inputTokens: 100 })
  gateway.close()
 })

 it('未认证请求得到 401', async () => {
  const { gateway, app } = seedUsage()
  const response = await app.request('/api/usage/summary')
  expect(response.status).toBe(401)
  gateway.close()
 })
})

describe('POST /api/client-errors', () => {
 const jwtSecret = new TextEncoder().encode('test-secret-test-secret-test-secret')

 function buildApp(store: MultiUserGatewayStore, userId = 7) {
  const app = new Hono<WebAppEnv>()
  app.use('*', async (c, next) => {
   c.set('userId', userId)
   c.set('namespace', 'default')
   await next()
  })
  mountExecutionRoutes(app, {
   store,
   jwtSecret,
   getSyncEngine: () => null,
   getSseManager: () => null,
   getStore: () => null
  })
  return app
 }

 it('把上报写进 console.error 并回 ok，带 uid/gaid 归因', async () => {
  const store = new MultiUserGatewayStore(':memory:')
  const owner = store.createAccount('owner', 'user', 'owner-namespace', null)
  const token = await new SignJWT({ gaid: owner.id }).setProtectedHeader({ alg: 'HS256' }).sign(jwtSecret)
  const app = buildApp(store)
  const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

  const response = await app.request('/api/client-errors', {
   method: 'POST',
   headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
   body: JSON.stringify({
    message: 'TypeError: boom',
    stack: 'TypeError: boom\n  at render',
    source: 'error-boundary',
    url: 'https://hub.example/sessions/x',
    userAgent: 'test-agent',
    appVersion: '0.25.1',
    occurredAt: 1754500000000
   })
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ ok: true })
  expect(spy).toHaveBeenCalledTimes(1)
  const payload = JSON.parse(spy.mock.calls[0]?.[1] as string) as Record<string, unknown>
  expect(payload).toMatchObject({
   uid: 7,
   gaid: owner.id,
   source: 'error-boundary',
   message: 'TypeError: boom',
   appVersion: '0.25.1'
  })
  spy.mockRestore()
  store.close()
 })

 it('缺 message 的载荷拒收 400', async () => {
  const store = new MultiUserGatewayStore(':memory:')
  const app = buildApp(store)
  const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

  const response = await app.request('/api/client-errors', {
   method: 'POST',
   headers: { 'content-type': 'application/json' },
   body: JSON.stringify({ stack: 'no message here' })
  })

  expect(response.status).toBe(400)
  expect(spy).not.toHaveBeenCalled()
  spy.mockRestore()
  store.close()
 })

 it('同一账号打满窗口配额后静默丢弃，不再落日志', async () => {
  const store = new MultiUserGatewayStore(':memory:')
  const app = buildApp(store)
  const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

  for (let index = 0; index < 35; index += 1) {
   const response = await app.request('/api/client-errors', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: `crash ${index}` })
   })
   expect(response.status).toBe(200)
  }

  expect(spy).toHaveBeenCalledTimes(30)
  spy.mockRestore()
  store.close()
 })
})

describe('目录限定的机器授权：只放行限定目录内的机器写操作与会话', () => {
 const jwtSecret = new TextEncoder().encode('test-secret-test-secret-test-secret')
 const sign = (accountId: number) => new SignJWT({ gaid: accountId }).setProtectedHeader({ alg: 'HS256' }).sign(jwtSecret)
 const SCOPE = 'C:\\Users\\Administrator\\peter'

 /** vircs（owner 的机器）上两条会话：一条在 peter\ 内，一条在 hapi\ 里。 */
 function seedScoped(pathPrefix: readonly string[] | string | null = SCOPE) {
  const store = new MultiUserGatewayStore(':memory:')
  const admin = store.createAccount('admin', 'admin', 'default', null)
  const owner = store.createAccount('owner', 'user', 'default', null)
  const peter = store.createAccount('peter', 'user', 'default', null)
  store.bindResource({ resourceType: 'machine', resourceId: 'm-vircs', ownerAccountId: owner.id, coreNamespace: 'default' })
  const records = new Map([
   ['s-in', {
    id: 's-in', namespace: 'default', active: false, createdAt: 1, updatedAt: 1, seq: 0, agentState: null,
    metadata: { machineId: 'm-vircs', path: 'C:\\Users\\Administrator\\peter\\mac' }
   }],
   ['s-out', {
    id: 's-out', namespace: 'default', active: false, createdAt: 1, updatedAt: 1, seq: 0, agentState: null,
    metadata: { machineId: 'm-vircs', path: 'C:\\Users\\Administrator\\hapi' }
   }]
  ])
  for (const id of records.keys()) {
   store.bindResource({ resourceType: 'session', resourceId: id, ownerAccountId: owner.id, coreNamespace: 'default' })
  }
  store.grant('machine', 'm-vircs', peter.id, 'operator', pathPrefix)

  const machines = [{ id: 'm-vircs', namespace: 'default' }]
  const engine = {
   getSessions: () => [...records.values()],
   getMachines: () => machines,
   getSessionsByNamespace: () => [...records.values()],
   getSession: (id: string) => records.get(id),
   getOnlineMachinesByNamespace: () => machines,
   getMachine: (id: string) => machines.find(m => m.id === id) ?? null
  } as unknown as SyncEngine

  const app = new Hono<WebAppEnv>()
  mountExecutionRoutes(app, { store, jwtSecret, getSyncEngine: () => engine, getSseManager: () => null, getStore: () => null })
  app.use('/api/*', createExecutionMiddleware({ store, jwtSecret, getSyncEngine: () => engine }))
  // 仿真实机器路由：spawn 回显 body 里的 directory —— 中间件为了校验路径读过一次
  // body，路由必须仍读得到（Hono 的 bodyCache），否则线上会变成 400 Invalid body。
  app.post('/api/machines/:id/spawn', async (c) => {
   const body = await c.req.json().catch(() => null) as { directory?: string } | null
   return body?.directory
    ? c.json({ sessionId: 'spawned', echoed: body.directory })
    : c.json({ error: 'Invalid body' }, 400)
  })
  app.post('/api/machines/:id/list-directory', c => c.json({ ok: true }))
  app.post('/api/machines/:id/create-directory', c => c.json({ ok: true }))
  // 真实路由按 c.get('machinePathScope') 过滤越界项（见 machines.test.ts），
  // 这里只回显中间件交下来的限定值，验证交接这一环。
  app.post('/api/machines/:id/paths/exists', c => c.json({ scope: c.get('machinePathScope') ?? null }))
  app.patch('/api/machines/:id', c => c.json({ ok: true }))
  return { store, app, admin, owner, peter }
 }

 const send = (app: Hono<WebAppEnv>, path: string, token: string, body: unknown, method = 'POST') =>
  app.request(path, {
   method,
   headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
   body: JSON.stringify(body)
  })

 it('限定目录内 spawn 放行，且路由仍读得到 body（中间件不能把 body 吃掉）', async () => {
  const { store, app, peter } = seedScoped()
  const response = await send(app, '/api/machines/m-vircs/spawn', await sign(peter.id),
   { directory: 'C:\\Users\\Administrator\\peter\\mac\\_edit' })
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ sessionId: 'spawned', echoed: 'C:\\Users\\Administrator\\peter\\mac\\_edit' })
  store.close()
 })

 it('限定目录外 spawn 拒绝', async () => {
  const { store, app, peter } = seedScoped()
  const response = await send(app, '/api/machines/m-vircs/spawn', await sign(peter.id),
   { directory: 'C:\\Users\\Administrator\\hapi' })
  expect(response.status).toBe(403)
  store.close()
 })

 it('限定目录外的 list-directory / create-directory 拒绝，内的放行', async () => {
  const { store, app, peter } = seedScoped()
  const token = await sign(peter.id)
  expect((await send(app, '/api/machines/m-vircs/list-directory', token, { path: 'C:\\Users\\Administrator' })).status).toBe(403)
  expect((await send(app, '/api/machines/m-vircs/list-directory', token, { path: SCOPE })).status).toBe(200)
  expect((await send(app, '/api/machines/m-vircs/create-directory', token,
   { parentPath: 'C:\\Users\\Administrator\\hapi', name: 'x' })).status).toBe(403)
  store.close()
 })

 // paths/exists 不整批拒：中间件只把 scope 交给路由，由路由把越界项过滤成
 // 「不存在」。整批 403 会被一条陈旧的越界路径带崩前端整列最近目录。
 it('paths/exists 不被整批拒，且把限定值交给路由', async () => {
  const { store, app, peter } = seedScoped()
  const token = await sign(peter.id)
  const mixed = await send(app, '/api/machines/m-vircs/paths/exists', token,
   { paths: [SCOPE, 'C:\\Users\\Administrator\\cx2cc'] })
  expect(mixed.status).toBe(200)
  expect(await mixed.json()).toEqual({ scope: ['c:/users/administrator/peter'] })
  store.close()
 })

 it('未限定的机器授权下路由拿到的 scope 是空的', async () => {
  const { store, app, peter } = seedScoped(null)
  const response = await send(app, '/api/machines/m-vircs/paths/exists', await sign(peter.id),
   { paths: ['C:\\Users\\Administrator\\cx2cc'] })
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ scope: null })
  store.close()
 })

 it('没有可校验路径的机器写操作（改机器名）一律拒绝 —— 白名单之外默认拒', async () => {
  const { store, app, peter } = seedScoped()
  const response = await send(app, '/api/machines/m-vircs', await sign(peter.id), { displayName: 'x' }, 'PATCH')
  expect(response.status).toBe(403)
  store.close()
 })

 it('未限定的机器授权不受影响：整机可写', async () => {
  const { store, app, peter } = seedScoped(null)
  const token = await sign(peter.id)
  expect((await send(app, '/api/machines/m-vircs/spawn', token, { directory: 'C:\\Users\\Administrator\\hapi' })).status).toBe(200)
  expect((await send(app, '/api/machines/m-vircs', token, { displayName: 'x' }, 'PATCH')).status).toBe(200)
  store.close()
 })

 it('机器主人不受限定约束（限定是 grant 的属性）', async () => {
  const { store, app, owner } = seedScoped()
  const response = await send(app, '/api/machines/m-vircs/spawn', await sign(owner.id),
   { directory: 'C:\\Users\\Administrator\\hapi' })
  expect(response.status).toBe(200)
  store.close()
 })

 it('会话列表只含限定目录内的会话 —— 机器授权不再把整机会话铺开', async () => {
  const { store, app, peter } = seedScoped()
  const response = await app.request('/api/sessions', { headers: { authorization: `Bearer ${await sign(peter.id)}` } })
  expect(response.status).toBe(200)
  const ids = ((await response.json()) as { sessions: Array<{ id: string }> }).sessions.map(s => s.id)
  expect(ids).toEqual(['s-in'])
  store.close()
 })

 it('机器本身仍出现在机器列表里 —— 否则 UI 里选不到这台机器，限定授权等于白开', async () => {
  const { store, app, peter } = seedScoped()
  const response = await app.request('/api/machines', { headers: { authorization: `Bearer ${await sign(peter.id)}` } })
  expect(response.status).toBe(200)
  const ids = ((await response.json()) as { machines: Array<{ id: string }> }).machines.map(m => m.id)
  expect(ids).toEqual(['m-vircs'])
  store.close()
 })

 it('限定外的会话仍可通过显式 session grant 单独共享', async () => {
  const { store, app, peter } = seedScoped()
  store.grant('session', 's-out', peter.id, 'viewer')
  const response = await app.request('/api/sessions', { headers: { authorization: `Bearer ${await sign(peter.id)}` } })
  const ids = ((await response.json()) as { sessions: Array<{ id: string }> }).sessions.map(s => s.id).sort()
  expect(ids).toEqual(['s-in', 's-out'])
  store.close()
 })

 it('限定外的会话本身也操作不了（会话路由走 sessionAccessLevel）', async () => {
  const { store, app, peter } = seedScoped()
  const token = await sign(peter.id)
  app.post('/api/sessions/:id/messages', c => c.json({ ok: true }))
  expect((await send(app, '/api/sessions/s-out/messages', token, {})).status).toBe(403)
  expect((await send(app, '/api/sessions/s-in/messages', token, {})).status).toBe(200)
  store.close()
 })

 it('多目录授权：两个不相邻目录均可 spawn/list/create，C:\\ 与旁系目录全部 403', async () => {
  const { store, app, peter } = seedScoped(['C:\\Users\\Tadokoro', 'C:\\Peter'])
  const token = await sign(peter.id)
  for (const directory of ['C:\\Users\\Tadokoro', 'C:\\Users\\Tadokoro\\proj', 'C:\\Peter', 'c:/peter/work']) {
   expect((await send(app, '/api/machines/m-vircs/spawn', token, { directory })).status).toBe(200)
   expect((await send(app, '/api/machines/m-vircs/list-directory', token, { path: directory })).status).toBe(200)
   expect((await send(app, '/api/machines/m-vircs/create-directory', token, { parentPath: directory, name: 'sub' })).status).toBe(200)
  }
  for (const directory of ['C:\\', 'C:\\vircs-projects', 'C:\\Users\\Other', 'C:\\PeterX', 'C:\\Peter\\..\\Users\\Other']) {
   expect((await send(app, '/api/machines/m-vircs/spawn', token, { directory })).status).toBe(403)
   expect((await send(app, '/api/machines/m-vircs/list-directory', token, { path: directory })).status).toBe(403)
   expect((await send(app, '/api/machines/m-vircs/create-directory', token, { parentPath: directory, name: 'sub' })).status).toBe(403)
  }
  store.close()
 })
})

describe('bind-on-view 不抢别人机器上的会话（2026-08-10 生产事故：15 条 vircs 会话被抢归属）', () => {
 const jwtSecret = new TextEncoder().encode('test-secret-test-secret-test-secret')
 const sign = (accountId: number) => new SignJWT({ gaid: accountId }).setProtectedHeader({ alg: 'HS256' }).sign(jwtSecret)

 /**
  * 生产事故形态：历史账号 default_namespace 全是 `default`，admin 的机器 m-vircs
  * 上有一条**未绑定**会话（CLI 起的，还没人列过表），peter 与 admin 同 namespace。
  * 另放一条挂在未注册机器上的孤儿会话，钉住旧行为不被误杀。
  */
 function seedUnbound() {
  const store = new MultiUserGatewayStore(':memory:')
  const admin = store.createAccount('admin', 'admin', 'default', null)
  const owner = store.createAccount('owner', 'user', 'default', null)
  const peter = store.createAccount('peter', 'user', 'default', null)
  store.bindResource({ resourceType: 'machine', resourceId: 'm-vircs', ownerAccountId: owner.id, coreNamespace: 'default' })
  const records = new Map([
   ['s-unbound-vircs', {
    id: 's-unbound-vircs', namespace: 'default', active: true, createdAt: 1, updatedAt: 2, seq: 0, agentState: null,
    metadata: { machineId: 'm-vircs', path: 'C:\\Users\\Administrator\\hapi' }
   }],
   ['s-orphan-unregistered', {
    id: 's-orphan-unregistered', namespace: 'default', active: false, createdAt: 1, updatedAt: 1, seq: 0, agentState: null,
    metadata: { machineId: 'm-ghost', path: 'D:\\somewhere' }
   }]
  ])
  const machines = [{ id: 'm-vircs', namespace: 'default' }]
  const engine = {
   getSessions: () => [...records.values()],
   getMachines: () => machines,
   getSessionsByNamespace: () => [...records.values()],
   getSession: (id: string) => records.get(id),
   getOnlineMachinesByNamespace: () => machines,
   getMachine: (id: string) => machines.find(m => m.id === id) ?? null
  } as unknown as SyncEngine
  const app = new Hono<WebAppEnv>()
  mountExecutionRoutes(app, { store, jwtSecret, getSyncEngine: () => engine, getSseManager: () => null, getStore: () => null })
  return { store, app, admin, owner, peter }
 }

 const list = async (app: Hono<WebAppEnv>, accountId: number) =>
  app.request('/api/sessions', { headers: { authorization: `Bearer ${await sign(accountId)}` } })

 it('同 namespace 的旁观者列表后：别人机器上的未绑定会话不被认领、也不可见', async () => {
  const { store, app, peter } = seedUnbound()
  const response = await list(app, peter.id)
  expect(response.status).toBe(200)
  const ids = ((await response.json()) as { sessions: Array<{ id: string }> }).sessions.map(s => s.id)
  expect(ids).not.toContain('s-unbound-vircs')
  // 关键：不是「这次没显示」，是压根没落 owner 行
  expect(store.getResource('session', 's-unbound-vircs')).toBeNull()
  store.close()
 })

 it('机器主人列表后认领成自己的（原行为保留）', async () => {
  const { store, app, owner } = seedUnbound()
  await list(app, owner.id)
  expect(store.getResource('session', 's-unbound-vircs')?.ownerAccountId).toBe(owner.id)
  store.close()
 })

 it('admin 列表全局可见但不创建或转移任何会话归属', async () => {
  const { store, app, admin } = seedUnbound()
  const response = await list(app, admin.id)
  const ids = ((await response.json()) as { sessions: Array<{ id: string }> }).sessions.map(s => s.id)
  expect(ids).toContain('s-unbound-vircs')
  expect(store.getResource('session', 's-unbound-vircs')).toBeNull()
  expect(store.getResource('session', 's-orphan-unregistered')).toBeNull()
  store.close()
 })

 it('未注册机器上的孤儿会话仍按原行为认领给查看者', async () => {
  const { store, app, peter } = seedUnbound()
  await list(app, peter.id)
  expect(store.getResource('session', 's-orphan-unregistered')?.ownerAccountId).toBe(peter.id)
  store.close()
 })

 it('带目录限定的被授权者列表：限定内未绑定会话绑给机器主人，限定外不落任何绑定', async () => {
  const { store, app, owner, peter } = seedUnbound()
  store.grant('machine', 'm-vircs', peter.id, 'operator', 'C:\\Users\\Administrator\\peter')
  await list(app, peter.id)
  // s-unbound-vircs 在 hapi\ 下（限定外）：第 1 支跳过（别人机器）、第 3 支跳过（越界）
  expect(store.getResource('session', 's-unbound-vircs')).toBeNull()
  store.close()
 })
})

describe('admin global visibility without ownership mutation', () => {
 const jwtSecret = new TextEncoder().encode('test-secret-test-secret-test-secret')

 it('lists and reads bound and orphan resources across namespaces without claiming them', async () => {
  const store = new MultiUserGatewayStore(':memory:')
  try {
   const admin = store.createAccount('admin', 'admin', 'admin-ns')
   const owner = store.createAccount('owner', 'user', 'foreign-ns')
   store.bindResource({ resourceType: 'session', resourceId: 'bound', ownerAccountId: owner.id, coreNamespace: 'foreign-ns' })
   store.bindResource({ resourceType: 'machine', resourceId: 'bound-machine', ownerAccountId: owner.id, coreNamespace: 'foreign-ns' })
   const sessions = ['bound', 'orphan'].map(id => ({
    id, namespace: 'foreign-ns', metadata: null, agentState: null,
    active: false, createdAt: 1, updatedAt: 1, seq: 0
   }))
   const machines = ['bound-machine', 'orphan-machine'].map(id => ({ id, namespace: 'foreign-ns' }))
   const engine = {
    getSessions: () => sessions,
    getMachines: () => machines,
    getSessionsByNamespace: (namespace: string) => sessions.filter(session => session.namespace === namespace),
    getOnlineMachinesByNamespace: (namespace: string) => machines.filter(machine => machine.namespace === namespace),
    getSession: (id: string) => sessions.find(session => session.id === id),
    getMachine: (id: string) => machines.find(machine => machine.id === id)
   } as unknown as SyncEngine
   const app = new Hono<WebAppEnv>()
   mountExecutionRoutes(app, { store, jwtSecret, getSyncEngine: () => engine, getSseManager: () => null, getStore: () => null })
   app.use('/api/*', createExecutionMiddleware({ store, jwtSecret, getSyncEngine: () => engine }))
   app.get('/api/sessions/:id', c => c.json({ namespace: c.get('namespace') }))
   app.get('/api/machines/:id', c => c.json({ namespace: c.get('namespace') }))
   const token = await new SignJWT({ gaid: admin.id }).setProtectedHeader({ alg: 'HS256' }).sign(jwtSecret)
   const headers = { authorization: `Bearer ${token}` }
   const sessionResponse = await app.request('/api/sessions', { headers })
   expect(sessionResponse.status).toBe(200)
   expect(await sessionResponse.json()).toMatchObject({ sessions: [{ id: 'bound' }, { id: 'orphan' }] })
   const machineResponse = await app.request('/api/machines', { headers })
   expect(machineResponse.status).toBe(200)
   expect(await machineResponse.json()).toEqual({ machines: [{ ...machines[0], ownerUsername: 'owner' }, machines[1]] })
   for (const path of ['/api/sessions/bound', '/api/sessions/orphan', '/api/machines/bound-machine', '/api/machines/orphan-machine']) {
    const response = await app.request(path, { headers })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ namespace: 'foreign-ns' })
   }
   expect(store.getResource('session', 'bound')?.ownerAccountId).toBe(owner.id)
   expect(store.getResource('machine', 'bound-machine')?.ownerAccountId).toBe(owner.id)
   expect(store.getResource('session', 'orphan')).toBeNull()
   expect(store.getResource('machine', 'orphan-machine')).toBeNull()
  } finally {
   store.close()
  }
 })

 it('streams events and toasts for a namespace created after the admin connects', async () => {
  const store = new MultiUserGatewayStore(':memory:')
  const manager = new SSEManager(0, new VisibilityTracker())
  const controller = new AbortController()
  let cancelReader: (() => Promise<void>) | undefined
  try {
   const admin = store.createAccount('admin', 'admin', 'admin-ns')
   const token = await new SignJWT({ gaid: admin.id }).setProtectedHeader({ alg: 'HS256' }).sign(jwtSecret)
   const app = new Hono<WebAppEnv>()
   mountExecutionRoutes(app, { store, jwtSecret, getSyncEngine: () => null, getSseManager: () => manager, getStore: () => null })
   const response = await app.request(`/api/events?token=${encodeURIComponent(token)}`, { signal: controller.signal })
   expect(response.status).toBe(200)
   const reader = response.body!.getReader()
   cancelReader = () => reader.cancel()
   expect(new TextDecoder().decode((await reader.read()).value)).toContain('connected')
   manager.broadcast({ type: 'session-updated', sessionId: 'future-session', namespace: 'future-ns' })
   expect(new TextDecoder().decode((await reader.read()).value)).toContain('future-session')
   expect(await manager.sendToast('future-ns', {
    type: 'toast', data: { title: 'Done', body: 'Ready', sessionId: 'future-session', url: '/sessions/future-session' }
   })).toBe(1)
   expect(new TextDecoder().decode((await reader.read()).value)).toContain('"type":"toast"')
   expect(store.getResource('session', 'future-session')).toBeNull()
  } finally {
   controller.abort()
   await cancelReader?.()
   manager.stop()
   store.close()
  }
 })
})

describe('admin global namespace coverage without ownership changes', () => {
 const jwtSecret = new TextEncoder().encode('test-secret-test-secret-test-secret')
 const sign = (accountId: number) => new SignJWT({ gaid: accountId }).setProtectedHeader({ alg: 'HS256' }).sign(jwtSecret)

 function seed() {
  const store = new MultiUserGatewayStore(':memory:')
  const admin = store.createAccount('admin', 'admin', 'default', null)
  const owner = store.createAccount('owner', 'user', 'owner-namespace', null)
  const stranger = store.createAccount('stranger', 'user', 'stranger-namespace', null)
  const records = [
   { id: 'local', namespace: 'default' },
   { id: 'foreign-bound', namespace: owner.defaultNamespace },
   // No session/machine binding or account namespace points to this namespace.
   { id: 'foreign-unbound', namespace: 'mnmn66' }
  ].map(record => ({ ...record, metadata: null, agentState: null, active: false, createdAt: 1, updatedAt: 1, seq: 0 }))
  const machines = [
   { id: 'bound-machine', namespace: owner.defaultNamespace, active: false },
   { id: 'unbound-machine', namespace: 'mnmn66', active: false }
  ]
  store.bindResource({ resourceType: 'session', resourceId: 'foreign-bound', ownerAccountId: owner.id, coreNamespace: owner.defaultNamespace })
  store.bindResource({ resourceType: 'machine', resourceId: 'bound-machine', ownerAccountId: owner.id, coreNamespace: owner.defaultNamespace })
  const engine = {
   getSessions: () => records,
   getSessionsByNamespace: (namespace: string) => records.filter(record => record.namespace === namespace),
   getSession: (id: string) => records.find(record => record.id === id),
   getMachines: () => machines,
   getOnlineMachinesByNamespace: () => [],
   getMachine: (id: string) => machines.find(machine => machine.id === id)
  } as unknown as SyncEngine
  const app = new Hono<WebAppEnv>()
  app.use('*', createExecutionMiddleware({ store, jwtSecret, getSyncEngine: () => engine }))
  mountExecutionRoutes(app, { store, jwtSecret, getSyncEngine: () => engine, getSseManager: () => null, getStore: () => null })
  app.get('/api/sessions/:id', c => c.json({ namespace: c.get('namespace') }))
  app.get('/api/machines/:id', c => c.json({ namespace: c.get('namespace') }))
  return { store, app, admin, owner, stranger }
 }

 it('lists bound and unbound sessions and offline machines globally and reads every listed detail', async () => {
  const { store, app, admin, owner } = seed()
  try {
   const headers = { authorization: `Bearer ${await sign(admin.id)}` }
   const sessions = await (await app.request('/api/sessions', { headers })).json() as { sessions: Array<{ id: string }> }
   expect(sessions.sessions.map(session => session.id).sort()).toEqual(['foreign-bound', 'foreign-unbound', 'local'])
   const machines = await (await app.request('/api/machines', { headers })).json() as { machines: Array<{ id: string; ownerUsername?: string }> }
   expect(machines.machines.map(machine => machine.id).sort()).toEqual(['bound-machine', 'unbound-machine'])
   expect(machines.machines.find(machine => machine.id === 'bound-machine')?.ownerUsername).toBe('owner')
   expect(machines.machines.find(machine => machine.id === 'unbound-machine')?.ownerUsername).toBeUndefined()
   for (const [type, rows] of [['sessions', sessions.sessions], ['machines', machines.machines]] as const) {
    for (const row of rows) {
     const detail = await app.request(`/api/${type}/${row.id}`, { headers })
     expect(detail.status).toBe(200)
     expect(await detail.json()).toEqual({ namespace: row.id === 'local' ? 'default' : row.id.includes('unbound') ? 'mnmn66' : owner.defaultNamespace })
    }
   }
   expect(store.getResource('session', 'local')).toBeNull()
   expect(store.getResource('session', 'foreign-bound')?.ownerAccountId).toBe(owner.id)
   expect(store.getResource('machine', 'bound-machine')?.ownerAccountId).toBe(owner.id)
   expect(store.getResource('session', 'foreign-unbound')).toBeNull()
   expect(store.getResource('machine', 'unbound-machine')).toBeNull()
   expect((await app.request('/api/sessions/missing', { headers })).status).toBe(403)
  } finally { store.close() }
 })

 it('discovery is global and read-only; ordinary users neither list nor read foreign records', async () => {
  const { store, app, admin, stranger } = seed()
  try {
   const adminHeaders = { authorization: `Bearer ${await sign(admin.id)}` }
   const discovery = await (await app.request('/api/sessions?order=updatedAt&limit=30', { headers: adminHeaders })).json() as { sessions: Array<{ id: string }> }
   expect(discovery.sessions.map(session => session.id).sort()).toEqual(['foreign-bound', 'foreign-unbound', 'local'])
   expect(store.getResource('session', 'local')).toBeNull()
   const headers = { authorization: `Bearer ${await sign(stranger.id)}` }
   expect(await (await app.request('/api/sessions', { headers })).json()).toEqual({ sessions: [] })
   expect(await (await app.request('/api/machines', { headers })).json()).toEqual({ machines: [] })
   for (const path of ['/api/sessions/foreign-bound', '/api/sessions/foreign-unbound', '/api/machines/bound-machine', '/api/machines/unbound-machine']) {
    expect((await app.request(path, { headers })).status).toBe(403)
   }
   expect(store.getResource('session', 'foreign-unbound')).toBeNull()
   expect(store.getResource('machine', 'unbound-machine')).toBeNull()
  } finally { store.close() }
 })

 it('admin SSE receives session and machine events in namespaces first created after connecting', async () => {
  const store = new MultiUserGatewayStore(':memory:')
  const admin = store.createAccount('admin', 'admin', 'default', null)
  const manager = new SSEManager(0, new VisibilityTracker())
  const app = new Hono<WebAppEnv>()
  mountExecutionRoutes(app, { store, jwtSecret, getSyncEngine: () => null, getSseManager: () => manager, getStore: () => null })
  const controller = new AbortController()
  const response = await app.request('/api/events', { headers: { authorization: `Bearer ${await sign(admin.id)}` }, signal: controller.signal })
  const reader = response.body!.getReader()
  try {
   expect(new TextDecoder().decode((await reader.read()).value)).toContain('connected')
   manager.broadcast({ type: 'session-added', namespace: 'brand-new-namespace', sessionId: 'new-unbound-session' })
   expect(new TextDecoder().decode((await reader.read()).value)).toContain('new-unbound-session')
   manager.broadcast({ type: 'machine-updated', namespace: 'another-new-namespace', machineId: 'new-unbound-machine' })
   expect(new TextDecoder().decode((await reader.read()).value)).toContain('new-unbound-machine')
   expect(store.getResource('session', 'new-unbound-session')).toBeNull()
   expect(store.getResource('machine', 'new-unbound-machine')).toBeNull()
  } finally {
   controller.abort()
   await reader.cancel()
   manager.stop()
   store.close()
  }
 })

 it('persists machine aliases and OMP usage machine preferences per account across devices', async () => {
  const { store, app, admin, owner } = seed()
  try {
   store.setAccountMachineAlias(admin.id, 'bound-machine', { displayName: 'ROG-G14', icon: 'gaming-laptop' })
   store.setAccountMachineAlias(owner.id, 'bound-machine', { displayName: 'Owner-G14' })
   store.setAccountUsagePreference(admin.id, { source: 'omp-native', ompMachineId: 'bound-machine', ompMachineHost: 'WIN-03F1GUBQD2G' })

   const adminRes = await app.request('/api/machines', { headers: { authorization: `Bearer ${await sign(admin.id)}` } })
   const adminMachines = (await adminRes.json() as { machines: Array<{ id: string; metadata?: { displayName?: string; icon?: string }; preferredForOmpUsage?: boolean; preferredUsageSource?: string }> }).machines
   const adminBound = adminMachines.find(m => m.id === 'bound-machine')
   expect(adminBound?.metadata?.displayName).toBe('ROG-G14')
   expect(adminBound?.metadata?.icon).toBe('gaming-laptop')
   expect(adminBound?.preferredForOmpUsage).toBe(true)
   expect(adminBound?.preferredUsageSource).toBe('omp-native')

   const ownerRes = await app.request('/api/machines', { headers: { authorization: `Bearer ${await sign(owner.id)}` } })
   const ownerMachines = (await ownerRes.json() as { machines: Array<{ id: string; metadata?: { displayName?: string; icon?: string }; preferredForOmpUsage?: boolean }> }).machines
   const ownerBound = ownerMachines.find(m => m.id === 'bound-machine')
   expect(ownerBound?.metadata?.displayName).toBe('Owner-G14')
   expect(ownerBound?.preferredForOmpUsage).toBeUndefined()
  } finally {
   store.close()
  }
 })
})
