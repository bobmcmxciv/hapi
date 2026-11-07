import { Hono } from 'hono'
import type { Context } from 'hono'
import { randomBytes, randomUUID } from 'node:crypto'
import { z } from 'zod'
import type {
    CreateP2pFileTransferResponse,
    GeneratedBlobChunkResponse,
    GeneratedBlobDownloadTicketResponse,
    GeneratedBlobKind,
    GeneratedBlobPendingResponse
} from '@hapi/protocol/apiTypes'
import {
    GENERATED_BLOB_PULL_CHUNK_BYTES,
    P2P_TRANSFER_TTL_MS
} from '@hapi/protocol/socketLimits'
import {
    isSafeBlobId,
    issueBlobDownloadTicket,
    verifyBlobDownloadTicket,
    type BlobRecord,
    type BlobStore,
    type GeneratedBlobServices
} from '../../blobs'
import type { SyncEngine } from '../../sync/syncEngine'
import { RpcTargetMissingError } from '../../sync/rpcGateway'
import type { WebAppEnv } from '../middleware/auth'
import { requireSessionFromParam, requireSyncEngine } from './guards'

const fileSearchSchema = z.object({
    query: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(500).optional()
})

const directorySchema = z.object({
    path: z.string().optional()
})

const filePathSchema = z.object({
    path: z.string().min(1)
})

const writeFileSchema = z.object({
    path: z.string().min(1),
    content: z.string(),
    expectedHash: z.string().regex(/^[a-f0-9]{64}$/)
})

const generatedImageSchema = z.object({
    imageId: z.string().min(1)
})

function normalizeFileSearchQuery(query: string, sessionPath: string): string {
    return isWindowsSessionPath(sessionPath) ? query.replaceAll('\\', '/') : query
}

function normalizeFileSearchPath(path: string): string {
    return path.replaceAll('\\', '/')
}

function isWindowsSessionPath(path: string): boolean {
    return /^[A-Za-z]:[\\/]/.test(path) || /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/.test(path)
}
const generatedFileSchema = z.object({
    fileId: z.string().min(1)
})

function parseBooleanParam(value: string | undefined): boolean | undefined {
    if (value === 'true') return true
    if (value === 'false') return false
    return undefined
}

async function runRpc<T>(fn: () => Promise<T>): Promise<T | { success: false; error: string }> {
    try {
        return await fn()
    } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
}

// Generated-image bytes for a given id never change, so they are cached for a year as immutable.
const GENERATED_IMAGE_CACHE_CONTROL = 'private, max-age=31536000, immutable'

// —— Generated blob transfer ————————————————————————————————————————————
//
// Downloads used to be a single RPC that had to move the whole blob inside the
// default 30 s budget; then a per-request chunked stream. Both pulled the bytes
// from the CLI machine on every request. Now the hub keeps the bytes itself
// (`BlobStore`): the CLI pushes them at send time, and for envelopes that were
// never pushed a single `GeneratedBlobFetcher` job pulls them once. A request
// that finds the bytes on disk is served from disk with Range support; one that
// finds them still in transit answers `202` with progress and the client polls.
// No HTTP request waits on the CLI link for long any more, which is what kept
// tripping the reverse proxy's idle timeout (502) on slow uplinks.
//
// `serveGeneratedBlobDirect` below is the previous streaming path; it is only
// used when the hub runs without a blob store (tests, minimal setups).

const BLOB_CHUNK_RETRIES = 3
const BLOB_CHUNK_RETRY_DELAY_MS = 750
/** How long a download request waits for a running pull before answering 202. */
const BLOB_PENDING_WAIT_MS = 12_000
/** Bounded wait for an active push to land before returning 202 (avoids a full 1.5 s poll pause on small files). */
const BLOB_PUSH_READY_WAIT_MS = 1_500
/** A push with no bytes for this long is treated as abandoned and pulled instead. */
const BLOB_PUSH_STALL_MS = 60_000
const BLOB_PENDING_RETRY_AFTER_MS = 1_500
type BlobFailure =
    | { kind: 'offline'; message: string }
    | { kind: 'timeout'; message: string }
    | { kind: 'not-found'; message: string }
    | { kind: 'storage'; message: string }

/**
 * Classify a failed blob read.
 *
 * The whole point: transport failures must stop masquerading as 404. A timeout
 * and a disconnected CLI are *retryable* conditions about the machine, while
 * 404 is a claim about the file itself — conflating them is what made this
 * problem invisible for weeks, since the logs and the UI both said "not found".
 */
function classifyBlobError(error: unknown): BlobFailure {
    const message = error instanceof Error ? error.message : String(error)
    if (error instanceof RpcTargetMissingError) {
        return { kind: 'offline', message }
    }
    if (/timed out/i.test(message)) {
        return { kind: 'timeout', message }
    }
    return { kind: 'not-found', message }
}

