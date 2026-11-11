import { describe, expect, test } from 'bun:test'
import { getFreshOmpUsageReports, OMP_USAGE_MAX_AGE_MS, OmpUsageResponseSchema, type OmpUsageResponse } from './ompUsage'

function snapshot(fetchedAt: number): OmpUsageResponse {
    return {
        success: true, source: 'omp-native', generatedAt: 100_000_000,
        reports: [{
            provider: 'anthropic', accountId: 'opaque', fetchedAt, limits: [{
                id: 'weekly', label: 'Weekly', scope: { shared: true, sharedGroup: 'opaque-pool' },
                amount: { unit: 'percent', remaining: 0, remainingFraction: 0 }, status: 'exhausted'
            }]
        }], accountsWithoutUsage: [], disabledCredentialCount: 0
    }
}

describe('OMP native usage freshness', () => {
    test('preserves a real zero without inventing missing amounts', () => {
        const result = getFreshOmpUsageReports(snapshot(100_000_000), 100_000_100)
        expect(result[0].limits[0].amount.remaining).toBe(0)
        expect(result[0].limits[0].amount.used).toBeUndefined()
    })
    test('a new generatedAt cannot resurrect old provider data', () => {
        expect(getFreshOmpUsageReports(snapshot(100_000_000 - OMP_USAGE_MAX_AGE_MS), 100_000_000)).toEqual([])
    })
    test('hides a reset window that expired while the page was open', () => {
        const input = snapshot(100_000_000)
        if (!input.success) throw new Error('Expected fixture success')
        input.reports[0].limits[0].window = { id: '5h', label: '5 Hour', resetsAt: 100_000_050 }
        expect(getFreshOmpUsageReports(input, 100_000_100)[0].limits).toEqual([])
    })
    test('does not bless a missing or far-future fetchedAt', () => {
        expect(getFreshOmpUsageReports(snapshot(0), 100_000_000)).toEqual([])
        expect(getFreshOmpUsageReports(snapshot(100_100_000), 100_000_000)).toEqual([])
    })
    test('schema strips raw data and arbitrary metadata at every level', () => {
        const input = snapshot(100_000_000)
        const result = OmpUsageResponseSchema.parse({ ...input, raw: 'secret', metadata: { token: 'secret' } })
        expect('raw' in result).toBe(false)
        expect('metadata' in result).toBe(false)
    })
})
