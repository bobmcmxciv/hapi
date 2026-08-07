import type { Database } from 'bun:sqlite'
import { decodeMessageContent } from '../../hub/src/store/contentCodec'

export type UsageAggregateRow = {
    model: string
    requestCount: number
    inputTokens: number
    outputTokens: number
    cacheCreationInputTokens: number
    cacheReadInputTokens: number
}

export type UsageModelSummary = UsageAggregateRow

export type UsageSummaryResponse = {
    models: UsageModelSummary[]
    totals: Omit<UsageModelSummary, 'model'>
    /** 该 namespace 下可筛选的机器 host 列表（用于前端下拉）。 */
    hosts: string[]
    /** 本次统计实际生效的筛选条件，回显给前端确认。 */
    filter: { since: string | null; until: string | null; host: string | null }
    generatedAt: number
}

/** 接受 ISO-8601 字符串或毫秒时间戳，规整成 UTC ISO 串，
 *  用于和库里 content.data.timestamp 做字典序比较。非法输入返回 null（= 不筛选）。 */
export function parseIsoParam(raw: string | undefined): string | null {
    if (!raw) return null
    const trimmed = raw.trim()
    if (!trimmed) return null
    const date = /^\d+$/.test(trimmed) ? new Date(Number(trimmed)) : new Date(trimmed)
    if (Number.isNaN(date.getTime())) return null
    return date.toISOString()
}

function modelTotal(m: Omit<UsageModelSummary, 'model'>): number {
    return m.inputTokens + m.outputTokens + m.cacheCreationInputTokens + m.cacheReadInputTokens
}

export function buildUsageSummaryResponse(
    rows: UsageAggregateRow[],
    hosts: string[],
    filter: { since: string | null; until: string | null; host: string | null },
    generatedAt: number
): UsageSummaryResponse {
    const models = [...rows].sort((a, b) => modelTotal(b) - modelTotal(a))
    const totals = models.reduce(
        (acc, m) => {
            acc.requestCount += m.requestCount
            acc.inputTokens += m.inputTokens
            acc.outputTokens += m.outputTokens
            acc.cacheCreationInputTokens += m.cacheCreationInputTokens
            acc.cacheReadInputTokens += m.cacheReadInputTokens
            return acc
        },
        { requestCount: 0, inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }
    )
    return { models, totals, hosts, filter, generatedAt }
}

/** Per-model token usage for a set of sessions (visibility resolved by the
 *  caller), aggregated entirely in SQLite.
 *
 *  **De-duplication is load bearing.** Claude Code writes one JSONL line per
 *  content block, and every line of the same API turn repeats that turn's full
 *  `usage` object — verified on the live hub DB: 150,180 usage-bearing rows map to
 *  only 69,935 distinct `message.id`s, and all rows sharing an id carry byte-identical
 *  usage numbers. Summing rows instead of turns inflates every figure ~2.15x, so the
 *  inner query collapses to DISTINCT (message.id, model, usage…) before aggregating.
 *
 *  Time filtering uses `content.data.timestamp` (the moment the turn actually
 *  happened, present on 100% of usage rows) rather than the `created_at` column,
 *  which for imported sessions records the import time instead. The values are
 *  UTC ISO-8601 strings, so lexicographic comparison is chronological.
 *
 *  `<synthetic>` is Claude Code's locally fabricated placeholder assistant
 *  message (no real API turn, no token counts) — excluded outright. */
