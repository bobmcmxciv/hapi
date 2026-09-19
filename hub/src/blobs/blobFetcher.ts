import type { GeneratedBlobChunkRequest, GeneratedBlobChunkResponse, GeneratedBlobKind } from '@hapi/protocol/apiTypes'
import { GENERATED_BLOB_PULL_CHUNK_BYTES } from '@hapi/protocol/socketLimits'
import { RpcTargetMissingError } from '../sync/rpcGateway'
import { BlobStorageFullError, BlobStore, BlobTooLargeError, type BlobRecord } from './blobStore'

/**
 * Pulls a blob from the CLI that holds it into the hub store — once, for
 * everyone.
 *
 * This is the fallback for envelopes whose bytes were never pushed (CLIs that
 * predate the push, or a push whose process died). It replaces the old
 * per-request streaming pull, which had three failure modes on a slow uplink:
 * the HTTP connection idled out before the first slice arrived (502), the 2 MiB
 * frames starved the socket.io heartbeat (session dropped), and every viewer,
 * retry and remount started the whole transfer again.
 *
 * One job per blob. HTTP requests never wait on it for long — they answer
 * `202` with progress and come back — so the job outlives any single request
 * and the bytes it lands are served from disk to whoever asks next.
 */

export type BlobFetchFailure = {
    kind: 'offline' | 'timeout' | 'not-found' | 'storage'
    message: string
}

export type BlobFetchOutcome =
    | { ok: true; record: BlobRecord }
    | { ok: false; failure: BlobFetchFailure }

export type BlobFetchEngine = {
    readGeneratedBlobChunk(sessionId: string, request: GeneratedBlobChunkRequest, timeoutMs?: number): Promise<GeneratedBlobChunkResponse>
    readGeneratedFile(sessionId: string, fileId: string): Promise<{ success: boolean; content?: string; mimeType?: string; fileName?: string; size?: number; error?: string }>
    readGeneratedImage(sessionId: string, imageId: string): Promise<{ success: boolean; content?: string; mimeType?: string; fileName?: string; error?: string }>
}

export type BlobFetcherOptions = {
    chunkBytes?: number
    /** Slices kept in flight on the socket. Two keeps the link busy across the
     *  RPC round-trip without queueing enough bytes to starve the heartbeat. */
    window?: number
    chunkTimeoutMs?: number
    chunkRetries?: number
    retryDelayMs?: number
    /** How long to keep waiting for a disconnected CLI to come back. */
    offlineWaitMs?: number
    offlinePollMs?: number
    /** Whole-job deadline. */
    deadlineMs?: number
    /** How long a failed job is remembered before a new request may start another. */
    failureTtlMs?: number
    now?: () => number
    sleep?: (ms: number) => Promise<void>
}

type ResolvedOptions = Required<BlobFetcherOptions>

const DEFAULT_OPTIONS: ResolvedOptions = {
    chunkBytes: GENERATED_BLOB_PULL_CHUNK_BYTES,
    window: 2,
    chunkTimeoutMs: 45_000,
    chunkRetries: 3,
    retryDelayMs: 750,
    offlineWaitMs: 90_000,
    offlinePollMs: 5_000,
    deadlineMs: 30 * 60_000,
    failureTtlMs: 20_000,
    now: () => Date.now(),
    sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))
}

class ChunkFailure extends Error {
    constructor(readonly failure: BlobFetchFailure) {
        super(failure.message)
        this.name = 'ChunkFailure'
    }
}

class LegacyReadRequired extends Error {
    constructor() {
        super('CLI predates chunked reads')
        this.name = 'LegacyReadRequired'
    }
}

type ChunkResult = {
    bytes: Buffer
    size: number
    mimeType: string
    fileName: string
}

function blobKey(kind: GeneratedBlobKind, id: string): string {
    return `${kind}-${id}`
}

export class GeneratedBlobFetchJob {
    readonly done: Promise<BlobFetchOutcome>
    private outcome: BlobFetchOutcome | null = null
    private received: number
    private size: number | null
    readonly startedAt: number
    finishedAt: number | null = null

    constructor(
        readonly kind: GeneratedBlobKind,
        readonly id: string,
        readonly sessionId: string,
        private readonly engine: BlobFetchEngine,
        private readonly store: BlobStore,
        private readonly options: ResolvedOptions
    ) {
        const existing = store.stat(kind, id)
        this.received = existing?.received ?? 0
        this.size = existing?.size ?? null
        this.startedAt = options.now()
        this.done = this.run().then((outcome) => {
            this.outcome = outcome
            this.finishedAt = options.now()
            return outcome
        })
    }

