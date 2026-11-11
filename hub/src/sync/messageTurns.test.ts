import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import type { Server } from 'socket.io'
import type { MessagesResponse } from '@hapi/protocol/apiTypes'
import { TURN_PAGE_ROW_LIMIT, mergeTurnSegments } from '@hapi/protocol/messageTurns'
import { Store } from '../store'
import type { StoredMessage } from '../store/types'
import { MessageService } from './messageService'
import type { EventPublisher } from './eventPublisher'
import type { SyncEngine } from './syncEngine'
import { createMessagesRoutes } from '../web/routes/messages'
import type { WebAppEnv } from '../web/middleware/auth'

function harness() {
    const store = new Store(':memory:')
    const session = store.sessions.getOrCreateSession('turn-pages', {}, null, 'default')
    const service = new MessageService(store, {} as Server, { emit() { } } as unknown as EventPublisher)
    const add = (role: 'user' | 'agent', at: number, text: string = role) => store.messages.addMessage(
        session.id, { role, content: { type: 'text', text } }, undefined, undefined, at
    )
    return { store, session, service, add }
}

function position(row: StoredMessage) {
    return { at: row.invokedAt ?? row.createdAt, seq: row.seq }
}

function before(page: MessagesResponse) {
    return { at: page.page.nextBeforeAt!, seq: page.page.nextBeforeSeq! }
}

function after(page: MessagesResponse) {
    return { at: page.page.nextAfterAt!, seq: page.page.nextAfterSeq! }
}

