/// <reference lib="webworker" />
import { cleanupOutdatedCaches, createHandlerBoundToURL, getCacheKeyForURL, precacheAndRoute } from 'workbox-precaching'
import { NavigationRoute, registerRoute } from 'workbox-routing'
import { CacheFirst, NetworkFirst } from 'workbox-strategies'
import { ExpirationPlugin } from 'workbox-expiration'
import {
    cleanupExpiredShareTransfers,
    ingestShareRequest,
    putShareTransfer,
} from './lib/shareTransfer'
import { shareTargetPathname } from './lib/sharePath'

const sharePath = shareTargetPathname()

declare const self: ServiceWorkerGlobalScope & {
    __WB_MANIFEST: Array<string | { url: string; revision?: string }>
}

type PushPayload = {
    title: string
    body?: string
    icon?: string
    badge?: string
    tag?: string
    data?: {
        type?: string
        sessionId?: string
        url?: string
    }
}

cleanupOutdatedCaches()
precacheAndRoute(self.__WB_MANIFEST)

// 导航请求一律回精缓存里的 index.html：保证 html 与 chunk 永远来自同一个
// SW 版本的 precache，堵住「网络上的新 html + 缓存里的旧 chunk」（或反向）
// 的错配白屏——生产 hub 每次换芯资产 hash 全变、旧资产即刻消失，此前深链
// 导航走网络就会踩中。denylist 放行必须由 hub 直接应答的路径（API、CLI
// 通道、文件下载、健康检查）。dev 模式的 SW 不预缓存 index.html，此时跳过。
const precachedIndexUrl = ['index.html', '/index.html'].find((url) => getCacheKeyForURL(url))
if (precachedIndexUrl) {
    registerRoute(new NavigationRoute(createHandlerBoundToURL(precachedIndexUrl), {
        denylist: [/^\/api\//, /^\/cli\//, /^\/download\//, /^\/health$/]
    }))
}

registerRoute(
    ({ url }) => url.pathname === '/api/sessions',
    new NetworkFirst({
        cacheName: 'api-sessions',
        networkTimeoutSeconds: 10,
        plugins: [
            new ExpirationPlugin({
                maxEntries: 10,
                maxAgeSeconds: 60 * 5
            })
        ]
    })
)

registerRoute(
    ({ url }) => /^\/api\/sessions\/[^/]+$/.test(url.pathname),
    new NetworkFirst({
        cacheName: 'api-session-detail',
        networkTimeoutSeconds: 10,
        plugins: [
            new ExpirationPlugin({
                maxEntries: 20,
                maxAgeSeconds: 60 * 5
            })
        ]
    })
)

registerRoute(
    ({ url }) => url.pathname === '/api/machines',
    new NetworkFirst({
        cacheName: 'api-machines',
        networkTimeoutSeconds: 10,
        plugins: [
            new ExpirationPlugin({
                maxEntries: 5,
                maxAgeSeconds: 60 * 10
            })
        ]
    })
)

registerRoute(
    /^https:\/\/cdn\.socket\.io\/.*/,
    new CacheFirst({
        cacheName: 'cdn-socketio',
        plugins: [
            new ExpirationPlugin({
                maxEntries: 5,
                maxAgeSeconds: 60 * 60 * 24 * 30
            })
        ]
    })
)

registerRoute(
    /^https:\/\/telegram\.org\/.*/,
    new CacheFirst({
        cacheName: 'cdn-telegram',
        plugins: [
            new ExpirationPlugin({
                maxEntries: 5,
                maxAgeSeconds: 60 * 60 * 24 * 7
            })
        ]
    })
)

self.addEventListener('message', (event) => {
    if (event.data?.type === 'SKIP_WAITING') {
        self.skipWaiting()
    }
})

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim())
})

self.addEventListener('push', (event) => {
    const payload = event.data?.json() as PushPayload | undefined
    if (!payload) {
        return
    }

    const title = payload.title || 'HAPI'
    const body = payload.body ?? ''
    const icon = payload.icon ?? '/pwa-192x192.png'
    const badge = payload.badge ?? '/pwa-64x64.png'
    const data = payload.data
    const tag = payload.tag

    event.waitUntil(
        self.registration.showNotification(title, {
            body,
            icon,
            badge,
            data,
            tag
        })
    )
})

self.addEventListener('notificationclick', (event) => {
    event.notification.close()
    const data = event.notification.data as { url?: string } | undefined
    const url = data?.url ?? '/'
    event.waitUntil(self.clients.openWindow(url))
})

// Web Share Target — manifest declares POST /share, Android Chrome posts a
// multipart form with title/text/url/files. Stash in IDB so the SPA route
// can read it after the 303 redirect (which converts POST -> GET).
self.addEventListener('fetch', (event) => {
    const request = event.request
    if (request.method !== 'POST') return
    const url = new URL(request.url)
    if (url.pathname !== sharePath) return

    event.respondWith(handleShareTarget(request))
})

async function handleShareTarget(request: Request): Promise<Response> {
    // Resolve to absolute URLs because Response.redirect throws on relative
    // input per the Fetch spec; Chrome currently tolerates relative paths
    // but the SW spec is explicit and the cost of resolving is one line.
    const origin = self.location.origin
    try {
        const { redirectTo } = await ingestShareRequest(request, { put: putShareTransfer })
        return Response.redirect(new URL(redirectTo, origin).toString(), 303)
    } catch (error) {
        // Surface a minimal page if IDB write fails — don't 5xx silently or
        // the user gets a Chrome error sheet instead of useful UI.
        console.error('share-target ingest failed', error)
        return Response.redirect(new URL(`${sharePath}?error=ingest`, origin).toString(), 303)
    }
}

// Best-effort GC for stale share transfers (TTL-only — never blocks
// anything else). 1h TTL is set in shareTransfer.ts.
self.addEventListener('activate', (event) => {
    event.waitUntil(
        cleanupExpiredShareTransfers().catch((error) => {
            console.warn('share-transfer cleanup failed', error)
        })
    )
})
