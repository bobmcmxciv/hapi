import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { DecryptedMessage, MessagesResponse } from '@/types/api'
import { clearMessageWindow, getMessageWindowState, ingestIncomingMessages, setMessageWindowScope, syncTailMessages } from './message-window-store'

const sessionId = 'beta-scope-transition-regression'
function row(id: string): DecryptedMessage {
    return { id, seq: 1, localId: null, createdAt: 100, invokedAt: 100, content: { role: 'user', content: { type: 'text', text: id } } }
}
afterEach(() => {
    for (const scope of ['hub/account-a', 'hub/account-b', '']) {
        setMessageWindowScope(scope)
        clearMessageWindow(sessionId)
    }
    vi.restoreAllMocks()
})

describe('authenticated message window ownership', () => {
    it('does not expose cached rows or late history responses from the prior account', async () => {
        setMessageWindowScope('hub/account-a')
        ingestIncomingMessages(sessionId, [row('account-a-private')])
        const pending = Promise.withResolvers<MessagesResponse>()
        const api = { getMessages: vi.fn(() => pending.promise) } as unknown as ApiClient
        const loading = syncTailMessages(api, sessionId)
        setMessageWindowScope('hub/account-b')
        expect(getMessageWindowState(sessionId).messages).toEqual([])
        const secondPending = Promise.withResolvers<MessagesResponse>()
        const secondApi = { getMessages: vi.fn(() => secondPending.promise) } as unknown as ApiClient
        const secondLoading = syncTailMessages(secondApi, sessionId)
        pending.resolve({
            messages: [row('late-account-a')],
            page: { direction: 'latest', limit: 200, epoch: 1, reset: false, nextBeforeSeq: 1, nextBeforeAt: 100, nextAfterSeq: 1, nextAfterAt: 100, snapshotHeadSeq: 1, snapshotHeadAt: 100, hasMore: false },
        })
        await loading
        expect(getMessageWindowState(sessionId).messages).toEqual([])
        secondPending.resolve({
            messages: [row('account-b-visible')],
            page: { direction: 'latest', limit: 200, epoch: 1, reset: false, nextBeforeSeq: 1, nextBeforeAt: 100, nextAfterSeq: 1, nextAfterAt: 100, snapshotHeadSeq: 1, snapshotHeadAt: 100, hasMore: false },
        })
        await secondLoading
        expect(getMessageWindowState(sessionId).messages.map(message => message.id)).toEqual(['account-b-visible'])
    })

    it('rehydrates each account cache without deleting the other account history', () => {
        setMessageWindowScope('hub/account-a')
        ingestIncomingMessages(sessionId, [row('account-a-offline-history')])
        setMessageWindowScope('hub/account-b')
        expect(getMessageWindowState(sessionId).messages).toEqual([])
        ingestIncomingMessages(sessionId, [row('account-b-offline-history')])
        setMessageWindowScope('hub/account-a')
        expect(getMessageWindowState(sessionId).messages.map(message => message.id)).toEqual(['account-a-offline-history'])
        setMessageWindowScope('hub/account-b')
        expect(getMessageWindowState(sessionId).messages.map(message => message.id)).toEqual(['account-b-offline-history'])
    })
})
