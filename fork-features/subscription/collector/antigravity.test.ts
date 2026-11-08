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

    test('execFile timeout（进程被杀、code=null）报超时而不是执行失败', async () => {
        // Node execFile timeout 杀掉的进程是 SIGTERM 终止：err.code 为 null，
        // 标志在 killed/signal/timedOut 上。只认 code==='ETIMEDOUT' 会把超时
        // 误报成"执行失败"，线上排查方向就跑偏了。
        const err = Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM', code: null })
        const snapshot = await collectAntigravity({ machine: 'vircs', now: () => 123 }, 'agy', 'default', async () => { throw err })
        expect(snapshot.error).toBe('agy /usage 超时')

        const syncErr = Object.assign(new Error('Timed out'), { code: 'ETIMEDOUT' })
        const snap2 = await collectAntigravity({ machine: 'vircs', now: () => 123 }, 'agy', 'default', async () => { throw syncErr })
        expect(snap2.error).toBe('agy /usage 超时')
    })
})
