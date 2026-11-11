import { afterEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import type { OmpUsageResponse } from '@hapi/protocol/ompUsage'
import type { Machine, SyncEngine } from '../../hub/src/sync/syncEngine'
import { createAuthMiddleware, type WebAppEnv } from '../../hub/src/web/middleware/auth'
import { createMultiUserGatewayRoutes } from '../multi-user/gatewayRoutes'
import { MultiUserGatewayStore } from '../multi-user/gatewayStore'
import { createApiToken } from '../multi-user/token'
import { SubscriptionStore } from './subscriptionStore'
import { createSubscriptionRoutes } from './subscriptionRoutes'

const SECRET = new Uint8Array(32).fill(19)
const PATH = '/api/subscription/omp/foreign-runner'
const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })

function nativeUsage(): OmpUsageResponse {
    return {
        success: true,
        source: 'omp-native',
        generatedAt: Date.now(),
        reports: [{
            provider: 'anthropic',
            accountId: 'account-opaque-1',
            fetchedAt: Date.now(),
            limits: [{
                id: 'five-hour',
                label: 'Five hours',
                scope: { shared: true, sharedGroup: 'claude', tier: 'pro' },
                window: { id: '5h', label: 'Five hours', durationMs: 18_000_000, resetsAt: Date.now() + 60_000 },
                amount: { unit: 'percent', used: 100, limit: 100, remaining: 0, usedFraction: 1, remainingFraction: 0 },
                status: 'exhausted'
            }]
        }],
        accountsWithoutUsage: [{ provider: 'custom', accountId: 'account-opaque-2' }],
        disabledCredentialCount: 1
    }
}

function fixture(withEngine = true) {
    const gatewayStore = new MultiUserGatewayStore(':memory:')
    const subscriptionStore = new SubscriptionStore(':memory:')
    cleanups.push(() => { subscriptionStore.close(); gatewayStore.close() })
    const admin = gatewayStore.createAccount('admin', 'admin', 'admin-namespace')
    const owner = gatewayStore.createAccount('owner', 'user', 'foreign-namespace')
    const viewer = gatewayStore.createAccount('viewer', 'user', 'viewer-namespace')
    const machine = {
        id: 'foreign-runner', namespace: owner.defaultNamespace, active: true,
        metadata: { capabilities: { omp: true } }
    } as unknown as Machine
    const machines = new Map([[machine.id, machine]])
    gatewayStore.bindResource({ resourceType: 'machine', resourceId: machine.id, ownerAccountId: owner.id, coreNamespace: machine.namespace })
    gatewayStore.grant('machine', machine.id, viewer.id, 'operator', '/shared')
    const calls: string[] = []
    let fetchUsage: () => Promise<unknown> = async () => nativeUsage()
    const engine = {
        getMachine: (id: string) => machines.get(id),
        getOmpUsageForMachine: async (id: string) => { calls.push(id); return fetchUsage() }
    } as unknown as SyncEngine
    const app = new Hono<WebAppEnv>()
    app.use('/api/*', createAuthMiddleware(SECRET))
    app.route('/api', createMultiUserGatewayRoutes({ store: gatewayStore, jwtSecret: SECRET, coreUserId: 1 }))
    app.route('/api', createSubscriptionRoutes({
        gatewayStore, subscriptionStore, jwtSecret: SECRET,
        ...(withEngine ? { getSyncEngine: () => engine } : {})
    }))
    async function login(accountId: number) {
        const apiToken = createApiToken()
        const stored = gatewayStore.createToken(accountId, 'native-usage-test', apiToken.hash)
        const response = await app.request('/api/auth', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ accessToken: apiToken.plaintext })
        })
        expect(response.status).toBe(200)
        const body = await response.json() as { token: string }
        return { jwt: body.token, tokenId: stored.id }
    }
    function request(jwt?: string, path = PATH) {
        return app.request(path, { headers: jwt ? { authorization: `Bearer ${jwt}` } : {} })
    }
    return {
        app, gatewayStore, subscriptionStore, admin, owner, viewer, machine, machines, calls, login, request,
        setFetchUsage: (fetch: () => Promise<unknown>) => { fetchUsage = fetch }
    }
}

