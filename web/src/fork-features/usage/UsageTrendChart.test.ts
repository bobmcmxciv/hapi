import { describe, expect, it } from 'vitest'
import { buildTrendLines, MAX_NAMED_SERIES } from './UsageTrendChart'

const series = (model: string, input: number[], output: number[] = input.map(() => 0)) => ({
    model,
    inputTokens: input,
    outputTokens: output,
    cacheCreationInputTokens: input.map(() => 0),
    cacheReadInputTokens: input.map(() => 0),
    requestCount: input.map(() => 0)
})

describe('buildTrendLines', () => {
    it('keeps the top models and folds the rest into Other', () => {
        const data = {
            unit: 'day' as const,
            buckets: ['a', 'b'],
            series: Array.from({ length: 9 }, (_, i) => series(`m${i}`, [10 - i, 1]))
        }
        const lines = buildTrendLines(data, 'total', 'Other')
        expect(lines).toHaveLength(MAX_NAMED_SERIES + 1)
        expect(lines[lines.length - 1]).toEqual({ key: '__other__', label: 'Other', slot: 8, values: [3 + 2, 2] })
    })

    it('keeps a model on the same color slot when the metric changes', () => {
        const data = { unit: 'day' as const, buckets: ['a'], series: [series('big', [100], [0]), series('small', [1], [5])] }
        const total = buildTrendLines(data, 'total', 'Other')
        const output = buildTrendLines(data, 'output', 'Other')
        expect(total.find(line => line.key === 'small')?.slot).toBe(2)
        expect(output.find(line => line.key === 'small')?.slot).toBe(2)
        // A model with nothing under this metric is dropped instead of drawn flat at zero.
        expect(output.map(line => line.key)).toEqual(['small'])
    })
})
