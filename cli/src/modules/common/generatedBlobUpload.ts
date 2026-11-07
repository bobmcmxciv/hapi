import type { GeneratedBlobKind, GeneratedBlobUploadResponse } from '@hapi/protocol/apiTypes'
import {
    GENERATED_BLOB_UPLOAD_CHUNK_BYTES,
    MAX_GENERATED_BLOB_UPLOAD_CHUNK_BYTES,
    MIN_GENERATED_BLOB_UPLOAD_CHUNK_BYTES
} from '@hapi/protocol/socketLimits'
import { logger } from '@/ui/logger'

/**
 * Push generated blobs (sent files, inline images/videos) to the hub as soon as
 * they are registered, so viewers download from the hub's disk instead of
 * pulling the bytes back through this machine's uplink on every open.
 *
 * Runs as a background queue, one blob at a time (a slow uplink is a shared
 * resource; two uploads at once only make both slower), in offset-addressed
 * slices over plain HTTP. A dropped connection resumes from the offset the hub
 * reports rather than starting over. The session's socket.io connection is not
 * involved, so a large transfer can no longer starve the heartbeat.
 */

export type GeneratedBlobSource = {
    size: number
    mimeType: string
    fileName: string
    read(offset: number, length: number): Promise<Uint8Array>
    sha256(): Promise<string>
}

export type GeneratedBlobSourceProvider = {
    open(id: string): Promise<GeneratedBlobSource | null>
    /** Called once the hub holds the whole blob; lets a store skip re-uploads after a restart. */
    markUploaded?(id: string): Promise<void>
}

export type GeneratedBlobUploaderConfig = {
    sessionId: string
    apiUrl: string
    token: string
    extraHeaders?: Record<string, string>
    fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
    chunkBytes?: number
    /** Allow a bounded fast lane for single-chunk small blobs while a multi-chunk blob is uploading (default true). */
    enableSmallBlobFastLane?: boolean
    /** Consecutive transport failures tolerated before the blob is left for a later resume. */
    maxAttempts?: number
    baseDelayMs?: number
    maxDelayMs?: number
    requestTimeoutMs?: number
}

export type GeneratedBlobUploadOutcome = 'ready' | 'skipped' | 'unsupported' | 'rejected' | 'failed'

/** Operator escape hatch: leave blobs on this machine and let the hub pull
 *  them on demand (the pre-push behaviour). Also what the e2e uses to exercise
 *  the pull path against a real hub. */
export function isGeneratedBlobPushDisabled(): boolean {
    const raw = process.env.HAPI_DISABLE_BLOB_PUSH
    return raw === '1' || raw === 'true'
}

const providers = new Map<GeneratedBlobKind, GeneratedBlobSourceProvider>()
let config: GeneratedBlobUploaderConfig | null = null

type QueueItem = { kind: GeneratedBlobKind; id: string; resolve: (outcome: GeneratedBlobUploadOutcome) => void }
const queue: QueueItem[] = []
const queued = new Set<string>()
let draining: Promise<void> | null = null
let fastLaneDraining: Promise<void> | null = null
let activeLargeUploads = 0

export function resolveUploadChunkBytes(configured?: number): number {
    if (typeof configured === 'number' && Number.isFinite(configured) && configured > 0) {
        return Math.max(1, Math.min(Math.floor(configured), MAX_GENERATED_BLOB_UPLOAD_CHUNK_BYTES))
    }
    const envRaw = process.env.HAPI_BLOB_UPLOAD_CHUNK_BYTES
    if (envRaw) {
        const parsed = Number.parseInt(envRaw, 10)
        if (Number.isFinite(parsed) && parsed > 0) {
            return Math.max(
                MIN_GENERATED_BLOB_UPLOAD_CHUNK_BYTES,
                Math.min(parsed, MAX_GENERATED_BLOB_UPLOAD_CHUNK_BYTES)
            )
        }
    }
    return GENERATED_BLOB_UPLOAD_CHUNK_BYTES
}
export function registerGeneratedBlobSource(kind: GeneratedBlobKind, provider: GeneratedBlobSourceProvider): void {
    providers.set(kind, provider)
}

/** Bind the uploader to this process's session. Pass `null` to disable (tests). */
export function configureGeneratedBlobUploader(next: GeneratedBlobUploaderConfig | null): void {
    config = next
}

export function getGeneratedBlobUploaderSessionId(): string | null {
    return config?.sessionId ?? null
}

/**
 * Queue a blob for upload. Fire-and-forget: registration must not wait on the
 * network. Returns a promise that settles with the outcome for callers (tests,
 * shutdown hooks) that want to wait.
 */
export function scheduleGeneratedBlobUpload(kind: GeneratedBlobKind, id: string): Promise<GeneratedBlobUploadOutcome> {
    if (!config || isGeneratedBlobPushDisabled()) {
        return Promise.resolve('skipped')
    }
    const key = `${kind}:${id}`
    if (queued.has(key)) {
        return Promise.resolve('skipped')
    }
    queued.add(key)
    return new Promise<GeneratedBlobUploadOutcome>((resolve) => {
        queue.push({ kind, id, resolve })
        ensureDraining()
    })
}

