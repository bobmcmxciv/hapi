import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../../hub/src/store'
import { __resetUsageEventCacheForTests } from './usageAggregate'

/** Codex / Kimi / 一切 ACP 后端（cursor、grok、copilot、opencode）都只发
 *  `token_count`，从不发 `assistant`，也从不发 `usage_report`。补上这一支之前
 *  用量页对这些 flavor 的会话恒报 0——这组用例钉的就是那个洞。
 *  口径搬自上游 `hub/src/sync/usageService.ts` 的 parseUsageEvent。
 *
 *  **信封形状取自生产库实测**，不是照着 CLI 源码猜的：ECS 上 12 个非 Claude
 *  会话共 2,123 条消息，`content.type` 全部是 `'codex'`（没有一条 `'output'`），
 *  且 `data.timestamp` **一条都没有**。第一版用例按 `type:'output'` + 显式
 *  timestamp 写，把这两个错误假设一起固化了，于是两个真 bug 都测不出来：
 *  (1) token_count 分支被 `outer.type !== 'output'` 的提前 return 挡死；
 *  (2) 没有 data.timestamp 时 inWindow() 恒 false，事件被静默丢光。 */

const tmpDirs: string[] = []

function makeStore(): Store {
    // 用文件库而不是 :memory:，这样可以另开一个连接改 created_at
    // （时间窗对这些 flavor 只能按入库时刻判定）。
    const dir = mkdtempSync(join(tmpdir(), 'hapi-usage-'))
    tmpDirs.push(dir)
    return new Store(join(dir, 'test.db'))
}

function makeSession(store: Store, tag: string, flavor: string, model?: string) {
    return store.sessions.getOrCreateSession(
        tag,
        { path: `/tmp/${tag}`, flavor },
        null,
        'default',
        model
    )
}

/** 直接改库里的 created_at —— token_count 信封没有 data.timestamp，
 *  时间窗只能落回这一列。 */
function setCreatedAt(store: Store, sessionId: string, seq: number, iso: string): void {
    const db = new Database(store.dbPath)
    db.prepare('UPDATE messages SET created_at = ? WHERE session_id = ? AND seq = ?')
        .run(new Date(iso).getTime(), sessionId, seq)
    db.close()
}

type Nums = {
    inputTokens?: number
    outputTokens?: number
    cachedInputTokens?: number
    cacheWriteInputTokens?: number
}

/** Codex app-server 的 thread/tokenUsage/updated：info 里带线程累计 total 与本轮 last。 */
function codexFrame(input: {
    total: Nums
    last?: Nums
    threadId?: string
    turnId?: string
    model?: string
}) {
    return {
        role: 'agent',
        content: {
            type: 'codex',
            data: {
                type: 'token_count',
                ...(input.threadId ? { threadId: input.threadId } : {}),
                ...(input.turnId ? { turnId: input.turnId } : {}),
                ...(input.model ? { model: input.model } : {}),
                info: {
                    total: input.total,
                    ...(input.last ? { last: input.last } : {})
                }
            }
        }
    }
}

/** 通用 ACP 后端（cli/src/agent/messageConverter.ts）：把**每次请求**的用量
 *  包在 `total` 里发，是增量不是累计。 */
function acpFrame(input: { total: Nums; model?: string }) {
    return {
        role: 'agent',
        content: {
            type: 'acp',
            data: {
                type: 'token_count',
                ...(input.model ? { model: input.model } : {}),
                info: { total: input.total }
            }
        }
    }
}

