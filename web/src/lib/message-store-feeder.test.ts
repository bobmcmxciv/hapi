import { afterEach, describe, expect, it } from 'vitest'
import type { DecryptedMessage, SyncEvent } from '@/types/api'
import {
    appendOptimisticMessage,
    clearMessageWindow,
    getMessageWindowState,
    ingestIncomingMessages
} from '@/lib/message-window-store'
import { isGlobalScopedMessageStreamEvent, MessageStoreFeeder } from './message-store-feeder'

const touchedSessions = new Set<string>()

function sessionId(name: string): string {
    const id = `feeder-test-${name}`
    touchedSessions.add(id)
    return id
}

function makeUserMessage(props: {
    id: string
    seq?: number | null
    localId?: string | null
    createdAt?: number
    invokedAt?: number | null
    status?: DecryptedMessage['status']
    scheduledAt?: number | null
}): DecryptedMessage {
    return {
        id: props.id,
        seq: props.seq ?? null,
        localId: props.localId ?? null,
        content: {
            role: 'user',
            content: { type: 'text', text: props.id }
        },
        createdAt: props.createdAt ?? 1_000,
        invokedAt: props.invokedAt,
        scheduledAt: props.scheduledAt,
        status: props.status,
        originalText: props.id
    } as DecryptedMessage
}

afterEach(() => {
    for (const id of touchedSessions) {
        clearMessageWindow(id)
    }
    touchedSessions.clear()
})

describe('isGlobalScopedMessageStreamEvent', () => {
    it('treats message stream events as global-scoped skips', () => {
        expect(isGlobalScopedMessageStreamEvent('global', 'message-received')).toBe(true)
        expect(isGlobalScopedMessageStreamEvent('global', 'messages-consumed')).toBe(true)
        expect(isGlobalScopedMessageStreamEvent('global', 'message-cancelled')).toBe(true)
        expect(isGlobalScopedMessageStreamEvent('global', 'scheduled-matured')).toBe(true)
    })

    it('does not skip session lifecycle events on the global connection', () => {
        expect(isGlobalScopedMessageStreamEvent('global', 'session-updated')).toBe(false)
        expect(isGlobalScopedMessageStreamEvent('global', 'session-added')).toBe(false)
        expect(isGlobalScopedMessageStreamEvent('global', 'session-removed')).toBe(false)
    })

    it('processes message stream events on full-scoped connections', () => {
        expect(isGlobalScopedMessageStreamEvent('full', 'message-received')).toBe(false)
    })
})

describe('MessageStoreFeeder — scope split', () => {
    it('ingests message-received on the session-scoped connection', () => {
        const sid = sessionId('ingest-full')
        const feeder = new MessageStoreFeeder({ scope: 'full' })

        feeder.feed({
            type: 'message-received',
            sessionId: sid,
            message: makeUserMessage({ id: 'srv-1', seq: 5 })
        } as SyncEvent)

        expect(getMessageWindowState(sid).messages.map((m) => m.id)).toContain('srv-1')
    })

    it('does NOT ingest message-received from the global connection (no double-feed)', () => {
        const sid = sessionId('ingest-global')
        const feeder = new MessageStoreFeeder({ scope: 'global' })

        feeder.feed({
            type: 'message-received',
            sessionId: sid,
            message: makeUserMessage({ id: 'srv-2', seq: 6 })
        } as SyncEvent)

        expect(getMessageWindowState(sid).messages).toHaveLength(0)
    })
})

describe('MessageStoreFeeder — consumed/cancelled side effects run on both scopes', () => {
    it.each(['global', 'full'] as const)('marks queued messages consumed on %s scope', (scope) => {
        const sid = sessionId(`consumed-${scope}`)
        // Match real optimistic prompts: null means held/not yet invoked;
        // omission is the legacy already-visible history representation.
        appendOptimisticMessage(sid, makeUserMessage({ id: 'l-1', localId: 'l-1', invokedAt: null, status: 'queued' }))
        const feeder = new MessageStoreFeeder({ scope })

        feeder.feed({
            type: 'messages-consumed',
            sessionId: sid,
            localIds: ['l-1'],
            invokedAt: 7_777
        } as SyncEvent)

        const message = getMessageWindowState(sid).messages.find((m) => m.localId === 'l-1')
        expect(message?.status).toBe('sent')
        expect(message?.invokedAt).toBe(7_777)
    })

    it.each(['global', 'full'] as const)('removes cancelled optimistic messages on %s scope', (scope) => {
        const sid = sessionId(`cancelled-${scope}`)
        appendOptimisticMessage(sid, makeUserMessage({ id: 'l-2', localId: 'l-2', status: 'queued' }))
        const feeder = new MessageStoreFeeder({ scope })

        feeder.feed({
            type: 'message-cancelled',
            sessionId: sid,
            messageId: 'l-2'
        } as SyncEvent)

        expect(getMessageWindowState(sid).messages.find((m) => m.localId === 'l-2')).toBeUndefined()
    })
})

describe('MessageStoreFeeder — removal vs end', () => {
    it('clears the whole window on session-removed', () => {
        const sid = sessionId('removed')
        ingestIncomingMessages(sid, [makeUserMessage({ id: 'srv-3', seq: 1 })])
        appendOptimisticMessage(sid, makeUserMessage({ id: 'l-3', localId: 'l-3', status: 'queued' }))
        const feeder = new MessageStoreFeeder({ scope: 'full' })

        feeder.feed({ type: 'session-removed', sessionId: sid } as SyncEvent)

        expect(getMessageWindowState(sid).messages).toHaveLength(0)
    })

    it.each(['terminated', 'error', 'cleared', 'handoff', 'completed'] as const)(
        'keeps held history and pending queued messages on session-ended (%s)',
        (reason) => {
            const sid = sessionId(`ended-${reason}`)
            ingestIncomingMessages(sid, [makeUserMessage({ id: 'srv-4', seq: 2 })])
            appendOptimisticMessage(sid, makeUserMessage({ id: 'l-4', localId: 'l-4', status: 'queued' }))
            const feeder = new MessageStoreFeeder({ scope: 'full' })

            feeder.feed({ type: 'session-ended', sessionId: sid, reason } as SyncEvent)

            const messages = getMessageWindowState(sid).messages
            expect(messages.map((m) => m.id)).toContain('srv-4')
            // The queued prompt is still queued — the hub preserves it for
            // re-attach; end ≠ consumed and ≠ cancelled.
            const queued = messages.find((m) => m.localId === 'l-4')
            expect(queued).toBeDefined()
            expect(queued?.invokedAt == null).toBe(true)
        }
    )
})
