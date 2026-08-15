import { describe, test, expect } from 'bun:test'
import { SubscriptionStore } from './subscriptionStore'
import {
    cx2ccResponseToSnapshot,
    cx2ccAccountToSnapshot,
    cx2ccAccountsToSnapshots,
    startCx2ccPoller,
    type Cx2ccRawUsage,
    type Cx2ccAccountsResponse
} from './cx2ccPoller'

// 真实响应（2026-08-15 从 bob.18852271093.top/cx2cc-api/accounts 抓，只裁掉 note/path）
const REAL_ACCOUNTS: Cx2ccAccountsResponse = {
    accounts: [
        {
            id: 'pro-cad25176', email: 'f7bnzpnygj@privaterelay.appleid.com', plan: 'pro',
            priority: 0, active: true, available: true, limit_reached: false,
            used_percent: 15, window_reset_at: 1787196670
        },
        {
            id: 'prolite-5f33844b', email: 'eechpxdmvzugf@mail.com', plan: 'prolite',
            priority: 1, active: false, available: true, limit_reached: false,
            used_percent: 0, window_reset_at: 1787386724
        }
    ],
    active: 'pro-cad25176'
}

const REAL_USAGE: Cx2ccRawUsage = {
    email: 'f7bnzpnygj@privaterelay.appleid.com',
    plan_type: 'pro',
    rate_limit: {
        allowed: true,
        primary_window: { used_percent: 15, reset_at: 1787196670, limit_window_seconds: 604800 }
    }
}

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

describe('cx2cc 账号池（轮换用的多个账号）', () => {
    test('真实两账号响应各出一条快照，主用/备用分得清', () => {
        const snaps = cx2ccAccountsToSnapshots(REAL_ACCOUNTS, REAL_USAGE, { machine: 'ecs-hub', reportedAt: 1 })
        expect(snaps).toHaveLength(2)
        expect(snaps[0]?.account_key).toBe('f7bnzpnygj@privaterelay.appleid.com')
        expect(snaps[0]?.plan_name).toBe('ChatGPT pro · 主用')
        expect(snaps[1]?.account_key).toBe('eechpxdmvzugf@mail.com')
        expect(snaps[1]?.plan_name).toBe('ChatGPT prolite · 备用')
    })

    test('生效账号拿 /usage 的窗口明细，备用账号用 used_percent 合成单窗口', () => {
        const snaps = cx2ccAccountsToSnapshots(REAL_ACCOUNTS, REAL_USAGE, { machine: 'ecs-hub', reportedAt: 1 })
        // 生效账号：/usage 的 primary_window（604800s = 7d）
        expect(snaps[0]?.windows[0]?.label).toBe('7d 窗口')
        // 备用账号：没有窗口明细，合成一条
        expect(snaps[1]?.windows).toHaveLength(1)
        expect(snaps[1]?.windows[0]?.key).toBe('account_window')
        expect(snaps[1]?.windows[0]?.used_percent).toBe(0)
        // window_reset_at 是秒，要转毫秒
        expect(snaps[1]?.windows[0]?.reset_at).toBe(1787386724 * 1000)
    })

    test('备用账号 0% 也必须出现——这正是加这个功能的原因', () => {
        const snaps = cx2ccAccountsToSnapshots(REAL_ACCOUNTS, REAL_USAGE, { machine: 'ecs-hub', reportedAt: 1 })
        const backup = snaps.find(s => s.account_key === 'eechpxdmvzugf@mail.com')
        expect(backup).toBeTruthy()
        expect(backup?.windows).toHaveLength(1)
    })

    test('limit_reached 优先于主用/备用标注', () => {
        const snap = cx2ccAccountToSnapshot(
            { id: 'x', email: 'a@b.com', plan: 'pro', limit_reached: true, used_percent: 100, window_reset_at: 1 },
            { machine: 'ecs-hub', reportedAt: 1, isActive: true, detailedWindows: null }
        )
        expect(snap.plan_name).toBe('ChatGPT pro · 已限流')
        expect(snap.windows[0]?.severity).toBe('critical')
    })

    test('available=false 标为不可用', () => {
        const snap = cx2ccAccountToSnapshot(
            { id: 'x', email: 'a@b.com', plan: 'prolite', available: false, used_percent: 0 },
            { machine: 'ecs-hub', reportedAt: 1, isActive: false, detailedWindows: null }
        )
        expect(snap.plan_name).toBe('ChatGPT prolite · 不可用')
    })

    test('顶层 active 缺失时退回各条目自己的 active 标记', () => {
        const snaps = cx2ccAccountsToSnapshots(
            { accounts: REAL_ACCOUNTS.accounts },
            null,
            { machine: 'ecs-hub', reportedAt: 1 }
        )
        expect(snaps[0]?.plan_name).toContain('主用')
        expect(snaps[1]?.plan_name).toContain('备用')
    })

    test('空账号池返回空数组（调用方据此回落到只报生效账号）', () => {
        expect(cx2ccAccountsToSnapshots({ accounts: [] }, REAL_USAGE, { machine: 'm', reportedAt: 1 })).toHaveLength(0)
        expect(cx2ccAccountsToSnapshots({}, REAL_USAGE, { machine: 'm', reportedAt: 1 })).toHaveLength(0)
    })

    test('没有 used_percent 的账号出空窗口而不是崩', () => {
        const snap = cx2ccAccountToSnapshot(
            { id: 'x', email: 'a@b.com', plan: 'pro' },
            { machine: 'm', reportedAt: 1, isActive: false, detailedWindows: null }
        )
        expect(snap.windows).toHaveLength(0)
        expect(snap.error).toBeNull()
    })
})

