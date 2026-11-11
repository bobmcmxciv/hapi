import { describe, expect, it } from 'bun:test'
import { MessagesQuerySchema } from './apiTypes'
import { isInvokedUserTurn, mergeTurnSegments, type MessageTurnSegment } from './messageTurns'

function segment(from: number, to: number, completeBefore: boolean, completeAfter: boolean): MessageTurnSegment {
    return { turnId: 'user', from: { at: from, seq: from }, to: { at: to, seq: to }, completeBefore, completeAfter }
}

describe('turn page protocol', () => {
    it('accepts bounded turn counts and selected-turn collection without changing legacy defaults', () => {
        expect(MessagesQuerySchema.parse({})).toEqual({})
        expect(MessagesQuerySchema.parse({ turns: '8' })).toEqual({ turns: 8 })
        expect(MessagesQuerySchema.parse({ turnId: 'user-id' })).toEqual({ turnId: 'user-id' })
        expect(MessagesQuerySchema.safeParse({ turns: 0 }).success).toBe(false)
        expect(MessagesQuerySchema.safeParse({ turns: 21 }).success).toBe(false)
        expect(MessagesQuerySchema.safeParse({ turns: 1.5 }).success).toBe(false)
        expect(MessagesQuerySchema.safeParse({ turnId: 'user', beforeAt: 100, beforeSeq: 1 }).success).toBe(false)
        expect(MessagesQuerySchema.safeParse({ turns: 8, beforeAt: 100, beforeSeq: 1, epoch: 2 }).success).toBe(true)
        expect(MessagesQuerySchema.safeParse({ beforeAt: 100, beforeSeq: 1, epoch: 2 }).success).toBe(false)
    })

    it('recognizes wrapped invoked users but never promotes held prompts to boundaries', () => {
        expect(isInvokedUserTurn({ invokedAt: null, content: { role: 'user', content: 'held' } })).toBe(false)
        expect(isInvokedUserTurn({ invokedAt: 12, content: { payload: { message: { role: 'user', content: 'go' } } } })).toBe(true)
        expect(isInvokedUserTurn({ invokedAt: 12, content: { role: 'agent', content: 'answer' } })).toBe(false)
    })

    it('merges contiguous partial-turn ranges without upgrading separated or later-started ranges', () => {
        expect(mergeTurnSegments([segment(5, 10, false, true)], [segment(1, 4, true, false)], true))
            .toEqual([segment(1, 10, true, true)])
        expect(mergeTurnSegments([segment(5, 10, false, true)], [segment(1, 4, true, false)]))
            .toEqual([segment(1, 4, true, false), segment(5, 10, false, true)])
        expect(mergeTurnSegments([segment(5, 10, false, true)], [segment(6, 10, false, true)], true))
            .toEqual([segment(5, 10, false, true)])
    })
})
