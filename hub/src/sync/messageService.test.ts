/**
 * MessageService.cancelQueuedMessage race scenario tests
 *
 * Race-A: CLI ack returns { removed: true }  → DB DELETE + status='cancelled'
 * Race-B: CLI ack returns { removed: false } (already shift()-ed) → markMessagesInvoked + status='invoked'
 * Race-C: CLI ack times out (500 ms)         → markMessagesInvoked + status='invoked'
 * Race-D (CLI offline): no CLI socket in room → immediate DELETE, message-cancelled emit, no ack call
 * Race-E (partial ack): broadcast ack receives err + [{ removed: true }] → DELETE + status='cancelled'
 */
import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MessageService } from './messageService'
import type { EventPublisher } from './eventPublisher'
import { Store } from '../store'
import type { Server } from 'socket.io'
import type { Session, SyncEvent } from '@hapi/protocol/types'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeStore(): Store {
 return new Store(':memory:')
}

function makeSession(store: Store, tag: string) {
 return store.sessions.getOrCreateSession(tag, { path: `/tmp/${tag}` }, null, 'default')
}

function toProtocolSession(session: ReturnType<typeof makeSession>): Session {
 return {
  id: session.id,
  namespace: session.namespace,
  seq: session.seq,
  createdAt: session.createdAt,
  updatedAt: session.updatedAt,
  active: session.active,
  activeAt: session.activeAt ?? session.updatedAt,
  metadata: {
   path: `/tmp/${session.tag ?? session.id}`,
   host: 'localhost'
  },
  metadataVersion: session.metadataVersion,
  agentState: null,
  agentStateVersion: session.agentStateVersion,
  thinking: false,
  thinkingAt: session.updatedAt,
  model: session.model,
  modelReasoningEffort: session.modelReasoningEffort,
  effort: session.effort,
  serviceTier: session.serviceTier,
  resumeWithSessionModel: session.resumeWithSessionModel,
  permissionMode: 'default',
  collaborationMode: 'default'
 }
}

type AckCallback = (err: Error | null, responses: Array<{ removed: boolean }>) => void

function makeIo(onEmit: (ack: AckCallback) => void, socketCount = 1): Server {
 const broadcastRoom = {
  timeout: (_ms: number) => ({
   emit: (_event: string, _data: unknown, callback: AckCallback) => {
    onEmit(callback)
   }
  }),
  emit: () => { }
 }

 // Pre-built set reused on every rooms.get() call (socketCount=0 → undefined)
 const socketSet = socketCount > 0
  ? new Set(Array.from({ length: socketCount }, (_, i) => `socket-${i}`))
  : undefined

 return {
  of: (_ns: string) => ({
   to: (_room: string) => broadcastRoom,
   adapter: { rooms: { get: (_roomName: string) => socketSet } }
  })
 } as unknown as Server
}

function makePublisher() {
 const events: SyncEvent[] = []
 return {
  emit: (event: SyncEvent) => { events.push(event) },
  events
 }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MessageService CLI delivery extension', () => {
 it('decorates immediate, reconnect, and mature scheduled delivery without changing persistence or SSE', async () => {
  const store = makeStore()
  const session = makeSession(store, 'delivery-extension')
  const updates: unknown[] = []
  const io = {
   of: () => ({
    to: () => ({ emit: (_event: string, update: unknown) => { updates.push(update) } }),
    adapter: { rooms: { get: () => new Set(['socket-1']) } }
   })
  } as unknown as Server
  const publisher = makePublisher()
  const decorate = (content: unknown) => ({ decorated: true, original: content })
  const service = new MessageService(store, io, publisher as any, undefined, decorate)

  await service.sendMessage(session.id, { text: 'raw immediate', localId: 'immediate', deliveryMetadata: { accountId: 1 } })
  expect(updates[0]).toMatchObject({ body: { message: { content: { decorated: true } } } })
  expect(service.getMessagesPage(session.id, { limit: 10, before: null }).messages[0]?.content).toMatchObject({ content: { text: 'raw immediate' } })
  expect(publisher.events.find(event => event.type === 'message-received')).toMatchObject({ message: { content: { content: { text: 'raw immediate' } } } })
  expect(service.getDeliverableMessagesAfter(session.id, { afterSeq: 0, limit: 10, now: Date.now() })[0]?.content).toMatchObject({ decorated: true })

  await service.sendMessage(session.id, { text: 'raw scheduled', localId: 'scheduled', scheduledAt: Date.now() + 20 })
  await Bun.sleep(30)
  service.releaseMatureScheduledMessages(Date.now())
  expect(updates.at(-1)).toMatchObject({ body: { message: { content: { decorated: true } } } })
 })

 it('persists and delivers the explicit OMP input command in user message metadata', async () => {
  const store = makeStore()
  const session = makeSession(store, 'omp-input-mode')
  const updates: unknown[] = []
  const io = {
   of: () => ({
    to: () => ({ emit: (_event: string, update: unknown) => { updates.push(update) } }),
    adapter: { rooms: { get: () => new Set(['socket-1']) } }
   })
  } as unknown as Server
  const service = new MessageService(store, io, makePublisher() as any)

  await service.sendMessage(session.id, {
   text: 'steer now',
   localId: 'steer-1',
   ompInputMode: 'steer'
  })

  expect(updates[0]).toMatchObject({
   body: { message: { content: { meta: { ompInputMode: 'steer' } } } }
  })
  expect(service.getMessagesPage(session.id, { limit: 10, before: null }).messages[0]?.content).toMatchObject({
   meta: { ompInputMode: 'steer' }
  })
 })
})

