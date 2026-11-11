import { afterEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { Hono } from 'hono'
import { mountBetaAssets } from './betaAssets'
import type { WebAppEnv } from './middleware/auth'

const directories: string[] = []
afterEach(async () => {
    await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })))
})

async function fixture() {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hapi-beta-assets-'))
    directories.push(directory)
    await Bun.write(path.join(directory, 'index.html'), '<main>beta-chat</main>')
    await Bun.write(path.join(directory, 'assets', 'chat-12345678.js'), 'globalThis.beta = true')
    await Bun.write(path.join(directory, 'assets', 'big-abcdefgh.js'), `globalThis.big = "${'x'.repeat(4096)}"`)
    await Bun.write(path.join(directory, 'sw.js'), 'self.addEventListener("fetch", () => {})')
    const app = new Hono<WebAppEnv>()
    mountBetaAssets(app, directory)
    app.get('*', c => c.text('production'))
    return app
}

describe('isolated beta asset routes', () => {
    it('serves Beta deep links without changing the production entry or claiming missing chunks', async () => {
        const app = await fixture()
        expect(await (await app.request('/')).text()).toBe('production')
        const deep = await app.request('/beta/sessions/example')
        expect(await deep.text()).toBe('<main>beta-chat</main>')
        expect(deep.headers.get('x-hapi-ui')).toBe('beta')
        expect(deep.headers.get('cache-control')).toBe('no-store')
        expect((await app.request('/beta/assets/missing.js')).status).toBe(404)
        expect((await app.request('/beta?test=1')).headers.get('location')).toBe('/beta/?test=1')
    })

    it('limits service-worker scope and does not cache the entry as immutable', async () => {
        const app = await fixture()
        const worker = await app.request('/beta/sw.js')
        expect(worker.headers.get('service-worker-allowed')).toBe('/beta/')
        expect(worker.headers.get('cache-control')).toBe('no-store')
        const chunk = await app.request('/beta/assets/chat-12345678.js')
        expect(await chunk.text()).toBe('globalThis.beta = true')
        expect(chunk.headers.get('cache-control')).toContain('immutable')
        const head = await app.request('/beta/sw.js', { method: 'HEAD' })
        expect(await head.text()).toBe('')
        expect(head.headers.get('service-worker-allowed')).toBe('/beta/')
    })

    it('rejects encoded path separators that could escape the Beta asset root', async () => {
        const app = await fixture()
        expect((await app.request('/beta/%2e%2e%2fsecret.txt')).status).toBe(400)
        expect((await app.request('/beta/%5csecret.txt')).status).toBe(400)
    })

    it('gzips compressible assets only for clients that accept gzip', async () => {
        const app = await fixture()
        const gz = await app.request('/beta/assets/big-abcdefgh.js', { headers: { 'accept-encoding': 'gzip, br' } })
        expect(gz.headers.get('content-encoding')).toBe('gzip')
        expect(gz.headers.get('vary')).toBe('Accept-Encoding')
        expect(gz.headers.get('cache-control')).toContain('immutable')
        const body = new Uint8Array(await gz.arrayBuffer())
        expect(new TextDecoder().decode(Bun.gunzipSync(body))).toContain('globalThis.big')
        expect(body.byteLength).toBeLessThan(4096)
        const refused = await app.request('/beta/assets/big-abcdefgh.js', { headers: { 'accept-encoding': 'gzip;q=0' } })
        expect(refused.headers.get('content-encoding')).toBeNull()
        expect(await refused.text()).toContain('globalThis.big')
    })
})
