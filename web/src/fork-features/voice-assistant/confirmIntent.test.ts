import { describe, expect, it } from 'vitest'
import { classifyConfirmation } from './confirmIntent'

describe('classifyConfirmation', () => {
    it('reads short spoken yes answers as send', () => {
        for (const text of ['确认', '确认发送', '对，确认发送。', '好的', '发吧', '嗯', '可以发', 'OK', '是的，发出去吧']) {
            expect(classifyConfirmation(text), text).toEqual({ decision: 'send', delivery: undefined })
        }
    })

    it('reads short spoken no answers as cancel', () => {
        for (const text of ['取消', '算了', '不要发', '别发了', '不用了']) {
            expect(classifyConfirmation(text), text).toEqual({ decision: 'cancel' })
        }
    })

    it('picks up an explicit interrupt or wait', () => {
        expect(classifyConfirmation('插队发吧')).toEqual({ decision: 'send', delivery: 'steer' })
        expect(classifyConfirmation('马上发送')).toEqual({ decision: 'send', delivery: 'steer' })
        expect(classifyConfirmation('好，排队发')).toEqual({ decision: 'send', delivery: 'queue' })
    })

    it('ignores real questions and requests, and mixed answers', () => {
        for (const text of ['好的，那你查一下视频那个会话的进度', '它现在做到哪了', '确认一下测试有没有跑完', '不要插队，排队发', '']) {
            expect(classifyConfirmation(text), text).toBeNull()
        }
    })
})
