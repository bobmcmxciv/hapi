import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
    configureGeneratedBlobUploader,
    registerGeneratedBlobSource,
    resetGeneratedBlobUploaderForTests,
    scheduleGeneratedBlobUpload,
    uploadGeneratedBlob,
    waitForGeneratedBlobUploads,
    type GeneratedBlobSource
} from './generatedBlobUpload'

type Received = { method: string; url: string; offset: number | null; body: Buffer; headers: IncomingMessage['headers'] }

/** A stand-in hub that speaks the blob push protocol, with programmable faults. */
class FakeHub {
    server: Server
    requests: Received[] = []
    stored = Buffer.alloc(0)
    size: number | null = null
    ready = false
    /** Return this status once for the next PUT, then behave normally. */
    failNextPut: { status: number; body?: unknown; times?: number } | null = null
    dropNextPut = 0
    statusState: 'missing' | 'uploading' | 'ready' | 'auto' = 'auto'
    rejectAllWith: number | null = null
    checksumReject = false

    constructor() {
        this.server = createServer((req, res) => void this.handle(req, res))
    }

    async listen(): Promise<string> {
        await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve))
        const address = this.server.address() as AddressInfo
        return `http://127.0.0.1:${address.port}`
    }

    async close(): Promise<void> {
        await new Promise<void>((resolve) => this.server.close(() => resolve()))
    }

    private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(chunk as Buffer)
        const body = Buffer.concat(chunks)
        const url = new URL(req.url ?? '/', 'http://x')
        const offsetRaw = url.searchParams.get('offset')
        const offset = offsetRaw === null ? null : Number(offsetRaw)
        this.requests.push({ method: req.method ?? '', url: url.pathname, offset, body, headers: req.headers })

        const json = (status: number, payload: unknown) => {
            res.writeHead(status, { 'content-type': 'application/json' })
            res.end(JSON.stringify(payload))
        }
        if (req.headers.authorization !== 'Bearer cli-token') {
            return json(401, { error: 'Invalid token' })
        }
        if (this.rejectAllWith !== null) {
            return json(this.rejectAllWith, { success: false, reason: 'unsupported' })
        }
        if (req.method === 'GET') {
            if (this.statusState === 'missing') return json(200, { success: true, state: 'missing', received: 0, size: null })
            if (this.statusState === 'ready') return json(200, { success: true, state: 'ready', received: this.size, size: this.size })
            if (this.statusState === 'uploading') return json(200, { success: true, state: 'uploading', received: this.stored.length, size: this.size })
            if (this.ready) return json(200, { success: true, state: 'ready', received: this.size, size: this.size })
            if (this.size === null) return json(200, { success: true, state: 'missing', received: 0, size: null })
            return json(200, { success: true, state: 'uploading', received: this.stored.length, size: this.size })
        }
        if (req.method !== 'PUT') return json(405, {})
        if (this.dropNextPut > 0) {
            this.dropNextPut -= 1
            req.socket.destroy()
            return
        }
        if (this.failNextPut) {
            const fault = this.failNextPut
            fault.times = (fault.times ?? 1) - 1
            if (fault.times <= 0) this.failNextPut = null
            return json(fault.status, fault.body ?? { success: false })
        }
        const size = Number(req.headers['x-blob-size'])
        if (this.size === null) this.size = size
        if (offset !== this.stored.length) {
            return json(409, { success: false, reason: 'offset-mismatch', received: this.stored.length })
        }
        this.stored = Buffer.concat([this.stored, body])
        if (this.stored.length === this.size) {
            const sha = createHash('sha256').update(this.stored).digest('hex')
            if (this.checksumReject || sha !== req.headers['x-blob-sha256']) {
                this.stored = Buffer.alloc(0)
                this.size = null
                this.checksumReject = false
                return json(422, { success: false, reason: 'checksum-mismatch', received: 0 })
            }
            this.ready = true
            return json(200, { success: true, state: 'ready', received: this.stored.length, size: this.size })
        }
        return json(200, { success: true, state: 'uploading', received: this.stored.length, size: this.size })
    }
}

