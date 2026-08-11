import { basename, extname, join } from 'path'
import { copyFile, lstat, mkdir, open, readdir, readFile, rename, rm, writeFile } from 'fs/promises'
import { rmSync } from 'node:fs'
import { tmpdir } from 'os'
import { MAX_SOCKET_RPC_BINARY_BYTES } from '@hapi/protocol/socketLimits'
import { detectImageMimeType, detectVideoMimeType } from './generatedImages'

export type GeneratedFileMetadata = {
    id: string
    fileName: string
    snapshotPath: string
    mimeType: string
    size: number
    createdAt: number
}

// Files are snapshotted to disk (not held in memory like generated images) because they
// can be much larger; the snapshot keeps IM semantics: the user downloads the bytes as
// they were when the agent sent the file, even if the original is edited or deleted.
export const MAX_GENERATED_FILE_BYTES = MAX_SOCKET_RPC_BINARY_BYTES
const MAX_GENERATED_FILE_TOTAL_BYTES = 500 * 1024 * 1024
const MAX_GENERATED_FILE_COUNT = 100

const SENT_FILES_DIR_NAME = 'hapi-sent-files'
// Bumped from the old per-PID layout: snapshots now live in one machine-wide
// store keyed only by file id, so they outlive the process that sent them.
const SENT_FILES_STORE_VERSION = 'store-v2'
// Snapshots are reclaimed by age rather than at process exit. A week comfortably
// covers "scroll back up and re-download what the agent sent me", which is the
// case the old exit-time cleanup broke.
const GENERATED_FILE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

const generatedFiles = new Map<string, GeneratedFileMetadata>()
let generatedFileBytes = 0

const MIME_BY_EXTENSION: Record<string, string> = {
    '.pdf': 'application/pdf',
    '.zip': 'application/zip',
    '.tar': 'application/x-tar',
    '.gz': 'application/gzip',
    '.tgz': 'application/gzip',
    '.7z': 'application/x-7z-compressed',
    '.rar': 'application/vnd.rar',
    '.txt': 'text/plain',
    '.log': 'text/plain',
    '.md': 'text/markdown',
    '.json': 'application/json',
    '.csv': 'text/csv',
    '.tsv': 'text/tab-separated-values',
    '.html': 'text/html',
    '.htm': 'text/html',
    '.xml': 'application/xml',
    '.yaml': 'text/yaml',
    '.yml': 'text/yaml',
    '.js': 'text/javascript',
    '.ts': 'text/plain',
    '.py': 'text/x-python',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.webm': 'video/webm',
    '.epub': 'application/epub+zip'
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
    return String.fromCharCode(...bytes.subarray(start, end))
}

function isUtf8Text(bytes: Uint8Array): boolean {
    if (bytes.includes(0)) return false
    try {
        new TextDecoder('utf-8', { fatal: true }).decode(bytes)
        return true
    } catch {
        return false
    }
}

