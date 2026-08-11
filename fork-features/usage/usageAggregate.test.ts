import { describe, expect, it } from 'bun:test'
import { Store } from '../../hub/src/store'
import { buildUsageSummaryResponse, parseIsoParam, summarizeUsageHosts } from './usageAggregate'

function makeStore(): Store {
    return new Store(':memory:')
}

function makeSession(store: Store, tag: string) {
    return store.sessions.getOrCreateSession(tag, { path: `/tmp/${tag}` }, null, 'default')
}

/** 构造与 CLI 实时同步/导入写库一致的 assistant 消息信封。 */
function assistantEnvelope(input: {
    messageId: string
    model: string
    timestamp: string
    usage?: { input?: number; output?: number; cacheCreation?: number; cacheRead?: number }
}) {
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
                        input_tokens: input.usage?.input ?? 0,
                        output_tokens: input.usage?.output ?? 0,
                        cache_creation_input_tokens: input.usage?.cacheCreation ?? 0,
                        cache_read_input_tokens: input.usage?.cacheRead ?? 0
                    }
                }
            }
        }
    }
}

/** usage_report 记账帧信封：sdkToLogConverter 从 SDK result 消息产出。
 *  OpenAI 兼容上游只在流末尾给 usage，assistant 行的 usage 恒为 0，
 *  真实 token 只能从这里拿。
 *  modelUsage 是**运行总计**（同一个常驻 SDK 进程跨轮累加），不是每轮增量，
 *  所以聚合端取相邻帧差值而不是求和。 */
function usageReportEnvelope(input: {
    timestamp: string
    modelUsage: Record<string, {
        inputTokens?: number
        outputTokens?: number
        cacheCreationInputTokens?: number
        cacheReadInputTokens?: number
    }>
}) {
    return {
        role: 'agent',
        content: {
            type: 'output',
            data: {
                type: 'usage_report',
                timestamp: input.timestamp,
                modelUsage: input.modelUsage
            }
        }
    }
}

