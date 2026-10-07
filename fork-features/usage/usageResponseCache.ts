/**
 * 用量端点的响应缓存。
 *
 * 聚合是同步的，算的时候整个 hub 事件循环都停着（生产实测：普通请求 17ms →
 * 统计期间 6.8s），所以重复计算的代价不只是这一页慢。两条规则：
 * - 时间戳记在**算完**的那一刻。旧实现记请求开始时间，计算超过 TTL 的结果一写进去
 *   就已过期（生产默认趋势图 71.5s，重放仍 13.8s）。
 * - TTL 要长于前端轮询间隔，否则每次轮询都恰好错过缓存。
 */
export class UsageResponseCache<T> {
    private readonly entries = new Map<string, { at: number; body: T }>()

    constructor(private readonly ttlMs: number, private readonly now: () => number = Date.now) {}

    get(key: string): T | null {
        const entry = this.entries.get(key)
        if (!entry) return null
        if (this.now() - entry.at >= this.ttlMs) {
            this.entries.delete(key)
            return null
        }
        return entry.body
    }

    /** 计算并缓存；时间戳取计算完成时。 */
    compute(key: string, build: () => T): T {
        const cached = this.get(key)
        if (cached !== null) return cached
        const body = build()
        const at = this.now()
        for (const [other, entry] of this.entries) {
            if (at - entry.at >= this.ttlMs) this.entries.delete(other)
        }
        this.entries.set(key, { at, body })
        return body
    }
}

/** 统计页每 60s 轮询总表、每 120s 轮询趋势图；TTL 取轮询间隔的两倍左右。 */
export const USAGE_SUMMARY_TTL_MS = 2 * 60_000
export const USAGE_TIMESERIES_TTL_MS = 5 * 60_000
