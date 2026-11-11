import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { ApiClient } from '@/api/client'
import type { CancelMessageResponse } from '@hapi/protocol/schemas'
import type { DecryptedMessage } from '@/types/api'
import { appendOptimisticMessage, clearMessageWindow, getMessageWindowState } from '@/lib/message-window-store'
import { isQueuedForInvocation } from '@/lib/messages'
import { useCancelQueuedMessage } from './useCancelQueuedMessage'

vi.mock('@/hooks/usePlatform', () => ({ usePlatform: () => ({ haptic: { notification: vi.fn() } }) }))
const sessionId = 'terminal-cancel-mutation'
const snapshot: DecryptedMessage = {
    id: 'server', localId: 'local', seq: 1, createdAt: 1000, invokedAt: null, status: 'queued',
    content: {
        role: 'user', content: {
            type: 'text', text: '/local original', attachments: [
                { id: 'a', filename: 'context.txt', mimeType: 'text/plain', size: 4, path: '/context.txt' },
            ]
        }
    },
}
function wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
}
afterEach(() => clearMessageWindow(sessionId))

describe('queued cancellation server convergence', () => {
    it.each(['handled', 'cancelled'] as const)('restores %s terminal history when cancellation loses the native race', async (outcome) => {
        appendOptimisticMessage(sessionId, snapshot)
        const response: CancelMessageResponse = {
            status: 'resolved', message: { ...snapshot, resolution: { outcome, resolvedAt: 2000 } },
        }
        const api = { cancelMessage: async () => response } as unknown as ApiClient
        const { result } = renderHook(() => useCancelQueuedMessage(api), { wrapper })
        await act(async () => {
            await result.current.mutateAsync({ sessionId, messageId: snapshot.id, localId: 'local', snapshot })
        })
        const messages = getMessageWindowState(sessionId).messages
        expect(messages).toHaveLength(1)
        expect(messages[0]).toMatchObject({ content: snapshot.content, resolution: { outcome, resolvedAt: 2000 }, invokedAt: null })
        expect(messages.filter(isQueuedForInvocation)).toEqual([])
    })

    it('restores an unconfirmed cancellation to the queue without invocation evidence', async () => {
        appendOptimisticMessage(sessionId, snapshot)
        const response: CancelMessageResponse = { status: 'unconfirmed', message: snapshot }
        const api = { cancelMessage: async () => response } as unknown as ApiClient
        const { result } = renderHook(() => useCancelQueuedMessage(api), { wrapper })
        await act(async () => {
            await result.current.mutateAsync({ sessionId, messageId: snapshot.id, localId: 'local', snapshot })
        })
        const messages = getMessageWindowState(sessionId).messages
        expect(messages).toHaveLength(1)
        expect(messages[0]).toMatchObject({ content: snapshot.content, invokedAt: null, status: 'queued' })
        expect(messages.filter(isQueuedForInvocation)).toHaveLength(1)
    })
})
