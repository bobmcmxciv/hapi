import { Hono } from 'hono'
import type { Context } from 'hono'
import { z } from 'zod'
import type { GeneratedBlobChunkResponse, GeneratedBlobKind } from '@hapi/protocol/apiTypes'
import { GENERATED_BLOB_CHUNK_BYTES } from '@hapi/protocol/socketLimits'
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

function normalizeFileSearchPath(path: string): string {
    return path.replaceAll('\\', '/')
}

function isWindowsSessionPath(path: string): boolean {
    return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')
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
// default 30 s budget. On the production hub between 2026-08-01 and 08-12 that
// lost 52 downloads: each returned `404 "not found"` after exactly `30s`, so a
// perfectly present 14 MB file was reported as missing. Successful transfers of
// the same size were already taking 21–22 s, i.e. the failures were the slow
// tail of a normal distribution, not an anomaly.
//
// The transfer is now a sequence of `GENERATED_BLOB_CHUNK_BYTES` slices: each
// slice has its own budget, is retried on its own, and is written to the
// response as soon as it lands. A stalled slice costs a retry instead of the
// whole download, and the client sees bytes flowing rather than a dead socket.

const BLOB_CHUNK_RETRIES = 3
const BLOB_CHUNK_RETRY_DELAY_MS = 750

type BlobFailure =
    | { kind: 'offline'; message: string }
    | { kind: 'timeout'; message: string }
    | { kind: 'not-found'; message: string }

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
    return c.json({ success: false, error: failure.message, reason: 'not-found', retryable: false }, 404)
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

/**
 * Serve a sent file or a generated image over the chunked path, falling back to
 * the legacy whole-blob RPC when the CLI is too old to expose chunked reads.
 *
 * Range requests are honoured because they are the client-side half of the same
 * reliability story: a download that dies at 80% can now ask for the remaining
 * 20% instead of starting over.
 */
async function serveGeneratedBlob(
    c: Context<WebAppEnv>,
    engine: SyncEngine,
    options: {
        sessionId: string
        kind: GeneratedBlobKind
        id: string
        etag: string
        disposition: 'inline' | 'attachment'
        fallbackFileName: string
        notFoundMessage: string
        legacyRead: () => Promise<{ success: boolean; content?: string; mimeType?: string; fileName?: string; error?: string }>
    }
) {
    const { sessionId, kind, id, etag, disposition, fallbackFileName, legacyRead } = options
    const read: ChunkReader = (offset, length) =>
        engine.readGeneratedBlobChunk(sessionId, { kind, id, offset, length })

    // Two ways chunking can be unavailable: this hub is talking to a CLI that
    // predates the RPC method (no handler registered), or the engine itself
    // does not expose it. Both fall back to the whole-blob read.
    const chunkCapable = typeof engine.readGeneratedBlobChunk === 'function'
    const head = chunkCapable
        ? await readChunkWithRetry(read, 0, GENERATED_BLOB_CHUNK_BYTES)
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
            'Content-Disposition': `${disposition}; filename="${encodeURIComponent(legacy.fileName ?? fallbackFileName)}"`,
            'Content-Length': String(bytes.byteLength),
            'Cache-Control': GENERATED_IMAGE_CACHE_CONTROL,
            ETag: etag
        })
    }

    if (!head.ok) {
        return blobFailureResponse(c, head.failure)
    }

    const first = head.response
    const size = typeof first.size === 'number' && first.size >= 0
        ? first.size
        : Buffer.byteLength(first.content ?? '', 'base64')
    const mimeType = first.mimeType ?? 'application/octet-stream'
    const fileName = first.fileName ?? fallbackFileName
    const baseHeaders: Record<string, string> = {
        'Content-Type': mimeType,
        'Content-Disposition': `${disposition}; filename="${encodeURIComponent(fileName)}"`,
        'Cache-Control': GENERATED_IMAGE_CACHE_CONTROL,
        // Advertised so browsers and download managers know a failed transfer
        // can be resumed rather than restarted.
        'Accept-Ranges': 'bytes',
        ETag: etag
    }

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
                    const want = Math.min(GENERATED_BLOB_CHUNK_BYTES, end - cursor + 1)
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

export function createGitRoutes(getSyncEngine: () => SyncEngine | null): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

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

    app.get('/sessions/:id/generated-images/:imageId', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const parsed = generatedImageSchema.safeParse(c.req.param())
        if (!parsed.success) {
            return c.json({ error: 'Invalid generated image id' }, 400)
        }

        // The id is an immutable content fingerprint, so it doubles as the ETag. If the client
        // already holds it, answer 304 *before* the RPC so revalidation skips the CLI round-trip
        // entirely (and still works even if the image was evicted from CLI memory). Issue #927.
        const etag = `"${parsed.data.imageId}"`
        if (ifNoneMatchMatches(c.req.header('if-none-match'), etag)) {
            return c.body(null, 304, {
                'Cache-Control': GENERATED_IMAGE_CACHE_CONTROL,
                ETag: etag
            })
        }

        // Generated images are content-addressed by an immutable random id, so the bytes for a
        // given id never change. Cache aggressively so remounts/scroll/session reopen don't
        // re-run the full HTTP -> socket.io RPC -> base64 round-trip every time (issue #927).
        return await serveGeneratedBlob(c, engine, {
            sessionId: sessionResult.sessionId,
            kind: 'image',
            id: parsed.data.imageId,
            etag,
            disposition: 'inline',
            fallbackFileName: 'generated-image',
            notFoundMessage: 'Generated image not found',
            legacyRead: () => engine.readGeneratedImage(sessionResult.sessionId, parsed.data.imageId)
        })
    })

    app.get('/sessions/:id/generated-files/:fileId', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const parsed = generatedFileSchema.safeParse(c.req.param())
        if (!parsed.success) {
            return c.json({ error: 'Invalid generated file id' }, 400)
        }

        // Sent files are disk snapshots keyed by an immutable random id, so the same
        // caching strategy as generated images applies (see the route above).
        const etag = `"${parsed.data.fileId}"`
        if (ifNoneMatchMatches(c.req.header('if-none-match'), etag)) {
            return c.body(null, 304, {
                'Cache-Control': GENERATED_IMAGE_CACHE_CONTROL,
                ETag: etag
            })
        }

        return await serveGeneratedBlob(c, engine, {
            sessionId: sessionResult.sessionId,
            kind: 'file',
            id: parsed.data.fileId,
            etag,
            disposition: 'attachment',
            fallbackFileName: 'file',
            notFoundMessage: 'Sent file not found',
            legacyRead: () => engine.readGeneratedFile(sessionResult.sessionId, parsed.data.fileId)
        })
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

        const query = parsed.data.query?.trim() ?? ''
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
