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

/**
 * 一台机器在当前时间窗内的用量小结。
 *
 * 原来这里只是个 `string[]` 主机名列表，前端拿它渲染一个裸下拉——机器列表在
 * 用量页上不提供任何量化信息，「哪台机器烧了 token」得逐台切换筛选去比。
 * 现在每台自带统计与归属，机器列表本身就是一张榜。
 */
export type UsageHostSummary = {
    host: string
    /** 该机器上的可见会话数（不随时间窗变化）。 */
    sessionCount: number
    /** 当前时间窗内四段合计。**不受 host 筛选影响**——否则选中一台之后
     *  其余机器全归零，就没法比较了。 */
    totalTokens: number
    requestCount: number
    /** 多用户 gateway 标注的归属账号用户名；单用户 hub 或未知为 null。 */
    owner: string | null
    /** node 平台词表（win32/darwin/linux），未知为 null。 */
    platform: string | null
}

export type UsageSummaryResponse = {
    models: UsageModelSummary[]
    totals: Omit<UsageModelSummary, 'model'>
    /** 该账号可见的机器列表，各自带统计与归属（前端机器榜 + 筛选用）。 */
    hosts: UsageHostSummary[]
    /** 本次统计实际生效的筛选条件，回显给前端确认。 */
    filter: { since: string | null; until: string | null; host: string | null }
    generatedAt: number
}

/** 会话投影：按 host 分桶算每台机器的统计。聚合本身由调用方注入，
 *  这里只管分桶与汇总，好让口径可单测。 */
