/**
 * Navigation scope for the service worker.
 *
 * A service worker served from `/sw.js` has scope `/`, so its NavigationRoute
 * sees **every** navigation on the origin — not just HAPI's. The original rule
 * claimed all of them and excluded a hardcoded denylist of HAPI's own backend
 * paths (`/api/`, `/cli/`, `/download/`, `/health`). That is only correct when
 * HAPI is the sole occupant of the origin: any *other* service reverse-proxied
 * onto the same host (a common homelab/nginx layout) had its navigations
 * answered with HAPI's cached `index.html`, so those sites appeared to 404 —
 * and kept doing so after the SW was gone, because a registered SW outlives
 * the page that installed it.
 *
 * Inverting the rule to an allowlist fixes that class of failure for good:
 * HAPI only claims paths it actually owns, and everything else falls through
 * to the network (i.e. to nginx and whatever else is mounted there).
 *
 * The failure modes are asymmetric, which is why an allowlist is the safer
 * default: forgetting to list a HAPI route only costs that route the
 * precache-consistency guarantee (the navigation still works, served from the
 * network); forgetting to deny someone else's path breaks their site.
 */

/**
 * Top-level path segments owned by the HAPI web app. Must stay in sync with
 * the top-level routes in `web/src/router.tsx` — `swNavigationScope.test.ts`
 * reads that file and fails if a route is added without updating this list.
 */
export const APP_TOP_LEVEL_SEGMENTS = [
    'browse',
    'sessions',
    'settings',
    'share',
    'usage'
] as const

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Build the NavigationRoute allowlist for a given Vite `base`.
 *
 * Matches the app root and anything under a known top-level segment, honoring
 * subpath deployments (`base` of `/hapi/` etc.). Workbox tests these against
 * `url.pathname + url.search`, so an optional query tail is allowed.
 */
export function buildNavigationAllowlist(baseUrl: string): RegExp[] {
    const withSlash = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
    const escapedWithSlash = escapeRegExp(withSlash)
    const withoutSlash = withSlash.slice(0, -1)
    const patterns: RegExp[] = [
        // App root: `/`, `/?foo=1` (or `/hapi/`, `/hapi/?foo=1`).
        new RegExp(`^${escapedWithSlash}(?:\\?.*)?$`)
    ]

    // Subpath deployments also need the base without its trailing slash
    // (`/hapi`). Skipped when base is `/`, where that would be the empty
    // string and match nothing useful.
    if (withoutSlash.length > 0) {
        patterns.push(new RegExp(`^${escapeRegExp(withoutSlash)}(?:\\?.*)?$`))
    }

    patterns.push(
        new RegExp(
            `^${escapedWithSlash}(?:${APP_TOP_LEVEL_SEGMENTS.map(escapeRegExp).join('|')})(?:/.*)?(?:\\?.*)?$`
        )
    )

    return patterns
}
