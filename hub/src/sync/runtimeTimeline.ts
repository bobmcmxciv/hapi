import { MAX_RUNTIME_PUBLICATION_BYTES, MAX_RUNTIME_RETAINED_BYTES, RuntimeTimelineProjection, runtimeSerializedBytes, type RuntimeItem, type RuntimePublication, type RuntimeSnapshot } from '@hapi/protocol/runtimeTimeline'

export type RuntimeSourceState = 'connected' | 'disconnected' | 'none'
export type RuntimeStatusFrame = { kind: 'runtime-source'; source: 'connected' | 'disconnected' }
export type RuntimeFrame = RuntimePublication | RuntimeStatusFrame
export type PublishOutcome = { result: 'ok' } | { result: 'resync' } | {
 result: 'error'; reason: 'retired-source' | 'namespace-mismatch' | 'overloaded' | 'too-large'
}
export type RuntimeSubscribeHandle = {
 initial: RuntimePublication | { kind: 'unavailable' }
 source: RuntimeSourceState
 pending: RuntimeFrame[]
 wait(): Promise<true | null>
 close(): void
}
type Subscriber = { pending: RuntimeFrame[]; closed: boolean; wake: (() => void) | null }
type Entry = {
 namespace: string
 projection: RuntimeTimelineProjection | null
 sizes: Map<string, number>
 bytes: number
 runBytes: number
 retiredEpochs: Set<string>
 sourceSocketId: string | null
 sourceGeneration: number
 sourceConnected: boolean
 subscribers: Set<Subscriber>
}
const MAX_TOTAL_BYTES = 64 * 1024 * 1024
// Byte contract with the CLI producer: publication wire payloads stay under
// MAX_RUNTIME_PUBLICATION_BYTES (4MiB) and projected retained state under
// MAX_RUNTIME_RETAINED_BYTES (3MiB) — the 1 MiB delta guarantees any
// materialized snapshot fits the wire cap, so resync can never loop on
// 'too-large'. Item bytes are bounded by projection eviction; run metadata is
// not evictable, so oversized runs are rejected before touching live state.
const MAX_SOURCES = 2048
const MAX_SUBSCRIBERS = 128
const MAX_QUEUED_BYTES = 8 * 1024 * 1024
const MAX_EPOCHS = 256

/** In-memory runtime only. Durable canonical history remains on the DB path.
 * Map-based projections mutate only named entities; snapshots materialize only
 * for HTTP/subscription reads. Idle entries are evicted before admitting new
 * state; subscribed entries are never silently evicted.
 */
export class RuntimeTimelineRegistry {
 readonly #entries = new Map<string, Entry>()
 readonly #sources = new Map<string, number>()
 readonly #frameSizes = new WeakMap<RuntimeFrame, number>()
 #nextGeneration = 0
 #totalBytes = 0
 #subscribers = 0

 constructor(private readonly options: { maxSessions?: number; maxPendingFrames?: number; maxPublicationBytes?: number } = {}) { }