describe('token_count 帧（Codex / ACP 后端）', () => {
    beforeEach(() => {
        __resetUsageEventCacheForTests()
    })
    afterEach(() => {
        while (tmpDirs.length) {
            try { rmSync(tmpDirs.pop()!, { recursive: true, force: true }) } catch { }
        }
    })

    it('修复前的洞：只有 token_count 的会话不再恒报 0', () => {
        const store = makeStore()
        const session = makeSession(store, 'codex-a', 'codex', 'gpt-5.3-codex')
        store.messages.addMessage(session.id, codexFrame({
            total: { inputTokens: 1_000, outputTokens: 200 },
            threadId: 't1'
        }))

        const rows = store.messages.aggregateUsageForSessions([session.id])
        expect(rows).toHaveLength(1)
        expect(rows[0]!.model).toBe('gpt-5.3-codex')
        expect(rows[0]!.outputTokens).toBe(200)
        expect(rows[0]!.inputTokens).toBe(1_000)
    })

    it('信封是 content.type=codex（生产库实测），不是 output——不能按 output 卡', () => {
        const store = makeStore()
        const session = makeSession(store, 'codex-env', 'codex', 'gpt-5.3-codex')
        const frame = codexFrame({ total: { inputTokens: 777 }, threadId: 't1' })
        expect(frame.content.type).toBe('codex')
        store.messages.addMessage(session.id, frame)

        expect(store.messages.aggregateUsageForSessions([session.id])[0]!.inputTokens).toBe(777)
    })

    it('没有 data.timestamp 时落回 created_at，不被时间窗静默丢光', () => {
        const store = makeStore()
        const session = makeSession(store, 'codex-ts', 'codex', 'gpt-5.3-codex')
        store.messages.addMessage(session.id, codexFrame({
            total: { inputTokens: 500 }, threadId: 't1'
        }))
        setCreatedAt(store, session.id, 1, '2026-08-01T00:00:00.000Z')
        __resetUsageEventCacheForTests()

        // 不带窗：必须能看到。
        expect(store.messages.aggregateUsageForSessions([session.id])[0]!.inputTokens).toBe(500)
        // 窗覆盖 created_at：仍能看到。
        __resetUsageEventCacheForTests()
        expect(store.messages.aggregateUsageForSessions(
            [session.id], { sinceIso: '2026-07-01T00:00:00.000Z' }
        )[0]!.inputTokens).toBe(500)
        // 窗在 created_at 之后：应被排除。
        __resetUsageEventCacheForTests()
        expect(store.messages.aggregateUsageForSessions(
            [session.id], { sinceIso: '2026-09-01T00:00:00.000Z' }
        )).toHaveLength(0)
    })

    it('Codex 的 total 是线程累计：多帧只记差值，不把每帧相加', () => {
        const store = makeStore()
        const session = makeSession(store, 'codex-b', 'codex', 'gpt-5.3-codex')
        for (const [i, input] of [1_000, 3_000, 7_000].entries()) {
            store.messages.addMessage(session.id, codexFrame({
                total: { inputTokens: input, outputTokens: input / 10 },
                threadId: 't1',
                turnId: `turn-${i}`
            }))
        }

        const rows = store.messages.aggregateUsageForSessions([session.id])
        // 累计到 7,000 就是 7,000；相加会得到 11,000。
        expect(rows[0]!.inputTokens).toBe(7_000)
        expect(rows[0]!.outputTokens).toBe(700)
    })

    it('ACP 后端的 total 是每请求增量：多帧相加，不做差', () => {
        const store = makeStore()
        const session = makeSession(store, 'cursor-a', 'cursor', 'grok-4.5')
        for (const input of [1_000, 3_000, 7_000]) {
            store.messages.addMessage(session.id, acpFrame({
                total: { inputTokens: input, outputTokens: 10 }
            }))
        }

        const rows = store.messages.aggregateUsageForSessions([session.id])
        // 增量相加 = 11,000；若误当累计做差只会得到 7,000。
        expect(rows[0]!.inputTokens).toBe(11_000)
        expect(rows[0]!.outputTokens).toBe(30)
    })

    it('inputTokens 已含缓存读：input 段扣掉 cacheRead，四段之和不把缓存记两遍', () => {
        const store = makeStore()
        const session = makeSession(store, 'codex-c', 'codex', 'gpt-5.3-codex')
        store.messages.addMessage(session.id, codexFrame({
            total: { inputTokens: 10_000, outputTokens: 500, cachedInputTokens: 8_000 },
            threadId: 't1'
        }))

        const row = store.messages.aggregateUsageForSessions([session.id])[0]!
        expect(row.cacheReadInputTokens).toBe(8_000)
        // 10,000 已经含那 8,000，所以未缓存部分只有 2,000。
        expect(row.inputTokens).toBe(2_000)
        const total = row.inputTokens + row.outputTokens
            + row.cacheCreationInputTokens + row.cacheReadInputTokens
        expect(total).toBe(10_500)
    })

    it('累计流回落（进程重启/换线程）用帧自带的 last 兜底，不整段重记', () => {
        const store = makeStore()
        const session = makeSession(store, 'codex-d', 'codex', 'gpt-5.3-codex')
        store.messages.addMessage(session.id, codexFrame({
            total: { inputTokens: 9_000, outputTokens: 900 },
            threadId: 't1',
            turnId: 'turn-1'
        }))
        // 计数器归零后重新爬升：差值为负，改用 last。
        store.messages.addMessage(session.id, codexFrame({
            total: { inputTokens: 500, outputTokens: 50 },
            last: { inputTokens: 500, outputTokens: 50 },
            threadId: 't1',
            turnId: 'turn-2'
        }))

        const row = store.messages.aggregateUsageForSessions([session.id])[0]!
        expect(row.inputTokens).toBe(9_500)
        expect(row.outputTokens).toBe(950)
    })

    it('导入的历史用量被排除，不与本机真实消耗重复计', () => {
        const store = makeStore()
        const session = makeSession(store, 'codex-e', 'codex', 'gpt-5.3-codex')
        const imported = codexFrame({ total: { inputTokens: 5_000 }, threadId: 't1' }) as any
        imported.content.data.hapiUsageScope = 'imported-history'
        store.messages.addMessage(session.id, imported)

        expect(store.messages.aggregateUsageForSessions([session.id])).toHaveLength(0)
    })

    it('帧自带 model 时优先用帧的，缺失才回落到会话 model', () => {
        const store = makeStore()
        const session = makeSession(store, 'codex-f', 'codex', 'session-model')
        store.messages.addMessage(session.id, codexFrame({
            total: { inputTokens: 100 }, threadId: 't1', turnId: 'a', model: 'frame-model'
        }))
        store.messages.addMessage(session.id, codexFrame({
            total: { inputTokens: 300 }, threadId: 't2', turnId: 'b'
        }))

        const models = store.messages.aggregateUsageForSessions([session.id])
            .map(r => r.model).sort()
        expect(models).toEqual(['frame-model', 'session-model'])
    })

    it('同一轮的重复累计快照（导入重放）只计一次', () => {
        const store = makeStore()
        const session = makeSession(store, 'codex-g', 'codex', 'gpt-5.3-codex')
        const frame = () => codexFrame({
            total: { inputTokens: 4_000, outputTokens: 400 },
            threadId: 't1',
            turnId: 'turn-1'
        })
        store.messages.addMessage(session.id, frame())
        store.messages.addMessage(session.id, frame())

        const row = store.messages.aggregateUsageForSessions([session.id])[0]!
        expect(row.inputTokens).toBe(4_000)
        expect(row.requestCount).toBe(1)
    })

    it('时间窗按差值归属，不让窗内首帧把整段线程累计算进来', () => {
        const store = makeStore()
        const session = makeSession(store, 'codex-h', 'codex', 'gpt-5.3-codex')
        store.messages.addMessage(session.id, codexFrame({
            total: { inputTokens: 8_000 }, threadId: 't1', turnId: 'turn-1'
        }))
        store.messages.addMessage(session.id, codexFrame({
            total: { inputTokens: 9_000 }, threadId: 't1', turnId: 'turn-2'
        }))
        setCreatedAt(store, session.id, 1, '2026-08-01T00:00:00.000Z')
        setCreatedAt(store, session.id, 2, '2026-08-03T00:00:00.000Z')
        __resetUsageEventCacheForTests()

        const rows = store.messages.aggregateUsageForSessions(
            [session.id],
            { sinceIso: '2026-08-02T00:00:00.000Z' }
        )
        // 窗内只有第二帧，它相对第一帧的增量是 1,000——不是 9,000。
        expect(rows[0]!.inputTokens).toBe(1_000)
    })
})
