import { randomUUID } from 'node:crypto';
import {
 RuntimeTimelineProjection,
 MAX_RUNTIME_PUBLICATION_BYTES,
 MAX_RUNTIME_RETAINED_BYTES,
 runtimeSerializedBytes,
 type RuntimeItem,
 type RuntimeChange,
 type RuntimePatch,
 type RuntimePublication,
 type RuntimeSnapshot
} from '@hapi/protocol/runtimeTimeline';
import { logger } from '@/ui/logger';

const DEFAULT_COALESCE_MS = 50;
const MAX_TERMINAL_RUNS = 256;

function isImmediateChange(change: RuntimeChange): boolean {
 if (change.type === 'clear' || change.type === 'delete') return true;
 if (change.type === 'item') return change.item.state !== 'running';
 return change.run.state !== 'running';
}

/**
 * Turns the adapter's semantic runtime changes into the wire contract:
 * an epoch-scoped, strictly-sequenced stream of `RuntimePatch` publications.
 *
 * - Live `running` item updates coalesce over `coalesceMs` (deduped by item id /
 *   run slot); terminal changes (item not `running`, run not `running`,
 *   `clear`, errors, aborts) flush immediately.
 * - Local truth lives in a {@link RuntimeTimelineProjection}: it is updated
 *   once per emitted patch and materializes a snapshot only on demand
 *   (`snapshot()`, e.g. socket reconnect / hub resync).
 * - A run that reached a terminal state is recorded in `terminalRuns`; late
 *   callbacks touching that run can never resurrect it.
 */
export class OmpRuntimeProducer {
 readonly #projection: RuntimeTimelineProjection;
 readonly #pendingItems = new Map<string, RuntimeChange>();
 readonly #pendingRuns = new Map<string, Extract<RuntimeChange, { type: 'run' }>>();
 #pendingClear = false;
 #flushTimer: NodeJS.Timeout | undefined;
 #disposed = false;
 readonly #terminalRuns = new Set<string>();
 readonly #coalesceMs: number;

 constructor(
  private readonly publish: (publication: RuntimePublication) => void,
  options?: { epoch?: string; coalesceMs?: number }
 ) {
  this.#projection = new RuntimeTimelineProjection(options?.epoch ?? randomUUID());
  this.#coalesceMs = options?.coalesceMs ?? DEFAULT_COALESCE_MS;
  this.#emit({ kind: 'snapshot', snapshot: this.#projection.snapshot() });
 }

 get epoch(): string { return this.#projection.epoch; }
 snapshot(): RuntimeSnapshot { return this.#projection.snapshot(); }

 push(changes: RuntimeChange[]): void {
  if (this.#disposed) return;
  let immediate = false;
  const terminalInBatch: string[] = [];
  for (const original of changes) {
   if (original.type === 'run' && this.#terminalRuns.has(original.run.id)) continue;
   if (original.type === 'item' && this.#terminalRuns.has(original.item.runId)) continue;
   let change = original;
   if (change.type === 'clear') {
    this.#pendingItems.clear();
    this.#pendingRuns.clear();
    this.#pendingClear = true;
   } else if (change.type === 'run') {
    if (runtimeSerializedBytes(change.run) > 32 * 1024) {
     change = { type: 'run', run: { ...change.run, errorMessage: 'Error details exceed the live preview limit; see the complete history.' } };
    }
    this.#pendingRuns.set(change.run.id, change);
    if (change.run.state !== 'running') terminalInBatch.push(change.run.id);
   } else if (change.type === 'item') {
    this.#pendingItems.set(change.item.id, { type: 'item', item: this.#boundedPreview(change.item) });
   } else {
    this.#pendingItems.set(change.id, change);
   }
   immediate ||= isImmediateChange(change);
  }
  // All changes in one atomic input batch are admitted before its run closes.
  for (const id of terminalInBatch) {
   this.#terminalRuns.add(id);
   if (this.#terminalRuns.size > MAX_TERMINAL_RUNS) {
    const oldest = this.#terminalRuns.values().next().value;
    if (oldest !== undefined) this.#terminalRuns.delete(oldest);
   }
  }
  if (immediate) this.#flush();
  else if (!this.#flushTimer) {
   this.#flushTimer = setTimeout(() => { this.#flushTimer = undefined; this.#flush(); }, this.#coalesceMs);
   this.#flushTimer.unref?.();
  }
 }

 #boundedPreview(item: RuntimeItem): RuntimeItem {
  if (runtimeSerializedBytes(item) <= MAX_RUNTIME_RETAINED_BYTES - 64 * 1024) return item;
  // Only the live preview is deferred. The adapter still commits the entire
  // canonical native message/result; never slice bytes and call them complete.
  const preview: RuntimeItem = {
   id: item.id, kind: item.kind, runId: item.runId, createdAt: item.createdAt,
   updatedAt: item.updatedAt, state: item.state, canonicalId: item.canonicalId,
   stopReason: item.stopReason, parentToolCallId: item.parentToolCallId,
   agentId: item.agentId, model: item.model, provider: item.provider,
   previewOmitted: true,
  };
  if (item.errorMessage && runtimeSerializedBytes(item.errorMessage) < 32 * 1024) preview.errorMessage = item.errorMessage;
  if (item.tool) {
   preview.tool = {
    id: item.tool.id, name: item.tool.name,
    input: runtimeSerializedBytes(item.tool.input) < 64 * 1024 ? item.tool.input : null,
    isError: item.tool.isError,
   };
  }
  return preview;
 }

 dispose(): void {
  if (this.#disposed) return;
  this.#flush();
  this.#disposed = true;
 }

 #flush(): void {
  clearTimeout(this.#flushTimer);
  this.#flushTimer = undefined;
  const changes: RuntimeChange[] = [];
  if (this.#pendingClear) changes.push({ type: 'clear' });
  changes.push(...this.#pendingItems.values());
  // Run completion is deliberately last, including runs shorter than the
  // coalescing interval; final text/tool state always reaches clients first.
  changes.push(...this.#pendingRuns.values());
  this.#pendingClear = false;
  this.#pendingItems.clear();
  this.#pendingRuns.clear();
  let batch: RuntimeChange[] = [];
  let bytes = 1024;
  for (const change of changes) {
   const size = runtimeSerializedBytes(change) + 1;
   if (batch.length && bytes + size > MAX_RUNTIME_PUBLICATION_BYTES - 16 * 1024) {
    this.#commit(batch);
    batch = [];
    bytes = 1024;
   }
   batch.push(change);
   bytes += size;
  }
  if (batch.length) this.#commit(batch);
 }

 #commit(changes: RuntimeChange[]): void {
  const patch: RuntimePatch = {
   version: 1, epoch: this.#projection.epoch, seq: this.#projection.seq + 1,
   changes, updatedAt: Date.now(),
  };
  this.#projection.apply(patch);
  for (const id of this.#projection.takeEvictedIds()) patch.changes.push({ type: 'delete', id });
  const publication: RuntimePublication = { kind: 'patch', patch };
  // Eviction metadata itself can make a patch larger than the bounded state.
  // An authoritative snapshot carries the same revision and always fits.
  this.#emit(runtimeSerializedBytes(publication) > MAX_RUNTIME_PUBLICATION_BYTES
   ? { kind: 'snapshot', snapshot: this.#projection.snapshot() }
   : publication);
 }

 #emit(publication: RuntimePublication): void {
  try { this.publish(publication); }
  catch (error) { logger.warn('[omp-runtime] publication callback failed; runtime state retained for snapshot recovery', error); }
 }
}