// 直接经 MessageStore 接缝调用，同时覆盖 fork 接缝与底层 SQL。
describe('aggregateUsageForSessions', () => {
    it('assistant 侧 usage 全为 0 的模型（OpenAI 兼容上游）改用 usage_report 的真实数字', () => {
        const store = makeStore()
        const session = makeSession(store, 'gpt-zero-usage')
        // cx2cc 这类代理必须在上游开口前发 message_start，只能填 0
        store.messages.addMessage(session.id, assistantEnvelope({
            messageId: 'msg_gpt_1', model: 'gpt-5.6-sol', timestamp: '2026-07-29T10:00:00.000Z'
        }))
        store.messages.addMessage(session.id, assistantEnvelope({
            messageId: 'msg_gpt_2', model: 'gpt-5.6-sol', timestamp: '2026-07-29T10:01:00.000Z'
        }))
        // 每轮一帧，帧内是运行总计而非增量
        store.messages.addMessage(session.id, usageReportEnvelope({
            timestamp: '2026-07-29T10:00:30.000Z',
            modelUsage: { 'gpt-5.6-sol': { inputTokens: 24958, outputTokens: 5 } }
        }))
        store.messages.addMessage(session.id, usageReportEnvelope({
            timestamp: '2026-07-29T10:01:30.000Z',
            modelUsage: { 'gpt-5.6-sol': { inputTokens: 49929, outputTokens: 10, cacheReadInputTokens: 22272 } }
        }))

        const rows = store.messages.aggregateUsageForSessions([session.id])
        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({
            model: 'gpt-5.6-sol',
            requestCount: 2,            // 仍按 assistant 的 API 轮次计数
            // 末帧即会话总量（不是 24958+49929），再扣掉含在里面的缓存读：
            // 中转上游的 inputTokens 是整段 prompt，49929 - 22272 = 27657 才是未命中量
            inputTokens: 27657,
            outputTokens: 10,
            cacheReadInputTokens: 22272
        })
    })

    it('modelUsage 是运行总计：多轮只记末帧，不把每帧相加（否则 n 轮放大 (n+1)/2 倍）', () => {
        const store = makeStore()
        const session = makeSession(store, 'cumulative-frames')
        // 线上 gpt-5.6-sol 三轮会话的真实帧序列
        for (const [ts, input, output] of [
            ['2026-08-02T14:56:00.000Z', 55931, 5],
            ['2026-08-02T14:57:00.000Z', 111945, 10],
            ['2026-08-02T14:58:00.000Z', 168046, 15]
        ] as Array<[string, number, number]>) {
            store.messages.addMessage(session.id, usageReportEnvelope({
                timestamp: ts,
                modelUsage: { 'gpt-5.6-sol': { inputTokens: input, outputTokens: output } }
            }))
        }

        const rows = store.messages.aggregateUsageForSessions([session.id])
        expect(rows).toHaveLength(1)
        // 求和会得到 335922（2 倍），正确答案是末帧 168046
        expect(rows[0]).toMatchObject({ model: 'gpt-5.6-sol', inputTokens: 168046, outputTokens: 15 })
    })

    it('会话被 resume 后计数器归零，按段累计而不是丢掉前一段', () => {
        const store = makeStore()
        const session = makeSession(store, 'counter-reset')
        for (const [ts, input] of [
            ['2026-08-02T14:56:00.000Z', 1000],
            ['2026-08-02T14:57:00.000Z', 2500],
            // 进程重启：新进程从头计
            ['2026-08-02T15:10:00.000Z', 700],
            ['2026-08-02T15:11:00.000Z', 1800]
        ] as Array<[string, number]>) {
            store.messages.addMessage(session.id, usageReportEnvelope({
                timestamp: ts, modelUsage: { 'gpt-5.6-sol': { inputTokens: input } }
            }))
        }

        const rows = store.messages.aggregateUsageForSessions([session.id])
        // 段一 2500 + 段二 1800 = 4300（既不是末帧 1800，也不是求和 6000）
        expect(rows[0]).toMatchObject({ model: 'gpt-5.6-sol', inputTokens: 4300 })
    })

    it('跨会话的运行总计各算各的，再相加', () => {
        const store = makeStore()
        const a = makeSession(store, 'cume-a')
        const b = makeSession(store, 'cume-b')
        for (const input of [100, 300]) {
            store.messages.addMessage(a.id, usageReportEnvelope({
                timestamp: '2026-08-02T14:56:00.000Z', modelUsage: { 'gpt-5.6-sol': { inputTokens: input } }
            }))
        }
        for (const input of [50, 90]) {
            store.messages.addMessage(b.id, usageReportEnvelope({
                timestamp: '2026-08-02T14:56:00.000Z', modelUsage: { 'gpt-5.6-sol': { inputTokens: input } }
            }))
        }

        const rows = store.messages.aggregateUsageForSessions([a.id, b.id])
        expect(rows[0]).toMatchObject({ model: 'gpt-5.6-sol', inputTokens: 390 })  // 300 + 90
    })

    it('时间窗按帧的增量归属，不让窗内首帧把整段运行总计算进来', () => {
        const store = makeStore()
        const session = makeSession(store, 'cume-window')
        for (const [ts, input] of [
            ['2026-08-02T10:00:00.000Z', 1000],
            ['2026-08-02T11:00:00.000Z', 3000],
            ['2026-08-02T12:00:00.000Z', 3600]
        ] as Array<[string, number]>) {
            store.messages.addMessage(session.id, usageReportEnvelope({
                timestamp: ts, modelUsage: { 'gpt-5.6-sol': { inputTokens: input } }
            }))
        }

        // 只看 11:00 起：应是 2000 + 600 = 2600，而不是把 3000 整个算进来
        const rows = store.messages.aggregateUsageForSessions([session.id], {
            sinceIso: '2026-08-02T10:30:00.000Z'
        })
        expect(rows[0]).toMatchObject({ model: 'gpt-5.6-sol', inputTokens: 2600 })
    })

    it('assistant 侧只剩涓流（流式恒 0、零星非流式有真数）而帧更大时，整体改用帧——两源取大，不相加', () => {
        const store = makeStore()
        const session = makeSession(store, 'trickle')
        // 线上 hub 实测形态（2026-08-06）：8090 轮 gpt-5.6-sol 的 assistant 行合计仅 70 万
        // token（全部来自零星非流式轮），帧里是 1.34 亿。旧规则「全零才替换」被这股
        // 涓流卡死，帧数据整个被丢弃。
        store.messages.addMessage(session.id, assistantEnvelope({
            messageId: 'msg_t1', model: 'gpt-5.6-sol', timestamp: '2026-08-06T10:00:00.000Z'
        }))
        store.messages.addMessage(session.id, assistantEnvelope({
            messageId: 'msg_t2', model: 'gpt-5.6-sol', timestamp: '2026-08-06T10:01:00.000Z',
            usage: { input: 66276, output: 120 }
        }))
        store.messages.addMessage(session.id, usageReportEnvelope({
            timestamp: '2026-08-06T10:01:30.000Z',
            modelUsage: { 'gpt-5.6-sol': { inputTokens: 17753347, outputTokens: 26271, cacheReadInputTokens: 15860736 } }
        }))

        const rows = store.messages.aggregateUsageForSessions([session.id])
        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({
            model: 'gpt-5.6-sol',
            requestCount: 2,
            inputTokens: 1892611,       // 17753347 - 15860736，缓存读不再被计两遍
            outputTokens: 26271,
            cacheReadInputTokens: 15860736
        })
    })

    it('代理会话的帧按底层 Claude 名上报时，归到会话自己的模型行，不挂到 Claude 行', () => {
        const store = makeStore()
        const session = makeSession(store, 'proxy-rehome')
        // cx2cc 形态：assistant 行写代理别名，result.modelUsage 却按真正在服务的
        // Claude 模型记账（含 haiku 子代理）。两边模型名毫无交集。
        store.messages.addMessage(session.id, assistantEnvelope({
            messageId: 'msg_p1', model: 'gpt-5.6-sol', timestamp: '2026-08-08T10:00:00.000Z'
        }))
        store.messages.addMessage(session.id, usageReportEnvelope({
            timestamp: '2026-08-08T10:00:30.000Z',
            modelUsage: {
                'claude-opus-4-8[1m]': { inputTokens: 900, outputTokens: 90 },
                'claude-haiku-4-5': { inputTokens: 10, outputTokens: 1 }
            }
        }))

        const rows = store.messages.aggregateUsageForSessions([session.id])
        expect(rows).toHaveLength(1)
        // 子代理 haiku 也并入：用户从没单独选过它，它花的是这个代理会话的预算
        expect(rows[0]).toMatchObject({
            model: 'gpt-5.6-sol', requestCount: 1, inputTokens: 910, outputTokens: 91
        })
        expect(rows.some(r => r.model.startsWith('claude-'))).toBe(false)
    })

    it('直连会话的帧不被改挂：Task 子代理仍单独成行', () => {
        const store = makeStore()
        const session = makeSession(store, 'direct-subagent')
        store.messages.addMessage(session.id, assistantEnvelope({
            messageId: 'msg_d1', model: 'claude-opus-4-8', timestamp: '2026-08-08T10:00:00.000Z',
            usage: { input: 5, output: 2 }
        }))
        store.messages.addMessage(session.id, usageReportEnvelope({
            timestamp: '2026-08-08T10:00:30.000Z',
            modelUsage: {
                'claude-opus-4-8[1m]': { inputTokens: 900, outputTokens: 90 },
                'claude-haiku-4-5': { inputTokens: 10, outputTokens: 1 }
            }
        }))

        const rows = store.messages.aggregateUsageForSessions([session.id])
        const byModel = Object.fromEntries(rows.map(r => [r.model, r]))
        expect(Object.keys(byModel).sort()).toEqual(['claude-haiku-4-5', 'claude-opus-4-8'])
        expect(byModel['claude-opus-4-8']).toMatchObject({ inputTokens: 900, requestCount: 1 })
        expect(byModel['claude-haiku-4-5']).toMatchObject({ inputTokens: 10, requestCount: 0 })
    })

    it('直连会话的大数字不再吃掉另一个代理会话的同名帧（线上 opus-4-8 丢 7.09 亿的形态）', () => {
        const store = makeStore()
        const direct = makeSession(store, 'mix-direct')
        const proxy = makeSession(store, 'mix-proxy')
        // 直连会话：assistant 侧就有真数，帧与之等值（同一批轮的两个视图）
        store.messages.addMessage(direct.id, assistantEnvelope({
            messageId: 'msg_dd', model: 'claude-opus-4-8', timestamp: '2026-08-08T10:00:00.000Z',
            usage: { input: 10000 }
        }))
        store.messages.addMessage(direct.id, usageReportEnvelope({
            timestamp: '2026-08-08T10:00:30.000Z',
            modelUsage: { 'claude-opus-4-8[1m]': { inputTokens: 10000 } }
        }))
        // 代理会话：assistant 侧只有涓流，帧按 Claude 名记
        store.messages.addMessage(proxy.id, assistantEnvelope({
            messageId: 'msg_pp', model: 'gpt-5.6-sol', timestamp: '2026-08-08T10:10:00.000Z',
            usage: { input: 7 }
        }))
        store.messages.addMessage(proxy.id, usageReportEnvelope({
            timestamp: '2026-08-08T10:10:30.000Z',
            modelUsage: { 'claude-opus-4-8[1m]': { inputTokens: 3000 } }
        }))

        const rows = store.messages.aggregateUsageForSessions([direct.id, proxy.id])
        const byModel = Object.fromEntries(rows.map(r => [r.model, r]))
        // 旧的全局 max 会得到 opus-4-8=13000（两会话帧相加后胜出）或丢掉 3000；
        // 逐会话结算后：直连的 10000 归 opus-4-8，代理的 3000 归别名，一分不丢也不混。
        expect(byModel['claude-opus-4-8']).toMatchObject({ inputTokens: 10000, requestCount: 1 })
        expect(byModel['gpt-5.6-sol']).toMatchObject({ inputTokens: 3000, requestCount: 1 })
        const grandTotal = rows.reduce((sum, r) => sum + r.inputTokens, 0)
        expect(grandTotal).toBe(13000)
    })

    it('帧比 assistant 小（帧只覆盖窗口一部分）时保留 assistant 数字', () => {
        const store = makeStore()
        const session = makeSession(store, 'frames-smaller')
        store.messages.addMessage(session.id, assistantEnvelope({
            messageId: 'msg_f1', model: 'claude-sonnet-5', timestamp: '2026-08-06T10:00:00.000Z',
            usage: { input: 1000, output: 200, cacheRead: 5000 }
        }))
        // 帧序列只捕到了会话末尾一小段
        store.messages.addMessage(session.id, usageReportEnvelope({
            timestamp: '2026-08-06T10:00:30.000Z',
            modelUsage: { 'claude-sonnet-5': { inputTokens: 400, outputTokens: 80 } }
        }))

        const rows = store.messages.aggregateUsageForSessions([session.id])
        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({
            model: 'claude-sonnet-5', requestCount: 1,
            inputTokens: 1000, outputTokens: 200, cacheReadInputTokens: 5000
        })
    })

    it('assistant 侧已有真实 usage 时忽略 usage_report，绝不相加（否则 Claude 官方来源数字翻倍）', () => {
        const store = makeStore()
        const session = makeSession(store, 'claude-no-double-count')
        store.messages.addMessage(session.id, assistantEnvelope({
            messageId: 'msg_c1', model: 'claude-opus-4-8', timestamp: '2026-07-29T10:00:00.000Z',
            usage: { input: 551, output: 109, cacheCreation: 6813 }
        }))
        // Claude 会话同样会产出 result → usage_report，数字与 assistant 侧重复
        store.messages.addMessage(session.id, usageReportEnvelope({
            timestamp: '2026-07-29T10:00:30.000Z',
            modelUsage: { 'claude-opus-4-8': { inputTokens: 551, outputTokens: 109, cacheCreationInputTokens: 6813 } }
        }))

        const rows = store.messages.aggregateUsageForSessions([session.id])
        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({
            model: 'claude-opus-4-8',
            requestCount: 1,
            inputTokens: 551,
            outputTokens: 109,
            cacheCreationInputTokens: 6813
        })
    })

    it('只在 usage_report 中出现的模型也产出一行', () => {
        const store = makeStore()
        const session = makeSession(store, 'report-only')
        store.messages.addMessage(session.id, usageReportEnvelope({
            timestamp: '2026-07-29T10:00:00.000Z',
            modelUsage: { 'gpt-5.6-sol-mini': { inputTokens: 1200, outputTokens: 30 } }
        }))

        const rows = store.messages.aggregateUsageForSessions([session.id])
        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({ model: 'gpt-5.6-sol-mini', requestCount: 0, inputTokens: 1200 })
    })

    it('modelUsage 带 [1m] 变体后缀时仍能配上 assistant 行（两边命名口径不同）', () => {
        const store = makeStore()
        const session = makeSession(store, 'variant-suffix')
        // assistant 侧的 message.model 永远是裸名
        store.messages.addMessage(session.id, assistantEnvelope({
            messageId: 'msg_v1', model: 'gpt-5.6-sol', timestamp: '2026-08-02T15:04:00.000Z'
        }))
        // 而 result.modelUsage 的键带变体后缀
        store.messages.addMessage(session.id, usageReportEnvelope({
            timestamp: '2026-08-02T15:04:20.000Z',
            modelUsage: { 'gpt-5.6-sol[1m]': { inputTokens: 193152, outputTokens: 2269, cacheReadInputTokens: 95488 } }
        }))

        const rows = store.messages.aggregateUsageForSessions([session.id])
        // 只有一行，且是裸名；不再裂成「有请求无 token」+「有 token 无请求」两行
        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({
            model: 'gpt-5.6-sol',
            requestCount: 1,
            inputTokens: 97664,         // 193152 - 95488
            outputTokens: 2269,
            cacheReadInputTokens: 95488
        })
    })

    it('同一模型的多个变体合并进同一行', () => {
        const store = makeStore()
        const a = makeSession(store, 'variant-a')
        const b = makeSession(store, 'variant-b')
        store.messages.addMessage(a.id, assistantEnvelope({
            messageId: 'msg_a', model: 'gpt-5.6-sol', timestamp: '2026-08-02T15:00:00.000Z'
        }))
        store.messages.addMessage(a.id, usageReportEnvelope({
            timestamp: '2026-08-02T15:00:30.000Z',
            modelUsage: { 'gpt-5.6-sol': { inputTokens: 168046 } }
        }))
        store.messages.addMessage(b.id, usageReportEnvelope({
            timestamp: '2026-08-02T15:05:00.000Z',
            modelUsage: { 'gpt-5.6-sol[1m]': { inputTokens: 227938 } }
        }))

        const rows = store.messages.aggregateUsageForSessions([a.id, b.id])
        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({ model: 'gpt-5.6-sol', requestCount: 1, inputTokens: 168046 + 227938 })
    })

    it('只在 usage_report 出现的变体，补出来的行用裸名', () => {
        const store = makeStore()
        const session = makeSession(store, 'variant-only')
        store.messages.addMessage(session.id, usageReportEnvelope({
            timestamp: '2026-08-02T15:00:00.000Z',
            modelUsage: { 'claude-opus-5[1m]': { inputTokens: 4242 } }
        }))

        const rows = store.messages.aggregateUsageForSessions([session.id])
        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({ model: 'claude-opus-5', requestCount: 0, inputTokens: 4242 })
    })

    // —— input 含缓存读的中转上游：缓存读不能被计两遍 ——
    // 生产库 2026-08-10 实证：cx2cc 会话 a00487b4 的帧差值合计 input=76,788,086，
    // 而同会话 assistant 行 input+cacheRead=76,784,812（差 0.004%）——帧的 input
    // 就是「未命中 + 命中」的整段 prompt。不扣的话命中率被摊薄近一半（47% vs 87%）。
    describe('inclusive-input 归一', () => {
        it('帧的 input 含缓存读时扣掉，命中率不再被摊薄', () => {
            const store = makeStore()
            const session = makeSession(store, 'inclusive-frame')
            store.messages.addMessage(session.id, assistantEnvelope({
                messageId: 'msg_i1', model: 'gpt-5.6-sol', timestamp: '2026-08-09T10:00:00.000Z'
            }))
            store.messages.addMessage(session.id, usageReportEnvelope({
                timestamp: '2026-08-09T10:00:30.000Z',
                modelUsage: {
                    'gpt-5.6-sol': {
                        inputTokens: 56277494, outputTokens: 430199,
                        cacheReadInputTokens: 50156350, cacheCreationInputTokens: 0
                    }
                }
            }))

            const [row] = store.messages.aggregateUsageForSessions([session.id])
            expect(row).toMatchObject({
                model: 'gpt-5.6-sol',
                inputTokens: 56277494 - 50156350,
                cacheReadInputTokens: 50156350,
                cacheCreationInputTokens: 0
            })
            const hit = row.cacheReadInputTokens
                / (row.inputTokens + row.cacheReadInputTokens + row.cacheCreationInputTokens)
            expect(hit).toBeGreaterThan(0.88)
        })

        it('直连 Anthropic 一位不动：cacheCreation 非 0 就不是中转口径', () => {
            const store = makeStore()
            const session = makeSession(store, 'direct-anthropic')
            // vircs 直连实测形态：input 只是未缓存的尾巴，cacheCreation 恒有值
            store.messages.addMessage(session.id, assistantEnvelope({
                messageId: 'msg_d1', model: 'claude-opus-5', timestamp: '2026-08-09T11:00:00.000Z',
                usage: { input: 68, output: 13159, cacheRead: 20750361, cacheCreation: 614500 }
            }))

            const [row] = store.messages.aggregateUsageForSessions([session.id])
            expect(row).toMatchObject({
                model: 'claude-opus-5',
                inputTokens: 68,
                cacheReadInputTokens: 20750361,
                cacheCreationInputTokens: 614500
            })
        })

        it('cacheRead > input 时不扣：那是 Anthropic 的「未缓存尾巴」口径，减了会算成负数', () => {
            const store = makeStore()
            const session = makeSession(store, 'read-exceeds-input')
            // cacheCreation 为 0 但 cacheRead 远大于 input——续用上一轮缓存、本轮没写入
            store.messages.addMessage(session.id, assistantEnvelope({
                messageId: 'msg_r1', model: 'claude-sonnet-5', timestamp: '2026-08-09T12:00:00.000Z',
                usage: { input: 194, output: 59777, cacheRead: 61831508 }
            }))

            const [row] = store.messages.aggregateUsageForSessions([session.id])
            expect(row).toMatchObject({ inputTokens: 194, cacheReadInputTokens: 61831508 })
        })

        it('按桶判而非按行判：同一会话里有过缓存写入，就整桶按直连处理', () => {
            const store = makeStore()
            const session = makeSession(store, 'bucket-level')
            // 第一轮写缓存（cacheRead=0），第二轮只读不写且 input 恰好大于 cacheRead。
            // 逐行判会把第二轮误判成中转口径并扣掉 3000；按桶判则因整桶 cacheCreation
            // 非 0 而放行。
            store.messages.addMessage(session.id, assistantEnvelope({
                messageId: 'msg_b1', model: 'claude-opus-5', timestamp: '2026-08-09T13:00:00.000Z',
                usage: { input: 500, output: 10, cacheCreation: 40000 }
            }))
            store.messages.addMessage(session.id, assistantEnvelope({
                messageId: 'msg_b2', model: 'claude-opus-5', timestamp: '2026-08-09T13:01:00.000Z',
                usage: { input: 9000, output: 20, cacheRead: 3000 }
            }))

            const [row] = store.messages.aggregateUsageForSessions([session.id])
            expect(row).toMatchObject({
                inputTokens: 9500,
                cacheReadInputTokens: 3000,
                cacheCreationInputTokens: 40000
            })
        })

        it('token_count 那支已逐帧扣过，不会被再扣一遍', () => {
            const store = makeStore()
            const session = store.sessions.getOrCreateSession(
                'agent-usage-no-double',
                { path: '/tmp/agent-usage-no-double', flavor: 'kimi' },
                null,
                'default'
            )
            // ACP 后端：input 含缓存读（12000 里有 4000 是命中），命中率低于 50%，
            // 所以扣完之后 input(8000) > cacheRead(4000) 且 cacheCreation=0——
            // 正是 normalizeInclusiveInput 的判据形状，必须靠 agentUsageBuckets 挡住。
            store.messages.addMessage(session.id, {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'token_count',
                        timestamp: '2026-08-09T14:00:00.000Z',
                        model: 'kimi-for-coding',
                        info: { total: { inputTokens: 12000, outputTokens: 300, cachedInputTokens: 4000 } }
                    }
                }
            })

            const [row] = store.messages.aggregateUsageForSessions([session.id])
            expect(row).toMatchObject({
                model: 'kimi-for-coding',
                inputTokens: 8000,          // 12000 - 4000，只扣一次
                cacheReadInputTokens: 4000
            })
        })
    })

    it('token 全为 0 的 usage_report-only 模型不产出幽灵行', () => {
        const store = makeStore()
        const session = makeSession(store, 'phantom')
        store.messages.addMessage(session.id, usageReportEnvelope({
            timestamp: '2026-08-02T15:00:00.000Z',
            modelUsage: { 'claude-opus-4-8[1m]': { inputTokens: 0, outputTokens: 0 } }
        }))

        expect(store.messages.aggregateUsageForSessions([session.id])).toHaveLength(0)
    })

    it('assistant 侧已有真数时，带变体后缀的 usage_report 也不能叠加', () => {
        const store = makeStore()
        const session = makeSession(store, 'variant-no-double')
        store.messages.addMessage(session.id, assistantEnvelope({
            messageId: 'msg_c', model: 'claude-opus-5', timestamp: '2026-08-02T15:00:00.000Z',
            usage: { input: 551, output: 109, cacheCreation: 6813 }
        }))
        store.messages.addMessage(session.id, usageReportEnvelope({
            timestamp: '2026-08-02T15:00:30.000Z',
            modelUsage: { 'claude-opus-5[1m]': { inputTokens: 551, outputTokens: 109, cacheCreationInputTokens: 6813 } }
        }))

        const rows = store.messages.aggregateUsageForSessions([session.id])
        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({
            model: 'claude-opus-5', requestCount: 1, inputTokens: 551, outputTokens: 109, cacheCreationInputTokens: 6813
        })
    })

    it('同一 message.id 的多行只按一次请求计数（Claude Code 每个 content block 写一行，usage 整份重复）', () => {
        const store = makeStore()
        const session = makeSession(store, 'dedup')
        const envelope = assistantEnvelope({
            messageId: 'msg_turn_1',
            model: 'claude-fable-5',
            timestamp: '2026-07-20T10:00:00.000Z',
            usage: { input: 100, output: 50, cacheCreation: 10, cacheRead: 1000 }
        })
        store.messages.addMessage(session.id, envelope)
        store.messages.addMessage(session.id, envelope)
        store.messages.addMessage(session.id, envelope)

        const rows = store.messages.aggregateUsageForSessions([session.id])
        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({
            model: 'claude-fable-5',
            requestCount: 1,
            inputTokens: 100,
            outputTokens: 50,
            cacheCreationInputTokens: 10,
            cacheReadInputTokens: 1000
        })
    })

    it('不同模型分开聚合，非 assistant 行与缺 message.id 的行被忽略', () => {
        const store = makeStore()
        const session = makeSession(store, 'models')
        store.messages.addMessage(session.id, assistantEnvelope({
            messageId: 'msg_a', model: 'claude-fable-5', timestamp: '2026-07-20T10:00:00.000Z', usage: { input: 10 }
        }))
        store.messages.addMessage(session.id, assistantEnvelope({
            messageId: 'msg_b', model: 'claude-opus-5', timestamp: '2026-07-20T11:00:00.000Z', usage: { output: 20 }
        }))
        // 用户消息（不含 usage 结构）不计入
        store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'hi "usage" mention' } })
        // agent 行但缺 message.id（如控制帧）不计入
        store.messages.addMessage(session.id, {
            role: 'agent',
            content: { type: 'output', data: { type: 'assistant', timestamp: '2026-07-20T12:00:00.000Z', message: { model: 'x', usage: { input_tokens: 999 } } } }
        })
        // Claude Code 本地合成的占位消息（model = '<synthetic>'）不计入
        store.messages.addMessage(session.id, assistantEnvelope({
            messageId: 'msg_synthetic', model: '<synthetic>', timestamp: '2026-07-20T13:00:00.000Z', usage: { input: 777 }
        }))

        const rows = store.messages.aggregateUsageForSessions([session.id])
        const models = rows.map(r => r.model).sort()
        expect(models).toEqual(['claude-fable-5', 'claude-opus-5'])
        expect(rows.reduce((sum, r) => sum + r.inputTokens, 0)).toBe(10)
        expect(rows.reduce((sum, r) => sum + r.outputTokens, 0)).toBe(20)
    })

    it('since 含端点、until 为开区间，按 content.data.timestamp 而非 created_at 过滤', () => {
        const store = makeStore()
        const session = makeSession(store, 'time')
        const at = (day: string, id: string) => store.messages.addMessage(session.id, assistantEnvelope({
            messageId: id, model: 'm', timestamp: `2026-07-${day}T00:00:00.000Z`, usage: { input: 1 }
        }))
        at('10', 'msg_1')
        at('15', 'msg_2')
        at('20', 'msg_3')

        const middle = store.messages.aggregateUsageForSessions([session.id], {
            sinceIso: '2026-07-15T00:00:00.000Z',
            untilIso: '2026-07-20T00:00:00.000Z'
        })
        expect(middle[0]?.requestCount).toBe(1)

        const fromMiddle = store.messages.aggregateUsageForSessions([session.id], { sinceIso: '2026-07-15T00:00:00.000Z' })
        expect(fromMiddle[0]?.requestCount).toBe(2)
    })

    it('只统计传入的 sessionIds；空列表直接返回空', () => {
        const store = makeStore()
        const mine = makeSession(store, 'mine')
        const theirs = makeSession(store, 'theirs')
        store.messages.addMessage(mine.id, assistantEnvelope({
            messageId: 'msg_mine', model: 'm', timestamp: '2026-07-20T10:00:00.000Z', usage: { input: 5 }
        }))
        store.messages.addMessage(theirs.id, assistantEnvelope({
            messageId: 'msg_theirs', model: 'm', timestamp: '2026-07-20T10:00:00.000Z', usage: { input: 7 }
        }))

        const rows = store.messages.aggregateUsageForSessions([mine.id])
        expect(rows[0]?.inputTokens).toBe(5)
        expect(store.messages.aggregateUsageForSessions([])).toEqual([])
    })
})