describe('turn-oriented history pagination', () => {
    it('returns entire invoked turns beyond the legacy row limit, excludes queued boundaries, and never repeats edges', async () => {
        const { store, session, service, add } = harness()
        const first = add('user', 1000)
        const answer = add('agent', 1001)
        const second = add('user', 2000)
        const rows = [second]
        for (let index = 0; index < 350; index++) rows.push(add('agent', 2001 + index))
        const queued = store.messages.addMessage(session.id, { role: 'user', content: 'queued' }, 'queued', undefined, 1500)
        await service.prepareTurnIndex(session.id)
        const latest = service.getMessagesPage(session.id, { limit: 2, turns: 1 })
        expect(latest.messages.map((row) => row.id)).toEqual([queued.id, ...rows.map((row) => row.id)])
        expect(latest.page.turns?.segments).toEqual([{
            turnId: second.id, from: position(second), to: position(rows.at(-1)!),
            completeBefore: true, completeAfter: true
        }])
        const older = service.getMessagesPage(session.id, { limit: 2, turns: 1, before: before(latest) })
        expect(older.messages.map((row) => row.id)).toEqual([first.id, answer.id])
        expect(older.page.hasMore).toBe(false)
        expect(service.getMessagesPage(session.id, { limit: 2 }).messages.length).toBeLessThanOrEqual(3)
        expect(service.getMessagesPage(session.id, { limit: 2 }).page.turns).toBeUndefined()
    })

    it('segments a huge turn with the original user ID, explicit missing sides, and exact bidirectional coverage', async () => {
        const { session, service, add } = harness()
        const user = add('user', 1000)
        const rows = [user]
        for (let i = 0; i < TURN_PAGE_ROW_LIMIT + 25; i++) rows.push(add('agent', 1001 + i, 'x'.repeat(300)))
        await service.prepareTurnIndex(session.id)
        const latest = service.getMessagesPage(session.id, { limit: 200, turns: 1 })
        expect(latest.messages.length).toBeLessThanOrEqual(TURN_PAGE_ROW_LIMIT)
        expect(latest.page.turns?.segments[0]).toMatchObject({ turnId: user.id, completeBefore: false, completeAfter: true })
        const older = service.getMessagesPage(session.id, { limit: 200, turns: 1, before: before(latest) })
        expect(older.page.turns?.segments[0]).toMatchObject({ turnId: user.id, completeBefore: true, completeAfter: false })
        expect([...older.messages, ...latest.messages].map((row) => row.id)).toEqual(rows.map((row) => row.id))
        const merged = mergeTurnSegments(latest.page.turns!.segments, older.page.turns!.segments, true)
        expect(merged).toHaveLength(1)
        expect(merged[0]).toMatchObject({ completeBefore: true, completeAfter: true })
        const forward = service.getMessagesPage(session.id, { limit: 200, turns: 1, after: position(user) })
        expect(forward.page.turns?.segments[0]).toMatchObject({ turnId: user.id, completeBefore: false, completeAfter: false })
        const rest = service.getMessagesPage(session.id, { limit: 200, turns: 1, after: after(forward) })
        expect([...forward.messages, ...rest.messages].map((row) => row.id)).toEqual(rows.slice(1).map((row) => row.id))
    })

    it('continues a byte-heavy Unicode turn in both directions without losing text or inventing complete coverage', async () => {
        const { session, service, add } = harness()
        const user = add('user', 1000)
        const records = [user]
        for (let i = 0; i < 40; i++) records.push(add('agent', 1001 + i, `${i}:` + '界'.repeat(20000)))
        await service.prepareTurnIndex(session.id)
        let page = service.getMessagesPage(session.id, { limit: 200, turns: 8 })
        expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(1100000)
        expect(page.page.turns?.segments[0]).toMatchObject({ turnId: user.id, completeBefore: false, completeAfter: true })
        const backward = [...page.messages]
        for (let attempts = 0; page.page.hasMore && attempts < records.length; attempts++) {
            page = service.getMessagesPage(session.id, { limit: 200, turns: 8, before: before(page) })
            backward.unshift(...page.messages)
        }
        expect(page.page.hasMore).toBe(false)
        expect(backward.map(row => ({ id: row.id, content: row.content }))).toEqual(records.map(row => ({ id: row.id, content: row.content })))
        page = service.getMessagesPage(session.id, { limit: 200, turnId: user.id })
        expect(page.page.turns?.segments[0]).toMatchObject({ completeBefore: true, completeAfter: false })
        const forward = [...page.messages]
        const until = { at: page.page.snapshotHeadAt!, seq: page.page.snapshotHeadSeq! }
        for (let attempts = 0; page.page.hasMoreAfter && attempts < records.length; attempts++) {
            page = service.getMessagesPage(session.id, { limit: 200, turnId: user.id, after: after(page), until })
            forward.push(...page.messages)
        }
        expect(page.page.hasMoreAfter).toBe(false)
        expect(forward.map(row => row.id)).toEqual(records.map(row => row.id))
    })

    it('keeps ordinary turns whole when their combined bytes exceed the page budget', async () => {
        const { session, service, add } = harness()
        const one = [add('user', 1000)]
        for (let i = 0; i < 10; i++) one.push(add('agent', 1001 + i, '界'.repeat(20000)))
        const two = [add('user', 2000)]
        for (let i = 0; i < 10; i++) two.push(add('agent', 2001 + i, '界'.repeat(20000)))
        await service.prepareTurnIndex(session.id)
        const latest = service.getMessagesPage(session.id, { limit: 200, turns: 8 })
        expect(latest.messages.map(row => row.id)).toEqual(two.map(row => row.id))
        expect(latest.page.turns?.segments[0]).toMatchObject({ completeBefore: true, completeAfter: true })
        const forward = service.getMessagesPage(session.id, { limit: 200, turns: 8, after: position(one[0]) })
        expect(forward.messages.map(row => row.id)).toEqual(one.slice(1).map(row => row.id))
        expect(forward.page.turns?.segments[0]).toMatchObject({ completeBefore: false, completeAfter: true })
    })

    it('returns an oversized individual prompt intact and advances past it', async () => {
        const { session, service, add } = harness()
        const user = add('user', 1000, '界'.repeat(400000))
        const answer = add('agent', 1001, 'done')
        await service.prepareTurnIndex(session.id)
        const first = service.getMessagesPage(session.id, { limit: 200, turnId: user.id })
        expect(first.messages.map(row => row.content)).toEqual([user.content])
        expect(first.page.hasMoreAfter).toBe(true)
        const next = service.getMessagesPage(session.id, { limit: 200, turnId: user.id, after: after(first) })
        expect(next.messages.map(row => row.id)).toEqual([answer.id])
        expect(next.page.hasMoreAfter).toBe(false)
    })

    it('uses position rather than ingestion seq, revalidates late records/consumption, and freezes forward snapshots', async () => {
        const { store, session, service, add } = harness()
        const old = add('user', 1000)
        const head = add('agent', 3000)
        const middle = add('user', 2000)
        await service.prepareTurnIndex(session.id)
        const latest = service.getMessagesPage(session.id, { limit: 200, turns: 1 })
        expect(latest.messages.map((row) => row.id)).toEqual([middle.id, head.id])
        const epoch = latest.page.epoch
        const late = add('agent', 2500)
        const reset = service.getMessagesPage(session.id, { limit: 200, turns: 1, after: position(head), epoch })
        expect(reset.page.reset).toBe(true)
        expect(reset.messages.map((row) => row.id)).toEqual([middle.id, late.id, head.id])
        const queued = store.messages.addMessage(session.id, { role: 'user', content: 'held' }, 'held', undefined, 1500)
        const beforeInvokeEpoch = store.messages.getMessageEpoch(session.id)
        store.messages.markMessagesInvoked(session.id, ['held'], 2200)
        expect(store.messages.getMessageEpoch(session.id)).toBeGreaterThan(beforeInvokeEpoch)
        const reordered = service.getMessagesPage(session.id, { limit: 200, turns: 1 })
        expect(reordered.page.turns?.segments[0]?.turnId).toBe(queued.id)
        const appended = add('agent', 4000)
        const frozen = service.getMessagesPage(session.id, { limit: 200, turns: 20, after: position(old), until: position(head) })
        expect(frozen.messages.map((row) => row.id)).not.toContain(appended.id)
        expect(frozen.page.hasMore).toBe(false)
    })

    it('handles equal timestamps, empty sessions and pre-user history without stalled cursors', async () => {
        const { session, service, add } = harness()
        await service.prepareTurnIndex(session.id)
        expect(service.getMessagesPage(session.id, { limit: 200, turns: 8 }).page.hasMore).toBe(false)
        const preamble = add('agent', 1000)
        const one = add('user', 1000)
        const two = add('user', 1000)
        const latest = service.getMessagesPage(session.id, { limit: 200, turns: 1 })
        expect(latest.messages.map((row) => row.id)).toEqual([two.id])
        const older = service.getMessagesPage(session.id, { limit: 200, turns: 1, before: before(latest) })
        expect(older.messages.map((row) => row.id)).toEqual([one.id])
        const oldest = service.getMessagesPage(session.id, { limit: 200, turns: 1, before: before(older) })
        expect(oldest.messages.map((row) => row.id)).toEqual([preamble.id])
        expect(oldest.page.turns?.segments[0]).toMatchObject({ turnId: null, completeBefore: true, completeAfter: true })
        expect(oldest.page.hasMore).toBe(false)
    })

    it('connects the guarded GET route to the real lazy index and turn service', async () => {
        const { session, service, add } = harness()
        const user = add('user', 1000)
        for (let i = 0; i < 250; i++) add('agent', 1001 + i)
        const engine = {
            resolveSessionAccess: () => ({ ok: true, sessionId: session.id, session }),
            prepareMessageTurnIndex: (id: string) => service.prepareTurnIndex(id),
            getMessagesPage: service.getMessagesPage.bind(service)
        } as unknown as SyncEngine
        const app = new Hono<WebAppEnv>()
        app.use('*', async (context, next) => { context.set('namespace', 'default'); await next() })
        app.route('/api', createMessagesRoutes(() => engine))
        const response = await app.request(`/api/sessions/${session.id}/messages?turns=1&limit=1`)
        expect(response.status).toBe(200)
        const result = await response.json() as MessagesResponse
        expect(result.messages).toHaveLength(251)
        expect(result.page.turns?.segments[0].turnId).toBe(user.id)
    })
    it('rechecks session authorization after yielding index preparation', async () => {
        const { session, service, add } = harness()
        add('user', 1000)
        const entered = Promise.withResolvers<void>()
        const release = Promise.withResolvers<void>()
        let revoked = false
        let queries = 0
        const engine = {
            resolveSessionAccess: () => revoked ? { ok: false, reason: 'access-denied' } : { ok: true, sessionId: session.id, session },
            prepareMessageTurnIndex: async (id: string) => {
                entered.resolve()
                await release.promise
                await service.prepareTurnIndex(id)
            },
            getMessagesPage: () => { queries++; throw new Error('revoked history must not be read') }
        } as unknown as SyncEngine
        const app = new Hono<WebAppEnv>()
        app.use('*', async (context, next) => { context.set('namespace', 'default'); await next() })
        app.route('/api', createMessagesRoutes(() => engine))
        const request = app.request(`/api/sessions/${session.id}/messages?turns=8`)
        await entered.promise
        revoked = true
        release.resolve()
        const response = await request
        expect(response.status).toBe(403)
        expect(queries).toBe(0)
    })

    it('maintains completed sparse coverage through copied and rewound histories', async () => {
        const { store, session, service } = harness()
        store.messages.addImportedMessage(session.id, { role: 'user', content: 'native user' }, 'native-user', 1000)
        store.messages.addMessage(session.id, { role: 'agent', content: 'answer' }, undefined, undefined, 1001)
        const target = store.sessions.getOrCreateSession('copy-target', {}, null, 'default')
        await service.prepareTurnIndex(target.id)
        store.messages.copyMessagesToSession(target.id, store.messages.getAllMessages(session.id))
        const copied = service.getMessagesPage(target.id, { limit: 1, turns: 8 })
        expect(copied.messages).toHaveLength(2)
        expect(copied.page.turns?.segments[0].turnId).toBe(copied.messages[0]?.id)
        store.messages.truncateMessagesFromLocalId(target.id, 'native-user', [{
            content: { role: 'user', content: 'replacement' }, localId: 'replacement', createdAt: 1500, invokedAt: 1500
        }])
        const rewound = service.getMessagesPage(target.id, { limit: 1, turns: 8 })
        expect(rewound.messages).toHaveLength(1)
        expect(rewound.page.turns?.segments[0].turnId).toBe(rewound.messages[0]?.id)
        expect(rewound.page.turns?.segments[0].turnId).not.toBe(copied.messages[0]?.id)
        const source = store.messages.getAllMessages(session.id)[0]!
        const extra = store.messages.copyMessageToSession(target.id, source)
        const updated = service.getMessagesPage(target.id, { limit: 1, turns: 8 })
        expect(updated.page.turns?.segments.map((segment) => segment.turnId)).toEqual([extra.id, rewound.messages[0]?.id])
    })

    it('reduces the turn count instead of cutting an ordinary turn when the combined page reaches the safety budget', async () => {
        const { session, service, add } = harness()
        const first = add('user', 1000)
        const one = [first]
        for (let index = 0; index < 1200; index++) one.push(add('agent', 1001 + index))
        const second = add('user', 3000)
        const two = [second]
        for (let index = 0; index < 1200; index++) two.push(add('agent', 3001 + index))
        await service.prepareTurnIndex(session.id)
        const latest = service.getMessagesPage(session.id, { limit: 1, turns: 8 })
        expect(latest.messages.map((row) => row.id)).toEqual(two.map((row) => row.id))
        expect(latest.page.turns?.segments[0]).toMatchObject({ completeBefore: true, completeAfter: true })
        const older = service.getMessagesPage(session.id, { limit: 1, turns: 8, before: before(latest) })
        expect(older.messages.map((row) => row.id)).toEqual(one.map((row) => row.id))
        const forward = service.getMessagesPage(session.id, { limit: 1, turns: 8, after: position(first) })
        expect(forward.messages.map((row) => row.id)).toEqual(one.slice(1).map((row) => row.id))
        const rest = service.getMessagesPage(session.id, { limit: 1, turns: 8, after: after(forward) })
        expect(rest.messages.map((row) => row.id)).toEqual(two.map((row) => row.id))
    })

    it('collects one large historical turn outside the cache with fixed fenced cursors and no neighboring records', async () => {
        const { session, service, add } = harness()
        const user = add('user', 1000)
        const selected = [user]
        for (let index = 0; index < TURN_PAGE_ROW_LIMIT + 10; index++) selected.push(add('agent', 1001 + index))
        const neighbor = add('user', 5000)
        add('agent', 5001)
        await service.prepareTurnIndex(session.id)
        const first = service.getMessagesPage(session.id, { limit: 1, turnId: user.id })
        expect(first.messages.length).toBeLessThanOrEqual(TURN_PAGE_ROW_LIMIT)
        expect(first.page.hasMoreAfter).toBe(true)
        expect(first.page.turns?.segments[0]).toMatchObject({ turnId: user.id, completeBefore: true, completeAfter: false })
        const second = service.getMessagesPage(session.id, {
            limit: 1, turnId: user.id, after: after(first), epoch: first.page.epoch,
            until: { at: first.page.snapshotHeadAt!, seq: first.page.snapshotHeadSeq! }
        })
        expect(second.page.hasMoreAfter).toBe(false)
        expect([...first.messages, ...second.messages].map((row) => row.id)).toEqual(selected.map((row) => row.id))
        expect(() => service.getMessagesPage(session.id, { limit: 1, turnId: user.id, after: position(neighbor) })).toThrow('outside')
        expect(() => service.getMessagesPage(session.id, { limit: 1, turnId: 'missing' })).toThrow('not found')
        add('agent', 1500)
        const changed = service.getMessagesPage(session.id, { limit: 1, turnId: user.id, after: after(first), epoch: first.page.epoch })
        expect(changed.page.reset).toBe(true)
        expect(changed.messages[0]?.id).toBe(user.id)
    })

    it('rejects unauthorized and mismatched turn reads before exposing history', async () => {
        const { store, session, service, add } = harness()
        const user = add('user', 1000)
        const other = store.sessions.getOrCreateSession('other', {}, null, 'default')
        const foreign = store.messages.addMessage(other.id, { role: 'user', content: 'foreign' })
        const held = store.messages.addMessage(session.id, { role: 'user', content: 'held' }, 'held')
        await service.prepareTurnIndex(session.id)
        expect(() => service.getMessagesPage(session.id, { limit: 1, turnId: foreign.id })).toThrow('not found')
        expect(() => service.getMessagesPage(session.id, { limit: 1, turnId: held.id })).toThrow('not found')
        let preparationCount = 0
        const engine = {
            resolveSessionAccess: () => ({ ok: false, reason: 'access-denied' }),
            prepareMessageTurnIndex: async () => { preparationCount++ },
            getMessagesPage: service.getMessagesPage.bind(service)
        } as unknown as SyncEngine
        const app = new Hono<WebAppEnv>()
        app.use('*', async (context, next) => { context.set('namespace', 'other'); await next() })
        app.route('/api', createMessagesRoutes(() => engine))
        const denied = await app.request(`/api/sessions/${session.id}/messages?turnId=${user.id}`)
        expect(denied.status).toBe(403)
        expect(preparationCount).toBe(0)
    })
    it('keeps terminal inputs history-visible without becoming executed boundaries or permanently pinned latest rows', async () => {
        const { store, session, service, add } = harness()
        try {
            const first = add('user', 1000)
            const terminal = store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: '/local' } }, 'terminal', undefined, 1500)
            const answer = add('agent', 1600)
            const second = add('user', 2000)
            const last = add('agent', 2100)
            await service.prepareTurnIndex(session.id)
            const beforeResolutionEpoch = store.messages.getMessageEpoch(session.id)
            store.messages.resolveMessages(session.id, [{ localId: 'terminal', outcome: 'handled' }], 2500)
            const latest = service.getMessagesPage(session.id, { limit: 2, turns: 1 })
            expect(latest.messages.map(row => row.id)).toEqual([second.id, last.id])
            expect(latest.page.turns?.segments.map(segment => segment.turnId)).toEqual([second.id])
            const older = service.getMessagesPage(session.id, { limit: 2, turns: 1, before: before(latest) })
            expect(older.messages.map(row => row.id)).toEqual([first.id, terminal.id, answer.id])
            expect(older.messages.find(row => row.id === terminal.id)).toMatchObject({ invokedAt: null, resolution: { outcome: 'handled', resolvedAt: 2500 } })
            expect(older.page.turns?.segments.map(segment => segment.turnId)).toEqual([first.id])
            expect(() => service.getMessagesPage(session.id, { limit: 2, turnId: terminal.id })).toThrow('not found')
            expect(service.getMessagesPage(session.id, { limit: 2, turns: 1, epoch: beforeResolutionEpoch }).page.reset).toBe(true)
            expect(service.getMessagesPage(session.id, { limit: 1 }).messages.map(row => row.id)).toEqual([last.id])
        } finally { store.close() }
    })
})
