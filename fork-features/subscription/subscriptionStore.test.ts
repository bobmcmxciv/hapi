import { describe, test, expect } from 'bun:test'
import { SubscriptionStore } from './subscriptionStore'
import type { SubscriptionSnapshot } from './domain'

function snap(overrides: Partial<SubscriptionSnapshot> = {}): SubscriptionSnapshot {
    return {
        machine: 'vircs',
        provider: 'anthropic',
        account_key: 'bob@example.com',
        plan_name: 'Claude Max',
        windows: [
            { key: 'five_hour', label: '5小时', used_percent: 12, reset_at: 1_800_000_000_000, severity: 'normal', is_active: true },
            { key: 'seven_day', label: '周', used_percent: 79, reset_at: 1_800_500_000_000, severity: 'warning', is_active: false }
        ],
        balance: null,
        error: null,
        reported_at: 1_700_000_000_000,
        ...overrides
    }
}

describe('SubscriptionStore', () => {
    test('upsert then read round-trips windows and metadata', () => {
        const store = new SubscriptionStore(':memory:')
        store.upsertSnapshots([snap()])
        const rows = store.listAll()
        expect(rows).toHaveLength(1)
        expect(rows[0]?.plan_name).toBe('Claude Max')
        expect(rows[0]?.windows).toHaveLength(2)
        expect(rows[0]?.windows[0]?.key).toBe('five_hour')
        expect(rows[0]?.windows[1]?.severity).toBe('warning')
        expect(rows[0]?.balance).toBeNull()
    })

    test('same primary key upserts instead of duplicating', () => {
        const store = new SubscriptionStore(':memory:')
        store.upsertSnapshots([snap({ plan_name: 'Old Plan' })])
        store.upsertSnapshots([snap({ plan_name: 'New Plan', reported_at: 1_700_100_000_000 })])
        const rows = store.listAll()
        expect(rows).toHaveLength(1)
        expect(rows[0]?.plan_name).toBe('New Plan')
        expect(rows[0]?.reported_at).toBe(1_700_100_000_000)
    })

    test('multiple providers/accounts per machine coexist', () => {
        const store = new SubscriptionStore(':memory:')
        store.upsertSnapshots([
            snap(),
            snap({ provider: 'deepseek', account_key: 'sk-...abcd', balance: { amount: 57.86, currency: 'CNY', granted: 0, topped_up: 57.86 }, windows: [] }),
            snap({ machine: 'desktop', provider: 'kimi', account_key: 'sk-kimi-...' })
        ])
        expect(store.listAll()).toHaveLength(3)
    })

    test('balance-only provider persists balance and empty windows', () => {
        const store = new SubscriptionStore(':memory:')
        store.upsertSnapshots([
            snap({
                provider: 'deepseek',
                account_key: 'sk-...abcd',
                plan_name: 'DeepSeek 按量',
                windows: [],
                balance: { amount: 57.86, currency: 'CNY', granted: 0, topped_up: 57.86 }
            })
        ])
        const [row] = store.listAll()
        expect(row?.balance?.amount).toBe(57.86)
        expect(row?.balance?.currency).toBe('CNY')
        expect(row?.windows).toHaveLength(0)
    })

    test('error snapshot is stored so UI can show stale/failed state', () => {
        const store = new SubscriptionStore(':memory:')
        store.upsertSnapshots([
            snap({ error: 'HTTP 401 Unauthorized', windows: [], balance: null, plan_name: null })
        ])
        const [row] = store.listAll()
        expect(row?.error).toBe('HTTP 401 Unauthorized')
        expect(row?.windows).toHaveLength(0)
    })

    test('malformed window fields are dropped, not thrown', () => {
        const store = new SubscriptionStore(':memory:')
        // 故意传坏值,验证 normalize 会剔除它;不用 @ts-expect-error 因为 SubscriptionWindow
        // 的字段都是宽类型(string/number),异形值恰好能过类型检查、只在运行期被 normalize 拦掉。
        store.upsertSnapshots([snap({
            windows: [
                { key: 'ok', label: 'OK', used_percent: 42, reset_at: 1_800_000_000_000, severity: 'normal', is_active: true },
                { key: '', label: 'bad-key', used_percent: 10, reset_at: null, severity: 'normal', is_active: false },
                { key: 'nan', label: 'NaN', used_percent: NaN, reset_at: null, severity: 'normal', is_active: false }
            ]
        })])
        const [row] = store.listAll()
        expect(row?.windows.map(w => w.key)).toEqual(['ok'])
    })

    test('used_percent clamps to [0,100]', () => {
        const store = new SubscriptionStore(':memory:')
        store.upsertSnapshots([snap({
            windows: [
                { key: 'over', label: 'over', used_percent: 150, reset_at: null, severity: 'critical', is_active: true },
                { key: 'under', label: 'under', used_percent: -5, reset_at: null, severity: 'normal', is_active: false }
            ]
        })])
        const [row] = store.listAll()
        expect(row?.windows[0]?.used_percent).toBe(100)
        expect(row?.windows[1]?.used_percent).toBe(0)
    })

    test('deleteByMachine removes only that machine', () => {
        const store = new SubscriptionStore(':memory:')
        store.upsertSnapshots([
            snap({ machine: 'vircs' }),
            snap({ machine: 'desktop', provider: 'kimi' })
        ])
        const removed = store.deleteByMachine('vircs')
        expect(removed).toBe(1)
        const remaining = store.listAll()
        expect(remaining).toHaveLength(1)
        expect(remaining[0]?.machine).toBe('desktop')
    })

    test('getByKey returns null when missing', () => {
        const store = new SubscriptionStore(':memory:')
        expect(store.getByKey('vircs', 'anthropic', 'nope')).toBeNull()
        store.upsertSnapshots([snap()])
        expect(store.getByKey('vircs', 'anthropic', 'bob@example.com')?.plan_name).toBe('Claude Max')
    })
})
