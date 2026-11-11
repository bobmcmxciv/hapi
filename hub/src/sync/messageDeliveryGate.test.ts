import { describe, expect, it } from 'bun:test'
import type { Server } from 'socket.io'
import type { SyncEvent } from '@hapi/protocol/types'
import { Store } from '../store'
import { MessageService } from './messageService'
import type { EventPublisher } from './eventPublisher'

type Delivery = { body: { message: { localId: string | null } } }

describe('native-ready message admission', () => {
    it('holds immediate and scheduled inputs through an unavailable generation without consuming or losing them', async () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('native-gate', { path: '/native-gate', host: 'localhost', flavor: 'omp' }, null, 'default')
        const updates: Delivery[] = []
        const events: SyncEvent[] = []
        const io = { of: () => ({ to: () => ({ emit: (_event: string, delivery: Delivery) => updates.push(delivery) }) }) } as unknown as Server
        const publisher = { emit: (event: SyncEvent) => events.push(event) } as unknown as EventPublisher
        let ready = true
        const service = new MessageService(store, io, publisher, undefined, undefined, () => ready)
        try {
            await service.sendMessage(session.id, { text: 'already invoked history', localId: 'history' })
            store.messages.markMessagesInvoked(session.id, ['history'], Date.now())
            updates.length = 0
            ready = false
            const scheduledAt = Date.now() + 60_000
            await service.sendMessage(session.id, { text: 'pending immediate', localId: 'immediate' })
            await service.sendMessage(session.id, { text: 'pending schedule', localId: 'scheduled', scheduledAt })
            expect(service.replayImmediateQueuedMessages(session.id)).toBe(0)
            expect(service.releaseDeliverableQueuedMessages(session.id, scheduledAt + 1)).toBe(0)
            service.releaseMatureScheduledMessages(scheduledAt + 1)
            expect(updates).toEqual([])
            expect(service.getQueuedState(session.id, ['immediate', 'scheduled']).queuedLocalIds.sort()).toEqual(['immediate', 'scheduled'])
            expect(service.getDeliverableMessagesAfter(session.id, { afterSeq: 0, limit: 10, now: scheduledAt + 1 }).map(message => message.localId)).toEqual(['history'])
            expect(events.some(event => event.type === 'messages-consumed')).toBe(false)

            ready = true
            expect(service.replayImmediateQueuedMessages(session.id)).toBe(1)
            service.releaseMatureScheduledMessages(scheduledAt + 1)
            expect(updates.map(update => update.body.message.localId)).toEqual(['immediate', 'scheduled'])
            expect(service.getQueuedState(session.id, ['immediate', 'scheduled']).queuedLocalIds.sort()).toEqual(['immediate', 'scheduled'])
            store.messages.markMessagesInvoked(session.id, ['immediate', 'scheduled'], scheduledAt + 1)
            expect(service.replayImmediateQueuedMessages(session.id)).toBe(0)
            expect(service.releaseDeliverableQueuedMessages(session.id, scheduledAt + 1)).toBe(0)
            expect(service.getQueuedState(session.id, ['immediate', 'scheduled']).queuedLocalIds).toEqual([])
        } finally {
            store.close()
        }
    })
})
