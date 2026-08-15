import { describe, test, expect } from 'bun:test'
import {
    convertAnthropicLimit,
    convertAnthropicUsage,
    convertDeepSeekBalance,
    convertGlmQuota,
    convertKimiUsage,
    kimiWindowLabel,
    kimiWindowMinutes,
    glmWindowLabel,
    apiKeySuffix,
    collectAnthropic,
    collectDeepSeek,
    collectGlm,
    collectKimi,
    type CollectContext
} from './adapters'

const CTX = { machine: 'vircs', reportedAt: 1_700_000_000_000 }

function ctxWith(fetchImpl: typeof fetch): CollectContext {
    return { machine: 'vircs', now: () => 1_700_000_000_000, fetchImpl }
}

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

// 真实响应体(2026-08-14 在 vircs 上从 api.anthropic.com 抓的,只裁掉无关字段)
const REAL_ANTHROPIC_USAGE = {
    five_hour: { utilization: 0.0, resets_at: '2026-08-15T10:30:00.119464+00:00' },
    seven_day: { utilization: 79.0, resets_at: '2026-08-16T16:00:00.119492+00:00' },
    limits: [
        { kind: 'session', group: 'session', percent: 0, severity: 'normal', resets_at: '2026-08-15T10:30:00.119464+00:00', scope: null, is_active: false },
        { kind: 'weekly_all', group: 'weekly', percent: 79, severity: 'warning', resets_at: '2026-08-16T16:00:00.119492+00:00', scope: null, is_active: false },
        { kind: 'weekly_scoped', group: 'weekly', percent: 100, severity: 'critical', resets_at: '2026-08-16T16:00:00.119768+00:00', scope: { model: { id: null, display_name: 'Fable' }, surface: null }, is_active: true }
    ]
}

const REAL_ANTHROPIC_PROFILE = {
    account: { uuid: 'x', email: 'smith_crystal6124@yahoo.com', has_claude_max: true, has_claude_pro: false },
    organization: { rate_limit_tier: 'default_claude_max_20x' }
}

// 真实 DeepSeek 响应(2026-08-14 vircs 抓)
const REAL_DEEPSEEK = {
    is_available: true,
    balance_infos: [{ currency: 'CNY', total_balance: '57.86', granted_balance: '0.00', topped_up_balance: '57.86' }]
}