function blobFailureResponse(c: Context<WebAppEnv>, failure: BlobFailure) {
    if (failure.kind === 'offline') {
        // 503: the file may well exist; the machine holding it is unreachable.
        return c.json({ success: false, error: failure.message, reason: 'session-offline', retryable: true }, 503)
    }
    if (failure.kind === 'timeout') {
        return c.json({ success: false, error: failure.message, reason: 'timeout', retryable: true }, 504)
    }
    if (failure.kind === 'storage') {
        return c.json({ success: false, error: failure.message, reason: 'insufficient-storage', retryable: false }, 507)
    }
    return c.json({ success: false, error: failure.message, reason: 'not-found', retryable: false }, 404)
}

function blobPendingResponse(
    c: Context<WebAppEnv>,
    state: 'uploading' | 'fetching',
    progress: { received: number; size: number | null }
) {
    const body: GeneratedBlobPendingResponse = {
        success: false,
        state,
        received: progress.received,
        size: progress.size,
        retryAfterMs: BLOB_PENDING_RETRY_AFTER_MS
    }
    return c.json(body, 202, {
        'Cache-Control': 'no-store',
        'Retry-After': String(Math.ceil(BLOB_PENDING_RETRY_AFTER_MS / 1000))
    })
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

type ChunkReader = (offset: number, length: number) => Promise<GeneratedBlobChunkResponse>

/** Read one slice, retrying transport failures. A CLI-reported "not found" is
 *  final and is not retried — retrying it would just stall the download. */
async function readChunkWithRetry(
    read: ChunkReader,
    offset: number,
    length: number
): Promise<{ ok: true; response: GeneratedBlobChunkResponse } | { ok: false; failure: BlobFailure }> {
    let last: BlobFailure = { kind: 'not-found', message: 'Generated blob not found' }
    for (let attempt = 0; attempt <= BLOB_CHUNK_RETRIES; attempt++) {
        try {
            const response = await read(offset, length)
            if (response.success && response.content !== undefined) {
                return { ok: true, response }
            }
            return { ok: false, failure: { kind: 'not-found', message: response.error ?? 'Generated blob not found' } }
        } catch (error) {
            last = classifyBlobError(error)
            // A CLI that never registered the chunk handler will never grow one
            // mid-download; let the caller fall back instead of burning retries.
            if (error instanceof RpcTargetMissingError && error.code === 'handler-not-registered') {
                return { ok: false, failure: last }
            }
            if (attempt < BLOB_CHUNK_RETRIES) {
                await sleep(BLOB_CHUNK_RETRY_DELAY_MS * (attempt + 1))
            }
        }
    }
    return { ok: false, failure: last }
}

/** `bytes=<start>-<end>` for a known total size. Only a single range is
 *  honoured; anything else is treated as "no range" per RFC 9110 §14.1.2. */
export function parseSingleByteRange(header: string | undefined, size: number): { start: number; end: number } | 'unsatisfiable' | null {
    if (!header) return null
    const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
    if (!match) return null
    const [, rawStart, rawEnd] = match
    if (rawStart === '' && rawEnd === '') return null

    let start: number
    let end: number
    if (rawStart === '') {
        // Suffix form: last N bytes.
        const suffix = Number(rawEnd)
        if (suffix <= 0) return 'unsatisfiable'
        start = Math.max(0, size - suffix)
        end = size - 1
    } else {
        start = Number(rawStart)
        end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1)
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
        return 'unsatisfiable'
    }
    return { start, end }
}

type GeneratedBlobServeOptions = {
    sessionId: string
    kind: GeneratedBlobKind
    id: string
    etag: string
    disposition: 'inline' | 'attachment'
    fallbackFileName: string
    notFoundMessage: string
    legacyRead: () => Promise<{ success: boolean; content?: string; mimeType?: string; fileName?: string; error?: string }>
}

function blobHeaders(options: GeneratedBlobServeOptions, mimeType: string, fileName: string): Record<string, string> {
    return {
        'Content-Type': mimeType,
        'Content-Disposition': `${options.disposition}; filename="${encodeURIComponent(fileName)}"`,
        'Cache-Control': GENERATED_IMAGE_CACHE_CONTROL,
        // Advertised so browsers and download managers know a failed transfer
        // can be resumed rather than restarted.
        'Accept-Ranges': 'bytes',
        ETag: options.etag
    }
}

