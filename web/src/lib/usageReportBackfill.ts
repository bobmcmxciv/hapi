import type { DecryptedMessage } from '@/types/api'
import type { NormalizedMessage, UsageData } from '@/chat/types'

/**
 * 用 `usage_report` 帧回填逐条 assistant 页脚的 token 数。
 *
 * 背景：经 OpenAI 兼容代理（cx2cc）的模型，`message_start` 里给不出 usage，
 * 所以每条 assistant 行的 `usage` 结构性全零——MessageMetadata 的
 * "Tokens: 0 total" 就来自这里。真实计数只存在于 SDK `result` 派生的
 * `usage_report` 帧（modelUsage 按模型记**进程运行总计**）。
 *
 * 语义与 fork-features/usage/usageAggregate.ts 的帧差值口径一致：
 * - 相邻两帧的差值 = 其间那一轮的用量；帧值回落 = 进程重启，按全额计。
 * - **窗口内首帧只做基线不做归属**：历史窗口可能没加载更早的帧，把首帧
 *   全额算给某一轮会虚高（等于把窗口外的整段历史都算进来）。
 * - 两帧之间同一模型若有多个 API 轮（漏帧才会发生；Claude Code 每轮都发
 *   result），整段差值归属给最后一轮——近似，但不会重复计数。
 *
 * 归属粒度是 **API 轮**（`data.message.id`）：同一轮的多行 assistant 消息
 * 共享 message.id 与全零 usage，assistant-runtime 的 turnFingerprint 会把
 * 相邻同指纹行并成一轮；只给其中一行打数会分裂指纹、虚增轮数，所以整轮
 * 的每一行都打上相同的 delta。
 *
 * 只回填「usage 存在且全零」的行——官方来源（Claude 直连）行本身有真数，
 * 绝不触碰（替换而非叠加，与聚合层的 mergeUsageReportFallback 同原则）。
 */

type FrameNums = {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens: number
    cache_read_input_tokens: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function asNum(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** `gpt-5.6-sol[1m]` → `gpt-5.6-sol`：帧键带上下文变体后缀，assistant 行是裸名。 */
function canonicalModelName(model: string): string {
    return model.replace(/\s*\[[^\]]*\]\s*$/, '')
}

function agentOutputData(message: DecryptedMessage): Record<string, unknown> | null {
    const envelope = message.content as unknown
    if (!isRecord(envelope) || envelope.role !== 'agent') return null
    const content = envelope.content
    if (!isRecord(content) || content.type !== 'output') return null
    return isRecord(content.data) ? content.data : null
}

function zeroUsage(usage: Record<string, unknown>): boolean {
    return asNum(usage.input_tokens) === 0
        && asNum(usage.output_tokens) === 0
        && asNum(usage.cache_creation_input_tokens) === 0
        && asNum(usage.cache_read_input_tokens) === 0
}

/** 按窗口内的帧序列计算逐轮 delta，返回 hub 消息 id → 应回填的 usage。 */
export function computeUsageReportBackfill(raw: readonly DecryptedMessage[]): Map<string, UsageData> {
    const patch = new Map<string, UsageData>()
    const prevByModel = new Map<string, FrameNums>()
    // 每个 canonical model 自上一帧以来的最后一个全零 API 轮：该轮全部行的 hub 消息 id
    const pendingTurn = new Map<string, { apiMessageId: string; rawIds: string[] }>()

    for (const message of raw) {
        const data = agentOutputData(message)
        if (!data) continue

        if (data.type === 'assistant') {
            const inner = isRecord(data.message) ? data.message : null
            const usage = inner && isRecord(inner.usage) ? inner.usage : null
            const model = inner && typeof inner.model === 'string' ? inner.model : null
            const apiMessageId = inner && typeof inner.id === 'string' ? inner.id : null
            if (!usage || !model || !apiMessageId || model === '<synthetic>') continue
            if (!zeroUsage(usage)) continue
            const key = canonicalModelName(model)
            const pending = pendingTurn.get(key)
            if (pending && pending.apiMessageId === apiMessageId) {
                pending.rawIds.push(message.id)
            } else {
                pendingTurn.set(key, { apiMessageId, rawIds: [message.id] })
            }
            continue
        }

        if (data.type === 'usage_report') {
            const modelUsage = isRecord(data.modelUsage) ? data.modelUsage : null
            if (!modelUsage) continue
            for (const [frameModel, entryRaw] of Object.entries(modelUsage)) {
                const entry = isRecord(entryRaw) ? entryRaw : {}
                const nums: FrameNums = {
                    input_tokens: asNum(entry.inputTokens),
                    output_tokens: asNum(entry.outputTokens),
                    cache_creation_input_tokens: asNum(entry.cacheCreationInputTokens),
                    cache_read_input_tokens: asNum(entry.cacheReadInputTokens)
                }
                const key = canonicalModelName(frameModel)
                const prev = prevByModel.get(key)
                prevByModel.set(key, nums)
                if (!prev) {
                    // 窗口内首帧：只立基线。归属它会把窗口外历史整段算给某一轮。
                    pendingTurn.delete(key)
                    continue
                }
                const delta: FrameNums = {
                    input_tokens: nums.input_tokens < prev.input_tokens ? nums.input_tokens : nums.input_tokens - prev.input_tokens,
                    output_tokens: nums.output_tokens < prev.output_tokens ? nums.output_tokens : nums.output_tokens - prev.output_tokens,
                    cache_creation_input_tokens: nums.cache_creation_input_tokens < prev.cache_creation_input_tokens
                        ? nums.cache_creation_input_tokens : nums.cache_creation_input_tokens - prev.cache_creation_input_tokens,
                    cache_read_input_tokens: nums.cache_read_input_tokens < prev.cache_read_input_tokens
                        ? nums.cache_read_input_tokens : nums.cache_read_input_tokens - prev.cache_read_input_tokens
                }
                const turn = pendingTurn.get(key)
                pendingTurn.delete(key)
                if (!turn) continue
                if (delta.input_tokens === 0 && delta.output_tokens === 0
                    && delta.cache_creation_input_tokens === 0 && delta.cache_read_input_tokens === 0) continue
                for (const rawId of turn.rawIds) {
                    patch.set(rawId, { ...delta })
                }
            }
        }
    }

    return patch
}

/** 把回填打到归一化消息上；未涉及的消息保持原引用（不打扰下游 memo）。 */
export function applyUsageReportBackfill(
    raw: readonly DecryptedMessage[],
    normalized: readonly NormalizedMessage[]
): NormalizedMessage[] {
    const patch = computeUsageReportBackfill(raw)
    if (patch.size === 0) return normalized as NormalizedMessage[]
    return normalized.map(message => {
        const patched = patch.get(message.id)
        if (!patched || message.role !== 'agent') return message
        // 只覆盖四个 token 计数。`context_window` / `service_tier` / `cost_usd`
        // 来自 message_start，帧里根本没有——整体替换会把状态栏的上下文窗口
        // 分母连带抹掉，用户看到的就是「有用量、没窗口」。
        return { ...message, usage: { ...message.usage, ...patched } }
    })
}