function ensureDraining(): void {
    if (!draining) {
        draining = drainPrimary().finally(() => {
            draining = null
        })
    }
    if (
        activeLargeUploads > 0
        && !fastLaneDraining
        && config?.enableSmallBlobFastLane !== false
    ) {
        fastLaneDraining = drainSmallFastLane().finally(() => {
            fastLaneDraining = null
        })
    }
}

/**
 * Resolves once every queued upload has been attempted, or after `timeoutMs`.
 * Returns whether the queue is empty. Exit paths call this so a one-shot
 * session does not vanish with a half-sent file; a bounded wait keeps handoffs
 * snappy, and whatever is left resumes in the next process of the session.
 */
export async function waitForGeneratedBlobUploads(options: { timeoutMs?: number } = {}): Promise<boolean> {
    const deadline = options.timeoutMs === undefined ? null : Date.now() + options.timeoutMs
    while (draining || fastLaneDraining) {
        const active = Promise.all([draining, fastLaneDraining].filter(Boolean))
        if (deadline !== null) {
            const remaining = deadline - Date.now()
            if (remaining <= 0) return false
            const { promise: timeout, resolve: resolveTimeout } = Promise.withResolvers<'timeout'>()
            setTimeout(() => resolveTimeout('timeout'), remaining)
            const result = await Promise.race([active.then(() => 'drained' as const), timeout])
            if (result === 'timeout') return false
        } else {
            await active
        }
    }
    return true
}

/** Whether any upload is queued or in flight right now. */
export function hasPendingGeneratedBlobUploads(): boolean {
    return draining !== null || fastLaneDraining !== null
}

async function peekBlobSize(item: QueueItem): Promise<number | null> {
    const provider = providers.get(item.kind)
    if (!provider) return null
    try {
        const source = await provider.open(item.id)
        return source ? source.size : null
    } catch {
        return null
    }
}

async function takeNextItem(onlySmallMaxBytes?: number): Promise<QueueItem | null> {
    if (queue.length === 0) return null
    if (onlySmallMaxBytes !== undefined) {
        for (let i = 0; i < queue.length; i += 1) {
            const size = await peekBlobSize(queue[i])
            if (size !== null && size <= onlySmallMaxBytes) {
                return queue.splice(i, 1)[0] ?? null
            }
        }
        return null
    }
    if (queue.length > 1) {
        const chunkBytes = resolveUploadChunkBytes(config?.chunkBytes)
        for (let i = 0; i < queue.length; i += 1) {
            const size = await peekBlobSize(queue[i])
            if (size !== null && size <= chunkBytes) {
                return queue.splice(i, 1)[0] ?? null
            }
        }
    }
    return queue.shift() ?? null
}

async function runQueueItem(item: QueueItem): Promise<void> {
    let outcome: GeneratedBlobUploadOutcome = 'failed'
    try {
        outcome = config ? await uploadGeneratedBlob(item.kind, item.id, config) : 'skipped'
    } catch (error) {
        logger.debug('[blobUpload] Unexpected upload failure:', item.kind, item.id, error instanceof Error ? error.message : String(error))
    } finally {
        queued.delete(`${item.kind}:${item.id}`)
    }
    item.resolve(outcome)
}

async function drainPrimary(): Promise<void> {
    for (;;) {
        const item = await takeNextItem()
        if (!item) break
        await runQueueItem(item)
    }
}

async function drainSmallFastLane(): Promise<void> {
    while (activeLargeUploads > 0 && queue.length > 0 && config?.enableSmallBlobFastLane !== false) {
        const chunkBytes = resolveUploadChunkBytes(config?.chunkBytes)
        const item = await takeNextItem(chunkBytes)
        if (!item) break
        await runQueueItem(item)
    }
}


const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

async function requestWithTimeout(
    doFetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
    url: string,
    init: RequestInit,
    timeoutMs: number
): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
        return await doFetch(url, { ...init, signal: controller.signal })
    } finally {
        clearTimeout(timer)
    }
}

async function readJson(response: Response): Promise<GeneratedBlobUploadResponse | null> {
    try {
        return await response.json() as GeneratedBlobUploadResponse
    } catch {
        return null
    }
}

/**
 * Upload one blob end to end. Exported for tests; production goes through the
 * queue. Never throws for expected conditions — the outcome says what happened.
 */