export function summarizeUsageHosts(
    sessions: Array<{ id: string; host: string | null; platform: string | null; owner: string | null }>,
    aggregate: (sessionIds: string[]) => UsageAggregateRow[]
): UsageHostSummary[] {
    const byHost = new Map<string, { ids: string[]; platform: string | null; owner: string | null }>()
    for (const session of sessions) {
        if (!session.host) continue
        const bucket = byHost.get(session.host)
        if (bucket) {
            bucket.ids.push(session.id)
            // 同一 host 的会话可能只有一部分带 os/归属，取第一个非空的。
            bucket.platform ??= session.platform
            bucket.owner ??= session.owner
        } else {
            byHost.set(session.host, { ids: [session.id], platform: session.platform, owner: session.owner })
        }
    }

    return [...byHost.entries()]
        .map(([host, bucket]) => {
            const rows = aggregate(bucket.ids)
            let totalTokens = 0
            let requestCount = 0
            for (const row of rows) {
                totalTokens += modelTotal(row)
                requestCount += row.requestCount
            }
            return {
                host,
                sessionCount: bucket.ids.length,
                totalTokens,
                requestCount,
                owner: bucket.owner,
                platform: bucket.platform
            }
        })
        // 用量降序——机器榜的重点是「谁在烧」；同量时按名字稳定排序。
        .sort((a, b) => b.totalTokens - a.totalTokens || a.host.localeCompare(b.host))
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
    hosts: UsageHostSummary[],
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
/** 一条与用量有关的事件，从 messages.content 解码后抽出的紧凑形态。
 *
 *  只保留聚合真正用得到的字段：解码是整个统计端点的成本大头（生产库
 *  356,844 行 / 1.2 GB content，每次打开统计页全量 zstd 解码一遍，实测
 *  8.7~36.0s），而事件本身极小，可以按会话缓存下来反复用。
 *
 *  时间窗**不**参与缓存：窗口过滤与帧差值都在聚合阶段用这些事件重算，
 *  所以任意 since/until 都命中同一份缓存。 */
type UsageEvent =
    | {
        kind: 'assistant'
        ts: string | null
        messageId: string
        model: string
        inputTokens: number
        outputTokens: number
        cacheCreationInputTokens: number
        cacheReadInputTokens: number
    }
    | {
        kind: 'frame'
        ts: string | null
        model: string
        /** 常驻进程运行总计（累计值，非增量）——差值在聚合阶段算。 */
        inputTokens: number
        outputTokens: number
        cacheCreationInputTokens: number
        cacheReadInputTokens: number
    }
    /** Codex / Kimi / 一切 ACP 后端（cursor、grok、copilot、opencode）唯一的
     *  用量来源。它们从不发 `assistant`，也从不发 `usage_report`，只发
     *  `token_count`（Kimi 的 wire scanner、Codex 的 app-server、以及
     *  `cli/src/agent/messageConverter.ts` 的通用 ACP 转换器各发一路），所以在
     *  补上这一支之前，本页对这些 flavor 的会话恒报 0。上游
     *  `hub/src/sync/usageService.ts` 一直读这一支——这条分支是把它的口径搬过来。 */
    | {
        kind: 'agentUsage'
        ts: string | null
        /** 同一条累计流的标识：累计值要对前一帧取差值，只有同流可比。 */
        streamKey: string
        /** 累计流里同一轮的重复快照要去重（会话导入会重放同一批帧）。 */
        turnId: string
        /** 帧自带的模型名；缺失时留 null，聚合阶段用会话 model 兜底。
         *  **不在这里回填**：兜底值来自会话行，而事件是按会话缓存的，
         *  烧进缓存会让会话改模型后旧事件永远挂在旧名字上。 */
        model: string | null
        /** Codex 报的是线程累计值；ACP 后端把每次请求的用量包在 `total` 里发，
         *  是增量。只有累计流才做差值。 */
        cumulative: boolean
        /** `inputTokens` 语义随 flavor 变：Claude 的 input 不含缓存，Codex/Kimi
         *  的 input **已经含**缓存读。归一在聚合阶段做，这里保持原样。 */
        inputTokens: number
        outputTokens: number
        cacheCreationInputTokens: number
        cacheReadInputTokens: number
        /** 累计流回落（进程重启/换线程）时的兜底：上游 `last_*` 那组。 */
        lastInputTokens: number | null
        lastOutputTokens: number | null
        lastCacheCreationInputTokens: number | null
        lastCacheReadInputTokens: number | null
    }

type SessionUsageEvents = {
    /** 已覆盖到的最大 seq；库里该会话 max(seq) 与之相等即可直接复用。 */
    maxSeq: number
    /** 解码时用的会话 flavor。它变了就必须整段重扫（见 loadSessionEvents）。 */
    agent: string
    events: UsageEvent[]
}

/** 会话 → 已解码事件。会话一旦不再产生新消息就永远命中缓存：生产库 931 个
 *  会话里近 1 小时有更新的只有 3 个（2,760 行 / 10.4 MB），稳态解码量因此
 *  从 1.2 GB 降到约 10 MB。hub 是单进程常驻，缓存随进程生命周期存活；
 *  重启后第一次调用重建，之后恢复。 */
const sessionEventCache = new Map<string, SessionUsageEvents>()

/** 仅供测试：清空缓存，让用例之间互不影响。 */
export function __resetUsageEventCacheForTests(): void {
    sessionEventCache.clear()
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null

/** 第一个能取到数字的键。各后端字段名不统一（camelCase / snake_case 混用），
 *  上游 `usageService.firstCount` 同款。 */
function firstCount(record: Record<string, unknown>, ...keys: string[]): number {
    for (const key of keys) {
        const value = record[key]
        if (typeof value === 'number' && Number.isFinite(value)) return value
    }
    return 0
}

const readNums = (record: Record<string, unknown>): UsageNums => ({
    inputTokens: firstCount(record, 'inputTokens', 'input_tokens'),
    outputTokens: firstCount(record, 'outputTokens', 'output_tokens'),
    cacheCreationInputTokens: firstCount(
        record, 'cacheWriteInputTokens', 'cache_write_input_tokens',
        'cacheCreationTokens', 'cache_creation_input_tokens'
    ),
    cacheReadInputTokens: firstCount(
        record, 'cachedInputTokens', 'cached_input_tokens',
        'cacheReadTokens', 'cache_read_input_tokens'
    )
})

/** 把一行 messages.content 解码成 0..n 条用量事件。
 *  过滤条件与聚合口径必须和原实现逐条一致。
 *
 *  `seq` 只用来给增量帧造一个会话内稳定的去重键（seq 在会话内唯一且不改写）。
 *  `agent` 是会话 flavor，决定 `token_count` 走累计还是增量口径。
 *  `createdAt` 是库里 messages.created_at，给没有 `data.timestamp` 的信封兜底。
 *
 *  **信封的 `content.type` 随 flavor 变，不能统一按 `output` 卡。** Claude 走
 *  `content.type === 'output'`，Codex 走 `content.type === 'codex'`（生产库
 *  实测：2,123 条 codex 消息全部是 `codex`，没有一条 `output`）。上游
 *  `usageService.parseUsageEvent` 也只对 assistant 分支要求 `output`，
 *  `token_count` 分支只看 `data.type`。 */
function extractUsageEvents(
    rawContent: string | Uint8Array,
    seq: number,
    agent: string,
    createdAt: number
): UsageEvent[] {
    let content: unknown
    try {
        content = decodeMessageContent(rawContent as never)
    } catch {
        return []
    }
    if (!content || typeof content !== 'object') return []
    const record = content as Record<string, unknown>
    if (record.role !== 'agent') return []
    const outer = record.content as Record<string, unknown> | undefined
    if (!outer) return []
    const data = outer.data as Record<string, unknown> | undefined
    if (!data) return []
    const ts = typeof data.timestamp === 'string' ? data.timestamp : null

    // Claude 专有的两支仍然只认 output 信封。
    if (outer.type === 'output' && data.type === 'assistant') {
        const message = data.message as Record<string, unknown> | undefined
        const messageId = message?.id
        const model = message?.model
        if (typeof messageId !== 'string' || typeof model !== 'string' || model === '<synthetic>') return []
        const usage = message?.usage as Record<string, unknown> | undefined
        if (!usage) return []
        return [{
            kind: 'assistant',
            ts,
            messageId,
            model,
            inputTokens: Number(usage.input_tokens) || 0,
            outputTokens: Number(usage.output_tokens) || 0,
            cacheCreationInputTokens: Number(usage.cache_creation_input_tokens) || 0,
            cacheReadInputTokens: Number(usage.cache_read_input_tokens) || 0
        }]
    }

    if (outer.type === 'output' && data.type === 'usage_report') {
        const modelUsage = data.modelUsage as Record<string, unknown> | undefined
        if (!modelUsage) return []
        const events: UsageEvent[] = []
        for (const [model, entryRaw] of Object.entries(modelUsage)) {
            const entry = (entryRaw ?? {}) as Record<string, unknown>
            events.push({
                kind: 'frame',
                ts,
                model,
                inputTokens: Number(entry.inputTokens) || 0,
                outputTokens: Number(entry.outputTokens) || 0,
                cacheCreationInputTokens: Number(entry.cacheCreationInputTokens) || 0,
                cacheReadInputTokens: Number(entry.cacheReadInputTokens) || 0
            })
        }
        return events
    }

    // —— Codex / Kimi / ACP 后端唯一的用量来源。口径搬自上游
    //    hub/src/sync/usageService.ts 的 parseUsageEvent。
    if (data.type === 'token_count' || data.type === 'usage') {
        // 导入的历史记录不是本机真实消耗，计进去会把同一批 token 记两遍。
        if (data.hapiUsageScope === 'imported-history') return []
        const info = asRecord(data.info) ?? data
        const explicitThreadId = typeof data.threadId === 'string'
            ? data.threadId
            : typeof data.thread_id === 'string' ? data.thread_id : null

        // 只有 Codex 报的是**线程累计值**；其余 ACP 后端把每次请求的用量
        // 包在 `total` 里发，那是增量，按累计做差会把每一轮都抹成 0。
        const cumulativeTotal = agent === 'codex'
            ? asRecord(info.total) ?? asRecord(info.total_token_usage) ?? asRecord(info.totalTokenUsage)
            : null
        const last = asRecord(info.last)
            ?? asRecord(info.last_token_usage)
            ?? asRecord(info.lastTokenUsage)
            ?? (data.type === 'usage' ? info : null)
        const total = cumulativeTotal ?? (agent === 'codex' ? last : asRecord(info.total) ?? info)
        if (!total) return []

        const nums = readNums(total)
        if (usageTotal(nums) <= 0) return []

        const isCumulative = cumulativeTotal !== null
        const scope = typeof data.scopeRole === 'string'
            ? data.scopeRole
            : typeof data.scope_role === 'string' ? data.scope_role : 'parent'
        const turnId = typeof data.turnId === 'string'
            ? data.turnId
            : typeof data.turn_id === 'string' ? data.turn_id : ''
        const lastNums = last ? readNums(last) : null

        return [{
            kind: 'agentUsage',
            // Codex/ACP 的信封没有 data.timestamp（生产库实测 2,123 条全部没有），
            // 落回库里的 created_at。时间窗对这些 flavor 只能按入库时刻判定；
            // 拿不到 ts 就等于永远落在窗外，整支会被静默丢掉。
            ts: ts ?? new Date(createdAt).toISOString(),
            // 累计流按 线程+scope 分组做差；增量帧用 seq 当会话内去重键。
            streamKey: isCumulative
                ? `cumulative|${explicitThreadId ?? ''}|${scope}`
                : `delta|${seq}`,
            turnId,
            model: typeof data.model === 'string' && data.model.trim() ? data.model.trim() : null,
            cumulative: isCumulative,
            ...nums,
            lastInputTokens: lastNums?.inputTokens ?? null,
            lastOutputTokens: lastNums?.outputTokens ?? null,
            lastCacheCreationInputTokens: lastNums?.cacheCreationInputTokens ?? null,
            lastCacheReadInputTokens: lastNums?.cacheReadInputTokens ?? null
        }]
    }

    return []
}

/** 会话的 flavor 与模型名。flavor 决定 `token_count` 的累计/增量口径，
 *  model 给缺模型名的帧兜底。 */
export type SessionUsageContext = { agent: string; model: string | null }

/** 读这批会话的 flavor / model。flavor 存在 metadata JSON 里（ROUTING_FIELDS），
 *  取不到时按 'unknown' 处理——与上游 `sessionAgent()` 一致。 */
function loadSessionContexts(db: Database, sessionIds: string[]): Map<string, SessionUsageContext> {
    const placeholders = sessionIds.map(() => '?').join(',')
    const rows = db.prepare(`
        SELECT id, metadata, model
        FROM sessions
        WHERE id IN (${placeholders})
    `).all(...sessionIds) as Array<{ id: string; metadata: string | null; model: string | null }>

    const out = new Map<string, SessionUsageContext>()
    for (const row of rows) {
        let agent = 'unknown'
        if (row.metadata) {
            try {
                const flavor = asRecord(JSON.parse(row.metadata))?.flavor
                if (typeof flavor === 'string' && flavor.trim()) agent = flavor.trim()
            } catch {
            }
        }
        const model = typeof row.model === 'string' && row.model.trim() ? row.model.trim() : null
        out.set(row.id, { agent, model })
    }
    return out
}

/** 取回这批会话的用量事件，只对有新消息的会话解码增量。 */
function loadSessionEvents(
    db: Database,
    sessionIds: string[],
    contexts: Map<string, SessionUsageContext>
): Map<string, UsageEvent[]> {
    const placeholders = sessionIds.map(() => '?').join(',')
    // 走 idx_messages_session(session_id, seq)，只读索引不碰 content。
    const heads = db.prepare(`
        SELECT session_id AS sessionId, MAX(seq) AS maxSeq
        FROM messages
        WHERE session_id IN (${placeholders})
        GROUP BY session_id
    `).all(...sessionIds) as Array<{ sessionId: string; maxSeq: number }>

    const result = new Map<string, UsageEvent[]>()
    const stale: Array<{ sessionId: string; fromSeq: number; maxSeq: number }> = []
    for (const head of heads) {
        const agent = contexts.get(head.sessionId)?.agent ?? 'unknown'
        const cached = sessionEventCache.get(head.sessionId)
        // flavor 变了要整段重扫：它决定 token_count 走累计还是增量，
        // 旧 flavor 下解出来的事件在新口径里是错的。
        if (cached && cached.agent === agent && cached.maxSeq === head.maxSeq) {
            result.set(head.sessionId, cached.events)
            continue
        }
        // 缓存落后就只补 seq 之后的部分；没有缓存则全量。消息只追加不改写，
        // 所以前缀事件保持有效；max(seq) 回退（会话被清空/重建）时整段重扫。
        const reusable = cached && cached.agent === agent && cached.maxSeq < head.maxSeq
        stale.push({ sessionId: head.sessionId, fromSeq: reusable ? cached.maxSeq : 0, maxSeq: head.maxSeq })
    }

    if (stale.length > 0) {
        const scan = db.prepare(`
            SELECT seq, content, created_at AS createdAt
            FROM messages
            WHERE session_id = ? AND seq > ?
            ORDER BY seq
        `)
        for (const entry of stale) {
            const agent = contexts.get(entry.sessionId)?.agent ?? 'unknown'
            const rows = scan.all(entry.sessionId, entry.fromSeq) as Array<{ seq: number; content: string | Uint8Array; createdAt: number }>
            const base = entry.fromSeq > 0
                ? (sessionEventCache.get(entry.sessionId)?.events ?? [])
                : []
            const events = base.slice()
            for (const row of rows) {
                for (const event of extractUsageEvents(row.content, row.seq, agent, row.createdAt)) {
                    events.push(event)
                }
            }
            sessionEventCache.set(entry.sessionId, { maxSeq: entry.maxSeq, agent, events })
            result.set(entry.sessionId, events)
        }
    }

    return result
}

export function aggregateUsageForSessions(
    db: Database,
    sessionIds: string[],
    opts?: { sinceIso?: string | null; untilIso?: string | null }
): UsageAggregateRow[] {
    if (sessionIds.length === 0) {
        return []
    }

    const contexts = loadSessionContexts(db, sessionIds)
    const eventsBySession = loadSessionEvents(db, sessionIds, contexts)

    const sinceIso = opts?.sinceIso ?? null
    const untilIso = opts?.untilIso ?? null
    const inWindow = (ts: unknown): boolean => {
        if (typeof ts !== 'string' || !ts) return false
        if (sinceIso && ts < sinceIso) return false
        if (untilIso && ts >= untilIso) return false
        return true
    }

    // —— 两侧都按会话分桶后再结算：帧与 assistant 行只有在同一会话内才描述
    //    同一批 API 轮，跨会话取 max 会把无关流量混在一起（见 settleSessionUsage）。
    const seenTurn = new Set<string>()
    const assistantBySession = new Map<string, Map<string, UsageAggregateRow>>()
    type FrameNums = { inputTokens: number; outputTokens: number; cacheCreationInputTokens: number; cacheReadInputTokens: number }
    const prevFrame = new Map<string, FrameNums>()
    const frameBySession = new Map<string, Map<string, FrameNums>>()
    /** Codex 累计流的前值，按 `sessionId::streamKey` 分组。 */
    const prevAgentTotal = new Map<string, FrameNums>()
    /** 同一轮累计快照的指纹，重复投递（导入重放）只计一次。 */
    const seenAgentTurn = new Set<string>()
    /** `sessionId::model`：这一桶的 input 已经在 agentUsage 分支逐帧扣过缓存读，
     *  不能再被 normalizeInclusiveInput 扣第二遍。 */
    const agentUsageBuckets = new Set<string>()
    const bucket = <T>(store: Map<string, Map<string, T>>, sessionId: string): Map<string, T> => {
        let inner = store.get(sessionId)
        if (!inner) { inner = new Map<string, T>(); store.set(sessionId, inner) }
        return inner
    }

    // seenTurn 是**跨会话**去重（键不含 sessionId），所以遍历顺序会影响归属：
    // 按 sessionId 升序、会话内按 seq 升序，复刻原来 `ORDER BY session_id, seq`
    // 的单次扫描顺序。
    for (const sessionId of [...eventsBySession.keys()].sort()) {
        for (const event of eventsBySession.get(sessionId)!) {
            if (event.kind === 'assistant') {
                // 窗口过滤在去重之前：窗外的行不该占用 turnKey，否则窗内同轮的行会被吞。
                if (!inWindow(event.ts)) continue
                // Claude Code 同一 API 轮写多行、usage 逐行重复（实测 150,180 行只
                // 有 69,935 个 distinct message.id），必须按轮去重否则整体虚高 ~2.15x。
                const turnKey = `${event.messageId}::${event.model}`
                if (seenTurn.has(turnKey)) continue
                seenTurn.add(turnKey)
                const perSession = bucket(assistantBySession, sessionId)
                const agg = perSession.get(event.model) ?? {
                    model: event.model, requestCount: 0, inputTokens: 0, outputTokens: 0,
                    cacheCreationInputTokens: 0, cacheReadInputTokens: 0
                }
                agg.requestCount += 1
                agg.inputTokens += event.inputTokens
                agg.outputTokens += event.outputTokens
                agg.cacheCreationInputTokens += event.cacheCreationInputTokens
                agg.cacheReadInputTokens += event.cacheReadInputTokens
                perSession.set(event.model, agg)
                continue
            }

            if (event.kind === 'agentUsage') {
                // 这些会话没有 assistant 行也没有 usage_report 帧，token_count
                // 是唯一来源，所以直接记进 assistant 侧：settleSessionUsage 见到
                // 空的帧侧会原样放行，不会与任何东西取 max。
                let nums: FrameNums = {
                    inputTokens: event.inputTokens,
                    outputTokens: event.outputTokens,
                    cacheCreationInputTokens: event.cacheCreationInputTokens,
                    cacheReadInputTokens: event.cacheReadInputTokens
                }
                if (event.cumulative) {
                    // 同一轮的重复快照（会话导入会重放整段）只算一次。
                    if (event.turnId) {
                        const fingerprint = `${sessionId}|${event.turnId}|${nums.inputTokens}|${nums.outputTokens}|${nums.cacheCreationInputTokens}|${nums.cacheReadInputTokens}`
                        if (seenAgentTurn.has(fingerprint)) continue
                        seenAgentTurn.add(fingerprint)
                    }
                    const key = `${sessionId}::${event.streamKey}`
                    const prev = prevAgentTotal.get(key)
                    prevAgentTotal.set(key, nums)
                    // 累计值对前值取差；回落（进程重启/换线程）时用帧自带的
                    // last_* 兜底，没有就按全额——与上游 cumulativeDelta 同款。
                    const step = (cur: number, before: number | undefined, last: number | null): number => {
                        if (before === undefined) return last ?? cur
                        return cur >= before ? cur - before : last ?? cur
                    }
                    nums = {
                        inputTokens: step(nums.inputTokens, prev?.inputTokens, event.lastInputTokens),
                        outputTokens: step(nums.outputTokens, prev?.outputTokens, event.lastOutputTokens),
                        cacheCreationInputTokens: step(nums.cacheCreationInputTokens, prev?.cacheCreationInputTokens, event.lastCacheCreationInputTokens),
                        cacheReadInputTokens: step(nums.cacheReadInputTokens, prev?.cacheReadInputTokens, event.lastCacheReadInputTokens)
                    }
                } else if (seenAgentTurn.has(`${sessionId}|${event.streamKey}`)) {
                    continue
                } else {
                    seenAgentTurn.add(`${sessionId}|${event.streamKey}`)
                }

                // 时间窗在差值之后：先窗后差会让窗内首帧把整段线程累计算进来。
                if (!inWindow(event.ts)) continue
                if (usageTotal(nums) <= 0) continue

                // Codex/Kimi 的 inputTokens **已经含**缓存读，而本页把
                // input / cacheRead 当四段并列相加。不扣掉的话缓存读会被计两遍。
                const uncachedInput = Math.max(0, nums.inputTokens - nums.cacheReadInputTokens)
                const model = event.model ?? contexts.get(sessionId)?.model ?? 'unknown'
                const perSession = bucket(assistantBySession, sessionId)
                const agg = perSession.get(model) ?? {
                    model, requestCount: 0, inputTokens: 0, outputTokens: 0,
                    cacheCreationInputTokens: 0, cacheReadInputTokens: 0
                }
                agg.requestCount += 1
                agg.inputTokens += uncachedInput
                agg.outputTokens += nums.outputTokens
                agg.cacheCreationInputTokens += nums.cacheCreationInputTokens
                agg.cacheReadInputTokens += nums.cacheReadInputTokens
                perSession.set(model, agg)
                agentUsageBuckets.add(`${sessionId}::${model}`)
                continue
            }

            const nums: FrameNums = {
                inputTokens: event.inputTokens,
                outputTokens: event.outputTokens,
                cacheCreationInputTokens: event.cacheCreationInputTokens,
                cacheReadInputTokens: event.cacheReadInputTokens
            }
            const key = `${sessionId}::${event.model}`
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
            if (!inWindow(event.ts)) continue
            const perSession = bucket(frameBySession, sessionId)
            const agg = perSession.get(event.model) ?? {
                inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0
            }
            agg.inputTokens += delta.inputTokens
            agg.outputTokens += delta.outputTokens
            agg.cacheCreationInputTokens += delta.cacheCreationInputTokens
            agg.cacheReadInputTokens += delta.cacheReadInputTokens
            perSession.set(event.model, agg)
        }
    }

    // —— 结算前把两侧统一到「input 不含缓存读」的口径 ——
    // assistant 行与 usage_report 帧都可能来自 OpenAI 兼容中转，那边的 input 是**含**
    // 缓存读的整段 prompt。逐桶归一（而不是逐行）：判据只有在整段累计上才可靠。
    for (const [sessionId, perModel] of assistantBySession) {
        for (const [model, agg] of perModel) {
            if (agentUsageBuckets.has(`${sessionId}::${model}`)) continue
            normalizeInclusiveInput(agg)
        }
    }
    for (const perModel of frameBySession.values()) {
        for (const agg of perModel.values()) normalizeInclusiveInput(agg)
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

/** 就地把「input 含缓存读」的一桶用量改成「input 不含缓存读」。
 *
 *  **本页把 input / output / cacheCreation / cacheRead 当四段并列相加**，所以任何
 *  把缓存读算进 input 的来源都会让缓存读被计两遍：总量虚高，命中率被摊薄近一半。
 *  `token_count` 那支早就在逐帧扣（Codex/Kimi 的 input 恒含缓存读），但 Claude 形态的
 *  两支——`assistant` 行与 `usage_report` 帧——一直没扣，而它们在**经 OpenAI 兼容中转
 *  的会话里同样是含缓存读的**。
 *
 *  生产库实证（2026-08-10，`hapi.db.pre-v0.27.1-fork.0`）：
 *  - 一条 cx2cc 会话（`a00487b4`，gpt-5.6-sol）的 `usage_report` 帧差值合计
 *    input=76,788,086，而同会话 assistant 行的 input+cacheRead=76,784,812
 *    ——两者相差 0.004%，即帧的 input **就是**「未命中 + 命中」的整段 prompt。
 *  - 对照组 vircs 直连 Anthropic：帧是 `input=194, cacheRead=61,831,508,
 *    cacheCreation=680,785`，input 只是未缓存的尾巴，两侧逐会话 1:1 吻合。
 *
 *  判据要求三条同时成立，缺一不扣：
 *  1. `cacheRead > 0` —— 没有缓存读就没有可能被重复计的量；
 *  2. `cacheCreation === 0` —— Anthropic 只要读过缓存，同一累计窗口里必然也写过缓存
 *     （Claude Code 每轮都重设 cache_control 断点），中转则从不报写入；
 *  3. `cacheRead <= input` —— 缓存读是 input 的子集才谈得上「含在里面」。直连的
 *     input 是未缓存尾巴，几乎恒小于缓存读，所以这条把直连挡在外面。
 *
 *  **按桶判而不是按行判**：判据依赖「整段累计里出现过缓存写入」，逐行看会把直连
 *  会话中「读了缓存但本轮没写」的正常轮误判成中转。全库实测按桶判时直连各行
 *  （claude-sonnet-5 / claude-opus-5）数字一位不变。 */
function normalizeInclusiveInput(nums: UsageNums): void {
    if (nums.cacheReadInputTokens > 0
        && nums.cacheCreationInputTokens === 0
        && nums.cacheReadInputTokens <= nums.inputTokens) {
        nums.inputTokens -= nums.cacheReadInputTokens
    }
}

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