function payload(size: number): Buffer {
    const buffer = Buffer.alloc(size)
    for (let i = 0; i < size; i++) buffer[i] = (i * 17 + 9) % 251
    return buffer
}

function sourceFor(bytes: Buffer, reads?: number[]): GeneratedBlobSource {
    return {
        size: bytes.length,
        mimeType: 'application/pdf',
        fileName: '报告 v2.pdf',
        read: async (offset, length) => {
            reads?.push(offset)
            return new Uint8Array(bytes.subarray(offset, offset + length))
        },
        sha256: async () => createHash('sha256').update(bytes).digest('hex')
    }
}

let hub: FakeHub
let apiUrl: string

beforeEach(async () => {
    resetGeneratedBlobUploaderForTests()
    hub = new FakeHub()
    apiUrl = await hub.listen()
})

afterEach(async () => {
    resetGeneratedBlobUploaderForTests()
    await hub.close()
})

const fastConfig = (overrides: Partial<Parameters<typeof uploadGeneratedBlob>[2]> = {}) => ({
    sessionId: 'session-1',
    apiUrl,
    token: 'cli-token',
    chunkBytes: 1000,
    baseDelayMs: 1,
    maxDelayMs: 2,
    maxAttempts: 4,
    requestTimeoutMs: 5000,
    ...overrides
})

