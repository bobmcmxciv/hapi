import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import SubscriptionPanel, {
    formatResetTime,
    formatRelativeAge,
    pickPrimaryWindow,
    translateWindowLabel,
    STALE_THRESHOLD_MS,
    type SubscriptionSnapshot,
    type SubscriptionWindow
} from './SubscriptionPanel'

vi.mock('@/lib/app-context', () => ({ useAppContext: () => ({ baseUrl: 'http://hub', token: 'jwt', user: { id: 1 } }) }))

afterEach(() => { vi.restoreAllMocks() })

function win(overrides: Partial<SubscriptionWindow> = {}): SubscriptionWindow {
    return {
        key: 'k', label: 'L', used_percent: 10, reset_at: null,
        severity: 'normal', is_active: false, ...overrides
    }
}

/** 简易 t()：直接回显 key + 变量，好断言选了哪个分支。 */
const t = (key: string, vars?: Record<string, string | number>) =>
    vars ? `${key}:${Object.values(vars).join(',')}` : key

function renderPanel() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(
        <QueryClientProvider client={client}>
            <I18nProvider><SubscriptionPanel /></I18nProvider>
        </QueryClientProvider>
    )
}

function mockSummary(snapshots: SubscriptionSnapshot[], status = 200) {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
        JSON.stringify({ snapshots, generatedAt: Date.now() }),
        { status, headers: { 'content-type': 'application/json' } }
    )))
}

/** 真实抓到的 Claude 快照（2026-08-14 vircs → hub e2e 的那一份）。 */
function claudeSnapshot(overrides: Partial<SubscriptionSnapshot> = {}): SubscriptionSnapshot {
    return {
        machine: 'vircs',
        provider: 'anthropic',
        account_key: 'smith_crystal6124@yahoo.com',
        plan_name: 'Claude Max',
        windows: [
            { key: 'session', label: '5 小时窗口', used_percent: 11, reset_at: 1786789800203, severity: 'normal', is_active: false },
            { key: 'weekly_all', label: '周窗口', used_percent: 81, reset_at: 1786896000203, severity: 'warning', is_active: false },
            { key: 'weekly_scoped:fable', label: 'Fable 周窗口', used_percent: 100, reset_at: 1786896000203, severity: 'critical', is_active: true }
        ],
        balance: null,
        error: null,
        reported_at: Date.now() - 60_000,
        ...overrides
    }
}

describe('formatResetTime — 客户端时区渲染', () => {
    // 这是本面板的核心需求：hub 在 UTC、采集机 vircs 在 UTC-7、人在 UTC+8，
    // 三个时区各不相同，所以只能传 epoch 再按浏览器时区渲染。
    const epoch = Date.parse('2026-08-16T16:00:00Z')

    it('同一 epoch 在不同时区渲染出不同本地时间', () => {
        const shanghai = formatResetTime(epoch, { locale: 'en-US', timeZone: 'Asia/Shanghai' })
        const utc = formatResetTime(epoch, { locale: 'en-US', timeZone: 'UTC' })
        const la = formatResetTime(epoch, { locale: 'en-US', timeZone: 'America/Los_Angeles' })
        // UTC+8 → 次日 00:00；UTC → 当日 16:00；UTC-7 → 当日 09:00
        expect(shanghai).toContain('8/17')
        expect(shanghai).toContain('00:00')
        expect(utc).toContain('8/16')
        expect(utc).toContain('16:00')
        expect(la).toContain('8/16')
        expect(la).toContain('09:00')
        expect(new Set([shanghai, utc, la]).size).toBe(3)
    })

    it('24 小时制，不出现 AM/PM', () => {
        const out = formatResetTime(epoch, { locale: 'en-US', timeZone: 'Asia/Shanghai' })
        expect(out).not.toContain('AM')
        expect(out).not.toContain('PM')
    })

    it('null / NaN 返回 null 而不是崩', () => {
        expect(formatResetTime(null)).toBeNull()
        expect(formatResetTime(NaN)).toBeNull()
    })

    it('非法时区不抛异常，降级为 null', () => {
        expect(formatResetTime(epoch, { timeZone: 'Not/AZone' })).toBeNull()
    })
})

describe('pickPrimaryWindow', () => {
    it('优先取 is_active 的窗口（provider 自己标的当前生效项）', () => {
        const active = win({ key: 'fable', used_percent: 100, is_active: true })
        const picked = pickPrimaryWindow([win({ key: 'a', used_percent: 5 }), active])
        expect(picked?.key).toBe('fable')
    })

    it('都不 active 时取 used_percent 最高的（最接近打满的才是瓶颈）', () => {
        const picked = pickPrimaryWindow([
            win({ key: 'a', used_percent: 5 }),
            win({ key: 'b', used_percent: 81 }),
            win({ key: 'c', used_percent: 40 })
        ])
        expect(picked?.key).toBe('b')
    })

    it('空数组返回 null', () => {
        expect(pickPrimaryWindow([])).toBeNull()
    })

    it('单条窗口直接返回它', () => {
        expect(pickPrimaryWindow([win({ key: 'only' })])?.key).toBe('only')
    })
})

describe('formatRelativeAge', () => {
    it('分钟以内是"刚刚"', () => {
        expect(formatRelativeAge(30_000, t)).toBe('subscription.age.justNow')
    })

    it('分钟 / 小时 / 天各走各的分支', () => {
        expect(formatRelativeAge(5 * 60_000, t)).toBe('subscription.age.minutes:5')
        expect(formatRelativeAge(3 * 3600_000, t)).toBe('subscription.age.hours:3')
        expect(formatRelativeAge(50 * 3600_000, t)).toBe('subscription.age.days:2')
    })

    it('stale 阈值是 15 分钟——collector 每 5 分钟一轮，留 3 倍余量', () => {
        expect(STALE_THRESHOLD_MS).toBe(15 * 60 * 1000)
        // 一轮失败(10min)不该判 stale；连续失败(16min)才判。
        expect(10 * 60_000 > STALE_THRESHOLD_MS).toBe(false)
        expect(16 * 60_000 > STALE_THRESHOLD_MS).toBe(true)
    })
})

