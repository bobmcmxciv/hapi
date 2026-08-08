import { describe, expect, it, beforeEach } from 'bun:test'
import { Store } from '../../hub/src/store'
import { aggregateUsageForSessions, __resetUsageEventCacheForTests } from './usageAggregate'

// 增量缓存的行为约束。语义本身由 usageAggregate.test.ts 的 25 条用例钉死，
// 这里只管「缓存不能改变结果」和「不该重复解码」。
function makeStore(): Store {
    return new Store(':memory:')
}

function makeSession(store: Store, tag: string) {
    return store.sessions.getOrCreateSession(tag, { path: `/tmp/${tag}` }, null, 'default')
}

function assistantEnvelope(input: { messageId: string; model: string; timestamp: string; input?: number; output?: number }) {
    return {
        role: 'agent',
        content: {
            type: 'output',
            data: {
                type: 'assistant',
                timestamp: input.timestamp,
                message: {
                    id: input.messageId,
                    model: input.model,
                    usage: {
                        input_tokens: input.input ?? 0,
                        output_tokens: input.output ?? 0,
                        cache_creation_input_tokens: 0,
                        cache_read_input_tokens: 0
                    }
                }
            }
        }
    }
}

function usageReportEnvelope(input: { timestamp: string; model: string; inputTokens: number; outputTokens: number }) {
    return {
        role: 'agent',
        content: {
            type: 'output',
            data: {
                type: 'usage_report',
                timestamp: input.timestamp,
                modelUsage: {
                    [input.model]: {
                        inputTokens: input.inputTokens,
                        outputTokens: input.outputTokens,
                        cacheCreationInputTokens: 0,
                        cacheReadInputTokens: 0
                    }
                }
            }
        }
    }
}

/** 统计 db.prepare 被调用时携带 content 列的次数 —— 解码路径的代理指标。 */
function countingDb(store: Store) {
    const db = (store as unknown as { db: any }).db
    const stats = { contentScans: 0 }
    const original = db.prepare.bind(db)
    db.prepare = (sql: string) => {
        if (sql.includes('content')) stats.contentScans += 1
        return original(sql)
    }
    return stats
}

