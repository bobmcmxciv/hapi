import type { Database } from 'bun:sqlite'

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

    const params: string[] = [...sessionIds]
    let timeClause = ''
    if (opts?.sinceIso) {
        timeClause += ` AND json_extract(content, '$.content.data.timestamp') >= ?`
        params.push(opts.sinceIso)
    }
    if (opts?.untilIso) {
        timeClause += ` AND json_extract(content, '$.content.data.timestamp') < ?`
        params.push(opts.untilIso)
    }

    const placeholders = sessionIds.map(() => '?').join(',')
    const rows = db.prepare(`
        SELECT
            model,
            COUNT(*) AS requestCount,
            COALESCE(SUM(inputTokens), 0) AS inputTokens,
            COALESCE(SUM(outputTokens), 0) AS outputTokens,
            COALESCE(SUM(cacheCreationInputTokens), 0) AS cacheCreationInputTokens,
            COALESCE(SUM(cacheReadInputTokens), 0) AS cacheReadInputTokens
        FROM (
            SELECT DISTINCT
                json_extract(content, '$.content.data.message.id') AS messageId,
                json_extract(content, '$.content.data.message.model') AS model,
                COALESCE(json_extract(content, '$.content.data.message.usage.input_tokens'), 0) AS inputTokens,
                COALESCE(json_extract(content, '$.content.data.message.usage.output_tokens'), 0) AS outputTokens,
                COALESCE(json_extract(content, '$.content.data.message.usage.cache_creation_input_tokens'), 0) AS cacheCreationInputTokens,
                COALESCE(json_extract(content, '$.content.data.message.usage.cache_read_input_tokens'), 0) AS cacheReadInputTokens
            FROM messages
            WHERE session_id IN (${placeholders})
              AND content LIKE '%"usage"%'
              AND json_extract(content, '$.role') = 'agent'
              AND json_extract(content, '$.content.type') = 'output'
              AND json_extract(content, '$.content.data.type') = 'assistant'
              AND json_extract(content, '$.content.data.message.id') IS NOT NULL
              AND json_extract(content, '$.content.data.message.model') IS NOT NULL
              AND json_extract(content, '$.content.data.message.model') != '<synthetic>'
              ${timeClause}
        )
        GROUP BY model
    `).all(...params) as UsageAggregateRow[]

    return mergeUsageReportFallback(rows, queryUsageReportTotals(db, sessionIds, opts))
}

/** Per-model token totals recovered from `usage_report` frames.
 *
 *  These come from the SDK `result` message (see sdkToLogConverter), which is the
 *  only place token counts appear for an upstream that cannot populate
 *  `message_start` — an OpenAI-compatible proxy learns the counts only when the
 *  upstream stream ends, so its `assistant` messages all carry usage 0.
 *
 *  **`modelUsage` is a running total, not a per-turn figure.** The SDK session is
 *  one long-lived agent process, and its `result` message reports everything that
 *  process has spent so far. Measured on a live 3-turn gpt-5.6-sol session:
 *
 *      seq=4  input=55931   output=5
 *      seq=8  input=111945  output=10
 *      seq=12 input=168046  output=15
 *
 *  Summing frames would report 335,922 for a session that actually consumed
 *  168,046 — an (n+1)/2 inflation that grows with turn count. So each frame
 *  contributes only its *delta* over the previous frame of the same session and
 *  model. A frame lower than its predecessor means the counter restarted (the
 *  session was resumed into a fresh process), so it contributes its full value.
 *
 *  Deltas are computed across every frame of the session and only then filtered
 *  by time: windowing the frames first would make the earliest surviving frame
 *  contribute its whole running total, re-inflating any window that starts
 *  mid-session. */
