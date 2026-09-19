import { Hono } from 'hono'
import { z } from 'zod'
import {
    CreateOrLoadMachineRequestSchema,
    CreateOrLoadSessionRequestSchema,
    ClearOpencodeSessionCallbackRequestSchema,
    CursorMigrateToAcpRequestSchema,
    PROTOCOL_VERSION
} from '@hapi/protocol'
import { getConfiguration } from '../../configuration'
import { constantTimeEquals } from '../../utils/crypto'
import { parseAccessToken } from '../../utils/accessToken'
import type { Machine, Session, SyncEngine } from '../../sync/syncEngine'
import type { GeneratedBlobUploadResponse } from '@hapi/protocol/apiTypes'
import { GENERATED_BLOB_UPLOAD_CHUNK_BYTES, MAX_GENERATED_BLOB_BYTES } from '@hapi/protocol/socketLimits'
import {
    BlobChecksumMismatchError,
    BlobOffsetMismatchError,
    BlobSizeMismatchError,
    BlobStorageFullError,
    BlobTooLargeError,
    isBlobKind,
    isSafeBlobId,
    type BlobStore
} from '../../blobs/blobStore'
import { SessionIdentityConflictError } from '../../store/sessions'

const bearerSchema = z.string().regex(/^Bearer\s+(.+)$/i)

const getMessagesQuerySchema = z.object({
    afterSeq: z.coerce.number().int().min(0),
    limit: z.coerce.number().int().min(1).max(200).optional()
})

type CliEnv = {
    Variables: {
        namespace: string
    }
}

function resolveSessionForNamespace(
    engine: SyncEngine,
    sessionId: string,
    namespace: string
): { ok: true; session: Session; sessionId: string } | { ok: false; status: 403 | 404; error: string } {
    const access = engine.resolveSessionAccess(sessionId, namespace)
    if (access.ok) {
        return { ok: true, session: access.session, sessionId: access.sessionId }
    }
    return {
        ok: false,
        status: access.reason === 'access-denied' ? 403 : 404,
        error: access.reason === 'access-denied' ? 'Session access denied' : 'Session not found'
    }
}

function resolveMachineForNamespace(
    engine: SyncEngine,
    machineId: string,
    namespace: string
): { ok: true; machine: Machine } | { ok: false; status: 403 | 404; error: string } {
    const machine = engine.getMachineByNamespace(machineId, namespace)
    if (machine) {
        return { ok: true, machine }
    }
    if (engine.getMachine(machineId)) {
        return { ok: false, status: 403, error: 'Machine access denied' }
    }
    return { ok: false, status: 404, error: 'Machine not found' }
}

function clearErrorStatus(code: string): 403 | 404 | 409 | 500 {
    return code === 'access_denied' ? 403
        : code === 'session_not_found' ? 404
            : code === 'clear_unavailable' ? 409
                : 500
}

/** Largest single upload slice the hub accepts; the CLI sends
 *  `GENERATED_BLOB_UPLOAD_CHUNK_BYTES` and older/newer clients may differ. */
const MAX_BLOB_UPLOAD_SLICE_BYTES = Math.max(4 * 1024 * 1024, GENERATED_BLOB_UPLOAD_CHUNK_BYTES)

const blobUploadQuerySchema = z.object({
    offset: z.coerce.number().int().min(0)
})

