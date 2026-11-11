import { MAX_RUNTIME_ITEMS, type RuntimeItem, type RuntimePatch, type RuntimePublication, type RuntimeRun, type RuntimeSnapshot } from '@hapi/protocol/runtimeTimeline'
import type { ToolCallBlock } from '@/chat/types'
import type { ToolGroupBlock, VisibleChatBlock } from '@/chat/toolGroups'

export type BetaRowRef = Readonly<{ id: string; kind: 'history' | 'runtime' }>
export type BetaRow =
 | Readonly<{ id: string; kind: 'history'; block: VisibleChatBlock }>
 | Readonly<{ id: string; kind: 'runtime'; item: RuntimeItem }>
export type BetaTimelineStatus = Readonly<{
 connection: 'connecting' | 'live' | 'reconnecting' | 'legacy' | 'error'
 run: RuntimeRun | null
 error: string | null
}>

export class RuntimeTimelineResyncError extends Error {
 constructor(message: string) {
  super(message)
  this.name = 'RuntimeTimelineResyncError'
 }
}

type Listener = () => void
/** `after` pins the row that preceded this one when it first became visible. */
type RuntimeEntry = { row: Extract<BetaRow, { kind: 'runtime' }>; ref: BetaRowRef; covered: boolean; after?: string }
type ToolOwner = { rowId: string; path: number[]; source: Extract<VisibleChatBlock, { kind: 'tool-call' }> }

function indexTools(block: VisibleChatBlock, rowId: string, owners: Map<string, ToolOwner>, path: number[] = []): void {
 if (block.kind === 'tool-call') {
  owners.set(block.tool.id, { rowId, path, source: block })
  block.children.forEach((child, index) => indexTools(child, rowId, owners, [...path, index]))
 } else if (block.kind === 'tool-group') {
  block.tools.forEach((child, index) => indexTools(child, rowId, owners, [...path, index]))
 }
}

function recomputedGroupSummaryCounts(tools: ToolCallBlock[], summary: ToolGroupBlock['summary']): ToolGroupBlock['summary'] {
 let errorCount = 0
 let runningCount = 0
 let pendingCount = 0
 for (const tool of tools) {
  if (tool.tool.state === 'error') errorCount += 1
  else if (tool.tool.state === 'running') runningCount += 1
  else if (tool.tool.state === 'pending') pendingCount += 1
 }
 if (errorCount === summary.errorCount && runningCount === summary.runningCount && pendingCount === summary.pendingCount) {
  return summary
 }
 return { ...summary, errorCount, runningCount, pendingCount }
}

/** Copy only this tool's ancestry; durable permission data stays authoritative. */
function overlayTool(block: VisibleChatBlock, path: readonly number[], item: RuntimeItem, depth = 0): VisibleChatBlock {
 if (depth < path.length) {
  const index = path[depth]
  if (block.kind === 'tool-call') {
   const child = overlayTool(block.children[index], path, item, depth + 1)
   if (child === block.children[index] || child.kind === 'tool-group') return block
   const children = [...block.children]
   children[index] = child
   return { ...block, children }
  }
  if (block.kind === 'tool-group') {
   const tool = overlayTool(block.tools[index], path, item, depth + 1)
   if (tool === block.tools[index] || tool.kind !== 'tool-call') return block
   const tools = [...block.tools]
   tools[index] = tool
   const summary = recomputedGroupSummaryCounts(tools, block.summary)
   return { ...block, tools, summary }
  }
  return block
 }
 if (block.kind !== 'tool-call' || !item.tool) return block
 const state = item.state === 'completed' ? 'completed'
  : item.state === 'error' || item.state === 'aborted' ? 'error'
   : block.tool.permission?.status === 'pending' ? 'pending' : 'running'
 return {
  ...block,
  tool: {
   ...block.tool,
   // A result-only runtime item may carry no input; keep durable args.
   input: item.tool.input ?? block.tool.input,
   state,
   ...(item.tool.output !== undefined ? { result: item.tool.output } : {}),
   ...(item.state !== 'running' ? { completedAt: item.updatedAt } : {})
  }
 }
}

/**
 * Canonical keys a runtime item may bind to for coverage. For tool blocks the
 * native tool_use id is the primary identity; the assistant message uuid is
 * secondary (an assistant item also reports it, and row reuse must not steal
 * its live key — the canonical coverage pass suppresses it instead).
 */
