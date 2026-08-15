import { describe, test, expect, beforeEach } from 'bun:test'
import { SignJWT } from 'jose'
import { MultiUserGatewayStore } from '../multi-user/gatewayStore'
import { SubscriptionStore } from './subscriptionStore'
import { createSubscriptionRoutes } from './subscriptionRoutes'
import type { SubscriptionSnapshot } from './domain'

const SECRET = new Uint8Array(32).fill(7)

async function makeAdminToken(accountId: number): Promise<string> {
    return new SignJWT({ gaid: accountId })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(SECRET)
}

async function makeToken(accountId: number): Promise<string> {
    return makeAdminToken(accountId)
}

function goodSnap(overrides: Partial<SubscriptionSnapshot> = {}): SubscriptionSnapshot {
    return {
        machine: 'vircs',
        provider: 'anthropic',
        account_key: 'admin@example.com',
        plan_name: 'Claude Max',
        windows: [
            { key: 'five_hour', label: '5小时', used_percent: 12, reset_at: 1_800_000_000_000, severity: 'normal', is_active: true }
        ],
        balance: null,
        error: null,
        reported_at: 1_700_000_000_000,
        ...overrides
    }
}

async function reqJson(routes: ReturnType<typeof createSubscriptionRoutes>, method: string, path: string, token: string | null, body?: unknown): Promise<{ status: number; body: any }> {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (token) headers['authorization'] = `Bearer ${token}`
    const res = await routes.request(new Request(`http://x${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body)
    }))
    return { status: res.status, body: await res.json() }
}

describe('subscription routes', () => {
    let gatewayStore: MultiUserGatewayStore
    let subStore: SubscriptionStore
    let routes: ReturnType<typeof createSubscriptionRoutes>
    let adminId: number
    let userId: number

    beforeEach(() => {
        gatewayStore = new MultiUserGatewayStore(':memory:')
        subStore = new SubscriptionStore(':memory:')
        routes = createSubscriptionRoutes({ gatewayStore, subscriptionStore: subStore, jwtSecret: SECRET })
        adminId = gatewayStore.createAccount('admin', 'admin', 'default').id
        userId = gatewayStore.createAccount('bob', 'user', 'default').id
    })

    test('POST rejects missing token as 401', async () => {
        const res = await reqJson(routes, 'POST', '/subscription/report', null, { snapshots: [goodSnap()] })
        expect(res.status).toBe(401)
    })

    test('POST rejects non-admin as 403', async () => {
        const token = await makeToken(userId)
        const res = await reqJson(routes, 'POST', '/subscription/report', token, { snapshots: [goodSnap()] })
        expect(res.status).toBe(403)
    })

    test('POST accepts admin snapshot and persists it', async () => {
        const token = await makeAdminToken(adminId)
        const res = await reqJson(routes, 'POST', '/subscription/report', token, { snapshots: [goodSnap()] })
        expect(res.status).toBe(200)
        expect(res.body).toEqual({ accepted: 1 })
        const stored = subStore.getByKey('vircs', 'anthropic', 'admin@example.com')
        expect(stored?.plan_name).toBe('Claude Max')
    })

    test('POST accepts an empty batch as zero-accepted (no throw)', async () => {
        const token = await makeAdminToken(adminId)
        const res = await reqJson(routes, 'POST', '/subscription/report', token, { snapshots: [] })
        expect(res.status).toBe(200)
        expect(res.body).toEqual({ accepted: 0 })
    })

    test('POST 400 on missing snapshots array', async () => {
        const token = await makeAdminToken(adminId)
        const res = await reqJson(routes, 'POST', '/subscription/report', token, { foo: 'bar' })
        expect(res.status).toBe(400)
    })

    test('POST 400 on bad snapshot shape (empty provider)', async () => {
        const token = await makeAdminToken(adminId)
        const bad = goodSnap({ provider: '' })
        const res = await reqJson(routes, 'POST', '/subscription/report', token, { snapshots: [goodSnap(), bad] })
        expect(res.status).toBe(400)
        expect(String(res.body.error)).toContain('snapshots[1]')
    })

    test('POST 400 when batch exceeds cap', async () => {
        const token = await makeAdminToken(adminId)
        const batch = Array.from({ length: 101 }, () => goodSnap())
        const res = await reqJson(routes, 'POST', '/subscription/report', token, { snapshots: batch })
        expect(res.status).toBe(400)
    })

    test('POST 400 on malformed JSON', async () => {
        const token = await makeAdminToken(adminId)
        const res = await routes.request(new Request('http://x/subscription/report', {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: '{ not valid'
        }))
        expect(res.status).toBe(400)
    })

    test('GET summary returns all snapshots with generatedAt', async () => {
        const token = await makeAdminToken(adminId)
        subStore.upsertSnapshots([goodSnap()])
        const res = await reqJson(routes, 'GET', '/subscription/summary', token)
        expect(res.status).toBe(200)
        expect(res.body.snapshots).toHaveLength(1)
        expect(res.body.snapshots[0].plan_name).toBe('Claude Max')
        expect(typeof res.body.generatedAt).toBe('number')
        expect(res.body.generatedAt).toBeGreaterThan(0)
    })

    test('GET summary 403 for non-admin', async () => {
        const token = await makeToken(userId)
        const res = await reqJson(routes, 'GET', '/subscription/summary', token)
        expect(res.status).toBe(403)
    })

    test('GET summary 401 without token', async () => {
        const res = await reqJson(routes, 'GET', '/subscription/summary', null)
        expect(res.status).toBe(401)
    })

    test('round-trip: POST then GET returns the same snapshot', async () => {
        const token = await makeAdminToken(adminId)
        await reqJson(routes, 'POST', '/subscription/report', token, {
            snapshots: [
                goodSnap(),
                goodSnap({ provider: 'deepseek', account_key: 'sk-...abcd', plan_name: 'DeepSeek 按量', windows: [], balance: { amount: 57.86, currency: 'CNY', granted: 0, topped_up: 57.86 } })
            ]
        })
        const res = await reqJson(routes, 'GET', '/subscription/summary', token)
        expect(res.status).toBe(200)
        expect(res.body.snapshots).toHaveLength(2)
        const ds = res.body.snapshots.find((s: SubscriptionSnapshot) => s.provider === 'deepseek')
        expect(ds?.balance?.amount).toBe(57.86)
        expect(ds?.balance?.currency).toBe('CNY')
    })
})