export async function uploadGeneratedBlob(
    kind: GeneratedBlobKind,
    id: string,
    cfg: GeneratedBlobUploaderConfig
): Promise<GeneratedBlobUploadOutcome> {
    const provider = providers.get(kind)
    if (!provider) {
        return 'skipped'
    }
    const source = await provider.open(id)
    if (!source) {
        logger.debug('[blobUpload] Nothing to upload for', kind, id)
        return 'skipped'
    }

    const doFetch = cfg.fetch ?? fetch
    const chunkBytes = resolveUploadChunkBytes(cfg.chunkBytes)
    const maxAttempts = cfg.maxAttempts ?? 12
    const baseDelayMs = cfg.baseDelayMs ?? 1000
    const maxDelayMs = cfg.maxDelayMs ?? 30_000
    const requestTimeoutMs = cfg.requestTimeoutMs ?? 180_000
    const base = cfg.apiUrl.replace(/\/+$/, '')
    const url = `${base}/cli/sessions/${encodeURIComponent(cfg.sessionId)}/blobs/${kind}/${encodeURIComponent(id)}`
    const sha256 = await source.sha256()
    const headers: Record<string, string> = {
        ...(cfg.extraHeaders ?? {}),
        Authorization: `Bearer ${cfg.token}`,
        'x-blob-size': String(source.size),
        'x-blob-mime': source.mimeType,
        'x-blob-name': encodeURIComponent(source.fileName),
        'x-blob-sha256': sha256
    }

    let received = 0
    let attempts = 0
    let restarted = false
    let statusKnown = false

    const finish = async (): Promise<GeneratedBlobUploadOutcome> => {
        try {
            await provider.markUploaded?.(id)
        } catch {
            // best effort
        }
        logger.debug('[blobUpload] Uploaded', kind, id, `${source.size} bytes`)
        return 'ready'
    }

    const backoff = async (why: string): Promise<boolean> => {
        attempts += 1
        if (attempts > maxAttempts) {
            logger.debug('[blobUpload] Giving up on', kind, id, 'after', attempts - 1, 'transport failures:', why)
            return false
        }
        const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempts - 1))
        logger.debug('[blobUpload] Retrying', kind, id, 'in', delay, 'ms:', why)
        await sleep(delay)
        return true
    }

    const isMultiChunk = source.size > chunkBytes
    if (isMultiChunk) {
        activeLargeUploads += 1
        ensureDraining()
    }
    try {
    for (;;) {
        // Ask the hub where it is before the first slice (and after a hiccup), so
        // a restarted process resumes instead of re-sending what already landed.
        if (!statusKnown) {
            try {
                const status = await requestWithTimeout(doFetch, url, { method: 'GET', headers: { ...(cfg.extraHeaders ?? {}), Authorization: `Bearer ${cfg.token}` } }, requestTimeoutMs)
                if (status.status === 501) return 'unsupported'
                if (status.status === 401 || status.status === 403 || status.status === 404) {
                    logger.debug('[blobUpload] Hub refused blob status', status.status, 'for', kind, id)
                    return 'rejected'
                }
                if (status.ok) {
                    const body = await readJson(status)
                    if (body?.state === 'ready') return await finish()
                    if (body?.state === 'uploading' && typeof body.received === 'number' && body.size === source.size) {
                        received = body.received
                    }
                    statusKnown = true
                } else if (!(await backoff(`status ${status.status}`))) {
                    return 'failed'
                }
            } catch (error) {
                if (!(await backoff(error instanceof Error ? error.message : String(error)))) {
                    return 'failed'
                }
            }
            continue
        }

        const length = Math.min(chunkBytes, source.size - received)
        const slice = await source.read(received, length)
        let response: Response
        try {
            response = await requestWithTimeout(doFetch, `${url}?offset=${received}`, {
                method: 'PUT',
                headers: { ...headers, 'content-type': 'application/octet-stream' },
                body: slice
            }, requestTimeoutMs)
        } catch (error) {
            statusKnown = false
            if (!(await backoff(error instanceof Error ? error.message : String(error)))) {
                return 'failed'
            }
            continue
        }

        if (response.ok) {
            const body = await readJson(response)
            attempts = 0
            if (body?.state === 'ready') {
                return await finish()
            }
            received = typeof body?.received === 'number' ? body.received : received + slice.byteLength
            if (received >= source.size) {
                // The hub had every byte but did not say ready: re-check rather than loop.
                statusKnown = false
            }
            continue
        }

        if (response.status === 409) {
            const body = await readJson(response)
            if (body?.reason === 'size-mismatch') {
                logger.debug('[blobUpload] Hub holds a different-sized blob for', kind, id)
                return 'rejected'
            }
            received = typeof body?.received === 'number' ? body.received : 0
            attempts = 0
            continue
        }
        if (response.status === 422) {
            if (restarted) {
                logger.debug('[blobUpload] Checksum rejected twice for', kind, id)
                return 'rejected'
            }
            restarted = true
            received = 0
            continue
        }
        if (response.status === 501) return 'unsupported'
        if (response.status === 400 || response.status === 401 || response.status === 403 || response.status === 404 || response.status === 413 || response.status === 507) {
            logger.debug('[blobUpload] Hub rejected upload', response.status, 'for', kind, id)
            return 'rejected'
        }
        statusKnown = false
        if (!(await backoff(`HTTP ${response.status}`))) {
            return 'failed'
        }
    }
    } finally {
        if (isMultiChunk) {
            activeLargeUploads = Math.max(0, activeLargeUploads - 1)
        }
    }
}

/** Test-only: forget queue state and providers. */
export function resetGeneratedBlobUploaderForTests(): void {
    queue.length = 0
    queued.clear()
    activeLargeUploads = 0
    config = null
}