describe('startCx2ccPoller', () => {
    test('同时拉 /usage 与 /accounts，落库两个账号', async () => {
        const store = new SubscriptionStore(':memory:')
        const seen: string[] = []
        const handle = startCx2ccPoller({
            url: 'https://example.com/cx2cc-api/usage',
            apiKey: 'k',
            intervalMs: 999_999_999,
            subscriptionStore: store,
            now: () => 1_700_000_000_000,
            log: () => {},
            fetchImpl: (async (input: string | URL | Request) => {
                const u = String(input)
                seen.push(u)
                if (u.endsWith('/accounts')) return new Response(JSON.stringify(REAL_ACCOUNTS), { status: 200 })
                return new Response(JSON.stringify(REAL_USAGE), { status: 200 })
            }) as unknown as typeof fetch
        })
        await handle.pollOnce()
        handle.stop()
        expect(seen).toContain('https://example.com/cx2cc-api/accounts')
        const rows = store.listAll()
        expect(rows).toHaveLength(2)
        expect(rows.map(r => r.account_key).sort()).toEqual([
            'eechpxdmvzugf@mail.com', 'f7bnzpnygj@privaterelay.appleid.com'
        ])
    })

    test('/accounts 404（老版本 cx2cc）时回落到只报生效账号，不算失败', async () => {
        const store = new SubscriptionStore(':memory:')
        const handle = startCx2ccPoller({
            url: 'https://example.com/cx2cc-api/usage',
            apiKey: 'k',
            intervalMs: 999_999_999,
            subscriptionStore: store,
            now: () => 1_700_000_000_000,
            log: () => {},
            fetchImpl: (async (input: string | URL | Request) => {
                const u = String(input)
                if (u.endsWith('/accounts')) return new Response('', { status: 404 })
                return new Response(JSON.stringify(REAL_USAGE), { status: 200 })
            }) as unknown as typeof fetch
        })
        await handle.pollOnce()
        handle.stop()
        const rows = store.listAll()
        expect(rows).toHaveLength(1)
        expect(rows[0]?.error).toBeNull()
        expect(rows[0]?.account_key).toBe('f7bnzpnygj@privaterelay.appleid.com')
    })

    test('两个端点都带 x-api-key，且 /accounts 由 /usage 的路径推导', async () => {
        const store = new SubscriptionStore(':memory:')
        const capturedUrls: string[] = []
        const capturedKeys: string[] = []
        const handle = startCx2ccPoller({
            url: 'https://example.com/cx2cc-api/usage',
            apiKey: 'test-key-123',
            intervalMs: 999_999_999,
            subscriptionStore: store,
            now: () => 1_700_000_000_000,
            log: () => {},
            // 关掉构造时的 eager 首轮，否则它与下面显式的 pollOnce() 各发一遍，URL 会重复
            eager: false,
            fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
                capturedUrls.push(String(input))
                capturedKeys.push(new Headers(init?.headers).get('x-api-key') ?? '')
                // 只有 /usage 有内容；/accounts 返回空池 → 回落到单账号路径
                return new Response(JSON.stringify({
                    email: 'p@x.com', plan_type: 'pro',
                    rate_limit: { primary_window: { used_percent: 5, reset_at: 1, limit_window_seconds: 3600 } }
                }), { status: 200, headers: { 'content-type': 'application/json' } })
            }) as unknown as typeof fetch
        })
        await handle.pollOnce()
        handle.stop()
        expect(capturedUrls).toEqual([
            'https://example.com/cx2cc-api/usage',
            'https://example.com/cx2cc-api/accounts'
        ])
        expect(capturedKeys).toEqual(['test-key-123', 'test-key-123'])
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
