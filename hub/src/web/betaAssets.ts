import type { Hono } from 'hono'
import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import type { WebAppEnv } from './middleware/auth'

/** Separate SPA assets and service-worker scope; all APIs retain their existing owners. */
export function mountBetaAssets(app: Hono<WebAppEnv>, directory: string): void {
    const root = path.resolve(directory)
    app.get('/beta', c => c.redirect(`/beta/${new URL(c.req.url).search}`, 302))
    app.on(['GET', 'HEAD'], '/beta/*', async c => {
        let relative: string
        try {
            relative = decodeURIComponent(c.req.path.slice('/beta/'.length))
        } catch {
            return c.text('Invalid Beta path', 400)
        }
        if (relative.includes('\0') || relative.includes('\\') || relative.split('/').includes('..')) {
            return c.text('Invalid Beta path', 400)
        }
        const requested = relative || 'index.html'
        const isAsset = path.extname(requested) !== ''
        const requestedPath = path.resolve(root, requested)
        if (requestedPath !== root && !requestedPath.startsWith(`${root}${path.sep}`)) {
            return c.text('Not found', 404)
        }
        let filePath = requestedPath
        try {
            if (!(await fs.stat(filePath)).isFile()) filePath = path.join(root, 'index.html')
        } catch {
            if (isAsset && requested !== 'index.html') return c.text('Beta asset not found', 404)
            filePath = path.join(root, 'index.html')
        }
        try {
            const real = await fs.realpath(filePath)
            const realRoot = await fs.realpath(root)
            if (!real.startsWith(`${realRoot}${path.sep}`)) return c.text('Not found', 404)
            const file = Bun.file(real)
            const isEntry = path.basename(real) === 'index.html'
            const isWorker = path.basename(real) === 'sw.js'
            const isFingerprintAsset = relative.startsWith('assets/') && /[-.][a-zA-Z0-9_-]{8,}\.[a-z0-9]+$/.test(relative)
            return new Response(c.req.method === 'HEAD' ? null : file, {
                headers: {
                    'content-type': file.type || 'application/octet-stream',
                    'cache-control': isEntry || isWorker ? 'no-store' : isFingerprintAsset ? 'public, max-age=31536000, immutable' : 'no-cache',
                    'x-content-type-options': 'nosniff',
                    'x-hapi-ui': 'beta',
                    ...(isWorker ? { 'service-worker-allowed': '/beta/' } : {}),
                },
            })
        } catch (error) {
            if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
                return c.text('Beta assets are not installed on this Hub.', 503)
            }
            throw error
        }
    })
}