function coverageIdentities(block: VisibleChatBlock): string[] {
 const keys: string[] = []
 if (block.kind === 'tool-call') keys.push(block.tool.id)
 if ('meta' in block && block.meta && typeof block.meta === 'object' && 'runtimeCanonicalId' in block.meta && typeof block.meta.runtimeCanonicalId === 'string') {
  keys.push(block.meta.runtimeCanonicalId)
 }
 if (block.kind === 'tool-call') {
  for (const child of block.children) keys.push(...coverageIdentities(child))
 } else if (block.kind === 'tool-group') {
  for (const tool of block.tools) keys.push(...coverageIdentities(tool))
 }
 return keys
}

/** Keys eligible for adopting a still-mounted runtime row id, tool id first. */
function reuseKeys(block: VisibleChatBlock): string[] {
 return block.kind === 'tool-call' ? [block.tool.id] : coverageIdentities(block)
}


function coverageKeys(item: RuntimeItem): string[] {
 // Tool canonicalId may name its assistant message, whereas the actual
 // tool card binds to tool_use_id. Never hide an unfinished tool merely
 // because its assistant message has committed.
 return item.kind === 'tool'
  ? item.tool ? [item.tool.id] : []
  : item.canonicalId ? [item.canonicalId] : []
}

function historyAliases(block: VisibleChatBlock): string[] {
 const keys = [`${block.kind}:${block.id}`]
 if (block.kind !== 'tool-group' && block.kind !== 'agent-event' && block.localId) {
  // Keep the content index: several text blocks can share one localId.
  const index = /:\d+$/.exec(block.id)?.[0] ?? ''
  keys.push(`${block.kind}:local:${block.localId}${index}`)
 }
 return keys
}

/** Assistant text/terminal transitions can move a row out of collapsed details. */
function runtimePresentationChanged(before: RuntimeItem, after: RuntimeItem): boolean {
 return before.kind !== after.kind || (after.kind === 'assistant' && (
  /\S/.test(before.text ?? '') !== /\S/.test(after.text ?? '')
  || (before.state === 'running') !== (after.state === 'running')
 ))
}

/** Per-mounted-session store. Only durable updates/snapshots scan the window. */
export class BetaTimelineStore {
 #disposed = false
 #historyInput: readonly VisibleChatBlock[] | null = null
 #historyRows: readonly Extract<BetaRow, { kind: 'history' }>[] = []
 #historyAliases = new Map<string, string>()
 #historyKeys = new Set<string>()
 #historyIds = new Set<string>()
 #runtime = new Map<string, RuntimeEntry>()
 #epoch: string | null = null
 #seq = 0
 #retiredEpochs = new Set<string>()
 #toolOwners = new Map<string, ToolOwner>()
 /** Retain only eviction identity/version, never the evicted preview payload. */
 #tombstones = new Map<string, Pick<RuntimeItem, 'runId' | 'state' | 'updatedAt'>>()
 #overlayCache = new Map<string, { source: VisibleChatBlock; item: RuntimeItem; row: Extract<BetaRow, { kind: 'history' }> }>()
 #rowsById = new Map<string, BetaRow>()
 #refs: readonly BetaRowRef[] = []
 #status: BetaTimelineStatus = { connection: 'connecting', run: null, error: null }
 #structureListeners = new Set<Listener>()
 #rowListeners = new Map<string, Set<Listener>>()
 #statusListeners = new Set<Listener>()

