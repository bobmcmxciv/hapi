import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import type { Session, SyncEngine } from '../../sync/syncEngine'
import { RpcTargetMissingError } from '../../sync/rpcGateway'
import type { WebAppEnv } from '../middleware/auth'
import { createAuthMiddleware } from '../middleware/auth'
import { createGitRoutes, parseSingleByteRange } from './git'

const JWT_SECRET = new TextEncoder().encode('generated-media-route-test')

async function authHeaders(namespace: string): Promise<{ authorization: string }> {
    const token = await new SignJWT({ uid: 1, ns: namespace })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(JWT_SECRET)
    return { authorization: `Bearer ${token}` }
}

function buildApp(engine: Partial<SyncEngine>): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => {
        c.set('namespace', 'default')
        await next()
    })
    app.route('/api', createGitRoutes(() => engine as SyncEngine))
    return app
}

function buildAuthenticatedApp(engine: Partial<SyncEngine>): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()
    app.use('*', createAuthMiddleware(JWT_SECRET))
    app.route('/api', createGitRoutes(() => engine as SyncEngine))
    return app
}

describe('session file route', () => {
    it('forwards an optimistic file write to the session RPC', async () => {
        const session = { id: 'session-1', namespace: 'default', active: true } as unknown as Session
        const calls: unknown[][] = []
        const engine = {
            resolveSessionAccess: () => ({ ok: true as const, sessionId: 'session-1', session }),
            writeSessionFile: async (...args: unknown[]) => {
                calls.push(args)
                return { success: true, hash: 'b'.repeat(64) }
            }
        } as unknown as Partial<SyncEngine>

        const response = await buildApp(engine).request('/api/sessions/session-1/file', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                path: 'README.md',
                content: Buffer.from('# updated').toString('base64'),
                expectedHash: 'a'.repeat(64)
            })
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ success: true, hash: 'b'.repeat(64) })
        expect(calls).toEqual([[
            'session-1',
            'README.md',
            Buffer.from('# updated').toString('base64'),
            'a'.repeat(64)
        ]])
    })

    it('rejects a write without a content hash', async () => {
        const session = { id: 'session-1', namespace: 'default', active: true } as unknown as Session
        const engine = {
            resolveSessionAccess: () => ({ ok: true as const, sessionId: 'session-1', session })
        } as unknown as Partial<SyncEngine>

        const response = await buildApp(engine).request('/api/sessions/session-1/file', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: 'README.md', content: 'dGVzdA==' })
        })

        expect(response.status).toBe(400)
    })
})