describe('OMP native usage subscription route with live gateway authentication', () => {
    test('anonymous, invalid, and query-token requests never reach the runner', async () => {
        const f = fixture()
        const admin = await f.login(f.admin.id)
        expect((await f.request()).status).toBe(401)
        expect((await f.request('invalid-token')).status).toBe(401)
        expect((await f.request(undefined, `${PATH}?token=${encodeURIComponent(admin.jwt)}`)).status).toBe(401)
        expect(f.calls).toEqual([])
    })

    test('ordinary machine owners and scoped shared-machine operators cannot read native usage', async () => {
        const f = fixture()
        for (const account of [f.owner, f.viewer]) {
            const token = await f.login(account.id)
            const response = await f.request(token.jwt)
            expect(response.status).toBe(403)
            expect(await response.json()).toEqual({ error: 'Admin only' })
        }
        expect(f.calls).toEqual([])
    })

    test('revoked admin API-token JWT remains denied on every request without runner calls', async () => {
        const f = fixture()
        const token = await f.login(f.admin.id)
        f.gatewayStore.revokeToken(token.tokenId, f.admin.id)
        expect((await f.request(token.jwt)).status).toBe(401)
        expect((await f.request(token.jwt)).status).toBe(401)
        expect(f.calls).toEqual([])
    })

    test('live account demotion, disabling, and deletion override the issued admin JWT', async () => {
        const f = fixture()
        const token = await f.login(f.admin.id)
        f.gatewayStore.updateAccount(f.admin.id, { role: 'user' })
        expect((await f.request(token.jwt)).status).toBe(403)
        f.gatewayStore.updateAccount(f.admin.id, { role: 'admin', disabled: true })
        expect((await f.request(token.jwt)).status).toBe(401)
        f.gatewayStore.deleteAccount(f.admin.id)
        expect((await f.request(token.jwt)).status).toBe(401)
        expect(f.calls).toEqual([])
    })

    test('administrator reads another namespace without changing machine ownership', async () => {
        const f = fixture()
        const token = await f.login(f.admin.id)
        const response = await f.request(token.jwt)
        expect(response.status).toBe(200)
        expect(response.headers.get('cache-control')).toBe('no-store')
        const body = await response.json() as OmpUsageResponse
        expect(body.success).toBe(true)
        if (!body.success) throw new Error('Expected usage success')
        expect(body.reports[0].limits[0].amount.remaining).toBe(0)
        expect(body.accountsWithoutUsage).toEqual([{ provider: 'custom', accountId: 'account-opaque-2' }])
        expect(body.disabledCredentialCount).toBe(1)
        expect(f.calls).toEqual([f.machine.id])
        expect(f.gatewayStore.getResource('machine', f.machine.id)?.ownerAccountId).toBe(f.owner.id)
        expect(f.subscriptionStore.listAll()).toEqual([])
    })

    test('administrator sees an unbound foreign machine without claiming it', async () => {
        const f = fixture()
        f.machines.set('unbound-runner', { ...f.machine, id: 'unbound-runner' })
        const token = await f.login(f.admin.id)
        expect((await f.request(token.jwt, '/api/subscription/omp/unbound-runner')).status).toBe(200)
        expect(f.calls).toEqual(['unbound-runner'])
        expect(f.gatewayStore.getResource('machine', 'unbound-runner')).toBeNull()
    })

    test('stale resource namespace binding cannot authorize a different core namespace', async () => {
        const f = fixture()
        f.gatewayStore.bindResource({ resourceType: 'machine', resourceId: f.machine.id, ownerAccountId: f.owner.id, coreNamespace: 'stale-namespace' })
        const token = await f.login(f.admin.id)
        expect((await f.request(token.jwt)).status).toBe(403)
        expect(f.calls).toEqual([])
    })

    test('missing, offline, and non-OMP machines never invoke native usage', async () => {
        const f = fixture()
        const token = await f.login(f.admin.id)
        expect((await f.request(token.jwt, '/api/subscription/omp/missing')).status).toBe(404)
        f.machine.active = false
        expect((await f.request(token.jwt)).status).toBe(409)
        f.machine.active = true
        f.machine.metadata = null
        const unsupported = await f.request(token.jwt)
        expect(unsupported.status).toBe(409)
        expect(await unsupported.json()).toMatchObject({ success: false, source: 'omp-native', errorCode: 'unsupported' })
        expect(f.calls).toEqual([])
    })

    test('optional or disconnected sync engine returns 503 without affecting legacy summary', async () => {
        const f = fixture(false)
        const token = await f.login(f.admin.id)
        expect((await f.request(token.jwt)).status).toBe(503)
        expect((await f.request(token.jwt, '/api/subscription/summary')).status).toBe(200)
        expect(f.calls).toEqual([])
        const disconnected = new Hono<WebAppEnv>()
        disconnected.route('/api', createSubscriptionRoutes({
            gatewayStore: f.gatewayStore, subscriptionStore: f.subscriptionStore, jwtSecret: SECRET,
            getSyncEngine: () => null
        }))
        expect((await disconnected.request(PATH, { headers: { authorization: `Bearer ${token.jwt}` } })).status).toBe(503)
        expect(f.calls).toEqual([])
    })

    test('schema whitelist strips raw metadata, notes, and email at every structural boundary', async () => {
        const f = fixture()
        const clean = nativeUsage()
        if (!clean.success) throw new Error('Expected usage fixture')
        const report = clean.reports[0]
        const limit = report.limits[0]
        f.setFetchUsage(async () => ({
            ...clean, raw: { secret: 'DO-NOT-FORWARD' }, notes: 'DO-NOT-FORWARD', email: 'private@example.invalid',
            reports: [{
                ...report, metadata: { secret: 'DO-NOT-FORWARD' }, email: 'private@example.invalid',
                limits: [{
                    ...limit, notes: 'DO-NOT-FORWARD',
                    scope: { ...limit.scope, email: 'private@example.invalid' },
                    window: { ...limit.window, notes: 'DO-NOT-FORWARD' },
                    amount: { ...limit.amount, raw: 'DO-NOT-FORWARD' }
                }]
            }],
            accountsWithoutUsage: [{ ...clean.accountsWithoutUsage[0], email: 'private@example.invalid', notes: 'DO-NOT-FORWARD' }]
        }))
        const token = await f.login(f.admin.id)
        const response = await f.request(token.jwt)
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual(clean)
    })

    for (const errorCode of ['unsupported', 'unavailable', 'timeout', 'output_limit', 'invalid_output', 'command_failed'] as const) {
        test(`preserves normalized native ${errorCode} without an external-collector fallback`, async () => {
            const f = fixture()
            const failure = { success: false, source: 'omp-native', errorCode, error: 'Native usage unavailable' }
            f.setFetchUsage(async () => failure)
            const token = await f.login(f.admin.id)
            const response = await f.request(token.jwt)
            expect(response.status).toBe(200)
            expect(await response.json()).toEqual(failure)
            expect(f.calls).toEqual([f.machine.id])
            expect(f.subscriptionStore.listAll()).toEqual([])
        })
    }

    test('invalid runner output is rejected without returning its raw data', async () => {
        const f = fixture()
        f.setFetchUsage(async () => ({ success: true, source: 'omp-native', reports: 'private@example.invalid' }))
        const token = await f.login(f.admin.id)
        const response = await f.request(token.jwt)
        expect(response.status).toBe(502)
        expect(await response.json()).toEqual({ success: false, source: 'omp-native', errorCode: 'invalid_output', error: 'Invalid OMP native usage response' })
    })

    test('runner exceptions are sanitized instead of forwarding command diagnostics', async () => {
        const f = fixture()
        f.setFetchUsage(async () => { throw new Error('token=DO-NOT-FORWARD private@example.invalid') })
        const token = await f.login(f.admin.id)
        const response = await f.request(token.jwt)
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ success: false, source: 'omp-native', errorCode: 'unavailable', error: 'OMP native usage is unavailable' })
    })

    test('revocation while fetching prevents disclosing the completed runner response', async () => {
        const f = fixture()
        const token = await f.login(f.admin.id)
        f.setFetchUsage(async () => {
            f.gatewayStore.revokeToken(token.tokenId, f.admin.id)
            return nativeUsage()
        })
        const response = await f.request(token.jwt)
        expect(response.status).toBe(401)
        expect(await response.json()).toEqual({ error: 'Invalid gateway identity' })
        expect(f.calls).toEqual([f.machine.id])
    })

    test('demotion while fetching prevents disclosing the completed runner response', async () => {
        const f = fixture()
        const token = await f.login(f.admin.id)
        f.setFetchUsage(async () => {
            f.gatewayStore.updateAccount(f.admin.id, { role: 'user' })
            return nativeUsage()
        })
        const response = await f.request(token.jwt)
        expect(response.status).toBe(403)
        expect(await response.json()).toEqual({ error: 'Admin only' })
        expect(f.calls).toEqual([f.machine.id])
    })
})
