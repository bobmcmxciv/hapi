import { useEffect, useId, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
    getFreshOmpUsageReports,
    OMP_USAGE_MAX_AGE_MS,
    type OmpUsageLimit,
    type OmpUsageResponse
} from '@hapi/protocol/ompUsage'
import { ApiError } from '@/api/client'
import type { MachineWithOwner } from '@/types/api'
import { useAppContext } from '@/lib/app-context'
import { useTranslation } from '@/lib/use-translation'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { ProviderLogo, resolveQuotaSubModelBrand } from './ProviderLogo'
import SubscriptionPanel from './SubscriptionPanel'

const COMPACT_SELECT_CLASS = 'h-7 max-w-[10.5rem] sm:max-w-[13rem] rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-2 text-xs text-[var(--app-fg)] disabled:opacity-50'
const CACHE_MS = 60_000


type StoredUsagePreference = {
    source?: 'omp-native' | 'external'
    machineId?: string
    host?: string
}

function readStoredUsagePreference(userId: number | string | undefined): StoredUsagePreference | null {
    if (userId === undefined || userId === null || userId === '' || typeof window === 'undefined') return null
    try {
        const raw = window.localStorage.getItem(`hapi.ompUsage.pref.v1:${userId}`)
        if (!raw) return null
        const parsed: unknown = JSON.parse(raw)
        if (!parsed || typeof parsed !== 'object') return null
        const data = parsed as Record<string, unknown>
        return {
            source: data.source === 'omp-native' || data.source === 'external' ? data.source : undefined,
            machineId: typeof data.machineId === 'string' && data.machineId ? data.machineId : undefined,
            host: typeof data.host === 'string' && data.host ? data.host : undefined
        }
    } catch {
        return null
    }
}

function writeStoredUsagePreference(
    userId: number | string | undefined,
    patch: Partial<StoredUsagePreference>
): void {
    if (userId === undefined || userId === null || userId === '' || typeof window === 'undefined') return
    try {
        const current = readStoredUsagePreference(userId) ?? {}
        const next: StoredUsagePreference = { ...current, ...patch }
        window.localStorage.setItem(`hapi.ompUsage.pref.v1:${userId}`, JSON.stringify(next))
    } catch {
        // Ignore storage errors
    }
}
const STATUS_BADGE_CLASS: Record<OmpUsageLimit['status'], string> = {
    ok: 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300',
    warning: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
    exhausted: 'bg-rose-500/15 text-rose-700 dark:text-rose-300',
    unknown: 'bg-[var(--app-subtle-bg)] text-[var(--app-hint)]'
}

const STATUS_BAR_CLASS: Record<OmpUsageLimit['status'], string> = {
    ok: 'bg-emerald-500',
    warning: 'bg-amber-500',
    exhausted: 'bg-rose-500',
    unknown: 'bg-[var(--app-link)]'
}

function formatCompactTime(epochMs: number): string {
    try {
        return new Intl.DateTimeFormat(undefined, {
            month: 'numeric',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        }).format(new Date(epochMs))
    } catch {
        return new Date(epochMs).toLocaleString()
    }
}

function formatQuotaValue(value: number, unit: OmpUsageLimit['amount']['unit']): string {
    if (unit === 'percent') {
        return Number(value.toFixed(1)).toLocaleString(undefined, { maximumFractionDigits: 1 })
    }
    return value.toLocaleString(undefined, { maximumFractionDigits: 2 })
}

function collectDistinctMeta(label: string, candidates: Array<string | undefined>): string[] {
    const normLabel = label.trim().toLowerCase()
    const seen = new Set<string>()
    const result: string[] = []
    for (const raw of candidates) {
        const trimmed = raw?.trim()
        if (!trimmed) continue
        const lower = trimmed.toLowerCase()
        if (seen.has(lower) || normLabel.includes(lower)) continue
        seen.add(lower)
        result.push(trimmed)
    }
    return result
}

