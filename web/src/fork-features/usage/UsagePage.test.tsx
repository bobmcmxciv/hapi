import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import UsagePage, {
    cacheHitRate,
    canonicalizeModelName,
    formatHitRate,
    formatTokens,
    groupUsageModels,
    localDayEndExclusiveIso,
    localDayStartIso,
} from './UsagePage'

vi.mock('@/lib/app-context', () => ({ useAppContext: () => ({ baseUrl: 'http://hub', token: 'jwt', user: { id: 1 } }) }))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))
vi.mock('./UsageTrendChart', () => ({ UsageTrendChart: () => <div data-testid="usage-trend" /> }))

afterEach(() => vi.unstubAllGlobals())

function renderPage() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(
        <QueryClientProvider client={queryClient}>
            <I18nProvider><UsagePage /></I18nProvider>
        </QueryClientProvider>
    )
}

const summaryBody = {
    models: [{
        model: 'claude-fable-5',
        requestCount: 42,
        inputTokens: 1000,
        outputTokens: 2000,
        cacheCreationInputTokens: 500,
        cacheReadInputTokens: 1_500_000
    }],
    totals: { requestCount: 42, inputTokens: 1000, outputTokens: 2000, cacheCreationInputTokens: 500, cacheReadInputTokens: 1_500_000 },
    hosts: [
        { host: 'vircs', sessionCount: 3, totalTokens: 1_503_500, requestCount: 42, owner: 'admin', platform: 'win32' },
        { host: 'peter-mac', sessionCount: 1, totalTokens: 2_000, requestCount: 4, owner: 'peter', platform: 'darwin' }
    ],
    filter: { since: null, until: null, host: null },
    generatedAt: 1
}

describe('UsagePage', () => {
    it('渲染按模型聚合的总览与机器榜', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(summaryBody), { status: 200 })))
        renderPage()

        expect((await screen.findAllByText('claude-fable-5')).length).toBeGreaterThan(0)
        // 机器榜列出服务端返回的机器，并把该机的 token 合计摆在右侧
        const vircs = screen.getByRole('button', { name: /vircs/ })
        expect(vircs.textContent).toContain('1.50M')
        // 归属分节：两个归属人各一节
        expect(screen.getAllByTestId('machine-owner-heading').map(n => n.textContent)).toEqual(['admin', 'peter'])
        // 预设时间范围与自定义（日历）按钮都在
        expect(screen.getByRole('button', { name: 'All time' })).toBeTruthy()
        expect(screen.getByRole('button', { name: /Custom/ })).toBeTruthy()
    })

    it('自定义日历范围把 since/until 带进请求', async () => {
        const calls: string[] = []
        vi.stubGlobal('fetch', vi.fn(async (url: string) => {
            calls.push(String(url))
            return new Response(JSON.stringify(summaryBody), { status: 200 })
        }))
        renderPage()
        await screen.findAllByText('claude-fable-5')

        fireEvent.click(screen.getByRole('button', { name: /Custom/ }))
        // 选本月 1 号和 2 号（日期选择器初始显示当月）
        fireEvent.click(screen.getByRole('button', { name: new Date(new Date().getFullYear(), new Date().getMonth(), 1).toLocaleDateString() }))
        fireEvent.click(screen.getByRole('button', { name: new Date(new Date().getFullYear(), new Date().getMonth(), 2).toLocaleDateString() }))

        await waitFor(() => {
            const withRange = calls.find(url => url.includes('since=') && url.includes('until='))
            expect(withRange).toBeTruthy()
        })
    })

    it('将同模型的不同后缀/渠道归并，仅对多变体模型提供展开子列表，单不重复模型直接平铺不展开', async () => {
        const bodyWithVariants = {
            ...summaryBody,
            models: [
                {
                    model: 'claude-opus-5-5',
                    requestCount: 100,
                    inputTokens: 10_000,
                    outputTokens: 20_000,
                    cacheCreationInputTokens: 0,
                    cacheReadInputTokens: 970_000,
                },
                {
                    model: 'claude-opus-5-5-high',
                    requestCount: 20,
                    inputTokens: 2_000,
                    outputTokens: 5_000,
                    cacheCreationInputTokens: 0,
                    cacheReadInputTokens: 93_000,
                },
                {
                    model: 'opus5.5',
                    requestCount: 5,
                    inputTokens: 1_000,
                    outputTokens: 2_000,
                    cacheCreationInputTokens: 0,
                    cacheReadInputTokens: 7_000,
                },
                {
                    model: 'claude-fable-5',
                    requestCount: 42,
                    inputTokens: 1_000,
                    outputTokens: 2_000,
                    cacheCreationInputTokens: 500,
                    cacheReadInputTokens: 500_000,
                },
            ],
        }
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(bodyWithVariants), { status: 200 })))
        renderPage()

        // 主模型 claude-opus-5-5 与单模型 claude-fable-5 显示在主列表
        expect((await screen.findAllByText('claude-opus-5-5')).length).toBeGreaterThan(0)
        expect(screen.getAllByText('claude-fable-5').length).toBeGreaterThan(0)

        // 默认折叠时，子变体 claude-opus-5-5-high / opus5.5 不占顶层行
        expect(screen.queryByText('claude-opus-5-5-high')).toBeNull()
        expect(screen.queryByText('opus5.5')).toBeNull()

        // 单不重复模型 claude-fable-5 没有展开按钮
        expect(screen.queryByRole('button', { name: /claude-fable-5/ })).toBeNull()

        // 点击展开 claude-opus-5-5 后显示 3 个子变体明细
        const expandButtons = screen.getAllByRole('button', { name: /Show 3 model variants for claude-opus-5-5/ })
        expect(expandButtons.length).toBeGreaterThan(0)
        fireEvent.click(expandButtons[0]!)

        expect(screen.getAllByText('claude-opus-5-5-high').length).toBeGreaterThan(0)
        expect(screen.getAllByText('opus5.5').length).toBeGreaterThan(0)
        expect(screen.getAllByTestId('model-variant-row-claude-opus-5-5')).toHaveLength(3)
    })
})

