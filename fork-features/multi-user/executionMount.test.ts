import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { createExecutionMiddleware, mountExecutionRoutes } from './executionMount'
import type { SyncEngine } from '../../hub/src/sync/syncEngine'
import type { WebAppEnv } from '../../hub/src/web/middleware/auth'
import { MultiUserGatewayStore } from './gatewayStore'

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
            getSseManager: () => null
        })

        const response = await app.request('/api/sessions', {
            headers: { authorization: `Bearer ${token}` }
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ sessions: [] })
        store.close()
    })
})

describe('列表可见性：admin 看整个 namespace，普通用户看自己的+被授权的', () => {
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
            getSessionsByNamespace: () => [...records.values()],
            getSession: (id: string) => records.get(id),
            getOnlineMachinesByNamespace: () => machines,
            getMachine: (id: string) => machines.find(m => m.id === id) ?? null
        } as unknown as SyncEngine

        const app = new Hono<WebAppEnv>()
        mountExecutionRoutes(app, { store, jwtSecret, getSyncEngine: () => engine, getSseManager: () => null })
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

    it('admin 的机器列表同样是整个 namespace', async () => {
        const { store, app, admin } = seed()
        const response = await app.request('/api/machines', { headers: { authorization: `Bearer ${await sign(admin.id)}` } })
        expect(await idsOf(response, 'machines')).toEqual(['m-admin', 'm-peter'])
        store.close()
    })

    it('普通用户仍然只看到自己拥有的 —— admin 分支没有放宽别人的可见性', async () => {
        const { store, app, peter } = seed()
        const sessions = await app.request('/api/sessions', { headers: { authorization: `Bearer ${await sign(peter.id)}` } })
        expect(await idsOf(sessions, 'sessions')).toEqual(['s-peter-1', 's-peter-2'])
        const machines = await app.request('/api/machines', { headers: { authorization: `Bearer ${await sign(peter.id)}` } })
        expect(await idsOf(machines, 'machines')).toEqual(['m-peter'])
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
})