describe('MessageService goal status filtering', () => {
 function redundantGoalStatusContent(message: string): unknown {
  return {
   role: 'agent',
   content: {
    id: `event-${message}`,
    type: 'event',
    data: { type: 'message', message }
   }
  }
 }

 it('hides stored redundant goal status events but keeps actionable goal messages', () => {
  const store = makeStore()
  const session = makeSession(store, 'goal-status-filter')

  store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: '/goal ship it' } })
  store.messages.addMessage(session.id, redundantGoalStatusContent('Goal active · 8016 tokens'))
  store.messages.addMessage(session.id, redundantGoalStatusContent('No goal to clear'))

  const service = new MessageService(store, makeIo(() => { }), makePublisher() as any)
  const page = service.getMessagesPage(session.id, { limit: 10, before: null })

  expect(page.messages.map(message => message.content)).toEqual([
   { role: 'user', content: { type: 'text', text: '/goal ship it' } },
   redundantGoalStatusContent('No goal to clear')
  ])
 })

 it('exports chronological visible messages and omits queued user rows', () => {
  const store = makeStore()
  const session = makeSession(store, 'session-export-visible')

  const first = store.messages.addMessage(session.id, { role: 'user', content: 'Hello' })
  const queued = store.messages.addMessage(session.id, { role: 'user', content: 'Queued' }, 'local-queued')
  store.messages.addMessage(session.id, redundantGoalStatusContent('Goal active'))
  const hiddenSystem = store.messages.addMessage(session.id, {
   role: 'agent',
   content: {
    type: 'output',
    data: { type: 'system', subtype: 'init', uuid: 'sys-init' }
   }
  })
  const second = store.messages.addMessage(session.id, { role: 'agent', content: 'Hi' })

  const service = new MessageService(store, makeIo(() => { }), makePublisher() as any)
  const result = service.getSessionExport(session.id, toProtocolSession(session))

  expect(result.type).toBe('success')
  if (result.type !== 'success') throw new Error('Expected success export')
  expect(result.payload.messages.map((message) => message.id)).toEqual([first.id, second.id])
  expect(result.payload.messages.some((message) => message.id === queued.id)).toBe(false)
  expect(result.payload.messages.some((message) => message.id === hiddenSystem.id)).toBe(false)
 })

 it('orders invoked scheduled messages by display time, not insertion seq', () => {
  const store = makeStore()
  const session = makeSession(store, 'session-export-scheduled-order')

  const scheduled = store.messages.addMessage(
   session.id,
   { role: 'user', content: { type: 'text', text: 'Scheduled' } },
   'local-scheduled',
   Date.now() + 60_000
  )
  const normal = store.messages.addMessage(
   session.id,
   { role: 'user', content: { type: 'text', text: 'Normal' } },
   'local-normal'
  )
  store.messages.markMessagesInvoked(session.id, ['local-normal'], 2_000)
  store.messages.markMessagesInvoked(session.id, ['local-scheduled'], 3_000)

  const service = new MessageService(store, makeIo(() => { }), makePublisher() as any)
  const result = service.getSessionExport(session.id, toProtocolSession(session))

  expect(result.type).toBe('success')
  if (result.type !== 'success') throw new Error('Expected success export')
  expect(result.payload.messages.map((message) => message.id)).toEqual([normal.id, scheduled.id])
 })

 it('returns too-large instead of truncating an export over the cap', () => {
  const store = makeStore()
  const session = makeSession(store, 'session-export-cap')

  store.messages.addMessage(session.id, { role: 'user', content: 'One' })
  store.messages.addMessage(session.id, { role: 'agent', content: 'Two' })

  const service = new MessageService(store, makeIo(() => { }), makePublisher() as any)
  const result = service.getSessionExport(session.id, toProtocolSession(session), 1)

  expect(result).toEqual({
   type: 'too-large',
   count: 2,
   limit: 1
  })
 })

 it('collapses superseded running agent-run-update rows and duplicate completed tool-call rows during export and supports pagination', () => {
  const store = makeStore()
  const session = makeSession(store, 'session-export-compact')

  const startMsg = store.messages.addMessage(session.id, {
   role: 'agent',
   content: {
    type: 'codex',
    data: {
     type: 'agent-run-start',
     agentId: 'sub-1',
     cardId: 'omp-subagent:sub-1',
     status: 'running'
    }
   }
  })
  for (let i = 0; i < 50; i += 1) {
   store.messages.addMessage(session.id, {
    role: 'agent',
    content: {
     type: 'codex',
     data: {
      type: 'agent-run-update',
      agentId: 'sub-1',
      cardId: 'omp-subagent:sub-1',
      status: 'running',
      activity: 'Running',
      progress: { tokens: i * 100 }
     }
    }
   })
  }
  const terminalUpdate = store.messages.addMessage(session.id, {
   role: 'agent',
   content: {
    type: 'codex',
    data: {
     type: 'agent-run-update',
     agentId: 'sub-1',
     cardId: 'omp-subagent:sub-1',
     status: 'completed',
     activity: 'Completed',
     result: 'done'
    }
   }
  })
  const toolStart = store.messages.addMessage(session.id, {
   role: 'agent',
   content: {
    type: 'codex',
    data: {
     type: 'tool-call',
     callId: 'todo-1',
     name: 'todo',
     input: { op: 'init' },
     status: 'in_progress'
    }
   }
  })
  store.messages.addMessage(session.id, {
   role: 'agent',
   content: {
    type: 'codex',
    data: {
     type: 'tool-call',
     callId: 'todo-1',
     name: 'todo',
     input: { op: 'init' },
     status: 'completed'
    }
   }
  })

  const service = new MessageService(store, makeIo(() => { }), makePublisher() as unknown as EventPublisher)
  const result = service.getSessionExport(session.id, toProtocolSession(session), 10)
  expect(result.type).toBe('success')
  if (result.type !== 'success') throw new Error('Expected success export')
  expect(result.payload.messages.map((message) => message.id)).toEqual([
   startMsg.id,
   terminalUpdate.id,
   toolStart.id
  ])

  const paged = service.getSessionExport(session.id, toProtocolSession(session), { offset: 1, limit: 1 })
  expect(paged.type).toBe('success')
  if (paged.type !== 'success') throw new Error('Expected paged success export')
  expect(paged.payload.messages.map((message) => message.id)).toEqual([terminalUpdate.id])
 })

 it('includes scratchlist text and attachment metadata in chronological order (tiann/hapi#1235)', () => {
  const store = makeStore()
  const session = makeSession(store, 'session-export-scratchlist')

  store.messages.addMessage(session.id, { role: 'user', content: 'Hello' })
  const older = store.scratchlist.create(session.id, 'Park this idea', {
   entryId: 'entry-older',
   createdAt: 1_000,
   attachments: [{
    id: 'att-1',
    filename: 'note.png',
    mimeType: 'image/png',
    size: 42,
    path: 'hapi-hub:scratchlist/att-1'
   }]
  })
  const newer = store.scratchlist.create(session.id, 'Follow up tomorrow', {
   entryId: 'entry-newer',
   createdAt: 2_000
  })
  expect(older.outcome).toBe('created')
  expect(newer.outcome).toBe('created')

  const service = new MessageService(store, makeIo(() => { }), makePublisher() as any)
  const result = service.getSessionExport(session.id, toProtocolSession(session))

  expect(result.type).toBe('success')
  if (result.type !== 'success') throw new Error('Expected success export')
  expect(result.payload.schemaVersion).toBe(2)
  expect(result.payload.scratchlist).toEqual([
   {
    entryId: 'entry-older',
    text: 'Park this idea',
    createdAt: 1_000,
    updatedAt: expect.any(Number),
    attachments: [{
     id: 'att-1',
     filename: 'note.png',
     mimeType: 'image/png',
     size: 42,
     path: 'hapi-hub:scratchlist/att-1'
    }]
   },
   {
    entryId: 'entry-newer',
    text: 'Follow up tomorrow',
    createdAt: 2_000,
    updatedAt: expect.any(Number),
    attachments: []
   }
  ])
 })

 it('emits an empty scratchlist array when the session has no notes', () => {
  const store = makeStore()
  const session = makeSession(store, 'session-export-no-scratchlist')

  const service = new MessageService(store, makeIo(() => { }), makePublisher() as any)
  const result = service.getSessionExport(session.id, toProtocolSession(session))

  expect(result.type).toBe('success')
  if (result.type !== 'success') throw new Error('Expected success export')
  expect(result.payload.scratchlist).toEqual([])
 })

 it('pages past hidden-only goal status rows', () => {
  const store = makeStore()
  const session = makeSession(store, 'goal-status-pagination')

  const user = store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: '/goal ship it' } })
  store.messages.addMessage(session.id, redundantGoalStatusContent('Goal active'))

  const service = new MessageService(store, makeIo(() => { }), makePublisher() as any)
  const latest = service.getMessagesPage(session.id, { limit: 1, before: null })

  expect(latest.messages).toHaveLength(1)
  expect(latest.messages[0]?.id).toBe(user.id)
  expect(latest.page.nextBeforeSeq).toBe(user.seq)
  expect(latest.page.hasMore).toBe(false)
 })

 it('pages past hidden-only goal status rows in position pagination', () => {
  const store = makeStore()
  const session = makeSession(store, 'goal-status-position-pagination')

  const user = store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: '/goal ship it' } })
  store.messages.addMessage(session.id, redundantGoalStatusContent('Goal active · 8016 tokens'))

  const service = new MessageService(store, makeIo(() => { }), makePublisher() as any)
  const latest = service.getMessagesPage(session.id, { limit: 1, before: null })

  expect(latest.messages).toHaveLength(1)
  expect(latest.messages[0]?.id).toBe(user.id)
  expect(latest.page.nextBeforeSeq).toBe(user.seq)
  expect(latest.page.hasMore).toBe(false)
 })
})

