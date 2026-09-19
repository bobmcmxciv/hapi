import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Session, SyncEngine } from '../../sync/syncEngine'
import { RpcTargetMissingError } from '../../sync/rpcGateway'
import type { WebAppEnv } from '../middleware/auth'
import { createConfiguration } from '../../configuration'
import { BlobStore } from '../../blobs/blobStore'
import { GeneratedBlobFetcher } from '../../blobs/blobFetcher'
import type { GeneratedBlobServices } from '../../blobs'
import { createGitRoutes } from './git'
import { createCliRoutes } from './cli'

const session = { id: 'session-1', namespace: 'default', active: true } as unknown as Session

let dir: string
let store: BlobStore

beforeAll(async () => {
    const config = await createConfiguration()
    config._setCliApiToken('test-token', 'env', false)
})

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'hapi-blobroutes-'))
    store = await BlobStore.open(dir)
})

afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
})

function payload(size: number): Buffer {
    const buffer = Buffer.alloc(size)
    for (let i = 0; i < size; i++) buffer[i] = (i * 31 + 3) % 251
    return buffer
}

function engineFor(bytes: Buffer, options: { calls?: number[]; fail?: () => Error; delayMs?: number } = {}): Partial<SyncEngine> {
    return {
        resolveSessionAccess: () => ({ ok: true as const, sessionId: 'session-1', session }),
        readGeneratedFile: async () => ({ success: false, error: 'legacy path must not be used' }),
        readGeneratedImage: async () => ({ success: false, error: 'legacy path must not be used' }),
        readGeneratedBlobChunk: async (_sessionId: string, request: { offset: number; length: number }) => {
            options.calls?.push(request.offset)
            if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs))
            if (options.fail) throw options.fail()
            const slice = bytes.subarray(request.offset, request.offset + request.length)
            return {
                success: true,
                content: slice.toString('base64'),
                offset: request.offset,
                size: bytes.byteLength,
                mimeType: 'application/pdf',
                fileName: 'report.pdf'
            }
        }
    } as unknown as Partial<SyncEngine>
}

function webApp(engine: Partial<SyncEngine>, blobs: GeneratedBlobServices): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => {
        c.set('namespace', 'default')
        await next()
    })
    app.route('/api', createGitRoutes(() => engine as SyncEngine, { blobs }))
    return app
}

function cliApp(engine: Partial<SyncEngine>, blobStore: BlobStore | undefined) {
    const app = new Hono()
    app.route('/cli', createCliRoutes(() => engine as SyncEngine, undefined, { blobStore }))
    return app
}

const cliAuth = { authorization: 'Bearer test-token' }