describe('generated images route', () => {
    it('serves generated images with an immutable cache header instead of no-store', async () => {
        const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
        const session = { id: 'session-1', namespace: 'default', active: true } as unknown as Session
        const engine = {
            resolveSessionAccess: () => ({ ok: true as const, sessionId: 'session-1', session }),
            readGeneratedImage: async () => ({
                success: true,
                content: pngBytes.toString('base64'),
                mimeType: 'image/png',
                fileName: 'shot.png'
            })
        } as unknown as Partial<SyncEngine>

        const response = await buildApp(engine).request('/api/sessions/session-1/generated-images/img-1')

        expect(response.status).toBe(200)
        const cacheControl = response.headers.get('cache-control') ?? ''
        // Generated images are content-addressed by an immutable random id, so they must be
        // cacheable; `no-store` forces a full RPC round-trip on every remount (issue #927).
        expect(cacheControl).toContain('immutable')
        expect(cacheControl).not.toContain('no-store')
        expect(response.headers.get('etag')).toBe('"img-1"')
    })

    it('returns 304 without an RPC round-trip when If-None-Match matches', async () => {
        const session = { id: 'session-1', namespace: 'default', active: true } as unknown as Session
        let rpcCalls = 0
        const engine = {
            resolveSessionAccess: () => ({ ok: true as const, sessionId: 'session-1', session }),
            readGeneratedImage: async () => {
                rpcCalls += 1
                return { success: true, content: '', mimeType: 'image/png', fileName: 'shot.png' }
            }
        } as unknown as Partial<SyncEngine>

        const response = await buildApp(engine).request('/api/sessions/session-1/generated-images/img-1', {
            headers: { 'if-none-match': '"img-1"' }
        })

        expect(response.status).toBe(304)
        // The whole point: a cache hit must not touch the CLI over the socket.
        expect(rpcCalls).toBe(0)
    })

    it('serves registered MP4 bytes with their video MIME type', async () => {
        const mp4Bytes = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d])
        const session = { id: 'session-1', namespace: 'default', active: true } as unknown as Session
        const engine = {
            resolveSessionAccess: () => ({ ok: true as const, sessionId: 'session-1', session }),
            readGeneratedImage: async () => ({
                success: true,
                content: mp4Bytes.toString('base64'),
                mimeType: 'video/mp4',
                fileName: 'recording.mp4'
            })
        } as unknown as Partial<SyncEngine>

        const response = await buildApp(engine).request('/api/sessions/session-1/generated-images/video-1')

        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toBe('video/mp4')
        expect(Buffer.from(await response.arrayBuffer())).toEqual(mp4Bytes)
    })

    it('requires JWT auth and enforces namespace-scoped session access', async () => {
        const engine = {
            resolveSessionAccess: (_sessionId: string, namespace: string) => namespace === 'owner'
                ? {
                    ok: true as const,
                    sessionId: 'session-1',
                    session: { id: 'session-1', namespace: 'owner', active: true } as unknown as Session
                }
                : { ok: false as const, reason: 'access-denied' as const }
        } as unknown as Partial<SyncEngine>
        const app = buildAuthenticatedApp(engine)

        const missingAuth = await app.request('/api/sessions/session-1/generated-images/img-1')
        const wrongNamespace = await app.request('/api/sessions/session-1/generated-images/img-1', {
            headers: await authHeaders('other')
        })

        expect(missingAuth.status).toBe(401)
        expect(wrongNamespace.status).toBe(403)
    })
})
describe('generated files route', () => {
    it('serves a valid empty sent file instead of treating empty base64 as missing', async () => {
        const session = { id: 'session-1', namespace: 'default', active: true } as unknown as Session
        const engine = {
            resolveSessionAccess: () => ({ ok: true as const, sessionId: 'session-1', session }),
            readGeneratedFile: async () => ({
                success: true,
                content: '',
                mimeType: 'text/plain',
                fileName: 'empty.txt',
                size: 0
            })
        } as unknown as Partial<SyncEngine>

        const response = await buildApp(engine).request('/api/sessions/session-1/generated-files/empty-file')

        expect(response.status).toBe(200)
        expect(await response.arrayBuffer()).toHaveLength(0)
    })

    it('serves sent files as attachments with immutable caching', async () => {
        const fileBytes = Buffer.from('hello report')
        const session = { id: 'session-1', namespace: 'default', active: true } as unknown as Session
        const engine = {
            resolveSessionAccess: () => ({ ok: true as const, sessionId: 'session-1', session }),
            readGeneratedFile: async () => ({
                success: true,
                content: fileBytes.toString('base64'),
                mimeType: 'application/pdf',
                fileName: 'report.pdf',
                size: fileBytes.byteLength
            })
        } as unknown as Partial<SyncEngine>

        const response = await buildApp(engine).request('/api/sessions/session-1/generated-files/file-1')

        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toContain('application/pdf')
        expect(response.headers.get('content-disposition') ?? '').toContain('attachment')
        expect(response.headers.get('content-disposition') ?? '').toContain('report.pdf')
        const cacheControl = response.headers.get('cache-control') ?? ''
        expect(cacheControl).toContain('immutable')
        expect(response.headers.get('etag')).toBe('"file-1"')
        expect(Buffer.from(await response.arrayBuffer()).toString()).toBe('hello report')
    })

    it('returns 304 without an RPC round-trip when If-None-Match matches', async () => {
        const session = { id: 'session-1', namespace: 'default', active: true } as unknown as Session
        let rpcCalls = 0
        const engine = {
            resolveSessionAccess: () => ({ ok: true as const, sessionId: 'session-1', session }),
            readGeneratedFile: async () => {
                rpcCalls += 1
                return { success: true, content: '', mimeType: 'application/pdf', fileName: 'report.pdf' }
            }
        } as unknown as Partial<SyncEngine>

        const response = await buildApp(engine).request('/api/sessions/session-1/generated-files/file-1', {
            headers: { 'if-none-match': '"file-1"' }
        })

        expect(response.status).toBe(304)
        expect(rpcCalls).toBe(0)
    })

    it('returns 404 when the sent file is gone from the CLI', async () => {
        const session = { id: 'session-1', namespace: 'default', active: true } as unknown as Session
        const engine = {
            resolveSessionAccess: () => ({ ok: true as const, sessionId: 'session-1', session }),
            readGeneratedFile: async () => ({ success: false, error: 'Sent file not found' })
        } as unknown as Partial<SyncEngine>

        const response = await buildApp(engine).request('/api/sessions/session-1/generated-files/file-1')

        expect(response.status).toBe(404)
    })
})

