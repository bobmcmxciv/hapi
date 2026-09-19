import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, readdir, readFile, rename, rm, stat, statfs, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { GeneratedBlobKind } from '@hapi/protocol/apiTypes'
import { MAX_GENERATED_BLOB_BYTES } from '@hapi/protocol/socketLimits'

/**
 * Hub-side storage for generated blobs (sent files, inline images/videos).
 *
 * Before this store existed the hub kept only a four-field envelope per sent
 * file; the bytes stayed on the CLI machine and were re-pulled over that
 * machine's uplink for every viewer, every retry and every remount. On a
 * 50 KB/s uplink that turned a 2 MB screenshot into a 502 and a
 * `ping timeout` for the whole session. Now the bytes land here once — pushed
 * by the CLI at send time, or pulled by the hub for envelopes that predate the
 * push — and every download is served from local disk.
 *
 * Layout (flat, one directory):
 *   <kind>-<id>        finished bytes
 *   <kind>-<id>.part   bytes received so far (push or pull in progress)
 *   <kind>-<id>.json   record sidecar (temp+rename, so readers never see a torn write)
 *
 * The record index is rebuilt from the sidecars at open(), so a hub restart
 * loses nothing and a half-written upload resumes from the `.part` length.
 */

export type BlobOrigin = 'push' | 'pull'
export type BlobState = 'uploading' | 'ready'

export type BlobRecord = {
    kind: GeneratedBlobKind
    id: string
    sessionId: string | null
    fileName: string
    mimeType: string
    size: number
    /** Bytes on disk so far; equals `size` once `state` is `ready`. */
    received: number
    state: BlobState
    origin: BlobOrigin
    /** Hex sha256 the writer promised; verified when the last byte lands. */
    sha256: string | null
    createdAt: number
    readyAt: number | null
    /** Last time bytes were appended — the stall detector for pushes whose CLI died. */
    lastActivityAt: number
    lastAccessAt: number
}

export type BlobWriteMeta = {
    sessionId: string | null
    fileName: string
    mimeType: string
    size: number
    origin: BlobOrigin
    sha256?: string | null
}

export class BlobOffsetMismatchError extends Error {
    constructor(readonly received: number) {
        super(`Blob offset mismatch; hub holds ${received} bytes`)
        this.name = 'BlobOffsetMismatchError'
    }
}

export class BlobSizeMismatchError extends Error {
    constructor(readonly received: number, readonly expected: number) {
        super(`Blob size mismatch; hub expects ${expected} bytes`)
        this.name = 'BlobSizeMismatchError'
    }
}

export class BlobChecksumMismatchError extends Error {
    constructor() {
        super('Blob checksum mismatch; upload discarded')
        this.name = 'BlobChecksumMismatchError'
    }
}

export class BlobTooLargeError extends Error {
    constructor(readonly limit: number) {
        super(`Blob exceeds the ${limit} byte limit`)
        this.name = 'BlobTooLargeError'
    }
}

export class BlobStorageFullError extends Error {
    constructor() {
        super('Blob storage has no room left')
        this.name = 'BlobStorageFullError'
    }
}

export type BlobStoreOptions = {
    /** Total bytes of finished blobs kept before the least-recently-used are evicted. */
    maxBytes?: number
    /** Finished blobs untouched for longer than this are evicted. */
    maxAgeMs?: number
    /** Refuse new blobs when the volume would drop below this much free space. */
    minFreeBytes?: number
    maxBlobBytes?: number
    /** Partial blobs with no activity for this long are discarded. */
    stalePartMs?: number
    now?: () => number
}

type ResolvedOptions = Required<BlobStoreOptions>

const DEFAULT_OPTIONS: ResolvedOptions = {
    maxBytes: 20 * 1024 * 1024 * 1024,
    maxAgeMs: 180 * 24 * 60 * 60 * 1000,
    minFreeBytes: 2 * 1024 * 1024 * 1024,
    maxBlobBytes: MAX_GENERATED_BLOB_BYTES,
    stalePartMs: 24 * 60 * 60 * 1000,
    now: () => Date.now()
}

/** Ids reach the filesystem: only opaque tokens (uuids in practice) are accepted. */
export function isSafeBlobId(id: string): boolean {
    return /^[A-Za-z0-9._-]{1,128}$/.test(id) && !id.includes('..')
}

export function isBlobKind(value: unknown): value is GeneratedBlobKind {
    return value === 'file' || value === 'image'
}

function blobKey(kind: GeneratedBlobKind, id: string): string {
    return `${kind}-${id}`
}

async function sha256OfFile(path: string): Promise<string> {
    const hash = createHash('sha256')
    await new Promise<void>((resolve, reject) => {
        const stream = createReadStream(path)
        stream.on('data', (chunk) => hash.update(chunk))
        stream.on('end', () => resolve())
        stream.on('error', reject)
    })
    return hash.digest('hex')
}

export class BlobStore {
    private readonly records = new Map<string, BlobRecord>()
    private readonly locks = new Map<string, Promise<unknown>>()
    private readonly options: ResolvedOptions
    private readonly touched = new Map<string, number>()

