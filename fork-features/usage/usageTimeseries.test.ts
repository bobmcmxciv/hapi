import { describe, expect, it } from 'bun:test'
import { buildUsageTimeseries, MAX_BUCKETS, planBuckets, type AggregateUsageBucketsFn } from './usageTimeseries'
import type { UsageAggregateRow } from './usageAggregate'

/** 把「逐窗口」的假聚合包成批量接口：builder 只该依赖每个窗口各自的结果。 */
const perWindow = (fn: (since: string, until: string) => UsageAggregateRow[]): AggregateUsageBucketsFn =>
    (total, buckets) => ({ total: fn(total.sinceIso, total.untilIso), buckets: buckets.map(bucket => fn(bucket.sinceIso, bucket.untilIso)) })

describe('planBuckets', () => {
    it('aligns day buckets to local midnight', () => {
        // 2026-10-06T10:00Z = 18:00 at UTC+8; local midnight is 2026-10-05T16:00Z.
        const buckets = planBuckets(Date.parse('2026-10-06T10:00:00Z'), Date.parse('2026-10-07T10:00:00Z'), 'day', 480)
        // 首桶裁到 since，其后按本地零点（UTC 16:00）切。
        expect(new Date(buckets[0]!.start).toISOString()).toBe('2026-10-06T10:00:00.000Z')
        expect(new Date(buckets[0]!.end).toISOString()).toBe('2026-10-06T16:00:00.000Z')
        expect(new Date(buckets[1]!.end).toISOString()).toBe('2026-10-07T10:00:00.000Z')
        expect(buckets).toHaveLength(2)
    })

    it('aligns week buckets to local Monday', () => {
        // 2026-10-08 is a Thursday.
        const buckets = planBuckets(Date.parse('2026-10-08T12:00:00Z'), Date.parse('2026-10-20T00:00:00Z'), 'week', 0)
        expect(new Date(buckets[0]!.end).toISOString()).toBe('2026-10-12T00:00:00.000Z')
    })

    it('aligns 6-hour buckets to local 00/06/12/18', () => {
        const buckets = planBuckets(Date.parse('2026-10-06T03:30:00Z'), Date.parse('2026-10-06T10:00:00Z'), '6h', 480)
        // 11:30 local -> bucket starts 06:00 local = 2026-10-05T22:00Z
        expect(new Date(buckets[0]!.end).toISOString()).toBe('2026-10-06T04:00:00.000Z')
    })

    it('keeps only the most recent buckets beyond the cap', () => {
        const until = Date.parse('2026-10-06T00:00:00Z')
        const buckets = planBuckets(until - 200 * 3600_000, until, 'hour', 0)
        expect(buckets).toHaveLength(MAX_BUCKETS)
        expect(buckets[buckets.length - 1]!.end).toBe(until)
    })
})

describe('buildUsageTimeseries', () => {
    it('rescales bucket shapes so each model sums exactly to the whole-window settlement', () => {
        const buckets = [{ start: 0, end: 10 }, { start: 10, end: 20 }]
        const row = (model: string, input: number) => ({ model, requestCount: 1, inputTokens: input, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 })
        // 逐桶结算各取了大值（60+60），整段结算只有 100。
        const result = buildUsageTimeseries(buckets, 'day', perWindow((since, until) => {
            if (since === new Date(0).toISOString() && until === new Date(20).toISOString()) return [row('a', 100)]
            return [row('a', 60)]
        }))
        expect(result.series[0]!.inputTokens).toEqual([50, 50])
        expect(result.series[0]!.requestCount.reduce((a, b) => a + b, 0)).toBe(1)
    })

    it('fills one value per bucket per model and orders models by total', () => {
        const buckets = [{ start: 0, end: 10 }, { start: 10, end: 20 }]
        const parts = (since: string) => since === new Date(0).toISOString()
            ? [{ model: 'a', requestCount: 1, inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }]
            : [
                { model: 'b', requestCount: 2, inputTokens: 10, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 5 },
                { model: 'zero', requestCount: 0, inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }
            ]
        const result = buildUsageTimeseries(buckets, 'day', perWindow((since, until) => {
            if (until === new Date(20).toISOString() && since === new Date(0).toISOString()) {
                return [
                    { model: 'a', requestCount: 1, inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
                    { model: 'b', requestCount: 2, inputTokens: 10, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 5 }
                ]
            }
            return parts(since)
        }), 99)
        expect(result.series.map(s => s.model)).toEqual(['b', 'a'])
        expect(result.series[0]!.inputTokens).toEqual([0, 10])
        expect(result.series[1]!.outputTokens).toEqual([1, 0])
        expect(result.buckets).toHaveLength(2)
    })
})