describe('MessageService message pagination', () => {
 function makeService(store: Store): MessageService {
  return new MessageService(store, makeIo(() => { }), makePublisher() as any)
 }

 it('returns the latest page with a composite cursor', () => {
  const store = makeStore()
  const session = makeSession(store, 'page-first')
  const first = store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'first' } }, 'local-first')
  const second = store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'second' } }, 'local-second')
  const third = store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'third' } }, 'local-third')
  store.messages.markMessagesInvoked(session.id, ['local-first'], 1_000)
  store.messages.markMessagesInvoked(session.id, ['local-second'], 2_000)
  store.messages.markMessagesInvoked(session.id, ['local-third'], 3_000)
  const epoch = store.messages.getMessageEpoch(session.id)

  const page = makeService(store).getMessagesPage(session.id, { limit: 2, before: null })

  expect(page.messages.map((message) => message.id)).toEqual([second.id, third.id])
  expect(page.page.nextBeforeAt).toBe(2_000)
  expect(page.page.nextBeforeSeq).toBe(second.seq)
  expect(page.page.direction).toBe('latest')
  expect(page.page.epoch).toBe(epoch)
  expect(page.page.reset).toBe(false)
  expect(page.page.snapshotHeadAt).toBe(3_000)
  expect(page.page.snapshotHeadSeq).toBe(third.seq)
  expect(page.page.hasMore).toBe(true)
  expect(first.id).toBeDefined()
 })

 it('uses the composite cursor for older pages', () => {
  const store = makeStore()
  const session = makeSession(store, 'page-older')
  const first = store.messages.addMessage(session.id, 'first', 'local-first')
  const second = store.messages.addMessage(session.id, 'second', 'local-second')
  const third = store.messages.addMessage(session.id, 'third', 'local-third')
  store.messages.markMessagesInvoked(session.id, ['local-first'], 1_000)
  store.messages.markMessagesInvoked(session.id, ['local-second'], 2_000)
  store.messages.markMessagesInvoked(session.id, ['local-third'], 3_000)

  const latest = makeService(store).getMessagesPage(session.id, { limit: 2, before: null })
  const older = makeService(store).getMessagesPage(session.id, {
   limit: 2,
   before: { at: latest.page.nextBeforeAt!, seq: latest.page.nextBeforeSeq! }
  })

  expect(older.messages.map((message) => message.id)).toEqual([first.id])
  expect(older.page.nextBeforeAt).toBe(1_000)
  expect(older.page.nextBeforeSeq).toBe(first.seq)
  expect(older.page.direction).toBe('before')
  expect(older.page.hasMore).toBe(false)
  expect(second.id).toBeDefined()
  expect(third.id).toBeDefined()
 })

 it('breaks equal timestamp ties by seq', () => {
  const store = makeStore()
  const session = makeSession(store, 'page-tie')
  const first = store.messages.addMessage(session.id, 'first', 'local-first')
  const second = store.messages.addMessage(session.id, 'second', 'local-second')
  const third = store.messages.addMessage(session.id, 'third', 'local-third')
  store.messages.markMessagesInvoked(session.id, ['local-first', 'local-second', 'local-third'], 1_000)

  const latest = makeService(store).getMessagesPage(session.id, { limit: 2, before: null })
  const older = makeService(store).getMessagesPage(session.id, {
   limit: 2,
   before: { at: latest.page.nextBeforeAt!, seq: latest.page.nextBeforeSeq! }
  })

  expect(latest.messages.map((message) => message.id)).toEqual([second.id, third.id])
  expect(latest.page.nextBeforeAt).toBe(1_000)
  expect(latest.page.nextBeforeSeq).toBe(second.seq)
  expect(older.messages.map((message) => message.id)).toEqual([first.id])
 })

 it('orders scheduled queued messages by their display position without changing the cursor', () => {
  const store = makeStore()
  const session = makeSession(store, 'page-scheduled')
  const scheduled = store.messages.addMessage(session.id, 'scheduled', 'local-scheduled', Date.now() + 60_000)
  const invoked = store.messages.addMessage(session.id, 'invoked', 'local-invoked')
  store.messages.markMessagesInvoked(session.id, ['local-invoked'], scheduled.createdAt + 1_000)

  const page = makeService(store).getMessagesPage(session.id, { limit: 1, before: null })

  expect(page.messages.map((message) => message.id)).toEqual([scheduled.id, invoked.id])
  expect(page.page.nextBeforeAt).toBe(scheduled.createdAt + 1_000)
  expect(page.page.nextBeforeSeq).toBe(invoked.seq)
  expect(page.page.hasMore).toBe(true)
 })

 for (const turns of [undefined, 1]) {
  it(`pages forward to a fixed snapshot head (${turns === undefined ? 'legacy' : 'turn'} paging)`, async () => {
   const store = makeStore()
   const session = makeSession(store, 'page-after')
   const first = store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'first' } }, 'local-first')
   const second = store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'second' } }, 'local-second')
   const third = store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'third' } }, 'local-third')
   const fourth = store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'fourth' } }, 'local-fourth')
   store.messages.markMessagesInvoked(session.id, ['local-first'], 1_000)
   store.messages.markMessagesInvoked(session.id, ['local-second'], 2_000)
   store.messages.markMessagesInvoked(session.id, ['local-third'], 3_000)
   store.messages.markMessagesInvoked(session.id, ['local-fourth'], 4_000)

   const service = makeService(store)
   if (turns !== undefined) await service.prepareTurnIndex(session.id)
   const epoch = store.messages.getMessageEpoch(session.id)
   const firstDelta = service.getMessagesPage(session.id, {
    limit: 1,
    turns,
    after: { at: 1_000, seq: first.seq },
    epoch
   })

   expect(firstDelta.messages.map((message) => message.id)).toEqual([second.id])
   expect(firstDelta.page).toMatchObject({
    direction: 'after',
    nextAfterAt: 2_000,
    nextAfterSeq: second.seq,
    snapshotHeadAt: 4_000,
    snapshotHeadSeq: fourth.seq,
    hasMore: true,
    reset: false
   })

   // A new execution event is an append, unlike acknowledging an existing
   // queued row (which changes its display position and turn membership).
   const fifth = store.messages.addMessage(session.id, {
    role: 'agent', content: { type: 'text', text: 'fifth' }
   }, undefined, undefined, 5_000)
   expect(store.messages.getMessageEpoch(session.id)).toBe(epoch)

   const secondDelta = service.getMessagesPage(session.id, {
    limit: 10,
    turns: turns === undefined ? undefined : 20,
    after: { at: firstDelta.page.nextAfterAt!, seq: firstDelta.page.nextAfterSeq! },
    until: { at: firstDelta.page.snapshotHeadAt!, seq: firstDelta.page.snapshotHeadSeq! },
    epoch: firstDelta.page.epoch
   })

   expect(secondDelta.messages.map((message) => message.id)).toEqual([third.id, fourth.id])
   expect([...firstDelta.messages, ...secondDelta.messages].map((message) => message.id)).toEqual([
    second.id, third.id, fourth.id
   ])
   expect(secondDelta.page).toMatchObject({
    direction: 'after',
    epoch,
    reset: false,
    snapshotHeadAt: firstDelta.page.snapshotHeadAt,
    snapshotHeadSeq: firstDelta.page.snapshotHeadSeq
   })
   expect(secondDelta.page.hasMore).toBe(false)
   expect(secondDelta.messages.some((message) => message.id === fifth.id)).toBe(false)
   expect(service.getMessagesPage(session.id, { limit: 1 }).messages.map((message) => message.id)).toEqual([fifth.id])
  })
 }

 it('completes a fixed snapshot when no raw row remains before its head', () => {
  const store = makeStore()
  const session = makeSession(store, 'page-after-empty-snapshot-gap')
  const first = store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'first' } }, 'local-first')
  const latest = store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'latest' } }, 'local-latest')
  store.messages.markMessagesInvoked(session.id, ['local-first'], 1_000)
  store.messages.markMessagesInvoked(session.id, ['local-latest'], 4_000)
  const epoch = store.messages.getMessageEpoch(session.id)

  const response = makeService(store).getMessagesPage(session.id, {
   limit: 10,
   after: { at: 2_000, seq: first.seq },
   until: { at: 3_000, seq: latest.seq },
   epoch
  })

  expect(response.messages).toEqual([])
  expect(response.page).toMatchObject({
   direction: 'after',
   epoch,
   reset: false,
   nextAfterAt: 3_000,
   nextAfterSeq: latest.seq,
   snapshotHeadAt: 3_000,
   snapshotHeadSeq: latest.seq,
   hasMore: false
  })
 })

 it('returns a reset latest page when the structural epoch changed', () => {
  const store = makeStore()
  const session = makeSession(store, 'page-after-reset')
  const first = store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'first' } }, 'local-first')
  store.messages.markMessagesInvoked(session.id, ['local-first'], 1_000)
  const queued = store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'queued' } }, 'local-queued')
  const epoch = store.messages.getMessageEpoch(session.id)
  store.messages.cancelQueuedMessage(session.id, queued.id)

  const response = makeService(store).getMessagesPage(session.id, {
   limit: 10,
   after: { at: 1_000, seq: first.seq },
   epoch
  })

  expect(response.page.direction).toBe('latest')
  expect(response.page.reset).toBe(true)
  expect(response.page.epoch).toBe(store.messages.getMessageEpoch(session.id))
  expect(response.page.epoch).not.toBe(epoch)
  expect(response.messages.map((message) => message.id)).toEqual([first.id])
 })

 for (const turns of [undefined, 20]) {
  it(`resets a stale snapshot when an existing queued prompt is invoked (${turns === undefined ? 'legacy' : 'turn'} paging)`, async () => {
   const store = makeStore()
   const session = makeSession(store, `page-invoked-reset-${turns ?? 'legacy'}`)
   const first = store.messages.addMessage(session.id, {
    role: 'user', content: { type: 'text', text: 'first' }
   }, undefined, undefined, 1_000)
   const queued = store.messages.addMessage(session.id, {
    role: 'user', content: { type: 'text', text: 'queued' }
   }, 'local-queued', undefined, 1_500)
   const head = store.messages.addMessage(session.id, {
    role: 'agent', content: { type: 'text', text: 'answer' }
   }, undefined, undefined, 3_000)
   const service = makeService(store)
   if (turns !== undefined) await service.prepareTurnIndex(session.id)
   const snapshot = service.getMessagesPage(session.id, { limit: 10, turns })

   // This is not a new tail event: an already-visible queued row becomes
   // an execution boundary behind the cursor. Continuing would skip it.
   expect(snapshot.messages.filter((message) => message.id === queued.id)).toHaveLength(1)
   expect(snapshot.messages.find((message) => message.id === queued.id)?.invokedAt).toBeNull()
   expect(store.messages.markMessagesInvoked(session.id, ['local-queued'], 2_000)).toBe(1)
   const request = {
    limit: 10, turns,
    after: { at: snapshot.page.snapshotHeadAt!, seq: snapshot.page.snapshotHeadSeq! },
    until: { at: snapshot.page.snapshotHeadAt!, seq: snapshot.page.snapshotHeadSeq! },
    epoch: snapshot.page.epoch
   }
   const reset = service.getMessagesPage(session.id, request)
   expect(reset.page).toMatchObject({
    direction: 'latest', reset: true,
    epoch: store.messages.getMessageEpoch(session.id),
    snapshotHeadAt: 3_000, snapshotHeadSeq: head.seq
   })
   expect(reset.page.epoch).not.toBe(snapshot.page.epoch)
   expect(reset.messages.map((message) => message.id)).toEqual([first.id, queued.id, head.id])
   expect(reset.messages.find((message) => message.id === queued.id)?.invokedAt).toBe(2_000)
   if (turns !== undefined) {
    expect(reset.page.turns?.segments.map((segment) => segment.turnId)).toEqual([first.id, queued.id])
   }

   // Duplicate acknowledgements must not move the row or invalidate again.
   expect(store.messages.markMessagesInvoked(session.id, ['local-queued'], 4_000)).toBe(0)
   const settled = service.getMessagesPage(session.id, { ...request, epoch: reset.page.epoch })
   expect(settled.messages).toEqual([])
   expect(settled.page).toMatchObject({ direction: 'after', reset: false, epoch: reset.page.epoch, hasMore: false })
  })
 }
})

describe('MessageService.getQueuedState', () => {
 it('returns requested queued and invoked local IDs from the requested session', () => {
  const store = makeStore()
  const session = makeSession(store, 'queued-state')
  const otherSession = makeSession(store, 'queued-state-other')
  store.messages.addMessage(session.id, 'queued', 'local-queued')
  store.messages.addMessage(session.id, 'invoked', 'local-invoked')
  store.messages.addMessage(
   session.id,
   'future scheduled',
   'local-future',
   Date.now() + 60_000
  )
  store.messages.addMessage(otherSession.id, 'other session', 'local-other')
  store.messages.markMessagesInvoked(session.id, ['local-invoked'], 1_000)

  const service = new MessageService(store, makeIo(() => { }), makePublisher() as any)

  expect(service.getQueuedState(session.id, [
   'local-queued',
   'local-invoked',
   'local-absent',
   'local-future',
   'local-other'
  ])).toEqual({
   queuedLocalIds: ['local-queued', 'local-future'],
   invokedLocalMessages: [{ localId: 'local-invoked', invokedAt: 1_000 }]
  })
  expect(service.getQueuedState(session.id, [])).toEqual({
   queuedLocalIds: [],
   invokedLocalMessages: []
  })
 })
})

