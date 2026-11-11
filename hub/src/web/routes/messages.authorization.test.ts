import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import type { Server } from 'socket.io'
import type { Session } from '@hapi/protocol/types'
import { Store } from '../../store'
import { MessageService } from '../../sync/messageService'
import type { EventPublisher } from '../../sync/eventPublisher'
import type { SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { createMessagesRoutes } from './messages'
import { MultiUserGatewayStore } from '../../../../fork-features/multi-user/gatewayStore'
import { createExecutionMiddleware } from '../../../../fork-features/multi-user/executionMount'

async function fixture(granted: boolean) {
    const store = new Store(':memory:')
    const gateway = new MultiUserGatewayStore(':memory:')
    const owner = gateway.createAccount('owner', 'user', 'owner-space', null)
    const viewer = gateway.createAccount('viewer', 'user', 'viewer-space', null)
    const stored = store.sessions.getOrCreateSession('private-turn', { path: '/private-turn', host: 'localhost' }, null, owner.defaultNamespace)
    const session: Session = {
        id: stored.id,
        namespace: stored.namespace,
        seq: stored.seq,
        createdAt: stored.createdAt,
        updatedAt: stored.updatedAt,
        active: false,
        metadataVersion: stored.metadataVersion,
        agentStateVersion: stored.agentStateVersion,
        metadata: { path: '/private-turn', host: 'localhost' },
        agentState: null,
        activeAt: stored.activeAt ?? stored.updatedAt,
        thinking: false,
        thinkingAt: stored.updatedAt,
        model: stored.model,
        modelReasoningEffort: stored.modelReasoningEffort,
        effort: stored.effort,
        serviceTier: stored.serviceTier,
        resumeWithSessionModel: stored.resumeWithSessionModel,
    }
    gateway.bindResource({ resourceType: 'session', resourceId: session.id, ownerAccountId: owner.id, coreNamespace: owner.defaultNamespace })
    if (granted) gateway.grant('session', session.id, viewer.id, 'viewer')
    const token = gateway.createToken(viewer.id, 'turn-read-test', 'a'.repeat(64))
    const secret = new TextEncoder().encode('turn-revalidation-test-secret-only')
    const jwt = await new SignJWT({ uid: 1, gaid: viewer.id, ns: viewer.defaultNamespace, tid: token.id })
        .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h').sign(secret)
    const service = new MessageService(store, {} as Server, { emit: () => { } } as unknown as EventPublisher)
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let preparations = 0
    const engine = {
        getSession: (id: string) => id === session.id ? session : undefined,
        getMachine: () => undefined,
        resolveSessionAccess: (id: string, namespace: string) => id === session.id && namespace === session.namespace
            ? { ok: true, sessionId: id, session }
            : { ok: false, reason: 'access-denied' },
        prepareMessageTurnIndex: async (id: string) => {
            preparations += 1
            await service.prepareTurnIndex(id)
            entered.resolve()
            await release.promise
        },
        getMessagesPage: service.getMessagesPage.bind(service),
    } as unknown as SyncEngine
    const app = new Hono<WebAppEnv>()
    app.use('*', createExecutionMiddleware({ store: gateway, jwtSecret: secret, getSyncEngine: () => engine }))
    app.route('/api', createMessagesRoutes(() => engine))
    return {
        app, gateway, viewer, token, session, entered, release,
        headers: { authorization: `Bearer ${jwt}` },
        preparations: () => preparations,
        close: () => { store.close(); gateway.close() },
    }
}

describe('turn-page authorization after asynchronous preparation', () => {
    it('does not prepare an unauthorized session index', async () => {
        const f = await fixture(false)
        try {
            const response = await f.app.request(`/api/sessions/${f.session.id}/messages?turns=1`, { headers: f.headers })
            expect(response.status).toBe(403)
            expect(f.preparations()).toBe(0)
        } finally { f.close() }
    })

    for (const change of ['grant', 'token'] as const) {
        it(`rejects the prepared response when its ${change} is revoked while preparation yields`, async () => {
            const f = await fixture(true)
            const pending = f.app.request(`/api/sessions/${f.session.id}/messages?turns=1`, { headers: f.headers })
            try {
                await f.entered.promise
                if (change === 'grant') f.gateway.removeGrant('session', f.session.id, f.viewer.id)
                else f.gateway.revokeToken(f.token.id, f.viewer.id)
                f.release.resolve()
                const response = await pending
                expect(response.status).toBe(change === 'grant' ? 403 : 401)
                expect(await response.json()).not.toHaveProperty('messages')
            } finally {
                f.release.resolve()
                await pending
                f.close()
            }
        })
    }
})