export function detectFileMimeType(fileName: string, bytes?: Uint8Array): string {
    const ext = extname(fileName).toLowerCase()
    if (bytes !== undefined) {
        if (bytes.length === 0) return 'text/plain'
        const image = detectImageMimeType(bytes)
        if (image) return image
        const video = detectVideoMimeType(bytes)
        if (video) return video

        if (bytes.length >= 5 && ascii(bytes, 0, 5) === '%PDF-') return 'application/pdf'
        if (bytes.length >= 4 && ascii(bytes, 0, 4) === 'PK\x03\x04') {
            if (ext === '.docx') return MIME_BY_EXTENSION['.docx']
            if (ext === '.xlsx') return MIME_BY_EXTENSION['.xlsx']
            if (ext === '.pptx') return MIME_BY_EXTENSION['.pptx']
            if (ext === '.epub') return MIME_BY_EXTENSION['.epub']
            return 'application/zip'
        }
        if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) return 'application/gzip'
        if (bytes.length >= 6 && ascii(bytes, 0, 6) === '7z\xbc\xaf\x27\x1c') return 'application/x-7z-compressed'
        if (bytes.length >= 7 && (ascii(bytes, 0, 7) === 'Rar!\x1a\x07\x00' || ascii(bytes, 0, 7) === 'Rar!\x1a\x07\x01')) return 'application/vnd.rar'
        if (bytes.length >= 8
            && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0
            && bytes[4] === 0xa1 && bytes[5] === 0xb1 && bytes[6] === 0x1a && bytes[7] === 0xe1) {
            if (ext === '.doc' || ext === '.xls' || ext === '.ppt') return MIME_BY_EXTENSION[ext]
            return 'application/x-ole-storage'
        }
        if (bytes.length >= 262 && ascii(bytes, 257, 262) === 'ustar') return 'application/x-tar'
        if (bytes.length >= 4 && ascii(bytes, 0, 4) === 'RIFF') {
            if (bytes.length >= 12 && ascii(bytes, 8, 12) === 'WAVE') return 'audio/wav'
        }
        if (bytes.length >= 3 && ascii(bytes, 0, 3) === 'ID3') return 'audio/mpeg'

        if (isUtf8Text(bytes)) {
            const text = new TextDecoder().decode(bytes).trimStart().toLowerCase()
            if (text.startsWith('<!doctype html') || text.startsWith('<html')) return 'text/html'
            if (text.startsWith('<?xml')) return ext === '.svg' ? 'image/svg+xml' : 'application/xml'
            if (ext === '.json' && (text.startsWith('{') || text.startsWith('['))) return 'application/json'
            const textMime = MIME_BY_EXTENSION[ext]
            return textMime?.startsWith('text/') ? textMime : 'text/plain'
        }

        return 'application/octet-stream'
    }
    return MIME_BY_EXTENSION[ext] ?? 'application/octet-stream'
}

async function readFileHeader(path: string, size: number): Promise<Buffer> {
    const handle = await open(path, 'r')
    try {
        const header = Buffer.alloc(Math.min(size, 8192))
        const { bytesRead } = await handle.read(header, 0, header.length, 0)
        return header.subarray(0, bytesRead)
    } finally {
        await handle.close()
    }
}

/**
 * One store per machine, **not per process**.
 *
 * The snapshot directory used to be `<tmp>/hapi-sent-files/<pid>` with an
 * `exit` hook that deleted it. That made every previously sent file card 404
 * the moment the session process went away — a CLI upgrade, a runner restart,
 * or a crash silently invalidated the entire scrollback, even when the session
 * itself was auto-resumed and looked alive. Keying by id alone lets the
 * *replacement* process keep serving snapshots the *previous* one wrote.
 */
function getSentFilesDir(): string {
    return join(tmpdir(), SENT_FILES_DIR_NAME, SENT_FILES_STORE_VERSION)
}

/** Snapshot ids reach the filesystem, so refuse anything that is not an opaque
 *  token (uuids in practice) rather than trusting the caller. */
function isSafeId(id: string): boolean {
    return /^[A-Za-z0-9._-]{1,128}$/.test(id) && !id.includes('..')
}

function getSidecarPath(id: string): string {
    return join(getSentFilesDir(), `${id}.meta.json`)
}

type PersistedMetadata = Omit<GeneratedFileMetadata, 'snapshotPath'> & { snapshotFileName: string }

/** Write the sidecar via temp+rename so a concurrent reader never observes a
 *  half-written record (several session processes share this directory). */
async function writeSidecar(metadata: GeneratedFileMetadata): Promise<void> {
    const persisted: PersistedMetadata = {
        id: metadata.id,
        fileName: metadata.fileName,
        snapshotFileName: basename(metadata.snapshotPath),
        mimeType: metadata.mimeType,
        size: metadata.size,
        createdAt: metadata.createdAt
    }
    const target = getSidecarPath(metadata.id)
    const temp = `${target}.${process.pid}.tmp`
    await writeFile(temp, JSON.stringify(persisted), 'utf8')
    await rename(temp, target)
}

