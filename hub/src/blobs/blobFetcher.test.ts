import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RpcTargetMissingError } from '../sync/rpcGateway'
import { BlobStore } from './blobStore'
import { GeneratedBlobFetcher, type BlobFetchEngine } from './blobFetcher'

let dir: string

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'hapi-blobfetch-'))
})

afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
})

function payload(size: number): Buffer {
    const buffer = Buffer.alloc(size)
    for (let i = 0; i < size; i++) buffer[i] = (i * 13 + 5) % 251
    return buffer
}

type EngineOptions = {
    calls?: { offset: number; length: number }[]
    failAt?: number
    failWith?: () => Error
    failTimes?: number
    legacy?: boolean
    delayMs?: number
}

/** A CLI that serves `bytes` through the chunk RPC, with optional faults. */
function chunkEngine(bytes: Buffer, options: EngineOptions = {}): BlobFetchEngine {
    let failures = 0
    return {
        readGeneratedBlobChunk: async (_sessionId, request) => {
            options.calls?.push({ offset: request.offset, length: request.length })
            if (options.legacy) {
                throw new RpcTargetMissingError('readGeneratedBlobChunk', 'handler-not-registered')
            }
            if (options.delayMs) {
                await new Promise((resolve) => setTimeout(resolve, options.delayMs))
            }
            if (options.failAt !== undefined && request.offset === options.failAt && failures < (options.failTimes ?? 1)) {
                failures += 1
                throw options.failWith ? options.failWith() : new Error('operation has timed out')
            }
            const slice = bytes.subarray(request.offset, request.offset + request.length)
            return {
                success: true,
                content: slice.toString('base64'),
                offset: request.offset,
                size: bytes.byteLength,
                mimeType: 'application/pdf',
                fileName: 'report.pdf'
            }
        },
        readGeneratedFile: async () => ({
            success: true,
            content: bytes.toString('base64'),
            mimeType: 'application/pdf',
            fileName: 'legacy.pdf',
            size: bytes.byteLength
        }),
        readGeneratedImage: async () => ({ success: false, error: 'not an image' })
    }
}

const fast = { retryDelayMs: 1, offlinePollMs: 5, sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) }

