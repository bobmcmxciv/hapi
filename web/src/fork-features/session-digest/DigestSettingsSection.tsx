import { SettingsSection } from '@/components/settings/SettingsPrimitives'
import { useTranslation } from '@/lib/use-translation'
import { useDigestSettings } from './digestApi'

const rowClass = 'flex min-h-11 items-center justify-between gap-3 px-3 py-2'
const controlClass = 'rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1 text-sm text-[var(--app-fg)] disabled:opacity-60'

function Toggle(props: { checked: boolean; disabled?: boolean; label: string; onChange: (value: boolean) => void }) {
    return (
        <input
            type="checkbox"
            role="switch"
            aria-label={props.label}
            checked={props.checked}
            disabled={props.disabled}
            onChange={(event) => props.onChange(event.target.checked)}
            className="h-4 w-4 accent-[var(--app-link)]"
        />
    )
}

/** 设置 → HAPI 扩展：会话/项目 AI 摘要（仅 admin）。 */
export function DigestSettingsSection() {
    const { t } = useTranslation()
    const { status, models, update, refreshAllProjects } = useDigestSettings(true)
    const data = status.data
    if (status.isError) {
        return (
            <SettingsSection title={t('digest.settings.title')}>
                <div className="px-3 py-3 text-sm text-red-600 dark:text-red-400">{String(status.error)}</div>
            </SettingsSection>
        )
    }
    if (!data) {
        return (
            <SettingsSection title={t('digest.settings.title')}>
                <div className="px-3 py-3 text-sm text-[var(--app-hint)]">{t('misc.loading')}</div>
            </SettingsSection>
        )
    }
    const settings = data.settings
    const pending = update.isPending
    const modelOptions = Array.from(new Set([settings.model, ...(models.data?.models ?? [])]))

    return (
        <SettingsSection title={t('digest.settings.title')}>
            <div className="px-3 pb-1 pt-2 text-xs leading-relaxed text-[var(--app-hint)]">{t('digest.settings.description')}</div>
            {!data.configured ? (
                <div role="alert" className="px-3 py-2 text-xs text-red-600 dark:text-red-400">{t('digest.settings.notConfigured')}</div>
            ) : null}
            <label className={rowClass}>
                <span className="text-sm text-[var(--app-fg)]">{t('digest.settings.enabled')}</span>
                <Toggle label={t('digest.settings.enabled')} checked={settings.enabled} disabled={pending} onChange={(enabled) => update.mutate({ enabled })} />
            </label>
            <label className={rowClass}>
                <span className="text-sm text-[var(--app-fg)]">{t('digest.settings.model')}</span>
                <select
                    value={settings.model}
                    disabled={pending}
                    onChange={(event) => update.mutate({ model: event.target.value })}
                    className={controlClass}
                >
                    {modelOptions.map(model => <option key={model} value={model}>{model}</option>)}
                </select>
            </label>
            <label className={rowClass}>
                <span className="flex flex-col">
                    <span className="text-sm text-[var(--app-fg)]">{t('digest.settings.autoRename')}</span>
                    <span className="text-xs text-[var(--app-hint)]">{t('digest.settings.autoRenameHint')}</span>
                </span>
                <Toggle label={t('digest.settings.autoRename')} checked={settings.autoRename} disabled={pending} onChange={(autoRename) => update.mutate({ autoRename })} />
            </label>
            <label className={rowClass}>
                <span className="text-sm text-[var(--app-fg)]">{t('digest.settings.maxPerHour')}</span>
                <input
                    type="number"
                    min={1}
                    max={600}
                    defaultValue={settings.maxPerHour}
                    key={settings.maxPerHour}
                    disabled={pending}
                    onBlur={(event) => {
                        const value = Number(event.target.value)
                        if (Number.isFinite(value) && value >= 1 && value !== settings.maxPerHour) update.mutate({ maxPerHour: value })
                    }}
                    className={`${controlClass} w-20 text-right tabular-nums`}
                />
            </label>
            <div className={rowClass}>
                <span className="flex flex-col">
                    <span className="text-sm text-[var(--app-fg)]">{t('digest.settings.refreshAll')}</span>
                    <span className="text-xs text-[var(--app-hint)]">{t('digest.settings.refreshAllHint')}</span>
                </span>
                <button
                    type="button"
                    disabled={refreshAllProjects.isPending || !data.configured}
                    onClick={() => refreshAllProjects.mutate()}
                    className="shrink-0 rounded-lg border border-[var(--app-border)] px-3 py-1 text-sm text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)] disabled:opacity-50"
                >
                    {data.queuedProjects > 0 ? t('digest.settings.queued', { n: data.queuedProjects }) : t('digest.settings.refreshAllButton')}
                </button>
            </div>
            <div className="px-3 pb-3 pt-1 text-xs leading-relaxed text-[var(--app-hint)]">
                {t('digest.settings.stats', {
                    digested: data.digestedSessions,
                    pending: data.pendingSessions,
                    projects: data.projects,
                    runs: data.runsLastHour
                })}
                {data.running ? <div>{t('digest.settings.running', { job: data.running })}</div> : null}
                {data.lastError ? <div className="text-red-600 dark:text-red-400">{data.lastError}</div> : null}
            </div>
        </SettingsSection>
    )
}
