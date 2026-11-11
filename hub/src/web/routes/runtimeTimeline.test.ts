import { describe, expect, it, test } from 'bun:test'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { MultiUserGatewayStore } from '../../../../fork-features/multi-user/gatewayStore'
import { createExecutionMiddleware } from '../../../../fork-features/multi-user/executionMount'
import { createRuntimeSnapshot } from '../../../../shared/src/runtimeTimeline'
import type { Session, SyncEngine } from '../../sync/syncEngine'
import type { RuntimeItem, RuntimeSnapshot } from '@hapi/protocol/runtimeTimeline'
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

const jwtSecret = new TextEncoder().encode('runtime-test-secret-runtime-test-secret')

function createSession(overrides?: Partial<Session>): Session {
    return {
        id: 'session-1',
        namespace: 'default',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadata: { path: '/tmp/project', host: 'localhost', flavor: 'omp' as const },
        metadataVersion: 1,
        agentState: { controlledByUser: false, requests: {}, completedRequests: {} },
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 1,
        model: null,
        modelReasoningEffort: null,
        effort: null,
        serviceTier: null,
        resumeWithSessionModel: false,
        permissionMode: 'default',
        collaborationMode: 'default',
        ...overrides
    }
}

function fakeEngine(sessions: Map<string, Session>, machines: Record<string, { namespace: string }>): SyncEngine {
    return {
        getSession: (id: string) => sessions.get(id),
        getMachine: (id: string) => machines[id],
        getSessionByNamespace: (id: string, namespace: string) => {
            const session = sessions.get(id)
            return session && session.namespace === namespace ? session : undefined
        },
        resolveSessionAccess: (id: string, namespace: string) => {
            const session = sessions.get(id)
            if (!session) return { ok: false, reason: 'not-found' as const }
            if (session.namespace !== namespace) return { ok: false, reason: 'access-denied' as const }
            return { ok: true, sessionId: session.id, session }
        }
    } as unknown as SyncEngine
}

const item = (id: string, state: RuntimeItem['state'] = 'running'): RuntimeItem => ({
    id,
    kind: 'assistant',
    runId: 'run-1',
    createdAt: 0,
    updatedAt: 1,
    state
})

const snapshot = (epoch: string, seq: number, items: RuntimeItem[] = []): RuntimeSnapshot => ({
    version: 1,
    epoch,
    seq,
    items,
    run: { id: 'run-1', state: 'running', startedAt: 0 },
    updatedAt: seq
})

async function sign(accountId: number, expiresIn = '1h'): Promise<string> {
    return new SignJWT({ uid: 1, ns: 'default', gaid: accountId })
        .setProtectedHeader({ alg: 'HS256' })
        .setExpirationTime(expiresIn)
        .sign(jwtSecret)
}

async function readSseFrame(reader: Pick<ReadableStreamDefaultReader<Uint8Array>, 'read'>, decoder: TextDecoder, buffered: { text: string }): Promise<string> {
    while (true) {
        while (!buffered.text.includes('\n\n')) {
            const { done, value } = await reader.read()
            if (done) return buffered.text
            buffered.text += decoder.decode(value, { stream: true })
        }
        const boundary = buffered.text.indexOf('\n\n')
        const frame = buffered.text.slice(0, boundary)
        buffered.text = buffered.text.slice(boundary + 2)
        if (!frame.includes('event: runtime-source') && !frame.startsWith(':')) return frame
    }
}

function setup(sessions: Map<string, Session>, machines: Record<string, { namespace: string }> = {}) {
    const gatewayStore = new MultiUserGatewayStore(':memory:')
    const registry = new RuntimeTimelineRegistry()
    const engine = fakeEngine(sessions, machines)
    const app = new Hono<WebAppEnv>()
    app.use('/api/*', createAuthMiddleware(jwtSecret))
    app.route('/api', createRuntimeTimelineRoutes(() => registry, () => engine, { gatewayStore, jwtSecret }))
    return { app, gatewayStore, registry, engine }
}