// A 14 MB file used to have to clear a single 30 s RPC budget or be reported as
// missing: 52 downloads on the production hub returned `404` after exactly
// `30s` between 2026-08-01 and 08-12. These pin the chunked replacement.
describe('chunked generated blob transfer', () => {
    const session = { id: 'session-1', namespace: 'default', active: true } as unknown as Session

    /** Engine backed by real bytes, served through the chunk RPC. */
    function chunkEngine(payload: Buffer, options: { chunkCalls?: number[]; failAt?: number; failWith?: Error } = {}) {
        return {
            resolveSessionAccess: () => ({ ok: true as const, sessionId: 'session-1', session }),
            readGeneratedFile: async () => ({ success: false, error: 'legacy path must not be used' }),
            readGeneratedBlobChunk: async (_sessionId: string, request: { offset: number; length: number }) => {
                options.chunkCalls?.push(request.offset)
                if (options.failAt !== undefined && request.offset === options.failAt) {
                    throw options.failWith ?? new Error('operation has timed out')
                }
                const slice = payload.subarray(request.offset, request.offset + request.length)
                return {
                    success: true,
                    content: slice.toString('base64'),
                    offset: request.offset,
                    size: payload.byteLength,
                    mimeType: 'application/pdf',
                    fileName: 'report.pdf'
                }
            }
        } as unknown as Partial<SyncEngine>
    }

    it('streams a blob larger than one chunk back in full', async () => {
        // 5 MiB against a 2 MiB chunk size: three slices, one of them partial.
        const payload = Buffer.alloc(5 * 1024 * 1024)
        for (let i = 0; i < payload.length; i++) payload[i] = i % 251
        const chunkCalls: number[] = []

        const response = await buildApp(chunkEngine(payload, { chunkCalls }))
            .request('/api/sessions/session-1/generated-files/file-1')

        expect(response.status).toBe(200)
        expect(response.headers.get('content-length')).toBe(String(payload.byteLength))
        expect(response.headers.get('accept-ranges')).toBe('bytes')
        const received = Buffer.from(await response.arrayBuffer())
        expect(received.byteLength).toBe(payload.byteLength)
        expect(received.equals(payload)).toBe(true)
        // The probe read is reused, so the transfer costs ceil(size/chunk) calls, not one more.
        expect(chunkCalls).toEqual([0, 2 * 1024 * 1024, 4 * 1024 * 1024])
    })

    it('retries a stalled chunk instead of failing the whole download', async () => {
        const payload = Buffer.alloc(3 * 1024 * 1024, 7)
        const chunkCalls: number[] = []
        let thrown = 0
        const engine = {
            resolveSessionAccess: () => ({ ok: true as const, sessionId: 'session-1', session }),
            readGeneratedBlobChunk: async (_sessionId: string, request: { offset: number; length: number }) => {
                chunkCalls.push(request.offset)
                // The second slice times out once, exactly like the tail of the
                // latency distribution that used to void the entire transfer.
                if (request.offset === 2 * 1024 * 1024 && thrown++ === 0) {
                    throw new Error('operation has timed out')
                }
                const slice = payload.subarray(request.offset, request.offset + request.length)
                return {
                    success: true,
                    content: slice.toString('base64'),
                    offset: request.offset,
                    size: payload.byteLength,
                    mimeType: 'application/pdf',
                    fileName: 'report.pdf'
                }
            }
        } as unknown as Partial<SyncEngine>

        const response = await buildApp(engine).request('/api/sessions/session-1/generated-files/file-1')

        expect(response.status).toBe(200)
        const received = Buffer.from(await response.arrayBuffer())
        expect(received.byteLength).toBe(payload.byteLength)
        expect(received.equals(payload)).toBe(true)
        expect(chunkCalls.filter((offset) => offset === 2 * 1024 * 1024)).toHaveLength(2)
    })

    it('answers a Range request with 206 and only the requested bytes', async () => {
        const payload = Buffer.from('0123456789abcdef')

        const response = await buildApp(chunkEngine(payload)).request(
            '/api/sessions/session-1/generated-files/file-1',
            { headers: { range: 'bytes=4-9' } }
        )

        expect(response.status).toBe(206)
        expect(response.headers.get('content-range')).toBe('bytes 4-9/16')
        expect(response.headers.get('content-length')).toBe('6')
        expect(Buffer.from(await response.arrayBuffer()).toString()).toBe('456789')
    })

    it('rejects an unsatisfiable Range with 416 rather than a wrong body', async () => {
        const payload = Buffer.from('short')

        const response = await buildApp(chunkEngine(payload)).request(
            '/api/sessions/session-1/generated-files/file-1',
            { headers: { range: 'bytes=99-200' } }
        )

        expect(response.status).toBe(416)
        expect(response.headers.get('content-range')).toBe('bytes */5')
    })

    // The heart of the bug: a transport failure was indistinguishable from a
    // deleted file, so the UI and the logs both said "not found" for what was
    // really an unreachable machine or an exhausted deadline.
    it('reports a timed-out transfer as 504, not as a missing file', async () => {
        const engine = {
            resolveSessionAccess: () => ({ ok: true as const, sessionId: 'session-1', session }),
            readGeneratedBlobChunk: async () => { throw new Error('operation has timed out') }
        } as unknown as Partial<SyncEngine>

        const response = await buildApp(engine).request('/api/sessions/session-1/generated-files/file-1')

        expect(response.status).toBe(504)
        expect(await response.json()).toMatchObject({ reason: 'timeout', retryable: true })
    })

    it('reports a disconnected CLI as 503, not as a missing file', async () => {
        const engine = {
            resolveSessionAccess: () => ({ ok: true as const, sessionId: 'session-1', session }),
            readGeneratedBlobChunk: async () => {
                throw new RpcTargetMissingError('readGeneratedBlobChunk', 'socket-disconnected')
            }
        } as unknown as Partial<SyncEngine>

        const response = await buildApp(engine).request('/api/sessions/session-1/generated-files/file-1')

        expect(response.status).toBe(503)
        expect(await response.json()).toMatchObject({ reason: 'session-offline', retryable: true })
    })

    it('still reports a genuinely deleted snapshot as 404', async () => {
        const engine = {
            resolveSessionAccess: () => ({ ok: true as const, sessionId: 'session-1', session }),
            readGeneratedBlobChunk: async () => ({ success: false, error: 'Sent file not found' })
        } as unknown as Partial<SyncEngine>

        const response = await buildApp(engine).request('/api/sessions/session-1/generated-files/file-1')

        expect(response.status).toBe(404)
        expect(await response.json()).toMatchObject({ reason: 'not-found', retryable: false })
    })

    it('falls back to the whole-blob read when the CLI predates chunked transfer', async () => {
        const payload = Buffer.from('legacy bytes')
        let legacyCalls = 0
        const engine = {
            resolveSessionAccess: () => ({ ok: true as const, sessionId: 'session-1', session }),
            readGeneratedBlobChunk: async () => {
                throw new RpcTargetMissingError('readGeneratedBlobChunk', 'handler-not-registered')
            },
            readGeneratedFile: async () => {
                legacyCalls += 1
                return {
                    success: true,
                    content: payload.toString('base64'),
                    mimeType: 'application/pdf',
                    fileName: 'report.pdf',
                    size: payload.byteLength
                }
            }
        } as unknown as Partial<SyncEngine>

        const response = await buildApp(engine).request('/api/sessions/session-1/generated-files/file-1')

        expect(response.status).toBe(200)
        expect(legacyCalls).toBe(1)
        expect(Buffer.from(await response.arrayBuffer()).toString()).toBe('legacy bytes')
    })

    it('serves generated images over the same chunked path', async () => {
        const payload = Buffer.alloc(3 * 1024 * 1024, 0x42)
        const engine = {
            resolveSessionAccess: () => ({ ok: true as const, sessionId: 'session-1', session }),
            readGeneratedBlobChunk: async (_sessionId: string, request: { kind: string; offset: number; length: number }) => {
                expect(request.kind).toBe('image')
                const slice = payload.subarray(request.offset, request.offset + request.length)
                return {
                    success: true,
                    content: slice.toString('base64'),
                    offset: request.offset,
                    size: payload.byteLength,
                    mimeType: 'image/png',
                    fileName: 'shot.png'
                }
            }
        } as unknown as Partial<SyncEngine>

        const response = await buildApp(engine).request('/api/sessions/session-1/generated-images/img-1')

        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toBe('image/png')
        expect(response.headers.get('content-disposition') ?? '').toContain('inline')
        expect(Buffer.from(await response.arrayBuffer()).byteLength).toBe(payload.byteLength)
    })
})

