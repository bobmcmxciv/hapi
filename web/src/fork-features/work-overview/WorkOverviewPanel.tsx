import { useCallback, useMemo, type ReactNode } from 'react'
import { useNavigate } from '@tanstack/react-router'
import type { SessionSummary } from '@/types/api'
import { useTranslation } from '@/lib/use-translation'
import { cn } from '@/lib/utils'
import { dailyActivity, findLine, sessionsInLine, type MainlineView, type WorkModel } from './deriveWork'
import { useWorkModel } from './useWorkModel'
import { setWorkView, useWorkView } from './workViewStore'
import {
    ArrowRightIcon,
    BellIcon,
    HeatStrip,
    InboxIcon,
    MachineIconRow,
    NeedBadge,
    PauseIcon,
    PlayIcon,
    RunDot,
    StatusBadge,
    TrendUpIcon,
    WorkGridIcon,
    shortDate,
    statusAccentStyle,
    useRelativeDay
} from './WorkParts'

const STRIP_DAYS = 14

/**
 * 方案 A：会话页之上的工作总览。
 * - 桌面：没选会话时右栏原本是空的，这里放总览；点主线/支线，左栏会话列表就过滤成这条线。
 * - 手机：会话列表顶部「工作 | 会话」切换；点线 → 过滤并切回会话列表。
 * 只有 admin 会渲染（useWorkModel 对非 admin 返回 enabled=false）。
 */