describe('runtime timeline routes', () => {
    it('serves available:false for sessions with no runtime publisher', async () => {
        const sessions = new Map([['session-1', createSession()]])
        const { app, gatewayStore } = setup(sessions)
        const owner = gatewayStore.createAccount('owner', 'user', 'default', null)
        gatewayStore.bindResource({ resourceType: 'session', resourceId: 'session-1', ownerAccountId: owner.id, coreNamespace: 'default' })

        const token = await sign(owner.id)
        const res = await app.request('/api/sessions/session-1/runtime', { headers: { authorization: `Bearer ${token}` } })

        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ available: false, source: 'none' })
        gatewayStore.close()
    })

    it('reads foreign unbound runtime snapshots as admin without claiming ownership', async () => {
        const sessions = new Map([['session-1', createSession({ namespace: 'mnmn66' })]])
        const gatewayStore = new MultiUserGatewayStore(':memory:')
        const admin = gatewayStore.createAccount('admin', 'admin', 'default', null)
        const stranger = gatewayStore.createAccount('stranger', 'user', 'default', null)
        const registry = new RuntimeTimelineRegistry()
        const engine = fakeEngine(sessions, {})
        registry.publish('session-1', 'mnmn66', 'sock-1', { kind: 'snapshot', snapshot: snapshot('foreign', 0) })
        const app = new Hono<WebAppEnv>()
        app.use('/api/*', createAuthMiddleware(jwtSecret))
        app.use('/api/*', createExecutionMiddleware({ store: gatewayStore, jwtSecret, getSyncEngine: () => engine }))
        app.route('/api', createRuntimeTimelineRoutes(() => registry, () => engine, { gatewayStore, jwtSecret }))
        try {
            const headers = { authorization: `Bearer ${await sign(admin.id)}` }
            const response = await app.request('/api/sessions/session-1/runtime', { headers })
            expect(response.status).toBe(200)
            expect(await response.json()).toMatchObject({ available: true, snapshot: { epoch: 'foreign' } })
            const stream = await app.request('/api/sessions/session-1/runtime/events', { headers })
            expect(stream.status).toBe(200)
            const reader = stream.body!.getReader()
            try {
                expect(await readSseFrame(reader, new TextDecoder(), { text: '' })).toContain('foreign')
            } finally { await reader.cancel() }
            expect(gatewayStore.getResource('session', 'session-1')).toBeNull()
            const denied = await app.request('/api/sessions/session-1/runtime', { headers: { authorization: `Bearer ${await sign(stranger.id)}` } })
            expect(denied.status).toBe(403)
        } finally { gatewayStore.close() }
    })

    it('serves the authoritative snapshot when a runtime is published', async () => {
        const sessions = new Map([['session-1', createSession()]])
        const { app, gatewayStore, registry } = setup(sessions)
        const owner = gatewayStore.createAccount('owner', 'user', 'default', null)
        gatewayStore.bindResource({ resourceType: 'session', resourceId: 'session-1', ownerAccountId: owner.id, coreNamespace: 'default' })
        registry.publish('session-1', 'default', 'sock-1', { kind: 'snapshot', snapshot: snapshot('e1', 3, [item('m1')]) })

        const token = await sign(owner.id)
        const res = await app.request('/api/sessions/session-1/runtime', { headers: { authorization: `Bearer ${token}` } })

        expect(res.status).toBe(200)
        const body = await res.json() as { available: boolean; snapshot: RuntimeSnapshot; source: string }
        expect(body.available).toBe(true)
        expect(body.source).toBe('connected')
        expect(body.snapshot.epoch).toBe('e1')
        expect(body.snapshot.items).toHaveLength(1)
        gatewayStore.close()
    })

    it('denies accounts without a session grant — no namespace-only leak', async () => {
        const sessions = new Map([['session-1', createSession()]])
        const { app, gatewayStore, registry } = setup(sessions)
        const owner = gatewayStore.createAccount('owner', 'user', 'default', null)
        const outsider = gatewayStore.createAccount('outsider', 'user', 'default', null)
        gatewayStore.bindResource({ resourceType: 'session', resourceId: 'session-1', ownerAccountId: owner.id, coreNamespace: 'default' })
        registry.publish('session-1', 'default', 'sock-1', { kind: 'snapshot', snapshot: snapshot('e1', 0) })

        const token = await sign(outsider.id)
        const res = await app.request('/api/sessions/session-1/runtime', { headers: { authorization: `Bearer ${token}` } })
        expect(res.status).toBe(403)

        const sse = await app.request('/api/sessions/session-1/runtime/events', { headers: { authorization: `Bearer ${token}` } })
        expect(sse.status).toBe(403)
        gatewayStore.close()
    })

    it('streams the snapshot first, then live patches', async () => {
        const sessions = new Map([['session-1', createSession()]])
        const { app, gatewayStore, registry } = setup(sessions)
        const owner = gatewayStore.createAccount('owner', 'user', 'default', null)
        gatewayStore.bindResource({ resourceType: 'session', resourceId: 'session-1', ownerAccountId: owner.id, coreNamespace: 'default' })
        registry.publish('session-1', 'default', 'sock-1', { kind: 'snapshot', snapshot: snapshot('e1', 0, [item('m1')]) })

        const token = await sign(owner.id)
        const res = await app.request('/api/sessions/session-1/runtime/events', { headers: { authorization: `Bearer ${token}` } })
        expect(res.status).toBe(200)
        expect(res.headers.get('content-type')).toContain('text/event-stream')

        const reader = res.body!.getReader()
        const decoder = new TextDecoder()
        const buffered = { text: '' }

        const first = await readSseFrame(reader, decoder, buffered)
        expect(first).toContain('"kind":"snapshot"')
        expect(first).toContain('"epoch":"e1"')

        registry.publish('session-1', 'default', 'sock-1', {
            kind: 'patch',
            patch: { version: 1, epoch: 'e1', seq: 1, changes: [{ type: 'item', item: item('m1', 'completed') }], updatedAt: 2 }
        })
        const second = await readSseFrame(reader, decoder, buffered)
        expect(second).toContain('"kind":"patch"')
        expect(second).toContain('"seq":1')

        await reader.cancel()
        gatewayStore.close()
    })

    it('streams unavailable then the first snapshot for a late-starting runtime', async () => {
        const sessions = new Map([['session-1', createSession()]])
        const { app, gatewayStore, registry } = setup(sessions)
        const owner = gatewayStore.createAccount('owner', 'user', 'default', null)
        gatewayStore.bindResource({ resourceType: 'session', resourceId: 'session-1', ownerAccountId: owner.id, coreNamespace: 'default' })

        const token = await sign(owner.id)
        const res = await app.request('/api/sessions/session-1/runtime/events', { headers: { authorization: `Bearer ${token}` } })
        const reader = res.body!.getReader()
        const decoder = new TextDecoder()
        const buffered = { text: '' }

        const first = await readSseFrame(reader, decoder, buffered)
        expect(first).toContain('"kind":"unavailable"')

        registry.publish('session-1', 'default', 'sock-1', { kind: 'snapshot', snapshot: snapshot('e1', 0) })
        const second = await readSseFrame(reader, decoder, buffered)
        expect(second).toContain('"kind":"snapshot"')

        await reader.cancel()
        gatewayStore.close()
    })

    it('terminates the stream when the account is disabled mid-stream', async () => {
        const sessions = new Map([['session-1', createSession()]])
        const { app, gatewayStore, registry } = setup(sessions)
        const owner = gatewayStore.createAccount('owner', 'user', 'default', null)
        gatewayStore.bindResource({ resourceType: 'session', resourceId: 'session-1', ownerAccountId: owner.id, coreNamespace: 'default' })
        registry.publish('session-1', 'default', 'sock-1', { kind: 'snapshot', snapshot: snapshot('e1', 0) })

        const token = await sign(owner.id)
        const res = await app.request('/api/sessions/session-1/runtime/events', { headers: { authorization: `Bearer ${token}` } })
        const reader = res.body!.getReader()
        const buffered = { text: '' }
        await readSseFrame(reader, new TextDecoder(), buffered)

        // Revoke the account, then publish a frame — the per-frame recheck must
        // close the stream before it is written.
        gatewayStore.updateAccount(owner.id, { disabled: true })
        registry.publish('session-1', 'default', 'sock-1', {
            kind: 'patch',
            patch: { version: 1, epoch: 'e1', seq: 1, changes: [], updatedAt: 2 }
        })

        let finished = false
        for (let i = 0; i < 3; i++) {
            const next = await reader.read()
            if (next.done) { finished = true; break }
            expect(new TextDecoder().decode(next.value)).not.toContain('"kind":"patch"')
        }
        expect(finished).toBe(true)
        gatewayStore.close()
    })

    it('rejects expired gateway tokens on the SSE endpoint', async () => {
        const sessions = new Map([['session-1', createSession()]])
        const { app, gatewayStore } = setup(sessions)
        const owner = gatewayStore.createAccount('owner', 'user', 'default', null)
        gatewayStore.bindResource({ resourceType: 'session', resourceId: 'session-1', ownerAccountId: owner.id, coreNamespace: 'default' })

        const token = await new SignJWT({ uid: 1, ns: 'default', gaid: owner.id })
            .setProtectedHeader({ alg: 'HS256' })
            .setExpirationTime(new Date(Date.now() - 60_000))
            .sign(jwtSecret)
        const res = await app.request('/api/sessions/session-1/runtime/events', { headers: { authorization: `Bearer ${token}` } })
        expect(res.status).toBe(401)
        gatewayStore.close()
    })

    it('rejects JWTs whose backing API token row is revoked, and kills live streams', async () => {
        const sessions = new Map([['session-1', createSession()]])
        const { app, gatewayStore, registry } = setup(sessions)
        const owner = gatewayStore.createAccount('owner', 'user', 'default', null)
        gatewayStore.bindResource({ resourceType: 'session', resourceId: 'session-1', ownerAccountId: owner.id, coreNamespace: 'default' })
        const apiToken = gatewayStore.createToken(owner.id, 'runtime-test', 'hash-not-needed')
        const token = await new SignJWT({ uid: 1, ns: 'default', gaid: owner.id, tid: apiToken.id })
            .setProtectedHeader({ alg: 'HS256' })
            .setExpirationTime('1h')
            .sign(jwtSecret)

        registry.publish('session-1', 'default', 'sock-1', { kind: 'snapshot', snapshot: snapshot('e1', 0) })
        const res = await app.request('/api/sessions/session-1/runtime/events', { headers: { authorization: `Bearer ${token}` } })
        expect(res.status).toBe(200)
        const reader = res.body!.getReader()
        await readSseFrame(reader, new TextDecoder(), { text: '' })

        gatewayStore.revokeToken(apiToken.id, owner.id)
        registry.publish('session-1', 'default', 'sock-1', {
            kind: 'patch', patch: { version: 1, epoch: 'e1', seq: 1, changes: [], updatedAt: 2 }
        })

        let finished = false
        for (let i = 0; i < 3; i++) {
            const next = await reader.read()
            if (next.done) { finished = true; break }
            expect(new TextDecoder().decode(next.value)).not.toContain('"kind":"patch"')
        }
        expect(finished).toBe(true)
        expect((await app.request('/api/sessions/session-1/runtime', { headers: { authorization: `Bearer ${token}` } })).status).toBe(403)
        gatewayStore.close()
    })

    it('accepts the EventSource query token on the SSE endpoint', async () => {
        const sessions = new Map([['session-1', createSession()]])
        const { app, gatewayStore } = setup(sessions)
        const owner = gatewayStore.createAccount('owner', 'user', 'default', null)
        gatewayStore.bindResource({ resourceType: 'session', resourceId: 'session-1', ownerAccountId: owner.id, coreNamespace: 'default' })

        const token = await sign(owner.id)
        const res = await app.request(`/api/sessions/session-1/runtime/events?token=${encodeURIComponent(token)}`)
        expect(res.status).toBe(200)
        const reader = res.body!.getReader()
        const first = await readSseFrame(reader, new TextDecoder(), { text: '' })
        expect(first).toContain('"kind":"unavailable"')
        await reader.cancel()
        gatewayStore.close()
    })
    it('inherits machine grants only inside their path scope, including live revocation', async () => {
        const session = createSession({ metadata: { path: '/srv/allowed/project', host: 'localhost', machineId: 'machine-1', flavor: 'omp' } })
        const sessions = new Map([['session-1', session]])
        const { app, gatewayStore, registry } = setup(sessions, { 'machine-1': { namespace: 'default' } })
        const owner = gatewayStore.createAccount('owner', 'user', 'default', null)
        const viewer = gatewayStore.createAccount('viewer', 'user', 'default', null)
        gatewayStore.bindResource({ resourceType: 'session', resourceId: session.id, ownerAccountId: owner.id, coreNamespace: 'default' })
        gatewayStore.bindResource({ resourceType: 'machine', resourceId: 'machine-1', ownerAccountId: owner.id, coreNamespace: 'default' })
        gatewayStore.grant('machine', 'machine-1', viewer.id, 'viewer', '/srv/allowed')
        const token = await sign(viewer.id)
        const headers = { authorization: `Bearer ${token}` }
        expect((await app.request('/api/sessions/session-1/runtime', { headers })).status).toBe(200)
        registry.publish(session.id, 'default', 'socket-1', { kind: 'snapshot', snapshot: snapshot('epoch-1', 0) })
        const res = await app.request('/api/sessions/session-1/runtime/events', { headers })
        const reader = res.body!.getReader()
        await readSseFrame(reader, new TextDecoder(), { text: '' })
        // Same namespace and machine, but the directory is no longer granted.
        session.metadata!.path = '/srv/private/project'
        registry.publish(session.id, 'default', 'socket-1', {
            kind: 'patch', patch: { version: 1, epoch: 'epoch-1', seq: 1, changes: [], updatedAt: 2 }
        })
        // The optional initial source status is also reauthorized; drain any
        // already-written status frame and require actual EOF before completion.
        let finished = false
        for (let i = 0; i < 3; i++) {
            const next = await reader.read()
            if (next.done) { finished = true; break }
            expect(new TextDecoder().decode(next.value)).not.toContain('"kind":"patch"')
        }
        expect(finished).toBe(true)
        expect((await app.request('/api/sessions/session-1/runtime', { headers })).status).toBe(403)
        gatewayStore.close()
    })

    it('checks the session namespace independently of a valid gateway grant', async () => {
        const sessions = new Map([['session-1', createSession({ namespace: 'private' })]])
        const { app, gatewayStore, registry } = setup(sessions)
        const owner = gatewayStore.createAccount('owner', 'user', 'default', null)
        gatewayStore.bindResource({ resourceType: 'session', resourceId: 'session-1', ownerAccountId: owner.id, coreNamespace: 'private' })
        registry.publish('session-1', 'private', 'socket-1', { kind: 'snapshot', snapshot: snapshot('e1', 0) })
        const token = await sign(owner.id)
        const res = await app.request('/api/sessions/session-1/runtime', { headers: { authorization: `Bearer ${token}` } })
        expect(res.status).toBe(403)
        gatewayStore.close()
    })
    it.each(['owner', 'operator', 'viewer', 'stranger', 'out-of-scope', 'missing-machine', 'core-mismatch', 'binding-mismatch'] as const)(
        'authorizes unbound runtime reads from authoritative machine inheritance (%s)', async scenario => {
            const sessions = new Map([['session-1', createSession({
                metadata: {
                    path: scenario === 'out-of-scope' ? '/allowed-other/project' : '/allowed/project',
                    host: 'localhost', machineId: 'machine', flavor: 'omp'
                }
            })]])
            const machines: Record<string, { namespace: string }> = scenario === 'missing-machine' ? {} : { machine: { namespace: scenario === 'core-mismatch' ? 'foreign' : 'default' } }
            const { app, gatewayStore, registry } = setup(sessions, machines)
            try {
                const owner = gatewayStore.createAccount('machine-owner', 'user', 'default')
                const operator = gatewayStore.createAccount('machine-operator', 'user', 'default')
                const stranger = gatewayStore.createAccount('machine-stranger', 'user', 'default')
                gatewayStore.bindResource({
                    resourceType: 'machine', resourceId: 'machine', ownerAccountId: owner.id,
                    coreNamespace: scenario === 'binding-mismatch' ? 'foreign' : 'default'
                })
                gatewayStore.grant('machine', 'machine', operator.id, scenario === 'viewer' ? 'viewer' : 'operator', '/allowed')
                const account = scenario === 'owner' ? owner : scenario === 'stranger' ? stranger : operator
                const headers = { authorization: `Bearer ${await sign(account.id)}` }
                const allowed = scenario === 'owner' || scenario === 'operator' || scenario === 'viewer'
                registry.publish('session-1', 'default', 'source', { kind: 'snapshot', snapshot: snapshot('unbound', 0) })
                const response = await app.request('/api/sessions/session-1/runtime', { headers })
                expect(response.status).toBe(allowed ? 200 : 403)
                const stream = await app.request('/api/sessions/session-1/runtime/events', { headers })
                expect(stream.status).toBe(allowed ? 200 : 403)
                if (allowed) {
                    const reader = stream.body!.getReader()
                    try { expect(await readSseFrame(reader, new TextDecoder(), { text: '' })).toContain('unbound') }
                    finally { await reader.cancel() }
                }
                expect(gatewayStore.getResource('session', 'session-1')).toBeNull()
            } finally { gatewayStore.close() }
        }
    )
})
