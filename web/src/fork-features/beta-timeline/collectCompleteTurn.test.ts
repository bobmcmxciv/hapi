import { describe, expect, it } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { DecryptedMessage, MessagesResponse } from '@/types/api'
import { TURN_PAGE_ROW_LIMIT } from '@hapi/protocol/messageTurns'
import { collectCompleteTurn } from './collectCompleteTurn'

function message(id: string, seq: number): DecryptedMessage {
    return { id, seq, localId: null, createdAt: seq * 10, invokedAt: seq * 10, scheduledAt: null, content: { role: id === 'turn' ? 'user' : 'agent', content: { type: 'text', text: id } } }
}

function page(messages: DecryptedMessage[], cursor: number, head: number, more: boolean, epoch = 1, reset = false): MessagesResponse {
    return {
        messages,
        page: {
            direction: messages[0]?.id === 'turn' ? 'latest' : 'after',
            limit: TURN_PAGE_ROW_LIMIT,
            epoch, reset,
            nextBeforeAt: null, nextBeforeSeq: null,
            nextAfterAt: cursor * 10, nextAfterSeq: cursor,
            snapshotHeadAt: head * 10, snapshotHeadSeq: head,
            hasMore: more,
            hasMoreAfter: more,
            turns: {
                requested: 1, rowLimit: TURN_PAGE_ROW_LIMIT,
                segments: messages.length ? [{
                    turnId: 'turn',
                    from: { at: messages[0].createdAt, seq: messages[0].seq! },
                    to: { at: cursor * 10, seq: cursor },
                    completeBefore: messages[0].id === 'turn',
                    completeAfter: !more,
                }] : [],
            },
        },
    }
}

