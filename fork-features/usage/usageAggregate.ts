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

    const placeholders = sessionIds.map(() => '?').join(',')
    const rows = db.prepare(`
        WITH frames AS (
            SELECT
                messages.session_id AS sessionId,
                messages.seq AS seq,
                json_extract(messages.content, '$.content.data.timestamp') AS ts,
                usage_entry.key AS model,
                COALESCE(json_extract(usage_entry.value, '$.inputTokens'), 0) AS inputTokens,
                COALESCE(json_extract(usage_entry.value, '$.outputTokens'), 0) AS outputTokens,
                COALESCE(json_extract(usage_entry.value, '$.cacheCreationInputTokens'), 0) AS cacheCreationInputTokens,
                COALESCE(json_extract(usage_entry.value, '$.cacheReadInputTokens'), 0) AS cacheReadInputTokens
            FROM messages,
                 json_each(json_extract(messages.content, '$.content.data.modelUsage')) AS usage_entry
            WHERE messages.session_id IN (${placeholders})
              AND json_extract(messages.content, '$.role') = 'agent'
              AND json_extract(messages.content, '$.content.type') = 'output'
              AND json_extract(messages.content, '$.content.data.type') = 'usage_report'
        ),
        lagged AS (
            SELECT
                model, ts,
                inputTokens, outputTokens, cacheCreationInputTokens, cacheReadInputTokens,
                LAG(inputTokens) OVER w AS prevInput,
                LAG(outputTokens) OVER w AS prevOutput,
                LAG(cacheCreationInputTokens) OVER w AS prevCacheCreation,
                LAG(cacheReadInputTokens) OVER w AS prevCacheRead
            FROM frames
            WINDOW w AS (PARTITION BY sessionId, model ORDER BY seq)
        )
        SELECT
            model,
            COALESCE(SUM(CASE WHEN prevInput IS NULL OR inputTokens < prevInput
                              THEN inputTokens ELSE inputTokens - prevInput END), 0) AS inputTokens,
            COALESCE(SUM(CASE WHEN prevOutput IS NULL OR outputTokens < prevOutput
                              THEN outputTokens ELSE outputTokens - prevOutput END), 0) AS outputTokens,
            COALESCE(SUM(CASE WHEN prevCacheCreation IS NULL OR cacheCreationInputTokens < prevCacheCreation
                              THEN cacheCreationInputTokens ELSE cacheCreationInputTokens - prevCacheCreation END), 0) AS cacheCreationInputTokens,
            COALESCE(SUM(CASE WHEN prevCacheRead IS NULL OR cacheReadInputTokens < prevCacheRead
                              THEN cacheReadInputTokens ELSE cacheReadInputTokens - prevCacheRead END), 0) AS cacheReadInputTokens
        FROM lagged
        WHERE 1 = 1
          ${timeClause}
        GROUP BY model
    `).all(...params) as Array<{ model: string } & Omit<UsageAggregateRow, 'model' | 'requestCount'>>

    return new Map(rows.map(({ model, ...totals }) => [model, totals]))
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
