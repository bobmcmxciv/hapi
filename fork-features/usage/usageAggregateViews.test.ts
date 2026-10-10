import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../../hub/src/store'
import {
    __resetUsageEventCacheForTests,
    aggregateUsageBuckets,
    aggregateUsageForSessions,
    aggregateUsageGroups,
    startUsageEventCacheWarmup,
    warmUsageEventCache,
    whenUsageEventCacheWarm,
    type UsageAggregateRow
} from './usageAggregate'
import { planBuckets } from './usageTimeseries'

/**
 * 一趟扫描喂多个视图（折线图的整段 + 各桶、总表 + 各机器）必须与逐个单独调用逐位相同。
 * 数据用固定种子随机生成，覆盖所有会跨窗口/跨会话带状态的分支：跨会话重复的 assistant 轮、
 * usage_report 运行总计（含回落）、代理会话帧改挂、Codex 累计流（含重放与回落）、ACP 增量帧。
 */

const tmpDirs: string[] = []
const START = Date.parse('2026-09-01T00:00:00.000Z')
const HOUR = 3600_000

function rng(seed: number): () => number {
    let state = seed >>> 0
    return () => {
        state = (state * 1664525 + 1013904223) >>> 0
        return state / 0x1_0000_0000
    }
}

function sorted(rows: UsageAggregateRow[]): UsageAggregateRow[] {
    return [...rows].sort((a, b) => a.model.localeCompare(b.model))
}