 getRows = (): readonly BetaRowRef[] => this.#refs
 getRow = (id: string): BetaRow | undefined => this.#rowsById.get(id)
 getAllRows = (): readonly BetaRow[] => this.#refs.map(ref => this.#rowsById.get(ref.id)!)
 getStatus = (): BetaTimelineStatus => this.#status
 subscribeRows = (listener: Listener): (() => void) => this.#subscribe(this.#structureListeners, listener)
 subscribeStatus = (listener: Listener): (() => void) => this.#subscribe(this.#statusListeners, listener)
 subscribeRow = (id: string, listener: Listener): (() => void) => {
  if (this.#disposed) return () => { }
  let listeners = this.#rowListeners.get(id)
  if (!listeners) this.#rowListeners.set(id, listeners = new Set())
  listeners.add(listener)
  return () => {
   listeners.delete(listener)
   if (!listeners.size) this.#rowListeners.delete(id)
  }
 }
 #subscribe(listeners: Set<Listener>, listener: Listener): () => void {
  if (this.#disposed) return () => { }
  listeners.add(listener)
  return () => { listeners.delete(listener) }
 }
 #emit(listeners: Set<Listener> | undefined): void {
  if (listeners) for (const listener of listeners) listener()
 }
 #emitRows(ids: Set<string>): void {
  for (const id of ids) this.#emit(this.#rowListeners.get(id))
 }
 #setStatus(partial: Partial<BetaTimelineStatus>): void {
  const next = { ...this.#status, ...partial }
  if (next.connection === this.#status.connection && next.error === this.#status.error && next.run === this.#status.run) return
  this.#status = next
  this.#emit(this.#statusListeners)
 }
 setConnection = (connection: BetaTimelineStatus['connection'], error: string | null = null): void => {
  if (!this.#disposed) this.#setStatus({ connection, error })
 }
 #covered(item: RuntimeItem): boolean {
  return coverageKeys(item).some(key => this.#historyKeys.has(key))
 }
 /**
  * Install a live tool overlay on its durable row. Returns nothing; callers
  * pass `firstTouched` to snapshot each affected row's pre-mutation value so
  * they can emit only when the final object actually differs — cached
  * overlays (same raw block + same item) reinstall the identical row and
  * never churn row listeners on unrelated updates.
  */
 #overlay(item: RuntimeItem, firstTouched?: Map<string, BetaRow | undefined>): void {
  if (item.kind !== 'tool' || !item.tool) return
  const owner = this.#toolOwners.get(item.tool.id)
  if (!owner) return
  // A durable terminal tool is authoritative; never resurrect progress.
  if (owner.source.tool.state === 'completed' || owner.source.tool.state === 'error') return
  const row = this.#rowsById.get(owner.rowId)
  if (row?.kind !== 'history') return
  const cached = this.#overlayCache.get(owner.rowId)
  let next: Extract<BetaRow, { kind: 'history' }>
  if (cached && cached.source === owner.source && cached.item === item) {
   next = cached.row
  } else {
   const block = overlayTool(row.block, owner.path, item)
   if (block === row.block) {
    this.#overlayCache.delete(owner.rowId)
    return
   }
   next = { ...row, block }
   this.#overlayCache.set(owner.rowId, { source: owner.source, item, row: next })
  }
  if (next === row) return
  if (firstTouched && !firstTouched.has(owner.rowId)) firstTouched.set(owner.rowId, row)
  this.#rowsById.set(owner.rowId, next)
 }
 /** Revert the deleted overlay while retaining other tools in the same row. */
 #removeOverlay(owner: ToolOwner, firstTouched: Map<string, BetaRow | undefined>): void {
  const current = this.#rowsById.get(owner.rowId)
  const raw = this.#historyRows.find(row => row.id === owner.rowId)
  this.#overlayCache.delete(owner.rowId)
  if (!raw || !current || current === raw) return
  if (!firstTouched.has(owner.rowId)) firstTouched.set(owner.rowId, current)
  this.#rowsById.set(owner.rowId, raw)
  for (const entry of this.#runtime.values()) {
   const toolId = entry.row.item.tool?.id
   if (toolId && this.#toolOwners.get(toolId)?.rowId === owner.rowId) {
    this.#overlay(entry.row.item, firstTouched)
   }
  }
 }
 /**
  * Evict one runtime item (explicit producer delete or retention trim).
  * Small version tombstones reject stale updates and terminal-to-running
  * resurrection in the same run; a different run may legitimately reuse an
  * ID. Durable rows that adopted live keys are never removed.
  */
 #deleteItem(itemId: string, firstTouched: Map<string, BetaRow | undefined>, changed: Set<string>): boolean {
  const entry = this.#runtime.get(itemId)
  if (!entry) return false
  const { runId, state, updatedAt } = entry.row.item
  this.#tombstones.set(itemId, { runId, state, updatedAt })
  if (this.#tombstones.size > MAX_RUNTIME_ITEMS) {
   const oldest = this.#tombstones.keys().next().value
   if (oldest !== undefined) this.#tombstones.delete(oldest)
  }
  this.#runtime.delete(itemId)
  const rowId = entry.row.id
  if (!this.#historyIds.has(rowId)) {
   this.#rowsById.delete(rowId)
   changed.add(rowId)
  }
  const toolId = entry.row.item.tool?.id
  if (toolId) {
   const owner = this.#toolOwners.get(toolId)
   if (owner) this.#removeOverlay(owner, firstTouched)
  }
  return !entry.covered
 }
 #resetOverlays(firstTouched: Map<string, BetaRow | undefined>): void {
  for (const row of this.#historyRows) {
   const current = this.#rowsById.get(row.id)
   if (current === row) continue
   if (!firstTouched.has(row.id)) firstTouched.set(row.id, current)
   this.#rowsById.set(row.id, row)
  }
 }
 #diffTouched(firstTouched: Map<string, BetaRow | undefined>, changed: Set<string>): void {
  for (const [id, prior] of firstTouched) {
   if (this.#rowsById.get(id) !== prior) changed.add(id)
  }
 }
 /**
    * Structural refs: history in order, uncovered runtime rows anchored to the
    * row that preceded them when they first became visible. Anchors — not
    * timestamps — place live rows: runner and hub clocks skew, so ordering by
    * item.createdAt once pushed answers above their own prompts. An entry
    * anchored to a durable row that adopts its live key stays put; orphans
    * (deleted/never-anchored rows) settle at the tail in insertion order and
    * are re-anchored there for stability.
    */
 #anchorFor(): string | undefined {
  const refs = this.#refs
  return refs.length ? refs[refs.length - 1].id : undefined
 }
 #rebuildRefs(presentationChanged = false): void {
  const previous = new Map(this.#refs.map(ref => [ref.id, ref]))
  const byAnchor = new Map<string, RuntimeEntry[]>()
  const loose: RuntimeEntry[] = []
  for (const entry of this.#runtime.values()) {
   if (entry.covered) continue
   if (entry.after === undefined) loose.push(entry)
   else {
    const group = byAnchor.get(entry.after)
    if (group) group.push(entry)
    else byAnchor.set(entry.after, [entry])
   }
  }
  const refs: BetaRowRef[] = []
  const emitted = new Set<string>()
  const flush = (anchor: string | undefined): void => {
   for (const entry of byAnchor.get(anchor as string) ?? []) {
    if (emitted.has(entry.ref.id)) continue
    refs.push(entry.ref)
    emitted.add(entry.ref.id)
    flush(entry.ref.id)
   }
  }
  for (const row of this.#historyRows) {
   const old = previous.get(row.id)
   const ref = old?.kind === 'history' ? old : { id: row.id, kind: 'history' as const }
   refs.push(ref)
   emitted.add(row.id)
   flush(row.id)
  }
  let last: string | undefined = refs.length ? refs[refs.length - 1].id : undefined
  for (const entry of loose) {
   if (emitted.has(entry.ref.id)) continue
   entry.after = last
   refs.push(entry.ref)
   emitted.add(entry.ref.id)
   flush(entry.ref.id)
   last = refs[refs.length - 1].id
  }
  for (const entry of this.#runtime.values()) {
   if (entry.covered || emitted.has(entry.ref.id)) continue
   refs.push(entry.ref)
   emitted.add(entry.ref.id)
   entry.after = last
   flush(entry.ref.id)
   last = refs[refs.length - 1].id
  }
  if (!presentationChanged && refs.length === this.#refs.length && refs.every((ref, index) => ref.id === this.#refs[index].id && ref.kind === this.#refs[index].kind)) return
  this.#refs = refs
  this.#emit(this.#structureListeners)
 }

 setHistory = (blocks: readonly VisibleChatBlock[]): void => {
  if (this.#disposed || blocks === this.#historyInput) return
  this.#historyInput = blocks
  const priorLookup = this.#rowsById
  const priorHistoryById = new Map(this.#historyRows.map(row => [row.id, row]))
  const runtimeKeys = new Map<string, string[]>()
  // Only uncovered live rows may lend their key to an arriving durable
  // block: covered entries were never displayed, so the history row keeps
  // its own h: identity.
  for (const entry of this.#runtime.values()) {
   if (entry.covered) continue
   for (const key of coverageKeys(entry.row.item)) {
    const ids = runtimeKeys.get(key) ?? []
    ids.push(entry.row.id)
    runtimeKeys.set(key, ids)
   }
  }
  const nextAliases = new Map<string, string>()
  const nextKeys = new Set<string>()
  const used = new Set<string>()
  const nextRows: Extract<BetaRow, { kind: 'history' }>[] = []
  const nextLookup = new Map<string, BetaRow>()
  for (const block of blocks) {
   for (const key of coverageIdentities(block)) nextKeys.add(key)
   const aliases = historyAliases(block)
   let id = aliases.map(alias => this.#historyAliases.get(alias)).find(value => value !== undefined && !used.has(value))
   // First durable block reuses the live key (tool ids take
   // precedence over the shared assistant canonical uuid). Any
   // remaining content blocks keep distinct keys: one canonicalId
   // must not collapse a multi-block message into one row.
   id ??= reuseKeys(block).flatMap(key => runtimeKeys.get(key) ?? []).find(value => !used.has(value))
   if (!id) {
    const base = `h:${block.id}`
    id = base
    let ordinal = 2
    while (used.has(id)) id = `${base}#${ordinal++}`
   }
   used.add(id)
   for (const alias of aliases) if (!nextAliases.has(alias)) nextAliases.set(alias, id)
   // Compare against the raw history row — the live lookup may hold
   // an overlaid copy of the same block, which must not churn.
   const prior = priorHistoryById.get(id)
   const row = prior?.block === block ? prior : { id, kind: 'history' as const, block }
   nextRows.push(row)
   nextLookup.set(id, row)
  }
  this.#historyAliases = nextAliases
  this.#historyRows = nextRows
  this.#historyKeys = nextKeys
  this.#historyIds = used
  for (const entry of this.#runtime.values()) {
   entry.covered = this.#covered(entry.row.item)
   if (!entry.covered) nextLookup.set(entry.row.id, entry.row)
  }
  this.#rowsById = nextLookup
  this.#toolOwners.clear()
  for (const row of nextRows) indexTools(row.block, row.id, this.#toolOwners)
  for (const entry of this.#runtime.values()) this.#overlay(entry.row.item)
  const changed = new Set<string>()
  for (const [id, row] of this.#rowsById) if (priorLookup.get(id) !== row) changed.add(id)
  for (const id of priorLookup.keys()) if (!this.#rowsById.has(id)) changed.add(id)
  this.#rebuildRefs()
  this.#emitRows(changed)
 }

 applyPublication = (publication: RuntimePublication): void => {
  if (this.#disposed) return
  if (publication.kind === 'snapshot') this.#applySnapshot(publication.snapshot)
  else this.#applyPatch(publication.patch)
 }
 #applySnapshot(snapshot: RuntimeSnapshot): void {
  if (snapshot.epoch === this.#epoch && snapshot.seq < this.#seq) return
  if (this.#retiredEpochs.has(snapshot.epoch)) return
  if (this.#epoch && this.#epoch !== snapshot.epoch) {
   this.#retiredEpochs.add(this.#epoch)
   this.#tombstones.clear()
   if (this.#retiredEpochs.size > 32) this.#retiredEpochs.delete(this.#retiredEpochs.values().next().value!)
  }
  const incoming = new Map<string, RuntimeEntry>()
  const changed = new Set<string>()
  const firstTouched = new Map<string, BetaRow | undefined>()
  let presentationChanged = false
  this.#resetOverlays(firstTouched)
  for (const entry of this.#runtime.values()) {
   if (!this.#historyIds.has(entry.row.id)) this.#rowsById.delete(entry.row.id)
   changed.add(entry.row.id)
  }
  for (const item of snapshot.items.slice(-MAX_RUNTIME_ITEMS)) {
   const old = this.#runtime.get(item.id)
   this.#tombstones.delete(item.id)
   const id = `r:${item.id}`
   const row = old?.row.item === item ? old.row : { id, kind: 'runtime' as const, item }
   const covered = this.#covered(item)
   if (old && !covered && runtimePresentationChanged(old.row.item, item)) presentationChanged = true
   const entry: RuntimeEntry = { row, ref: old?.ref ?? { id, kind: 'runtime' as const }, covered, after: old ? old.after : (!covered ? this.#anchorFor() : undefined) }
   incoming.set(item.id, entry)
   if (!entry.covered) this.#rowsById.set(id, row)
   changed.add(id)
   this.#overlay(item, firstTouched)
  }
  this.#runtime = incoming
  this.#diffTouched(firstTouched, changed)
  this.#epoch = snapshot.epoch
  this.#seq = snapshot.seq
  this.#setStatus({ run: snapshot.run })
  this.#rebuildRefs(presentationChanged)
  this.#emitRows(changed)
 }
 #patchRun(run: RuntimeRun): void {
  const prior = this.#status.run
  if (prior?.id === run.id && prior.state !== 'running' && run.state === 'running') return
  if (prior && prior.id !== run.id && run.startedAt < prior.startedAt) return
  this.#setStatus({ run })
 }
 #applyPatch(patch: RuntimePatch): void {
  if (patch.epoch !== this.#epoch) throw new RuntimeTimelineResyncError('Runtime epoch changed; snapshot required')
  if (patch.seq <= this.#seq) return
  if (patch.seq !== this.#seq + 1) throw new RuntimeTimelineResyncError('Runtime sequence gap; snapshot required')
  const changed = new Set<string>()
  const firstTouched = new Map<string, BetaRow | undefined>()
  let structural = false
  let presentationChanged = false
  for (const change of patch.changes) {
   if (change.type === 'clear') {
    this.#resetOverlays(firstTouched)
    for (const entry of this.#runtime.values()) {
     if (!this.#historyIds.has(entry.row.id)) this.#rowsById.delete(entry.row.id)
     changed.add(entry.row.id)
    }
    this.#runtime.clear()
    this.#tombstones.clear()
    this.#setStatus({ run: null })
    structural = true
   } else if (change.type === 'run') {
    this.#patchRun(change.run)
   } else if (change.type === 'delete') {
    // Retention eviction on the producer: drop only the live representation
    // and any overlay it installed; durable history rows keep their keys.
    if (this.#deleteItem(change.id, firstTouched, changed)) structural = true
   } else {
    const item = change.item
    const prior = this.#runtime.get(item.id)
    if (prior && (item.updatedAt < prior.row.item.updatedAt || (prior.row.item.state !== 'running' && item.state === 'running'))) continue
    if (!prior) {
     const tombstone = this.#tombstones.get(item.id)
     if (tombstone && tombstone.runId === item.runId && (item.updatedAt <= tombstone.updatedAt || (tombstone.state !== 'running' && item.state === 'running'))) continue
    }
    this.#tombstones.delete(item.id)
    if (prior?.row.item === item) continue
    const id = `r:${item.id}`
    const covered = this.#covered(item)
    if (prior && !covered && runtimePresentationChanged(prior.row.item, item)) presentationChanged = true
    const row = { id, kind: 'runtime' as const, item }
    const after = prior ? prior.after : (!covered ? this.#anchorFor() : undefined)
    this.#runtime.set(item.id, { row, ref: prior?.ref ?? { id, kind: 'runtime' }, covered, after })
    if (!covered) {
     this.#rowsById.set(id, row)
     changed.add(id)
    } else if (!this.#historyIds.has(id)) {
     this.#rowsById.delete(id)
     if (prior && !prior.covered) changed.add(id)
    }
    this.#overlay(item, firstTouched)
    if ((!prior && !covered) || (prior && prior.covered !== covered)) structural = true
   }
  }
  while (this.#runtime.size > MAX_RUNTIME_ITEMS) {
   const id = this.#runtime.keys().next().value!
   if (this.#deleteItem(id, firstTouched, changed)) structural = true
  }
  this.#seq = patch.seq
  this.#diffTouched(firstTouched, changed)
  // Content-only patches touch only changed IDs: no window scan, refs
  // allocation or list/status notifications on the token hot path.
  if (structural || presentationChanged) this.#rebuildRefs(presentationChanged)
  this.#emitRows(changed)
 }
 clearRuntime(): void {
  if (this.#disposed) return
  const changed = new Set<string>()
  const firstTouched = new Map<string, BetaRow | undefined>()
  this.#resetOverlays(firstTouched)
  for (const entry of this.#runtime.values()) {
   if (!this.#historyIds.has(entry.row.id)) this.#rowsById.delete(entry.row.id)
   changed.add(entry.row.id)
  }
  this.#runtime.clear()
  this.#tombstones.clear()
  this.#overlayCache.clear()
  this.#diffTouched(firstTouched, changed)
  this.#epoch = null
  this.#seq = 0
  this.#retiredEpochs.clear()
  this.#setStatus({ run: null })
  this.#rebuildRefs()
  this.#emitRows(changed)
 }
 dispose = (): void => {
  if (this.#disposed) return
  this.#disposed = true
  this.#structureListeners.clear()
  this.#rowListeners.clear()
  this.#statusListeners.clear()
  this.#runtime.clear()
  this.#rowsById.clear()
  this.#historyRows = []
  this.#historyInput = null
  this.#historyAliases.clear()
  this.#historyKeys.clear()
  this.#historyIds.clear()
  this.#retiredEpochs.clear()
  this.#tombstones.clear()
  this.#overlayCache.clear()
  this.#toolOwners.clear()
  this.#refs = []
 }
}
