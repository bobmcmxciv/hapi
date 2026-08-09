import { isClaudeModelPreset } from '@hapi/protocol'

/**
 * Context windows vary by model/provider and may change over time.
 *
 * The UI only needs this to compute a conservative "context remaining" warning.
 * We intentionally keep a headroom budget to avoid false confidence near the limit
 * (system prompts, tool overhead, and other hidden tokens can consume extra space).
 *
 * If/when the server provides an explicit per-session context limit, prefer that
 * and use this only as a fallback.
 */
const CONTEXT_HEADROOM_TOKENS = 10_000
const DEFAULT_CLAUDE_CONTEXT_WINDOW_TOKENS = 200_000
const LARGE_CLAUDE_CONTEXT_WINDOW_TOKENS = 1_000_000
// cx2cc 的 gpt-5.6-sol 服务端契约窗口（Codex 订阅端实时元数据实测值）。
const CX2CC_SOL_CONTEXT_WINDOW_TOKENS = 272_000
// Fallback for Codex sessions when the server has not reported an explicit modelContextWindow.
// The value matches the context window currently reported by Codex App Server token-count events.
const DEFAULT_CODEX_CONTEXT_WINDOW_TOKENS = 258_400
// Pi supports multiple providers with varying context windows. 200K is a
// conservative default (most Claude/GPT-4 class models). When the server
// reports an explicit modelContextWindow via usage events, that takes
// precedence over this fallback.
const DEFAULT_PI_CONTEXT_WINDOW_TOKENS = 200_000

function parseCursorWireContextWindow(model: string): number | null {
    const match = model.match(/\[([^\]]+)\]/)
    if (!match) {
        return null
    }
    for (const segment of match[1].split(',')) {
        const part = segment.trim()
        const eq = part.indexOf('=')
        if (eq === -1 || part.slice(0, eq).trim() !== 'context') {
            continue
        }
        const raw = part.slice(eq + 1).trim().toLowerCase()
        const digits = raw.match(/(\d+)/)?.[1]
        if (!digits) {
            return null
        }
        const value = Number.parseInt(digits, 10)
        if (!Number.isFinite(value) || value <= 0) {
            return null
        }
        return raw.endsWith('k') ? value * 1000 : value
    }
    return null
}

export function getContextBudgetTokens(model: string | null | undefined, flavor?: string | null): number | null {
    if (flavor === 'codex') {
        return Math.max(1, DEFAULT_CODEX_CONTEXT_WINDOW_TOKENS - CONTEXT_HEADROOM_TOKENS)
    }

    if (flavor === 'pi') {
        return Math.max(1, DEFAULT_PI_CONTEXT_WINDOW_TOKENS - CONTEXT_HEADROOM_TOKENS)
    }

    if (flavor === 'cursor') {
        const trimmedModel = model?.trim()
        const windowTokens = trimmedModel ? parseCursorWireContextWindow(trimmedModel) : null
        if (!windowTokens) {
            return null
        }
        return Math.max(1, windowTokens - CONTEXT_HEADROOM_TOKENS)
    }

    if (flavor !== 'claude') {
        return null
    }

    const trimmedModel = model?.trim()
    const windowTokens = (() => {
        if (!trimmedModel) {
            return DEFAULT_CLAUDE_CONTEXT_WINDOW_TOKENS
        }
        // The "[1m]" suffix is a launch-time declaration, not a family marker:
        // Claude Code honours it on any model id it does not recognise, proxy
        // aliases included. Verified live against cx2cc — `--model
        // gpt-5.6-sol[1m]` comes back with
        // `result.modelUsage["gpt-5.6-sol[1m]"].contextWindow = 1_000_000`.
        // So the suffix outranks the family check below; without this, picking
        // a proxy id's 1M variant would still be metered against 200k.
        if (trimmedModel.endsWith('[1m]')) {
            return LARGE_CLAUDE_CONTEXT_WINDOW_TOKENS
        }
        if (isClaudeModelPreset(trimmedModel) || trimmedModel.startsWith('claude-')) {
            // Fable ships with a 1M window even under its bare id: the SDK
            // result message reports modelUsage["claude-fable-5"].contextWindow
            // = 1,000,000, so the "[1m]" suffix check alone would undercount
            // local-mode sessions (their transcript usage carries no
            // context_window and falls through to this heuristic).
            const isFable = trimmedModel === 'fable'
                || trimmedModel.startsWith('claude-fable')
            return isFable
                ? LARGE_CLAUDE_CONTEXT_WINDOW_TOKENS
                : DEFAULT_CLAUDE_CONTEXT_WINDOW_TOKENS
        }
        // 已实锤契约的代理别名直接给真值：`gpt-5.6-sol` 服务端契约 272k
        // （/backend-api/codex/models 实时元数据 context_window=max=272000，
        // 2026-08-10 实测，见记忆 cx2cc-honest-context-window）。terra/luna
        // 未单独实测，不写进来——宁可落 200k 保守值也不外推。
        if (trimmedModel === 'gpt-5.6-sol') {
            return CX2CC_SOL_CONTEXT_WINDOW_TOKENS
        }
        // 模型 id 不是已知的 Claude 形态——典型是经 OpenAI 兼容代理
        // （cx2cc）跑的会话：assistant 行的 model 是代理自己的别名
        // （如 `gpt-5.6-sol`），底层仍然是 Claude Code SDK 在跑。此前这里
        // 返回 null，状态栏就完全没有分母，只剩「167K used」——上下文窗口
        // 直接消失。空 model 的分支早就退回默认窗口了，别名不该比空值更差。
        //
        // 退回保守的 200k 下限（不是 1M）：显式 context_window 存在时根本
        // 走不到这里（那条路优先），走到这里说明毫无窗口信号，此时宁可高估
        // 使用率也不要给出「还很空」的假安全感。实测佐证：某 cx2cc 会话在
        // 上下文 167,410 tokens 时触发了 Claude Code 自动压缩
        // （compact_boundary preTokens=167,277），正是 200k 窗口的行为。
        return DEFAULT_CLAUDE_CONTEXT_WINDOW_TOKENS
    })()

    if (!windowTokens) return null
    return Math.max(1, windowTokens - CONTEXT_HEADROOM_TOKENS)
}