describe('MessageService.cancelQueuedMessage race scenarios', () => {
 describe('Race-A: CLI ack removed:true → DELETE + status=cancelled', () => {
  it('returns cancelled and emits message-cancelled SSE after CLI confirms removal', async () => {
   const store = makeStore()
   const session = makeSession(store, 'race-a')
   const msg = store.messages.addMessage(
    session.id,
    { role: 'user', content: { type: 'text', text: 'hello' } },
    'local-a'
   )

   const publisher = makePublisher()
   const io = makeIo((callback) => {
    // CLI confirms it removed the item
    callback(null, [{ removed: true }])
   })

   const service = new MessageService(store, io, publisher as any)
   const result = await service.cancelQueuedMessage(session.id, msg.id)

   expect(result.status).toBe('cancelled')

   // Row must be gone from the DB
   const remaining = store.messages.getUninvokedLocalMessages(session.id)
   expect(remaining).toHaveLength(0)

   // message-cancelled SSE must have been broadcast
   const cancelled = publisher.events.find(e => e.type === 'message-cancelled')
   expect(cancelled).toBeDefined()

   // No messages-consumed for cancelled path (row is deleted, not invoked)
   const consumedCount = publisher.events.filter(e => e.type === 'messages-consumed').length
   expect(consumedCount).toBe(0)
  })
 })

 describe('Race-B: CLI ack removed:false (already shift()-ed) → markMessagesInvoked + status=invoked', () => {
  it('returns invoked with message row when CLI says item was already consumed', async () => {
   const store = makeStore()
   const session = makeSession(store, 'race-b')
   const msg = store.messages.addMessage(
    session.id,
    { role: 'user', content: { type: 'text', text: 'hello' } },
    'local-b'
   )

   const publisher = makePublisher()
   const io = makeIo((callback) => {
    // CLI already shifted the item before the cancel arrived
    callback(null, [{ removed: false }])
   })

   const service = new MessageService(store, io, publisher as any)
   const result = await service.cancelQueuedMessage(session.id, msg.id)

   expect(result.status).toBe('invoked')
   if (result.status === 'invoked') {
    expect(result.message.id).toBe(msg.id)
    expect(result.message.localId).toBe('local-b')
    expect(result.message.invokedAt).not.toBeNull()
   }

   // Row must still exist but now have invoked_at set
   const rows = store.messages.getMessages(session.id)
   const row = rows.find(r => r.id === msg.id)
   expect(row).toBeDefined()
   expect(row!.invokedAt).not.toBeNull()

   // No message-cancelled SSE should have been emitted
   const cancelled = publisher.events.find(e => e.type === 'message-cancelled')
   expect(cancelled).toBeUndefined()

   // messages-consumed SSE must be broadcast so other web clients clear the queued row
   const consumed = publisher.events.find(e => e.type === 'messages-consumed')
   expect(consumed).toBeDefined()
   if (consumed?.type === 'messages-consumed') {
    expect(consumed.sessionId).toBe(session.id)
    expect(consumed.localIds).toEqual(['local-b'])
    expect(typeof consumed.invokedAt).toBe('number')
   }

   // messages-consumed must be emitted exactly once
   const consumedCount = publisher.events.filter(e => e.type === 'messages-consumed').length
   expect(consumedCount).toBe(1)
  })
 })

 describe('Race-C: CLI ack timeout → markMessagesInvoked + status=invoked', () => {
  it('returns invoked with message row when CLI does not respond within timeout', async () => {
   const store = makeStore()
   const session = makeSession(store, 'race-c')
   const msg = store.messages.addMessage(
    session.id,
    { role: 'user', content: { type: 'text', text: 'hello' } },
    'local-c'
   )

   const publisher = makePublisher()
   const io = makeIo((callback) => {
    // Simulate timeout: socket.io passes an error as first arg
    callback(new Error('operation has timed out'), [])
   })

   const service = new MessageService(store, io, publisher as any)
   const result = await service.cancelQueuedMessage(session.id, msg.id)

   expect(result.status).toBe('invoked')
   if (result.status === 'invoked') {
    expect(result.message.id).toBe(msg.id)
    expect(result.message.invokedAt).not.toBeNull()
   }

   // Row must still exist with invoked_at stamped
   const rows = store.messages.getMessages(session.id)
   const row = rows.find(r => r.id === msg.id)
   expect(row).toBeDefined()
   expect(row!.invokedAt).not.toBeNull()

   // No message-cancelled SSE
   const cancelled = publisher.events.find(e => e.type === 'message-cancelled')
   expect(cancelled).toBeUndefined()

   // messages-consumed SSE must be broadcast so other web clients clear the queued row
   const consumed = publisher.events.find(e => e.type === 'messages-consumed')
   expect(consumed).toBeDefined()
   if (consumed?.type === 'messages-consumed') {
    expect(consumed.sessionId).toBe(session.id)
    expect(consumed.localIds).toEqual(['local-c'])
    expect(typeof consumed.invokedAt).toBe('number')
   }

   // messages-consumed must be emitted exactly once
   const consumedCount = publisher.events.filter(e => e.type === 'messages-consumed').length
   expect(consumedCount).toBe(1)
  })
 })

 describe('Race-D: CLI offline (room socket count === 0) → immediate DELETE, no ack', () => {
  it('returns cancelled and emits message-cancelled without calling ack when no CLI socket is connected', async () => {
   const store = makeStore()
   const session = makeSession(store, 'race-d-offline')
   const msg = store.messages.addMessage(
    session.id,
    { role: 'user', content: { type: 'text', text: 'hello' } },
    'local-offline'
   )

   let ackCalled = false
   // socketCount=0 → adapter.rooms.get() returns undefined → cliCount = 0
   const io = makeIo(() => { ackCalled = true }, 0)
   const publisher = makePublisher()

   const service = new MessageService(store, io, publisher as any)
   const result = await service.cancelQueuedMessage(session.id, msg.id)

   // Hub must return cancelled immediately
   expect(result.status).toBe('cancelled')

   // CLI ack must NOT have been called
   expect(ackCalled).toBe(false)

   // Row must be gone from the DB (immediate DELETE)
   const remaining = store.messages.getUninvokedLocalMessages(session.id)
   expect(remaining).toHaveLength(0)

   // message-cancelled SSE must have been emitted with localId
   const cancelled = publisher.events.find(e => e.type === 'message-cancelled')
   expect(cancelled).toBeDefined()
   if (cancelled?.type === 'message-cancelled') {
    expect(cancelled.localId).toBe('local-offline')
   }

   // No messages-consumed (row was deleted, not invoked)
   const consumedCount = publisher.events.filter(e => e.type === 'messages-consumed').length
   expect(consumedCount).toBe(0)

   // No invoked_at stamped (row deleted, not marked invoked)
   const rows = store.messages.getMessages(session.id)
   expect(rows.find(r => r.id === msg.id)).toBeUndefined()
  })
 })

 describe('existing store-level invoked guard (DB first-write-wins) still respected', () => {
  it('returns invoked without contacting CLI when DB row already has invoked_at', async () => {
   const store = makeStore()
   const session = makeSession(store, 'race-d-already-invoked')
   const msg = store.messages.addMessage(
    session.id,
    { role: 'user', content: { type: 'text', text: 'hello' } },
    'local-d'
   )

   // DB row was already marked invoked (e.g. by a concurrent messages-consumed)
   const invokedAt = Date.now()
   store.messages.markMessagesInvoked(session.id, ['local-d'], invokedAt)

   let cliContacted = false
   const io = makeIo(() => { cliContacted = true })
   const publisher = makePublisher()

   const service = new MessageService(store, io, publisher as any)
   const result = await service.cancelQueuedMessage(session.id, msg.id)

   expect(result.status).toBe('invoked')
   // CLI must NOT have been contacted — DB guard should short-circuit before ack
   expect(cliContacted).toBe(false)

   if (result.status === 'invoked') {
    expect(result.message.invokedAt).toBe(invokedAt)
   }

   // DB guard path: messages-consumed was already published by the prior
   // messages-consumed flow that set invoked_at.  No additional emit here.
   const consumedCount = publisher.events.filter(e => e.type === 'messages-consumed').length
   expect(consumedCount).toBe(0)
  })
 })

 describe('Race-E: partial ack — broadcast callback receives err + [{ removed: true }]', () => {
  it('returns cancelled and deletes row when at least one socket acked removal, even if err is set', async () => {
   const store = makeStore()
   const session = makeSession(store, 'race-e')
   const msg = store.messages.addMessage(
    session.id,
    { role: 'user', content: { type: 'text', text: 'hello' } },
    'local-e'
   )

   const publisher = makePublisher()
   // Reconnect-overlap scenario: one socket timed out (err set by Socket.IO),
   // but the live socket confirmed removal in responses.
   const io = makeIo((callback) => {
    callback(new Error('operation has timed out'), [{ removed: true }])
   })

   const service = new MessageService(store, io, publisher as any)
   const result = await service.cancelQueuedMessage(session.id, msg.id)

   // The live socket's ack must win — cancel is confirmed
   expect(result.status).toBe('cancelled')

   // Row must be deleted
   const remaining = store.messages.getUninvokedLocalMessages(session.id)
   expect(remaining).toHaveLength(0)

   // message-cancelled SSE must have been emitted
   const cancelled = publisher.events.find(e => e.type === 'message-cancelled')
   expect(cancelled).toBeDefined()

   // No messages-consumed (row deleted, not invoked)
   const consumedCount = publisher.events.filter(e => e.type === 'messages-consumed').length
   expect(consumedCount).toBe(0)
  })
 })
})

// ---------------------------------------------------------------------------
// #1 cancel × scheduled mature race (expected behavior documentation)
// ---------------------------------------------------------------------------

