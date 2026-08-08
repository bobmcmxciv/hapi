import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { APP_TOP_LEVEL_SEGMENTS, buildNavigationAllowlist } from './swNavigationScope'

/** Workbox matches NavigationRoute allow/deny patterns against pathname + search. */
function matches(patterns: RegExp[], pathname: string): boolean {
    return patterns.some((p) => p.test(pathname))
}

describe('buildNavigationAllowlist', () => {
    const allow = buildNavigationAllowlist('/')

    it('claims the app root and its own top-level routes', () => {
        expect(matches(allow, '/')).toBe(true)
        expect(matches(allow, '/?foo=1')).toBe(true)
        for (const segment of APP_TOP_LEVEL_SEGMENTS) {
            expect(matches(allow, `/${segment}`)).toBe(true)
            expect(matches(allow, `/${segment}/`)).toBe(true)
        }
        // Deep links must still be claimed, or a refresh on a session page
        // would lose the precache-consistency guarantee.
        expect(matches(allow, '/sessions/abc-123')).toBe(true)
        expect(matches(allow, '/sessions/abc-123/files')).toBe(true)
        expect(matches(allow, '/settings/voice/advanced')).toBe(true)
        expect(matches(allow, '/sessions/abc-123?tab=files')).toBe(true)
    })

    it('does NOT claim other services sharing the origin', () => {
        // The reported failure: everything else on the host answered with
        // HAPI's index.html and looked like a 404.
        for (const foreign of [
            '/grafana', '/grafana/d/abc', '/jellyfin', '/nas/',
            '/webdav/file.txt', '/some-other-app', '/', // '/' is ours, checked above
        ].slice(0, -1)) {
            expect(matches(allow, foreign)).toBe(false)
        }
    })

    it('does not claim hub backend paths either', () => {
        // Previously handled by the denylist; the allowlist must keep them out.
        for (const backend of ['/api/sessions', '/cli/foo', '/download/x.zip', '/health']) {
            expect(matches(allow, backend)).toBe(false)
        }
    })

    it('does not let a route name match as a mere prefix', () => {
        // `/sessions-archive` belongs to someone else, not to `/sessions`.
        expect(matches(allow, '/sessions-archive')).toBe(false)
        expect(matches(allow, '/usagestats')).toBe(false)
    })

    it('honors a subpath base deployment', () => {
        const sub = buildNavigationAllowlist('/hapi/')
        expect(matches(sub, '/hapi/')).toBe(true)
        expect(matches(sub, '/hapi')).toBe(true)
        expect(matches(sub, '/hapi/sessions/abc')).toBe(true)
        // Outside the base, including the bare paths that would be ours at root.
        expect(matches(sub, '/sessions')).toBe(false)
        expect(matches(sub, '/other')).toBe(false)
    })

    it('accepts a base given without a trailing slash', () => {
        const sub = buildNavigationAllowlist('/hapi')
        expect(matches(sub, '/hapi/sessions')).toBe(true)
        expect(matches(sub, '/hapi')).toBe(true)
    })
})

describe('allowlist stays in sync with the router', () => {
    it('covers every top-level route declared in router.tsx', () => {
        // Drift guard: adding a top-level route without listing it here would
        // silently drop it out of SW navigation handling.
        // vitest runs the web suite with cwd = web/; import.meta.url is an
        // http: URL under the vite/jsdom environment, so resolve from cwd.
        const routerSource = readFileSync(resolve(process.cwd(), 'src/router.tsx'), 'utf8')
        const declared = new Set<string>()
        for (const match of routerSource.matchAll(/path:\s*'\/([a-z0-9-]+)'/gi)) {
            declared.add(match[1].toLowerCase())
        }

        expect(declared.size).toBeGreaterThan(0)
        const covered = new Set<string>(APP_TOP_LEVEL_SEGMENTS)
        const missing = [...declared].filter((segment) => !covered.has(segment))
        expect(missing, `router.tsx declares top-level route(s) missing from APP_TOP_LEVEL_SEGMENTS: ${missing.join(', ')}`).toEqual([])
    })
})
