import { describe, expect, it } from 'vitest'
import type { DecryptedMessage } from '@/types/api'
import type { NormalizedMessage } from '@/chat/types'
import { applyUsageReportBackfill, computeUsageReportBackfill } from './usageReportBackfill'

let seq = 0
function assistantRow(id: string, apiMessageId: string, model: string, usage: Record<string, number>): DecryptedMessage {
    seq += 1
    return {
        id,
        localId: null,
        createdAt: seq,
        content: {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'assistant',
                    timestamp: new Date(1700000000000 + seq).toISOString(),
                    message: { id: apiMessageId, model, usage }
                }
            }
        }
    } as unknown as DecryptedMessage
}

function frame(id: string, modelUsage: Record<string, Record<string, number>>): DecryptedMessage {
    seq += 1
    return {
        id,
        localId: null,
        createdAt: seq,
        content: {
            role: 'agent',
            content: {
                type: 'output',
                data: { type: 'usage_report', timestamp: new Date(1700000000000 + seq).toISOString(), modelUsage }
            }
        }
    } as unknown as DecryptedMessage
}

const ZERO = { input_tokens: 0, output_tokens: 0 }

describe('computeUsageReportBackfill', () => {
    it('相邻帧差值回填到其间的全零轮（含变体后缀配对）', () => {
        const raw = [
            frame('f0', { 'gpt-5.6-sol[1m]': { inputTokens: 100, outputTokens: 10 } }),
            assistantRow('m1', 'api-1', 'gpt-5.6-sol', ZERO),
            frame('f1', { 'gpt-5.6-sol[1m]': { inputTokens: 350, outputTokens: 25 } })
        ]
        const patch = computeUsageReportBackfill(raw)
        expect(patch.get('m1')).toEqual({
            input_tokens: 250,
            output_tokens: 15,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0
        })
    })

    it('窗口内首帧只做基线，不把整段历史算给某一轮', () => {
        const raw = [
            assistantRow('m1', 'api-1', 'gpt-5.6-sol', ZERO),
            frame('f1', { 'gpt-5.6-sol': { inputTokens: 168_046, outputTokens: 15 } })
        ]
        expect(computeUsageReportBackfill(raw).size).toBe(0)
    })

    it('帧值回落视为进程重启，按全额计入', () => {
        const raw = [
            frame('f0', { m: { inputTokens: 900, outputTokens: 90 } }),
            assistantRow('m1', 'api-1', 'm', ZERO),
            frame('f1', { m: { inputTokens: 120, outputTokens: 6 } })
        ]
        expect(computeUsageReportBackfill(raw).get('m1')).toMatchObject({ input_tokens: 120, output_tokens: 6 })
    })

    it('同一 API 轮的多行拿到相同 delta（保持 turnFingerprint 不分裂）', () => {
        const raw = [
            frame('f0', { m: { inputTokens: 10, outputTokens: 1 } }),
            assistantRow('m1', 'api-1', 'm', ZERO),
            assistantRow('m2', 'api-1', 'm', ZERO),
            frame('f1', { m: { inputTokens: 40, outputTokens: 4 } })
        ]
        const patch = computeUsageReportBackfill(raw)
        expect(patch.get('m1')).toEqual(patch.get('m2'))
        expect(patch.get('m1')).toMatchObject({ input_tokens: 30, output_tokens: 3 })
    })

    it('非零 usage 的行（官方来源）绝不触碰', () => {
        const raw = [
            frame('f0', { m: { inputTokens: 10, outputTokens: 1 } }),
            assistantRow('m1', 'api-1', 'm', { input_tokens: 500, output_tokens: 42 }),
            frame('f1', { m: { inputTokens: 40, outputTokens: 4 } })
        ]
        expect(computeUsageReportBackfill(raw).size).toBe(0)
    })
})

describe('applyUsageReportBackfill', () => {
    it('只替换命中的归一化消息，其余保持原引用', () => {
        const raw = [
            frame('f0', { m: { inputTokens: 10, outputTokens: 1 } }),
            assistantRow('m1', 'api-1', 'm', ZERO),
            frame('f1', { m: { inputTokens: 40, outputTokens: 4 } })
        ]
        const untouched: NormalizedMessage = {
            id: 'other', localId: null, createdAt: 1, role: 'agent', isSidechain: false, content: [], meta: undefined
        } as unknown as NormalizedMessage
        const target: NormalizedMessage = {
            id: 'm1', localId: null, createdAt: 2, role: 'agent', isSidechain: false, content: [],
            model: 'm', usage: { input_tokens: 0, output_tokens: 0 }, meta: undefined
        } as unknown as NormalizedMessage
        const result = applyUsageReportBackfill(raw, [untouched, target])
        expect(result[0]).toBe(untouched)
        expect(result[1]).not.toBe(target)
        expect(result[1]!.usage).toMatchObject({ input_tokens: 30, output_tokens: 3 })
    })

    it('无帧时原样返回', () => {
        const target = { id: 'x', role: 'agent' } as unknown as NormalizedMessage
        expect(applyUsageReportBackfill([], [target])[0]).toBe(target)
    })
})
