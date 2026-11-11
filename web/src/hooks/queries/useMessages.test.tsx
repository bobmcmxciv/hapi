import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ApiClient } from '@/api/client'
import type { MessagesResponse } from '@/types/api'
import { clearMessageWindow } from '@/lib/message-window-store'
import { useMessages } from './useMessages'

const id = 'use-messages-turn-contract'

afterEach(() => {
    cleanup()
    clearMessageWindow(id)
})

describe('useMessages turn continuation', () => {
    it('opts the connected loader into Beta turn units and exposes coverage while preserving the legacy opt-out', async () => {
        const getMessages = vi.fn(async (_sessionId: string, options: Parameters<ApiClient['getMessages']>[1]): Promise<MessagesResponse> => ({
            messages: [{
                id: 'user', seq: 1, localId: null, createdAt: 1000, invokedAt: 1000,
                content: { role: 'user', content: { type: 'text', text: 'prompt' } }
            }],
            page: {
                direction: 'latest', limit: 200, epoch: 0, reset: false,
                nextBeforeAt: 1000, nextBeforeSeq: 1, nextAfterAt: null, nextAfterSeq: null,
                snapshotHeadAt: 1000, snapshotHeadSeq: 1, hasMore: false,
                ...(options.turns ? {
                    turns: {
                        requested: options.turns, rowLimit: 2000, segments: [{
                            turnId: 'user', from: { at: 1000, seq: 1 }, to: { at: 1000, seq: 1 },
                            completeBefore: true, completeAfter: true
                        }]
                    }
                } : {})
            }
        }))
        const api = { getMessages } as unknown as ApiClient
        const { result, rerender } = renderHook(({ turns }) => useMessages(api, id, { turns }), {
            initialProps: { turns: 8 as number | undefined }
        })
        await waitFor(() => expect(result.current.turnSegments[0]?.turnId).toBe('user'))
        expect(getMessages.mock.calls[0]?.[1]).toMatchObject({ turns: 8 })
        expect(result.current.turnSegments[0]).toMatchObject({ completeBefore: true, completeAfter: true })
        rerender({ turns: undefined })
        await waitFor(() => expect(getMessages.mock.calls.at(-1)?.[1]).not.toHaveProperty('turns'))
        await waitFor(() => expect(result.current.turnSegments).toEqual([]))
    })
})
