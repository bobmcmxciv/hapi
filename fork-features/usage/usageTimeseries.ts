import type { UsageAggregateRow } from './usageAggregate'

/**
 * 用量随时间的折线数据。
 *
 * 每个时间桶直接复用 `aggregateUsageForSessions` 的窗口口径（去重、帧结算、
 * 代理会话改挂、缓存读归一全在里面），所以各桶之和与用量表同一时间窗的合计
 * 一致；解码有按会话的事件缓存，多跑几次窗口只多花聚合的 CPU。
 */

export type UsageBucketUnit = 'hour' | '6h' | 'day' | 'week'

export type UsageTimeseriesSeries = {
    model: string
    inputTokens: number[]
    outputTokens: number[]
    cacheCreationInputTokens: number[]
    cacheReadInputTokens: number[]
    requestCount: number[]
}

export type UsageTimeseriesResponse = {
    unit: UsageBucketUnit
    /** 每个桶的起点（ISO，UTC 表示；已按调用方时区对齐到本地整点/零点/周一）。 */
    buckets: string[]
    series: UsageTimeseriesSeries[]
    generatedAt: number
}

export const MAX_BUCKETS = 60
const HOUR_MS = 3600_000
const DAY_MS = 24 * HOUR_MS

export function parseBucketUnit(raw: string | undefined): UsageBucketUnit {
    return raw === 'hour' || raw === '6h' || raw === 'week' ? raw : 'day'
}

/** `tzOffsetMinutes` = 本地时间比 UTC 快多少分钟（东八区 480）。 */
export function planBuckets(
    sinceMs: number,
    untilMs: number,
    unit: UsageBucketUnit,
    tzOffsetMinutes: number
): Array<{ start: number; end: number }> {
    const offset = tzOffsetMinutes * 60_000
    const step = unit === 'hour' ? HOUR_MS : unit === '6h' ? 6 * HOUR_MS : unit === 'day' ? DAY_MS : 7 * DAY_MS
    let start: number
    if (unit === 'week') {
        const localDay = Math.floor((sinceMs + offset) / DAY_MS)
        // 1970-01-01 是周四：(day + 3) % 7 == 0 即周一。
        const monday = localDay - (((localDay + 3) % 7) + 7) % 7
        start = monday * DAY_MS - offset
    } else {
        start = Math.floor((sinceMs + offset) / step) * step - offset
    }
    const buckets: Array<{ start: number; end: number }> = []
    for (let cursor = start; cursor < untilMs; cursor += step) {
        buckets.push({ start: cursor, end: cursor + step })
    }
    // 超出上限时保留最近的桶。
    return buckets.slice(-MAX_BUCKETS)
}

export function buildUsageTimeseries(
    buckets: Array<{ start: number; end: number }>,
    unit: UsageBucketUnit,
    aggregate: (sinceIso: string, untilIso: string) => UsageAggregateRow[],
    now: number = Date.now()
): UsageTimeseriesResponse {
    const byModel = new Map<string, UsageTimeseriesSeries>()
    const series = (model: string): UsageTimeseriesSeries => {
        let entry = byModel.get(model)
        if (!entry) {
            const zeros = () => buckets.map(() => 0)
            entry = {
                model,
                inputTokens: zeros(),
                outputTokens: zeros(),
                cacheCreationInputTokens: zeros(),
                cacheReadInputTokens: zeros(),
                requestCount: zeros()
            }
            byModel.set(model, entry)
        }
        return entry
    }
    buckets.forEach((bucket, index) => {
        const rows = aggregate(new Date(bucket.start).toISOString(), new Date(bucket.end).toISOString())
        for (const row of rows) {
            const entry = series(row.model)
            entry.inputTokens[index]! += row.inputTokens
            entry.outputTokens[index]! += row.outputTokens
            entry.cacheCreationInputTokens[index]! += row.cacheCreationInputTokens
            entry.cacheReadInputTokens[index]! += row.cacheReadInputTokens
            entry.requestCount[index]! += row.requestCount
        }
    })
    const total = (s: UsageTimeseriesSeries) => s.inputTokens.reduce((sum, value, i) =>
        sum + value + s.outputTokens[i]! + s.cacheCreationInputTokens[i]! + s.cacheReadInputTokens[i]!, 0)
    return {
        unit,
        buckets: buckets.map(bucket => new Date(bucket.start).toISOString()),
        series: [...byModel.values()].filter(s => total(s) > 0).sort((a, b) => total(b) - total(a)),
        generatedAt: now
    }
}
