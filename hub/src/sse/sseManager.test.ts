import { describe, expect, it } from 'bun:test'
import { SSEManager } from './sseManager'
import type { SyncEvent } from '../sync/syncEngine'
import { VisibilityTracker } from '../visibility/visibilityTracker'

describe('SSEManager namespace filtering', () => {
    it('routes events to matching namespace', () => {
        const manager = new SSEManager(0, new VisibilityTracker())
        const receivedAlpha: SyncEvent[] = []
        const receivedBeta: SyncEvent[] = []

        manager.subscribe({
            id: 'alpha',
            namespace: 'alpha',
            all: true,
            send: (event) => {
                receivedAlpha.push(event)
            },
            sendHeartbeat: () => {}
        })

        manager.subscribe({
            id: 'beta',
            namespace: 'beta',
            all: true,
            send: (event) => {
                receivedBeta.push(event)
            },
            sendHeartbeat: () => {}
        })

        manager.broadcast({ type: 'session-updated', sessionId: 's1', namespace: 'alpha' })

        expect(receivedAlpha).toHaveLength(1)
        expect(receivedBeta).toHaveLength(0)
    })

    it('broadcasts connection-changed to all namespaces', () => {
        const manager = new SSEManager(0, new VisibilityTracker())
        const received: Array<{ id: string; event: SyncEvent }> = []

        manager.subscribe({
            id: 'alpha',
            namespace: 'alpha',
            all: true,
            send: (event) => {
                received.push({ id: 'alpha', event })
            },
            sendHeartbeat: () => {}
        })

        manager.subscribe({
            id: 'beta',
            namespace: 'beta',
            all: true,
            send: (event) => {
                received.push({ id: 'beta', event })
            },
            sendHeartbeat: () => {}
        })

        manager.broadcast({ type: 'connection-changed', data: { status: 'connected' } })

        expect(received).toHaveLength(2)
        expect(received.map((entry) => entry.id).sort()).toEqual(['alpha', 'beta'])
    })

    it('sends toast only to visible connections in a namespace', async () => {
        const manager = new SSEManager(0, new VisibilityTracker())
        const received: Array<{ id: string; event: SyncEvent }> = []

        manager.subscribe({
            id: 'visible',
            namespace: 'alpha',
            all: true,
            visibility: 'visible',
            send: (event) => {
                received.push({ id: 'visible', event })
            },
            sendHeartbeat: () => {}
        })

        manager.subscribe({
            id: 'hidden',
            namespace: 'alpha',
            all: true,
            visibility: 'hidden',
            send: (event) => {
                received.push({ id: 'hidden', event })
            },
            sendHeartbeat: () => {}
        })

        manager.subscribe({
            id: 'other',
            namespace: 'beta',
            all: true,
            visibility: 'visible',
            send: (event) => {
                received.push({ id: 'other', event })
            },
            sendHeartbeat: () => {}
        })

        const toastEvent: Extract<SyncEvent, { type: 'toast' }> = {
            type: 'toast',
            data: {
                title: 'Test',
                body: 'Toast body',
                sessionId: 'session-1',
                url: '/sessions/session-1'
            }
        }

        const delivered = await manager.sendToast('alpha', toastEvent)

        expect(delivered).toBe(1)
        expect(received).toHaveLength(1)
        expect(received[0]?.id).toBe('visible')
    })

    it('applies the canDeliver predicate to toasts, not just broadcasts', async () => {
        // 多用户网关下同一个 namespace 住着多个账号，namespace + visible 两个条件
        // 拦不住跨账号：提醒必须和 broadcast 走同一条谓词。
        const manager = new SSEManager(0, new VisibilityTracker())
        const received: string[] = []

        for (const id of ['allowed', 'denied']) {
            manager.subscribe({
                id,
                namespace: 'alpha',
                all: true,
                visibility: 'visible',
                canDeliver: (event) => id === 'allowed'
                    || (event.type === 'toast' && event.data.sessionId !== 'session-1'),
                send: () => { received.push(id) },
                sendHeartbeat: () => {}
            })
        }

        const delivered = await manager.sendToast('alpha', {
            type: 'toast',
            data: { title: 'Ready for input', body: 'x', sessionId: 'session-1', url: '/sessions/session-1' }
        })

        expect(delivered).toBe(1)
        expect(received).toEqual(['allowed'])
    })

    it('hands the predicate the delivery namespace even though toast events carry none', async () => {
        // toast 事件的 schema 里 namespace 是可选的，pushNotificationChannel 也不填。
        // 谓词靠 namespace 判「未绑定资源的短暂放行窗口」，收不到就会误拦。
        const manager = new SSEManager(0, new VisibilityTracker())
        const seen: Array<string | undefined> = []

        manager.subscribe({
            id: 'conn',
            namespace: 'alpha',
            all: true,
            visibility: 'visible',
            canDeliver: (event) => { seen.push(event.namespace); return true },
            send: () => {},
            sendHeartbeat: () => {}
        })

        await manager.sendToast('alpha', {
            type: 'toast',
            data: { title: 'Ready for input', body: 'x', sessionId: 'session-1', url: '/sessions/session-1' }
        })

        expect(seen).toEqual(['alpha'])
    })
})