export function aggregateUsageForSessions(
    db: Database,
    sessionIds: string[],
    opts?: { sinceIso?: string | null; untilIso?: string | null }
): UsageAggregateRow[] {
    if (sessionIds.length === 0) {
        return []
    }

    // contentCodec (schema V16) 之后 messages.content 可能是 zstd BLOB，
    // json_extract / LIKE 都无法在 SQL 侧使用；改为整段取出 → 解码 → JS 聚合。
    // 统计页低频调用，扫描一次可见会话的全部行是可接受的成本。
    const placeholders = sessionIds.map(() => '?').join(',')
    const rows = db.prepare(`
        SELECT session_id AS sessionId, seq, content
        FROM messages
        WHERE session_id IN (${placeholders})
        ORDER BY session_id, seq
    `).all(...sessionIds) as Array<{ sessionId: string; seq: number; content: string | Uint8Array }>

    const sinceIso = opts?.sinceIso ?? null
    const untilIso = opts?.untilIso ?? null
    const inWindow = (ts: unknown): boolean => {
        if (typeof ts !== 'string' || !ts) return false
        if (sinceIso && ts < sinceIso) return false
        if (untilIso && ts >= untilIso) return false
        return true
    }

    // —— assistant 行（官方口径）：按 message.id+model 去重后求和 ——
    const seenTurn = new Set<string>()
    const assistantAgg = new Map<string, UsageAggregateRow>()
    // —— usage_report 帧：先按 (session, model) 全程算差值，再按时间窗过滤 ——
    type FrameNums = { inputTokens: number; outputTokens: number; cacheCreationInputTokens: number; cacheReadInputTokens: number }
    const prevFrame = new Map<string, FrameNums>()
    const frameAgg = new Map<string, FrameNums>()

    for (const row of rows) {
        let content: unknown
        try {
            content = decodeMessageContent(row.content as never)
        } catch {
            continue
        }
        if (!content || typeof content !== 'object') continue
        const record = content as Record<string, unknown>
        if (record.role !== 'agent') continue
        const outer = record.content as Record<string, unknown> | undefined
        if (!outer || outer.type !== 'output') continue
        const data = outer.data as Record<string, unknown> | undefined
        if (!data) continue

        if (data.type === 'assistant') {
            const message = data.message as Record<string, unknown> | undefined
            const messageId = message?.id
            const model = message?.model
            if (typeof messageId !== 'string' || typeof model !== 'string' || model === '<synthetic>') continue
            const usage = message?.usage as Record<string, unknown> | undefined
            if (!usage) continue
            if (!inWindow(data.timestamp)) continue
            // Claude Code 同一 API 轮写多行、usage 逐行重复（实测 150,180 行только
            // 69,935 个 distinct message.id），必须按轮去重否则整体虚高 ~2.15x。
            const turnKey = `${messageId}::${model}`
            if (seenTurn.has(turnKey)) continue
            seenTurn.add(turnKey)
            const agg = assistantAgg.get(model) ?? {
                model, requestCount: 0, inputTokens: 0, outputTokens: 0,
                cacheCreationInputTokens: 0, cacheReadInputTokens: 0
            }
            agg.requestCount += 1
            agg.inputTokens += Number(usage.input_tokens) || 0
            agg.outputTokens += Number(usage.output_tokens) || 0
            agg.cacheCreationInputTokens += Number(usage.cache_creation_input_tokens) || 0
            agg.cacheReadInputTokens += Number(usage.cache_read_input_tokens) || 0
            assistantAgg.set(model, agg)
            continue
        }

        if (data.type === 'usage_report') {
            const modelUsage = data.modelUsage as Record<string, unknown> | undefined
            if (!modelUsage) continue
            for (const [model, entryRaw] of Object.entries(modelUsage)) {
                const entry = (entryRaw ?? {}) as Record<string, unknown>
                const nums: FrameNums = {
                    inputTokens: Number(entry.inputTokens) || 0,
                    outputTokens: Number(entry.outputTokens) || 0,
                    cacheCreationInputTokens: Number(entry.cacheCreationInputTokens) || 0,
                    cacheReadInputTokens: Number(entry.cacheReadInputTokens) || 0
                }
                const key = `${row.sessionId}::${model}`
                const prev = prevFrame.get(key)
                prevFrame.set(key, nums)
                // modelUsage 是常驻进程运行总计：帧对前一帧取差值；回落=进程重启按全额。
                const delta: FrameNums = prev ? {
                    inputTokens: nums.inputTokens < prev.inputTokens ? nums.inputTokens : nums.inputTokens - prev.inputTokens,
                    outputTokens: nums.outputTokens < prev.outputTokens ? nums.outputTokens : nums.outputTokens - prev.outputTokens,
                    cacheCreationInputTokens: nums.cacheCreationInputTokens < prev.cacheCreationInputTokens ? nums.cacheCreationInputTokens : nums.cacheCreationInputTokens - prev.cacheCreationInputTokens,
                    cacheReadInputTokens: nums.cacheReadInputTokens < prev.cacheReadInputTokens ? nums.cacheReadInputTokens : nums.cacheReadInputTokens - prev.cacheReadInputTokens
                } : nums
                // 时间窗在差值之后过滤：先窗后差会让窗内首帧把整段运行总计算进来。
                if (!inWindow(data.timestamp)) continue
                const agg = frameAgg.get(model) ?? {
                    inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0
                }
                agg.inputTokens += delta.inputTokens
                agg.outputTokens += delta.outputTokens
                agg.cacheCreationInputTokens += delta.cacheCreationInputTokens
                agg.cacheReadInputTokens += delta.cacheReadInputTokens
                frameAgg.set(model, agg)
            }
        }
    }

    return mergeUsageReportFallback([...assistantAgg.values()], frameAgg)
}