async function readSidecar(id: string): Promise<GeneratedFileMetadata | null> {
    try {
        const parsed = JSON.parse(await readFile(getSidecarPath(id), 'utf8')) as PersistedMetadata
        if (!parsed || typeof parsed.snapshotFileName !== 'string' || typeof parsed.size !== 'number') {
            return null
        }
        return {
            id: parsed.id,
            fileName: parsed.fileName,
            snapshotPath: join(getSentFilesDir(), parsed.snapshotFileName),
            mimeType: parsed.mimeType,
            size: parsed.size,
            createdAt: parsed.createdAt
        }
    } catch {
        return null
    }
}

async function removePersisted(metadata: GeneratedFileMetadata): Promise<void> {
    await rm(metadata.snapshotPath, { force: true }).catch(() => {})
    await rm(getSidecarPath(metadata.id), { force: true }).catch(() => {})
}

/**
 * Reclaim the shared store: drop anything past the age limit, then trim oldest
 * first until the count and byte caps hold. Runs after each registration rather
 * than at exit, because exit-time cleanup is exactly what used to destroy
 * still-referenced snapshots.
 */
async function pruneStore(): Promise<void> {
    let entries: string[]
    try {
        entries = await readdir(getSentFilesDir())
    } catch {
        return
    }

    const records: GeneratedFileMetadata[] = []
    for (const entry of entries) {
        if (!entry.endsWith('.meta.json')) continue
        const id = entry.slice(0, -'.meta.json'.length)
        const metadata = await readSidecar(id)
        if (metadata) records.push(metadata)
    }

    const now = Date.now()
    const survivors: GeneratedFileMetadata[] = []
    for (const record of records) {
        if (now - record.createdAt > GENERATED_FILE_MAX_AGE_MS) {
            await removePersisted(record)
            generatedFiles.delete(record.id)
        } else {
            survivors.push(record)
        }
    }

    survivors.sort((a, b) => a.createdAt - b.createdAt)
    let totalBytes = survivors.reduce((sum, record) => sum + record.size, 0)
    let index = 0
    while (index < survivors.length
        && (survivors.length - index > MAX_GENERATED_FILE_COUNT || totalBytes > MAX_GENERATED_FILE_TOTAL_BYTES)) {
        const victim = survivors[index++]
        totalBytes -= victim.size
        await removePersisted(victim)
        generatedFiles.delete(victim.id)
    }

    generatedFileBytes = totalBytes
}

function sanitizeFileName(fileName: string): string {
    const sanitized = fileName
        .replace(/[/\\]/g, '_')
        .replace(/\.\./g, '_')
        .replace(/\s+/g, '_')
        .slice(0, 255)
    return sanitized || 'file'
}

/** Wipe the whole shared store. Deliberately **not** wired to process exit any
 *  more — that hook is what used to invalidate every sent file on restart. */
function cleanupSentFilesSync(): void {
    generatedFiles.clear()
    generatedFileBytes = 0
    try {
        rmSync(getSentFilesDir(), { recursive: true, force: true })
    } catch {
        // best effort
    }
}