describe('parseIsoParam', () => {
    it('接受 ISO 串并规整为 UTC ISO', () => {
        expect(parseIsoParam('2026-07-20T10:00:00.000Z')).toBe('2026-07-20T10:00:00.000Z')
    })
    it('接受毫秒时间戳数字串', () => {
        expect(parseIsoParam('0')).toBe('1970-01-01T00:00:00.000Z')
    })
    it('非法/空输入返回 null（= 不筛选）', () => {
        expect(parseIsoParam(undefined)).toBeNull()
        expect(parseIsoParam('')).toBeNull()
        expect(parseIsoParam('not-a-date')).toBeNull()
    })
})

describe('buildUsageSummaryResponse', () => {
    it('按合计降序排序并汇总 totals', () => {
        const small = { model: 'small', requestCount: 1, inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }
        const large = { model: 'large', requestCount: 2, inputTokens: 100, outputTokens: 100, cacheCreationInputTokens: 100, cacheReadInputTokens: 100 }
        const vircs = { host: 'vircs', sessionCount: 2, totalTokens: 404, requestCount: 3, owner: 'admin', platform: 'win32' }
        const response = buildUsageSummaryResponse([small, large], [vircs], { since: null, until: null, host: null }, 123)
        expect(response.models.map(m => m.model)).toEqual(['large', 'small'])
        expect(response.totals).toEqual({
            requestCount: 3,
            inputTokens: 101,
            outputTokens: 101,
            cacheCreationInputTokens: 100,
            cacheReadInputTokens: 100
        })
        expect(response.hosts).toEqual([vircs])
        expect(response.generatedAt).toBe(123)
    })
})

