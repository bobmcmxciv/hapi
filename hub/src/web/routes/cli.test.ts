import { beforeAll, describe, expect, it, mock } from 'bun:test'
import { Hono } from 'hono'
import type { SyncEngine } from '../../sync/syncEngine'
import { createConfiguration } from '../../configuration'
import { createCliRoutes } from './cli'
import { SessionIdentityConflictError } from '../../store/sessions'
import { MultiUserGatewayStore } from '../../../../fork-features/multi-user/gatewayStore'
import { resolveGatewayCliNamespace } from '../../../../fork-features/multi-user/cliAdapter'
import { hashApiToken } from '../../../../fork-features/multi-user/token'

function createApp(engine: Partial<SyncEngine>) {
    const app = new Hono()
    app.route('/cli', createCliRoutes(() => engine as SyncEngine))
    return app
}

function authHeaders() {
    return {
        authorization: 'Bearer test-token'
    }
}

beforeAll(async () => {
    const config = await createConfiguration()
    config._setCliApiToken('test-token', 'env', false)
})

describe('gateway CLI authentication boundary', () => {
    it.each([false, true])('rejects retired master keys with gateway store=%s while honoring server namespace and revocation', async (withGatewayStore) => {
        const store = new MultiUserGatewayStore(':memory:')
        try {
            const owner = store.createAccount('runner-owner', 'user', 'owner-ns')
            const retired = store.createToken(owner.id, 'retired shared key', hashApiToken('test-token'))
            store.revokeToken(retired.id, owner.id)
            const independent = store.createToken(owner.id, 'independent', hashApiToken('independent-token'), 'runner-ns')
            const listLocalResumableSessions = mock(() => [])
            const app = new Hono()
            app.route('/cli', createCliRoutes(
                () => ({ listLocalResumableSessions }) as unknown as SyncEngine,
                token => resolveGatewayCliNamespace(store, token),
                withGatewayStore ? { gatewayStore: store } : {}
            ))
            const request = (token: string) => app.request('/cli/sessions/resumable', {
                headers: { authorization: `Bearer ${token}` }
            })
            for (const token of ['test-token', 'test-token:default', 'test-token:other']) {
                expect((await request(token)).status).toBe(401)
            }
            expect(listLocalResumableSessions).not.toHaveBeenCalled()
            expect((await request('independent-token:forged-ns')).status).toBe(200)
            expect(listLocalResumableSessions).toHaveBeenCalledWith('runner-ns', { machineId: undefined })
            store.revokeToken(independent.id, owner.id)
            expect((await request('independent-token')).status).toBe(401)
            expect((await request('independent-token:runner-ns')).status).toBe(401)
        } finally {
            store.close()
        }
    })
})

describe('gateway CLI machine bootstrap', () => {
    it.each(['/machines', '/sessions'])('binds the authenticated creator before %s returns and rejects a same-namespace stranger', async path => {
        const store = new MultiUserGatewayStore(':memory:')
        try {
            const owner = store.createAccount('bootstrap-owner', 'user', 'shared')
            const stranger = store.createAccount('bootstrap-stranger', 'user', 'shared')
            store.createToken(owner.id, 'owner', hashApiToken('owner-key'))
            store.createToken(stranger.id, 'stranger', hashApiToken('stranger-key'))
            const machines = new Map<string, { id: string; namespace: string; metadata: unknown }>()
            const getOrCreateMachine = mock((id: string, metadata: unknown, _state: unknown, namespace: string) => {
                const machine = { id, namespace, metadata }
                machines.set(id, machine)
                return machine
            })
            const getOrCreateSession = mock(() => ({ id: 'session', namespace: 'shared' }))
            const engine = { getMachine: (id: string) => machines.get(id), getOrCreateMachine, getOrCreateSession } as unknown as SyncEngine
            const app = new Hono()
            app.route('/cli', createCliRoutes(() => engine, undefined, { gatewayStore: store }))
            const machine = { id: 'new-machine', metadata: { host: 'runner' } }
            const body = path === '/machines' ? machine : { tag: 'native', metadata: { machineId: machine.id }, machine }
            const request = (token: string) => app.request(`/cli${path}`, {
                method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body)
            })
            expect((await request('owner-key')).status).toBe(200)
            expect(store.getResource('machine', machine.id)).toMatchObject({ ownerAccountId: owner.id, coreNamespace: 'shared' })
            expect(getOrCreateMachine).toHaveBeenCalledTimes(1)
            expect((await request('stranger-key')).status).toBe(403)
            expect(getOrCreateMachine).toHaveBeenCalledTimes(1)
            expect(getOrCreateSession).toHaveBeenCalledTimes(path === '/sessions' ? 1 : 0)
            expect(store.getResource('machine', machine.id)?.ownerAccountId).toBe(owner.id)
        } finally { store.close() }
    })
})

