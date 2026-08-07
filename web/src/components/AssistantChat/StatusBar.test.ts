import { describe, expect, it } from 'vitest'
import { getContextBudgetTokens } from '@/chat/modelConfig'
import {
    formatCompactContextUsageLabel,
    formatContextUsageLabel,
    getContextUsageDetails,
    shouldShowCodexFastBadge
} from './StatusBar'

describe('context usage labels', () => {
    it('keeps the desktop label compact and expresses used capacity', () => {
        expect(formatContextUsageLabel(90_000, 258_000)).toBe('35% · 90k / 258k')
    })

    it('uses the compact parenthesized mobile label with a fixed English suffix', () => {
        expect(formatCompactContextUsageLabel(186_000, 262_000)).toBe('ctx 262k (29% left)')
    })

    it('orders cache, used, and remaining metrics for the desktop details', () => {
        expect(getContextUsageDetails(90_000, 258_000, 86_000)).toEqual({
            cacheRead: '86k',
            used: '90k',
            usedPercentage: 35,
            remaining: '168k',
            remainingPercentage: 65
        })
    })

    it('keeps external and detailed percentages complementary at rounding midpoints', () => {
        expect(formatContextUsageLabel(69, 200)).toBe('35% · 69 / 200')
        expect(formatCompactContextUsageLabel(69, 200)).toBe('ctx 200 (65% left)')
        expect(getContextUsageDetails(69, 200, 0)).toMatchObject({
            usedPercentage: 35,
            remainingPercentage: 65
        })
    })

    /**
     * cx2cc 经代理的会话回归：assistant 行的 model 是代理别名，usage 里没有
     * context_window。此前分母解析成 null，标签退化成「167k used」——上下文
     * 窗口在状态栏彻底消失。
     *
     * 数字取自线上真实会话（host FA608_INDEX）：最后一条 assistant
     * input=84,722 + cache_read=82,688 + cache_creation=0 = 167,410，
     * 同会话 compact_boundary 的 preTokens=167,277 佐证该分子正确、
     * 且该会话确实是 200k 窗口（Claude Code 在此触发了自动压缩）。
     */
    it('经代理别名的 claude 会话仍然给出上下文窗口分母', () => {
        const contextSize = 84_722 + 82_688
        const budget = getContextBudgetTokens('gpt-5.6-sol', 'claude')

        expect(budget).toBe(190_000)
        expect(formatContextUsageLabel(contextSize, budget)).toBe('88% · 167k / 190k')
        expect(formatContextUsageLabel(contextSize, budget)).not.toContain('used')
    })
})

describe('shouldShowCodexFastBadge', () => {
    it('uses only the effective service tier', () => {
        expect(shouldShowCodexFastBadge('codex', undefined)).toBe(false)
        expect(shouldShowCodexFastBadge('codex', 'standard')).toBe(false)
        expect(shouldShowCodexFastBadge('codex', 'fast')).toBe(true)
        expect(shouldShowCodexFastBadge('codex', 'priority')).toBe(true)
        expect(shouldShowCodexFastBadge('claude', 'fast')).toBe(false)
    })
})