describe('MessageService — cancel × mature race (scheduled messages)', () => {
 // The 5-second mature tick widens the cancel race window for scheduled
 // messages compared to immediately-queued ones.  When mature fires first,
 // the CLI shifts the row; a subsequent cancel call gets 'not-found' from
 // the CLI ack, which stamps invoked_at (PR #568 contract preserved).
 // The web client surfaces this as "sent".  This test documents that the
 // behaviour is intentional — it is the expected outcome, not a bug.
 it('cancel after mature-emit stamps invoked_at (race resolved as invoked — expected behavior)', async () => {
  const store = makeStore()
  const session = makeSession(store, 'race-sched-mature')
  const publisher = makePublisher()

  const now = Date.now()
  const past = now - 1000
  // Add a scheduled message that is already mature
  const msg = store.messages.addMessage(
   session.id,
   { role: 'user', content: { type: 'text', text: 'sched' } },
   'local-sched-race',
   past
  )

  // Simulate: mature tick already emitted to CLI, CLI shifted the item.
  // Cancel arrives and CLI returns not-found (item already shift()-ed).
  const io = makeIo((callback) => {
   // CLI cannot remove — it already shift()-ed (mature tick beat the cancel)
   callback(null, [{ removed: false }])
  })

  const service = new MessageService(store, io, publisher as any)
  // Simulate the mature tick firing first (CLI now has the item)
  // Then cancel arrives — CLI says not-found
  const result = await service.cancelQueuedMessage(session.id, msg.id)

  // Expected behavior: invoked_at is stamped (PR #568 contract preserved)
  // Web client will show the message as "sent"
  expect(result.status).toBe('invoked')
  if (result.status === 'invoked') {
   expect(result.message.localId).toBe('local-sched-race')
   expect(result.message.invokedAt).not.toBeNull()
  }

  // messages-consumed SSE ensures web clients remove it from the queued bar
  const consumed = publisher.events.find(e => e.type === 'messages-consumed')
  expect(consumed).toBeDefined()
 })
})

// ---------------------------------------------------------------------------
// #1 cancel of future-scheduled message: must DELETE (not invoke)
// ---------------------------------------------------------------------------

describe('MessageService.cancelQueuedMessage — future-scheduled message', () => {
 // A future-scheduled message was never emitted to the CLI.
 // When the user clicks X, the hub contacts the CLI (room has sockets) and
 // CLI responds not-found — because the message was never there.
 // The hub MUST treat this as a clean delete (status='cancelled'), NOT as
 // "CLI already consumed it" (which would stamp invoked_at).
 it('cancel of future-scheduled msg with CLI online returns cancelled (not invoked)', async () => {
  const store = makeStore()
  const session = makeSession(store, 'cancel-future-sched')
  const publisher = makePublisher()

  const futureMs = Date.now() + 60_000
  const msg = store.messages.addMessage(
   session.id,
   { role: 'user', content: { type: 'text', text: 'scheduled future' } },
   'local-future-cancel',
   futureMs
  )

  // CLI responds not-found: the message was never emitted there
  let ackCalled = false
  const io = makeIo((callback) => {
   ackCalled = true
   callback(null, [{ removed: false }])
  }, 1) // 1 CLI socket online

  const service = new MessageService(store, io, publisher as any)
  const result = await service.cancelQueuedMessage(session.id, msg.id)

  // Future-scheduled cancel must succeed as 'cancelled', not 'invoked'
  expect(result.status).toBe('cancelled')

  // Row must be gone from DB (not just invoked_at stamped)
  const rows = store.messages.getMessages(session.id)
  const remaining = rows.find(r => r.id === msg.id)
  expect(remaining).toBeUndefined()

  // message-cancelled SSE must be emitted
  const cancelled = publisher.events.find(e => e.type === 'message-cancelled')
  expect(cancelled).toBeDefined()

  // messages-consumed (invoked path) must NOT be emitted
  const consumedCount = publisher.events.filter(e => e.type === 'messages-consumed').length
  expect(consumedCount).toBe(0)

  // invoked_at must never have been stamped (row deleted)
  // (row is gone, so we just verify the cancel result is not invoked)
  expect(result.status).not.toBe('invoked')

  // Short-circuit must have bypassed the CLI ack round-trip entirely.
  // ackCalled being false proves the future-scheduled path deleted the row
  // without ever contacting the CLI.
  expect(ackCalled).toBe(false)
 })

 it('cancel of future-scheduled msg when CLI offline also returns cancelled', async () => {
  const store = makeStore()
  const session = makeSession(store, 'cancel-future-sched-offline')
  const publisher = makePublisher()

  const futureMs = Date.now() + 60_000
  const msg = store.messages.addMessage(
   session.id,
   { role: 'user', content: { type: 'text', text: 'future offline' } },
   'local-future-offline',
   futureMs
  )

  let ackCalled = false
  const io = makeIo(() => { ackCalled = true }, 0) // CLI offline

  const service = new MessageService(store, io, publisher as any)
  const result = await service.cancelQueuedMessage(session.id, msg.id)

  expect(result.status).toBe('cancelled')
  expect(ackCalled).toBe(false)

  // Row must be deleted
  const rows = store.messages.getMessages(session.id)
  expect(rows.find(r => r.id === msg.id)).toBeUndefined()
 })
})

// ---------------------------------------------------------------------------
// sendMessage with scheduledAt
// ---------------------------------------------------------------------------

describe('MessageService.sendMessage with scheduledAt', () => {
 function makeNoopIo(): Server {
  let emittedUpdates: unknown[] = []
  return {
   of: (_ns: string) => ({
    to: (_room: string) => ({
     emit: (_event: string, data: unknown) => { emittedUpdates.push(data) },
     timeout: (_ms: number) => ({
      emit: () => { }
     })
    }),
    adapter: { rooms: { get: () => undefined } }
   }),
   _emittedUpdates: emittedUpdates
  } as unknown as Server
 }

 it('future scheduledAt: stores message with scheduledAt, does NOT emit to /cli', async () => {
  const store = makeStore()
  const session = makeSession(store, 'sched-future')
  const publisher = makePublisher()

  const cliEmitted: unknown[] = []
  const io = {
   of: (ns: string) => ({
    to: (_room: string) => ({
     emit: (_event: string, data: unknown) => {
      if (ns === '/cli') cliEmitted.push(data)
     },
     timeout: (_ms: number) => ({ emit: () => { } })
    }),
    adapter: { rooms: { get: () => undefined } }
   })
  } as unknown as Server

  const futureMs = Date.now() + 60_000

  const service = new MessageService(store, io, publisher as any)
  await service.sendMessage(session.id, {
   text: 'hello future',
   localId: 'local-sched',
   scheduledAt: futureMs
  })

  // DB must have the message with scheduledAt set
  const msgs = store.messages.getUninvokedLocalMessages(session.id)
  expect(msgs).toHaveLength(1)
  expect(msgs[0].scheduledAt).toBe(futureMs)

  // CLI must NOT receive the message yet (future scheduled)
  expect(cliEmitted).toHaveLength(0)

  // Web SSE must still receive message-received so the bar renders
  const received = publisher.events.find(e => e.type === 'message-received')
  expect(received).toBeDefined()
 })

 it('null scheduledAt: immediate send, emits to /cli normally', async () => {
  const store = makeStore()
  const session = makeSession(store, 'sched-null')
  const publisher = makePublisher()

  const cliEmitted: unknown[] = []
  const io = {
   of: (ns: string) => ({
    to: (_room: string) => ({
     emit: (_event: string, data: unknown) => {
      if (ns === '/cli') cliEmitted.push(data)
     },
     timeout: (_ms: number) => ({ emit: () => { } })
    }),
    adapter: { rooms: { get: () => undefined } }
   })
  } as unknown as Server

  const service = new MessageService(store, io, publisher as any)
  await service.sendMessage(session.id, { text: 'immediate', localId: 'local-imm' })

  // CLI must receive the message immediately
  expect(cliEmitted).toHaveLength(1)

  // scheduledAt must be null in DB
  const msgs = store.messages.getMessages(session.id)
  expect(msgs[0].scheduledAt).toBeNull()
 })

 it('past scheduledAt (already mature): emits to /cli immediately', async () => {
  const store = makeStore()
  const session = makeSession(store, 'sched-past')
  const publisher = makePublisher()

  const cliEmitted: unknown[] = []
  const io = {
   of: (ns: string) => ({
    to: (_room: string) => ({
     emit: (_event: string, data: unknown) => {
      if (ns === '/cli') cliEmitted.push(data)
     },
     timeout: (_ms: number) => ({ emit: () => { } })
    }),
    adapter: { rooms: { get: () => undefined } }
   })
  } as unknown as Server

  const pastMs = Date.now() - 5_000

  const service = new MessageService(store, io, publisher as any)
  await service.sendMessage(session.id, {
   text: 'past scheduled',
   localId: 'local-past',
   scheduledAt: pastMs
  })

  // Past scheduled_at is already mature → emit to CLI immediately
  expect(cliEmitted).toHaveLength(1)
 })

 // #11 TOCTOU: isFutureScheduled must use Date.now() at check time, not the
 // pre-addMessage `now` capture, to avoid a double-emit race window.
 it('#11 TOCTOU: scheduledAt exactly equal to Date.now() is treated as mature (not future)', async () => {
  const store = makeStore()
  const session = makeSession(store, 'sched-toctou')
  const publisher = makePublisher()

  const cliEmitted: unknown[] = []
  const io = {
   of: (ns: string) => ({
    to: (_room: string) => ({
     emit: (_event: string, data: unknown) => {
      if (ns === '/cli') cliEmitted.push(data)
     },
     timeout: (_ms: number) => ({ emit: () => { } })
    }),
    adapter: { rooms: { get: () => undefined } }
   })
  } as unknown as Server

  // Use a scheduledAt in the past to simulate TOCTOU: addMessage inserts
  // a row, then the post-insert check should use a fresh Date.now() which
  // is >= scheduledAt, treating it as mature and emitting to CLI.
  const scheduledAt = Date.now() - 1
  const service = new MessageService(store, io, publisher as any)
  await service.sendMessage(session.id, {
   text: 'toctou',
   localId: 'local-toctou',
   scheduledAt
  })

  // scheduledAt is in the past at emit-check time → must emit to CLI
  expect(cliEmitted).toHaveLength(1)
 })

 // Defence-in-depth: REST already rejects scheduledAt + attachments at the
 // Zod layer, but non-REST callers (Telegram bot, MCP, internal) reach
 // sendMessage directly and must hit the same invariant — otherwise the CLI
 // session's upload directory could be purged before the mature emit lands,
 // leaving @path attachment references pointing at deleted files.
 it('rejects sendMessage when scheduledAt is set and attachments are non-empty', async () => {
  const store = makeStore()
  const session = makeSession(store, 'sched-with-attachments')
  const publisher = makePublisher()
  const service = new MessageService(store, makeNoopIo(), publisher as any)

  const futureMs = Date.now() + 60_000
  await expect(
   service.sendMessage(session.id, {
    text: 'hello',
    localId: 'local-att',
    scheduledAt: futureMs,
    attachments: [{
     id: 'att-1',
     filename: 'a.png',
     mimeType: 'image/png',
     size: 10,
     path: '/tmp/a.png'
    }]
   })
  ).rejects.toThrow(/scheduled messages with attachments/)

  // Row must NOT have been inserted (throw is the first statement).
  const msgs = store.messages.getUninvokedLocalMessages(session.id)
  expect(msgs).toHaveLength(0)
 })

 it('accepts sendMessage with scheduledAt and an empty attachments array', async () => {
  const store = makeStore()
  const session = makeSession(store, 'sched-empty-attachments')
  const publisher = makePublisher()
  const service = new MessageService(store, makeNoopIo(), publisher as any)

  const futureMs = Date.now() + 60_000
  await service.sendMessage(session.id, {
   text: 'hello',
   localId: 'local-att-2',
   scheduledAt: futureMs,
   attachments: []
  })

  const msgs = store.messages.getUninvokedLocalMessages(session.id)
  expect(msgs).toHaveLength(1)
 })
})

