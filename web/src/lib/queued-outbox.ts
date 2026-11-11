import { z } from 'zod'
import { AttachmentMetadataSchema } from '@hapi/protocol/schemas'

const STORAGE_KEY_PREFIX = 'hapi:queued-outbox:v1:'
const DEFAULT_SCOPE = 'default'
const ItemSchema = z.object({
 localId: z.string().min(1), sessionId: z.string().min(1), text: z.string(),
 attachments: z.array(AttachmentMetadataSchema).optional(),
 scheduledAt: z.number().finite().nullable(), deliveryMode: z.enum(['queue', 'steer']),
 createdAt: z.number().finite(), status: z.enum(['pending', 'failed']),
 lastError: z.string().optional(),
})
export type QueuedOutboxItem = z.infer<typeof ItemSchema>
export type QueuedOutboxStatus = QueuedOutboxItem['status']
let scope = DEFAULT_SCOPE
let generation = 0
let version = 0
let cache: Map<string, QueuedOutboxItem> | null = null
const listeners = new Set<() => void>()
const snapshots = new Map<string, readonly QueuedOutboxItem[]>()
function storagePrefix() { return `${STORAGE_KEY_PREFIX}${encodeURIComponent(scope)}:item:` }
function storageKey(localId: string) { return `${storagePrefix()}${encodeURIComponent(localId)}` }
function hydrate() {
 if (cache) return cache
 const items = new Map<string, QueuedOutboxItem>()
 const prefix = storagePrefix()
 for (let index = 0; index < localStorage.length; index += 1) {
  const key = localStorage.key(index)
  if (!key?.startsWith(prefix)) continue
  const raw = localStorage.getItem(key)
  if (!raw) continue
  const item = ItemSchema.parse(JSON.parse(raw))
  if (storageKey(item.localId) === key) items.set(item.localId, item)
 }
 cache = items
 return items
}
function notify() {
 version += 1
 snapshots.clear()
 for (const listener of listeners) listener()
}
function persistItem(item: QueuedOutboxItem) {
 // One atomic storage write per input: another tab can never overwrite or
 // remove unrelated accepted input through a stale scope-wide map snapshot.
 localStorage.setItem(storageKey(item.localId), JSON.stringify(item))
 cache = null
 notify()
}
function readItem(localId: string): QueuedOutboxItem | null {
 const raw = localStorage.getItem(storageKey(localId))
 return raw ? ItemSchema.parse(JSON.parse(raw)) : null
}
if (typeof window !== 'undefined') {
 window.addEventListener('storage', event => {
  if (event.key !== null && !event.key.startsWith(storagePrefix())) return
  cache = null
  notify()
 })
}
export function setQueuedOutboxScope(nextScope: string) {
 const normalized = nextScope || DEFAULT_SCOPE
 if (normalized === scope) return
 scope = normalized
 generation += 1
 cache = null
 notify()
}
/** Prevent delayed transport callbacks from touching a newly signed-in account. */
export function captureQueuedOutboxScope() {
 const captured = generation
 return () => captured === generation
}
export function getQueuedOutboxScope() { return scope }
export function subscribeQueuedOutbox(listener: () => void) {
 listeners.add(listener)
 return () => { listeners.delete(listener) }
}
export function getQueuedOutboxItems(sessionId: string): readonly QueuedOutboxItem[] {
 const existing = snapshots.get(sessionId)
 if (existing) return existing
 let items: QueuedOutboxItem[] = []
 try {
  items = [...hydrate().values()].filter(item => item.sessionId === sessionId)
 } catch {
  // Reads remain render-safe; a send still surfaces storage failures before
  // acceptance and leaves the composer untouched.
 }
 items.sort((a, b) => a.createdAt - b.createdAt)
 snapshots.set(sessionId, items)
 return items
}
export function getQueuedOutboxItem(sessionId: string, localId: string) {
 return getQueuedOutboxItems(sessionId).find(item => item.localId === localId) ?? null
}
export function getQueuedOutboxCount(sessionId: string) { return getQueuedOutboxItems(sessionId).length }
export function getQueuedOutboxVersion() { return version }
export function getQueuedOutboxSnapshot(sessionId: string) { return getQueuedOutboxItems(sessionId) }
export function recordQueuedOutboxItem(item: Omit<QueuedOutboxItem, 'status' | 'lastError'>) {
 const validated = ItemSchema.parse({ ...item, status: 'pending' })
 persistItem(validated)
}
/** Cleanup may fail under quota/private mode; retain the previous durable
 * receipt rather than turn an acknowledged POST into a transport failure. */
export function removeQueuedOutboxItem(localId: string) {
 try {
  localStorage.removeItem(storageKey(localId))
  cache = null
  notify()
 } catch { /* Idempotent retry remains available. */ }
}
export function markQueuedOutboxFailed(localId: string, error: string) {
 try {
  const item = readItem(localId)
  if (item) persistItem({ ...item, status: 'failed', lastError: error })
 } catch { /* Original durable pending payload remains recoverable. */ }
}
export function markQueuedOutboxPending(localId: string) {
 const item = readItem(localId)
 if (item && item.status !== 'pending') persistItem({ ...item, status: 'pending', lastError: undefined })
}
export function clearQueuedOutboxForTests() {
 scope = DEFAULT_SCOPE
 generation += 1
 cache = new Map()
 for (let index = localStorage.length - 1; index >= 0; index -= 1) {
  const key = localStorage.key(index)
  if (key?.startsWith(STORAGE_KEY_PREFIX)) localStorage.removeItem(key)
 }
 notify()
}
export function resetQueuedOutboxCacheForTests() {
 cache = null
 notify()
}