/** Local expiration only: never fetch quotas in a timer, focus or reconnect handler. */
function useSnapshotClock(response: OmpUsageResponse | undefined): number {
    const [now, setNow] = useState(Date.now)
    useEffect(() => {
        const current = Date.now()
        setNow(current)
        if (!response?.success) return
        const deadlines = response.reports.flatMap(report => [
            report.fetchedAt - 60_000,
            report.fetchedAt + OMP_USAGE_MAX_AGE_MS,
            ...report.limits.flatMap(limit => limit.window?.resetsAt === undefined ? [] : [limit.window.resetsAt])
        ]).filter(deadline => deadline > current).sort((left, right) => left - right)
        let timer: number | undefined
        const schedule = () => {
            const next = deadlines.find(deadline => deadline > Date.now())
            if (next === undefined) return
            timer = window.setTimeout(() => {
                setNow(Date.now())
                schedule()
            }, Math.min(next - Date.now() + 1, 2_147_483_647))
        }
        schedule()
        return () => window.clearTimeout(timer)
    }, [response])
    return Math.max(now, Date.now())
}

function QuotaLimit({ limit, provider }: { limit: OmpUsageLimit; provider: string }) {
    const { t } = useTranslation()
    const amount = limit.amount
    const fraction = amount.usedFraction ?? (amount.remainingFraction === undefined ? undefined : 1 - amount.remainingFraction)
    const clampedPct = fraction === undefined ? undefined : Math.max(0, Math.min(1, fraction)) * 100
    const fields = [
        ['used', amount.used], ['limit', amount.limit], ['remaining', amount.remaining]
    ] as const
    const distinctMeta = collectDistinctMeta(limit.label, [limit.scope.modelId, limit.scope.tier, limit.window?.label])
    const subBrand = resolveQuotaSubModelBrand(provider, limit.label, limit.scope.modelId)
    const SubIcon = subBrand?.Icon
    const unitSuffix = t(`ompUsage.unit.${amount.unit}`)
    const isPercentUnit = amount.unit === 'percent'
    const hideRedundantPercentTotal = isPercentUnit && amount.limit === 100 && (amount.used !== undefined || amount.remaining !== undefined)
    const hasNumericFields = fields.some(([, value]) => value !== undefined) || amount.remainingFraction !== undefined

    return (
        <li className="space-y-1 px-2.5 py-1.5" data-testid="omp-limit" data-status={limit.status}>
            <div className="flex items-center justify-between gap-1.5 text-xs">
                <div className="flex min-w-0 items-center gap-1">
                    {SubIcon ? (
                        <span aria-hidden="true" className={cn('inline-flex shrink-0 items-center justify-center leading-none', subBrand.iconClassName)}>
                            <SubIcon size={12} />
                        </span>
                    ) : null}
                    <span className="min-w-0 truncate font-medium text-[var(--app-fg)]" title={limit.label}>{limit.label}</span>
                    {distinctMeta.length > 0 ? (
                        <span className="shrink-0 text-[11px] text-[var(--app-hint)]" title={distinctMeta.join(' · ')}>
                            · {distinctMeta.join(' · ')}
                        </span>
                    ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                    {limit.scope.shared || limit.scope.sharedGroup ? (
                        <span
                            className="rounded bg-[var(--app-subtle-bg)] px-1.5 py-0.5 text-[10px] leading-none text-[var(--app-hint)]"
                            data-testid="omp-shared-pool"
                            title={t('ompUsage.sharedPool')}
                        >
                            {t('ompUsage.sharedPool')}
                        </span>
                    ) : null}
                    <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-medium leading-none', STATUS_BADGE_CLASS[limit.status])}>
                        {t(`ompUsage.status.${limit.status}`)}
                    </span>
                </div>
            </div>
            {clampedPct !== undefined ? (
                <div
                    role="progressbar"
                    aria-label={limit.label}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(clampedPct)}
                    className="h-1.5 overflow-hidden rounded-full bg-[var(--app-subtle-bg)]"
                >
                    <div
                        className={cn('h-full rounded-full transition-all', STATUS_BAR_CLASS[limit.status])}
                        style={{ width: `${clampedPct === 0 ? 1.5 : clampedPct}%` }}
                    />
                </div>
            ) : null}
            {hasNumericFields || limit.window?.resetsAt !== undefined ? (
                <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5 text-[11px] tabular-nums">
                    <dl className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
                        {fields.map(([key, value]) => value === undefined ? null : (
                            <div key={key} className={cn(key === 'limit' && hideRedundantPercentTotal && 'sr-only')}>
                                <dt className="inline text-[var(--app-hint)]">{t(`ompUsage.${key}`)} </dt>
                                <dd className="inline font-medium text-[var(--app-fg)]">
                                    <data data-testid={`omp-amount-${key}`} value={value}>{formatQuotaValue(value, amount.unit)}</data>
                                    {isPercentUnit ? unitSuffix : ` ${unitSuffix}`}
                                </dd>
                            </div>
                        ))}
                        {amount.remainingFraction !== undefined && (!isPercentUnit || amount.remaining === undefined) ? (
                            <div>
                                <dt className="inline text-[var(--app-hint)]">{t('ompUsage.remaining')} </dt>
                                <dd className="inline font-medium text-[var(--app-fg)]">
                                    <data data-testid="omp-remaining-fraction" value={amount.remainingFraction}>{(amount.remainingFraction * 100).toFixed(1)}%</data>
                                </dd>
                            </div>
                        ) : null}
                    </dl>
                    {limit.window?.resetsAt !== undefined ? (
                        <span
                            className="ml-auto shrink-0 text-[var(--app-hint)]"
                            title={`${t('ompUsage.resetsAt')}: ${new Date(limit.window.resetsAt).toLocaleString()}`}
                        >
                            {t('ompUsage.resetsAt')}{' '}
                            <time dateTime={new Date(limit.window.resetsAt).toISOString()}>
                                {formatCompactTime(limit.window.resetsAt)}
                            </time>
                        </span>
                    ) : null}
                </div>
            ) : null}
            {fields.every(([, value]) => value === undefined) && fraction === undefined ? (
                <p className="text-[11px] text-[var(--app-hint)]">{t('ompUsage.unknownAmount')}</p>
            ) : null}
        </li>
    )
}

function NativeUsagePanel({ machines, sourceControl }: { machines: MachineWithOwner[]; sourceControl: ReactNode }) {
    const { api, baseUrl, user } = useAppContext()
    const { t } = useTranslation()
    const machineSelectId = useId()
    const [selectedId, setSelectedId] = useState('')
    const available = machines.filter(machine => machine.active && machine.metadata?.capabilities?.omp === true)
    const storedPref = readStoredUsagePreference(user?.id)
    const machine = available.find(candidate => candidate.id === selectedId)
        ?? available.find(candidate => candidate.preferredForOmpUsage === true)
        ?? (storedPref?.machineId ? available.find(candidate => candidate.id === storedPref.machineId) : undefined)
        ?? (storedPref?.host
            ? available.find(candidate => candidate.metadata?.host === storedPref.host || candidate.metadata?.displayName === storedPref.host)
            : undefined)
        ?? available[0]
    const machineId = machine?.id ?? ''
    const query = useQuery({
        queryKey: ['omp-native-usage', baseUrl, user.id, machineId],
        queryFn: () => api.getOmpUsage(machineId),
        enabled: Boolean(api && machineId),
        staleTime: CACHE_MS,
        gcTime: 5 * 60_000,
        retry: false,
        refetchInterval: false,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false
    })
    const now = useSnapshotClock(query.data)
    // A failed refresh must not keep presenting a previously successful quota as current.
    const response = query.isError ? undefined : query.data
    const reports = response ? getFreshOmpUsageReports(response, now) : []
    const hiddenReports = response?.success ? response.reports.length - reports.length : 0
    const originalLimits = response?.success ? response.reports.reduce((sum, report) => sum + report.limits.length, 0) : 0
    const hiddenLimits = originalLimits - reports.reduce((sum, report) => sum + report.limits.length, 0)
    const errorCode = response?.success === false ? response.errorCode
        : query.isError ? (query.error instanceof ApiError && [404, 501].includes(query.error.status) ? 'unsupported' : 'unavailable')
            : null

    const withoutUsageProviders = response?.success
        ? [...new Set(response.accountsWithoutUsage.map(account => account.provider))]
        : []

    return (
        <Card className="overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-[var(--app-divider)] px-3 py-2">
                <div className="min-w-0 flex-1 basis-48">
                    <div className="flex items-baseline gap-2">
                        <h2 className="text-sm font-semibold leading-tight text-[var(--app-fg)]">{t('ompUsage.title')}</h2>
                        {query.isFetching ? (
                            <span role="status" className="text-[11px] text-[var(--app-hint)]">{t('ompUsage.loading')}</span>
                        ) : null}
                    </div>
                    <p className="truncate text-[11px] text-[var(--app-hint)]" title={t('ompUsage.description')}>
                        {t('ompUsage.description')}
                    </p>
                </div>
                <div className="flex max-w-full flex-wrap items-center gap-2">
                    {sourceControl}
                    <div className="inline-flex items-center gap-1.5 text-xs">
                        <label htmlFor={machineSelectId} className="whitespace-nowrap text-[var(--app-hint)]">
                            {t('ompUsage.machine')}
                        </label>
                        <select
                            id={machineSelectId}
                            className={COMPACT_SELECT_CLASS}
                            value={machineId}
                            onChange={event => {
                                const nextId = event.target.value
                                setSelectedId(nextId)
                                const picked = available.find(candidate => candidate.id === nextId)
                                writeStoredUsagePreference(user?.id, {
                                    source: 'omp-native',
                                    machineId: nextId,
                                    host: picked?.metadata?.host
                                })
                            }}
                            disabled={!available.length}
                        >
                            {!available.length ? <option value="">{t('ompUsage.noMachines')}</option> : null}
                            {available.map(candidate => (
                                <option key={candidate.id} value={candidate.id}>
                                    {candidate.metadata?.displayName ?? candidate.metadata?.host ?? candidate.id}
                                </option>
                            ))}
                        </select>
                    </div>
                    <Button
                        variant="outline"
                        size="sm"
                        className="h-7 px-2.5 text-xs"
                        disabled={!machineId || query.isFetching}
                        onClick={() => void query.refetch()}
                    >
                        {t('ompUsage.refresh')}
                    </Button>
                </div>
            </div>
            <div className="space-y-2.5 p-2.5">
                {!available.length ? <p role="status" className="text-xs text-[var(--app-hint)]">{t('ompUsage.noMachines')}</p> : null}
                {errorCode ? <p role="alert" className="text-xs text-[var(--app-hint)]">{t(`ompUsage.error.${errorCode}`)}</p> : null}
                {response?.success ? (
                    <>
                        {!reports.some(report => report.limits.length > 0) ? (
                            <p role="status" className="text-xs text-[var(--app-hint)]">{t('ompUsage.noReports')}</p>
                        ) : null}
                        {reports.length > 0 ? (
                            <div className="grid items-start gap-2 sm:grid-cols-2 lg:grid-cols-3">
                                {reports.map((report, index) => (
                                    <section
                                        key={`${report.provider}/${report.accountId}/${index}`}
                                        className="overflow-hidden rounded-lg border border-[var(--app-divider)] bg-[var(--app-bg)]"
                                        aria-label={`${report.provider} ${index + 1}`}
                                    >
                                        <div className="flex items-center justify-between gap-2 border-b border-[var(--app-divider)] bg-[var(--app-subtle-bg)]/45 px-2.5 py-1.5">
                                            <div className="flex min-w-0 items-center gap-2">
                                                <ProviderLogo provider={report.provider} />
                                                <h3 className="min-w-0 truncate text-xs font-semibold leading-tight text-[var(--app-fg)]">
                                                    {report.provider}{' '}
                                                    <span className="font-normal text-[var(--app-hint)]">
                                                        · {t('ompUsage.account', { n: index + 1 })}
                                                    </span>
                                                </h3>
                                            </div>
                                            <time
                                                data-testid="omp-fetched-at"
                                                dateTime={new Date(report.fetchedAt).toISOString()}
                                                title={`${t('ompUsage.fetchedAt')}: ${new Date(report.fetchedAt).toLocaleString()}`}
                                                className="shrink-0 text-[11px] tabular-nums text-[var(--app-hint)]"
                                            >
                                                {formatCompactTime(report.fetchedAt)}
                                            </time>
                                        </div>
                                        {!report.limits.length ? (
                                            <p className="px-2.5 py-2 text-xs text-[var(--app-hint)]">{t('ompUsage.noLimits')}</p>
                                        ) : (
                                            <ul className="divide-y divide-[var(--app-divider)]">
                                                {report.limits.map((limit, limitIndex) => (
                                                    <QuotaLimit key={`${limit.id}/${limitIndex}`} limit={limit} provider={report.provider} />
                                                ))}
                                            </ul>
                                        )}
                                    </section>
                                ))}
                            </div>
                        ) : null}
                        {(hiddenReports > 0 || hiddenLimits > 0 || response.accountsWithoutUsage.length > 0 || response.disabledCredentialCount > 0) ? (
                            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--app-hint)]">
                                {hiddenReports > 0 || hiddenLimits > 0 ? (
                                    <p role="status" data-testid="omp-hidden-stale">{t('ompUsage.hiddenStale')}</p>
                                ) : null}
                                {response.accountsWithoutUsage.length > 0 ? (
                                    <p className="inline-flex flex-wrap items-center gap-1">
                                        <span className="inline-flex items-center gap-0.5">
                                            {withoutUsageProviders.map(provider => (
                                                <ProviderLogo key={provider} provider={provider} size="sm" framed={false} />
                                            ))}
                                        </span>
                                        <span>
                                            {t('ompUsage.withoutUsage', {
                                                n: response.accountsWithoutUsage.length,
                                                providers: withoutUsageProviders.join(', ')
                                            })}
                                        </span>
                                    </p>
                                ) : null}
                                {response.disabledCredentialCount > 0 ? (
                                    <p>{t('ompUsage.disabledCredentials', { n: response.disabledCredentialCount })}</p>
                                ) : null}
                            </div>
                        ) : null}
                    </>
                ) : null}
            </div>
        </Card>
    )
}