describe('uploadGeneratedBlob', () => {
    it('pushes a blob in offset-addressed slices with size, mime, name and checksum headers', async () => {
        const bytes = payload(2500)
        const marked: string[] = []
        registerGeneratedBlobSource('file', { open: async () => sourceFor(bytes), markUploaded: async (id) => { marked.push(id) } })

        const outcome = await uploadGeneratedBlob('file', 'file-1', fastConfig())

        expect(outcome).toBe('ready')
        expect(hub.stored.equals(bytes)).toBe(true)
        expect(marked).toEqual(['file-1'])
        const puts = hub.requests.filter((r) => r.method === 'PUT')
        expect(puts.map((r) => r.offset)).toEqual([0, 1000, 2000])
        expect(puts[0].url).toBe('/cli/sessions/session-1/blobs/file/file-1')
        expect(puts[0].headers['x-blob-size']).toBe('2500')
        expect(puts[0].headers['x-blob-mime']).toBe('application/pdf')
        expect(decodeURIComponent(String(puts[0].headers['x-blob-name']))).toBe('报告 v2.pdf')
        expect(puts[0].headers['x-blob-sha256']).toBe(createHash('sha256').update(bytes).digest('hex'))
        expect(puts[0].headers['content-type']).toBe('application/octet-stream')
    })

    it('resumes from the offset the hub reports instead of re-sending landed bytes', async () => {
        const bytes = payload(3000)
        registerGeneratedBlobSource('file', { open: async () => sourceFor(bytes) })
        hub.stored = Buffer.from(bytes.subarray(0, 1000))
        hub.size = 3000

        const outcome = await uploadGeneratedBlob('file', 'file-1', fastConfig())

        expect(outcome).toBe('ready')
        expect(hub.stored.equals(bytes)).toBe(true)
        expect(hub.requests.filter((r) => r.method === 'PUT').map((r) => r.offset)).toEqual([1000, 2000])
    })

    it('re-syncs on 409 and retries transport failures with backoff', async () => {
        const bytes = payload(2000)
        registerGeneratedBlobSource('file', { open: async () => sourceFor(bytes) })
        hub.failNextPut = { status: 503, times: 2 }
        hub.dropNextPut = 1

        const outcome = await uploadGeneratedBlob('file', 'file-1', fastConfig())

        expect(outcome).toBe('ready')
        expect(hub.stored.equals(bytes)).toBe(true)
        const puts = hub.requests.filter((r) => r.method === 'PUT')
        expect(puts.length).toBeGreaterThanOrEqual(4)
    })

    it('starts over once when the hub rejects the checksum, then gives up', async () => {
        const bytes = payload(1500)
        registerGeneratedBlobSource('file', { open: async () => sourceFor(bytes) })
        hub.checksumReject = true

        const outcome = await uploadGeneratedBlob('file', 'file-1', fastConfig())

        expect(outcome).toBe('ready')
        expect(hub.stored.equals(bytes)).toBe(true)
        const puts = hub.requests.filter((r) => r.method === 'PUT').map((r) => r.offset)
        expect(puts).toEqual([0, 1000, 0, 1000])
    })

    it('gives up after the transport budget without throwing', async () => {
        const bytes = payload(500)
        registerGeneratedBlobSource('file', { open: async () => sourceFor(bytes) })
        hub.failNextPut = { status: 502, times: 99 }

        const outcome = await uploadGeneratedBlob('file', 'file-1', fastConfig({ maxAttempts: 2 }))

        expect(outcome).toBe('failed')
        expect(hub.ready).toBe(false)
    })

    it('stops immediately on a hub without blob storage or one that refuses the blob', async () => {
        registerGeneratedBlobSource('file', { open: async () => sourceFor(payload(10)) })
        hub.rejectAllWith = 501
        expect(await uploadGeneratedBlob('file', 'file-1', fastConfig())).toBe('unsupported')
        hub.rejectAllWith = null
        hub.statusState = 'missing'
        hub.failNextPut = { status: 413, times: 1 }
        expect(await uploadGeneratedBlob('file', 'file-1', fastConfig())).toBe('rejected')
    })

    it('skips blobs the hub already holds, and blobs with no local source', async () => {
        const marked: string[] = []
        registerGeneratedBlobSource('file', { open: async (id) => (id === 'known' ? sourceFor(payload(10)) : null), markUploaded: async (id) => { marked.push(id) } })
        hub.statusState = 'ready'
        hub.size = 10
        expect(await uploadGeneratedBlob('file', 'known', fastConfig())).toBe('ready')
        expect(hub.requests.filter((r) => r.method === 'PUT')).toEqual([])
        expect(marked).toEqual(['known'])
        expect(await uploadGeneratedBlob('file', 'unknown', fastConfig())).toBe('skipped')
    })

    it('handles an empty blob with a single zero-length slice', async () => {
        registerGeneratedBlobSource('file', { open: async () => sourceFor(Buffer.alloc(0)) })
        expect(await uploadGeneratedBlob('file', 'empty', fastConfig())).toBe('ready')
        expect(hub.requests.filter((r) => r.method === 'PUT').map((r) => r.body.length)).toEqual([0])
    })
})

describe('scheduleGeneratedBlobUpload', () => {
    it('is a no-op until the uploader is bound to a session', async () => {
        registerGeneratedBlobSource('file', { open: async () => sourceFor(payload(10)) })
        expect(await scheduleGeneratedBlobUpload('file', 'file-1')).toBe('skipped')
        expect(hub.requests).toEqual([])
    })

    it('uploads queued blobs one at a time and de-duplicates', async () => {
        const order: string[] = []
        registerGeneratedBlobSource('file', {
            open: async (id) => {
                order.push(id)
                return sourceFor(payload(10))
            }
        })
        configureGeneratedBlobUploader({ ...fastConfig() })
        const a = scheduleGeneratedBlobUpload('file', 'a')
        const dup = scheduleGeneratedBlobUpload('file', 'a')
        hub.ready = false
        const b = scheduleGeneratedBlobUpload('file', 'b')
        expect(await dup).toBe('skipped')
        await waitForGeneratedBlobUploads()
        expect(await a).toBe('ready')
        // Same fake hub for both ids, so the second one sees "ready" from the status probe.
        expect(await b).toBe('ready')
        expect(order).toEqual(['a', 'b'])
    })
})