 /** Capture socket connection ordering, not packet arrival ordering. */
 connectSource(socketId: string): boolean {
  if (this.#sources.has(socketId)) return true
  if (this.#sources.size >= MAX_SOURCES) return false
  this.#sources.set(socketId, ++this.#nextGeneration)
  return true
 }

 publish(sessionId: string, namespace: string, socketId: string, publication: RuntimePublication): PublishOutcome {
  const wireBytes = runtimeSerializedBytes(publication)
  if (wireBytes > (this.options.maxPublicationBytes ?? MAX_RUNTIME_PUBLICATION_BYTES)) return { result: 'error', reason: 'too-large' }
  if (!this.connectSource(socketId)) return { result: 'error', reason: 'overloaded' }
  const generation = this.#sources.get(socketId)!
  const entry = this.#getOrCreateEntry(sessionId, namespace)
  if (!entry) return { result: 'error', reason: 'overloaded' }
  if (entry.namespace !== namespace) return { result: 'error', reason: 'namespace-mismatch' }
  if (generation < entry.sourceGeneration) return { result: 'error', reason: 'retired-source' }

  if (publication.kind === 'patch') {
   const projection = entry.projection
   if (!projection || entry.sourceSocketId !== socketId) return { result: 'resync' }
   const patch = publication.patch
   if (projection.epoch !== patch.epoch) return { result: 'resync' }
   if (patch.seq <= projection.seq) return { result: 'ok' }
   if (patch.seq !== projection.seq + 1) return { result: 'resync' }

   // Preflight byte accounting only touches changed entities. Clearing
   // creates a new ledger; ordinary patches don't clone history.
   let bytes = entry.bytes
   let runBytes = entry.runBytes
   let run = projection.run
   let cleared = false
   const changedSizes = new Map<string, number>()
   const stagedItems = new Map<string, RuntimeItem | null>()
   const deletedIds = new Set<string>()
   for (const change of patch.changes) {
    if (change.type === 'clear') {
     cleared = true
     changedSizes.clear()
     stagedItems.clear()
     deletedIds.clear()
     bytes = 1024
     runBytes = 0
     run = null
    } else if (change.type === 'run') {
     const size = runtimeSerializedBytes(change.run)
     if (size + 1024 > MAX_RUNTIME_RETAINED_BYTES) return { result: 'error', reason: 'too-large' }
     if (run?.id === change.run.id && run.state !== 'running' && change.run.state === 'running') continue
     if (run && run.id !== change.run.id && change.run.startedAt < run.startedAt) continue
     bytes += size - runBytes
     runBytes = size
     run = change.run
    } else if (change.type === 'item') {
     const priorItem = stagedItems.has(change.item.id) ? stagedItems.get(change.item.id) : cleared ? undefined : projection.getItem(change.item.id)
     if (priorItem && (change.item.updatedAt < priorItem.updatedAt || (priorItem.state !== 'running' && change.item.state === 'running'))) continue
     const old = deletedIds.has(change.item.id) ? 0 : changedSizes.get(change.item.id) ?? (cleared ? 0 : entry.sizes.get(change.item.id) ?? 0)
     const size = runtimeSerializedBytes(change.item)
     deletedIds.delete(change.item.id)
     stagedItems.set(change.item.id, change.item)
     bytes += size - old
     changedSizes.set(change.item.id, size)
    } else {
     const old = deletedIds.has(change.id) ? 0 : changedSizes.get(change.id) ?? (cleared ? 0 : entry.sizes.get(change.id) ?? 0)
     bytes -= old
     changedSizes.delete(change.id)
     stagedItems.set(change.id, null)
     deletedIds.add(change.id)
    }
   }
   // Automatic whole-entity eviction bounds the actual committed projection.
   if (!this.#makeRoom(Math.min(bytes, MAX_RUNTIME_RETAINED_BYTES) - entry.bytes, sessionId)) {
    return { result: 'error', reason: 'overloaded' }
   }
   projection.apply(patch)
   entry.runBytes = runBytes
   if (cleared) entry.sizes.clear()
   for (const [id, size] of changedSizes) entry.sizes.set(id, size)
   for (const id of deletedIds) entry.sizes.delete(id)
   const evictedIds = projection.takeEvictedIds()
   for (const id of evictedIds) entry.sizes.delete(id)
   const retained = projection.retainedBytes
   this.#totalBytes += retained - entry.bytes
   entry.bytes = retained
   let accepted: RuntimePublication = evictedIds.length ? {
    kind: 'patch', patch: { ...patch, changes: [...patch.changes, ...evictedIds.map(id => ({ type: 'delete' as const, id }))] },
   } : publication
   let acceptedBytes = evictedIds.length ? runtimeSerializedBytes(accepted) : wireBytes
   if (acceptedBytes > MAX_RUNTIME_PUBLICATION_BYTES) {
    accepted = { kind: 'snapshot', snapshot: projection.snapshot() }
    acceptedBytes = runtimeSerializedBytes(accepted)
   }
   this.#fanout(entry, accepted, acceptedBytes)
   return { result: 'ok' }
  }

  const snapshot = publication.snapshot
  const prior = entry.projection
  if (entry.retiredEpochs.has(snapshot.epoch)) return { result: 'error', reason: 'retired-source' }
  if (prior?.epoch === snapshot.epoch && snapshot.seq < prior.seq) return { result: 'resync' }
  if (prior?.epoch === snapshot.epoch && snapshot.seq === prior.seq) {
   const reconnected = !entry.sourceConnected
   entry.sourceSocketId = socketId
   entry.sourceGeneration = generation
   entry.sourceConnected = true
   if (reconnected) this.#fanout(entry, { kind: 'runtime-source', source: 'connected' }, 64)
   return { result: 'ok' }
  }
  if (prior && prior.epoch !== snapshot.epoch && entry.retiredEpochs.size >= MAX_EPOCHS) {
   return { result: 'error', reason: 'overloaded' }
  }
  // Retained-state admission counts projected bytes, not the wire frame:
  // same ledger units as the patch path. Reject BEFORE mutating entry state —
  // a failed snapshot must not retire the prior epoch or swap the projection.
  const snapshotRunBytes = snapshot.run ? runtimeSerializedBytes(snapshot.run) : 0
  if (snapshotRunBytes + 1024 > MAX_RUNTIME_RETAINED_BYTES) return { result: 'error', reason: 'too-large' }
  const itemSizes = new Map(snapshot.items.map(item => [item.id, runtimeSerializedBytes(item)]))
  const projection = new RuntimeTimelineProjection(snapshot.epoch)
  projection.replace(snapshot)
  // The projection may already have evicted oldest items under the shared
  // byte cap; mirror those evictions in the per-id ledger so patch preflight
  // stays consistent, and admit the exact projected retained bytes.
  for (const evicted of projection.takeEvictedIds()) itemSizes.delete(evicted)
  const snapshotBytes = projection.retainedBytes
  if (snapshotBytes > MAX_RUNTIME_RETAINED_BYTES) return { result: 'error', reason: 'too-large' }
  if (!this.#makeRoom(snapshotBytes - entry.bytes, sessionId)) return { result: 'error', reason: 'overloaded' }
  if (prior && prior.epoch !== snapshot.epoch) entry.retiredEpochs.add(prior.epoch)
  entry.projection = projection
  entry.sizes = itemSizes
  entry.runBytes = snapshotRunBytes
  this.#totalBytes += snapshotBytes - entry.bytes
  entry.bytes = snapshotBytes
  const disconnected = entry.sourceSocketId !== null && !entry.sourceConnected
  entry.sourceSocketId = socketId
  entry.sourceGeneration = generation
  entry.sourceConnected = true
  const accepted: RuntimePublication = { kind: 'snapshot', snapshot: projection.snapshot() }
  this.#fanout(entry, accepted, runtimeSerializedBytes(accepted))
  if (disconnected) this.#fanout(entry, { kind: 'runtime-source', source: 'connected' }, 64)
  return { result: 'ok' }
 }

 disconnectSocket(socketId: string): void {
  this.#sources.delete(socketId)
  for (const entry of this.#entries.values()) {
   if (entry.sourceSocketId !== socketId || !entry.sourceConnected) continue
   entry.sourceConnected = false
   this.#fanout(entry, { kind: 'runtime-source', source: 'disconnected' }, 64)
  }
 }

 /** Retain final rows; session end is not an instruction to fabricate run state. */
 markSessionEnded(sessionId: string, socketId: string): void {
  const entry = this.#entries.get(sessionId)
  if (!entry || entry.sourceSocketId !== socketId) return
  if (entry.sourceConnected) this.#fanout(entry, { kind: 'runtime-source', source: 'disconnected' }, 64)
  entry.sourceConnected = false
 }

 /** Subscribe and capture initial projection without yielding — no delta window. */
 subscribe(sessionId: string, namespace: string): RuntimeSubscribeHandle | null {
  if (this.#subscribers >= MAX_SUBSCRIBERS) return null
  const entry = this.#getOrCreateEntry(sessionId, namespace)
  if (!entry || entry.namespace !== namespace) return null
  const subscriber: Subscriber = { pending: [], closed: false, wake: null }
  entry.subscribers.add(subscriber)
  this.#subscribers++
  return {
   initial: entry.projection ? { kind: 'snapshot', snapshot: entry.projection.snapshot() } : { kind: 'unavailable' },
   source: !entry.sourceSocketId ? 'none' : entry.sourceConnected ? 'connected' : 'disconnected',
   pending: subscriber.pending,
   wait: () => {
    if (subscriber.closed) return Promise.resolve(null)
    if (subscriber.pending.length) return Promise.resolve(true)
    const { promise, resolve } = Promise.withResolvers<true | null>()
    subscriber.wake = () => {
     subscriber.wake = null
     resolve(subscriber.closed ? null : true)
    }
    return promise
   },
   close: () => this.#closeSubscriber(entry, subscriber)
  }
 }

 snapshot(sessionId: string, namespace: string): { snapshot: RuntimeSnapshot | null; source: RuntimeSourceState } | null {
  const entry = this.#entries.get(sessionId)
  if (!entry || entry.namespace !== namespace) return null
  return {
   snapshot: entry.projection?.snapshot() ?? null,
   source: !entry.sourceSocketId ? 'none' : entry.sourceConnected ? 'connected' : 'disconnected'
  }
 }

 drop(sessionId: string): void {
  const entry = this.#entries.get(sessionId)
  if (!entry) return
  for (const subscriber of entry.subscribers) this.#closeSubscriber(entry, subscriber)
  this.#totalBytes -= entry.bytes
  this.#entries.delete(sessionId)
 }

 get size(): number { return this.#entries.size }

 #getOrCreateEntry(sessionId: string, namespace: string): Entry | null {
  const existing = this.#entries.get(sessionId)
  if (existing) {
   this.#entries.delete(sessionId)
   this.#entries.set(sessionId, existing)
   return existing
  }
  if (this.#entries.size >= (this.options.maxSessions ?? 128)) {
   const idle = [...this.#entries].find(([, entry]) => !entry.sourceConnected && entry.subscribers.size === 0)
   if (!idle) return null
   this.drop(idle[0])
  }
  const entry: Entry = {
   namespace, projection: null, sizes: new Map(), bytes: 0, runBytes: 0, retiredEpochs: new Set(),
   sourceSocketId: null, sourceGeneration: 0, sourceConnected: false, subscribers: new Set()
  }
  this.#entries.set(sessionId, entry)
  return entry
 }

 #makeRoom(extraBytes: number, protectedId: string): boolean {
  if (this.#totalBytes + extraBytes <= MAX_TOTAL_BYTES) return true
  for (const [id, entry] of this.#entries) {
   if (id === protectedId || entry.sourceConnected || entry.subscribers.size) continue
   this.drop(id)
   if (this.#totalBytes + extraBytes <= MAX_TOTAL_BYTES) return true
  }
  return false
 }

 #closeSubscriber(entry: Entry, subscriber: Subscriber): void {
  if (subscriber.closed) return
  subscriber.closed = true
  subscriber.pending.length = 0
  entry.subscribers.delete(subscriber)
  this.#subscribers--
  subscriber.wake?.()
 }

 #fanout(entry: Entry, frame: RuntimeFrame, wireBytes: number): void {
  this.#frameSizes.set(frame, wireBytes)
  for (const subscriber of entry.subscribers) {
   let queuedBytes = wireBytes
   for (const queued of subscriber.pending) queuedBytes += this.#frameSizes.get(queued) ?? 0
   if (subscriber.pending.length >= (this.options.maxPendingFrames ?? 256) || queuedBytes > MAX_QUEUED_BYTES) {
    this.#closeSubscriber(entry, subscriber)
    continue
   }
   subscriber.pending.push(frame)
   subscriber.wake?.()
  }
 }
}


export const runtimeTimelineRegistry = new RuntimeTimelineRegistry()