// 真实 Kimi 响应(2026-08-14 vircs 抓)
const REAL_KIMI = {
    user: { userId: 'crp9ok2bhd5odpfcs2dg', region: 'REGION_CN', membership: { level: 'LEVEL_INTERMEDIATE' }, businessId: '' },
    usage: { limit: '100', used: '45', remaining: '55', resetTime: '2026-08-19T06:40:25.742592Z' },
    limits: [{ window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' }, detail: { limit: '100', remaining: '100', resetTime: '2026-08-15T10:40:25.742592Z' } }],
    parallel: { limit: '20' },
    subType: 'TYPE_PURCHASE'
}

// 真实 GLM 响应(2026-08-14 vircs 抓)
const REAL_GLM = {
    code: 200, msg: '操作成功', success: true,
    data: {
        limits: [
            { type: 'TIME_LIMIT', unit: 5, number: 1, usage: 4000, currentValue: 4, remaining: 3996, percentage: 1, nextResetTime: 1786780625997 },
            { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 4, nextResetTime: 1786788066098 },
            { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 1, nextResetTime: 1787126225997 }
        ],
        level: 'max'
    }
}

describe('anthropic adapter', () => {
    test('real response yields 5h / weekly / Fable windows', () => {
        const snap = convertAnthropicUsage(REAL_ANTHROPIC_USAGE, REAL_ANTHROPIC_PROFILE, CTX)
        expect(snap.provider).toBe('anthropic')
        expect(snap.plan_name).toBe('Claude Max')
        expect(snap.account_key).toBe('smith_crystal6124@yahoo.com')
        expect(snap.windows).toHaveLength(3)
        expect(snap.windows.map(w => w.label)).toEqual(['5 小时窗口', '周窗口', 'Fable 周窗口'])
        expect(snap.windows.map(w => w.used_percent)).toEqual([0, 79, 100])
    })

    test('fable window keeps API severity and is_active', () => {
        const snap = convertAnthropicUsage(REAL_ANTHROPIC_USAGE, REAL_ANTHROPIC_PROFILE, CTX)
        const fable = snap.windows.find(w => w.label === 'Fable 周窗口')
        expect(fable?.severity).toBe('critical')
        expect(fable?.is_active).toBe(true)
        expect(fable?.key).toBe('weekly_scoped:fable')
    })

    test('resets_at ISO converts to epoch ms', () => {
        const snap = convertAnthropicUsage(REAL_ANTHROPIC_USAGE, REAL_ANTHROPIC_PROFILE, CTX)
        expect(snap.windows[0]?.reset_at).toBe(Date.parse('2026-08-15T10:30:00.119464+00:00'))
    })

    test('missing profile degrades account_key but keeps windows', () => {
        const snap = convertAnthropicUsage(REAL_ANTHROPIC_USAGE, null, CTX)
        expect(snap.account_key).toBe('default')
        expect(snap.plan_name).toBe('Claude')
        expect(snap.windows).toHaveLength(3)
    })

    test('limit without percent is dropped, not thrown', () => {
        expect(convertAnthropicLimit({ kind: 'session' })).toBeNull()
    })

    test('severity falls back to percent when API omits it', () => {
        const w = convertAnthropicLimit({ kind: 'session', percent: 96 })
        expect(w?.severity).toBe('critical')
    })

    test('collectAnthropic maps HTTP 401 into an error snapshot', async () => {
        const snap = await collectAnthropic(ctxWith((async () => new Response('no', { status: 401 })) as unknown as typeof fetch), 'tok')
        expect(snap.error).toContain('401')
        expect(snap.windows).toHaveLength(0)
    })

    test('collectAnthropic sends the oauth beta header', async () => {
        let headers: Record<string, string> = {}
        const fetchImpl = (async (_url: string, init?: RequestInit) => {
            headers = Object.fromEntries(new Headers(init?.headers).entries())
            return jsonResponse(REAL_ANTHROPIC_USAGE)
        }) as unknown as typeof fetch
        await collectAnthropic(ctxWith(fetchImpl), 'tok')
        expect(headers['anthropic-beta']).toBe('oauth-2025-04-20')
        expect(headers['authorization']).toBe('Bearer tok')
    })

    test('profile failure still produces a usable snapshot', async () => {
        let call = 0
        const fetchImpl = (async () => {
            call++
            return call === 1 ? jsonResponse(REAL_ANTHROPIC_USAGE) : new Response('nope', { status: 500 })
        }) as unknown as typeof fetch
        const snap = await collectAnthropic(ctxWith(fetchImpl), 'tok')
        expect(snap.error).toBeNull()
        expect(snap.windows).toHaveLength(3)
        expect(snap.account_key).toBe('default')
    })
})

describe('deepseek adapter', () => {
    test('real response yields a CNY balance and no windows', () => {
        const snap = convertDeepSeekBalance(REAL_DEEPSEEK, { ...CTX, accountKey: '…a834' })
        expect(snap.balance?.amount).toBe(57.86)
        expect(snap.balance?.currency).toBe('CNY')
        expect(snap.balance?.topped_up).toBe(57.86)
        expect(snap.windows).toHaveLength(0)
        // plan_name 留空:前端渲染 provider 名就够了,不塞采集器硬编码的中文串。
        expect(snap.plan_name).toBeNull()
        expect(snap.error).toBeNull()
    })

    test('is_available=false 抬进 error 通道(前端红底显示),余额仍保留', () => {
        const snap = convertDeepSeekBalance({ ...REAL_DEEPSEEK, is_available: false }, { ...CTX, accountKey: 'k' })
        expect(snap.error).toContain('unavailable')
        expect(snap.balance?.amount).toBe(57.86)
    })

    test('empty balance_infos becomes an error snapshot', () => {
        const snap = convertDeepSeekBalance({ balance_infos: [] }, { ...CTX, accountKey: 'k' })
        expect(snap.error).toContain('balance_infos')
        expect(snap.balance).toBeNull()
    })

    test('collectDeepSeek network error becomes an error snapshot', async () => {
        const snap = await collectDeepSeek(
            ctxWith((async () => { throw new Error('ECONNRESET') }) as unknown as typeof fetch),
            'sk-abcdefgh12345678'
        )
        expect(snap.error).toBe('ECONNRESET')
        expect(snap.account_key).toBe('…12345678')
    })
})

describe('kimi adapter', () => {
    test('real response yields plan total + 5h window', () => {
        const snap = convertKimiUsage(REAL_KIMI, { ...CTX, accountKey: 'fallback' })
        expect(snap.account_key).toBe('crp9ok2bhd5odpfcs2dg')
        expect(snap.plan_name).toBe('Kimi Coding · intermediate')
        expect(snap.windows).toHaveLength(2)
        expect(snap.windows[0]?.label).toBe('套餐额度')
        expect(snap.windows[0]?.used_percent).toBe(45)
        expect(snap.windows[1]?.label).toBe('5 小时窗口')
        expect(snap.windows[1]?.used_percent).toBe(0)
    })

    test('300 TIME_UNIT_MINUTE renders as 5 小时窗口', () => {
        expect(kimiWindowLabel(300, 'TIME_UNIT_MINUTE')).toBe('5 小时窗口')
        expect(kimiWindowLabel(90, 'TIME_UNIT_MINUTE')).toBe('90 分钟窗口')
        expect(kimiWindowLabel(7, 'TIME_UNIT_DAY')).toBe('7 天窗口')
    })

    test('window key 编码时长(分钟),让前端能按界面语言渲染标签', () => {
        // 这是 UI 契约:SubscriptionPanel.translateWindowLabel 认 duration_<minutes>。
        // 改这里的 key 格式会让英文界面退回显示采集器的中文 label。
        const snap = convertKimiUsage(REAL_KIMI, { ...CTX, accountKey: 'k' })
        expect(snap.windows.map(w => w.key)).toEqual(['plan_total', 'duration_300'])
    })

    test('时长单位换算成分钟', () => {
        expect(kimiWindowMinutes(300, 'TIME_UNIT_MINUTE')).toBe(300)
        expect(kimiWindowMinutes(5, 'TIME_UNIT_HOUR')).toBe(300)
        expect(kimiWindowMinutes(1, 'TIME_UNIT_DAY')).toBe(1440)
        expect(kimiWindowMinutes(null, 'TIME_UNIT_MINUTE')).toBeNull()
        expect(kimiWindowMinutes(5, 'UNKNOWN_UNIT')).toBeNull()
    })

    test('识别不了时长时 key 退回索引形式(前端会用 label 兜底)', () => {
        const snap = convertKimiUsage({
            user: { userId: 'u' },
            limits: [{ window: { duration: 5, timeUnit: 'WEIRD_UNIT' }, detail: { limit: '10', remaining: '5' } }]
        }, { ...CTX, accountKey: 'k' })
        expect(snap.windows[0]?.key).toBe('window_0')
    })

    test('string numbers are parsed (kimi sends numbers as strings)', () => {
        const snap = convertKimiUsage(REAL_KIMI, { ...CTX, accountKey: 'k' })
        expect(typeof snap.windows[0]?.used_percent).toBe('number')
    })

    test('zero limit does not divide by zero', () => {
        const snap = convertKimiUsage({ usage: { limit: '0', used: '0' } }, { ...CTX, accountKey: 'k' })
        expect(snap.windows).toHaveLength(0)
    })

    test('collectKimi 404 becomes an error snapshot', async () => {
        const snap = await collectKimi(ctxWith((async () => new Response('', { status: 404 })) as unknown as typeof fetch), 'sk-kimi-xyz')
        expect(snap.error).toContain('404')
    })
})

describe('glm adapter', () => {
    test('real response maps unit 3 -> 5h and unit 6 -> weekly', () => {
        const snap = convertGlmQuota(REAL_GLM, { ...CTX, accountKey: '…776a8' })
        expect(snap.plan_name).toBe('Zhipu GLM · max')
        const byKey = Object.fromEntries(snap.windows.map(w => [w.key, w]))
        expect(byKey.five_hour?.label).toBe('5 小时窗口')
        expect(byKey.five_hour?.used_percent).toBe(4)
        expect(byKey.weekly?.label).toBe('周窗口')
        expect(byKey.weekly?.used_percent).toBe(1)
        expect(byKey.tool_calls?.label).toBe('工具调用额度')
    })

    test('nextResetTime is already epoch ms and passes through', () => {
        const snap = convertGlmQuota(REAL_GLM, { ...CTX, accountKey: 'k' })
        const weekly = snap.windows.find(w => w.key === 'weekly')
        expect(weekly?.reset_at).toBe(1787126225997)
    })

    test('five_hour is the active window', () => {
        const snap = convertGlmQuota(REAL_GLM, { ...CTX, accountKey: 'k' })
        expect(snap.windows.filter(w => w.is_active).map(w => w.key)).toEqual(['five_hour'])
    })

    test('业务错误(HTTP 200 + success:false)变成 error 快照', () => {
        const snap = convertGlmQuota(
            { code: 404, msg: '接口不存在: /openplatform/coding_plan/remains', success: false, data: null },
            { ...CTX, accountKey: 'k' }
        )
        expect(snap.error).toContain('接口不存在')
        expect(snap.windows).toHaveLength(0)
    })

    test('unit mapping helper', () => {
        expect(glmWindowLabel('TOKENS_LIMIT', 3).key).toBe('five_hour')
        expect(glmWindowLabel('TOKENS_LIMIT', 6).key).toBe('weekly')
        expect(glmWindowLabel('TIME_LIMIT', 5).key).toBe('tool_calls')
        expect(glmWindowLabel('TOKENS_LIMIT', 99).key).toBe('unit_99')
    })

    test('collectGlm sends Authorization without Bearer prefix', async () => {
        let headers: Record<string, string> = {}
        const fetchImpl = (async (_url: string, init?: RequestInit) => {
            headers = Object.fromEntries(new Headers(init?.headers).entries())
            return jsonResponse(REAL_GLM)
        }) as unknown as typeof fetch
        await collectGlm(ctxWith(fetchImpl), 'my-glm-key')
        expect(headers['authorization']).toBe('my-glm-key')
    })

    test('falls back to first window as active when no five_hour present', () => {
        const snap = convertGlmQuota(
            { code: 200, success: true, data: { limits: [{ type: 'TOKENS_LIMIT', unit: 6, percentage: 30, nextResetTime: 1 }] } },
            { ...CTX, accountKey: 'k' }
        )
        expect(snap.windows[0]?.is_active).toBe(true)
    })
})

describe('apiKeySuffix', () => {
    test('keeps only the last 8 chars so full keys never reach the DB', () => {
        expect(apiKeySuffix('sk-4431c46123054ee496c5d1ec5a76a834')).toBe('…5a76a834')
        expect(apiKeySuffix('short')).toBe('short')
    })
})