export function WorkOverviewPanel(props: { variant: 'desktop' | 'mobile' }) {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const { enabled, isLoading, error, result } = useWorkModel()
    const view = useWorkView()
    const relative = useRelativeDay()
    const mobile = props.variant === 'mobile'

    const selectLine = useCallback((lineId: string) => {
        setWorkView({ lineId, ...(mobile ? { mobileView: 'sessions' as const } : {}) })
    }, [mobile])

    const strips = useMemo(
        () => (result ? dailyActivity(result.model, result.sessions, STRIP_DAYS, Date.now()) : null),
        [result]
    )

    if (!enabled) return null
    if (error) return <div className="p-6 text-sm text-red-600">{t('work.loadFailed', { error })}</div>
    if (isLoading || !result || !strips) return <div className="p-6 text-sm text-[var(--app-hint)]">{t('loading')}</div>

    const { model } = result
    const selected = view.lineId ? findLine(model, view.lineId) : null

    if (model.mainlines.length === 0) {
        return (
            <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
                <div className="text-base font-semibold">{t('work.empty.title')}</div>
                <div className="max-w-sm text-sm text-[var(--app-hint)]">{t('work.empty.body')}</div>
                <button type="button" className="rounded-lg bg-[var(--app-button)] px-3 py-1.5 text-sm text-[var(--app-button-text)]" onClick={() => navigate({ to: '/work', search: { tab: 'triage' } })}>{t('work.triage.open')}</button>
            </div>
        )
    }

    const tiles: Array<{ key: string; value: number; label: string; icon: ReactNode; tint: string; fg: string; show: boolean }> = [
        { key: 'push', value: model.totals.pushingMainlines, label: t('work.stat.pushing'), icon: <TrendUpIcon className="h-4 w-4" />, tint: 'var(--wo-push-bg)', fg: 'var(--wo-push-fg)', show: !mobile },
        { key: 'active', value: model.totals.active, label: t('work.stat.running'), icon: <PlayIcon className="h-4 w-4" />, tint: 'rgba(34, 197, 94, 0.1)', fg: 'var(--wo-run)', show: true },
        {
            key: 'approval', value: model.totals.needsApproval, label: t('work.stat.approval'), icon: <BellIcon className="h-4 w-4" />,
            tint: model.totals.needsApproval > 0 ? 'var(--wo-need-bg)' : 'var(--wo-chip)',
            fg: model.totals.needsApproval > 0 ? 'var(--wo-need)' : 'var(--app-hint)', show: true
        },
        { key: 'stall', value: model.totals.stalledMainlines, label: t('work.stat.stalled'), icon: <PauseIcon className="h-4 w-4" />, tint: 'var(--wo-stall-bg)', fg: 'var(--wo-stall-fg)', show: true }
    ]

    return (
        <div className={cn('flex h-full min-h-0 flex-col', mobile ? 'px-3 pb-4' : 'bg-[var(--wo-page)] px-6 py-5')}>
            {mobile ? null : (
                <div className="mb-4 flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                        <h1 className="text-[22px] font-semibold tracking-tight">{t('work.title')}</h1>
                        <div className="mt-0.5 text-xs text-[var(--app-hint)]">
                            {t('work.summaryLine', { machines: model.machines.length, lines: model.mainlines.length, sessions: model.totals.sessions })}
                        </div>
                    </div>
                    <button type="button" className="wo-card wo-card-interactive flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium" onClick={() => navigate({ to: '/work' })}>
                        <WorkGridIcon className="h-3.5 w-3.5" />{t('work.map.open')}
                    </button>
                </div>
            )}

            <div className={cn('grid', mobile ? 'mb-3 mt-1 grid-cols-3 gap-2' : 'mb-5 grid-cols-4 gap-3')}>
                {tiles.filter(tile => tile.show).map(tile => (
                    <div key={tile.key} className={cn('wo-card', mobile ? 'px-2.5 py-2' : 'px-4 py-3')}>
                        <div className="flex items-center gap-2">
                            <span className={cn('flex shrink-0 items-center justify-center rounded-lg', mobile ? 'h-6 w-6' : 'h-8 w-8')} style={{ background: tile.tint, color: tile.fg }}>{tile.icon}</span>
                            <span className={cn('font-semibold tabular-nums tracking-tight', mobile ? 'text-lg' : 'text-[26px] leading-none')} style={tile.key === 'approval' && tile.value > 0 ? { color: 'var(--wo-need)' } : undefined}>{tile.value}</span>
                        </div>
                        <div className={cn('mt-1 truncate text-[var(--app-hint)]', mobile ? 'text-[10px]' : 'text-xs')}>{tile.label}</div>
                    </div>
                ))}
            </div>

            <div className="mb-2 flex items-center justify-between px-0.5">
                <span className="text-xs font-semibold text-[var(--app-hint)]">{t('work.section.mainlines')}</span>
                <span className="flex items-center gap-1.5 text-[10px] text-[var(--app-hint)]">
                    {t('work.strip.legend', { n: STRIP_DAYS })}
                    <HeatStrip counts={[0, 1, 2, 3, 4]} days={[]} size={7} />
                </span>
            </div>

            <div className="wo-scroll -mx-1 min-h-0 flex-1 space-y-2.5 overflow-y-auto px-1 pb-1">
                {model.mainlines.map(main => {
                    const isSelected = selected?.main.id === main.id
                    return (
                        <MainlineCard
                            key={main.id}
                            model={model}
                            main={main}
                            mobile={mobile}
                            counts={strips.byMainline.get(main.id) ?? []}
                            days={strips.days}
                            selected={isSelected}
                            selectedSublineId={isSelected ? selected?.sub?.id ?? null : null}
                            expanded={mobile && (isSelected || (!selected && main === model.mainlines[0]))}
                            relative={relative}
                            onSelect={selectLine}
                        />
                    )
                })}
            </div>

            <button
                type="button"
                className="wo-card wo-card-interactive mt-3 flex items-center gap-2.5 px-3.5 py-2.5 text-left"
                onClick={() => navigate({ to: '/work', search: { tab: 'triage' } })}
            >
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg" style={{ background: 'var(--wo-slow-bg)', color: 'var(--wo-slow-fg)' }}><InboxIcon className="h-4 w-4" /></span>
                <span className="min-w-0 flex-1 text-xs text-[var(--app-hint)]">
                    <span className="font-medium text-[var(--app-fg)]">{t('work.triage.title', { n: model.totals.unassignedSessions })}</span>
                    {mobile ? null : <span className="ml-2">{t('work.triage.sub', { folders: model.unassignedFolders.length })}</span>}
                </span>
                <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-[var(--wo-push-fg)]">{t('work.triage.open')}<ArrowRightIcon className="h-3.5 w-3.5" /></span>
            </button>
        </div>
    )
}

