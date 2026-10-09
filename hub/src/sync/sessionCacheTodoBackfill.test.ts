import { describe, expect, it } from 'bun:test'
import type { SyncEvent } from '@hapi/protocol/types'
import { Store } from '../store'
import type { EventPublisher } from './eventPublisher'
import { SessionCache } from './sessionCache'

function createPublisher(events: SyncEvent[]): EventPublisher {
    return {
        emit: (event: SyncEvent) => {
            events.push(event)
        }
    } as unknown as EventPublisher
}

const todoWriteMessage = {
    role: 'agent',
    content: {
        type: 'output',
        data: {
            type: 'assistant',
            message: {
                content: [
                    {
                        type: 'tool_use',
                        name: 'TodoWrite',
                        input: {
                            todos: [
                                { content: 'pending thing', status: 'pending' },
                                { content: 'done thing', status: 'completed' }
                            ]
                        }
                    }
                ]
            }
        }
    }
}

async function waitUntil(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!condition()) {
        if (Date.now() > deadline) throw new Error('condition not met in time')
        await new Promise((resolve) => setTimeout(resolve, 10))
    }
}

describe('SessionCache startup todo backfill', () => {
    it('loads sessions without replaying their messages, then backfills todos in the background', async () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('todo-backfill', { path: '/tmp', host: 'h' }, null, 'default')
        store.messages.addMessage(session.id, todoWriteMessage)
        expect(store.sessions.getSession(session.id)?.todos).toBeNull()

        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))
        try {
            cache.reloadAll()

            expect(cache.getSession(session.id)).toBeDefined()
            expect(store.sessions.getSession(session.id)?.todos).toBeNull()

            await waitUntil(() => cache.getSession(session.id)?.todos !== undefined)
            expect(cache.getSession(session.id)?.todos).toEqual([
                expect.objectContaining({ content: 'pending thing', status: 'pending' }),
                expect.objectContaining({ content: 'done thing', status: 'completed' })
            ])
            expect(store.sessions.getSession(session.id)?.todos).not.toBeNull()
        } finally {
            cache.stopBackgroundWork()
        }
    })

    it('still backfills inline when a session is refreshed outside startup', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('todo-inline', { path: '/tmp', host: 'h' }, null, 'default')
        store.messages.addMessage(session.id, todoWriteMessage)

        const cache = new SessionCache(store, createPublisher([]))
        cache.refreshSession(session.id)

        expect(cache.getSession(session.id)?.todos).toHaveLength(2)
    })

    it('stops the background backfill when asked', async () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('todo-stopped', { path: '/tmp', host: 'h' }, null, 'default')
        store.messages.addMessage(session.id, todoWriteMessage)

        const cache = new SessionCache(store, createPublisher([]))
        cache.reloadAll()
        cache.stopBackgroundWork()
        await new Promise((resolve) => setTimeout(resolve, 100))

        expect(store.sessions.getSession(session.id)?.todos).toBeNull()
    })
})
