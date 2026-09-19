import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
    BlobChecksumMismatchError,
    BlobOffsetMismatchError,
    BlobSizeMismatchError,
    BlobStore,
    BlobStorageFullError,
    BlobTooLargeError
} from './blobStore'

let dir: string

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'hapi-blobstore-'))
})

afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
})

function payload(size: number, seed = 1): Buffer {
    const buffer = Buffer.alloc(size)
    for (let i = 0; i < size; i++) buffer[i] = (i * seed + 7) % 251
    return buffer
}

const meta = (size: number, extra: Partial<{ sha256: string | null; origin: 'push' | 'pull' }> = {}) => ({
    sessionId: 'session-1',
    fileName: 'report.pdf',
    mimeType: 'application/pdf',
    size,
    origin: 'push' as const,
    ...extra
})

describe('BlobStore', () => {
    it('assembles slices in order and finalises on the last byte', async () => {
        const store = await BlobStore.open(dir)
        const bytes = payload(1000)

        let record = await store.append('file', 'blob-1', meta(1000), 0, bytes.subarray(0, 400))
        expect(record.state).toBe('uploading')
        expect(record.received).toBe(400)
        expect(store.stat('file', 'blob-1')?.received).toBe(400)

        record = await store.append('file', 'blob-1', meta(1000), 400, bytes.subarray(400))
        expect(record.state).toBe('ready')
        expect(record.received).toBe(1000)
        expect(record.readyAt).not.toBeNull()

        const stored = await readFile(store.finalPath('file', 'blob-1'))
        expect(stored.equals(bytes)).toBe(true)
        await expect(stat(`${store.finalPath('file', 'blob-1')}.part`)).rejects.toThrow()
    })

    it('tells a stale writer the real offset instead of splicing', async () => {
        const store = await BlobStore.open(dir)
        const bytes = payload(600)
        await store.append('file', 'blob-1', meta(600), 0, bytes.subarray(0, 300))

        let error: unknown
        try {
            await store.append('file', 'blob-1', meta(600), 100, bytes.subarray(100, 300))
        } catch (e) {
            error = e
        }
        expect(error).toBeInstanceOf(BlobOffsetMismatchError)
        expect((error as BlobOffsetMismatchError).received).toBe(300)

        // A brand-new blob must start at 0 too.
        await expect(store.append('file', 'blob-2', meta(600), 10, bytes.subarray(10, 20))).rejects.toBeInstanceOf(BlobOffsetMismatchError)
    })

    it('refuses to mix a partial with a writer that claims a different size', async () => {
        const store = await BlobStore.open(dir)
        await store.append('file', 'blob-1', meta(600), 0, payload(600).subarray(0, 300))
        await expect(store.append('file', 'blob-1', meta(700), 300, payload(700).subarray(300))).rejects.toBeInstanceOf(BlobSizeMismatchError)
        await expect(store.append('file', 'blob-1', meta(600), 300, payload(900).subarray(300))).rejects.toBeInstanceOf(BlobSizeMismatchError)
    })

    it('verifies the promised sha256 and discards a corrupt upload', async () => {
        const store = await BlobStore.open(dir)
        const bytes = payload(512)
        const good = createHash('sha256').update(bytes).digest('hex')

        await store.append('file', 'ok', meta(512, { sha256: good }), 0, bytes)
        expect(store.stat('file', 'ok')?.state).toBe('ready')

        const bad = 'a'.repeat(64)
        await expect(store.append('file', 'corrupt', meta(512, { sha256: bad }), 0, bytes)).rejects.toBeInstanceOf(BlobChecksumMismatchError)
        expect(store.stat('file', 'corrupt')).toBeNull()
        await expect(stat(store.finalPath('file', 'corrupt'))).rejects.toThrow()
    })

    it('survives a restart: the index is rebuilt and a partial resumes from its length', async () => {
        const first = await BlobStore.open(dir)
        const done = payload(300, 3)
        await first.append('image', 'done', { ...meta(300), fileName: 'shot.png', mimeType: 'image/png' }, 0, done)
        const partial = payload(1000, 5)
        await first.append('file', 'partial', meta(1000), 0, partial.subarray(0, 450))

        const second = await BlobStore.open(dir)
        expect(second.stat('image', 'done')).toMatchObject({ state: 'ready', received: 300, size: 300, fileName: 'shot.png', mimeType: 'image/png' })
        expect(second.stat('file', 'partial')).toMatchObject({ state: 'uploading', received: 450, size: 1000 })

        // A stale writer that thinks it is at 0 learns 450.
        await expect(second.append('file', 'partial', meta(1000), 0, partial.subarray(0, 10))).rejects.toBeInstanceOf(BlobOffsetMismatchError)
        const record = await second.append('file', 'partial', meta(1000, { origin: 'pull' }), 450, partial.subarray(450))
        expect(record.state).toBe('ready')
        expect(record.origin).toBe('pull')
        expect((await readFile(second.finalPath('file', 'partial'))).equals(partial)).toBe(true)
    })

    it('drops a finished blob whose bytes vanished from disk', async () => {
        const first = await BlobStore.open(dir)
        await first.append('file', 'gone', meta(100), 0, payload(100))
        await rm(first.finalPath('file', 'gone'))
        const second = await BlobStore.open(dir)
        expect(second.stat('file', 'gone')).toBeNull()
    })

    it('handles an empty blob', async () => {
        const store = await BlobStore.open(dir)
        const record = await store.append('file', 'empty', meta(0), 0, new Uint8Array(0))
        expect(record.state).toBe('ready')
        expect((await stat(store.finalPath('file', 'empty'))).size).toBe(0)
    })

    it('enforces the per-blob size cap and the free-space floor', async () => {
        const capped = await BlobStore.open(dir, { maxBlobBytes: 100 })
        await expect(capped.append('file', 'big', meta(101), 0, payload(101))).rejects.toBeInstanceOf(BlobTooLargeError)

        const full = await BlobStore.open(dir, { minFreeBytes: Number.MAX_SAFE_INTEGER })
        await expect(full.append('file', 'nope', meta(10), 0, payload(10))).rejects.toBeInstanceOf(BlobStorageFullError)
    })

    it('is idempotent once ready', async () => {
        const store = await BlobStore.open(dir)
        await store.append('file', 'blob-1', meta(50), 0, payload(50))
        const again = await store.append('file', 'blob-1', meta(50), 0, payload(50))
        expect(again.state).toBe('ready')
    })

    it('evicts by age, then least-recently-accessed until the byte cap holds', async () => {
        let now = 1_000_000
        const store = await BlobStore.open(dir, { maxBytes: 250, maxAgeMs: 10_000, now: () => now })
        await store.append('file', 'a', meta(100), 0, payload(100))
        now += 1000
        await store.append('file', 'b', meta(100), 0, payload(100))
        now += 1000
        await store.append('file', 'c', meta(100), 0, payload(100))
        // 300 > 250: the oldest access (a) goes on the append-triggered prune.
        expect(store.stat('file', 'a')).toBeNull()
        expect(store.stat('file', 'b')).not.toBeNull()
        expect(store.stat('file', 'c')).not.toBeNull()

        // Touching b makes c the LRU victim next time.
        now += 1000
        store.touch('file', 'b')
        await store.append('file', 'd', meta(100), 0, payload(100))
        expect(store.stat('file', 'c')).toBeNull()
        expect(store.stat('file', 'b')).not.toBeNull()

        // Age: everything untouched for 10 s is gone.
        now += 20_000
        await store.prune()
        expect(store.list()).toEqual([])
    })

    it('discards a partial with no activity past the stale window', async () => {
        let now = 1_000_000
        const store = await BlobStore.open(dir, { stalePartMs: 5_000, now: () => now })
        await store.append('file', 'stuck', meta(100), 0, payload(100).subarray(0, 10))
        now += 6_000
        await store.prune()
        expect(store.stat('file', 'stuck')).toBeNull()
    })

    it('serialises concurrent appends to the same blob', async () => {
        const store = await BlobStore.open(dir)
        const bytes = payload(900)
        const results = await Promise.allSettled([
            store.append('file', 'race', meta(900), 0, bytes.subarray(0, 300)),
            store.append('file', 'race', meta(900), 0, bytes.subarray(0, 300)),
            store.append('file', 'race', meta(900), 300, bytes.subarray(300, 600))
        ])
        expect(results[0].status).toBe('fulfilled')
        expect(results[1].status).toBe('rejected')
        expect(results[2].status).toBe('fulfilled')
        expect(store.stat('file', 'race')?.received).toBe(600)
    })

    it('rejects ids that could escape the directory', async () => {
        const store = await BlobStore.open(dir)
        await expect(store.append('file', '../evil', meta(1), 0, payload(1))).rejects.toThrow('Invalid blob id')
    })
})