function MainlineCard(props: {
    model: WorkModel
    main: MainlineView
    mobile: boolean
    counts: number[]
    days: number[]
    selected: boolean
    selectedSublineId: string | null
    expanded: boolean
    relative: (at: number) => string
    onSelect: (lineId: string) => void
}) {
    const { t } = useTranslation()
    const { main, mobile } = props
    const chips = mobile ? main.sublines.slice(0, 3) : main.sublines
    return (
        <div
            role="button"
            tabIndex={0}
            onClick={() => props.onSelect(main.id)}
            onKeyDown={event => { if (event.key === 'Enter') props.onSelect(main.id) }}
            className={cn('wo-card wo-card-interactive wo-accent', mobile ? 'px-3.5 py-3' : 'px-4 py-3.5', props.selected && 'wo-card-selected')}
            style={statusAccentStyle(main.status)}
        >
            <div className="flex items-center gap-2">
                <span className="min-w-0 truncate text-[15px] font-semibold tracking-tight">{main.name}</span>
                <StatusBadge status={main.status} />
                {main.pendingCount > 0 ? <NeedBadge>{t('work.pending', { n: main.pendingCount })}</NeedBadge> : null}
                <span className="flex-1" />
                {mobile ? null : (
                    <span className="flex shrink-0 items-center gap-2">
                        <HeatStrip counts={props.counts} days={props.days} />
                        <span className="w-12 text-right text-[11px] text-[var(--app-hint)]">{props.relative(main.lastActivity)}</span>
                    </span>
                )}
            </div>
            {main.goal ? <div className="mt-1 truncate text-xs text-[var(--app-hint)]">{main.goal}</div> : null}
            {mobile ? <HeatStrip className="mt-2" counts={props.counts} days={props.days} size={8} /> : null}
            <div className="mt-2.5 flex flex-wrap gap-1.5">
                {chips.map(sub => {
                    const active = props.selectedSublineId === sub.id
                    return (
                        <button
                            key={sub.id}
                            type="button"
                            onClick={event => { event.stopPropagation(); props.onSelect(sub.id) }}
                            className={cn('inline-flex items-center gap-1.5 rounded-lg px-2 py-[3px] text-[11px]', active ? 'text-white' : 'wo-chip text-[var(--app-fg)]')}
                            style={active ? { background: 'var(--wo-push)' } : undefined}
                        >
                            {sub.activeCount > 0 ? <RunDot active className="h-1.5 w-1.5" /> : null}
                            {sub.name}
                            <span className={active ? 'opacity-80' : 'text-[var(--app-hint)]'}>{sub.sessionCount}</span>
                        </button>
                    )
                })}
                {mobile && main.sublines.length > 3 ? <span className="wo-chip rounded-lg px-2 py-[3px] text-[11px] text-[var(--app-hint)]">+{main.sublines.length - 3}</span> : null}
            </div>
            {props.expanded ? (
                <div className="mt-3 space-y-2 rounded-xl p-2.5" style={{ background: 'var(--wo-chip)' }}>
                    {main.sublines.slice(0, 3).map(sub => (
                        <div key={sub.id}>
                            <div className="flex items-center gap-1.5 text-xs font-medium">{sub.name}<StatusBadge status={sub.status} /></div>
                            {sub.projects.flatMap(project => project.folders).slice(0, 2).map(folder => (
                                <div key={folder.projectKey} className="mt-1 flex justify-between gap-2 text-[11px]">
                                    <span className="truncate">{folder.displayName}</span>
                                    <span className="shrink-0 text-[var(--app-hint)]">{folder.machineLabel} · {folder.sessionCount}</span>
                                </div>
                            ))}
                        </div>
                    ))}
                </div>
            ) : null}
            <div className="mt-3 flex items-center gap-3 border-t border-[var(--app-divider)] pt-2.5 text-[11px] text-[var(--app-hint)]">
                <MachineIconRow model={props.model} machineIds={main.machineIds} labels={main.machineLabels} max={mobile ? 4 : 6} />
                {main.nextStep ? (
                    <span className="flex min-w-0 flex-1 items-center gap-1">
                        <ArrowRightIcon className="h-3 w-3 shrink-0" />
                        <span className="truncate">{main.nextStep.text}</span>
                    </span>
                ) : <span className="flex-1" />}
                <span className="flex shrink-0 items-center gap-1.5">
                    <RunDot active={main.activeCount > 0} />
                    {mobile ? t('work.runningShort', { n: main.activeCount }) : t('work.cardMeta', { running: main.activeCount, sessions: main.sessionCount })}
                </span>
            </div>
        </div>
    )
}