describe('MessageService.sendMessage deliveryMode', () => {
 function makeTrackingIo(): { io: Server; cliEmitted: unknown[] } {
  const cliEmitted: unknown[] = []
  const io = {
   of: (ns: string) => ({
    to: (_room: string) => ({
     emit: (_event: string, data: unknown) => {
      if (ns === '/cli') cliEmitted.push(data)
     },
     timeout: (_ms: number) => ({ emit: () => { } })
    }),
    adapter: { rooms: { get: () => undefined } }
   })
  } as unknown as Server
  return { io, cliEmitted }
 }

 it('persists Pi steer provenance but downgrades every deferred CLI delivery to queue', async () => {
  const store = makeStore()
  const session = store.sessions.getOrCreateSession(
   'delivery-mode-pi',
   { path: '/tmp/delivery-mode-pi', host: 'localhost', flavor: 'pi' },
   null,
   'default'
  )
  const publisher = makePublisher()
  const { io, cliEmitted } = makeTrackingIo()
  const service = new MessageService(store, io, publisher as any)

  await service.sendMessage(session.id, {
   text: 'steer this Pi turn',
   localId: 'pi-steer',
   deliveryMode: 'steer'
  })

  const stored = store.messages.getUninvokedLocalMessages(session.id)
  expect(stored).toHaveLength(1)
  expect(stored[0]?.content).toMatchObject({
   role: 'user',
   meta: { sentFrom: 'webapp', deliveryMode: 'steer' }
  })
  expect(cliEmitted).toHaveLength(1)
  expect(cliEmitted[0]).toMatchObject({
   body: { message: { content: { meta: { deliveryMode: 'steer' } } } }
  })

  expect(service.replayImmediateQueuedMessages(session.id)).toBe(1)
  expect(cliEmitted).toHaveLength(2)
  expect(cliEmitted[1]).toMatchObject({
   body: { message: { content: { meta: { deliveryMode: 'queue' } } } }
  })

  const backfill = service.getDeliverableMessagesAfter(session.id, {
   afterSeq: 0,
   limit: 10,
   now: Date.now()
  })
  expect(backfill).toHaveLength(1)
  expect(backfill[0]?.content).toMatchObject({ meta: { deliveryMode: 'queue' } })

  expect(service.releaseDeliverableQueuedMessages(session.id)).toBe(1)
  expect(cliEmitted).toHaveLength(3)
  expect(cliEmitted[2]).toMatchObject({
   body: { message: { content: { meta: { deliveryMode: 'queue' } } } }
  })

  // Deferred delivery is a view transformation only. The database keeps
  // the original provenance for Web display and diagnostics.
  expect(store.messages.getUninvokedLocalMessages(session.id)[0]?.content).toMatchObject({
   role: 'user',
   meta: { sentFrom: 'webapp', deliveryMode: 'steer' }
  })
 })

 it('delivers a duplicate-localId retry as queue even when the stored row retains steer', async () => {
  const store = makeStore()
  const session = store.sessions.getOrCreateSession(
   'delivery-mode-duplicate-pi',
   { path: '/tmp/delivery-mode-duplicate-pi', host: 'localhost', flavor: 'pi' },
   null,
   'default'
  )
  const { io, cliEmitted } = makeTrackingIo()
  const service = new MessageService(store, io, makePublisher() as any)

  await service.sendMessage(session.id, {
   text: 'original steer whose response is lost',
   localId: 'duplicate-steer',
   deliveryMode: 'steer'
  })
  await service.sendMessage(session.id, {
   text: 'retry requests queue',
   localId: 'duplicate-steer',
   deliveryMode: 'queue'
  })

  expect(cliEmitted).toHaveLength(2)
  expect(cliEmitted[0]).toMatchObject({
   body: { message: { content: { meta: { deliveryMode: 'steer' } } } }
  })
  expect(cliEmitted[1]).toMatchObject({
   body: { message: { content: { meta: { deliveryMode: 'queue' } } } }
  })
  const rows = store.messages.getUninvokedLocalMessages(session.id)
  expect(rows).toHaveLength(1)
  expect(rows[0]?.content).toMatchObject({
   role: 'user',
   content: { text: 'original steer whose response is lost' },
   meta: { sentFrom: 'webapp', deliveryMode: 'steer' }
  })
 })

 it('downgrades a legacy persisted steer through the mature scheduled scan', () => {
  const store = makeStore()
  const session = store.sessions.getOrCreateSession(
   'delivery-mode-mature-pi',
   { path: '/tmp/delivery-mode-mature-pi', host: 'localhost', flavor: 'pi' },
   null,
   'default'
  )
  const publisher = makePublisher()
  const { io, cliEmitted } = makeTrackingIo()
  const service = new MessageService(store, io, publisher as any)
  const scheduledAt = Date.now() - 1_000

  store.messages.addMessage(
   session.id,
   {
    role: 'user',
    content: { type: 'text', text: 'legacy scheduled steer' },
    meta: { sentFrom: 'webapp', deliveryMode: 'steer' }
   },
   'mature-steer',
   scheduledAt
  )

  service.releaseMatureScheduledMessages(Date.now())

  expect(cliEmitted).toHaveLength(1)
  expect(cliEmitted[0]).toMatchObject({
   body: { message: { content: { meta: { deliveryMode: 'queue' } } } }
  })
  expect(store.messages.getUninvokedLocalMessages(session.id)[0]?.content).toMatchObject({
   role: 'user',
   meta: { sentFrom: 'webapp', deliveryMode: 'steer' }
  })
 })

 it('leaves non-user and already-queued content unchanged during CLI backfill', () => {
  const store = makeStore()
  const session = makeSession(store, 'delivery-mode-backfill-guards')
  const service = new MessageService(store, makeTrackingIo().io, makePublisher() as any)
  const agentContent = {
   role: 'agent',
   content: { type: 'text', text: 'agent event' },
   meta: { deliveryMode: 'steer', marker: 'keep-agent' }
  }
  const userWithoutMeta = {
   role: 'user',
   content: { type: 'text', text: 'legacy user' }
  }
  const queuedUser = {
   role: 'user',
   content: { type: 'text', text: 'already queued' },
   meta: { sentFrom: 'webapp', deliveryMode: 'queue', marker: 'keep-user' }
  }

  store.messages.addMessage(session.id, agentContent)
  store.messages.addMessage(session.id, userWithoutMeta, 'legacy-user')
  store.messages.addMessage(session.id, queuedUser, 'queued-user')

  const backfill = service.getDeliverableMessagesAfter(session.id, {
   afterSeq: 0,
   limit: 10,
   now: Date.now()
  })

  expect(backfill.map((message) => message.content)).toEqual([
   agentContent,
   userWithoutMeta,
   queuedUser
  ])
 })

 it('downgrades forged steer intent for non-Pi sessions and defaults omitted intent to queue', async () => {
  const store = makeStore()
  const session = makeSession(store, 'delivery-mode-non-pi')
  const service = new MessageService(store, makeTrackingIo().io, makePublisher() as any)

  await service.sendMessage(session.id, {
   text: 'forged steer',
   localId: 'non-pi-steer',
   deliveryMode: 'steer'
  })
  await service.sendMessage(session.id, {
   text: 'missing mode',
   localId: 'missing-mode'
  })

  const rows = store.messages.getUninvokedLocalMessages(session.id)
  expect(rows).toHaveLength(2)
  expect(rows.map((row) => {
   const content = row.content as { meta?: { deliveryMode?: unknown } }
   return content.meta?.deliveryMode
  })).toEqual(['queue', 'queue'])
 })

 it('normalizes direct scheduled steer requests to queue', async () => {
  const store = makeStore()
  const session = store.sessions.getOrCreateSession(
   'delivery-mode-pi-scheduled',
   { path: '/tmp/delivery-mode-pi-scheduled', host: 'localhost', flavor: 'pi' },
   null,
   'default'
  )
  const service = new MessageService(store, makeTrackingIo().io, makePublisher() as any)

  await service.sendMessage(session.id, {
   text: 'scheduled steer',
   localId: 'pi-scheduled-steer',
   scheduledAt: Date.now() + 60_000,
   deliveryMode: 'steer'
  })

  expect(store.messages.getUninvokedLocalMessages(session.id)[0]?.content).toMatchObject({
   meta: { deliveryMode: 'queue' }
  })
 })
})