describe('generated blob download backed by the hub store', () => {
    it('serves a stored blob from disk with Range support and never touches the CLI', async () => {
        const bytes = payload(5000)
        await store.append('file', 'file-1', {
            sessionId: 'session-1', fileName: 'report.pdf', mimeType: 'application/pdf', size: 5000, origin: 'push'
        }, 0, bytes)
        const calls: number[] = []
        const app = webApp(engineFor(bytes, { calls }), { store, fetcher: new GeneratedBlobFetcher(store) })

        const full = await app.request('/api/sessions/session-1/generated-files/file-1')
        expect(full.status).toBe(200)
        expect(full.headers.get('content-type')).toBe('application/pdf')
        expect(full.headers.get('content-length')).toBe('5000')
        expect(full.headers.get('accept-ranges')).toBe('bytes')
        expect(full.headers.get('etag')).toBe('"file-1"')
        expect(full.headers.get('content-disposition')).toBe('attachment; filename="report.pdf"')
        expect(Buffer.from(await full.arrayBuffer()).equals(bytes)).toBe(true)

        const partial = await app.request('/api/sessions/session-1/generated-files/file-1', { headers: { range: 'bytes=4000-' } })
        expect(partial.status).toBe(206)
        expect(partial.headers.get('content-range')).toBe('bytes 4000-4999/5000')
        expect(partial.headers.get('content-length')).toBe('1000')
        expect(Buffer.from(await partial.arrayBuffer()).equals(bytes.subarray(4000))).toBe(true)

        const beyond = await app.request('/api/sessions/session-1/generated-files/file-1', { headers: { range: 'bytes=9000-' } })
        expect(beyond.status).toBe(416)

        expect(calls).toEqual([])
    })

    it('pulls a blob the store lacks, then serves it, and serves the next viewer from disk', async () => {
        const bytes = payload(3000)
        const calls: number[] = []
        const fetcher = new GeneratedBlobFetcher(store, { chunkBytes: 1000 })
        const app = webApp(engineFor(bytes, { calls }), { store, fetcher })

        const first = await app.request('/api/sessions/session-1/generated-images/img-1')
        expect(first.status).toBe(200)
        expect(first.headers.get('content-disposition')).toBe('inline; filename="report.pdf"')
        expect(Buffer.from(await first.arrayBuffer()).equals(bytes)).toBe(true)
        expect(calls).toEqual([0, 1000, 2000])
        expect(store.stat('image', 'img-1')?.state).toBe('ready')

        const second = await app.request('/api/sessions/session-1/generated-images/img-1')
        expect(second.status).toBe(200)
        expect(calls).toEqual([0, 1000, 2000])
    })

    it('answers 202 with progress while a slow pull is running, then 200 once landed', async () => {
        const bytes = payload(2000)
        const fetcher = new GeneratedBlobFetcher(store, { chunkBytes: 1000 })
        const app = webApp(engineFor(bytes, { delayMs: 60 }), { store, fetcher, pendingWaitMs: 20 })

        const pending = await app.request('/api/sessions/session-1/generated-files/file-1')
        expect(pending.status).toBe(202)
        expect(pending.headers.get('cache-control')).toBe('no-store')
        const body = await pending.json() as { state: string; received: number; size: number | null; retryAfterMs: number }
        expect(body.state).toBe('fetching')
        expect(body.retryAfterMs).toBeGreaterThan(0)

        await fetcher.get('file', 'file-1')!.done
        const done = await app.request('/api/sessions/session-1/generated-files/file-1')
        expect(done.status).toBe(200)
        expect(Buffer.from(await done.arrayBuffer()).equals(bytes)).toBe(true)
    })

    it('answers 202 uploading while the CLI push is fresh, and does not start a pull', async () => {
        const bytes = payload(4000)
        await store.append('file', 'file-1', {
            sessionId: 'session-1', fileName: 'report.pdf', mimeType: 'application/pdf', size: 4000, origin: 'push'
        }, 0, bytes.subarray(0, 1500))
        const calls: number[] = []
        const app = webApp(engineFor(bytes, { calls }), { store, fetcher: new GeneratedBlobFetcher(store), pendingWaitMs: 20 })

        const response = await app.request('/api/sessions/session-1/generated-files/file-1')
        expect(response.status).toBe(202)
        expect(await response.json()).toMatchObject({ state: 'uploading', received: 1500, size: 4000 })
        expect(calls).toEqual([])
    })

    it('takes over a push that stalled: pulls the remainder from where it stopped', async () => {
        let now = 1_000_000
        const stalledStore = await BlobStore.open(dir, { now: () => now })
        const bytes = payload(4000)
        await stalledStore.append('file', 'file-1', {
            sessionId: 'session-1', fileName: 'report.pdf', mimeType: 'application/pdf', size: 4000, origin: 'push'
        }, 0, bytes.subarray(0, 1500))
        now += 5 * 60_000
        const calls: number[] = []
        const app = webApp(engineFor(bytes, { calls }), { store: stalledStore, fetcher: new GeneratedBlobFetcher(stalledStore, { chunkBytes: 1000 }) })

        const response = await app.request('/api/sessions/session-1/generated-files/file-1')
        expect(response.status).toBe(200)
        expect(Buffer.from(await response.arrayBuffer()).equals(bytes)).toBe(true)
        expect(calls).toEqual([1500, 2500, 3500])
    })

    it('maps a disconnected CLI to 503 and a missing blob to 404', async () => {
        const offline = webApp(engineFor(payload(10), {
            fail: () => new RpcTargetMissingError('readGeneratedBlobChunk', 'socket-disconnected')
        }), { store, fetcher: new GeneratedBlobFetcher(store, { offlineWaitMs: 10, offlinePollMs: 1 }) })
        const offlineResponse = await offline.request('/api/sessions/session-1/generated-files/file-1')
        expect(offlineResponse.status).toBe(503)
        expect(await offlineResponse.json()).toMatchObject({ reason: 'session-offline', retryable: true })

        const missingEngine = {
            resolveSessionAccess: () => ({ ok: true as const, sessionId: 'session-1', session }),
            readGeneratedBlobChunk: async () => ({ success: false, error: 'Sent file not found' })
        } as unknown as Partial<SyncEngine>
        const missing = webApp(missingEngine, { store, fetcher: new GeneratedBlobFetcher(store) })
        const missingResponse = await missing.request('/api/sessions/session-1/generated-files/file-2')
        expect(missingResponse.status).toBe(404)
        expect(await missingResponse.json()).toMatchObject({ reason: 'not-found', retryable: false })
    })

    it('still answers 304 for a matching ETag without touching the store or the CLI', async () => {
        const calls: number[] = []
        const app = webApp(engineFor(payload(10), { calls }), { store, fetcher: new GeneratedBlobFetcher(store) })
        const response = await app.request('/api/sessions/session-1/generated-files/file-1', { headers: { 'if-none-match': '"file-1"' } })
        expect(response.status).toBe(304)
        expect(calls).toEqual([])
    })
})