/** Source switching unmounts the other collector; native never requests the fleet summary. */
export function SubscriptionUsageSection({ machines }: { machines: MachineWithOwner[] }) {
    const { user } = useAppContext()
    const { t } = useTranslation()
    const sourceSelectId = useId()
    const [userPickedSource, setUserPickedSource] = useState<'omp-native' | 'external' | null>(null)
    const storedSource = readStoredUsagePreference(user?.id)?.source
    const serverPreferredSource = machines.find(m => m.preferredUsageSource)?.preferredUsageSource
    const source = userPickedSource ?? storedSource ?? serverPreferredSource ?? 'omp-native'

    const sourceControl = (
        <div className="inline-flex items-center gap-1.5 text-xs">
            <label htmlFor={sourceSelectId} className="whitespace-nowrap text-[var(--app-hint)]">
                {t('ompUsage.source')}
            </label>
            <select
                id={sourceSelectId}
                className={COMPACT_SELECT_CLASS}
                value={source}
                onChange={event => {
                    const next = event.target.value === 'external' ? 'external' : 'omp-native'
                    setUserPickedSource(next)
                    writeStoredUsagePreference(user?.id, { source: next })
                }}
            >
                <option value="omp-native">{t('ompUsage.nativeSource')}</option>
                <option value="external">{t('ompUsage.externalSource')}</option>
            </select>
        </div>
    )

    if (source === 'omp-native') {
        return (
            <section aria-label={t('ompUsage.title')}>
                <NativeUsagePanel machines={machines} sourceControl={sourceControl} />
            </section>
        )
    }

    return (
        <section className="space-y-2" aria-label={t('ompUsage.title')}>
            <div className="flex items-center justify-between gap-2 rounded-lg border border-[var(--app-divider)] bg-[var(--app-bg)] px-3 py-1.5">
                <span className="text-xs font-semibold text-[var(--app-fg)]">{t('ompUsage.title')}</span>
                {sourceControl}
            </div>
            <SubscriptionPanel />
        </section>
    )
}