/** Serve a finished blob straight from the hub's disk, honouring Range. */
function serveStoredBlob(
    c: Context<WebAppEnv>,
    store: BlobStore,
    record: BlobRecord,
    options: GeneratedBlobServeOptions
): Response {
    store.touch(record.kind, record.id)
    const baseHeaders = blobHeaders(options, record.mimeType, record.fileName || options.fallbackFileName)
    const headOnly = c.req.method === 'HEAD'
    const size = record.size
    const range = parseSingleByteRange(c.req.header('range'), size)
    if (range === 'unsatisfiable') {
        return c.body(null, 416, { ...baseHeaders, 'Content-Range': `bytes */${size}` })
    }
    if (size === 0) {
        return new Response(headOnly ? null : new Uint8Array(0), {
            status: 200,
            headers: { ...baseHeaders, 'Content-Length': '0' }
        })
    }
    const start = range ? range.start : 0
    const end = range ? range.end : size - 1
    const length = end - start + 1
    const headers = range
        ? { ...baseHeaders, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(length) }
        : { ...baseHeaders, 'Content-Length': String(length) }
    if (headOnly) {
        return new Response(null, { status: range ? 206 : 200, headers })
    }
    const file = Bun.file(store.finalPath(record.kind, record.id))
    const body = range ? file.slice(start, end + 1) : file
    return new Response(body, { status: range ? 206 : 200, headers })
}

async function resolveStoredOrFetchedBlob(
    c: Context<WebAppEnv>,
    engine: SyncEngine,
    blobs: GeneratedBlobServices,
    options: Pick<GeneratedBlobServeOptions, 'sessionId' | 'kind' | 'id'>
): Promise<{ ok: true; record: BlobRecord } | { ok: false; response: Response }> {
    const { store, fetcher } = blobs
    const { sessionId, kind, id } = options
    let record = store.stat(kind, id)
    if (record && record.sessionId !== null && record.sessionId !== sessionId) {
        return {
            ok: false,
            response: c.json({
                success: false,
                error: 'Blob belongs to another session',
                reason: 'access-denied',
                retryable: false
            }, 403)
        }
    }
    if (record?.state === 'ready') {
        return { ok: true, record }
    }
    if (record?.state === 'uploading' && record.origin === 'push' && store.now() - record.lastActivityAt < BLOB_PUSH_STALL_MS) {
        const waitMs = blobs.pushReadyWaitMs ?? blobs.pendingWaitMs ?? BLOB_PUSH_READY_WAIT_MS
        if (waitMs > 0) {
            record = await store.waitForReady(kind, id, waitMs)
            if (record && record.sessionId !== null && record.sessionId !== sessionId) {
                return {
                    ok: false,
                    response: c.json({
                        success: false,
                        error: 'Blob belongs to another session',
                        reason: 'access-denied',
                        retryable: false
                    }, 403)
                }
            }
            if (record?.state === 'ready') {
                return { ok: true, record }
            }
        }
        // The sending CLI is still pushing; pulling concurrently would only
        // compete with it for the same uplink.
        return {
            ok: false,
            response: blobPendingResponse(c, 'uploading', {
                received: record?.received ?? 0,
                size: record?.size ?? null
            })
        }
    }
    const job = fetcher.ensure(engine, sessionId, kind, id)
    const outcome = await job.waitFor(blobs.pendingWaitMs ?? BLOB_PENDING_WAIT_MS)
    if (outcome === 'pending') {
        return { ok: false, response: blobPendingResponse(c, 'fetching', job.status()) }
    }
    if (!outcome.ok) {
        return { ok: false, response: blobFailureResponse(c, outcome.failure) }
    }
    if (outcome.record.sessionId !== null && outcome.record.sessionId !== sessionId) {
        return {
            ok: false,
            response: c.json({
                success: false,
                error: 'Blob belongs to another session',
                reason: 'access-denied',
                retryable: false
            }, 403)
        }
    }
    return { ok: true, record: outcome.record }
}

/**
 * Serve a sent file or a generated image from the hub store, pulling it from the
 * CLI first if the store does not have it yet. Never blocks on the CLI link for
 * more than `BLOB_PENDING_WAIT_MS`: past that the answer is `202` + progress.
 */
async function serveGeneratedBlob(
    c: Context<WebAppEnv>,
    engine: SyncEngine,
    blobs: GeneratedBlobServices,
    options: GeneratedBlobServeOptions
): Promise<Response> {
    const resolved = await resolveStoredOrFetchedBlob(c, engine, blobs, options)
    if (!resolved.ok) {
        return resolved.response
    }
    return serveStoredBlob(c, blobs.store, resolved.record, options)
}

/**
 * Previous behaviour, kept for hubs running without a blob store: stream the
 * blob straight from the CLI, slice by slice, into this response.
 */