describe('parseSingleByteRange', () => {
    it('parses closed, open and suffix ranges', () => {
        expect(parseSingleByteRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 })
        expect(parseSingleByteRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 })
        expect(parseSingleByteRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 })
        // An end past EOF is clamped rather than rejected (RFC 9110 §14.1.2).
        expect(parseSingleByteRange('bytes=95-500', 100)).toEqual({ start: 95, end: 99 })
    })

    it('ignores headers it cannot honour and flags impossible ones', () => {
        expect(parseSingleByteRange(undefined, 100)).toBeNull()
        expect(parseSingleByteRange('items=0-9', 100)).toBeNull()
        // Multi-range is not supported, so it is treated as no range at all.
        expect(parseSingleByteRange('bytes=0-9,20-29', 100)).toBeNull()
        expect(parseSingleByteRange('bytes=-', 100)).toBeNull()
        expect(parseSingleByteRange('bytes=100-200', 100)).toBe('unsatisfiable')
        expect(parseSingleByteRange('bytes=9-4', 100)).toBe('unsatisfiable')
    })
})

describe('file search route', () => {
    it('adds size and modification metadata to search results', async () => {
        const session = {
            id: 'session-1',
            namespace: 'default',
            active: true,
            metadata: { path: '/project' }
        } as unknown as Session
        const engine = {
            resolveSessionAccess: () => ({ ok: true as const, sessionId: 'session-1', session }),
            runRipgrep: async () => ({
                success: true,
                stdout: 'src/large.txt\nsrc/small.txt\n'
            }),
            statFiles: async (_sessionId: string, paths: string[]) => ({
                success: true,
                entries: paths.map((path, index) => ({ path, size: index ? 10 : 500, modified: index ? 100 : 200 }))
            })
        } as unknown as Partial<SyncEngine>

        const response = await buildApp(engine).request('/api/sessions/session-1/files?query=.txt')
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            success: true,
            files: [
                { fileName: 'large.txt', filePath: 'src', fullPath: 'src/large.txt', fileType: 'file', size: 500, modified: 200 },
                { fileName: 'small.txt', filePath: 'src', fullPath: 'src/small.txt', fileType: 'file', size: 10, modified: 100 },
            ]
        })
    })

    it('normalizes ripgrep path separators before deriving file names and directories', async () => {
        const session = {
            id: 'session-1',
            namespace: 'default',
            active: true,
            metadata: { path: 'C:\\project' }
        } as unknown as Session
        const engine = {
            resolveSessionAccess: () => ({ ok: true as const, sessionId: 'session-1', session }),
            runRipgrep: async () => ({
                success: true,
                stdout: 'src\\nested\\file.ts\nroot.ts\n'
            }),
            statFiles: async (_sessionId: string, paths: string[]) => ({
                success: true,
                entries: paths.map((path) => ({ path, size: 10, modified: 100 }))
            })
        } as unknown as Partial<SyncEngine>

        const response = await buildApp(engine).request('/api/sessions/session-1/files?query=.ts')

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            success: true,
            files: [
                { fileName: 'file.ts', filePath: 'src/nested', fullPath: 'src/nested/file.ts', fileType: 'file', size: 10, modified: 100 },
                { fileName: 'root.ts', filePath: '', fullPath: 'root.ts', fileType: 'file', size: 10, modified: 100 },
            ]
        })
    })

    it('preserves backslashes in file names for non-Windows sessions', async () => {
        const session = {
            id: 'session-1',
            namespace: 'default',
            active: true,
            metadata: { path: '/project' }
        } as unknown as Session
        const engine = {
            resolveSessionAccess: () => ({ ok: true as const, sessionId: 'session-1', session }),
            runRipgrep: async () => ({
                success: true,
                stdout: 'src/file\\name.ts\n'
            }),
            statFiles: async (_sessionId: string, paths: string[]) => ({
                success: true,
                entries: paths.map((path) => ({ path, size: 10, modified: 100 }))
            })
        } as unknown as Partial<SyncEngine>

        const response = await buildApp(engine).request('/api/sessions/session-1/files?query=.ts')

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            success: true,
            files: [
                { fileName: 'file\\name.ts', filePath: 'src', fullPath: 'src/file\\name.ts', fileType: 'file', size: 10, modified: 100 },
            ]
        })
    })
})