function queryUsageReportTotals(
    db: Database,
    sessionIds: string[],
    opts?: { sinceIso?: string | null; untilIso?: string | null }
): Map<string, Omit<UsageAggregateRow, 'model' | 'requestCount'>> {
    const params: string[] = [...sessionIds]
    let timeClause = ''
    if (opts?.sinceIso) {
        timeClause += ` AND ts >= ?`
        params.push(opts.sinceIso)
    }
    if (opts?.untilIso) {
        timeClause += ` AND ts < ?`
        params.push(opts.untilIso)
    }

    // —— 两侧都按会话分桶后再结算：帧与 assistant 行只有在同一会话内才描述
    //    同一批 API 轮，跨会话取 max 会把无关流量混在一起（见 settleSessionUsage）。
    const seenTurn = new Set<string>()
    const assistantBySession = new Map<string, Map<string, UsageAggregateRow>>()
    // —— usage_report 帧：先按 (session, model) 全程算差值，再按时间窗过滤 ——
    type FrameNums = { inputTokens: number; outputTokens: number; cacheCreationInputTokens: number; cacheReadInputTokens: number }
    const prevFrame = new Map<string, FrameNums>()
    const frameBySession = new Map<string, Map<string, FrameNums>>()
    const bucket = <T>(store: Map<string, Map<string, T>>, sessionId: string): Map<string, T> => {
        let inner = store.get(sessionId)
        if (!inner) { inner = new Map<string, T>(); store.set(sessionId, inner) }
        return inner
    }

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
            const perSession = bucket(assistantBySession, row.sessionId)
            const agg = perSession.get(model) ?? {
                model, requestCount: 0, inputTokens: 0, outputTokens: 0,
                cacheCreationInputTokens: 0, cacheReadInputTokens: 0
            }
            agg.requestCount += 1
            agg.inputTokens += Number(usage.input_tokens) || 0
            agg.outputTokens += Number(usage.output_tokens) || 0
            agg.cacheCreationInputTokens += Number(usage.cache_creation_input_tokens) || 0
            agg.cacheReadInputTokens += Number(usage.cache_read_input_tokens) || 0
            perSession.set(model, agg)
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
                const perSession = bucket(frameBySession, row.sessionId)
                const agg = perSession.get(model) ?? {
                    inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0
                }
                agg.inputTokens += delta.inputTokens
                agg.outputTokens += delta.outputTokens
                agg.cacheCreationInputTokens += delta.cacheCreationInputTokens
                agg.cacheReadInputTokens += delta.cacheReadInputTokens
                perSession.set(model, agg)
            }
        }
    }

    const settled: UsageAggregateRow[][] = []
    for (const sessionId of new Set([...assistantBySession.keys(), ...frameBySession.keys()])) {
        settled.push(settleSessionUsage(
            [...(assistantBySession.get(sessionId)?.values() ?? [])],
            frameBySession.get(sessionId) ?? new Map()
        ))
    }
    return combineSessionUsage(settled)
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

type UsageNums = Omit<UsageAggregateRow, 'model' | 'requestCount'>

const usageTotal = (n: UsageNums): number =>
    n.inputTokens + n.outputTokens + n.cacheCreationInputTokens + n.cacheReadInputTokens

const addUsage = (a: UsageNums, b: UsageNums): UsageNums => ({
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheCreationInputTokens: a.cacheCreationInputTokens + b.cacheCreationInputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens
})

function collapseToCanonical<T extends UsageNums>(
    source: Iterable<[string, T]>
): Map<string, UsageNums> {
    const out = new Map<string, UsageNums>()
    for (const [model, nums] of source) {
        const key = canonicalModelName(model)
        const acc = out.get(key)
        out.set(key, acc ? addUsage(acc, nums) : { ...nums })
    }
    return out
}

