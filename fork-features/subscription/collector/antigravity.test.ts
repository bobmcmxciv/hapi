import { describe, expect, test } from 'bun:test'
import { collectAntigravity, convertAntigravityUsage } from './antigravity'

const QUOTA = JSON.stringify({
    status: 'SUCCESS',
    command: {
        name: 'usage',
        data: { groups: [
            { name: 'Gemini Models', buckets: [
                { id: 'gemini-weekly', name: 'Weekly Limit Remaining', remaining_fraction: 1, reset_time: '2026-10-27T03:59:47Z' }
            ] },
            { name: 'Claude and GPT models', buckets: [
                { id: '3p-5h', name: 'Five Hour Limit Remaining', remaining_fraction: 0.9535295963, reset_time: '2026-10-20T08:47:03Z' }
            ] }
        ] }
    }
})

describe('Antigravity /usage collector', () => {
    test('maps remaining fractions to used percentages and reset timestamps', () => {
        const snapshot = convertAntigravityUsage(QUOTA, { machine: 'vircs', accountKey: 'default', reportedAt: 123 })
        expect(snapshot.provider).toBe('antigravity')
        expect(snapshot.account_key).toBe('default')
        expect(snapshot.windows).toEqual([
            { key: 'agy:gemini-weekly', label: 'Gemini Models · Weekly Limit · 已用', used_percent: 0,
                reset_at: Date.parse('2026-10-27T03:59:47Z'), severity: 'normal', is_active: false },
            { key: 'agy:3p-5h', label: 'Claude and GPT models · Five Hour Limit · 已用', used_percent: 4.6,
                reset_at: Date.parse('2026-10-20T08:47:03Z'), severity: 'normal', is_active: false }
        ])
    })

    test('rejects a successful but empty or unrelated response rather than reporting zero use', () => {
        expect(() => convertAntigravityUsage('{"status":"SUCCESS"}', { machine: 'vircs', accountKey: 'default', reportedAt: 123 })).toThrow()
        expect(() => convertAntigravityUsage('{"status":"SUCCESS","command":{"name":"usage","data":{"groups":[]}}}',
            { machine: 'vircs', accountKey: 'default', reportedAt: 123 })).toThrow()
    })

    test('CLI failure becomes a sanitized error snapshot, not raw stderr', async () => {
        const snapshot = await collectAntigravity({ machine: 'vircs', now: () => 123 }, 'agy', 'default', async () => {
            throw new Error('secret account data from stderr')
        })
        expect(snapshot.error).toBe('agy /usage 执行失败')
        expect(JSON.stringify(snapshot)).not.toContain('secret')
    })
})