describe('complete turn collection', () => {
    it('collects beyond the viewport cache using one fixed forward snapshot', async () => {
        const rows = Array.from({ length: 9001 }, (_, index) => message(index === 0 ? 'turn' : `m-${index}`, index + 1))
        let calls = 0
        const api: Pick<ApiClient, 'getMessages'> = {
            getMessages: async (_id, options) => {
                calls += 1
                const start = options.afterSeq ?? 0
                if (start > 0) {
                    expect(options.untilSeq).toBe(rows.length)
                    expect(options.untilAt).toBe(rows.length * 10)
                    expect(options.epoch).toBe(1)
                }
                const slice = rows.slice(start, start + TURN_PAGE_ROW_LIMIT)
                const end = start + slice.length
                return page(slice, end, rows.length, end < rows.length)
            },
        }
        const collected = await collectCompleteTurn(api, 'session', 'turn')
        expect(collected.map(row => row.id)).toEqual(rows.map(row => row.id))
        expect(calls).toBe(5)
    })

    it('propagates 4-tuple order/eventOrder cursors across same-epoch multi-page turn collection', async () => {
        const firstSlice = Array.from({ length: TURN_PAGE_ROW_LIMIT }, (_, index) => ({
            ...message(index === 0 ? 'turn' : `part-${index}`, index + 1),
            createdAt: 1000,
            invokedAt: 1000,
            position: { at: 5000, order: 2, eventOrder: index },
        }))
        const finalRow: DecryptedMessage = {
            ...message('final', TURN_PAGE_ROW_LIMIT + 1),
            createdAt: 1000,
            invokedAt: 1000,
            position: { at: 5000, order: 3, eventOrder: 4 },
        }
        let calls = 0
        const api: Pick<ApiClient, 'getMessages'> = {
            getMessages: async (_id, options) => {
                calls += 1
                if (calls === 1) {
                    return {
                        messages: firstSlice,
                        page: {
                            direction: 'latest',
                            limit: TURN_PAGE_ROW_LIMIT,
                            epoch: 7,
                            reset: false,
                            nextBeforeAt: null,
                            nextBeforeSeq: null,
                            nextAfterAt: 5000,
                            nextAfterOrder: 2,
                            nextAfterEventOrder: TURN_PAGE_ROW_LIMIT - 1,
                            nextAfterSeq: TURN_PAGE_ROW_LIMIT,
                            snapshotHeadAt: 5000,
                            snapshotHeadOrder: 3,
                            snapshotHeadEventOrder: 4,
                            snapshotHeadSeq: TURN_PAGE_ROW_LIMIT + 1,
                            hasMore: true,
                            hasMoreAfter: true,
                            turns: {
                                requested: 1,
                                rowLimit: TURN_PAGE_ROW_LIMIT,
                                segments: [{
                                    turnId: 'turn',
                                    from: { at: 5000, order: 2, eventOrder: 0, seq: 1 },
                                    to: { at: 5000, order: 2, eventOrder: TURN_PAGE_ROW_LIMIT - 1, seq: TURN_PAGE_ROW_LIMIT },
                                    completeBefore: true,
                                    completeAfter: false,
                                }],
                            },
                        },
                    }
                }
                expect(options).toMatchObject({
                    turnId: 'turn',
                    afterAt: 5000,
                    afterOrder: 2,
                    afterEventOrder: TURN_PAGE_ROW_LIMIT - 1,
                    afterSeq: TURN_PAGE_ROW_LIMIT,
                    untilAt: 5000,
                    untilOrder: 3,
                    untilEventOrder: 4,
                    untilSeq: TURN_PAGE_ROW_LIMIT + 1,
                    epoch: 7,
                })
                return {
                    messages: [finalRow],
                    page: {
                        direction: 'after',
                        limit: TURN_PAGE_ROW_LIMIT,
                        epoch: 7,
                        reset: false,
                        nextBeforeAt: null,
                        nextBeforeSeq: null,
                        nextAfterAt: 5000,
                        nextAfterOrder: 3,
                        nextAfterEventOrder: 4,
                        nextAfterSeq: TURN_PAGE_ROW_LIMIT + 1,
                        snapshotHeadAt: 5000,
                        snapshotHeadOrder: 3,
                        snapshotHeadEventOrder: 4,
                        snapshotHeadSeq: TURN_PAGE_ROW_LIMIT + 1,
                        hasMore: false,
                        hasMoreAfter: false,
                        turns: {
                            requested: 1,
                            rowLimit: TURN_PAGE_ROW_LIMIT,
                            segments: [{
                                turnId: 'turn',
                                from: { at: 5000, order: 3, eventOrder: 4, seq: TURN_PAGE_ROW_LIMIT + 1 },
                                to: { at: 5000, order: 3, eventOrder: 4, seq: TURN_PAGE_ROW_LIMIT + 1 },
                                completeBefore: false,
                                completeAfter: true,
                            }],
                        },
                    },
                }
            },
        }
        const collected = await collectCompleteTurn(api, 'session', 'turn')
        expect(collected).toHaveLength(TURN_PAGE_ROW_LIMIT + 1)
        expect(collected.at(-1)?.id).toBe('final')
    })

    it('discards pre-rewind data when the selected turn resets to a new epoch', async () => {
        let call = 0
        const api: Pick<ApiClient, 'getMessages'> = {
            getMessages: async () => ++call === 1
                ? page([message('turn', 1), message('discarded', 2)], 2, 4, true)
                : page([message('turn', 1), message('replacement', 5)], 5, 5, false, 2, true)
        }
        expect((await collectCompleteTurn(api, 'session', 'turn')).map(row => row.id)).toEqual(['turn', 'replacement'])
    })

    it('stops instead of looping or exporting a fragment when the raw cursor stops advancing', async () => {
        let calls = 0
        const api: Pick<ApiClient, 'getMessages'> = {
            getMessages: async () => ++calls === 1
                ? page([message('turn', 1), message('first', 2)], 2, 4, true)
                : page([], 2, 4, true)
        }
        await expect(collectCompleteTurn(api, 'session', 'turn')).rejects.toMatchObject({ reason: 'incomplete' })
        expect(calls).toBe(2)
    })

    it('rejects an older server response that cannot prove selected-turn coverage', async () => {
        const legacy = page([message('turn', 1), message('answer', 2)], 2, 2, false)
        delete legacy.page.turns
        const api: Pick<ApiClient, 'getMessages'> = { getMessages: async () => legacy }
        await expect(collectCompleteTurn(api, 'session', 'turn')).rejects.toMatchObject({ reason: 'unsupported' })
    })

    it('does not return content after cancellation even when the transport ignores its signal', async () => {
        const controller = new AbortController()
        let calls = 0
        const api: Pick<ApiClient, 'getMessages'> = {
            getMessages: async () => {
                calls += 1
                controller.abort()
                return page([message('turn', 1), message('answer', 2)], 2, 2, false)
            }
        }
        await expect(collectCompleteTurn(api, 'session', 'turn', controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
        expect(calls).toBe(1)
    })
})