describe('cli resume routes', () => {
    it('returns local resumable sessions', async () => {
        const app = createApp({
            listLocalResumableSessions: () => [{
                sessionId: 'session-1',
                flavor: 'codex',
                directory: '/tmp/project',
                machineId: 'machine-1',
                active: false,
                thinking: false,
                controlledByUser: false,
                agentSessionId: 'codex-thread-1',
                updatedAt: 123
            }]
        } as never)

        const response = await app.request('/cli/sessions/resumable?machineId=machine-1', {
            headers: authHeaders()
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            sessions: [{
                sessionId: 'session-1',
                flavor: 'codex',
                directory: '/tmp/project',
                machineId: 'machine-1',
                active: false,
                thinking: false,
                controlledByUser: false,
                agentSessionId: 'codex-thread-1',
                updatedAt: 123
            }]
        })
    })

    it('returns a local resume target', async () => {
        const app = createApp({
            resolveLocalResumeTarget: () => ({
                type: 'success',
                target: {
                    sessionId: 'session-1',
                    flavor: 'claude',
                    directory: '/tmp/project',
                    machineId: 'machine-1',
                    active: false,
                    thinking: false,
                    controlledByUser: false,
                    agentSessionId: '11111111-1111-4111-8111-111111111111'
                }
            })
        } as never)

        const response = await app.request('/cli/sessions/session-1/resume-target', {
            headers: authHeaders()
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            target: {
                sessionId: 'session-1',
                flavor: 'claude',
                directory: '/tmp/project',
                machineId: 'machine-1',
                active: false,
                thinking: false,
                controlledByUser: false,
                agentSessionId: '11111111-1111-4111-8111-111111111111'
            }
        })
    })

    it('returns handoff errors with status codes', async () => {
        const app = createApp({
            handoffSessionToLocal: async () => ({
                type: 'error',
                message: 'Session is already controlled by a local terminal',
                code: 'already_local'
            })
        } as never)

        const response = await app.request('/cli/sessions/session-1/handoff-local', {
            method: 'POST',
            headers: authHeaders()
        })

        expect(response.status).toBe(409)
        expect(await response.json()).toEqual({
            error: 'Session is already controlled by a local terminal',
            code: 'already_local'
        })
    })
})