describe('summarizeUsageHosts', () => {
    const row = (model: string, requestCount: number, inputTokens: number) => ({
        model, requestCount, inputTokens, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0
    })

    it('按 host 分桶，汇总 token 与请求数，并按用量降序', () => {
        const sessions = [
            { id: 'a1', host: 'vircs', platform: 'win32', owner: 'admin' },
            { id: 'a2', host: 'vircs', platform: 'win32', owner: 'admin' },
            { id: 'b1', host: 'peter-mac', platform: 'darwin', owner: 'peter' }
        ]
        const perSession: Record<string, number> = { a1: 30, a2: 70, b1: 500 }
        const hosts = summarizeUsageHosts(sessions, ids =>
            ids.map(id => row('m', 1, perSession[id])))

        expect(hosts.map(h => h.host)).toEqual(['peter-mac', 'vircs'])
        expect(hosts[0]).toEqual({ host: 'peter-mac', sessionCount: 1, totalTokens: 500, requestCount: 1, owner: 'peter', platform: 'darwin' })
        expect(hosts[1]).toEqual({ host: 'vircs', sessionCount: 2, totalTokens: 100, requestCount: 2, owner: 'admin', platform: 'win32' })
    })

    it('同一 host 只有部分会话带 os/归属时，取第一个非空的', () => {
        const hosts = summarizeUsageHosts([
            { id: 'a1', host: 'vircs', platform: null, owner: null },
            { id: 'a2', host: 'vircs', platform: 'win32', owner: 'admin' }
        ], () => [])

        expect(hosts[0]).toMatchObject({ platform: 'win32', owner: 'admin' })
    })

    it('丢掉没有 host 的会话，而不是造一台空名机器', () => {
        const hosts = summarizeUsageHosts([
            { id: 'a1', host: null, platform: null, owner: null },
            { id: 'a2', host: 'vircs', platform: 'win32', owner: 'admin' }
        ], ids => ids.map(() => row('m', 1, 5)))

        expect(hosts.map(h => h.host)).toEqual(['vircs'])
        expect(hosts[0].sessionCount).toBe(1)
    })

    it('用量相同时按机器名稳定排序', () => {
        const hosts = summarizeUsageHosts([
            { id: 'b', host: 'zeta', platform: null, owner: null },
            { id: 'a', host: 'alpha', platform: null, owner: null }
        ], ids => ids.map(() => row('m', 1, 10)))

        expect(hosts.map(h => h.host)).toEqual(['alpha', 'zeta'])
    })
})