describe('canonicalizeModelName & groupUsageModels', () => {
    it('归并推理档位后缀、渠道前缀、日期快照与 Claude 命名顺序', () => {
        expect(canonicalizeModelName('opus5.5')).toBe('claude-opus-5-5')
        expect(canonicalizeModelName('opus5.5-high')).toBe('claude-opus-5-5')
        expect(canonicalizeModelName('claude-opus-5-5-medium')).toBe('claude-opus-5-5')
        expect(canonicalizeModelName('claude-opus-4.7')).toBe('claude-opus-4-7')
        expect(canonicalizeModelName('anthropic/claude-4.6-opus-20260205')).toBe('claude-opus-4-6')
        expect(canonicalizeModelName('cx2cc/gpt-6.1-sol')).toBe('gpt-6.1-sol')
        expect(canonicalizeModelName('Deepseek-v4-pro')).toBe('deepseek-v4-pro')
        expect(canonicalizeModelName('gemini-3.8-flash-tiered')).toBe('gemini-3.8-flash')
    })

    it('仅大小写不同的同名模型直接合并为单个变体（不产生多余展开项）', () => {
        const grouped = groupUsageModels([
            { model: 'deepseek-v4-pro', requestCount: 10, inputTokens: 100, outputTokens: 50, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
            { model: 'Deepseek-v4-pro', requestCount: 5, inputTokens: 20, outputTokens: 10, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
        ])
        expect(grouped).toHaveLength(1)
        expect(grouped[0]!.model).toBe('deepseek-v4-pro')
        expect(grouped[0]!.requestCount).toBe(15)
        expect(grouped[0]!.variants).toHaveLength(1)
    })
})

describe('本地日期换算', () => {
    it('start 取当天本地零点，end 为次日零点（开区间上界），跨月正确进位', () => {
        expect(new Date(localDayStartIso('2026-07-20')!).getTime()).toBe(new Date(2026, 6, 20).getTime())
        expect(new Date(localDayEndExclusiveIso('2026-07-20')!).getTime()).toBe(new Date(2026, 6, 21).getTime())
        expect(new Date(localDayEndExclusiveIso('2026-07-31')!).getTime()).toBe(new Date(2026, 7, 1).getTime())
    })
    it('非法输入返回 null', () => {
        expect(localDayStartIso('')).toBeNull()
        expect(localDayStartIso('not-a-day')).toBeNull()
    })
})

describe('cacheHitRate', () => {
    it('分母是总输入，不含 output', () => {
        // 1_500_000 / (1000 + 500 + 1_500_000)——把 output 算进分母会得到 99.77%
        expect(formatHitRate(cacheHitRate(summaryBody.totals))).toBe('99.9%')
    })

    it('没有输入侧数据时不画百分比', () => {
        expect(cacheHitRate({
            requestCount: 3, inputTokens: 0, outputTokens: 900,
            cacheCreationInputTokens: 0, cacheReadInputTokens: 0
        })).toBeNull()
        expect(formatHitRate(null)).toBe('—')
    })
})

describe('formatTokens', () => {
    it('按数量级缩写', () => {
        expect(formatTokens(999)).toBe('999')
        expect(formatTokens(1500)).toBe('1.5K')
        expect(formatTokens(2_500_000)).toBe('2.50M')
        expect(formatTokens(28_390_000_000)).toBe('28.39B')
    })
})
