import { z } from 'zod'

export const MAX_RUNTIME_ITEMS = 2000
export const MAX_RUNTIME_PUBLICATION_BYTES = 4 * 1024 * 1024
export const MAX_RUNTIME_RETAINED_BYTES = 3 * 1024 * 1024
const RUNTIME_ENVELOPE_RESERVE = 1024
const runtimeEncoder = new TextEncoder()

export function runtimeSerializedBytes(value: unknown): number {
    return runtimeEncoder.encode(JSON.stringify(value)).byteLength
}
const RuntimeStopReasonSchema = z.enum(['stop', 'length', 'toolUse', 'error', 'aborted'])
export type RuntimeStopReason = z.infer<typeof RuntimeStopReasonSchema>

export const RuntimeItemSchema = z.object({
    id: z.string().min(1).max(256),
    kind: z.enum(['assistant', 'tool']),
    runId: z.string().min(1).max(256),
    createdAt: z.number().finite(),
    updatedAt: z.number().finite(),
    state: z.enum(['running', 'completed', 'error', 'aborted']),
    text: z.string().optional(),
    reasoning: z.string().optional(),
    stopReason: RuntimeStopReasonSchema.optional(),
    errorMessage: z.string().optional(),
    model: z.string().optional(),
    provider: z.string().optional(),
    previewOmitted: z.boolean().optional(),
    tool: z.object({
        id: z.string().min(1).max(256),
        name: z.string().min(1),
        input: z.unknown(),
        output: z.unknown().optional(),
        isError: z.boolean().optional(),
    }).optional(),
    canonicalId: z.string().optional(),
    parentToolCallId: z.string().optional(),
    agentId: z.string().optional(),
})
export type RuntimeItem = z.infer<typeof RuntimeItemSchema>

export const RuntimeRunSchema = z.object({
    id: z.string().min(1).max(256),
    state: z.enum(['running', 'idle', 'error', 'aborted']),
    startedAt: z.number().finite(),
    endedAt: z.number().finite().optional(),
    stopReason: RuntimeStopReasonSchema.optional(),
    errorMessage: z.string().optional(),
})
export type RuntimeRun = z.infer<typeof RuntimeRunSchema>

export const RuntimeChangeSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('item'), item: RuntimeItemSchema }),
    z.object({ type: z.literal('run'), run: RuntimeRunSchema }),
    z.object({ type: z.literal('clear') }),
    z.object({ type: z.literal('delete'), id: z.string().min(1).max(256) }),
])
export type RuntimeChange = z.infer<typeof RuntimeChangeSchema>

export const RuntimePatchSchema = z.object({
    version: z.literal(1),
    epoch: z.string().min(1).max(256),
    seq: z.number().int().positive(),
    changes: z.array(RuntimeChangeSchema).max(MAX_RUNTIME_ITEMS * 2 + 2),
    updatedAt: z.number().finite(),
})
export type RuntimePatch = z.infer<typeof RuntimePatchSchema>

export const RuntimeSnapshotSchema = z.object({
    version: z.literal(1),
    epoch: z.string().min(1).max(256),
    seq: z.number().int().nonnegative(),
    items: z.array(RuntimeItemSchema).max(MAX_RUNTIME_ITEMS),
    run: RuntimeRunSchema.nullable(),
    updatedAt: z.number().finite(),
}).superRefine((value, context) => {
    const ids = new Set<string>()
    for (const item of value.items) {
        if (ids.has(item.id)) context.addIssue({ code: 'custom', message: `Duplicate runtime item: ${item.id}` })
        ids.add(item.id)
    }
})
export type RuntimeSnapshot = z.infer<typeof RuntimeSnapshotSchema>

export const RuntimePublicationSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('snapshot'), snapshot: RuntimeSnapshotSchema }),
    z.object({ kind: z.literal('patch'), patch: RuntimePatchSchema }),
])
export type RuntimePublication = z.infer<typeof RuntimePublicationSchema>

export function createRuntimeSnapshot(epoch: string): RuntimeSnapshot {
    return { version: 1, epoch, seq: 0, items: [], run: null, updatedAt: 0 }
}

/** Apply one atomic runtime commit. Missing revisions require an authoritative snapshot. */
export function applyRuntimePatch(previous: RuntimeSnapshot, patch: RuntimePatch): RuntimeSnapshot {
    const projection = new RuntimeTimelineProjection(previous.epoch)
    projection.replace(previous)
    return projection.apply(patch) ? projection.snapshot() : previous
}

/** The live path updates only named entities; snapshots are materialized on demand. */
export class RuntimeTimelineProjection {
    #epoch: string
    #seq = 0
    #items = new Map<string, RuntimeItem>()
    #sizes = new Map<string, number>()
    #itemBytes = 0
    #runBytes = 0
    #evictedIds: string[] = []
    #run: RuntimeRun | null = null
    #updatedAt = 0
    #cached: RuntimeSnapshot | undefined

