import { useTranslation } from '@/lib/use-translation'
import { formatClaudeProxyFetchedAt } from './claudeProxyModelOptions'
import type { ClaudeProxyModelsState } from './useClaudeProxyModels'

/**
 * New Session 里 Claude 模型选择器下方的一行目录状态：来源 · 更新时间 · 旧快照 · 刷新。
 * 目录未配置时不渲染（静态清单没有"状态"可言）。加载失败但有旧快照时显示 stale + 原因；
 * 从未成功过时显示"目录不可用"并保留刷新按钮。
 */
export function ClaudeProxyCatalogHint(props: {
    state: ClaudeProxyModelsState
    notice?: string | null
    isDisabled?: boolean
}) {
    const { t, locale } = useTranslation()
    const { state } = props
    if (!state.configured && !state.isLoading && !state.error) {
        return props.notice ? (
            <div className="px-3 pb-3 text-xs text-[var(--app-hint)]" data-testid="claude-proxy-catalog-notice">
                {props.notice}
            </div>
        ) : null
    }

    const updated = formatClaudeProxyFetchedAt(state.fetchedAt, locale)
    return (
        <div className="flex flex-col gap-1 px-3 pb-3 text-xs text-[var(--app-hint)]" data-testid="claude-proxy-catalog-hint">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span>{t('newSession.model.proxyCatalog')}</span>
                {state.source ? <span className="font-mono">{state.source}</span> : null}
                {state.isLoading ? (
                    <span>{t('newSession.model.proxyCatalogLoading')}</span>
                ) : null}
                {updated ? <span>· {t('newSession.model.proxyCatalogUpdated', { time: updated })}</span> : null}
                {state.stale && state.fetchedAt !== null ? (
                    <span className="text-amber-600">· {t('newSession.model.proxyCatalogStale')}</span>
                ) : null}
                {!state.isLoading && state.fetchedAt === null && state.error ? (
                    <span className="text-red-600">· {t('newSession.model.proxyCatalogError')}</span>
                ) : null}
                <button
                    type="button"
                    className="underline disabled:opacity-50"
                    disabled={props.isDisabled || state.isLoading}
                    onClick={() => state.refetch(true)}
                    data-testid="claude-proxy-catalog-refresh"
                >
                    {t('newSession.model.proxyCatalogRefresh')}
                </button>
            </div>
            {state.error ? (
                <div className="text-red-600" data-testid="claude-proxy-catalog-error">{state.error}</div>
            ) : null}
            {props.notice ? (
                <div data-testid="claude-proxy-catalog-notice">{props.notice}</div>
            ) : null}
        </div>
    )
}