    private constructor(readonly dir: string, options: BlobStoreOptions) {
        this.options = { ...DEFAULT_OPTIONS, ...options }
    }

    static async open(dir: string, options: BlobStoreOptions = {}): Promise<BlobStore> {
        await mkdir(dir, { recursive: true })
        const store = new BlobStore(dir, options)
        await store.scan()
        await store.prune()
        return store
    }

    now(): number {
        return this.options.now()
    }

    finalPath(kind: GeneratedBlobKind, id: string): string {
        return join(this.dir, blobKey(kind, id))
    }

    private partPath(kind: GeneratedBlobKind, id: string): string {
        return `${this.finalPath(kind, id)}.part`
    }

    private metaPath(kind: GeneratedBlobKind, id: string): string {
        return `${this.finalPath(kind, id)}.json`
    }

    stat(kind: GeneratedBlobKind, id: string): BlobRecord | null {
        const record = this.records.get(blobKey(kind, id))
        return record ? { ...record } : null
    }

    list(): BlobRecord[] {
        return [...this.records.values()].map((record) => ({ ...record }))
    }

    usage(): { bytes: number; count: number } {
        let bytes = 0
        let count = 0
        for (const record of this.records.values()) {
            if (record.state !== 'ready') continue
            bytes += record.size
            count += 1
        }
        return { bytes, count }
    }

    async freeBytes(): Promise<number | null> {
        try {
            const info = await statfs(this.dir)
            return Number(info.bavail) * Number(info.bsize)
        } catch {
            return null
        }
    }

    /**
     * Append `bytes` at `offset`. Creates the record on the first slice, resumes
     * a partial one on later slices, and finalises (checksum, rename, `ready`)
     * when the last byte lands. Concurrent callers for the same blob are
     * serialised; a stale caller learns the real offset through
     * `BlobOffsetMismatchError` and resumes from there.
     */
    async append(kind: GeneratedBlobKind, id: string, meta: BlobWriteMeta, offset: number, bytes: Uint8Array): Promise<BlobRecord> {
        if (!isSafeBlobId(id)) {
            throw new Error('Invalid blob id')
        }
        return await this.withLock(blobKey(kind, id), async () => {
            const key = blobKey(kind, id)
            let record = this.records.get(key)
            if (record?.state === 'ready') {
                return { ...record }
            }
            if (meta.size > this.options.maxBlobBytes) {
                throw new BlobTooLargeError(this.options.maxBlobBytes)
            }
            if (record && record.size !== meta.size) {
                // Same id, different length: the writer is talking about a different
                // blob than the one we started. Never splice them together.
                throw new BlobSizeMismatchError(record.received, record.size)
            }
            if (!record) {
                if (offset !== 0) {
                    throw new BlobOffsetMismatchError(0)
                }
                const free = await this.freeBytes()
                if (free !== null && free - meta.size < this.options.minFreeBytes) {
                    throw new BlobStorageFullError()
                }
                await rm(this.partPath(kind, id), { force: true })
                const now = this.now()
                record = {
                    kind,
                    id,
                    sessionId: meta.sessionId,
                    fileName: meta.fileName,
                    mimeType: meta.mimeType,
                    size: meta.size,
                    received: 0,
                    state: 'uploading',
                    origin: meta.origin,
                    sha256: meta.sha256 ?? null,
                    createdAt: now,
                    readyAt: null,
                    lastActivityAt: now,
                    lastAccessAt: now
                }
                this.records.set(key, record)
            }
            if (offset !== record.received) {
                throw new BlobOffsetMismatchError(record.received)
            }
            if (record.received + bytes.byteLength > record.size) {
                throw new BlobSizeMismatchError(record.received, record.size)
            }

            if (bytes.byteLength > 0) {
                const handle = await open(this.partPath(kind, id), 'a')
                try {
                    await handle.write(bytes)
                } finally {
                    await handle.close()
                }
                record.received += bytes.byteLength
            } else if (record.size === 0) {
                await writeFile(this.partPath(kind, id), new Uint8Array(0))
            }
            record.lastActivityAt = this.now()
            // A pull may finish what a push started; remember who delivered the last byte.
            record.origin = meta.origin
            if (meta.sha256 && !record.sha256) {
                record.sha256 = meta.sha256
            }

            if (record.received === record.size) {
                if (record.sha256) {
                    const actual = await sha256OfFile(this.partPath(kind, id))
                    if (actual !== record.sha256) {
                        await this.discard(kind, id)
                        throw new BlobChecksumMismatchError()
                    }
                }
                await rename(this.partPath(kind, id), this.finalPath(kind, id))
                record.state = 'ready'
                record.readyAt = this.now()
                record.lastAccessAt = record.readyAt
            }
            await this.writeMeta(record)
            if (record.state === 'ready') {
                await this.prune()
            }
            return { ...record }
        })
    }

    /** Drop a partial or finished blob entirely. */
    async remove(kind: GeneratedBlobKind, id: string): Promise<void> {
        await this.withLock(blobKey(kind, id), () => this.discard(kind, id))
    }

