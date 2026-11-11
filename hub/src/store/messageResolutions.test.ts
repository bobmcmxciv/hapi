import { describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from './index'

const content = { role: 'user', content: { type: 'text', text: '/local', attachments: [{ name: 'audit.txt', path: '/audit' }] } }
const createSession = (store: Store, tag: string) => store.sessions.getOrCreateSession(tag, { flavor: 'omp' }, null, 'default')

describe('durable native input resolution', () => {
 it('is first-write-wins against duplicate outcomes and invocation in both orders', () => {
  const store = new Store(':memory:')
  try {
   const session = createSession(store, 'race')
   store.messages.addMessage(session.id, content, 'resolved')
   store.messages.addMessage(session.id, content, 'invoked')
   expect(store.messages.resolveMessages(session.id, [{ localId: 'resolved', outcome: 'handled' }], 100)).toEqual([
    { localId: 'resolved', resolution: { outcome: 'handled', resolvedAt: 100 } }
   ])
   const epoch = store.messages.getMessageEpoch(session.id)
   expect(store.messages.resolveMessages(session.id, [{ localId: 'resolved', outcome: 'cancelled' }], 200)[0].resolution).toEqual({ outcome: 'handled', resolvedAt: 100 })
   expect(store.messages.getMessageEpoch(session.id)).toBe(epoch)
   expect(store.messages.markMessagesInvoked(session.id, ['resolved'], 300)).toBe(0)
   expect(store.messages.markMessagesInvoked(session.id, ['invoked'], 400)).toBe(1)
   expect(store.messages.resolveMessages(session.id, [{ localId: 'invoked', outcome: 'cancelled' }, { localId: 'unknown', outcome: 'handled' }], 500)).toEqual([])
   expect(store.messages.getAllMessages(session.id)).toEqual([
    expect.objectContaining({ localId: 'resolved', content, invokedAt: null, resolution: { outcome: 'handled', resolvedAt: 100 } }),
    expect.objectContaining({ localId: 'invoked', invokedAt: 400 })
   ])
   expect(store.messages.cancelQueuedMessage(session.id, 'resolved').status).toBe('resolved')
   expect(store.messages.deleteQueuedMessageById(session.id, 'resolved')).toBe(false)
  } finally { store.close() }
 })

 it('survives reopen without changing version20, original bytes or timestamps and cannot be replayed or scheduled', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hapi-terminal-'))
  const path = join(directory, 'store.db')
  let store = new Store(path)
  try {
   const session = createSession(store, 'restart')
   const at = Date.now() + 60_000
   const immediate = store.messages.addMessage(session.id, content, 'immediate')
   store.messages.addMessage(session.id, content, 'scheduled', at)
   const db = new Database(path)
   const original = db.prepare('SELECT * FROM messages WHERE id = ?').get(immediate.id)
   store.messages.resolveMessages(session.id, [{ localId: 'immediate', outcome: 'handled' }, { localId: 'scheduled', outcome: 'cancelled' }], 123)
   expect(db.prepare('SELECT * FROM messages WHERE id = ?').get(immediate.id)).toEqual(original)
   expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 20 })
   db.close()
   store.close()
   store = new Store(path)
   expect(store.messages.getAllMessages(session.id).map(row => row.resolution)).toEqual([
    { outcome: 'handled', resolvedAt: 123 }, { outcome: 'cancelled', resolvedAt: 123 }
   ])
   expect(store.messages.getDeliverableMessagesAfter(session.id, 0, at + 1)).toEqual([])
   expect(store.messages.getUninvokedLocalMessages(session.id)).toEqual([])
   expect(store.messages.getImmediateQueuedLocalMessages(session.id)).toEqual([])
   expect(store.messages.getMatureScheduledMessages(at + 1)).toEqual([])
   expect(store.messages.countFutureScheduledLocalMessages(session.id, at - 1)).toBe(0)
   expect(store.messages.countFutureScheduledBySessionIds([session.id], at - 1).size).toBe(0)
   expect(store.messages.minFutureScheduledAtBySessionIds([session.id], at - 1).size).toBe(0)
   expect(store.messages.markUninvokedImmediateMessages(session.id, 999)).toEqual([])
   store.sessions.deleteSession(session.id, 'default')
   const reopened = new Database(path)
   try { expect(reopened.prepare('SELECT COUNT(*) AS count FROM message_input_resolutions').get()).toEqual({ count: 0 }) }
   finally { reopened.close() }
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }) }
 })

 it('batch-hydrates large copies, preserves evidence across merge, excludes terminal rows from handoff, and cascades rewind/delete', () => {
  const store = new Store(':memory:')
  try {
   const source = createSession(store, 'source')
   const target = createSession(store, 'target')
   for (let i = 0; i < 410; i++) store.messages.addMessage(source.id, content, `local-${i}`, undefined, 1000 + i)
   store.messages.resolveMessages(source.id, Array.from({ length: 410 }, (_, i) => ({ localId: `local-${i}`, outcome: 'handled' as const })), 1500)
   const rows = store.messages.getAllMessages(source.id)
   expect(rows.every(row => row.resolution?.resolvedAt === 1500)).toBe(true)
   expect(store.messages.copyMessagesToSession(target.id, rows)).toBe(410)
   expect(store.messages.getAllMessages(target.id).every(row => row.invokedAt === null && row.resolution?.resolvedAt === 1500)).toBe(true)
   const single = store.messages.copyMessageToSession(target.id, rows[0])
   expect(single.resolution).toEqual(rows[0].resolution)
   expect(store.messages.moveUninvokedMessages(source.id, target.id)).toBe(0)
   store.messages.mergeSessionMessages(source.id, target.id)
   expect(store.messages.getAllMessages(target.id).filter(row => row.resolution)).toHaveLength(821)
   const earliest = store.messages.getAllMessages(target.id).find(row => row.seq === 1)!
   store.messages.truncateMessagesFromLocalId(target.id, earliest.localId!)
   expect(store.messages.getAllMessages(target.id)).toEqual([])
   expect(store.messages.resolveMessages(target.id, [{ localId: 'local-0', outcome: 'cancelled' }], 2000)).toEqual([])
   store.messages.copyMessagesToSession(source.id, rows.slice(0, 2))
   store.sessions.deleteSession(source.id, 'default')
   expect(store.messages.getAllMessages(source.id)).toEqual([])
  } finally { store.close() }
 })
})
