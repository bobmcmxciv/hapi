import { describe, test, expect } from 'bun:test'
import { SubscriptionStore } from './subscriptionStore'
import { cx2ccResponseToSnapshot, startCx2ccPoller, type Cx2ccRawUsage } from './cx2ccPoller'

describe('cx2cc snapshot conversion', () => {
    test('typical response translates both windows and picks main by higher used%', () => {
        const raw: Cx2ccRawUsage = {
            email: 'pang@example.com',
            plan_type: 'pro',
            rate_limit: {
                allowed: true,
                primary_window: { used_percent: 40, reset_at: 1_800_000_000, limit_window_seconds: 5 * 3600 },
                secondary_window: { used_percent: 78, reset_at: 1_800_500_000, limit_window_seconds: 7 * 24 * 3600 }
            }
        }
        const snap = cx2ccResponseToSnapshot(raw, { machine: 'ecs-hub', reportedAt: 1_700_000_000_000 })
        expect(snap.provider).toBe('cx2cc')
        expect(snap.account_key).toBe('pang@example.com')
        expect(snap.plan_name).toBe('ChatGPT pro · pang')
        expect(snap.windows).toHaveLength(2)
        expect(snap.windows[0]?.label).toBe('5h 窗口')
        expect(snap.windows[1]?.label).toBe('7d 窗口')
        // secondary has higher used_percent → it becomes the active one
        expect(snap.windows[0]?.is_active).toBe(false)
        expect(snap.windows[1]?.is_active).toBe(true)
        // reset_at 从秒 → 毫秒
        expect(snap.windows[0]?.reset_at).toBe(1_800_000_000_000)
    })

    test('used_percent >= 95 marks critical', () => {
        const snap = cx2ccResponseToSnapshot({
            email: 'e@x.com',
            plan_type: 'pro',
            rate_limit: {
                primary_window: { used_percent: 96, reset_at: 1, limit_window_seconds: 3600 }
            }
        }, { machine: 'ecs-hub', reportedAt: 1_700_000_000_000 })
        expect(snap.windows[0]?.severity).toBe('critical')
    })

    test('missing email falls back to plan_type as account_key', () => {
        const snap = cx2ccResponseToSnapshot({
            plan_type: 'team',
            rate_limit: { primary_window: { used_percent: 10, reset_at: 1, limit_window_seconds: 3600 } }
        }, { machine: 'ecs-hub', reportedAt: 1_700_000_000_000 })
        expect(snap.account_key).toBe('team')
        expect(snap.plan_name).toBe('ChatGPT team')
    })

    test('no windows at all still produces a snapshot with empty windows', () => {
        const snap = cx2ccResponseToSnapshot({ email: 'e@x.com', plan_type: 'pro', rate_limit: {} }, { machine: 'ecs-hub', reportedAt: 1 })
        expect(snap.windows).toHaveLength(0)
        expect(snap.error).toBeNull()
    })
})

describe('startCx2ccPoller', () => {
    test('pollOnce hits URL with x-api-key header and writes snapshot', async () => {
        const store = new SubscriptionStore(':memory:')
        let capturedUrl = '' as string
        let capturedHeaders: Record<string, string> = {}
        const handle = startCx2ccPoller({
            url: 'https://example.com/cx2cc-api/usage',
            apiKey: 'test-key-123',
            intervalMs: 999_999_999,
            subscriptionStore: store,
            now: () => 1_700_000_000_000,
            fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
                capturedUrl = String(input)
                capturedHeaders = Object.fromEntries(new Headers(init?.headers).entries())
                return new Response(JSON.stringify({
                    email: 'p@x.com', plan_type: 'pro',
                    rate_limit: { primary_window: { used_percent: 5, reset_at: 1, limit_window_seconds: 3600 } }
                }), { status: 200, headers: { 'content-type': 'application/json' } })
            }) as unknown as typeof fetch
        })
        await handle.pollOnce()
        handle.stop()
        expect(capturedUrl).toBe('https://example.com/cx2cc-api/usage')
        expect(capturedHeaders['x-api-key']).toBe('test-key-123')
        const rows = store.listAll()
        expect(rows).toHaveLength(1)
        expect(rows[0]?.provider).toBe('cx2cc')
        expect(rows[0]?.plan_name).toBe('ChatGPT pro · p')
    })

    test('HTTP error writes an error snapshot instead of throwing', async () => {
        const store = new SubscriptionStore(':memory:')
        const handle = startCx2ccPoller({
            url: 'https://example.com/cx2cc-api/usage',
            apiKey: 'k',
            intervalMs: 999_999_999,
            subscriptionStore: store,
            now: () => 1_700_000_000_000,
            log: () => {},
            fetchImpl: (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch
        })
        await handle.pollOnce()
        handle.stop()
        const [row] = store.listAll()
        expect(row?.error).toBe('HTTP 503')
        expect(row?.windows).toHaveLength(0)
    })

    test('fetch throw writes error snapshot with the error message', async () => {
        const store = new SubscriptionStore(':memory:')
        const handle = startCx2ccPoller({
            url: 'https://example.com/cx2cc-api/usage',
            apiKey: 'k',
            intervalMs: 999_999_999,
            subscriptionStore: store,
            now: () => 1_700_000_000_000,
            log: () => {},
            fetchImpl: (async () => { throw new Error('DNS boom') }) as unknown as typeof fetch
        })
        await handle.pollOnce()
        handle.stop()
        const [row] = store.listAll()
        expect(row?.error).toBe('DNS boom')
    })

    test('stop() prevents further scheduled polls', async () => {
        const store = new SubscriptionStore(':memory:')
        let calls = 0
        const handle = startCx2ccPoller({
            url: 'https://example.com/cx2cc-api/usage',
            apiKey: 'k',
            intervalMs: 5,
            subscriptionStore: store,
            log: () => {},
            fetchImpl: (async () => {
                calls++
                return new Response(JSON.stringify({ rate_limit: {} }), { status: 200 })
            }) as unknown as typeof fetch
        })
        await handle.pollOnce()
        handle.stop()
        const before = calls
        // Wait longer than the interval; scheduled next should not fire because stop() clamped it.
        await new Promise(r => setTimeout(r, 40))
        expect(calls).toBe(before)
    })
})