    status(): { received: number; size: number | null } {
        return { received: this.received, size: this.size }
    }

    result(): BlobFetchOutcome | null {
        return this.outcome
    }

    /** Resolve with the outcome if the job finishes within `ms`, else `'pending'`. */
    async waitFor(ms: number): Promise<BlobFetchOutcome | 'pending'> {
        if (this.outcome) return this.outcome
        let timer: ReturnType<typeof setTimeout> | null = null
        const timeout = new Promise<'pending'>((resolve) => {
            timer = setTimeout(() => resolve('pending'), ms)
        })
        try {
            return await Promise.race([this.done, timeout])
        } finally {
            if (timer) clearTimeout(timer)
        }
    }

    private async run(): Promise<BlobFetchOutcome> {
        try {
            const record = await this.pull()
            return { ok: true, record }
        } catch (error) {
            if (error instanceof ChunkFailure) {
                return { ok: false, failure: error.failure }
            }
            if (error instanceof BlobStorageFullError || error instanceof BlobTooLargeError) {
                return { ok: false, failure: { kind: 'storage', message: error.message } }
            }
            const message = error instanceof Error ? error.message : String(error)
            return { ok: false, failure: { kind: 'not-found', message } }
        }
    }

    private async pull(): Promise<BlobRecord> {
        const { chunkBytes, window } = this.options
        const existing = this.store.stat(this.kind, this.id)
        if (existing?.state === 'ready') {
            return existing
        }
        let start = existing?.received ?? 0

        let first: ChunkResult
        try {
            first = await this.readChunk(start, chunkBytes)
        } catch (error) {
            if (!(error instanceof LegacyReadRequired)) throw error
            return await this.pullLegacy()
        }

        if (existing && existing.size !== first.size) {
            // The partial on disk is not this blob (size disagrees). Start clean.
            await this.store.remove(this.kind, this.id)
            start = 0
            first = await this.readChunk(0, chunkBytes)
        }

        this.size = first.size
        const meta = {
            sessionId: this.sessionId,
            fileName: first.fileName,
            mimeType: first.mimeType,
            size: first.size,
            origin: 'pull' as const
        }

        let record = await this.store.append(this.kind, this.id, meta, start, first.bytes)
        this.received = record.received
        if (record.state === 'ready') {
            return record
        }
        if (first.bytes.byteLength === 0) {
            throw new ChunkFailure({ kind: 'not-found', message: `generated blob transfer stalled at offset ${start}` })
        }

        // Pipelined, in-order: keep `window` slices requested ahead, but write
        // strictly sequentially so the store's offset check stays trivially true.
        let next = record.received
        const inflight: { offset: number; promise: Promise<ChunkResult> }[] = []
        const enqueue = () => {
            while (inflight.length < window && next < record.size) {
                const offset = next
                const length = Math.min(chunkBytes, record.size - offset)
                inflight.push({ offset, promise: this.readChunk(offset, length) })
                next += length
            }
        }
        enqueue()
        while (inflight.length > 0) {
            const head = inflight.shift()!
            let chunk: ChunkResult
            try {
                chunk = await head.promise
            } catch (error) {
                // Let the rest of the window settle so nothing rejects unobserved.
                for (const pending of inflight) pending.promise.catch(() => {})
                throw error
            }
            if (chunk.bytes.byteLength === 0) {
                for (const pending of inflight) pending.promise.catch(() => {})
                throw new ChunkFailure({ kind: 'not-found', message: `generated blob transfer stalled at offset ${head.offset}` })
            }
            record = await this.store.append(this.kind, this.id, meta, head.offset, chunk.bytes)
            this.received = record.received
            enqueue()
        }
        if (record.state !== 'ready') {
            throw new ChunkFailure({ kind: 'not-found', message: `generated blob transfer ended short at ${record.received}/${record.size}` })
        }
        return record
    }

    /** Pre-chunking CLI: one whole-blob RPC, then store it in one append. */
    private async pullLegacy(): Promise<BlobRecord> {
        let legacy: Awaited<ReturnType<BlobFetchEngine['readGeneratedFile']>>
        try {
            legacy = this.kind === 'image'
                ? await this.engine.readGeneratedImage(this.sessionId, this.id)
                : await this.engine.readGeneratedFile(this.sessionId, this.id)
        } catch (error) {
            throw new ChunkFailure(classifyRpcError(error))
        }
        if (!legacy.success || legacy.content === undefined) {
            throw new ChunkFailure({ kind: 'not-found', message: legacy.error ?? 'Generated blob not found' })
        }
        const bytes = Buffer.from(legacy.content, 'base64')
        this.size = bytes.byteLength
        await this.store.remove(this.kind, this.id)
        const record = await this.store.append(this.kind, this.id, {
            sessionId: this.sessionId,
            fileName: legacy.fileName ?? this.id,
            mimeType: legacy.mimeType ?? 'application/octet-stream',
            size: bytes.byteLength,
            origin: 'pull'
        }, 0, bytes)
        this.received = record.received
        return record
    }

