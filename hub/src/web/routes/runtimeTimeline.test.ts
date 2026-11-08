import { expect, test } from 'bun:test'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { MultiUserGatewayStore } from '../../../../fork-features/multi-user/gatewayStore'
import { createExecutionMiddleware } from '../../../../fork-features/multi-user/executionMount'
import { createRuntimeSnapshot } from '../../../../shared/src/runtimeTimeline'
import type { SyncEngine } from '../../sync/syncEngine'
import { RuntimeTimelineRegistry } from '../../sync/runtimeTimeline'
import { createAuthMiddleware, type WebAppEnv } from '../middleware/auth'
import { createRuntimeTimelineRoutes } from './runtimeTimeline'

test('admin reads and streams an unbound foreign runtime without claiming ownership; ordinary users cannot', async () => {
    const store = new MultiUserGatewayStore(':memory:')
    const registry = new RuntimeTimelineRegistry()
    const controller = new AbortController()
    let cancelReader: (() => Promise<void>) | undefined
    try {
        const admin = store.createAccount('admin', 'admin', 'admin-ns')
        const user = store.createAccount('user', 'user', 'user-ns')
        const session = { id: 'unbound', namespace: 'foreign-ns', metadata: null }
        const engine = {
            getSession: (id: string) => id === session.id ? session : undefined,
            getMachine: () => undefined,
            resolveSessionAccess: (id: string, namespace: string) => id !== session.id
                ? { ok: false, reason: 'not-found' }
                : namespace !== session.namespace
                    ? { ok: false, reason: 'access-denied' }
                    : { ok: true, sessionId: id, session }
        } as unknown as SyncEngine
        const snapshot = {
            ...createRuntimeSnapshot('authorization-epoch'),
            items: [{ id: 'assistant-1', kind: 'assistant' as const, runId: 'run-1', createdAt: 1, updatedAt: 2, state: 'running' as const, text: 'Retained foreign-session runtime' }],
            updatedAt: 2
        }
        registry.publish(session.id, session.namespace, 'publisher', { kind: 'snapshot', snapshot })
        const jwtSecret = new TextEncoder().encode('runtime-authorization-test-secret')
        const tokenFor = (accountId: number) => new SignJWT({ uid: 1, ns: 'default', gaid: accountId })
            .setProtectedHeader({ alg: 'HS256' }).sign(jwtSecret)
        const adminToken = await tokenFor(admin.id)
        const userToken = await tokenFor(user.id)
        const app = new Hono<WebAppEnv>()
        app.use('/api/*', createAuthMiddleware(jwtSecret))
        app.use('/api/*', createExecutionMiddleware({ store, jwtSecret, getSyncEngine: () => engine }))
        app.route('/api', createRuntimeTimelineRoutes(() => registry, () => engine, { gatewayStore: store, jwtSecret }))
        const base = `/api/sessions/${session.id}/runtime`
        const headers = { authorization: `Bearer ${adminToken}` }
        const response = await app.request(base, { headers })
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ available: true, snapshot, source: 'connected' })
        const stream = await app.request(`${base}/events?token=${encodeURIComponent(adminToken)}`, { signal: controller.signal })
        expect(stream.status).toBe(200)
        const reader = stream.body!.getReader()
        cancelReader = () => reader.cancel()
        expect(new TextDecoder().decode((await reader.read()).value)).toContain('Retained foreign-session runtime')
        for (const path of [base, `${base}/events`]) {
            expect((await app.request(path, { headers: { authorization: `Bearer ${userToken}` } })).status).toBe(403)
        }
        expect(store.getResource('session', session.id)).toBeNull()
    } finally {
        controller.abort()
        await cancelReader?.()
        store.close()
    }
})
