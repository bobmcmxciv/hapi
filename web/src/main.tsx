import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import { ReactQueryDevtools } from '@tanstack/react-query-devtools'
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router'
import './index.css'
import { initializeFontScale } from '@/hooks/useFontScale'
import { getTelegramWebApp, isTelegramEnvironment, loadTelegramSdk } from './hooks/useTelegram'
import { queryClient } from './lib/query-client'
import { createAppRouter } from './router'
import { I18nProvider } from './lib/i18n-context'
import { restoreSpaRedirect } from './lib/spaRedirect'
import { installScrollRestorationGuard } from './lib/scrollStorageGuard'
import { installCrashGuard, isChunkLoadError, reportCrash, tryRecoverFromStaleChunks } from './lib/crashGuard'
import { AppErrorBoundary } from './components/AppErrorBoundary'

installCrashGuard()

function getStartParam(): string | null {
    const query = new URLSearchParams(window.location.search)
    const fromQuery = query.get('startapp') || query.get('tgWebAppStartParam')
    if (fromQuery) return fromQuery

    return getTelegramWebApp()?.initDataUnsafe?.start_param ?? null
}

function getDeepLinkedSessionId(): string | null {
    const startParam = getStartParam()
    if (startParam?.startsWith('session_')) {
        return startParam.slice('session_'.length)
    }
    return null
}

function getInitialPath(): string {
    const sessionId = getDeepLinkedSessionId()
    return sessionId ? `/sessions/${sessionId}` : '/sessions'
}

async function bootstrap() {
    installScrollRestorationGuard()
    initializeFontScale()

    // Only load Telegram SDK in Telegram environment (with 3s timeout)
    const isTelegram = isTelegramEnvironment()
    document.documentElement.dataset.telegramApp = isTelegram ? 'true' : 'false'
    if (isTelegram) {
        await loadTelegramSdk()
    }

    // Handle GitHub Pages 404 redirect for SPA routing
    // When GitHub Pages can't find a path (e.g. /sessions/xxx), it serves 404.html
    // which stores the path in sessionStorage and redirects to /
    if (!isTelegram) {
        restoreSpaRedirect()
    }

    const history = isTelegram
        ? createMemoryHistory({ initialEntries: [getInitialPath()] })
        : undefined
    const router = createAppRouter(history)

    ReactDOM.createRoot(document.getElementById('root')!).render(
        <React.StrictMode>
            <AppErrorBoundary>
                <I18nProvider>
                    <QueryClientProvider client={queryClient}>
                        <RouterProvider router={router} />
                        {import.meta.env.DEV ? <ReactQueryDevtools initialIsOpen={false} /> : null}
                    </QueryClientProvider>
                </I18nProvider>
            </AppErrorBoundary>
        </React.StrictMode>
    )
}

bootstrap().catch((error: unknown) => {
    // bootstrap 失败时 React 还没接管 #root——直接渲染静态兜底页，
    // 否则页面停在空白 div 上没有任何出口。错误文本不插入 HTML（防注入），
    // 只进 console 与上报通道。
    console.error('bootstrap failed', error)
    if (isChunkLoadError(error) && tryRecoverFromStaleChunks()) return
    reportCrash(error, 'bootstrap')
    const root = document.getElementById('root')
    if (!root || root.childElementCount > 0) return
    root.innerHTML = ''
    const container = document.createElement('div')
    container.style.cssText = 'display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100dvh;gap:16px;padding:24px;text-align:center;font-family:system-ui,sans-serif'
    const title = document.createElement('div')
    title.textContent = '加载失败 · Failed to load'
    title.style.cssText = 'font-size:18px;font-weight:600'
    const detail = document.createElement('pre')
    detail.textContent = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    detail.style.cssText = 'max-width:36rem;overflow:auto;white-space:pre-wrap;word-break:break-all;font-size:12px;opacity:.7;text-align:left'
    const reload = document.createElement('button')
    reload.textContent = '刷新 · Reload'
    reload.style.cssText = 'padding:8px 16px;font-size:14px;border:1px solid #d1d5db;border-radius:6px;background:none;cursor:pointer'
    reload.addEventListener('click', () => window.location.reload())
    container.append(title, detail, reload)
    root.append(container)
})