export async function registerGeneratedFile(args: { id: string; path: string; fileName?: string | null }): Promise<GeneratedFileMetadata> {
    const info = await lstat(args.path)
    if (!info.isFile()) {
        throw new Error('Path is not a regular file')
    }
    if (info.size > MAX_GENERATED_FILE_BYTES) {
        throw new Error(`File is too large to send (max ${MAX_GENERATED_FILE_BYTES} bytes)`)
    }
    if (!isSafeId(args.id)) {
        throw new Error('Invalid generated file id')
    }

    const baseName = basename(args.path) || args.id
    let fileName = sanitizeFileName(args.fileName || baseName)
    // A custom display title often omits the extension; keep the source file's
    // extension so downloads stay openable and mime detection keeps working.
    if (!extname(fileName) && extname(baseName)) {
        fileName = `${fileName}${extname(baseName)}`
    }
    const dir = getSentFilesDir()
    await mkdir(dir, { recursive: true })
    const snapshotPath = join(dir, `${args.id}-${fileName}`)
    try {
        await copyFile(args.path, snapshotPath)
        const snapshotInfo = await lstat(snapshotPath)
        if (!snapshotInfo.isFile()) {
            throw new Error('Snapshot path is not a regular file')
        }
        if (snapshotInfo.size > MAX_GENERATED_FILE_BYTES) {
            throw new Error(`File is too large to send (max ${MAX_GENERATED_FILE_BYTES} bytes)`)
        }
        const header = await readFileHeader(snapshotPath, snapshotInfo.size)

        const metadata: GeneratedFileMetadata = {
            id: args.id,
            fileName,
            snapshotPath,
            mimeType: detectFileMimeType(fileName, header),
            size: snapshotInfo.size,
            createdAt: Date.now()
        }
        generatedFiles.set(args.id, metadata)
        generatedFileBytes += snapshotInfo.size

        // Sidecar first, then prune: the record must be discoverable from disk
        // before anything else in the store is reclaimed.
        await writeSidecar(metadata)
        await pruneStore()

        return metadata
    } catch (error) {
        await rm(snapshotPath, { force: true })
        throw error
    }
}

/** Synchronous, in-memory-only lookup — the sending process's own view. */
export function getGeneratedFile(id: string): GeneratedFileMetadata | null {
    return generatedFiles.get(id) ?? null
}

/**
 * Resolve a snapshot from this process's memory **or** from the shared on-disk
 * store. The disk path is what lets a restarted session keep serving files an
 * earlier process sent; without it every card sent before the restart 404s.
 */
export async function loadGeneratedFile(id: string): Promise<GeneratedFileMetadata | null> {
    const cached = generatedFiles.get(id)
    if (cached) return cached
    if (!isSafeId(id)) return null

    const persisted = await readSidecar(id)
    if (!persisted) return null
    // The sidecar can outlive its snapshot (interrupted prune, tmp reaper).
    // Verify the bytes are actually there before promising them to the hub.
    try {
        const info = await lstat(persisted.snapshotPath)
        if (!info.isFile()) return null
        if (info.size !== persisted.size) return null
    } catch {
        return null
    }
    generatedFiles.set(id, persisted)
    return persisted
}

export async function unregisterGeneratedFile(id: string): Promise<void> {
    const file = generatedFiles.get(id) ?? await readSidecar(id)
    if (!file) return
    if (generatedFiles.delete(id)) {
        generatedFileBytes -= file.size
    }
    await removePersisted(file)
}

/**
 * Read one slice of a snapshot. Chunking is what makes large transfers
 * survivable: each slice gets its own RPC budget and can be retried on its own,
 * instead of one 14 MB frame having to clear a 30 s deadline or be lost.
 */
export async function readGeneratedFileChunk(
    id: string,
    offset: number,
    length: number
): Promise<{ metadata: GeneratedFileMetadata; bytes: Buffer } | null> {
    const metadata = await loadGeneratedFile(id)
    if (!metadata) return null

    const start = Math.max(0, Math.min(Math.floor(offset), metadata.size))
    const count = Math.max(0, Math.min(Math.floor(length), metadata.size - start))
    if (count === 0) {
        return { metadata, bytes: Buffer.alloc(0) }
    }

    const handle = await open(metadata.snapshotPath, 'r')
    try {
        const buffer = Buffer.alloc(count)
        const { bytesRead } = await handle.read(buffer, 0, count, start)
        return { metadata, bytes: buffer.subarray(0, bytesRead) }
    } finally {
        await handle.close()
    }
}

/** Test-only: drop both the in-memory registry and the on-disk store. */
export function clearGeneratedFiles(): void {
    cleanupSentFilesSync()
}

/** Test-only: forget this process's cache while leaving the on-disk store
 *  intact — i.e. exactly what a session process restart looks like. */
export function __forgetGeneratedFilesInMemoryForTests(): void {
    generatedFiles.clear()
    generatedFileBytes = 0
}