/** Strip a trailing context-window variant suffix: `gpt-5.6-sol[1m]` → `gpt-5.6-sol`.
 *
 *  The two sources name the same model differently. `assistant` rows carry
 *  `message.model`, which is always the bare id, while `result.modelUsage` is
 *  keyed by the full id including the variant tag. Matching the raw strings makes
 *  a 1M-context session miss its fallback entirely: the bare row keeps its zeros
 *  and the real tokens land in a separate `…[1m]` row with requestCount 0, so the
 *  same model shows up twice — once with requests and no tokens, once with tokens
 *  and no requests. Observed live on a Mac session: assistant said `gpt-5.6-sol`
 *  (0 tokens) while the frames said `gpt-5.6-sol[1m]` (227,938 input). */
function canonicalModelName(model: string): string {
    return model.replace(/\s*\[[^\]]*\]\s*$/, '')
}

/** Per canonical model, report the larger of the two sources — never their sum.
 *
 *  **Winner-take-all, never add.** Every session emits `result`, so a Claude
 *  model has both sources populated with (near-)identical numbers, and summing
 *  them would double every official-source figure. Taking the per-model max
 *  keeps that safe (equal totals leave the assistant side untouched) while
 *  repairing the models the assistant side undercounts.
 *
 *  The previous rule substituted only when the assistant side was *entirely*
 *  zero. That gate breaks on proxied models: cx2cc-style streams record zero
 *  usage on every streamed turn, but the occasional non-stream turn carries
 *  real usage — observed live on the hub: 8,090 `gpt-5.6-sol` turns totalling
 *  702k tokens on the assistant side while the frames held 134M. The 702k
 *  trickle made `hasTokens` true and the 134M fallback was dropped on the
 *  floor. Comparing totals instead of testing for zero fixes exactly that
 *  case, and only ever moves a model's figure *up* to the better source.
 *
 *  Both sides collapse to the canonical (variant-stripped) name before the
 *  comparison, so every `…[1m]` variant's usage is absorbed into one row.
 *
 *  `requestCount` always stays with the assistant side: it counts API turns,
 *  and a `usage_report` frame is emitted per *turn*, which is the coarser
 *  unit. A model seen only in `usage_report` still gets a row under its
 *  canonical name, with requestCount 0 — unless it carries no tokens at all,
 *  in which case it is dropped rather than rendered as an all-zero phantom
 *  row on the usage page. */
export function mergeUsageReportFallback(
    assistantRows: UsageAggregateRow[],
    reportTotals: Map<string, Omit<UsageAggregateRow, 'model' | 'requestCount'>>
): UsageAggregateRow[] {
    type Nums = Omit<UsageAggregateRow, 'model' | 'requestCount'>
    const total = (n: Nums): number =>
        n.inputTokens + n.outputTokens + n.cacheCreationInputTokens + n.cacheReadInputTokens
    const add = (a: Nums, b: Nums): Nums => ({
        inputTokens: a.inputTokens + b.inputTokens,
        outputTokens: a.outputTokens + b.outputTokens,
        cacheCreationInputTokens: a.cacheCreationInputTokens + b.cacheCreationInputTokens,
        cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens
    })

    const frameByCanonical = new Map<string, Nums>()
    for (const [model, totals] of reportTotals) {
        const key = canonicalModelName(model)
        const acc = frameByCanonical.get(key)
        frameByCanonical.set(key, acc ? add(acc, totals) : { ...totals })
    }

    // message.model is documented bare, so this collapse is a no-op in
    // practice; it keeps the source comparison well-defined if a
    // variant-suffixed name ever slips into an assistant row.
    const assistantByCanonical = new Map<string, UsageAggregateRow>()
    for (const row of assistantRows) {
        const key = canonicalModelName(row.model)
        const acc = assistantByCanonical.get(key)
        assistantByCanonical.set(key, acc
            ? { model: key, requestCount: acc.requestCount + row.requestCount, ...add(acc, row) }
            : { ...row, model: key })
    }

    const merged: UsageAggregateRow[] = []
    for (const [key, row] of assistantByCanonical) {
        const frames = frameByCanonical.get(key)
        merged.push(frames && total(frames) > total(row) ? { ...row, ...frames } : row)
    }

    for (const [model, totals] of frameByCanonical) {
        if (assistantByCanonical.has(model)) continue
        if (total(totals) === 0) continue
        merged.push({ model, requestCount: 0, ...totals })
    }
    return merged
}