export function createCliRoutes(
    getSyncEngine: () => SyncEngine | null,
    resolveExternalNamespace?: (token: string) => string | null,
    deps: { blobStore?: BlobStore } = {}
): Hono<CliEnv> {
    const app = new Hono<CliEnv>()
    const blobStore = deps.blobStore ?? null

    app.use('*', async (c, next) => {
        c.header('X-Hapi-Protocol-Version', String(PROTOCOL_VERSION))

        const raw = c.req.header('authorization')
        if (!raw) {
            return c.json({ error: 'Missing Authorization header' }, 401)
        }

        const parsed = bearerSchema.safeParse(raw)
        if (!parsed.success) {
            return c.json({ error: 'Invalid Authorization header' }, 401)
        }

        const token = parsed.data.replace(/^Bearer\s+/i, '')
        const configuration = getConfiguration()
        const parsedToken = parseAccessToken(token)
        if (!parsedToken || !constantTimeEquals(parsedToken.baseToken, configuration.cliApiToken)) {
            const namespace = resolveExternalNamespace?.(token) ?? null
            if (!namespace) return c.json({ error: 'Invalid token' }, 401)
            c.set('namespace', namespace)
            return await next()
        }

        c.set('namespace', parsedToken.namespace)
        return await next()
    })

    // —— Generated blob push (send_file / display_image) ——————————————————————
    //
    // The CLI pushes a blob's bytes here right after it emits the envelope, in
    // `offset`-addressed slices so a dropped connection resumes instead of
    // restarting. The hub answers the offset it holds on every slice; a 409
    // carries the offset to resume from. Once the bytes are here every viewer
    // is served from the hub's disk and the CLI machine's uplink is out of the
    // loop for good.

    app.get('/sessions/:id/blobs/:kind/:blobId', async (c) => {
        if (!blobStore) {
            return c.json({ success: false, error: 'Blob storage is not enabled on this hub', reason: 'unsupported' }, 501)
        }
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ success: false, error: 'Not ready' }, 503)
        }
        const kind = c.req.param('kind')
        const blobId = c.req.param('blobId')
        if (!isBlobKind(kind) || !isSafeBlobId(blobId)) {
            return c.json({ success: false, error: 'Invalid blob reference' }, 400)
        }
        const access = resolveSessionForNamespace(engine, c.req.param('id'), c.get('namespace'))
        if (!access.ok) {
            return c.json({ success: false, error: access.error }, access.status)
        }
        const record = blobStore.stat(kind, blobId)
        if (!record) {
            return c.json({ success: true, state: 'missing', received: 0, size: null })
        }
        return c.json({ success: true, state: record.state, received: record.received, size: record.size })
    })

    app.put('/sessions/:id/blobs/:kind/:blobId', async (c) => {
        if (!blobStore) {
            return c.json({ success: false, error: 'Blob storage is not enabled on this hub', reason: 'unsupported' }, 501)
        }
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ success: false, error: 'Not ready' }, 503)
        }
        const kind = c.req.param('kind')
        const blobId = c.req.param('blobId')
        if (!isBlobKind(kind) || !isSafeBlobId(blobId)) {
            return c.json({ success: false, error: 'Invalid blob reference' }, 400)
        }
        const access = resolveSessionForNamespace(engine, c.req.param('id'), c.get('namespace'))
        if (!access.ok) {
            return c.json({ success: false, error: access.error }, access.status)
        }
        const query = blobUploadQuerySchema.safeParse(c.req.query())
        if (!query.success) {
            return c.json({ success: false, error: 'Invalid offset' }, 400)
        }
        const size = Number(c.req.header('x-blob-size'))
        if (!Number.isInteger(size) || size < 0) {
            return c.json({ success: false, error: 'Missing or invalid x-blob-size' }, 400)
        }
        if (size > MAX_GENERATED_BLOB_BYTES) {
            const body: GeneratedBlobUploadResponse = { success: false, error: 'Blob too large', reason: 'too-large' }
            return c.json(body, 413)
        }
        const mimeType = c.req.header('x-blob-mime') || 'application/octet-stream'
        let fileName = blobId
        const rawName = c.req.header('x-blob-name')
        if (rawName) {
            try {
                fileName = decodeURIComponent(rawName)
            } catch {
                fileName = rawName
            }
        }
        const sha256Header = c.req.header('x-blob-sha256')
        const sha256 = sha256Header && /^[a-f0-9]{64}$/i.test(sha256Header) ? sha256Header.toLowerCase() : null
        const bytes = new Uint8Array(await c.req.arrayBuffer())
        if (bytes.byteLength > MAX_BLOB_UPLOAD_SLICE_BYTES) {
            const body: GeneratedBlobUploadResponse = { success: false, error: 'Upload slice too large', reason: 'too-large' }
            return c.json(body, 413)
        }
        try {
            const record = await blobStore.append(kind, blobId, {
                sessionId: access.sessionId,
                fileName,
                mimeType,
                size,
                origin: 'push',
                sha256
            }, query.data.offset, bytes)
            const body: GeneratedBlobUploadResponse = { success: true, state: record.state, received: record.received, size: record.size }
            return c.json(body)
        } catch (error) {
            if (error instanceof BlobOffsetMismatchError) {
                const body: GeneratedBlobUploadResponse = { success: false, error: error.message, reason: 'offset-mismatch', received: error.received }
                return c.json(body, 409)
            }
            if (error instanceof BlobSizeMismatchError) {
                const body: GeneratedBlobUploadResponse = { success: false, error: error.message, reason: 'size-mismatch', received: error.received, size: error.expected }
                return c.json(body, 409)
            }
            if (error instanceof BlobChecksumMismatchError) {
                const body: GeneratedBlobUploadResponse = { success: false, error: error.message, reason: 'checksum-mismatch', received: 0 }
                return c.json(body, 422)
            }
            if (error instanceof BlobTooLargeError) {
                const body: GeneratedBlobUploadResponse = { success: false, error: error.message, reason: 'too-large' }
                return c.json(body, 413)
            }
            if (error instanceof BlobStorageFullError) {
                const body: GeneratedBlobUploadResponse = { success: false, error: error.message, reason: 'insufficient-storage' }
                return c.json(body, 507)
            }
            const message = error instanceof Error ? error.message : String(error)
            return c.json({ success: false, error: message }, 500)
        }
    })

    app.post('/sessions', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not ready' }, 503)
        }
        const json = await c.req.json().catch(() => null)
        const parsed = CreateOrLoadSessionRequestSchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        const namespace = c.get('namespace')
        const machineInput = parsed.data.machine
        if (machineInput) {
            const existingMachine = engine.getMachine(machineInput.id)
            if (existingMachine && existingMachine.namespace !== namespace) {
                return c.json({ error: 'Machine access denied' }, 403)
            }
            engine.getOrCreateMachine(
                machineInput.id,
                machineInput.metadata,
                machineInput.runnerState ?? null,
                namespace
            )
        }

        try {
            const session = engine.getOrCreateSession(
                parsed.data.tag,
                parsed.data.metadata,
                parsed.data.agentState ?? null,
                namespace,
                parsed.data.model,
                parsed.data.effort,
                parsed.data.modelReasoningEffort,
                parsed.data.id
            )
            return c.json({ session })
        } catch (error) {
            if (error instanceof SessionIdentityConflictError) {
                return c.json({ error: error.message }, 409)
            }
            throw error
        }
    })

    app.get('/sessions/resumable', (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not ready' }, 503)
        }

        const namespace = c.get('namespace')
        const machineId = c.req.query('machineId') || undefined
        const sessions = engine.listLocalResumableSessions(namespace, { machineId })
        return c.json({ sessions })
    })

    app.get('/sessions/:id/resume-target', (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not ready' }, 503)
        }

        const namespace = c.get('namespace')
        const result = engine.resolveLocalResumeTarget(c.req.param('id'), namespace)
        if (result.type === 'error') {
            const status = result.code === 'access_denied' ? 403
                : result.code === 'session_not_found' ? 404
                    : 409
            return c.json({ error: result.message, code: result.code }, status)
        }

        return c.json({ target: result.target })
    })

    app.post('/sessions/:id/handoff-local', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not ready' }, 503)
        }

        const namespace = c.get('namespace')
        const result = await engine.handoffSessionToLocal(c.req.param('id'), namespace)
        if (result.type === 'error') {
            const status = result.code === 'access_denied' ? 403
                : result.code === 'session_not_found' ? 404
                    : result.code === 'already_local' ? 409
                        : 500
            return c.json({ error: result.message, code: result.code }, status)
        }

        return c.json({ ok: true })
    })

    app.post('/sessions/:id/clear-opencode', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not ready' }, 503)
        }

        const result = await engine.clearOpenCodeSession(c.req.param('id'), c.get('namespace'))
        if (result.type === 'error') {
            const status = result.code === 'access_denied' ? 403
                : result.code === 'session_not_found' ? 404
                    : result.code === 'clear_unavailable' ? 409
                        : 500
            return c.json({ error: result.message, code: result.code }, status)
        }
        return c.json({ ok: true, sessionId: result.sessionId })
    })

    app.post('/sessions/:id/clear-opencode/reserve', (c) => {
        const engine = getSyncEngine()
        if (!engine) return c.json({ error: 'Not ready' }, 503)
        const result = engine.reserveOpenCodeClearSession(c.req.param('id'), c.get('namespace'))
        if (result.type === 'error') {
            const status = result.code === 'access_denied' ? 403 : result.code === 'session_not_found' ? 404 : result.code === 'clear_unavailable' ? 409 : 500
            return c.json({ error: result.message, code: result.code }, status)
        }
        return c.json({ ok: true, sessionId: result.sessionId })
    })

    app.post('/sessions/:id/clear-opencode/abort', async (c) => {
        const engine = getSyncEngine()
        if (!engine) return c.json({ error: 'Not ready' }, 503)
        const parsed = ClearOpencodeSessionCallbackRequestSchema.safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) return c.json({ error: 'Invalid clear callback request' }, 400)
        const result = engine.abortOpenCodeClearSession(c.req.param('id'), c.get('namespace'), parsed.data.replacementSessionId)
        if (result.type === 'error') return c.json({ error: result.message, code: result.code }, clearErrorStatus(result.code))
        return c.json({ ok: true, sessionId: result.sessionId })
    })

    app.post('/sessions/:id/clear-opencode/confirm-cleanup', async (c) => {
        const engine = getSyncEngine()
        if (!engine) return c.json({ error: 'Not ready' }, 503)
        const parsed = ClearOpencodeSessionCallbackRequestSchema.safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) return c.json({ error: 'Invalid clear callback request' }, 400)
        const result = engine.confirmOpenCodeClearCleanup(c.req.param('id'), c.get('namespace'), parsed.data.replacementSessionId)
        if (result.type === 'error') return c.json({ error: result.message, code: result.code }, clearErrorStatus(result.code))
        return c.json({ ok: true, sessionId: result.sessionId })
    })

    app.get('/sessions/:id', (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not ready' }, 503)
        }
        const sessionId = c.req.param('id')
        const namespace = c.get('namespace')
        const resolved = resolveSessionForNamespace(engine, sessionId, namespace)
        if (!resolved.ok) {
            return c.json({ error: resolved.error }, resolved.status)
        }
        return c.json({ session: resolved.session })
    })

    app.get('/sessions/:id/messages', (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not ready' }, 503)
        }
        const sessionId = c.req.param('id')
        const namespace = c.get('namespace')
        const resolved = resolveSessionForNamespace(engine, sessionId, namespace)
        if (!resolved.ok) {
            return c.json({ error: resolved.error }, resolved.status)
        }

        const parsed = getMessagesQuerySchema.safeParse(c.req.query())
        if (!parsed.success) {
            return c.json({ error: 'Invalid query' }, 400)
        }

        const limit = parsed.data.limit ?? 200
        // Future-scheduled rows are excluded from CLI backfill — see
        // messages.ts:getDeliverableMessagesAfter for the rationale.  The
        // mature-scan path (releaseMatureScheduledMessages) is the sole
        // emit channel for scheduled rows.
        const messages = engine.getDeliverableMessagesAfter(resolved.sessionId, {
            afterSeq: parsed.data.afterSeq,
            limit,
            now: Date.now()
        })
        return c.json({ messages })
    })

    app.post('/sessions/:id/migrate-to-acp', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not ready' }, 503)
        }
        const sessionId = c.req.param('id')
        const namespace = c.get('namespace')
        const resolved = resolveSessionForNamespace(engine, sessionId, namespace)
        if (!resolved.ok) {
            return c.json({ error: resolved.error }, resolved.status)
        }
        // Codex #34 P2 (round 13): mirror the sessions.ts route hardening —
        // distinguish "no body" from "malformed JSON". A silent fallback to
        // {} would run the migration with destructive defaults even when
        // the operator's intended body was mangled in transit.
        const rawBody = await c.req.text()
        let body: unknown = {}
        if (rawBody.trim().length > 0) {
            try {
                body = JSON.parse(rawBody)
            } catch {
                return c.json({ error: 'Invalid JSON body' }, 400)
            }
        }
        const parsed = CursorMigrateToAcpRequestSchema.safeParse(body ?? {})
        if (!parsed.success) {
            return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400)
        }
        const outcome = await engine.migrateLegacyCursorSession(resolved.sessionId, namespace, parsed.data)
        const status = outcome.ok ? 200
            : outcome.reason === 'already_acp' || outcome.reason === 'not_cursor_session' || outcome.reason === 'no_cursor_session_id' ? 409
                : outcome.reason === 'running_refused' ? 409
                    : outcome.reason === 'target_already_exists' ? 409
                        : outcome.reason === 'no_legacy_store_on_disk' ? 404
                            : 500
        return c.json(outcome, status)
    })

    app.post('/machines', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not ready' }, 503)
        }
        const json = await c.req.json().catch(() => null)
        const parsed = CreateOrLoadMachineRequestSchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        const namespace = c.get('namespace')
        const existing = engine.getMachine(parsed.data.id)
        if (existing && existing.namespace !== namespace) {
            return c.json({ error: 'Machine access denied' }, 403)
        }
        const machine = engine.getOrCreateMachine(parsed.data.id, parsed.data.metadata, parsed.data.runnerState ?? null, namespace)
        return c.json({ machine })
    })

    app.get('/machines/:id', (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not ready' }, 503)
        }
        const machineId = c.req.param('id')
        const namespace = c.get('namespace')
        const resolved = resolveMachineForNamespace(engine, machineId, namespace)
        if (!resolved.ok) {
            return c.json({ error: resolved.error }, resolved.status)
        }
        return c.json({ machine: resolved.machine })
    })

    return app
}
