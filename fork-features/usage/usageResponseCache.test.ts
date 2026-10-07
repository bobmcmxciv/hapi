import { describe, expect, test } from 'bun:test'
import { UsageResponseCache } from './usageResponseCache'

describe('UsageResponseCache', () => {
    test('a result that took longer than the TTL to compute is still served afterwards', () => {
        let clock = 0
        const cache = new UsageResponseCache<string>(60_000, () => clock)
        let builds = 0
        const body = cache.compute('k', () => {
            builds += 1
            clock += 71_500 // 生产默认趋势图实测耗时
            return 'result'
        })
        expect(body).toBe('result')
        clock += 30_000
        expect(cache.compute('k', () => { builds += 1; return 'again' })).toBe('result')
        expect(builds).toBe(1)
    })

    test('expires after the TTL measured from completion and keeps keys separate', () => {
        let clock = 0
        const cache = new UsageResponseCache<number>(1000, () => clock)
        cache.compute('a', () => 1)
        cache.compute('b', () => 2)
        clock = 999
        expect(cache.get('a')).toBe(1)
        clock = 1000
        expect(cache.get('a')).toBeNull()
        expect(cache.compute('b', () => 3)).toBe(3)
    })
})
