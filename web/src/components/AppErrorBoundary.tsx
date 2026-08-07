import { Component, type ErrorInfo, type ReactNode } from 'react'
import { isChunkLoadError, reportCrash, tryRecoverFromStaleChunks } from '@/lib/crashGuard'

/**
 * 崩溃兜底 UI。故意不依赖 i18n / router / query 任何上层 provider——
 * 它要在这些 provider 自身崩掉时也能渲染，文案双语硬编码。
 */
export function CrashFallback(props: { error: unknown; onRetry?: () => void }) {
    const message = props.error instanceof Error
        ? `${props.error.name}: ${props.error.message}`
        : String(props.error)
    return (
        <div className="flex min-h-[100dvh] flex-col items-center justify-center gap-4 bg-[var(--app-bg,#fff)] p-6 text-center text-[var(--app-fg,#111)]">
            <div className="text-lg font-semibold">界面出错了 · Something went wrong</div>
            <pre className="max-h-48 w-full max-w-xl overflow-auto whitespace-pre-wrap break-all rounded-md border border-[var(--app-border,#d1d5db)] bg-[var(--app-code-bg,#f5f5f5)] p-3 text-left text-xs opacity-80">{message}</pre>
            <div className="flex flex-wrap items-center justify-center gap-3">
                {props.onRetry ? (
                    <button
                        type="button"
                        onClick={props.onRetry}
                        className="rounded-md border border-[var(--app-border,#d1d5db)] px-4 py-2 text-sm"
                    >
                        重试 · Retry
                    </button>
                ) : null}
                <button
                    type="button"
                    onClick={() => window.location.reload()}
                    className="rounded-md border border-[var(--app-border,#d1d5db)] px-4 py-2 text-sm font-medium"
                >
                    刷新页面 · Reload
                </button>
                <button
                    type="button"
                    onClick={() => { window.location.href = '/sessions' }}
                    className="rounded-md border border-[var(--app-border,#d1d5db)] px-4 py-2 text-sm"
                >
                    返回会话列表 · Sessions
                </button>
            </div>
        </div>
    )
}

type AppErrorBoundaryState = {
    hasError: boolean
    error: unknown
    recovering: boolean
}

/**
 * 根级 ErrorBoundary：渲染异常的最后防线。此前任何一条消息渲染抛错都会让
 * 整棵 React 树卸载成白屏且无出口。chunk 错配类错误优先走自动刷新恢复，
 * 其余错误渲染带「重试 / 刷新 / 回列表」出口的兜底页并上报。
 */
export class AppErrorBoundary extends Component<{ children: ReactNode }, AppErrorBoundaryState> {
    state: AppErrorBoundaryState = { hasError: false, error: null, recovering: false }

    static getDerivedStateFromError(error: unknown): Partial<AppErrorBoundaryState> {
        return { hasError: true, error }
    }

    componentDidCatch(error: unknown, info: ErrorInfo): void {
        if (isChunkLoadError(error) && tryRecoverFromStaleChunks()) {
            this.setState({ recovering: true })
            return
        }
        console.error('AppErrorBoundary caught', error, info.componentStack)
        reportCrash(error, 'error-boundary')
    }

    render() {
        if (this.state.recovering) {
            return (
                <div className="flex min-h-[100dvh] items-center justify-center p-6 text-center text-sm opacity-70">
                    正在更新到最新版本… · Updating…
                </div>
            )
        }
        if (this.state.hasError) {
            return (
                <CrashFallback
                    error={this.state.error}
                    onRetry={() => this.setState({ hasError: false, error: null })}
                />
            )
        }
        return this.props.children
    }
}