function buildFixture(seed: number): { store: Store; dbPath: string; ids: string[] } {
    const dir = mkdtempSync(join(tmpdir(), 'hapi-usage-views-'))
    tmpDirs.push(dir)
    const dbPath = join(dir, 'test.db')
    const store = new Store(dbPath)
    const random = rng(seed)
    const at = (hours: number) => new Date(START + hours * HOUR).toISOString()
    const int = (max: number) => Math.floor(random() * max)
    const session = (tag: string, flavor: string, model?: string) =>
        store.sessions.getOrCreateSession(tag, { path: `/tmp/${tag}`, flavor }, null, 'default', model)

    const ids: string[] = []
    const createdAtFixes: Array<{ sessionId: string; seq: number; iso: string }> = []

    // 三个 Claude 会话：直连（帧与 assistant 同名）、代理（帧名与 assistant 名无交集）、重复轮（与直连共享一批 message.id）。
    const direct = session('direct', 'claude')
    const proxy = session('proxy', 'claude')
    const dup = session('dup', 'claude')
    ids.push(direct.id, proxy.id, dup.id)
    const sharedIds: Array<{ id: string; hour: number }> = []
    let directFrame = { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }
    for (let i = 0; i < 60; i += 1) {
        const hour = i * 4 + int(4)
        const messageId = `msg-${i}`
        const model = i % 7 === 0 ? 'claude-haiku-4-5' : 'claude-opus-4-8'
        const usage = { input: int(500), output: int(800), cacheCreation: int(3) === 0 ? 0 : int(2000), cacheRead: int(9000) }
        // 同一轮写多行（Claude Code 逐 content block 写一行）。
        for (let copy = 0; copy < 1 + int(3); copy += 1) {
            store.messages.addMessage(direct.id, assistantEnvelope({ messageId, model, timestamp: at(hour), usage }))
        }
        if (i % 5 === 0) sharedIds.push({ id: messageId, hour })
        if (i % 6 === 0) {
            // 运行总计：通常递增，偶尔回落（进程重启）。
            directFrame = i % 30 === 0 && i > 0
                ? { inputTokens: int(400), outputTokens: int(400), cacheCreationInputTokens: int(400), cacheReadInputTokens: int(400) }
                : {
                    inputTokens: directFrame.inputTokens + int(3000),
                    outputTokens: directFrame.outputTokens + int(5000),
                    cacheCreationInputTokens: directFrame.cacheCreationInputTokens + int(4000),
                    cacheReadInputTokens: directFrame.cacheReadInputTokens + int(50000)
                }
            store.messages.addMessage(direct.id, usageReportEnvelope({ timestamp: at(hour + 1), modelUsage: { 'claude-opus-4-8[1m]': directFrame } }))
        }
    }
    let proxyFrame = { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }
    for (let i = 0; i < 40; i += 1) {
        const hour = i * 6 + int(6)
        store.messages.addMessage(proxy.id, assistantEnvelope({
            messageId: `proxy-${i}`, model: 'gpt-5.6-sol', timestamp: at(hour),
            usage: { input: int(20000), output: int(900), cacheRead: int(15000) }
        }))
        proxyFrame = {
            inputTokens: proxyFrame.inputTokens + int(30000),
            outputTokens: proxyFrame.outputTokens + int(1000),
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: proxyFrame.cacheReadInputTokens + int(20000)
        }
        store.messages.addMessage(proxy.id, usageReportEnvelope({
            timestamp: at(hour),
            modelUsage: { 'claude-opus-4-8[1m]': proxyFrame, 'claude-haiku-4-5': { inputTokens: i * 10, outputTokens: i * 3 } }
        }))
    }
    for (const shared of sharedIds) {
        store.messages.addMessage(dup.id, assistantEnvelope({
            messageId: shared.id, model: 'claude-opus-4-8', timestamp: at(shared.hour), usage: { input: 1, output: 2, cacheRead: 3 }
        }))
    }

    // Codex：线程累计流（两条线程），带同轮重放与回落；时间窗只能看 created_at。
    const codex = session('codex', 'codex', 'gpt-5.6-sol')
    ids.push(codex.id)
    let seq = 0
    for (const thread of ['t1', 't2']) {
        let total = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 }
        for (let turn = 0; turn < 25; turn += 1) {
            const last = { inputTokens: int(4000), outputTokens: int(600), cachedInputTokens: int(3000) }
            total = turn === 12
                ? { ...last }
                : { inputTokens: total.inputTokens + last.inputTokens, outputTokens: total.outputTokens + last.outputTokens, cachedInputTokens: total.cachedInputTokens + last.cachedInputTokens }
            const frame = codexFrame({ total, last, threadId: thread, turnId: `${thread}-${turn}`, model: turn % 9 === 0 ? undefined : 'gpt-5.6-sol' })
            const copies = turn % 8 === 0 ? 2 : 1
            for (let copy = 0; copy < copies; copy += 1) {
                store.messages.addMessage(codex.id, frame)
                seq += 1
                createdAtFixes.push({ sessionId: codex.id, seq, iso: at(turn * 9 + (thread === 't2' ? 3 : 0)) })
            }
        }
    }

    // ACP：每次请求的增量帧。
    const acp = session('acp', 'opencode', 'kimi-k3')
    ids.push(acp.id)
    for (let i = 0; i < 30; i += 1) {
        store.messages.addMessage(acp.id, acpFrame({ total: { inputTokens: int(3000), outputTokens: int(500), cachedInputTokens: int(1000) }, model: i % 4 ? 'kimi-k3' : undefined }))
        createdAtFixes.push({ sessionId: acp.id, seq: i + 1, iso: at(i * 8 + int(8)) })
    }

    // 没有消息的会话也要能出现在视图里。
    ids.push(session('empty', 'claude').id)

    const db = new Database(dbPath)
    const fix = db.prepare('UPDATE messages SET created_at = ? WHERE session_id = ? AND seq = ?')
    for (const item of createdAtFixes) fix.run(Date.parse(item.iso), item.sessionId, item.seq)
    db.close()
    return { store, dbPath, ids }
}

function assistantEnvelope(input: { messageId: string; model: string; timestamp: string; usage: { input?: number; output?: number; cacheCreation?: number; cacheRead?: number } }) {
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
                        input_tokens: input.usage.input ?? 0,
                        output_tokens: input.usage.output ?? 0,
                        cache_creation_input_tokens: input.usage.cacheCreation ?? 0,
                        cache_read_input_tokens: input.usage.cacheRead ?? 0
                    }
                }
            }
        }
    }
}