describe('aggregateUsageForSessions 增量缓存', () => {
    beforeEach(() => {
        __resetUsageEventCacheForTests()
    })

    it('第二次调用命中缓存，不再扫 content', () => {
        const store = makeStore()
        const session = makeSession(store, 'cache-1')
        store.messages.addMessage(session.id, assistantEnvelope({
            messageId: 'msg-1', model: 'opus', timestamp: '2026-08-08T00:00:00.000Z', input: 100, output: 10
        }))

        const first = aggregateUsageForSessions((store as any).db, [session.id])
        const stats = countingDb(store)
        const second = aggregateUsageForSessions((store as any).db, [session.id])

        expect(second).toEqual(first)
        // 命中缓存后只应查 MAX(seq)（不含 content 列），不该再取 content。
        expect(stats.contentScans).toBe(0)
    })

    it('会话新增消息后只解码增量，且结果与全量重算一致', () => {
        const store = makeStore()
        const session = makeSession(store, 'cache-2')
        store.messages.addMessage(session.id, assistantEnvelope({
            messageId: 'msg-1', model: 'opus', timestamp: '2026-08-08T00:00:00.000Z', input: 100, output: 10
        }))
        aggregateUsageForSessions((store as any).db, [session.id])

        store.messages.addMessage(session.id, assistantEnvelope({
            messageId: 'msg-2', model: 'opus', timestamp: '2026-08-08T01:00:00.000Z', input: 5, output: 1
        }))
        const incremental = aggregateUsageForSessions((store as any).db, [session.id])

        // 同一份数据从零重算，必须逐行相同。
        __resetUsageEventCacheForTests()
        const fromScratch = aggregateUsageForSessions((store as any).db, [session.id])

        expect(incremental).toEqual(fromScratch)
        expect(incremental).toEqual([{
            model: 'opus', requestCount: 2, inputTokens: 105, outputTokens: 11,
            cacheCreationInputTokens: 0, cacheReadInputTokens: 0
        }])
    })

    it('缓存与时间窗解耦：换窗口不重扫，且结果与冷缓存一致', () => {
        const store = makeStore()
        const session = makeSession(store, 'cache-3')
        store.messages.addMessage(session.id, assistantEnvelope({
            messageId: 'old', model: 'opus', timestamp: '2026-08-01T00:00:00.000Z', input: 999, output: 999
        }))
        store.messages.addMessage(session.id, assistantEnvelope({
            messageId: 'new', model: 'opus', timestamp: '2026-08-08T00:00:00.000Z', input: 7, output: 3
        }))
        aggregateUsageForSessions((store as any).db, [session.id])

        const stats = countingDb(store)
        const windowed = aggregateUsageForSessions((store as any).db, [session.id], {
            sinceIso: '2026-08-05T00:00:00.000Z'
        })
        expect(stats.contentScans).toBe(0)

        __resetUsageEventCacheForTests()
        const cold = aggregateUsageForSessions((store as any).db, [session.id], {
            sinceIso: '2026-08-05T00:00:00.000Z'
        })

        expect(windowed).toEqual(cold)
        expect(windowed).toEqual([{
            model: 'opus', requestCount: 1, inputTokens: 7, outputTokens: 3,
            cacheCreationInputTokens: 0, cacheReadInputTokens: 0
        }])
    })

    it('帧差值在增量解码下仍按整段 seq 序计算，不因缓存切段而重复计入', () => {
        // modelUsage 是运行总计，差值必须跨缓存边界连续；若增量段从零重算
        // 前一帧，第二帧会把整段总计再算一遍。
        const store = makeStore()
        const session = makeSession(store, 'cache-4')
        store.messages.addMessage(session.id, usageReportEnvelope({
            timestamp: '2026-08-08T00:00:00.000Z', model: 'opus', inputTokens: 100, outputTokens: 10
        }))
        aggregateUsageForSessions((store as any).db, [session.id])

        store.messages.addMessage(session.id, usageReportEnvelope({
            timestamp: '2026-08-08T01:00:00.000Z', model: 'opus', inputTokens: 250, outputTokens: 25
        }))
        const incremental = aggregateUsageForSessions((store as any).db, [session.id])

        __resetUsageEventCacheForTests()
        const fromScratch = aggregateUsageForSessions((store as any).db, [session.id])

        expect(incremental).toEqual(fromScratch)
        // 末帧总计 250/25，而不是 100+250。
        expect(incremental[0]?.inputTokens).toBe(250)
        expect(incremental[0]?.outputTokens).toBe(25)
    })

    it('跨会话去重顺序与冷缓存一致（seenTurn 键不含 sessionId）', () => {
        const store = makeStore()
        const a = makeSession(store, 'aaa-first')
        const b = makeSession(store, 'zzz-second')
        // 同一 message.id 出现在两个会话：只有字典序靠前的会话该计入。
        store.messages.addMessage(a.id, assistantEnvelope({
            messageId: 'shared', model: 'opus', timestamp: '2026-08-08T00:00:00.000Z', input: 11, output: 1
        }))
        store.messages.addMessage(b.id, assistantEnvelope({
            messageId: 'shared', model: 'opus', timestamp: '2026-08-08T00:00:00.000Z', input: 11, output: 1
        }))

        const warmed = aggregateUsageForSessions((store as any).db, [a.id, b.id])
        __resetUsageEventCacheForTests()
        const cold = aggregateUsageForSessions((store as any).db, [a.id, b.id])

        expect(warmed).toEqual(cold)
        expect(warmed).toEqual([{
            model: 'opus', requestCount: 1, inputTokens: 11, outputTokens: 1,
            cacheCreationInputTokens: 0, cacheReadInputTokens: 0
        }])
    })

    it('传入会话子集时不串用其他会话的缓存', () => {
        const store = makeStore()
        const a = makeSession(store, 'subset-a')
        const b = makeSession(store, 'subset-b')
        store.messages.addMessage(a.id, assistantEnvelope({
            messageId: 'a1', model: 'opus', timestamp: '2026-08-08T00:00:00.000Z', input: 100, output: 0
        }))
        store.messages.addMessage(b.id, assistantEnvelope({
            messageId: 'b1', model: 'opus', timestamp: '2026-08-08T00:00:00.000Z', input: 5, output: 0
        }))

        aggregateUsageForSessions((store as any).db, [a.id, b.id])
        const onlyB = aggregateUsageForSessions((store as any).db, [b.id])

        expect(onlyB).toEqual([{
            model: 'opus', requestCount: 1, inputTokens: 5, outputTokens: 0,
            cacheCreationInputTokens: 0, cacheReadInputTokens: 0
        }])
    })
})