    /** One slice with the full retry ladder: transport timeouts retry a few
     *  times, a disconnected CLI is waited for, a "not found" is final. */
    private async readChunk(offset: number, length: number): Promise<ChunkResult> {
        const { chunkRetries, retryDelayMs, offlineWaitMs, offlinePollMs, chunkTimeoutMs, deadlineMs, now, sleep } = this.options
        let timeouts = 0
        let offlineSince: number | null = null
        for (;;) {
            if (now() - this.startedAt > deadlineMs) {
                throw new ChunkFailure({ kind: 'timeout', message: 'generated blob transfer exceeded its deadline' })
            }
            try {
                const response = await this.engine.readGeneratedBlobChunk(
                    this.sessionId,
                    { kind: this.kind, id: this.id, offset, length },
                    chunkTimeoutMs
                )
                if (!response.success || response.content === undefined) {
                    throw new ChunkFailure({ kind: 'not-found', message: response.error ?? 'Generated blob not found' })
                }
                const size = typeof response.size === 'number' && response.size >= 0
                    ? response.size
                    : Buffer.byteLength(response.content, 'base64')
                return {
                    bytes: Buffer.from(response.content, 'base64'),
                    size,
                    mimeType: response.mimeType ?? 'application/octet-stream',
                    fileName: response.fileName ?? this.id
                }
            } catch (error) {
                if (error instanceof ChunkFailure) throw error
                if (error instanceof RpcTargetMissingError && error.code === 'handler-not-registered') {
                    throw new LegacyReadRequired()
                }
                const failure = classifyRpcError(error)
                if (failure.kind === 'offline') {
                    offlineSince ??= now()
                    if (now() - offlineSince > offlineWaitMs) {
                        throw new ChunkFailure(failure)
                    }
                    await sleep(offlinePollMs)
                    continue
                }
                if (failure.kind === 'timeout') {
                    timeouts += 1
                    if (timeouts > chunkRetries) {
                        throw new ChunkFailure(failure)
                    }
                    await sleep(retryDelayMs * timeouts)
                    continue
                }
                throw new ChunkFailure(failure)
            }
        }
    }
}

export function classifyRpcError(error: unknown): BlobFetchFailure {
    const message = error instanceof Error ? error.message : String(error)
    if (error instanceof RpcTargetMissingError) {
        return { kind: 'offline', message }
    }
    if (/timed out/i.test(message)) {
        return { kind: 'timeout', message }
    }
    return { kind: 'not-found', message }
}

export class GeneratedBlobFetcher {
    private readonly jobs = new Map<string, GeneratedBlobFetchJob>()
    private readonly options: ResolvedOptions

    constructor(private readonly store: BlobStore, options: BlobFetcherOptions = {}) {
        this.options = { ...DEFAULT_OPTIONS, ...options }
    }

    /** The running job for this blob, starting one if there is none. A job that
     *  failed recently is returned as-is so a burst of viewers does not turn into
     *  a burst of pulls against a machine that just said no. */
    ensure(engine: BlobFetchEngine, sessionId: string, kind: GeneratedBlobKind, id: string): GeneratedBlobFetchJob {
        const key = blobKey(kind, id)
        const existing = this.jobs.get(key)
        if (existing) {
            const result = existing.result()
            if (!result) return existing
            if (!result.ok && existing.finishedAt !== null && this.options.now() - existing.finishedAt < this.options.failureTtlMs) {
                return existing
            }
            this.jobs.delete(key)
        }
        const job = new GeneratedBlobFetchJob(kind, id, sessionId, engine, this.store, this.options)
        this.jobs.set(key, job)
        void job.done.then((outcome) => {
            if (outcome.ok && this.jobs.get(key) === job) {
                this.jobs.delete(key)
            }
        })
        return job
    }

    get(kind: GeneratedBlobKind, id: string): GeneratedBlobFetchJob | null {
        return this.jobs.get(blobKey(kind, id)) ?? null
    }
}