/** Settle one session's two usage sources into per-model rows.
 *
 *  **Two views of the same turns, so never add — and the comparison only holds
 *  inside a session.** Both `assistant` rows and `usage_report` frames describe
 *  the same API turns of the same session, so summing them doubles any session
 *  where both are populated. The previous implementation took that max
 *  *globally*, across every session at once, which silently mixed unrelated
 *  traffic: measured on the live hub, `claude-opus-4-8` had 3.37B assistant
 *  tokens from direct sessions and 709M frame tokens that came **entirely**
 *  from proxied (`gpt-5.6-sol`) sessions. The global max kept 3.37B and threw
 *  the 709M away — 709M real tokens that appeared under no row at all. The
 *  mirror-image failure also occurred: `claude-sonnet-4-6` showed 119M of
 *  which 98.4% was proxied traffic that had drowned out the real direct usage.
 *  Settling per session keeps each comparison between numbers that genuinely
 *  describe the same turns.
 *
 *  **Frame keys are re-homed onto the session's own model when they cannot be
 *  reconciled.** An OpenAI-compatible proxy reports its own alias on
 *  `message.model` (`gpt-5.6-sol`) while `result.modelUsage` is keyed by the
 *  Claude model actually serving it (`claude-opus-4-8[1m]`). The frames are
 *  that session's real numbers, but filing them under the Claude name both
 *  hides them from the model the user actually selected and pollutes a row
 *  that otherwise means "direct Claude usage". When a session's frame keys
 *  share nothing with its assistant models, every frame is therefore re-homed
 *  onto the session's primary assistant model — including subagent entries
 *  (haiku), which the user never chose separately and which belong to the
 *  proxied session's budget. Sessions whose keys *do* intersect (every direct
 *  Claude session) keep their frame keys untouched, so a Task subagent still
 *  gets its own row exactly as before.
 *
 *  `requestCount` always stays with the assistant side: it counts API turns,
 *  and a `usage_report` frame is emitted per *turn*, which is the coarser
 *  unit. A model seen only in `usage_report` still gets a row under its
 *  canonical name, with requestCount 0 — unless it carries no tokens at all,
 *  in which case it is dropped rather than rendered as an all-zero phantom
 *  row on the usage page. */
export function settleSessionUsage(
    assistantRows: UsageAggregateRow[],
    reportTotals: Map<string, UsageNums>
): UsageAggregateRow[] {
    const assistantByCanonical = new Map<string, UsageAggregateRow>()
    for (const row of assistantRows) {
        const key = canonicalModelName(row.model)
        const acc = assistantByCanonical.get(key)
        assistantByCanonical.set(key, acc
            ? { model: key, requestCount: acc.requestCount + row.requestCount, ...addUsage(acc, row) }
            : { ...row, model: key })
    }

    let frameByCanonical = collapseToCanonical(reportTotals)

    // 代理会话判定：帧的模型名与本会话 assistant 的模型名毫无交集。
    // 直连会话至少主模型两边同名，绝不会命中这条。
    const disjoint = assistantByCanonical.size > 0
        && frameByCanonical.size > 0
        && ![...frameByCanonical.keys()].some(key => assistantByCanonical.has(key))
    if (disjoint) {
        // 主模型 = assistant 侧请求数最多的那个（并列时取 token 更多者），
        // 保证同一份数据每次得到同一个归属。
        let primary: UsageAggregateRow | null = null
        for (const row of assistantByCanonical.values()) {
            if (!primary
                || row.requestCount > primary.requestCount
                || (row.requestCount === primary.requestCount && usageTotal(row) > usageTotal(primary))) {
                primary = row
            }
        }
        if (primary) {
            const folded = [...frameByCanonical.values()].reduce(addUsage, {
                inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0
            })
            frameByCanonical = new Map([[primary.model, folded]])
        }
    }

    const merged: UsageAggregateRow[] = []
    for (const [key, row] of assistantByCanonical) {
        const frames = frameByCanonical.get(key)
        merged.push(frames && usageTotal(frames) > usageTotal(row) ? { ...row, ...frames } : row)
    }

    for (const [model, totals] of frameByCanonical) {
        if (assistantByCanonical.has(model)) continue
        if (usageTotal(totals) === 0) continue
        merged.push({ model, requestCount: 0, ...totals })
    }
    return merged
}

/** Sum per-session settled rows into the final per-model table. */
export function combineSessionUsage(perSession: Iterable<UsageAggregateRow[]>): UsageAggregateRow[] {
    const out = new Map<string, UsageAggregateRow>()
    for (const rows of perSession) {
        for (const row of rows) {
            const acc = out.get(row.model)
            out.set(row.model, acc
                ? { model: row.model, requestCount: acc.requestCount + row.requestCount, ...addUsage(acc, row) }
                : { ...row })
        }
    }
    return [...out.values()]
}
