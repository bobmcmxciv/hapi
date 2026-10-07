import type { UsageAggregateRow } from './usageAggregate'

/**
 * 用量随时间的折线数据。
 *
 * 每个时间桶复用 `aggregateUsageForSessions` 的窗口口径取「形状」（各桶与整段在
 * `aggregateUsageBuckets` 里一趟扫描算完，结果与逐桶单独调用相同），再按模型
 * 逐项缩放到整段窗口的结算值上：结算（帧与 assistant 取大、代理会话改挂、
 * 含缓存读归一）只在整段累计上成立，逐桶各自结算再相加会偏大（生产 7 天实测
 * +11%，gpt-6.1-sol +48%）。缩放后各桶之和与用量表同窗合计逐模型相等。
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
    // 超出上限时保留最近的桶；首尾桶裁到请求窗口内，使合计窗口与用量表一致。
    const kept = buckets.slice(-MAX_BUCKETS)
    if (kept.length > 0) {
        kept[0] = { ...kept[0]!, start: Math.max(kept[0]!.start, sinceMs) }
        kept[kept.length - 1] = { ...kept[kept.length - 1]!, end: Math.min(kept[kept.length - 1]!.end, untilMs) }
    }
    return kept
}

type Component = 'inputTokens' | 'outputTokens' | 'cacheCreationInputTokens' | 'cacheReadInputTokens' | 'requestCount'
const COMPONENTS: Component[] = ['inputTokens', 'outputTokens', 'cacheCreationInputTokens', 'cacheReadInputTokens', 'requestCount']

/** 把某模型各桶的某一项按比例缩放到 target，四舍五入后把误差补到最大的桶上，保证合计精确相等。 */
function rescale(values: number[], target: number): number[] {
    const sum = values.reduce((a, b) => a + b, 0)
    if (sum <= 0) {
        if (target <= 0) return values.map(() => 0)
        // 桶里没有这一项却有整段合计（极少见）：整笔记到最后一个桶。
        return values.map((_, i) => (i === values.length - 1 ? target : 0))
    }
    const scaled = values.map(v => Math.round((v * target) / sum))
    const drift = target - scaled.reduce((a, b) => a + b, 0)
    if (drift !== 0) {
        let maxIndex = 0
        scaled.forEach((v, i) => { if (v > scaled[maxIndex]!) maxIndex = i })
        scaled[maxIndex] = Math.max(0, scaled[maxIndex]! + drift)
    }
    return scaled
}

export type UsageBucketWindow = { sinceIso: string; untilIso: string }

/** 整段窗口与各桶一次给出，由调用方一趟扫描算完（见 aggregateUsageBuckets）。 */
export type AggregateUsageBucketsFn = (
    total: UsageBucketWindow,
    buckets: UsageBucketWindow[]
) => { total: UsageAggregateRow[]; buckets: UsageAggregateRow[][] }

export function buildUsageTimeseries(
    buckets: Array<{ start: number; end: number }>,
    unit: UsageBucketUnit,
    aggregate: AggregateUsageBucketsFn,
    now: number = Date.now()
): UsageTimeseriesResponse {
    const windows = buckets.map(bucket => ({ sinceIso: new Date(bucket.start).toISOString(), untilIso: new Date(bucket.end).toISOString() }))
    const computed = windows.length > 0
        ? aggregate({ sinceIso: windows[0]!.sinceIso, untilIso: windows[windows.length - 1]!.untilIso }, windows)
        : { total: [], buckets: [] }
    const totals = computed.total
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
    buckets.forEach((_bucket, index) => {
        for (const row of computed.buckets[index] ?? []) {
            const entry = series(row.model)
            entry.inputTokens[index]! += row.inputTokens
            entry.outputTokens[index]! += row.outputTokens
            entry.cacheCreationInputTokens[index]! += row.cacheCreationInputTokens
            entry.cacheReadInputTokens[index]! += row.cacheReadInputTokens
            entry.requestCount[index]! += row.requestCount
        }
    })
    for (const row of totals) series(row.model)
    const totalByModel = new Map(totals.map(row => [row.model, row]))
    for (const entry of byModel.values()) {
        const target = totalByModel.get(entry.model)
        for (const component of COMPONENTS) {
            entry[component] = rescale(entry[component], target ? target[component] : 0)
        }
    }
    const total = (s: UsageTimeseriesSeries) => s.inputTokens.reduce((sum, value, i) =>
        sum + value + s.outputTokens[i]! + s.cacheCreationInputTokens[i]! + s.cacheReadInputTokens[i]!, 0)
    return {
        unit,
        buckets: buckets.map(bucket => new Date(bucket.start).toISOString()),
        series: [...byModel.values()].filter(s => total(s) > 0).sort((a, b) => total(b) - total(a)),
        generatedAt: now
    }
}