async function serveGeneratedBlobDirect(
    c: Context<WebAppEnv>,
    engine: SyncEngine,
    options: GeneratedBlobServeOptions
) {
    const { sessionId, kind, id, fallbackFileName, legacyRead } = options
    const read: ChunkReader = (offset, length) =>
        engine.readGeneratedBlobChunk(sessionId, { kind, id, offset, length })

    // Two ways chunking can be unavailable: this hub is talking to a CLI that
    // predates the RPC method (no handler registered), or the engine itself
    // does not expose it. Both fall back to the whole-blob read.
    const chunkCapable = typeof engine.readGeneratedBlobChunk === 'function'
    const head = chunkCapable
        ? await readChunkWithRetry(read, 0, GENERATED_BLOB_PULL_CHUNK_BYTES)
        : null

    if (head === null || (!head.ok && head.failure.kind === 'offline' && /handler not registered/i.test(head.failure.message))) {
        // Pre-chunking CLI: one shot at the whole blob, now with the larger
        // budget rather than the 30 s cliff that produced the phantom 404s.
        let legacy: Awaited<ReturnType<typeof legacyRead>>
        try {
            legacy = await legacyRead()
        } catch (error) {
            return blobFailureResponse(c, classifyBlobError(error))
        }
        if (!legacy.success || legacy.content === undefined) {
            return blobFailureResponse(c, { kind: 'not-found', message: legacy.error ?? options.notFoundMessage })
        }
        const bytes = Uint8Array.from(Buffer.from(legacy.content, 'base64'))
        return c.body(bytes, 200, {
            'Content-Type': legacy.mimeType ?? 'application/octet-stream',
            'Content-Disposition': `${options.disposition}; filename="${encodeURIComponent(legacy.fileName ?? fallbackFileName)}"`,
            'Content-Length': String(bytes.byteLength),
            'Cache-Control': GENERATED_IMAGE_CACHE_CONTROL,
            ETag: options.etag
        })
    }

    if (!head.ok) {
        return blobFailureResponse(c, head.failure)
    }

    const first = head.response
    const size = typeof first.size === 'number' && first.size >= 0
        ? first.size
        : Buffer.byteLength(first.content ?? '', 'base64')
    const baseHeaders = blobHeaders(options, first.mimeType ?? 'application/octet-stream', first.fileName ?? fallbackFileName)

    const range = parseSingleByteRange(c.req.header('range'), size)
    if (range === 'unsatisfiable') {
        return c.body(null, 416, { ...baseHeaders, 'Content-Range': `bytes */${size}` })
    }

    const start = range ? range.start : 0
    const end = range ? range.end : size - 1
    const length = size === 0 ? 0 : end - start + 1

    if (size === 0) {
        return c.body(new Uint8Array(0), 200, { ...baseHeaders, 'Content-Length': '0' })
    }

    const status = range ? 206 : 200
    const headers = range
        ? { ...baseHeaders, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(length) }
        : { ...baseHeaders, 'Content-Length': String(length) }

    const firstChunk = Buffer.from(first.content ?? '', 'base64')
    const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
            try {
                let cursor = start
                while (cursor <= end) {
                    const want = Math.min(GENERATED_BLOB_PULL_CHUNK_BYTES, end - cursor + 1)
                    let bytes: Buffer
                    // The probe read already fetched [0, chunk); reuse it so a
                    // plain (rangeless) download costs no extra round-trip.
                    if (cursor < firstChunk.length) {
                        bytes = firstChunk.subarray(cursor, Math.min(cursor + want, firstChunk.length))
                    } else {
                        const next = await readChunkWithRetry(read, cursor, want)
                        if (!next.ok) {
                            // Status is already committed, so the only honest
                            // signal left is an aborted body — the declared
                            // Content-Length lets the client detect truncation.
                            controller.error(new Error(`generated blob transfer failed at offset ${cursor}: ${next.failure.message}`))
                            return
                        }
                        bytes = Buffer.from(next.response.content ?? '', 'base64')
                    }
                    if (bytes.length === 0) {
                        controller.error(new Error(`generated blob transfer stalled at offset ${cursor}`))
                        return
                    }
                    controller.enqueue(new Uint8Array(bytes))
                    cursor += bytes.length
                }
                controller.close()
            } catch (error) {
                controller.error(error)
            }
        }
    })

    return c.body(stream, status as 200 | 206, headers)
}