// ---------------------------------------------------------------------------
// releaseMatureScheduledMessages
// ---------------------------------------------------------------------------

describe('MessageService.releaseMatureScheduledMessages', () => {
 function makeTrackingIo(): { io: Server; cliEmitted: unknown[] } {
  const cliEmitted: unknown[] = []
  const io = {
   of: (ns: string) => ({
    to: (_room: string) => ({
     emit: (_event: string, data: unknown) => {
      if (ns === '/cli') cliEmitted.push(data)
     },
     timeout: (_ms: number) => ({ emit: () => { } })
    }),
    adapter: { rooms: { get: () => undefined } }
   })
  } as unknown as Server
  return { io, cliEmitted }
 }

 it('emits mature messages to /cli', async () => {
  const store = makeStore()
  const session = makeSession(store, 'release-emit')
  const publisher = makePublisher()
  const { io, cliEmitted } = makeTrackingIo()

  const now = Date.now()
  const past = now - 1000
  // Insert mature scheduled message directly via store
  store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'hi' } }, 'local-r', past)

  const service = new MessageService(store, io, publisher as any)
  service.releaseMatureScheduledMessages(now)

  expect(cliEmitted).toHaveLength(1)
 })

 it('emits scheduled-matured once per session for web session-list refresh', async () => {
  const store = makeStore()
  const session = makeSession(store, 'release-sse')
  const publisher = makePublisher()
  const { io } = makeTrackingIo()

  const now = Date.now()
  const past = now - 1000
  store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'one' } }, 'local-a', past)
  store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'two' } }, 'local-b', past)

  const service = new MessageService(store, io, publisher as any)
  service.releaseMatureScheduledMessages(now)

  const matured = publisher.events.filter((event) => event.type === 'scheduled-matured')
  expect(matured).toEqual([{ type: 'scheduled-matured', sessionId: session.id }])
 })

 it('does NOT re-emit scheduled-matured on later ticks while CLI ack is pending', async () => {
  const store = makeStore()
  const session = makeSession(store, 'release-sse-no-repeat')
  const publisher = makePublisher()
  const { io } = makeTrackingIo()

  const now = Date.now()
  const past = now - 1000
  store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'hi' } }, 'local-repeat', past)

  const service = new MessageService(store, io, publisher as any)
  service.releaseMatureScheduledMessages(now)
  service.releaseMatureScheduledMessages(now + 60_000)

  const matured = publisher.events.filter((event) => event.type === 'scheduled-matured')
  expect(matured).toHaveLength(1)
 })

 it('emits scheduled-matured when first scan is long after scheduled_at', async () => {
  const store = makeStore()
  const session = makeSession(store, 'release-sse-late-scan')
  const publisher = makePublisher()
  const { io } = makeTrackingIo()

  const now = Date.now()
  const past = now - 60_000
  store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'hi' } }, 'local-late', past)

  const service = new MessageService(store, io, publisher as any)
  service.releaseMatureScheduledMessages(now)

  const matured = publisher.events.filter((event) => event.type === 'scheduled-matured')
  expect(matured).toEqual([{ type: 'scheduled-matured', sessionId: session.id }])
 })

 it('does NOT call markMessagesInvoked (pitfall #2 guard): message is re-emitted on next tick', async () => {
  const store = makeStore()
  const session = makeSession(store, 'release-no-mark')
  const publisher = makePublisher()
  const { io, cliEmitted } = makeTrackingIo()

  const now = Date.now()
  const past = now - 1000
  store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'hi' } }, 'local-nm', past)

  const service = new MessageService(store, io, publisher as any)

  // First tick
  service.releaseMatureScheduledMessages(now)
  expect(cliEmitted).toHaveLength(1)

  // Second tick (simulating hub restart without CLI ack): must re-emit
  service.releaseMatureScheduledMessages(now + 5_000)
  expect(cliEmitted).toHaveLength(2)

  // invoked_at must still be NULL (not marked)
  const msgs = store.messages.getMessages(session.id)
  const msg = msgs.find(m => m.localId === 'local-nm')!
  expect(msg.invokedAt).toBeNull()
 })

 it('does NOT emit future scheduled messages', async () => {
  const store = makeStore()
  const session = makeSession(store, 'release-future')
  const publisher = makePublisher()
  const { io, cliEmitted } = makeTrackingIo()

  const now = Date.now()
  const future = now + 60_000
  store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'hi' } }, 'local-f', future)

  const service = new MessageService(store, io, publisher as any)
  service.releaseMatureScheduledMessages(now)

  expect(cliEmitted).toHaveLength(0)
 })

 it('does NOT emit already-invoked messages', async () => {
  const store = makeStore()
  const session = makeSession(store, 'release-invoked')
  const publisher = makePublisher()
  const { io, cliEmitted } = makeTrackingIo()

  const now = Date.now()
  const past = now - 1000
  store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'hi' } }, 'local-inv', past)
  store.messages.markMessagesInvoked(session.id, ['local-inv'], now - 500)

  const service = new MessageService(store, io, publisher as any)
  service.releaseMatureScheduledMessages(now)

  expect(cliEmitted).toHaveLength(0)
 })

 // #10: true cold-start restart simulation — new Store + new MessageService
 // share the same SQLite file, replicating what hub restart actually does.
 it('#10 hub cold-start restart: mature message is re-emitted by new Store+Service (true restart sim)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hapi-restart-test-'))
  const dbPath = join(dir, 'test.db')
  let store1: Store | undefined
  let store2: Store | undefined
  try {
   // First "run": write a mature scheduled message to disk
   store1 = new Store(dbPath)
   const session = store1.sessions.getOrCreateSession('restart-test', { path: '/tmp/restart' }, null, 'default')
   const sessionId = session.id
   const now = Date.now()
   const past = now - 2000
   store1.messages.addMessage(sessionId, { role: 'user', content: { type: 'text', text: 'restart me' } }, 'local-restart', past)

   // Simulate hub shutdown before opening a fresh Store.
   store1.close()
   store1 = undefined

   // Second "run": fresh Store + fresh MessageService (cold start)
   store2 = new Store(dbPath)
   const cliEmitted: unknown[] = []
   const io2 = {
    of: (ns: string) => ({
     to: (_room: string) => ({
      emit: (_event: string, data: unknown) => {
       if (ns === '/cli') cliEmitted.push(data)
      },
      timeout: (_ms: number) => ({ emit: () => { } })
     }),
     adapter: { rooms: { get: () => undefined } }
    })
   } as unknown as Server
   const publisher2 = { emit: () => { }, events: [] }

   const service2 = new MessageService(store2, io2, publisher2 as any)
   // After cold start, first tick should discover and emit the mature message
   service2.releaseMatureScheduledMessages(now + 5_000)

   expect(cliEmitted).toHaveLength(1)

   // invoked_at must still be null (CLI hasn't acked yet)
   const msgs = store2.messages.getMessages(sessionId)
   const msg = msgs.find(m => m.localId === 'local-restart')!
   expect(msg.invokedAt).toBeNull()
  } finally {
   store2?.close()
   store1?.close()
   rmSync(dir, { recursive: true, force: true })
  }
 })
})


