import { afterEach, describe, expect, it } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { DecryptedMessage, MessagesResponse } from '@/types/api'
import type { QueuedStateResponse } from '@hapi/protocol/apiTypes'
import { normalizeDecryptedMessage } from '@/chat/normalize'
import { reduceChatBlocks } from '@/chat/reducer'
import { isInvokedUserTurn } from '@hapi/protocol/messageTurns'
import { MessageStoreFeeder } from './message-store-feeder'
import { isQueuedForInvocation } from './messages'
import { reconcileQueuedStateAfterConnect } from './queued-state-reconciliation'
import {
    appendOptimisticMessage, clearMessageWindow, getMessageWindowState,
    ingestIncomingMessages, markMessagesConsumed, setMessageViewMode, setMessageWindowScope,
} from './message-window-store'

const sessions = new Set<string>()
function prompt(id: string): DecryptedMessage {
    return {
        id, localId: id, seq: null, createdAt: 1000, invokedAt: null, status: 'queued',
        content: {
            role: 'user', content: {
                type: 'text', text: '/local command', attachments: [
                    { id: 'attachment', filename: 'context.txt', mimeType: 'text/plain', size: 4, path: '/context.txt' },
                ]
            }
        },
    }
}
function page(messages: DecryptedMessage[] = []): MessagesResponse {
    return {
        messages, page: {
            direction: 'latest', limit: 200, epoch: 0, reset: false, hasMore: false,
            nextBeforeAt: null, nextBeforeSeq: null, nextAfterAt: null, nextAfterSeq: null,
            snapshotHeadAt: null, snapshotHeadSeq: null,
        }
    }
}
function seed(id: string) {
    sessions.add(id)
    appendOptimisticMessage(id, prompt('local'))
}
function visibleTerminal(id: string, outcome: 'handled' | 'cancelled') {
    const messages = getMessageWindowState(id).messages
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ resolution: { outcome, resolvedAt: 2000 }, invokedAt: null })
    expect(messages.filter(isQueuedForInvocation)).toHaveLength(0)
    expect(isInvokedUserTurn(messages[0])).toBe(false)
    const normalized = normalizeDecryptedMessage(messages[0])!
    const { blocks } = reduceChatBlocks([normalized], null)
    expect(blocks).toMatchObject([{
        kind: 'user-text', text: '/local command', resolution: { outcome }, invokedAt: null,
        attachments: [{ filename: 'context.txt' }]
    }])
}
afterEach(() => {
    for (const id of sessions) clearMessageWindow(id)
    sessions.clear()
    setMessageWindowScope('')
})

describe('terminal native input consumer convergence', () => {
    it.each(['handled', 'cancelled'] as const)('keeps live %s evidence through stale echo and reconnect', async (outcome) => {
        const id = `terminal-live-${outcome}`
        seed(id)
        const feeder = new MessageStoreFeeder({ scope: 'full' })
        feeder.feed({ type: 'messages-resolved', sessionId: id, resolutions: [{ localId: 'local', resolution: { outcome, resolvedAt: 2000 } }] })
        ingestIncomingMessages(id, [{ ...prompt('local'), id: 'server', seq: 1 }])
        markMessagesConsumed(id, ['local'], 9999)
        visibleTerminal(id, outcome)
        const api = { getMessages: async () => page([{ ...prompt('local'), id: 'server', seq: 1 }]) } as unknown as ApiClient
        await reconcileQueuedStateAfterConnect(api, id)
        visibleTerminal(id, outcome)
    })

    it.each(['handled', 'cancelled'] as const)('resolves detached history %s from durable queued-state without execution', async (outcome) => {
        const id = `terminal-detached-${outcome}`
        seed(id)
        setMessageViewMode(id, 'history')
        const api = {
            getMessages: async () => page(),
            getQueuedState: async () => ({
                queuedLocalIds: [], invokedLocalMessages: [], resolvedLocalMessages: [
                    { localId: 'local', resolution: { outcome, resolvedAt: 2000 } },
                ]
            }),
        } as unknown as ApiClient
        await reconcileQueuedStateAfterConnect(api, id)
        visibleTerminal(id, outcome)
        expect(getMessageWindowState(id).viewMode).toBe('history')
    })

    it('anchors terminal input inside its native position epoch before subsequent turns without marking it invoked', async () => {
        const id = 'terminal-position-order'
        sessions.add(id)
        const feeder = new MessageStoreFeeder({ scope: 'full' })
        appendOptimisticMessage(id, {
            ...prompt('term-local'),
            createdAt: 90_000,
        })
        feeder.feed({
            type: 'messages-resolved',
            sessionId: id,
            resolutions: [{
                localId: 'term-local',
                resolution: { outcome: 'handled', resolvedAt: 91_000 },
                position: { at: 50_000, order: 2, eventOrder: 1 },
            }],
        })
        ingestIncomingMessages(id, [
            {
                ...prompt('term-local'),
                id: 'srv-term',
                seq: 2,
                createdAt: 90_000,
            },
            {
                id: 'srv-u2',
                localId: 'u2-local',
                seq: 1,
                createdAt: 10_000,
                invokedAt: 10_000,
                position: { at: 50_000, order: 3, eventOrder: 0 },
                content: { role: 'user', content: { type: 'text', text: 'next turn' } },
            },
        ])
        const messages = getMessageWindowState(id).messages
        expect(messages.map((m) => m.id)).toEqual(['srv-term', 'srv-u2'])
        expect(messages[0]).toMatchObject({
            id: 'srv-term',
            invokedAt: null,
            resolution: { outcome: 'handled', resolvedAt: 91_000 },
            position: { at: 50_000, order: 2, eventOrder: 1 },
        })
        expect(isInvokedUserTurn(messages[0]!)).toBe(false)
    })

    it('does not inject unrelated detail from global terminal events', () => {
        seed('terminal-held')
        sessions.add('terminal-unrelated')
        const feeder = new MessageStoreFeeder({ scope: 'global' })
        feeder.feed({
            type: 'messages-resolved', sessionId: 'terminal-unrelated', resolutions: [
                { localId: 'local', resolution: { outcome: 'handled', resolvedAt: 2000 } },
            ]
        })
        expect(getMessageWindowState('terminal-unrelated').messages).toEqual([])
        expect(getMessageWindowState('terminal-held').messages.filter(isQueuedForInvocation)).toHaveLength(1)
    })

    it('rejects queued-state completion after switching away and back to the same account scope', async () => {
        const id = 'terminal-stale-scope'
        setMessageWindowScope('account-a')
        seed(id)
        const querying = Promise.withResolvers<void>()
        const pending = Promise.withResolvers<QueuedStateResponse>()
        const api = { getMessages: async () => page(), getQueuedState: () => { querying.resolve(); return pending.promise } } as unknown as ApiClient
        const reconnect = reconcileQueuedStateAfterConnect(api, id)
        await querying.promise
        setMessageWindowScope('account-b')
        setMessageWindowScope('account-a')
        appendOptimisticMessage(id, prompt('local'))
        pending.resolve({ queuedLocalIds: [], invokedLocalMessages: [], resolvedLocalMessages: [{ localId: 'local', resolution: { outcome: 'handled', resolvedAt: 2000 } }] })
        await reconnect
        expect(getMessageWindowState(id).messages.filter(isQueuedForInvocation)).toHaveLength(1)
    })
})