/** 左栏顶部的过滤条：正在看哪条线。没选线或线已被删时不渲染。 */
export function WorkLineFilterBar() {
    const { t } = useTranslation()
    const view = useWorkView()
    const { enabled, result } = useWorkModel()
    if (!enabled || !result || !view.lineId) return null
    const found = findLine(result.model, view.lineId)
    if (!found) return null
    const line = found.sub ?? found.main
    return (
        <div data-testid="work-line-filter" className="mx-3 mb-1.5 mt-1 flex items-center gap-2 rounded-xl px-3 py-2 text-xs" style={{ background: 'var(--wo-push-bg)', color: 'var(--wo-push-fg)' }}>
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: 'var(--wo-push)' }} />
            <span className="min-w-0 flex-1 truncate">
                <span className="opacity-80">{found.sub ? t('work.filter.sublineLabel', { main: found.main.name }) : t('work.filter.mainlineLabel')}</span>
                <span className="ml-1 font-semibold">{line.name}</span>
                <span className="ml-1.5 opacity-80">· {t('work.sessionCount', { n: line.sessionCount })}</span>
            </span>
            <button type="button" className="shrink-0 rounded-md px-1.5 py-0.5 font-medium hover:bg-[var(--wo-push-bg)]" onClick={() => setWorkView({ lineId: null })}>
                {t('work.filter.clear')} ×
            </button>
        </div>
    )
}

/** 会话页用：选中了线时把会话列表过滤到这条线。非 admin / 未选线时原样返回。 */
export function useWorkLineSessionFilter(): (sessions: SessionSummary[]) => SessionSummary[] {
    const view = useWorkView()
    const { result } = useWorkModel()
    const ids = useMemo(() => (result && view.lineId && findLine(result.model, view.lineId) ? sessionsInLine(result.model, view.lineId) : null), [result, view.lineId])
    return useCallback((sessions: SessionSummary[]) => (ids ? sessions.filter(session => ids.has(session.id)) : sessions), [ids])
}

/** 手机端会话列表顶部的「工作 | 会话」切换。 */
export function WorkMobileToggle() {
    const { t } = useTranslation()
    const view = useWorkView()
    return (
        <div className="flex justify-center px-3 pb-2 pt-1 split:hidden">
            <div className="inline-flex rounded-xl p-[3px]" style={{ background: 'var(--wo-chip)' }}>
                {(['work', 'sessions'] as const).map(key => (
                    <button
                        key={key}
                        type="button"
                        onClick={() => setWorkView({ mobileView: key })}
                        className={cn(
                            'rounded-[10px] px-5 py-1 text-sm transition-colors',
                            view.mobileView === key ? 'bg-[var(--app-bg)] font-semibold shadow-sm' : 'text-[var(--app-hint)]'
                        )}
                    >
                        {t(key === 'work' ? 'work.toggle.work' : 'work.toggle.sessions')}
                    </button>
                ))}
            </div>
        </div>
    )
}

export { shortDate }
export type { WorkModel }