describe('translateWindowLabel — 标签跟随界面语言，不吃采集器的中文串', () => {
    // 采集器跑在 vircs，label 是硬编码中文；英文界面直接渲染它会中英混排。
    const en = (key: string, vars?: Record<string, string | number>) => {
        const table: Record<string, string> = {
            'subscription.window.fiveHour': '5-hour window',
            'subscription.window.weekly': 'Weekly window',
            'subscription.window.scopedWeekly': '{model} weekly window',
            'subscription.window.toolCalls': 'Tool call quota',
            'subscription.window.planTotal': 'Plan quota',
            'subscription.window.hours': '{n}-hour window',
            'subscription.window.accountWindow': 'Account window'
        }
        let out = table[key] ?? key
        for (const [k, v] of Object.entries(vars ?? {})) out = out.replace(`{${k}}`, String(v))
        return out
    }

    it('anthropic / glm 的静态 key 走本地化文案，忽略采集器给的中文 label', () => {
        expect(translateWindowLabel('session', '5 小时窗口', en)).toBe('5-hour window')
        expect(translateWindowLabel('five_hour', '5 小时窗口', en)).toBe('5-hour window')
        expect(translateWindowLabel('weekly_all', '周窗口', en)).toBe('Weekly window')
        expect(translateWindowLabel('tool_calls', '工具调用额度', en)).toBe('Tool call quota')
    })

    it('weekly_scoped:<model> 把模型名拼进文案并还原首字母大写', () => {
        expect(translateWindowLabel('weekly_scoped:fable', 'Fable 周窗口', en)).toBe('Fable weekly window')
    })

    it('kimi 的 duration_<minutes> 按小时渲染', () => {
        expect(translateWindowLabel('duration_300', '5 小时窗口', en)).toBe('5-hour window')
    })

    it('cx2cc 备用账号的 account_window 也走翻译', () => {
        // 备用账号只给一个 used_percent+reset，没有 primary/secondary 之分。
        // 漏加这条会让英文界面显示采集侧的中文串「账号窗口」（上线后截图发现过）。
        expect(translateWindowLabel('account_window', '账号窗口', en)).toBe('Account window')
    })

    it('未知 key 退回采集器的 label（新 provider 至少有东西可看）', () => {
        expect(translateWindowLabel('brand_new_key', '某个新窗口', en)).toBe('某个新窗口')
    })
})

describe('SubscriptionPanel 渲染', () => {
    it('渲染真实 Claude 快照的三个窗口（含 Fable）', async () => {
        mockSummary([claudeSnapshot()])
        renderPanel()
        // I18nProvider 默认英文，所以断言英文文案——这正好证明标签跟的是界面语言
        // 而不是采集器写死的中文 label。
        await waitFor(() => expect(screen.getByText('5-hour window')).toBeTruthy())
        expect(screen.getByText('Weekly window')).toBeTruthy()
        expect(screen.getByText('Fable weekly window')).toBeTruthy()
        expect(screen.getByText('11%')).toBeTruthy()
        expect(screen.getByText('81%')).toBeTruthy()
        expect(screen.getByText('100%')).toBeTruthy()
        expect(screen.getByText(/Claude Max/)).toBeTruthy()
    })

    it('余额型 provider 渲染金额与币种', async () => {
        mockSummary([{
            machine: 'vircs', provider: 'deepseek', account_key: '…5a76a834',
            plan_name: 'DeepSeek 按量', windows: [],
            balance: { amount: 57.86, currency: 'CNY', granted: 0, topped_up: 57.86 },
            error: null, reported_at: Date.now() - 30_000
        }])
        renderPanel()
        await waitFor(() => expect(screen.getByText('57.86')).toBeTruthy())
        expect(screen.getByText('CNY')).toBeTruthy()
    })

    it('采集失败的快照显示错误而不是消失', async () => {
        mockSummary([claudeSnapshot({
            error: 'HTTP 401(凭据无效或过期)', windows: [], plan_name: null
        })])
        renderPanel()
        await waitFor(() => expect(screen.getByText(/HTTP 401/)).toBeTruthy())
    })

    it('403（非 admin）时整块不渲染', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"Admin only"}', { status: 403 })))
        const { container } = renderPanel()
        await waitFor(() => expect(container.textContent).toBe(''))
    })

    it('空快照集不渲染（不留一个空卡片）', async () => {
        mockSummary([])
        const { container } = renderPanel()
        await waitFor(() => expect(container.textContent).toBe(''))
    })

    it('reset_at 按浏览器时区渲染，且与 UTC 原值不同', async () => {
        // 1786896000203 = 2026-08-16T16:00:00Z。测试环境 TZ 非 UTC 时本地时间必然不是 16:00。
        mockSummary([claudeSnapshot()])
        renderPanel()
        await waitFor(() => expect(screen.getByText('Fable weekly window')).toBeTruthy())
        const expected = formatResetTime(1786896000203)
        expect(expected).toBeTruthy()
        // 页面上至少出现一次该本地化时间串（5h 窗口那条是另一个时间）。
        expect(screen.getAllByText(expected!).length).toBeGreaterThan(0)
    })
})