describe('MessageService.forceSendQueuedMessages', () => {
 function forceIo(responses: unknown[] = [], error: Error | null = null) {
  const updates: Array<{ body: { t: string } }> = []
  const io = {
   of: () => ({
    to: () => ({
     emit: (_event: string, update: { body: { t: string } }) => { updates.push(update) },
     timeout: () => ({
      emit: (_event: string, update: { body: { t: string } }, ack: (error: Error | null, responses: unknown[]) => void) => {
       updates.push(update)
       ack(error, responses)
      }
     })
    })
   })
  } as unknown as Server
  return { io, updates }
 }

 it('snapshots all pending identities, persists requests and never fakes consumption', async () => {
  const store = makeStore()
  try {
   const session = makeSession(store, 'force-all')
   for (let i = 0; i < 230; i++) store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: `input ${i}` } }, `local-${i}`)
   const { io, updates } = forceIo([{ results: Array.from({ length: 230 }, (_, i) => ({ localId: `local-${i}`, status: 'accepted' })) }])
   const publisher = makePublisher()
   const service = new MessageService(store, io, publisher as unknown as ConstructorParameters<typeof MessageService>[2])
   const result = await service.forceSendQueuedMessages(session.id)
   expect(result.results).toHaveLength(230)
   expect(result.results.every(row => row.status === 'dispatched')).toBe(true)
   expect(result.messages.every(row => row.invokedAt === null)).toBe(true)
   expect(updates.filter(update => update.body.t === 'new-message')).toHaveLength(230)
   expect(store.messages.getAllMessages(session.id)[0]?.content).toMatchObject({ meta: { forceSendRequestedAt: expect.any(Number) } })
   expect(publisher.events.filter(event => event.type === 'messages-consumed')).toHaveLength(0)
   const repeated = await service.forceSendQueuedMessages(session.id)
   expect(repeated.messages.map(row => row.id)).toEqual(result.messages.map(row => row.id))
   expect(store.messages.getAllMessages(session.id)).toHaveLength(230)
  } finally { store.close() }
 })

 it('retains offline, unsupported and partial-ack rows without clearing the queue', async () => {
  const store = makeStore()
  try {
   const session = makeSession(store, 'force-partial')
   for (const id of ['accepted', 'unsupported', 'missing']) store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: id } }, id)
   const { io } = forceIo([{ results: [{ localId: 'accepted', status: 'promoted' }, { localId: 'unsupported', status: 'unsupported', error: 'old native' }] }], new Error('partial timeout'))
   const service = new MessageService(store, io, makePublisher() as unknown as ConstructorParameters<typeof MessageService>[2])
   const result = await service.forceSendQueuedMessages(session.id)
   expect(result.results.map(row => row.status)).toEqual(['dispatched', 'failed', 'pending'])
   expect(store.messages.getUninvokedLocalMessages(session.id)).toHaveLength(3)
   const offline = await service.forceSendQueuedMessages(session.id, {}, false)
   expect(offline.results.every(row => row.status === 'pending')).toBe(true)
  } finally { store.close() }
 })

 it('publishes pending rows before a delayed runner ack and never regresses a racing consumption receipt', async () => {
  const store = makeStore()
  try {
   const session = makeSession(store, 'force-racing-receipt')
   store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'retain me' } }, 'racing')
   const waiting = Promise.withResolvers<(error: Error | null, responses: unknown[]) => void>()
   const io = {
    of: () => ({
     to: () => ({
      emit() { },
      timeout: () => ({ emit: (_event: string, _update: unknown, ack: (error: Error | null, responses: unknown[]) => void) => waiting.resolve(ack) })
     })
    })
   } as unknown as Server
   const publisher = makePublisher()
   const service = new MessageService(store, io, publisher as unknown as EventPublisher)
   const request = service.forceSendQueuedMessages(session.id)
   const acknowledge = await waiting.promise
   expect(publisher.events.filter(event => event.type === 'message-received')).toMatchObject([{
    message: { localId: 'racing', invokedAt: null, content: { meta: { forceSendRequestedAt: expect.any(Number) } } }
   }])
   store.messages.markMessagesInvoked(session.id, ['racing'], 12345)
   acknowledge(null, [{ results: [{ localId: 'racing', status: 'promoted' }] }])
   const response = await request
   expect(response.results).toEqual([{ localId: 'racing', status: 'invoked' }])
   expect(response.messages[0]?.invokedAt).toBe(12345)
   expect(publisher.events.filter(event => event.type === 'message-received').at(-1)).toMatchObject({
    message: { localId: 'racing', invokedAt: 12345 }
   })
  } finally { store.close() }
 })

 it('requires explicit scheduling opt-in and makes opted-in rows immediately replayable', async () => {
  const store = makeStore()
  try {
   const session = makeSession(store, 'force-scheduled')
   store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'later' } }, 'later', Date.now() + 60_000)
   const { io, updates } = forceIo()
   const service = new MessageService(store, io, makePublisher() as unknown as ConstructorParameters<typeof MessageService>[2])
   const excluded = await service.forceSendQueuedMessages(session.id, {}, false)
   expect(excluded.results[0]?.error).toBe('scheduled')
   expect(updates).toHaveLength(0)
   await service.forceSendQueuedMessages(session.id, { includeScheduled: true }, false)
   expect(store.messages.getImmediateQueuedLocalMessages(session.id)[0]?.localId).toBe('later')
   expect(store.messages.getAllMessages(session.id)[0]?.invokedAt).toBeNull()
  } finally { store.close() }
 })
})

describe('MessageService terminal native inputs', () => {
 it('preserves history/export/queued-state resolution without direct resend, replay or scheduled delivery', async () => {
  const store = makeStore()
  try {
   const session = makeSession(store, 'terminal-delivery')
   const emitted: unknown[] = []
   const io = { of: () => ({ to: () => ({ emit: (...args: unknown[]) => emitted.push(args) }) }) } as unknown as Server
   const publisher = makePublisher()
   const service = new MessageService(store, io, publisher as unknown as EventPublisher)
   await service.sendMessage(session.id, { text: '/local', localId: 'terminal' })
   store.messages.resolveMessages(session.id, [{ localId: 'terminal', outcome: 'handled' }], 123)
   emitted.length = 0
   await service.sendMessage(session.id, { text: '/local', localId: 'terminal' })
   expect(emitted).toEqual([])
   expect(service.replayImmediateQueuedMessages(session.id)).toBe(0)
   expect(service.releaseDeliverableQueuedMessages(session.id)).toBe(0)
   expect(service.getDeliverableMessagesAfter(session.id, { afterSeq: 0, now: Date.now(), limit: 200 })).toEqual([])
   expect(service.getQueuedState(session.id, ['terminal'])).toEqual({
    queuedLocalIds: [], invokedLocalMessages: [], resolvedLocalMessages: [{ localId: 'terminal', resolution: { outcome: 'handled', resolvedAt: 123 } }]
   })
   expect(service.getMessages(session.id)[0]).toMatchObject({ invokedAt: null, resolution: { outcome: 'handled', resolvedAt: 123 } })
   const exported = service.getSessionExport(session.id, toProtocolSession(session))
   if (exported.type !== 'success') throw new Error('Expected successful export')
   expect(exported.payload.messages[0]).toMatchObject({
    invokedAt: null, resolution: { outcome: 'handled', resolvedAt: 123 }
   })
   expect(await service.cancelQueuedMessage(session.id, 'terminal')).toMatchObject({ status: 'resolved', message: { invokedAt: null } })
  } finally { store.close() }
 })

 it.each(['timeout', 'not-found'] as const)('does not manufacture native invocation after %s cancellation acknowledgement', async (outcome) => {
  const store = makeStore()
  try {
   const session = store.sessions.getOrCreateSession(`terminal-unconfirmed-${outcome}`, { flavor: 'omp' }, null, 'default')
   const row = store.messages.addMessage(session.id, { role: 'user', content: 'keep work' }, 'pending')
   const publisher = makePublisher()
   const service = new MessageService(store, makeIo(ack => ack(outcome === 'timeout' ? new Error('timeout') : null, [])), publisher as unknown as EventPublisher)
   expect(await service.cancelQueuedMessage(session.id, row.id)).toMatchObject({ status: 'unconfirmed', message: { id: row.id, invokedAt: null } })
   expect(store.messages.getUninvokedLocalMessages(session.id).map(message => message.id)).toEqual([row.id])
   expect(publisher.events).toEqual([])
  } finally { store.close() }
 })

 it.each([true, false])('returns terminal evidence that wins during the cancel roundtrip (removed=%s)', async (removed) => {
  const store = makeStore()
  try {
   const session = store.sessions.getOrCreateSession('terminal-cancel-race', { flavor: 'omp' }, null, 'default')
   store.messages.addMessage(session.id, { role: 'user', content: '/cancelled' }, 'terminal')
   const publisher = makePublisher()
   const service = new MessageService(store, makeIo(ack => {
    store.messages.resolveMessages(session.id, [{ localId: 'terminal', outcome: 'cancelled' }], 456)
    ack(null, [{ removed }])
   }), publisher as unknown as EventPublisher)
   expect(await service.cancelQueuedMessage(session.id, 'terminal')).toMatchObject({
    status: 'resolved',
    message: { invokedAt: null, resolution: { outcome: 'cancelled', resolvedAt: 456 } }
   })
   expect(publisher.events).toEqual([])
   expect(store.messages.getAllMessages(session.id)).toHaveLength(1)
  } finally { store.close() }
 })
})

describe('native queued state positions', () => {
 it('returns persisted coordinates for invoked and resolved rows without waiting for transcript reload', () => {
  const store = makeStore()
  try {
   const session = makeSession(store, 'native-queued-state')
   const origin = { sessionId: 'native', entryId: 'assistant', entryOrder: 3, eventOrder: 0 }
   const assistant = store.messages.addMessage(session.id, { role: 'agent', content: 'answer' }, undefined, undefined, 1, origin)
   store.messages.addMessage(session.id, { role: 'user', content: 'prompt' }, 'input')
   const deliveredAt = '2024-03-10T00:00:00.000Z'
   store.messages.markMessagesInvoked(session.id, ['input'], Date.now(), {
    sessionId: 'native', entryId: 'user', entryOrder: 2, deliveredAt
   })
   store.messages.addMessage(session.id, { role: 'user', content: '/local' }, 'command')
   store.messages.resolveMessages(session.id, [{
    localId: 'command', outcome: 'handled',
    nativeOrder: { sessionId: 'native', entryId: 'resolution', entryOrder: 4, eventOrder: 0 }
   }], 1234)
   const service = new MessageService(store, makeIo(() => { }), makePublisher() as unknown as EventPublisher)
   expect(service.getQueuedState(session.id, ['input', 'command'])).toEqual({
    queuedLocalIds: [],
    invokedLocalMessages: [{
     localId: 'input', invokedAt: Date.parse(deliveredAt),
     position: { at: assistant.position!.at, order: 2, eventOrder: 0 }
    }],
    resolvedLocalMessages: [{
     localId: 'command', resolution: { outcome: 'handled', resolvedAt: 1234 },
     position: { at: assistant.position!.at, order: 4, eventOrder: 0 }
    }]
   })
  } finally {
   store.close()
  }
 })
})