    /** Record a read so LRU eviction keeps what people actually open. Persisted
     *  at most once per ten minutes per blob to keep reads cheap. */
    touch(kind: GeneratedBlobKind, id: string): void {
        const key = blobKey(kind, id)
        const record = this.records.get(key)
        if (!record) return
        const now = this.now()
        record.lastAccessAt = now
        const persisted = this.touched.get(key) ?? 0
        if (now - persisted > 10 * 60 * 1000) {
            this.touched.set(key, now)
            void this.writeMeta(record).catch(() => {})
        }
    }

    /**
     * Evict what the caps no longer cover: stale partials, finished blobs past
     * the age limit, then least-recently-accessed finished blobs until the byte
     * cap holds. Returns how many records were dropped.
     */
    async prune(): Promise<number> {
        const now = this.now()
        let removed = 0
        const finished: BlobRecord[] = []
        for (const record of [...this.records.values()]) {
            if (record.state === 'uploading') {
                if (now - record.lastActivityAt > this.options.stalePartMs) {
                    await this.remove(record.kind, record.id)
                    removed += 1
                }
                continue
            }
            if (now - Math.max(record.readyAt ?? 0, record.lastAccessAt) > this.options.maxAgeMs) {
                await this.remove(record.kind, record.id)
                removed += 1
                continue
            }
            finished.push(record)
        }
        finished.sort((a, b) => a.lastAccessAt - b.lastAccessAt)
        let total = finished.reduce((sum, record) => sum + record.size, 0)
        for (const victim of finished) {
            if (total <= this.options.maxBytes) break
            await this.remove(victim.kind, victim.id)
            total -= victim.size
            removed += 1
        }
        return removed
    }

    private async discard(kind: GeneratedBlobKind, id: string): Promise<void> {
        this.records.delete(blobKey(kind, id))
        this.touched.delete(blobKey(kind, id))
        await rm(this.partPath(kind, id), { force: true }).catch(() => {})
        await rm(this.finalPath(kind, id), { force: true }).catch(() => {})
        await rm(this.metaPath(kind, id), { force: true }).catch(() => {})
    }

    private async writeMeta(record: BlobRecord): Promise<void> {
        const target = this.metaPath(record.kind, record.id)
        const temp = `${target}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
        await writeFile(temp, JSON.stringify(record), 'utf8')
        await rename(temp, target)
    }

    private async scan(): Promise<void> {
        let entries: string[]
        try {
            entries = await readdir(this.dir)
        } catch {
            return
        }
        for (const entry of entries) {
            if (!entry.endsWith('.json')) continue
            let parsed: Partial<BlobRecord>
            try {
                parsed = JSON.parse(await readFile(join(this.dir, entry), 'utf8')) as Partial<BlobRecord>
            } catch {
                continue
            }
            if (!isBlobKind(parsed.kind) || typeof parsed.id !== 'string' || !isSafeBlobId(parsed.id)
                || typeof parsed.size !== 'number' || (parsed.state !== 'ready' && parsed.state !== 'uploading')) {
                continue
            }
            const record: BlobRecord = {
                kind: parsed.kind,
                id: parsed.id,
                sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : null,
                fileName: typeof parsed.fileName === 'string' ? parsed.fileName : parsed.id,
                mimeType: typeof parsed.mimeType === 'string' ? parsed.mimeType : 'application/octet-stream',
                size: parsed.size,
                received: 0,
                state: parsed.state,
                origin: parsed.origin === 'pull' ? 'pull' : 'push',
                sha256: typeof parsed.sha256 === 'string' ? parsed.sha256 : null,
                createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : this.now(),
                readyAt: typeof parsed.readyAt === 'number' ? parsed.readyAt : null,
                lastActivityAt: typeof parsed.lastActivityAt === 'number' ? parsed.lastActivityAt : this.now(),
                lastAccessAt: typeof parsed.lastAccessAt === 'number' ? parsed.lastAccessAt : this.now()
            }
            if (record.state === 'ready') {
                try {
                    const info = await stat(this.finalPath(record.kind, record.id))
                    if (!info.isFile() || info.size !== record.size) {
                        await this.discard(record.kind, record.id)
                        continue
                    }
                    record.received = record.size
                } catch {
                    await this.discard(record.kind, record.id)
                    continue
                }
            } else {
                try {
                    const info = await stat(this.partPath(record.kind, record.id))
                    record.received = Math.min(info.size, record.size)
                    if (info.size > record.size) {
                        // Longer than promised: whatever wrote it lied. Start over.
                        await rm(this.partPath(record.kind, record.id), { force: true })
                        record.received = 0
                    }
                } catch {
                    record.received = 0
                }
            }
            this.records.set(blobKey(record.kind, record.id), record)
        }
    }

    private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
        const previous = this.locks.get(key) ?? Promise.resolve()
        const run = previous.catch(() => {}).then(fn)
        const settled = run.catch(() => {})
        this.locks.set(key, settled)
        try {
            return await run
        } finally {
            if (this.locks.get(key) === settled) {
                this.locks.delete(key)
            }
        }
    }
}
