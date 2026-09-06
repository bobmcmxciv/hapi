import type { CcSwitchProviderSummary } from '@hapi/protocol'
import { SelectControl } from '@/components/ui/select-control'
import { useTranslation } from '@/lib/use-translation'

/**
 * fork(claude-proxy-models)：New Session 的 cc-switch 供应商选择器（仅 Claude）。
 *
 * 为什么需要它：模型目录是全 hub 一份（cx2cc 的），但一台机器的 Claude Code 实际打到
 * 哪个上游由该机 cc-switch 的**当前供应商**决定。2026-09-06 实测：吹雪3080 当前供应商是
 * Zhipu GLM，选 gpt-6-astra 建会话跑的是 glm-5.3。这里让用户在创建时显式选 cx2cc
 * 供应商，runner 只给这一个子进程注入该供应商的 env，不改机器全局状态。
 *
 * 空值 = 跟随机器当前供应商（与以往行为一致）。
 */
export function CcSwitchProviderSelector(props: {
    providers: readonly CcSwitchProviderSummary[]
    currentProviderId: string | null
    value: string | null
    isLoading?: boolean
    isDisabled?: boolean
    onChange: (providerId: string | null) => void
}) {
    const { t } = useTranslation()
    const current = props.providers.find((provider) => provider.id === props.currentProviderId) ?? null

    return (
        <div className="flex flex-col gap-1.5 px-3 py-3">
            <label className="text-xs font-medium text-[var(--app-hint)]">
                {t('newSession.ccSwitchProvider')}
            </label>
            <SelectControl
                value={props.value ?? ''}
                onChange={(event) => props.onChange(event.target.value || null)}
                disabled={props.isDisabled || props.isLoading}
                data-testid="cc-switch-provider"
                className="py-2 pl-3 text-sm rounded-lg border border-[var(--app-divider)] bg-[var(--app-bg)] text-[var(--app-text)] focus:outline-none focus:ring-2 focus:ring-[var(--app-link)] disabled:opacity-50"
            >
                <option value="">
                    {current
                        ? t('newSession.ccSwitchProvider.followCurrent', { name: current.name })
                        : t('newSession.ccSwitchProvider.followCurrentUnknown')}
                </option>
                {props.providers.map((provider) => (
                    <option key={provider.id} value={provider.id}>
                        {provider.name}{provider.isCurrent ? ` · ${t('newSession.ccSwitchProvider.currentMark')}` : ''}
                    </option>
                ))}
            </SelectControl>
            <div className="text-xs text-[var(--app-hint)]">
                {t('newSession.ccSwitchProvider.hint')}
            </div>
        </div>
    )
}
