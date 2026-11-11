import { gzipSync } from 'node:zlib'
import { acceptsGzip } from './sseCompression'

/** Vite emits `name-<hash>.ext`; such files never change under the same URL. */
export function isFingerprintedAsset(relativePath: string): boolean {
    return /(^|\/)assets\//.test(relativePath) && /[-.][a-zA-Z0-9_-]{8,}\.[a-z0-9]+$/.test(relativePath)
}

const COMPRESSIBLE = /^(text\/|application\/(javascript|json|manifest\+json|xml)|image\/svg\+xml)/i
const MIN_COMPRESS_BYTES = 1024
const GZIP_CACHE_LIMIT_BYTES = 64 * 1024 * 1024

// Static files are immutable for a given (path, size, mtime): compress once per
// process. Bounded so a long-lived hub serving several Beta builds cannot grow
// without limit; on overflow the cache simply restarts.
const gzipCache = new Map<string, Uint8Array>()
let gzipCacheBytes = 0

async function gzipped(file: Bun.BunFile, key: string): Promise<Uint8Array> {
    const hit = gzipCache.get(key)
    if (hit) return hit
    const body = gzipSync(new Uint8Array(await file.arrayBuffer()), { level: 9 })
    if (gzipCacheBytes + body.byteLength > GZIP_CACHE_LIMIT_BYTES) {
        gzipCache.clear()
        gzipCacheBytes = 0
    }
    gzipCache.set(key, body)
    gzipCacheBytes += body.byteLength
    return body
}

export async function staticFileResponse(options: {
    filePath: string
    mimeType?: string
    cacheControl: string | null
    acceptEncoding: string | undefined
    head: boolean
    headers?: Record<string, string>
}): Promise<Response> {
    const file = Bun.file(options.filePath)
    const mimeType = options.mimeType || file.type || 'application/octet-stream'
    const headers: Record<string, string> = {
        'content-type': mimeType,
        'x-content-type-options': 'nosniff',
        ...(options.cacheControl ? { 'cache-control': options.cacheControl } : {}),
        ...options.headers,
    }
    const compressible = COMPRESSIBLE.test(mimeType) && file.size >= MIN_COMPRESS_BYTES
    if (compressible) headers.vary = 'Accept-Encoding'
    if (compressible && acceptsGzip(options.acceptEncoding)) {
        const body = await gzipped(file, `${options.filePath}:${file.size}:${file.lastModified}`)
        headers['content-encoding'] = 'gzip'
        headers['content-length'] = String(body.byteLength)
        return new Response(options.head ? null : body, { headers })
    }
    return new Response(options.head ? null : file, { headers })
}
