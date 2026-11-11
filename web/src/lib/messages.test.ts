import { describe, expect, it } from 'vitest'
import type { DecryptedMessage } from '@/types/api'
import { mergeMessages } from '@/lib/messages'

function userMessage(partial: Partial<DecryptedMessage> & { id: string }): DecryptedMessage {
    return {
        localId: partial.localId ?? partial.id,
        seq: partial.seq ?? 1,
        createdAt: partial.createdAt ?? 1_000,
        invokedAt: partial.invokedAt ?? null,
        status: partial.status,
        content: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        ...partial,
    }
}

describe('mergeMessages', () => {
    it('preserves invokedAt when a stale snapshot omits the ack timestamp', () => {
        const invokedAt = 2_000
        const existing = [userMessage({ id: 'server-1', localId: 'local-1', invokedAt })]
        const incoming = [userMessage({ id: 'server-1', localId: 'local-1', invokedAt: null })]

        const merged = mergeMessages(existing, incoming)
        expect(merged).toHaveLength(1)
        expect(merged[0]?.invokedAt).toBe(invokedAt)
    })

    it('retains an earlier prompt when only a later prompt has a server echo', () => {
        const first = userMessage({ id: 'local-a', localId: 'local-a', createdAt: 1000, status: 'sent' })
        const second = userMessage({ id: 'local-b', localId: 'local-b', createdAt: 1500, status: 'sent' })
        const echo = userMessage({ id: 'server-b', localId: 'local-b', createdAt: 1500, invokedAt: 1600 })
        const merged = mergeMessages([first, second], [echo])
        expect(merged.map(message => message.id)).toEqual(['local-a', 'server-b'])
        const final = mergeMessages(merged, [userMessage({ id: 'server-a', localId: 'local-a', invokedAt: 1700 })])
        expect(final.map(message => message.id)).toEqual(['server-b', 'server-a'])
    })

    it('does not guess identity from a nearby server message without localId', () => {
        const optimistic = userMessage({ id: 'local-a', status: 'sent', invokedAt: 1200 })
        const unrelated = { ...userMessage({ id: 'server-b', invokedAt: 1200 }), localId: null }
        expect(mergeMessages([optimistic], [unrelated]).map(message => message.id).sort()).toEqual(['local-a', 'server-b'])
    })

    it('orders delayed ACK, ±60s clock-skewed, and same-ms adjacent turns by native position while keeping display timestamps intact', () => {
        const epochAt = 50_000
        const u1 = userMessage({
            id: 'u1',
            localId: 'local-u1',
            seq: 1,
            createdAt: 10_000,
            invokedAt: 80_000,
            position: { at: epochAt, order: 1, eventOrder: 0 },
        })
        const a1 = {
            id: 'a1',
            localId: null,
            seq: 2,
            createdAt: 20_000,
            invokedAt: 20_000,
            position: { at: epochAt, order: 2, eventOrder: 1 },
            content: { role: 'agent', content: [{ type: 'text', text: 'reply 1' }] },
        } satisfies DecryptedMessage
        const u2QueuedEarlySameMs = userMessage({
            id: 'u2',
            localId: 'local-u2',
            seq: 3,
            createdAt: 20_000,
            invokedAt: 20_000,
            position: { at: epochAt, order: 3, eventOrder: 0 },
        })

        const merged = mergeMessages([u2QueuedEarlySameMs, a1], [u1])
        expect(merged.map((m) => m.id)).toEqual(['u1', 'a1', 'u2'])
        expect(merged[0]?.invokedAt).toBe(80_000)
        expect(merged[1]?.createdAt).toBe(20_000)
        expect(merged[2]?.createdAt).toBe(20_000)
    })

    it('preserves optimistic position across server echo and never matches by text equality', () => {
        const optimisticFirst = userMessage({
            id: 'local-1',
            localId: 'local-1',
            seq: null,
            createdAt: 1_000,
            invokedAt: 1_000,
            status: 'sent',
            position: { at: 9_000, order: 4, eventOrder: 0 },
        })
        const optimisticSecondSameText = userMessage({
            id: 'local-2',
            localId: 'local-2',
            seq: null,
            createdAt: 1_000,
            invokedAt: null,
            status: 'queued',
        })
        const staleEchoFirst = userMessage({
            id: 'srv-1',
            localId: 'local-1',
            seq: 10,
            createdAt: 1_000,
            invokedAt: null,
        })
        const unrelatedCanonicalSameText = {
            ...userMessage({
                id: 'srv-tokenless',
                seq: 11,
                createdAt: 1_000,
                invokedAt: 1_000,
                position: { at: 9_000, order: 5, eventOrder: 0 },
            }),
            localId: null,
        }

        const merged = mergeMessages([optimisticFirst, optimisticSecondSameText], [staleEchoFirst, unrelatedCanonicalSameText])
        expect(merged.map((m) => m.id)).toEqual(['local-2', 'srv-1', 'srv-tokenless'])
        expect(merged.find((m) => m.id === 'srv-1')?.position).toEqual({ at: 9_000, order: 4, eventOrder: 0 })
    })
})