describe('CLI blob push routes', () => {
    const engine = {
        resolveSessionAccess: (sessionId: string) => sessionId === 'session-1'
            ? { ok: true as const, sessionId: 'session-1', session }
            : { ok: false as const, reason: 'not-found' as const }
    } as unknown as Partial<SyncEngine>

    function put(app: Hono, offset: number, bytes: Uint8Array, headers: Record<string, string>) {
        return app.request(`/cli/sessions/session-1/blobs/file/file-1?offset=${offset}`, {
            method: 'PUT',
            headers: { ...cliAuth, ...headers },
            body: bytes
        })
    }

    it('accepts offset-addressed slices and finalises with a matching checksum', async () => {
        const app = cliApp(engine, store)
        const bytes = payload(2500)
        const headers = {
            'x-blob-size': '2500',
            'x-blob-mime': 'application/pdf',
            'x-blob-name': encodeURIComponent('季度 报告.pdf'),
            'x-blob-sha256': createHash('sha256').update(bytes).digest('hex')
        }

        const status0 = await app.request('/cli/sessions/session-1/blobs/file/file-1', { headers: cliAuth })
        expect(await status0.json()).toEqual({ success: true, state: 'missing', received: 0, size: null })

        const first = await put(app, 0, bytes.subarray(0, 1000), headers)
        expect(first.status).toBe(200)
        expect(await first.json()).toEqual({ success: true, state: 'uploading', received: 1000, size: 2500 })

        const stale = await put(app, 500, bytes.subarray(500, 1500), headers)
        expect(stale.status).toBe(409)
        expect(await stale.json()).toMatchObject({ reason: 'offset-mismatch', received: 1000 })

        const status1 = await app.request('/cli/sessions/session-1/blobs/file/file-1', { headers: cliAuth })
        expect(await status1.json()).toEqual({ success: true, state: 'uploading', received: 1000, size: 2500 })

        const last = await put(app, 1000, bytes.subarray(1000), headers)
        expect(last.status).toBe(200)
        expect(await last.json()).toEqual({ success: true, state: 'ready', received: 2500, size: 2500 })

        const record = store.stat('file', 'file-1')
        expect(record).toMatchObject({ state: 'ready', fileName: '季度 报告.pdf', mimeType: 'application/pdf', sessionId: 'session-1', origin: 'push' })
        expect((await readFile(store.finalPath('file', 'file-1'))).equals(bytes)).toBe(true)
    })

    it('discards a corrupt upload with 422 so the CLI restarts from zero', async () => {
        const app = cliApp(engine, store)
        const bytes = payload(100)
        const response = await put(app, 0, bytes, { 'x-blob-size': '100', 'x-blob-sha256': 'b'.repeat(64) })
        expect(response.status).toBe(422)
        expect(await response.json()).toMatchObject({ reason: 'checksum-mismatch', received: 0 })
        expect(store.stat('file', 'file-1')).toBeNull()
    })

    it('rejects oversized blobs, bad references, unknown sessions, and missing auth', async () => {
        const app = cliApp(engine, store)
        const tooBig = await put(app, 0, new Uint8Array(1), { 'x-blob-size': String(10 * 1024 * 1024 * 1024) })
        expect(tooBig.status).toBe(413)

        const badKind = await app.request('/cli/sessions/session-1/blobs/video/file-1?offset=0', { method: 'PUT', headers: { ...cliAuth, 'x-blob-size': '1' }, body: new Uint8Array(1) })
        expect(badKind.status).toBe(400)

        const badId = await app.request('/cli/sessions/session-1/blobs/file/..%2Fevil?offset=0', { method: 'PUT', headers: { ...cliAuth, 'x-blob-size': '1' }, body: new Uint8Array(1) })
        expect(badId.status).toBe(400)

        const noSize = await app.request('/cli/sessions/session-1/blobs/file/file-1?offset=0', { method: 'PUT', headers: cliAuth, body: new Uint8Array(1) })
        expect(noSize.status).toBe(400)

        const unknownSession = await app.request('/cli/sessions/session-9/blobs/file/file-1?offset=0', { method: 'PUT', headers: { ...cliAuth, 'x-blob-size': '1' }, body: new Uint8Array(1) })
        expect(unknownSession.status).toBe(404)

        const unauthenticated = await app.request('/cli/sessions/session-1/blobs/file/file-1?offset=0', { method: 'PUT', headers: { 'x-blob-size': '1' }, body: new Uint8Array(1) })
        expect(unauthenticated.status).toBe(401)
    })

    it('answers 501 when the hub has no blob store so the CLI stops trying', async () => {
        const app = cliApp(engine, undefined)
        const response = await put(app, 0, new Uint8Array(1), { 'x-blob-size': '1' })
        expect(response.status).toBe(501)
        expect(await response.json()).toMatchObject({ reason: 'unsupported' })
    })
})