describe('GeneratedBlobFetcher', () => {
    it('pulls a multi-slice blob into the store in order, two slices in flight', async () => {
        const store = await BlobStore.open(dir)
        const fetcher = new GeneratedBlobFetcher(store, { chunkBytes: 1000, window: 2, ...fast })
        const bytes = payload(4500)
        const calls: { offset: number; length: number }[] = []

        const job = fetcher.ensure(chunkEngine(bytes, { calls }), 'session-1', 'file', 'blob-1')
        const outcome = await job.done
        expect(outcome.ok).toBe(true)
        if (!outcome.ok) return
        expect(outcome.record.state).toBe('ready')
        expect(outcome.record.origin).toBe('pull')
        expect(outcome.record.fileName).toBe('report.pdf')
        expect((await readFile(store.finalPath('file', 'blob-1'))).equals(bytes)).toBe(true)
        expect(calls.map((c) => c.offset)).toEqual([0, 1000, 2000, 3000, 4000])
        expect(calls[4].length).toBe(500)
        expect(job.status()).toEqual({ received: 4500, size: 4500 })
    })

    it('is single-flight: concurrent viewers share one pull', async () => {
        const store = await BlobStore.open(dir)
        const fetcher = new GeneratedBlobFetcher(store, { chunkBytes: 1000, ...fast })
        const calls: { offset: number; length: number }[] = []
        const engine = chunkEngine(payload(2500), { calls, delayMs: 5 })

        const a = fetcher.ensure(engine, 'session-1', 'file', 'shared')
        const b = fetcher.ensure(engine, 'session-1', 'file', 'shared')
        expect(a).toBe(b)
        await a.done
        expect(calls.length).toBe(3)
        // Once landed, the job is released and a new ensure() sees the store.
        const c = fetcher.ensure(engine, 'session-1', 'file', 'shared')
        expect(c).not.toBe(a)
        const outcome = await c.done
        expect(outcome.ok && outcome.record.state).toBe('ready')
        expect(calls.length).toBe(3)
    })

    it('retries a timed-out slice and continues', async () => {
        const store = await BlobStore.open(dir)
        const fetcher = new GeneratedBlobFetcher(store, { chunkBytes: 1000, chunkRetries: 3, ...fast })
        const bytes = payload(3000)
        const calls: { offset: number; length: number }[] = []
        const outcome = await fetcher.ensure(chunkEngine(bytes, { calls, failAt: 1000, failTimes: 2 }), 'session-1', 'file', 'retry').done
        expect(outcome.ok).toBe(true)
        expect(calls.filter((c) => c.offset === 1000).length).toBe(3)
        expect((await readFile(store.finalPath('file', 'retry'))).equals(bytes)).toBe(true)
    })

    it('waits for a disconnected CLI to come back instead of failing at once', async () => {
        const store = await BlobStore.open(dir)
        const fetcher = new GeneratedBlobFetcher(store, { chunkBytes: 1000, offlineWaitMs: 500, ...fast })
        const bytes = payload(1500)
        const engine = chunkEngine(bytes, {
            failAt: 1000,
            failTimes: 3,
            failWith: () => new RpcTargetMissingError('readGeneratedBlobChunk', 'socket-disconnected')
        })
        const outcome = await fetcher.ensure(engine, 'session-1', 'file', 'flaky').done
        expect(outcome.ok).toBe(true)
    })

    it('gives up as offline once the wait budget is spent, and remembers the failure briefly', async () => {
        let now = 0
        const store = await BlobStore.open(dir)
        const fetcher = new GeneratedBlobFetcher(store, {
            chunkBytes: 1000,
            offlineWaitMs: 50,
            offlinePollMs: 1,
            failureTtlMs: 1000,
            now: () => now,
            sleep: async (ms) => { now += Math.max(ms, 30) }
        })
        const engine = chunkEngine(payload(1000), {
            failAt: 0,
            failTimes: 99,
            failWith: () => new RpcTargetMissingError('readGeneratedBlobChunk', 'socket-disconnected')
        })
        const job = fetcher.ensure(engine, 'session-1', 'file', 'offline')
        const outcome = await job.done
        expect(outcome.ok).toBe(false)
        if (outcome.ok) return
        expect(outcome.failure.kind).toBe('offline')
        // Within the TTL a new viewer gets the same failed job, not a new pull.
        expect(fetcher.ensure(engine, 'session-1', 'file', 'offline')).toBe(job)
        now += 5000
        expect(fetcher.ensure(engine, 'session-1', 'file', 'offline')).not.toBe(job)
    })

    it('reports a CLI "not found" as final', async () => {
        const store = await BlobStore.open(dir)
        const fetcher = new GeneratedBlobFetcher(store, fast)
        const engine: BlobFetchEngine = {
            readGeneratedBlobChunk: async () => ({ success: false, error: 'Sent file not found' }),
            readGeneratedFile: async () => ({ success: false }),
            readGeneratedImage: async () => ({ success: false })
        }
        const outcome = await fetcher.ensure(engine, 'session-1', 'file', 'missing').done
        expect(outcome.ok).toBe(false)
        if (outcome.ok) return
        expect(outcome.failure).toEqual({ kind: 'not-found', message: 'Sent file not found' })
        expect(store.stat('file', 'missing')).toBeNull()
    })

    it('falls back to the whole-blob RPC for a CLI without chunked reads', async () => {
        const store = await BlobStore.open(dir)
        const fetcher = new GeneratedBlobFetcher(store, fast)
        const bytes = payload(700)
        const outcome = await fetcher.ensure(chunkEngine(bytes, { legacy: true }), 'session-1', 'file', 'old').done
        expect(outcome.ok).toBe(true)
        if (!outcome.ok) return
        expect(outcome.record.fileName).toBe('legacy.pdf')
        expect((await readFile(store.finalPath('file', 'old'))).equals(bytes)).toBe(true)
    })

    it('resumes a partial left behind by a stalled push', async () => {
        const store = await BlobStore.open(dir)
        const bytes = payload(2500)
        await store.append('file', 'stalled', {
            sessionId: 'session-1', fileName: 'report.pdf', mimeType: 'application/pdf', size: 2500, origin: 'push'
        }, 0, bytes.subarray(0, 1200))
        const fetcher = new GeneratedBlobFetcher(store, { chunkBytes: 1000, ...fast })
        const calls: { offset: number; length: number }[] = []
        const outcome = await fetcher.ensure(chunkEngine(bytes, { calls }), 'session-1', 'file', 'stalled').done
        expect(outcome.ok).toBe(true)
        expect(calls.map((c) => c.offset)).toEqual([1200, 2200])
        expect((await readFile(store.finalPath('file', 'stalled'))).equals(bytes)).toBe(true)
    })

    it('waitFor answers pending while the pull is still running', async () => {
        const store = await BlobStore.open(dir)
        const fetcher = new GeneratedBlobFetcher(store, { chunkBytes: 1000, ...fast })
        const job = fetcher.ensure(chunkEngine(payload(3000), { delayMs: 40 }), 'session-1', 'file', 'slow')
        expect(await job.waitFor(10)).toBe('pending')
        const outcome = await job.waitFor(5000)
        expect(outcome !== 'pending' && outcome.ok).toBe(true)
    })
})
