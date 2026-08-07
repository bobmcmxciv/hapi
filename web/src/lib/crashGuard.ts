/**
 * 全局崩溃防线。三件事：
 * 1. window error / unhandledrejection 兜底捕获，错误上报 hub（App 侧 attach 认证过的 reporter 后生效）
 * 2. 识别「部署换版后旧 chunk 已不存在」类加载失败，触发一次带防环护栏的 SW 换代 + 整页刷新
 * 3. 给 ErrorBoundary / 路由错误组件 / SSE 处理链提供统一的 reportCrash 入口
 *
 * 上报是尽力而为的诊断通道：去重、限量、失败静默，绝不能反过来影响页面本身。
 */

export type CrashSource =
    | 'window-error'
    | 'unhandled-rejection'
    | 'error-boundary'
    | 'route-error'
    | 'sse'
    | 'bootstrap'

export type ClientErrorReport = {
    message: string
    stack: string | null
    source: CrashSource
    url: string
    userAgent: string
    appVersion: string
    occurredAt: number
}

export type CrashReporter = (report: ClientErrorReport) => void

// 覆盖 Chrome / Safari / Firefox 三家对动态 import 失败的措辞，外加 Vite 的
// CSS 预载失败。这些都指向同一件事：当前页面持有的资产清单已过时。
const CHUNK_LOAD_ERROR_PATTERN = /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Failed to load module script|Unable to preload CSS|ChunkLoadError|Loading chunk \S+ failed/i

export const CHUNK_RELOAD_GUARD_KEY = 'hapi.chunk-reload-guard.v1'
export const CHUNK_RELOAD_GUARD_WINDOW_MS = 60_000
const MAX_REPORTS_PER_PAGE = 10
const MESSAGE_MAX_LENGTH = 500
const STACK_MAX_LENGTH = 4000

let installed = false
let reporter: CrashReporter | null = null
let reportedCount = 0
const pendingReports: ClientErrorReport[] = []
const seenSignatures = new Set<string>()

function describeError(value: unknown): string {
    if (value instanceof Error) return `${value.name}: ${value.message}`
    if (typeof value === 'string') return value
    try {
        return JSON.stringify(value) ?? String(value)
    } catch {
        return String(value)
    }
}

export function isChunkLoadError(value: unknown): boolean {
    if (value == null) return false
    return CHUNK_LOAD_ERROR_PATTERN.test(describeError(value))
}

export function shouldAttemptChunkReload(nowMs: number, lastReloadMs: number | null): boolean {
    if (lastReloadMs === null || !Number.isFinite(lastReloadMs)) return true
    return nowMs - lastReloadMs > CHUNK_RELOAD_GUARD_WINDOW_MS
}

function readLastChunkReloadAt(): number | null {
    try {
        const raw = sessionStorage.getItem(CHUNK_RELOAD_GUARD_KEY)
        if (!raw) return null
        const parsed = Number(raw)
        return Number.isFinite(parsed) ? parsed : null
    } catch {
        return null
    }
}

/**
 * 旧页面拉新部署已不存在的 chunk 时，让 SW 立即换代并整页刷新一次。
 * sessionStorage 护栏保证同一标签页 60s 内只自动刷一次——刷新后仍失败
 * 说明不是版本错配，转交调用方渲染可见的错误 UI，防止无限刷新循环。
 *
 * @returns 是否发起了自动恢复（false = 被护栏拦下）
 */
export function tryRecoverFromStaleChunks(): boolean {
    const now = Date.now()
    if (!shouldAttemptChunkReload(now, readLastChunkReloadAt())) return false
    try {
        sessionStorage.setItem(CHUNK_RELOAD_GUARD_KEY, String(now))
    } catch {
        // 护栏写不进去也照样刷——顶多多刷一次，比留在坏页面强。
    }
    void (async () => {
        try {
            const registration = await navigator.serviceWorker?.getRegistration()
            await registration?.update().catch(() => undefined)
            registration?.waiting?.postMessage({ type: 'SKIP_WAITING' })
        } catch {
            // SW 不可用（隐身模式、非安全上下文）时直接整页刷新。
        }
        window.location.reload()
    })()
    return true
}

export function reportCrash(error: unknown, source: CrashSource): void {
    const message = describeError(error)
    const signature = `${source}:${message}`
    if (seenSignatures.has(signature) || reportedCount >= MAX_REPORTS_PER_PAGE) return
    seenSignatures.add(signature)
    reportedCount += 1
    const stack = error instanceof Error ? error.stack ?? null : null
    const report: ClientErrorReport = {
        message: message.slice(0, MESSAGE_MAX_LENGTH),
        stack: stack?.slice(0, STACK_MAX_LENGTH) ?? null,
        source,
        url: window.location.href.slice(0, 300),
        userAgent: navigator.userAgent.slice(0, 300),
        appVersion: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev',
        occurredAt: Date.now()
    }
    if (reporter) {
        reporter(report)
    } else {
        pendingReports.push(report)
    }
}

/** App 侧拿到认证过的 ApiClient 后调用；attach 前发生的崩溃会积压并在此刻补发。 */
export function attachCrashReporter(next: CrashReporter): void {
    reporter = next
    while (pendingReports.length > 0) {
        const report = pendingReports.shift()
        if (report) next(report)
    }
}

function handleErrorEvent(event: ErrorEvent): void {
    const candidate = event.error ?? event.message
    if (isChunkLoadError(candidate) && tryRecoverFromStaleChunks()) return
    reportCrash(candidate, 'window-error')
}

// 资源级 error（script/link 加载失败）不冒泡，只能在捕获阶段拿到。
// /assets/ 下的脚本或样式拉不到 = 部署换版后旧资源已消失，与 chunk 错配同治。
function handleResourceError(event: Event): void {
    const target = event.target
    const source = target instanceof HTMLScriptElement
        ? target.src
        : target instanceof HTMLLinkElement ? target.href : null
    if (!source || !source.includes('/assets/')) return
    if (tryRecoverFromStaleChunks()) return
    reportCrash(new Error(`Asset failed to load: ${source}`), 'window-error')
}

export function installCrashGuard(): void {
    if (installed) return
    installed = true
    window.addEventListener('error', (event) => {
        if (event instanceof ErrorEvent) {
            handleErrorEvent(event)
        } else {
            handleResourceError(event)
        }
    }, true)
    window.addEventListener('unhandledrejection', (event) => {
        if (isChunkLoadError(event.reason) && tryRecoverFromStaleChunks()) return
        reportCrash(event.reason, 'unhandled-rejection')
    })
}

export function __resetCrashGuardForTests(): void {
    installed = false
    reporter = null
    reportedCount = 0
    pendingReports.length = 0
    seenSignatures.clear()
}