function usageReportEnvelope(input: { timestamp: string; modelUsage: Record<string, Record<string, number>> }) {
    return { role: 'agent', content: { type: 'output', data: { type: 'usage_report', timestamp: input.timestamp, modelUsage: input.modelUsage } } }
}

function codexFrame(input: { total: Record<string, number>; last: Record<string, number>; threadId: string; turnId: string; model?: string }) {
    return {
        role: 'agent',
        content: {
            type: 'codex',
            data: {
                type: 'token_count',
                threadId: input.threadId,
                turnId: input.turnId,
                ...(input.model ? { model: input.model } : {}),
                info: { total: input.total, last: input.last }
            }
        }
    }
}

function acpFrame(input: { total: Record<string, number>; model?: string }) {
    return { role: 'agent', content: { type: 'acp', data: { type: 'token_count', ...(input.model ? { model: input.model } : {}), info: { total: input.total } } } }
}

describe('一趟扫描多个视图 ≡ 逐个单独聚合', () => {
    beforeEach(() => __resetUsageEventCacheForTests())
    afterEach(() => {
        while (tmpDirs.length) {
            try { rmSync(tmpDirs.pop()!, { recursive: true, force: true }) } catch { }
        }
    })

    for (const seed of [1, 7, 42]) {
        it(`折线图：整段与每个时间桶（seed ${seed}）`, () => {
            const { store, ids } = buildFixture(seed)
            const db = (store as unknown as { db: Database }).db
            for (const unit of ['day', '6h', 'week'] as const) {
                const sinceMs = START - 12 * HOUR
                const untilMs = START + 250 * HOUR
                const buckets = planBuckets(sinceMs, untilMs, unit, 480)
                    .map(bucket => ({ sinceIso: new Date(bucket.start).toISOString(), untilIso: new Date(bucket.end).toISOString() }))
                const total = { sinceIso: buckets[0]!.sinceIso, untilIso: buckets[buckets.length - 1]!.untilIso }
                const batched = aggregateUsageBuckets(db, ids, total, buckets)
                expect(sorted(batched.total)).toEqual(sorted(aggregateUsageForSessions(db, ids, total)))
                buckets.forEach((bucket, index) => {
                    expect(sorted(batched.buckets[index]!)).toEqual(sorted(aggregateUsageForSessions(db, ids, bucket)))
                })
                expect(batched.total.length).toBeGreaterThan(0)
            }
        })

        it(`总表 + 各机器：重叠分组与开放时间窗（seed ${seed}）`, () => {
            const { store, ids } = buildFixture(seed)
            const db = (store as unknown as { db: Database }).db
            const random = rng(seed * 31)
            const groups = [ids, ...Array.from({ length: 6 }, () => ids.filter(() => random() < 0.5)), [ids[0]!, ids[0]!, ids[2]!], []]
            const windows = [
                {},
                { sinceIso: new Date(START + 30 * HOUR).toISOString() },
                { untilIso: new Date(START + 120 * HOUR).toISOString() },
                { sinceIso: new Date(START + 50 * HOUR).toISOString(), untilIso: new Date(START + 51 * HOUR).toISOString() }
            ]
            for (const window of windows) {
                const batched = aggregateUsageGroups(db, ids, window, groups)
                groups.forEach((group, index) => {
                    expect(sorted(batched[index]!)).toEqual(sorted(aggregateUsageForSessions(db, group, window)))
                })
            }
        })
    }

    it('时间桶必须升序且不重叠', () => {
        const { store, ids } = buildFixture(3)
        const db = (store as unknown as { db: Database }).db
        const a = { sinceIso: '2026-09-02T00:00:00.000Z', untilIso: '2026-09-03T00:00:00.000Z' }
        const b = { sinceIso: '2026-09-01T00:00:00.000Z', untilIso: '2026-09-02T12:00:00.000Z' }
        expect(() => aggregateUsageBuckets(db, ids, {}, [a, b])).toThrow('ascending')
    })

    it('分段预热后的缓存与一次性冷解码结果相同', async () => {
        const { store, ids } = buildFixture(11)
        const db = (store as unknown as { db: Database }).db
        const window = { sinceIso: new Date(START + 20 * HOUR).toISOString(), untilIso: new Date(START + 200 * HOUR).toISOString() }
        const cold = aggregateUsageForSessions(db, ids, window)
        __resetUsageEventCacheForTests()
        const warmed = await warmUsageEventCache(db, { budgetMs: 0, pauseMs: 0 })
        expect(warmed.sessions).toBe(ids.length)
        const total = (db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n
        expect(warmed.rows).toBe(total)
        expect(sorted(aggregateUsageForSessions(db, ids, window))).toEqual(sorted(cold))

        // 预热到一半后新增消息：后续聚合按 maxSeq 增量补齐，结果仍与冷解码一致。
        store.messages.addMessage(ids[0]!, assistantEnvelope({ messageId: 'late', model: 'claude-opus-4-8', timestamp: new Date(START + 100 * HOUR).toISOString(), usage: { input: 5, output: 5 } }))
        const incremental = aggregateUsageForSessions(db, ids, window)
        __resetUsageEventCacheForTests()
        expect(sorted(incremental)).toEqual(sorted(aggregateUsageForSessions(db, ids, window)))
    }, 60_000)

    it('冷缓存时用量请求等共享的分段预热，等待期间事件循环照常跑', async () => {
        const { store, ids } = buildFixture(13)
        const db = (store as unknown as { db: Database }).db
        const window = { sinceIso: new Date(START + 20 * HOUR).toISOString(), untilIso: new Date(START + 200 * HOUR).toISOString() }
        const cold = aggregateUsageForSessions(db, ids, window)
        __resetUsageEventCacheForTests()

        let ticks = 0
        const timer = setInterval(() => { ticks += 1 }, 0)
        try {
            // budgetMs 0 makes the warm-up yield after every session, as it does on a large database.
            const warmup = startUsageEventCacheWarmup(db, { budgetMs: 0, pauseMs: 0 })
            await whenUsageEventCacheWarm(db)
            expect((await warmup).sessions).toBe(ids.length)
        } finally {
            clearInterval(timer)
        }
        expect(ticks).toBeGreaterThan(0)
        expect(sorted(aggregateUsageForSessions(db, ids, window))).toEqual(sorted(cold))
    }, 60_000)

    it('请求先到时由它启动预热，启动定时器随后拿到的是同一次预热', async () => {
        const { store, ids } = buildFixture(17)
        const db = (store as unknown as { db: Database }).db
        __resetUsageEventCacheForTests()

        await whenUsageEventCacheWarm(db)
        const total = (db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n
        const shared = await startUsageEventCacheWarmup(db)
        expect(shared).toEqual({ sessions: ids.length, rows: total })
        expect(await startUsageEventCacheWarmup(db)).toBe(shared)
    }, 60_000)

    it('有上限地等：预热没完就回 false，路由据此回 503', async () => {
        const { store } = buildFixture(19)
        const db = (store as unknown as { db: Database }).db
        __resetUsageEventCacheForTests()

        const warmup = startUsageEventCacheWarmup(db, { budgetMs: 0, pauseMs: 5 })
        expect(await whenUsageEventCacheWarm(db, 1)).toBe(false)
        expect(await whenUsageEventCacheWarm(db)).toBe(true)
        await warmup
        expect(await whenUsageEventCacheWarm(db, 1)).toBe(true)
    }, 60_000)

    it('预热可以中途停下', async () => {
        const { store } = buildFixture(5)
        const db = (store as unknown as { db: Database }).db
        let calls = 0
        const result = await warmUsageEventCache(db, { budgetMs: 0, pauseMs: 0, shouldStop: () => ++calls > 3 })
        expect(result.sessions).toBeLessThan(6)
    }, 30_000)
})