// Weak comparison of an If-None-Match header against our ETag (handles lists, `*`, and W/ prefixes).
function ifNoneMatchMatches(header: string | undefined, etag: string): boolean {
    if (!header) {
        return false
    }
    const normalized = etag.replace(/^W\//, '')
    return header.split(',').some((candidate) => {
        const trimmed = candidate.trim()
        return trimmed === '*' || trimmed.replace(/^W\//, '') === normalized
    })
}

export function createGitRoutes(
    getSyncEngine: () => SyncEngine | null,
    deps: { blobs?: GeneratedBlobServices; jwtSecret?: Uint8Array } = {}
): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()
    const blobs = deps.blobs ?? null
    const ticketSecret = deps.blobs?.ticketSecret ?? deps.jwtSecret
    app.get('/sessions/:id/git-status', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const sessionPath = sessionResult.session.metadata?.path
        if (!sessionPath) {
            return c.json({ success: false, error: 'Session path not available' })
        }

        const result = await runRpc(() => engine.getGitStatus(sessionResult.sessionId, sessionPath))
        return c.json(result)
    })

    app.get('/sessions/:id/git-diff-numstat', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const sessionPath = sessionResult.session.metadata?.path
        if (!sessionPath) {
            return c.json({ success: false, error: 'Session path not available' })
        }

        const staged = parseBooleanParam(c.req.query('staged'))
        const result = await runRpc(() => engine.getGitDiffNumstat(sessionResult.sessionId, { cwd: sessionPath, staged }))
        return c.json(result)
    })

    app.get('/sessions/:id/git-diff-file', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const sessionPath = sessionResult.session.metadata?.path
        if (!sessionPath) {
            return c.json({ success: false, error: 'Session path not available' })
        }

        const parsed = filePathSchema.safeParse(c.req.query())
        if (!parsed.success) {
            return c.json({ error: 'Invalid file path' }, 400)
        }

        const staged = parseBooleanParam(c.req.query('staged'))
        const result = await runRpc(() => engine.getGitDiffFile(sessionResult.sessionId, {
            cwd: sessionPath,
            filePath: parsed.data.path,
            staged
        }))
        return c.json(result)
    })

    app.get('/sessions/:id/file', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const sessionPath = sessionResult.session.metadata?.path
        if (!sessionPath) {
            return c.json({ success: false, error: 'Session path not available' })
        }

        const parsed = filePathSchema.safeParse(c.req.query())
        if (!parsed.success) {
            return c.json({ error: 'Invalid file path' }, 400)
        }

        const result = await runRpc(() => engine.readSessionFile(sessionResult.sessionId, parsed.data.path))
        return c.json(result)
    })

    app.put('/sessions/:id/file', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) return engine

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) return sessionResult

        const parsed = writeFileSchema.safeParse(await c.req.json())
        if (!parsed.success) {
            return c.json({ error: 'Invalid file write request' }, 400)
        }

        const result = await runRpc(() => engine.writeSessionFile(
            sessionResult.sessionId,
            parsed.data.path,
            parsed.data.content,
            parsed.data.expectedHash
        ))
        return c.json(result)
    })

    const verifyOptionalQueryTicket = (
        c: Context<WebAppEnv>,
        sessionId: string,
        kind: GeneratedBlobKind,
        blobId: string
    ): Response | null => {
        const ticket = c.req.query('ticket')
        if (!ticket) return null
        const verified = verifyBlobDownloadTicket(ticket, { sessionId, kind, blobId, now: blobs?.store.now() }, ticketSecret)
        if (!verified.ok) {
            return c.json({
                error: verified.reason === 'expired' ? 'Download ticket expired' : 'Invalid download ticket',
                reason: verified.reason === 'expired' ? 'ticket-expired' : 'invalid-ticket'
            }, 401)
        }
        if (verified.claims.ns !== c.get('namespace')) {
            return c.json({ error: 'Session access denied', reason: 'access-denied' }, 403)
        }
        return null
    }

    const handleGeneratedImage = async (c: Context<WebAppEnv>): Promise<Response> => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const parsed = generatedImageSchema.safeParse(c.req.param())
        if (!parsed.success) {
            return c.json({ error: 'Invalid generated image id' }, 400)
        }

        const ticketError = verifyOptionalQueryTicket(c, c.req.param('id') ?? '', 'image', parsed.data.imageId)
        if (ticketError) {
            return ticketError
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        // The id is an immutable content fingerprint, so it doubles as the ETag. If the client
        // already holds it, answer 304 *before* the RPC so revalidation skips the CLI round-trip
        // entirely (and still works even if the image was evicted from CLI memory). Issue #927.
        const etag = `"${parsed.data.imageId}"`
        if (ifNoneMatchMatches(c.req.header('if-none-match'), etag)) {
            if (blobs) {
                const existing = blobs.store.stat('image', parsed.data.imageId)
                if (existing && existing.sessionId !== null && existing.sessionId !== sessionResult.sessionId) {
                    return c.json({
                        success: false,
                        error: 'Blob belongs to another session',
                        reason: 'access-denied',
                        retryable: false
                    }, 403)
                }
            }
            return c.body(null, 304, {
                'Cache-Control': GENERATED_IMAGE_CACHE_CONTROL,
                ETag: etag
            })
        }

        // Generated images are content-addressed by an immutable random id, so the bytes for a
        // given id never change. Cache aggressively so remounts/scroll/session reopen don't
        // re-run the full HTTP -> socket.io RPC -> base64 round-trip every time (issue #927).
        const serve: GeneratedBlobServeOptions = {
            sessionId: sessionResult.sessionId,
            kind: 'image',
            id: parsed.data.imageId,
            etag,
            disposition: 'inline',
            fallbackFileName: 'generated-image',
            notFoundMessage: 'Generated image not found',
            legacyRead: () => engine.readGeneratedImage(sessionResult.sessionId, parsed.data.imageId)
        }
        return blobs
            ? await serveGeneratedBlob(c, engine, blobs, serve)
            : await serveGeneratedBlobDirect(c, engine, serve)
    }

    app.get('/sessions/:id/generated-images/:imageId', handleGeneratedImage)
    app.on('HEAD', '/sessions/:id/generated-images/:imageId', handleGeneratedImage)

    const handleGeneratedFile = async (c: Context<WebAppEnv>): Promise<Response> => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const parsed = generatedFileSchema.safeParse(c.req.param())
        if (!parsed.success) {
            return c.json({ error: 'Invalid generated file id' }, 400)
        }

        const ticketError = verifyOptionalQueryTicket(c, c.req.param('id') ?? '', 'file', parsed.data.fileId)
        if (ticketError) {
            return ticketError
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        // Sent files are disk snapshots keyed by an immutable random id, so the same
        // caching strategy as generated images applies (see the route above).
        const etag = `"${parsed.data.fileId}"`
        if (ifNoneMatchMatches(c.req.header('if-none-match'), etag)) {
            if (blobs) {
                const existing = blobs.store.stat('file', parsed.data.fileId)
                if (existing && existing.sessionId !== null && existing.sessionId !== sessionResult.sessionId) {
                    return c.json({
                        success: false,
                        error: 'Blob belongs to another session',
                        reason: 'access-denied',
                        retryable: false
                    }, 403)
                }
            }
            return c.body(null, 304, {
                'Cache-Control': GENERATED_IMAGE_CACHE_CONTROL,
                ETag: etag
            })
        }

        const serve: GeneratedBlobServeOptions = {
            sessionId: sessionResult.sessionId,
            kind: 'file',
            id: parsed.data.fileId,
            etag,
            disposition: 'attachment',
            fallbackFileName: 'file',
            notFoundMessage: 'Sent file not found',
            legacyRead: () => engine.readGeneratedFile(sessionResult.sessionId, parsed.data.fileId)
        }
        return blobs
            ? await serveGeneratedBlob(c, engine, blobs, serve)
            : await serveGeneratedBlobDirect(c, engine, serve)
    }

    app.get('/sessions/:id/generated-files/:fileId', handleGeneratedFile)
    app.on('HEAD', '/sessions/:id/generated-files/:fileId', handleGeneratedFile)

    const handleDownloadTicket = async (c: Context<WebAppEnv>, kind: GeneratedBlobKind, blobId: string): Promise<Response> => {
        if (!blobs) {
            return c.json({ success: false, error: 'Blob storage is not enabled on this hub', reason: 'unsupported' }, 501)
        }
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }
        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }
        const resolved = await resolveStoredOrFetchedBlob(c, engine, blobs, {
            sessionId: sessionResult.sessionId,
            kind,
            id: blobId
        })
        if (!resolved.ok) {
            return resolved.response
        }
        const deliveryMeta = c.get('deliveryMetadata')
        const gatewayAccountId = deliveryMeta && typeof deliveryMeta.gatewayAccountId === 'number'
            ? deliveryMeta.gatewayAccountId
            : undefined
        const issued = issueBlobDownloadTicket({
            sessionId: sessionResult.sessionId,
            kind,
            blobId,
            namespace: c.get('namespace') ?? 'default',
            userId: c.get('userId') ?? 0,
            ...(gatewayAccountId !== undefined ? { gatewayAccountId } : {}),
            ttlMs: blobs.ticketTtlMs,
            now: blobs.store.now()
        }, ticketSecret)
        const routeSegment = kind === 'file' ? 'generated-files' : 'generated-images'
        const downloadPath = `/api/sessions/${encodeURIComponent(sessionResult.sessionId)}/${routeSegment}/${encodeURIComponent(blobId)}?ticket=${encodeURIComponent(issued.ticket)}`
        const body: GeneratedBlobDownloadTicketResponse = {
            success: true,
            state: 'ready',
            ticket: issued.ticket,
            downloadPath,
            expiresAt: issued.expiresAt,
            fileName: resolved.record.fileName || (kind === 'file' ? 'file' : 'generated-image'),
            mimeType: resolved.record.mimeType,
            size: resolved.record.size
        }
        return c.json(body, 200, { 'Cache-Control': 'no-store' })
    }

    app.post('/sessions/:id/generated-files/:fileId/download-ticket', async (c) => {
        const parsed = generatedFileSchema.safeParse(c.req.param())
        if (!parsed.success) {
            return c.json({ error: 'Invalid generated file id' }, 400)
        }
        return await handleDownloadTicket(c, 'file', parsed.data.fileId)
    })

    app.post('/sessions/:id/generated-images/:imageId/download-ticket', async (c) => {
        const parsed = generatedImageSchema.safeParse(c.req.param())
        if (!parsed.success) {
            return c.json({ error: 'Invalid generated image id' }, 400)
        }
        return await handleDownloadTicket(c, 'image', parsed.data.imageId)
    })

    type HubP2pTransferRecord = {
        transferId: string
        sessionId: string
        kind: GeneratedBlobKind
        blobId: string
        namespace: string
        userId: number
        gatewayAccountId?: number
        authToken: string
        expiresAt: number
    }

    const hubP2pTransfers = new Map<string, HubP2pTransferRecord>()

    const p2pSignalBodySchema = z.object({
        action: z.enum(['signal', 'cancel', 'complete', 'renew']).default('signal'),
        answer: z.object({
            type: z.literal('answer'),
            sdp: z.string().min(1).max(65_536)
        }).optional(),
        candidates: z.array(z.object({
            candidate: z.string().min(1).max(1024),
            sdpMid: z.string().max(64).nullish(),
            sdpMLineIndex: z.number().int().min(0).max(32).nullish()
        })).max(32).optional(),
        reason: z.string().max(256).optional()
    })

    function resolveConfiguredStunServers(): Array<{ urls: string | string[] }> {
        const raw = process.env.HAPI_P2P_STUN_URLS?.trim()
        if (!raw) return []
        const urls = raw
            .split(',')
            .map((entry) => entry.trim())
            .filter((entry) => entry.startsWith('stun:'))
        return urls.length > 0 ? [{ urls }] : []
    }

    app.post('/sessions/:id/generated-files/:fileId/p2p', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }
        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }
        const parsed = generatedFileSchema.safeParse(c.req.param())
        if (!parsed.success || !isSafeBlobId(parsed.data.fileId)) {
            return c.json({ error: 'Invalid generated file id' }, 400)
        }
        const fileId = parsed.data.fileId
        const existingRecord = blobs?.store.stat('file', fileId) ?? null
        if (existingRecord && existingRecord.sessionId !== null && existingRecord.sessionId !== sessionResult.sessionId) {
            return c.json({
                success: false,
                error: 'Blob belongs to another session',
                reason: 'access-denied',
                retryable: false
            }, 403)
        }
        const hubReady = existingRecord?.state === 'ready'
        const now = blobs?.store.now() ?? Date.now()
        for (const [id, record] of hubP2pTransfers) {
            if (now >= record.expiresAt) {
                hubP2pTransfers.delete(id)
            }
        }

        if (typeof engine.prepareP2pFileTransfer !== 'function') {
            const unavailable: CreateP2pFileTransferResponse = {
                success: false,
                p2pAvailable: false,
                reason: 'unsupported',
                error: 'P2P transfer is not available on this hub',
                hubReady
            }
            return c.json(unavailable, 200, { 'Cache-Control': 'no-store' })
        }

        const transferId = randomUUID()
        const authToken = randomBytes(24).toString('base64url')
        const expiresAt = now + P2P_TRANSFER_TTL_MS
        const iceServers = resolveConfiguredStunServers()

        try {
            const prepared = await engine.prepareP2pFileTransfer(sessionResult.sessionId, {
                transferId,
                authToken,
                kind: 'file',
                id: fileId,
                expiresAt,
                iceServers
            })
            if (!prepared.success) {
                const unavailable: CreateP2pFileTransferResponse = {
                    success: false,
                    p2pAvailable: false,
                    reason: prepared.reason,
                    error: prepared.error,
                    hubReady
                }
                return c.json(unavailable, 200, { 'Cache-Control': 'no-store' })
            }

            const deliveryMeta = c.get('deliveryMetadata')
            const gatewayAccountId = deliveryMeta && typeof deliveryMeta.gatewayAccountId === 'number'
                ? deliveryMeta.gatewayAccountId
                : undefined
            hubP2pTransfers.set(transferId, {
                transferId,
                sessionId: sessionResult.sessionId,
                kind: 'file',
                blobId: fileId,
                namespace: c.get('namespace') ?? 'default',
                userId: c.get('userId') ?? 0,
                ...(gatewayAccountId !== undefined ? { gatewayAccountId } : {}),
                authToken,
                expiresAt
            })

            const response: CreateP2pFileTransferResponse = {
                success: true,
                p2pAvailable: true,
                transferId,
                authToken,
                expiresAt,
                hubReady,
                offer: prepared.offer,
                candidates: prepared.candidates,
                manifest: prepared.manifest,
                iceServers,
                candidateTypes: prepared.candidateTypes
            }
            return c.json(response, 200, { 'Cache-Control': 'no-store' })
        } catch (error) {
            const failure = classifyBlobError(error)
            const unavailable: CreateP2pFileTransferResponse = {
                success: false,
                p2pAvailable: false,
                reason: failure.kind === 'offline' ? 'session-offline' : 'failed',
                error: failure.message,
                hubReady
            }
            return c.json(unavailable, 200, { 'Cache-Control': 'no-store' })
        }
    })

    app.post('/sessions/:id/generated-files/:fileId/p2p/:transferId/signal', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }
        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }
        const fileId = c.req.param('fileId')
        const transferId = c.req.param('transferId')
        if (!fileId || !isSafeBlobId(fileId) || !transferId) {
            return c.json({ error: 'Invalid transfer reference' }, 400)
        }
        const record = hubP2pTransfers.get(transferId)
        const now = blobs?.store.now() ?? Date.now()
        if (!record || now >= record.expiresAt) {
            hubP2pTransfers.delete(transferId)
            return c.json({ success: false, error: 'P2P transfer session expired or not found', reason: 'expired' }, 410)
        }
        const deliveryMeta = c.get('deliveryMetadata')
        const gatewayAccountId = deliveryMeta && typeof deliveryMeta.gatewayAccountId === 'number'
            ? deliveryMeta.gatewayAccountId
            : undefined
        if (
            record.sessionId !== sessionResult.sessionId
            || record.blobId !== fileId
            || record.namespace !== (c.get('namespace') ?? 'default')
            || record.userId !== (c.get('userId') ?? 0)
            || (record.gatewayAccountId !== undefined && record.gatewayAccountId !== gatewayAccountId)
        ) {
            return c.json({ success: false, error: 'Transfer access denied', reason: 'access-denied' }, 403)
        }

        const rawBody = await c.req.json().catch(() => ({}))
        const parsedBody = p2pSignalBodySchema.safeParse(rawBody)
        if (!parsedBody.success) {
            return c.json({ success: false, error: 'Invalid P2P signal payload' }, 400)
        }
        const { action, answer, candidates, reason } = parsedBody.data

        if (action === 'cancel' || action === 'complete') {
            hubP2pTransfers.delete(transferId)
            if (typeof engine.signalP2pFileTransfer === 'function') {
                await engine.signalP2pFileTransfer(sessionResult.sessionId, {
                    transferId,
                    action,
                    reason
                }).catch(() => {})
            }
            return c.json({ success: true })
        }

        if (action === 'renew') {
            record.expiresAt = now + P2P_TRANSFER_TTL_MS
            if (typeof engine.signalP2pFileTransfer === 'function') {
                await engine.signalP2pFileTransfer(sessionResult.sessionId, {
                    transferId,
                    action: 'renew',
                    expiresAt: record.expiresAt
                }).catch(() => {})
            }
            return c.json({ success: true, expiresAt: record.expiresAt })
        }

        if (typeof engine.signalP2pFileTransfer !== 'function') {
            return c.json({ success: false, error: 'P2P signaling not supported' }, 501)
        }

        try {
            const result = await engine.signalP2pFileTransfer(sessionResult.sessionId, {
                transferId,
                action: 'signal',
                answer,
                candidates
            })
            if (!result.success) {
                return c.json(result, 400)
            }
            return c.json(result, 200, { 'Cache-Control': 'no-store' })
        } catch (error) {
            const failure = classifyBlobError(error)
            return blobFailureResponse(c, failure)
        }
    })

    app.get('/sessions/:id/files', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const sessionPath = sessionResult.session.metadata?.path
        if (!sessionPath) {
            return c.json({ success: false, error: 'Session path not available' })
        }

        const parsed = fileSearchSchema.safeParse(c.req.query())
        if (!parsed.success) {
            return c.json({ error: 'Invalid query' }, 400)
        }

        const query = normalizeFileSearchQuery(parsed.data.query?.trim() ?? '', sessionPath)
        const limit = parsed.data.limit ?? 200
        const args = ['--files']
        if (query) {
            args.push('--iglob', `*${query}*`)
        }

        const result = await runRpc(() => engine.runRipgrep(sessionResult.sessionId, args, sessionPath))
        if (!result.success) {
            return c.json({ success: false, error: result.error ?? 'Failed to list files' })
        }

        const stdout = result.stdout ?? ''
        const normalizePath = isWindowsSessionPath(sessionPath)
            ? normalizeFileSearchPath
            : (path: string) => path
        const paths = stdout
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
            .map(normalizePath)
            .slice(0, limit)

        const metadataResult = await runRpc(() => engine.statFiles(sessionResult.sessionId, paths))
        const metadataByPath = new Map(
            metadataResult.success
                ? (metadataResult.entries ?? []).map((entry) => [entry.path, entry] as const)
                : []
        )

        const files = paths.map((fullPath) => {
            const parts = fullPath.split('/')
            const fileName = parts[parts.length - 1] || fullPath
            const filePath = parts.slice(0, -1).join('/')
            const metadata = metadataByPath.get(fullPath)
            return {
                fileName,
                filePath,
                fullPath,
                fileType: 'file' as const,
                size: metadata?.size,
                modified: metadata?.modified
            }
        })

        return c.json({ success: true, files })
    })

    app.get('/sessions/:id/directory', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const sessionPath = sessionResult.session.metadata?.path
        if (!sessionPath) {
            return c.json({ success: false, error: 'Session path not available' })
        }

        const parsed = directorySchema.safeParse(c.req.query())
        if (!parsed.success) {
            return c.json({ error: 'Invalid query' }, 400)
        }

        const path = parsed.data.path ?? ''
        const result = await runRpc(() => engine.listDirectory(sessionResult.sessionId, path))
        return c.json(result)
    })

    return app
}
