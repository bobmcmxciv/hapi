/** Classify application routes independently of their deployment prefix. */
export function appPathname(pathname: string, baseUrl = import.meta.env.BASE_URL ?? '/'): string {
    const base = baseUrl.replace(/\/+$/, '')
    if (!base || base === '/') return pathname
    if (pathname === base) return '/'
    return pathname.startsWith(`${base}/`) ? pathname.slice(base.length) : pathname
}
