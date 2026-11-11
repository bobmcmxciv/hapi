import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
 captureQueuedOutboxScope,
 clearQueuedOutboxForTests,
 getQueuedOutboxItem,
 getQueuedOutboxItems,
 markQueuedOutboxFailed,
 markQueuedOutboxPending,
 recordQueuedOutboxItem,
 removeQueuedOutboxItem,
 resetQueuedOutboxCacheForTests,
 setQueuedOutboxScope,
} from './queued-outbox'

function record(localId: string, sessionId = 'session-A', text = 'typed input') {
 recordQueuedOutboxItem({
  localId,
  sessionId,
  text,
  scheduledAt: null,
  deliveryMode: 'queue',
  createdAt: Date.now(),
 })
}

describe('queued-outbox', () => {
 beforeEach(() => {
  clearQueuedOutboxForTests()
 })
 afterEach(() => vi.restoreAllMocks())

 it('rehydrates pending and failed records after a simulated reload', () => {
  record('local-1')
  markQueuedOutboxFailed('local-1', 'HTTP 503')
  record('local-2')
  resetQueuedOutboxCacheForTests()

  const items = getQueuedOutboxItems('session-A')
  expect(items.map((item) => item.localId)).toEqual(['local-1', 'local-2'])
  expect(items[0]?.status).toBe('failed')
  expect(items[0]?.lastError).toBe('HTTP 503')
  expect(items[1]?.status).toBe('pending')
 })

 it('keeps attachment metadata and delivery intent for attachment-only input', () => {
  recordQueuedOutboxItem({
   localId: 'local-att',
   sessionId: 'session-A',
   text: '',
   attachments: [{ id: 'a1', filename: 'clip.png', mimeType: 'image/png', size: 4, path: '/tmp/clip.png' }],
   scheduledAt: null,
   deliveryMode: 'queue',
   createdAt: 10,
  })
  resetQueuedOutboxCacheForTests()
  const item = getQueuedOutboxItem('session-A', 'local-att')
  expect(item?.attachments?.[0]?.filename).toBe('clip.png')
  expect(item?.scheduledAt).toBeNull()
 })

 it('scopes records by account: another scope sees nothing', () => {
  record('local-1')
  setQueuedOutboxScope('["other-hub","9","other-user"]')
  expect(getQueuedOutboxItems('session-A')).toHaveLength(0)
  // Cross-scope writes cannot leak back either.
  record('local-other', 'session-A', 'other account input')
  setQueuedOutboxScope('default')
  expect(getQueuedOutboxItems('session-A').map((item) => item.localId)).toEqual(['local-1'])
 })

 it('drops the record only after the hub acknowledges it', () => {
  record('local-1')
  removeQueuedOutboxItem('local-1')
  expect(getQueuedOutboxItem('session-A', 'local-1')).toBeNull()
 })

 it('upserts on retry: same localId keeps one row and clears the stale error', () => {
  record('local-1')
  markQueuedOutboxFailed('local-1', 'offline')
  markQueuedOutboxPending('local-1')
  record('local-1')
  const items = getQueuedOutboxItems('session-A')
  expect(items).toHaveLength(1)
  expect(items[0]?.status).toBe('pending')
  expect(items[0]?.lastError).toBeUndefined()
 })

 it('returns a stable snapshot reference between mutations', () => {
  record('local-1')
  const first = getQueuedOutboxItems('session-A')
  const second = getQueuedOutboxItems('session-A')
  expect(first).toBe(second)
  markQueuedOutboxFailed('local-1', 'x')
  const third = getQueuedOutboxItems('session-A')
  expect(third).not.toBe(first)
 })

 it('cannot lose unrelated tab entries during an interleaved insert or removal', () => {
  const key = (id: string) => `hapi:queued-outbox:v1:default:item:${encodeURIComponent(id)}`
  const payload = (id: string) => JSON.stringify({ localId: id, sessionId: 'session-A', text: id, createdAt: 1, scheduledAt: null, deliveryMode: 'queue', status: 'pending' })
  const nativeSet = Storage.prototype.setItem
  const nativeRemove = Storage.prototype.removeItem
  let injected = false
  const insert = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function(this: Storage, name, value) {
   if (!injected && name === key('tab-A')) {
    injected = true
    nativeSet.call(this, key('tab-B'), payload('tab-B'))
   }
   nativeSet.call(this, name, value)
  })
  record('tab-A')
  insert.mockRestore()
  resetQueuedOutboxCacheForTests()
  expect(getQueuedOutboxItems('session-A').map(item => item.localId).sort()).toEqual(['tab-A', 'tab-B'])
  vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(function(this: Storage, name) {
   if (name === key('tab-A')) nativeSet.call(this, key('tab-C'), payload('tab-C'))
   nativeRemove.call(this, name)
  })
  removeQueuedOutboxItem('tab-A')
  resetQueuedOutboxCacheForTests()
  expect(getQueuedOutboxItems('session-A').map(item => item.localId).sort()).toEqual(['tab-B', 'tab-C'])
 })

 it('invalidates delayed account callbacks and cached snapshots on storage events', () => {
  record('tab-A')
  expect(getQueuedOutboxItems('session-A')).toHaveLength(1)
  const key = 'hapi:queued-outbox:v1:default:item:tab-B'
  localStorage.setItem(key, JSON.stringify({ localId: 'tab-B', sessionId: 'session-A', text: 'B', createdAt: 1, scheduledAt: null, deliveryMode: 'queue', status: 'pending' }))
  window.dispatchEvent(new StorageEvent('storage', { key }))
  expect(getQueuedOutboxItems('session-A')).toHaveLength(2)
  const isCurrent = captureQueuedOutboxScope()
  setQueuedOutboxScope('another-account')
  expect(isCurrent()).toBe(false)
  expect(getQueuedOutboxItems('session-A')).toHaveLength(0)
 })
})
