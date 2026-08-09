import { describe, expect, it } from 'vitest'
import { getContextBudgetTokens } from './modelConfig'

describe('getContextBudgetTokens', () => {
    it('uses the large budget only for explicit 1m Claude presets', () => {
        expect(getContextBudgetTokens('sonnet[1m]', 'claude')).toBe(990_000)
    })

    it('uses the default Claude budget for full Claude model names', () => {
        expect(getContextBudgetTokens('claude-sonnet-4-6', 'claude')).toBe(190_000)
    })

    it('uses the large budget for a full Claude model name carrying a [1m] suffix', () => {
        expect(getContextBudgetTokens('claude-opus-4-8[1m]', 'claude')).toBe(990_000)
    })

    it('uses the large budget for Fable even under its bare id (1M window)', () => {
        expect(getContextBudgetTokens('claude-fable-5', 'claude')).toBe(990_000)
        expect(getContextBudgetTokens('fable', 'claude')).toBe(990_000)
        expect(getContextBudgetTokens('fable[1m]', 'claude')).toBe(990_000)
    })

    it('uses Codex app-server context window with headroom', () => {
        expect(getContextBudgetTokens('gpt-5.4', 'codex')).toBe(248_400)
    })

    it('parses context budget from Cursor wire ids', () => {
        expect(getContextBudgetTokens('composer-2.5-fast[context=300k]', 'cursor')).toBe(290_000)
    })

    it('returns null for unknown non-Claude sessions', () => {
        expect(getContextBudgetTokens('gemini-3-pro', 'gemini')).toBeNull()
    })

    // cx2cc：assistant 行的 model 是代理别名，底层仍是 Claude Code SDK。
    // 这类会话此前拿不到分母，状态栏的上下文窗口整个消失。
    it('falls back to the conservative Claude budget for proxy model aliases', () => {
        expect(getContextBudgetTokens('gpt-5.6-terra', 'claude')).toBe(190_000)
    })

    // 带 [1m] 的代理别名不是「无信号」——那是启动时的显式声明，且 Claude Code
    // 对不认识的 model id 同样认这个后缀（实测 cx2cc：--model gpt-5.6-sol[1m]
    // 的 result.modelUsage["gpt-5.6-sol[1m]"].contextWindow = 1_000_000）。
    it('honours the [1m] suffix on proxy model aliases', () => {
        expect(getContextBudgetTokens('gpt-5.6-sol[1m]', 'claude')).toBe(990_000)
    })

    it('cx2cc 裸名 gpt-5.6-sol 按服务端契约 272k 计（272,000 - 10,000 headroom）', () => {
        expect(getContextBudgetTokens('gpt-5.6-sol', 'claude')).toBe(262_000)
    })

    it('keeps the no-model fallback identical to the alias fallback', () => {
        expect(getContextBudgetTokens(null, 'claude')).toBe(190_000)
        expect(getContextBudgetTokens('', 'claude')).toBe(190_000)
        expect(getContextBudgetTokens('   ', 'claude')).toBe(190_000)
    })
})