    constructor(epoch: string) {
        this.#epoch = epoch
    }

    get epoch(): string { return this.#epoch }
    get seq(): number { return this.#seq }
    get retainedBytes(): number { return RUNTIME_ENVELOPE_RESERVE + this.#itemBytes + this.#runBytes }
    hasItem(id: string): boolean { return this.#items.has(id) }
    getItem(id: string): RuntimeItem | undefined { return this.#items.get(id) }
    get run(): RuntimeRun | null { return this.#run }

    takeEvictedIds(): string[] {
        const result = this.#evictedIds
        this.#evictedIds = []
        return result
    }

    #remove(id: string): void {
        this.#itemBytes -= this.#sizes.get(id) ?? 0
        this.#sizes.delete(id)
        this.#items.delete(id)
    }

    #bound(): void {
        if (this.#items.size <= MAX_RUNTIME_ITEMS && this.retainedBytes <= MAX_RUNTIME_RETAINED_BYTES) return
        // Older completed rows already have canonical history. Retention evicts
        // whole entities, never silently slices their text or tool output.
        for (const phase of ['completed', 'terminal', 'any'] as const) {
            for (const [id, item] of this.#items) {
                if (phase === 'completed' && item.state !== 'completed') continue
                if (phase === 'terminal' && item.state === 'running') continue
                this.#remove(id)
                this.#evictedIds.push(id)
                if (this.#items.size <= MAX_RUNTIME_ITEMS && this.retainedBytes <= MAX_RUNTIME_RETAINED_BYTES) return
            }
        }
    }

    replace(snapshot: RuntimeSnapshot): void {
        const runBytes = snapshot.run ? runtimeSerializedBytes(snapshot.run) : 0
        if (runBytes + RUNTIME_ENVELOPE_RESERVE > MAX_RUNTIME_RETAINED_BYTES) throw new Error('Runtime run metadata exceeds retention budget')
        this.#epoch = snapshot.epoch
        this.#seq = snapshot.seq
        this.#items = new Map(snapshot.items.map(item => [item.id, item]))
        this.#sizes = new Map(snapshot.items.map(item => [item.id, runtimeSerializedBytes(item)]))
        this.#itemBytes = 0
        for (const size of this.#sizes.values()) this.#itemBytes += size
        this.#run = snapshot.run
        this.#runBytes = runBytes
        this.#updatedAt = snapshot.updatedAt
        this.#evictedIds = []
        this.#bound()
        this.#cached = this.#evictedIds.length === 0 ? snapshot : undefined
    }

    apply(patch: RuntimePatch): boolean {
        if (patch.epoch !== this.#epoch) throw new Error('Runtime epoch changed; snapshot required')
        if (patch.seq <= this.#seq) return false
        if (patch.seq !== this.#seq + 1) throw new Error('Runtime sequence gap; snapshot required')
        for (const change of patch.changes) {
            if (change.type === 'run' && runtimeSerializedBytes(change.run) + RUNTIME_ENVELOPE_RESERVE > MAX_RUNTIME_RETAINED_BYTES) {
                throw new Error('Runtime run metadata exceeds retention budget')
            }
        }
        this.#evictedIds = []
        for (const change of patch.changes) {
            if (change.type === 'clear') {
                this.#items.clear()
                this.#sizes.clear()
                this.#itemBytes = 0
                this.#run = null
                this.#runBytes = 0
            } else if (change.type === 'delete') {
                this.#remove(change.id)
            } else if (change.type === 'run') {
                const prior = this.#run
                if (prior?.id === change.run.id && prior.state !== 'running' && change.run.state === 'running') continue
                if (prior && prior.id !== change.run.id && change.run.startedAt < prior.startedAt) continue
                this.#run = change.run
                this.#runBytes = runtimeSerializedBytes(change.run)
            } else {
                const prior = this.#items.get(change.item.id)
                if (prior && (change.item.updatedAt < prior.updatedAt || (prior.state !== 'running' && change.item.state === 'running'))) continue
                const size = runtimeSerializedBytes(change.item)
                this.#itemBytes += size - (this.#sizes.get(change.item.id) ?? 0)
                this.#sizes.set(change.item.id, size)
                this.#items.set(change.item.id, change.item)
            }
        }
        this.#bound()
        this.#seq = patch.seq
        this.#updatedAt = patch.updatedAt
        this.#cached = undefined
        return true
    }

    snapshot(): RuntimeSnapshot {
        this.#cached ??= {
            version: 1, epoch: this.#epoch, seq: this.#seq,
            items: [...this.#items.values()], run: this.#run, updatedAt: this.#updatedAt,
        }
        return this.#cached
    }
}