describe('cli OpenCode clear route', () => {
    it.each(['confirm-cleanup', 'abort'] as const)('maps transient %s persistence failure to retryable 500', async (action) => {
        const failure = mock(() => ({
            type: 'error' as const,
            code: 'replacement_link_failed' as const,
            message: 'metadata write failed'
        }))
        const app = createApp(action === 'confirm-cleanup'
            ? { confirmOpenCodeClearCleanup: failure } as never
            : { abortOpenCodeClearSession: failure } as never)
        const response = await app.request(`/cli/sessions/source-session/clear-opencode/${action}`, {
            method: 'POST', headers: authHeaders(), body: JSON.stringify({ replacementSessionId: 'reserved-session' })
        })
        expect(response.status).toBe(500)
        expect(await response.json()).toMatchObject({ code: 'replacement_link_failed' })
        expect(failure).toHaveBeenCalledWith('source-session', 'default', 'reserved-session')
    })

    it.each(['confirm-cleanup', 'abort'] as const)('requires reservation identity for %s', async (action) => {
        const app = createApp({} as never)
        const response = await app.request(`/cli/sessions/source-session/clear-opencode/${action}`, {
            method: 'POST', headers: authHeaders(), body: '{}'
        })
        expect(response.status).toBe(400)
    })

    it('durably reserves through the namespace-scoped engine route', async () => {
        const reserveOpenCodeClearSession = mock(() => ({ type: 'success' as const, sessionId: 'reserved-session' }))
        const app = createApp({ reserveOpenCodeClearSession } as never)
        const response = await app.request('/cli/sessions/source-session/clear-opencode/reserve', {
            method: 'POST', headers: authHeaders()
        })
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ ok: true, sessionId: 'reserved-session' })
        expect(reserveOpenCodeClearSession).toHaveBeenCalledWith('source-session', 'default')
    })

    it('orchestrates a fresh session only through the namespace-scoped engine route', async () => {
        const clearOpenCodeSession = mock(async () => ({ type: 'success' as const, sessionId: 'fresh-opencode-session' }))
        const app = createApp({ clearOpenCodeSession } as never)

        const response = await app.request('/cli/sessions/source-session/clear-opencode', {
            method: 'POST',
            headers: authHeaders()
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ ok: true, sessionId: 'fresh-opencode-session' })
        expect(clearOpenCodeSession).toHaveBeenCalledWith('source-session', 'default')
    })

    it('does not turn an active or wrong-flavor source into a new session', async () => {
        const app = createApp({
            clearOpenCodeSession: async () => ({
                type: 'error' as const,
                code: 'clear_unavailable' as const,
                message: 'Session must be an archived OpenCode clear source'
            })
        } as never)

        const response = await app.request('/cli/sessions/source-session/clear-opencode', {
            method: 'POST',
            headers: authHeaders()
        })

        expect(response.status).toBe(409)
        expect(await response.json()).toEqual({
            error: 'Session must be an archived OpenCode clear source',
            code: 'clear_unavailable'
        })
    })
})

describe('cli lazy session creation', () => {
    const sessionId = '11111111-1111-4111-8111-111111111111'

    it('creates the machine and requested session identity in one request', async () => {
        const getOrCreateMachine = mock(() => ({ id: 'machine-1' }))
        const getOrCreateSession = mock(() => ({ id: sessionId }))
        const app = createApp({
            getMachine: () => null,
            getOrCreateMachine,
            getOrCreateSession
        } as never)

        const response = await app.request('/cli/sessions', {
            method: 'POST',
            headers: {
                ...authHeaders(),
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                id: sessionId,
                tag: 'lazy-tag',
                metadata: { path: '/tmp/project' },
                agentState: { controlledByUser: true },
                machine: {
                    id: 'machine-1',
                    metadata: { host: 'localhost' }
                }
            })
        })

        expect(response.status).toBe(200)
        expect(getOrCreateMachine).toHaveBeenCalledWith(
            'machine-1',
            { host: 'localhost' },
            null,
            'default'
        )
        expect(getOrCreateSession).toHaveBeenCalledWith(
            'lazy-tag',
            { path: '/tmp/project' },
            { controlledByUser: true },
            'default',
            undefined,
            undefined,
            undefined,
            sessionId
        )
    })

    it('rejects an embedded machine owned by another namespace', async () => {
        const getOrCreateMachine = mock(() => ({ id: 'machine-1' }))
        const getOrCreateSession = mock(() => ({ id: sessionId }))
        const app = createApp({
            getMachine: () => ({ id: 'machine-1', namespace: 'other' }),
            getOrCreateMachine,
            getOrCreateSession
        } as never)

        const response = await app.request('/cli/sessions', {
            method: 'POST',
            headers: {
                ...authHeaders(),
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                id: sessionId,
                tag: 'lazy-tag',
                metadata: {},
                machine: { id: 'machine-1', metadata: {} }
            })
        })

        expect(response.status).toBe(403)
        expect(getOrCreateMachine).not.toHaveBeenCalled()
        expect(getOrCreateSession).not.toHaveBeenCalled()
    })

    it('returns 409 for a requested identity conflict', async () => {
        const app = createApp({
            getOrCreateSession: () => {
                throw new SessionIdentityConflictError('Session tag is already bound to a different id')
            }
        })

        const response = await app.request('/cli/sessions', {
            method: 'POST',
            headers: {
                ...authHeaders(),
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                id: sessionId,
                tag: 'lazy-tag',
                metadata: {}
            })
        })

        expect(response.status).toBe(409)
    })
})
