import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from '@tanstack/react-router'
import type { SessionSummary } from '@/types/api'
import { useTranslation } from '@/lib/use-translation'
import { getSessionTitle } from '@/lib/sessionTitle'
import { cn } from '@/lib/utils'
import { MachineOsIcon } from '@/components/machinePresentation'
import { useDigestIndex } from '@/fork-features/session-digest/digestApi'
import {
    dailyActivity,
    findLine,
    isEmptyFilter,
    latestSessionInFolder,
    latestSessionInLine,
    sessionFilterPredicate,
    sessionsInLine,
    type MainlineView,
    type WorkFilter,
    type WorkModel,
    type WorkStatus
} from './deriveWork'
import { useWorkModel, type WorkModelResult } from './useWorkModel'
import { setWorkFilter, setWorkView, useWorkView } from './workViewStore'
import { newLineId, useWorkActions } from './workApi'
import { ArrowRightIcon, NeedBadge, RunDot, StatusBadge, WorkGridIcon, heatColor, shortDate, useRelativeDay } from './WorkParts'
import { NeedCard, type CardCandidate } from './NeedCard'
import { pickCardSessions } from './needCardModel'
import type { BriefingItem } from './workApi'
import { BriefingPanel } from './BriefingPanel'
import { LineDetailPanel, useLineDetailOpen } from './LineDetailPanel'

const STRIP_DAYS = 14
const STATUS_BAR: Record<WorkStatus, string> = { push: 'var(--wo-push)', slow: 'var(--wo-slow)', stall: 'var(--wo-stall)' }

type CardTab = 'all' | WorkStatus

/**
 * 方案 A（版式参照 GPT 方案 1「全局驾驶舱」）：会话页之上的工作总览。
 * - 桌面：没选会话时右栏原本是空的，这里放总览；点主线卡片空白处，左栏会话列表就过滤成这条线。
 * - 手机：会话列表顶部「工作 | 会话」切换。
 * 每个可点的东西都落到实际对象：会话、目录详情、工作台里的主线、或过滤后的会话列表。
 * 只有 admin 会渲染（useWorkModel 对非 admin 返回 enabled=false）。
 */
export function WorkOverviewPanel(props: { variant: 'desktop' | 'mobile' }) {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const { enabled, isLoading, error, result } = useWorkModel()
    const view = useWorkView()
    const digestIndex = useDigestIndex()
    const { upsertLine } = useWorkActions()
    const [tab, setTab] = useState<CardTab>('all')
    const [card, setCard] = useState<{
        sessionId: string
        title: string
        sub: string
        context?: { text: string; line: string | null }
        candidates?: CardCandidate[]
    } | null>(null)
    const [showDismissed, setShowDismissed] = useState(false)
    const { setDismissed } = useWorkActions()
    const needRef = useRef<HTMLDivElement>(null)
    const mobile = props.variant === 'mobile'

    const strips = useMemo(
        () => (result ? dailyActivity(result.model, result.sessions, STRIP_DAYS, Date.now()) : null),
        [result]
    )

    const openSession = useCallback((sessionId: string) => {
        navigate({ to: '/sessions/$sessionId', params: { sessionId } })
    }, [navigate])
    const filterSessions = useCallback((filter: WorkFilter) => {
        setWorkFilter(filter, { showSessions: mobile })
    }, [mobile])

    if (!enabled) return null
    if (error) return <div className="p-6 text-sm text-red-600">{t('work.loadFailed', { error })}</div>
    if (isLoading || !result || !strips) return <div className="p-6 text-sm text-[var(--app-hint)]">{t('loading')}</div>

    const { model, sessions } = result
    const selectedLine = view.filter?.lineId ? findLine(model, view.filter.lineId) : null

    if (model.mainlines.length === 0) {
        return (
            <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
                <div className="text-base font-semibold">{t('work.empty.title')}</div>
                <div className="max-w-sm text-sm text-[var(--app-hint)]">{t('work.empty.body')}</div>
                <button type="button" className="wo-btn-primary px-3 py-1.5 text-sm" onClick={() => navigate({ to: '/work', search: { tab: 'triage' } })}>{t('work.triage.open')}</button>
            </div>
        )
    }

    // 「需要你处理」：去掉用户忽略过的会话；左栏按主线/支线过滤时，这里也只看这条线。
    const { dismissed } = result
    const focusLine = view.filter?.lineId ? findLine(model, view.filter.lineId) : null
    const focusSessions = focusLine ? sessionsInLine(model, (focusLine.sub ?? focusLine.main).id) : null
    const pendingSessions = sessions
        .filter(session => session.pendingRequestsCount > 0 && !dismissed.has(session.id) && (!focusSessions || focusSessions.has(session.id)))
        .sort((a, b) => b.updatedAt - a.updatedAt)
    const stalled = model.mainlines.filter(line => line.status === 'stall' && (!focusLine || focusLine.main.id === line.id))
    const dismissedSessions = sessions.filter(session => dismissed.has(session.id)).sort((a, b) => b.updatedAt - a.updatedAt)
    const lineNameOfSession = (session: SessionSummary) => {
        const sub = model.sublineOfSession.get(session.id)
        const main = sub ? model.mainlineOfLine.get(sub) : undefined
        return main ? findLine(model, main)?.main.name ?? null : null
    }
    const machineLabelOf = (session: SessionSummary) => model.machines.find(machine => machine.id === (session.metadata?.machineId ?? null))?.label ?? session.metadata?.host ?? '?'
    const openCard = (session: SessionSummary) => setCard({
        sessionId: session.id,
        title: getSessionTitle(session) || t('work.untitled'),
        sub: [machineLabelOf(session), lineNameOfSession(session)].filter(Boolean).join(' · ')
    })
    const toCandidate = (session: SessionSummary): CardCandidate => ({
        id: session.id,
        title: getSessionTitle(session) || t('work.untitled'),
        sub: [machineLabelOf(session), lineNameOfSession(session), shortDate(session.updatedAt)].filter(Boolean).join(' · '),
        active: session.active,
        pending: session.pendingRequestsCount
    })
    // 梳理待办里的一条：指名会话的直接开它的卡片；只指到主线/支线的，开这条线里最该看的会话，卡片里可切换。
    const openBriefingItem = (item: BriefingItem) => {
        const target = item.sessionId ? sessions.find(session => session.id === item.sessionId) ?? null : null
        const lineId = item.lineId ?? (target ? model.sublineOfSession.get(target.id) ?? null : null)
        const lineIds = lineId && findLine(model, lineId) ? sessionsInLine(model, lineId) : null
        const pool = [...(lineIds ? sessions.filter(session => lineIds.has(session.id)) : []), ...(target ? [target] : [])]
        const { initial, list } = pickCardSessions(pool, target?.id ?? null)
        const first = list.find(session => session.id === initial)
        if (!first) {
            if (lineId) filterSessions({ lineId })
            return
        }
        const found = lineId ? findLine(model, lineId) : null
        const candidate = toCandidate(first)
        setCard({
            sessionId: first.id,
            title: candidate.title,
            sub: candidate.sub,
            context: { text: item.text, line: found ? (found.sub ?? found.main).name : null },
            candidates: list.map(toCandidate)
        })
    }
    const needItems: Array<{ key: string; title: string; sub: string; tone: 'need' | 'slow' | 'stall'; onClick: () => void; onDismiss?: () => void; sessionId?: string }> = [
        ...pendingSessions.slice(0, focusLine ? 12 : 6).map(session => ({
            key: `pending-${session.id}`,
            title: getSessionTitle(session) || t('work.untitled'),
            sub: [machineLabelOf(session), t('work.need.approvals', { n: session.pendingRequestsCount }), lineNameOfSession(session), shortDate(session.updatedAt)].filter(Boolean).join(' · '),
            tone: 'need' as const,
            sessionId: session.id,
            onClick: () => openCard(session),
            onDismiss: () => setDismissed.mutate({ sessionId: session.id, dismissed: true })
        })),
        ...(model.unassignedFolders.length > 0 && !focusLine ? [{
            key: 'folders',
            title: t('work.need.folders', { n: model.unassignedFolders.length }),
            sub: model.unassignedFolders.slice(0, 3).map(folder => folder.displayName).join('、'),
            tone: 'slow' as const,
            onClick: () => navigate({ to: '/work', search: { tab: 'triage' } })
        }] : []),
        ...stalled.slice(0, 2).map(line => ({
            key: `stall-${line.id}`,
            title: t('work.need.stalled', { name: line.name, n: Math.max(1, Math.floor((Date.now() - line.lastActivity) / 86_400_000)) }),
            sub: line.nextStep ? t('work.nextStepInline', { text: line.nextStep.text }) : line.goal,
            tone: 'stall' as const,
            onClick: () => navigate({ to: '/work', search: { tab: 'lines', line: line.id } })
        }))
    ]

    const projectCount = (lines: MainlineView[]) => lines.reduce((sum, line) => sum + line.sublines.reduce((s, sub) => s + sub.projects.length, 0), 0)
    const pushing = model.mainlines.filter(line => line.status === 'push')
    const activeMachines = new Set(sessions.filter(session => session.active).map(session => session.metadata?.machineId)).size
    const stats: Array<{ key: string; label: string; value: number; note: string; color: string; onClick: () => void }> = [
        { key: 'push', label: t('work.stat2.pushing'), value: pushing.length, note: t('work.stat2.pushingNote', { n: projectCount(pushing) }), color: 'var(--wo-push)', onClick: () => setTab('push') },
        { key: 'need', label: t('work.stat2.need'), value: needItems.length, note: t('work.stat2.needNote', { a: pendingSessions.length, b: needItems.length - Math.min(4, pendingSessions.length) }), color: 'var(--wo-slow)', onClick: () => needRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }) },
        { key: 'running', label: t('work.stat2.running'), value: model.totals.active, note: t('work.stat2.runningNote', { n: activeMachines }), color: 'var(--wo-run)', onClick: () => filterSessions({ mode: 'running' }) },
        { key: 'triage', label: t('work.stat2.triage'), value: model.totals.unassignedSessions, note: t('work.stat2.triageNote', { n: model.unassignedFolders.length }), color: 'var(--wo-muted)', onClick: () => navigate({ to: '/work', search: { tab: 'triage' } }) }
    ]

    const tabs: Array<{ key: CardTab; label: string; n: number }> = [
        { key: 'all', label: t('work.tabs.all'), n: model.mainlines.length },
        { key: 'push', label: t('work.status.push'), n: model.mainlines.filter(line => line.status === 'push').length },
        { key: 'slow', label: t('work.status.slow'), n: model.mainlines.filter(line => line.status === 'slow').length },
        { key: 'stall', label: t('work.status.stall'), n: model.mainlines.filter(line => line.status === 'stall').length }
    ]
    const shownLines = model.mainlines.filter(line => tab === 'all' || line.status === tab)

    const done = sessions
        .filter(session => digestIndex[session.id]?.completed)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 3)

    const addMainline = async () => {
        const name = window.prompt(t('work.prompt.newMainline'))?.trim()
        if (!name) return
        const mainId = newLineId()
        await upsertLine.mutateAsync({ id: mainId, parentId: null, name, goal: '', sort: model.mainlines.length })
        const subName = window.prompt(t('work.prompt.firstSubline'), name)?.trim()
        if (subName) await upsertLine.mutateAsync({ id: newLineId(), parentId: mainId, name: subName, goal: '', sort: 0 })
    }

    return (
        <div className={cn('wo-scroll h-full overflow-y-auto', mobile ? 'px-3 pb-6' : 'bg-[var(--wo-page)]')}>
            <div className={cn('mx-auto', mobile ? '' : 'max-w-[1180px] px-8 py-7')}>
                {mobile ? null : (
                    <div className="mb-6 flex items-start gap-4">
                        <div className="min-w-0 flex-1">
                            <div className="text-[13px] text-[var(--wo-muted)]">{t('work.title')}</div>
                            <h1 data-testid="work-overview-title" className="mt-1 text-[28px] font-bold leading-tight tracking-tight text-[var(--wo-ink)]">{t('work.hero.title')}</h1>
                            <p className="mt-1.5 text-[13px] text-[var(--wo-muted)]">
                                {t('work.hero.subtitle')}
                                <span className="ml-2">{t('work.summaryLine', { machines: model.machines.length, lines: model.mainlines.length, sessions: model.totals.sessions })}</span>
                            </p>
                        </div>
                        <button type="button" data-testid="work-help" className="wo-card wo-card-interactive mt-1 flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium" onClick={() => navigate({ to: '/settings/help' })}>
                            <span aria-hidden className="flex h-3.5 w-3.5 items-center justify-center rounded-full border border-current text-[9px] font-bold leading-none">?</span>{t('settings.help.title')}
                        </button>
                        <button type="button" className="wo-card wo-card-interactive mt-1 flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium" onClick={() => navigate({ to: '/work' })}>
                            <WorkGridIcon className="h-3.5 w-3.5" />{t('work.bench.open')}
                        </button>
                    </div>
                )}

                <div className={cn('grid gap-3', mobile ? 'mt-1 grid-cols-2' : 'grid-cols-4 gap-4')}>
                    {stats.map(stat => (
                        <button key={stat.key} type="button" onClick={stat.onClick} data-testid={`work-stat-${stat.key}`} className={cn('wo-card wo-card-interactive text-left', mobile ? 'px-3.5 py-3' : 'px-5 py-4')}>
                            <div className="text-xs text-[var(--wo-muted)]">{stat.label}</div>
                            <div className="mt-1.5 flex items-baseline gap-2.5">
                                <span className={cn('font-bold tabular-nums tracking-tight', mobile ? 'text-2xl' : 'text-[32px] leading-none')} style={{ color: stat.color }}>{String(stat.value).padStart(2, '0')}</span>
                                <span className="min-w-0 truncate text-xs text-[var(--wo-muted)]">{stat.note}</span>
                            </div>
                        </button>
                    ))}
                </div>

                <BriefingPanel
                    result={result}
                    digestIndex={digestIndex}
                    mobile={mobile}
                    onItem={openBriefingItem}
                />

                <div ref={needRef} data-testid="work-need" className="mt-5 rounded-2xl px-5 py-4" style={{ background: 'var(--wo-soft)' }}>
                    <div className="mb-2 flex items-center gap-2">
                        <div className="text-[15px] font-bold text-[var(--wo-ink)]">{t('work.need.title')}</div>
                        {focusLine ? (
                            <button type="button" data-testid="work-need-focus" className="wo-chip flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] text-[var(--wo-ink)]" onClick={() => setWorkFilter(null)}>
                                {t('work.need.only', { name: (focusLine.sub ?? focusLine.main).name })} ×
                            </button>
                        ) : null}
                    </div>
                    {needItems.length === 0 ? <div className="py-2 text-xs text-[var(--wo-muted)]">{t('work.need.none')}</div> : (
                        <div className="space-y-0.5">
                            {needItems.map(item => (
                                <div key={item.key} className="flex items-center gap-1">
                                    <button type="button" data-testid={item.onDismiss ? 'work-need-pending' : undefined} data-session-id={item.sessionId} onClick={item.onClick} className="wo-clickable flex min-w-0 flex-1 items-center gap-3 px-2 py-2 text-left">
                                        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[var(--wo-card)] text-sm font-bold" style={{ color: item.tone === 'need' ? 'var(--wo-need)' : item.tone === 'slow' ? 'var(--wo-slow)' : 'var(--wo-muted)' }}>!</span>
                                        <span className="min-w-0 flex-1">
                                            <span className="block truncate text-[13px] font-semibold text-[var(--wo-ink)]">{item.title}</span>
                                            <span className="block truncate text-xs text-[var(--wo-muted)]">{item.sub}</span>
                                        </span>
                                        <ArrowRightIcon className="h-4 w-4 shrink-0 text-[var(--wo-push)]" />
                                    </button>
                                    {item.onDismiss ? (
                                        <button
                                            type="button"
                                            data-testid="work-need-dismiss"
                                            onClick={item.onDismiss}
                                            title={t('work.need.dismissHint')}
                                            className="shrink-0 rounded-md px-2 py-1 text-[11px] text-[var(--wo-muted)] hover:bg-[var(--wo-card)] hover:text-[var(--wo-ink)]"
                                        >
                                            {t('work.need.dismiss')}
                                        </button>
                                    ) : null}
                                </div>
                            ))}
                        </div>
                    )}
                    {dismissedSessions.length > 0 ? (
                        <div className="mt-2 border-t border-[var(--wo-border)] pt-2">
                            <button type="button" data-testid="work-need-dismissed-toggle" className="text-[11px] text-[var(--wo-muted)] hover:text-[var(--wo-ink)]" onClick={() => setShowDismissed(open => !open)}>
                                {t('work.need.dismissedCount', { n: dismissedSessions.length })} {showDismissed ? '▴' : '▾'}
                            </button>
                            {showDismissed ? (
                                <div className="mt-1 space-y-0.5">
                                    {dismissedSessions.slice(0, 30).map(session => (
                                        <div key={session.id} className="flex items-center gap-2 px-2 py-1 text-xs">
                                            <span className="min-w-0 flex-1 truncate text-[var(--wo-muted)]">{getSessionTitle(session) || t('work.untitled')}</span>
                                            <button type="button" className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-[var(--wo-push-fg)] hover:bg-[var(--wo-card)]" onClick={() => setDismissed.mutate({ sessionId: session.id, dismissed: false })}>
                                                {t('work.need.restore')}
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            ) : null}
                        </div>
                    ) : null}
                </div>
                {card ? <NeedCard sessionId={card.sessionId} title={card.title} sub={card.sub} dismissedIds={dismissed} context={card.context} candidates={card.candidates} onClose={() => setCard(null)} /> : null}

                <div className={cn('mb-4 mt-7 flex flex-wrap items-center gap-3', mobile && 'mt-5')}>
                    <h2 className="text-[19px] font-bold tracking-tight text-[var(--wo-ink)]">{t('work.section.myLines')}</h2>
                    <div className="flex items-center gap-1">
                        {tabs.map(item => (
                            <button
                                key={item.key}
                                type="button"
                                onClick={() => setTab(item.key)}
                                className={cn('rounded-lg px-2.5 py-1 text-xs', tab === item.key ? 'font-semibold text-[var(--wo-push-fg)]' : 'text-[var(--wo-muted)] hover:text-[var(--wo-ink)]')}
                                style={tab === item.key ? { background: 'var(--wo-push-bg)' } : undefined}
                            >
                                {item.label} {item.n}
                            </button>
                        ))}
                    </div>
                    <span className="flex-1" />
                    {mobile ? null : (
                        <button type="button" className="wo-btn-primary px-4 py-2 text-sm" onClick={() => { void addMainline() }}>{t('work.line.newMainline')}</button>
                    )}
                </div>

                <div className="grid gap-4" style={{ gridTemplateColumns: mobile ? 'minmax(0, 1fr)' : 'repeat(auto-fill, minmax(min(420px, 100%), 1fr))' }}>
                    {shownLines.map(main => (
                        <MainlineCard
                            key={main.id}
                            result={result}
                            main={main}
                            mobile={mobile}
                            counts={strips.byMainline.get(main.id) ?? []}
                            days={strips.days}
                            selected={selectedLine?.main.id === main.id}
                            selectedSublineId={selectedLine?.main.id === main.id ? selectedLine?.sub?.id ?? null : null}
                            onFilter={filterSessions}
                            onOpenSession={openSession}
                        />
                    ))}
                </div>

                {done.length > 0 ? (
                    <div className="wo-card mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 px-5 py-3.5">
                        <span className="flex shrink-0 items-center gap-2 text-xs text-[var(--wo-muted)]"><RunDot active className="h-2 w-2" />{t('work.done.title')}</span>
                        {done.map(session => (
                            <button key={session.id} type="button" onClick={() => openSession(session.id)} className="wo-clickable min-w-0 max-w-[320px] px-1.5 py-0.5 text-left">
                                <span className="block truncate text-[13px] font-semibold text-[var(--wo-ink)]">{getSessionTitle(session) || t('work.untitled')}</span>
                                <span className="block truncate text-[11px] text-[var(--wo-muted)]">{[lineNameOfSession(session), shortDate(session.updatedAt)].filter(Boolean).join(' · ')}</span>
                            </button>
                        ))}
                    </div>
                ) : null}
            </div>
        </div>
    )
}

function MainlineCard(props: {
    result: WorkModelResult
    main: MainlineView
    mobile: boolean
    counts: number[]
    days: number[]
    selected: boolean
    selectedSublineId: string | null
    onFilter: (filter: WorkFilter) => void
    onOpenSession: (sessionId: string) => void
}) {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const relative = useRelativeDay()
    const { main, mobile, result } = props
    const { model, sessions } = result
    const projects = main.sublines.flatMap(sub => sub.projects).sort((a, b) => b.lastActivity - a.lastActivity)
    const latest = useMemo(() => latestSessionInLine(model, sessions, main.id), [model, sessions, main.id])
    const nextSession = useMemo(
        () => (main.nextStep ? latestSessionInFolder(sessions, main.nextStep.projectKey) : null),
        [sessions, main.nextStep]
    )
    const machineOf = new Map(model.machines.map(machine => [machine.id, machine]))
    const stop = (event: { stopPropagation: () => void }) => event.stopPropagation()

    return (
        <div
            role="button"
            tabIndex={0}
            data-testid="work-mainline-card"
            onClick={() => props.onFilter({ lineId: main.id })}
            onKeyDown={event => { if (event.key === 'Enter') props.onFilter({ lineId: main.id }) }}
            className={cn('wo-card wo-card-interactive flex min-w-0 flex-col', mobile ? 'p-4' : 'p-5', props.selected && 'wo-card-selected')}
        >
            <div className="flex items-center gap-2.5">
                <span className="h-6 w-1 shrink-0 rounded-full" style={{ background: STATUS_BAR[main.status] }} />
                <button
                    type="button"
                    onClick={event => { stop(event); navigate({ to: '/work', search: { tab: 'lines', line: main.id } }) }}
                    className="min-w-0 truncate text-left text-[18px] font-bold tracking-tight text-[var(--wo-ink)] hover:underline"
                >
                    {main.name}
                </button>
                <span className="flex-1" />
                {main.pendingCount > 0 ? (
                    <button type="button" onClick={event => { stop(event); props.onFilter({ lineId: main.id, mode: 'pending' }) }}>
                        <NeedBadge>{t('work.pending', { n: main.pendingCount })}</NeedBadge>
                    </button>
                ) : null}
                <StatusBadge status={main.status} />
            </div>
            <div className="mt-1 truncate pl-3.5 text-[13px] text-[var(--wo-muted)]">{t('work.card.kind')} · {main.goal || main.sublines.map(sub => sub.name).join('、')}</div>

            <div className="mt-4 flex items-start gap-3 text-[13px]">
                <span className="w-16 shrink-0 pt-0.5 text-xs text-[var(--wo-muted)]">{t('work.card.projects')}</span>
                <div className="flex min-w-0 flex-wrap gap-x-3 gap-y-1">
                    {projects.slice(0, mobile ? 2 : 3).map(project => (
                        <button
                            key={project.name}
                            type="button"
                            onClick={event => { stop(event); navigate({ to: '/work', search: { tab: 'map', folder: project.folders[0]!.projectKey } }) }}
                            className="max-w-[180px] truncate text-left font-medium text-[var(--wo-ink)] hover:text-[var(--wo-push-fg)] hover:underline"
                            title={project.folders.map(folder => `${folder.machineLabel} · ${folder.path}`).join('\n')}
                        >
                            {project.name}
                        </button>
                    ))}
                    {projects.length > (mobile ? 2 : 3) ? <span className="text-xs text-[var(--wo-muted)]">+{projects.length - (mobile ? 2 : 3)}</span> : null}
                </div>
            </div>

            <div className="mt-2.5 flex flex-wrap gap-1.5 pl-[76px]">
                {main.sublines.slice(0, mobile ? 3 : 6).map(sub => {
                    const active = props.selectedSublineId === sub.id
                    return (
                        <button
                            key={sub.id}
                            type="button"
                            onClick={event => { stop(event); props.onFilter({ lineId: sub.id }) }}
                            className={cn('inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px]', active ? 'text-white' : 'wo-chip text-[var(--wo-ink)]')}
                            style={active ? { background: 'var(--wo-push)' } : undefined}
                        >
                            {sub.activeCount > 0 ? <RunDot active className="h-1.5 w-1.5" /> : null}
                            {sub.name}
                            <span className={active ? 'opacity-80' : 'text-[var(--wo-muted)]'}>{sub.sessionCount}</span>
                        </button>
                    )
                })}
            </div>

            {main.nextStep ? (
                <button
                    type="button"
                    onClick={event => { stop(event); if (nextSession) props.onOpenSession(nextSession.id) }}
                    className="mt-4 flex items-start gap-3 rounded-xl px-4 py-3 text-left transition-colors hover:brightness-[0.98]"
                    style={{ background: 'var(--wo-next-bg)' }}
                    title={nextSession ? getSessionTitle(nextSession) : undefined}
                >
                    <span className="shrink-0 text-[13px] font-bold text-[var(--wo-push-fg)]">{t('work.card.next')}</span>
                    <span className="line-clamp-2 min-w-0 text-[13px] text-[var(--wo-ink)]">{main.nextStep.text}</span>
                </button>
            ) : null}

            {mobile ? null : (
                <div className="mt-4 flex items-center gap-3 text-xs text-[var(--wo-muted)]">
                    <span className="w-16 shrink-0">{t('work.card.activity')}</span>
                    <span className="flex items-center gap-[2px]">
                        {props.counts.map((n, index) => (
                            <button
                                key={props.days[index] ?? index}
                                type="button"
                                title={`${shortDate(props.days[index] ?? 0)}: ${n}`}
                                disabled={n === 0}
                                onClick={event => { stop(event); props.onFilter({ lineId: main.id, day: props.days[index] }) }}
                                className="h-[10px] w-[10px] rounded-[2px] enabled:hover:ring-1 enabled:hover:ring-[var(--wo-push)]"
                                style={{ background: heatColor(n) }}
                            />
                        ))}
                    </span>
                    <span className="flex-1" />
                    <span className="flex items-center gap-1">
                        {main.machineIds.slice(0, 5).map((id, index) => {
                            const machine = machineOf.get(id)
                            return (
                                <button
                                    key={`${id ?? '?'}-${index}`}
                                    type="button"
                                    title={main.machineLabels[index]}
                                    onClick={event => { stop(event); if (id) props.onFilter({ lineId: main.id, machineId: id }) }}
                                    className="flex h-5 w-5 items-center justify-center rounded-md hover:ring-1 hover:ring-[var(--wo-push)]"
                                    style={{ background: 'var(--wo-chip)' }}
                                >
                                    <MachineOsIcon platform={machine?.platform ?? null} icon={machine?.icon ?? null} className="h-3 w-3" />
                                </button>
                            )
                        })}
                        {main.machineIds.length > 5 ? <span>+{main.machineIds.length - 5}</span> : null}
                    </span>
                </div>
            )}

            <div className={cn('mt-auto', mobile ? 'pt-3.5' : 'pt-4')}>
                <div className="flex items-center gap-3 border-t border-[var(--wo-border)] pt-3.5 text-xs text-[var(--wo-muted)]">
                    <span className="min-w-0 truncate">{t('work.card.meta', { subs: main.sublines.length, sessions: main.sessionCount, when: relative(main.lastActivity) })}</span>
                    <span className="flex-1" />
                    <button
                        type="button"
                        data-testid="work-continue"
                        disabled={!latest}
                        onClick={event => { stop(event); if (latest) props.onOpenSession(latest.id) }}
                        className="wo-link flex shrink-0 items-center gap-1 text-[13px] disabled:opacity-40"
                        title={latest ? getSessionTitle(latest) : undefined}
                    >
                        {t('work.card.continue')}<ArrowRightIcon className="h-3.5 w-3.5" />
                    </button>
                </div>
            </div>
        </div>
    )
}

/** 左栏顶部的过滤条：正在看什么。没有过滤或线已被删时不渲染。 */
export function WorkLineFilterBar() {
    const { t } = useTranslation()
    const view = useWorkView()
    const { enabled, result } = useWorkModel()
    const [detailOpen, toggleDetail] = useLineDetailOpen()
    if (!enabled || !result || isEmptyFilter(view.filter)) return null
    const filter = view.filter!
    const { model, sessions } = result
    const parts: ReactNode[] = []
    const found = filter.lineId ? findLine(model, filter.lineId) : null
    const lineId = found ? (found.sub ?? found.main).id : null
    if (found) parts.push(<span key="line"><span className="opacity-80">{found.sub ? t('work.filter.sublineLabel', { main: found.main.name }) : t('work.filter.mainlineLabel')}</span> <b>{(found.sub ?? found.main).name}</b></span>)
    if (filter.machineId) parts.push(<b key="machine">{model.machines.find(machine => machine.id === filter.machineId)?.label ?? filter.machineId.slice(0, 8)}</b>)
    if (filter.projectKey) parts.push(<b key="folder">{model.folders.get(filter.projectKey)?.displayName ?? filter.projectKey.split('::')[1]}</b>)
    if (filter.day !== undefined) parts.push(<b key="day">{shortDate(filter.day)}</b>)
    if (filter.mode) parts.push(<b key="mode">{t(filter.mode === 'running' ? 'work.filter.running' : 'work.filter.pending')}</b>)
    const predicate = sessionFilterPredicate(model, filter)
    const count = sessions.filter(predicate).length
    return (
        <div data-testid="work-line-filter" className="mx-3 mb-1.5 mt-1 rounded-xl px-3 py-2 text-xs" style={{ background: 'var(--wo-push-bg)', color: 'var(--wo-push-fg)' }}>
            <div className="flex items-center gap-2">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: 'var(--wo-push)' }} />
                <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 truncate">
                    {parts.map((part, index) => <span key={index} className="flex items-center gap-1.5">{index > 0 ? <span className="opacity-50">·</span> : null}{part}</span>)}
                    <span className="opacity-80">· {t('work.sessionCount', { n: count })}</span>
                </span>
                {lineId ? (
                    <button type="button" data-testid="work-line-detail-toggle" aria-expanded={detailOpen} className="shrink-0 rounded-md px-1.5 py-0.5 font-medium hover:bg-[var(--wo-push-bg)]" onClick={toggleDetail}>
                        {t('work.lineDetail.toggle')} {detailOpen ? '▴' : '▾'}
                    </button>
                ) : null}
                <button type="button" className="shrink-0 rounded-md px-1.5 py-0.5 font-medium hover:bg-[var(--wo-push-bg)]" onClick={() => setWorkFilter(null)}>
                    {t('work.filter.clear')} ×
                </button>
            </div>
            {lineId && detailOpen ? <LineDetailPanel model={model} sessions={sessions} lineId={lineId} /> : null}
        </div>
    )
}

/** 会话页用：有过滤条件时把会话列表过滤掉。非 admin / 没过滤时原样返回。 */
export function useWorkLineSessionFilter(): (sessions: SessionSummary[]) => SessionSummary[] {
    const view = useWorkView()
    const { result } = useWorkModel()
    const predicate = useMemo(
        () => (result && !isEmptyFilter(view.filter) ? sessionFilterPredicate(result.model, view.filter!) : null),
        [result, view.filter]
    )
    return useCallback((sessions: SessionSummary[]) => (predicate ? sessions.filter(predicate) : sessions), [predicate])
}

/** 手机端会话列表顶部的「工作 | 会话」切换。 */
export function WorkMobileToggle(props: { compact?: boolean }) {
    const { t } = useTranslation()
    const view = useWorkView()
    return (
        <div className={cn('flex split:hidden', props.compact ? 'justify-start' : 'justify-center', props.compact ? '' : 'px-3 pb-2 pt-1')}>
            <div className="inline-flex rounded-xl p-[3px]" style={{ background: 'var(--wo-chip)' }}>
                {(['work', 'sessions'] as const).map(key => (
                    <button
                        key={key}
                        type="button"
                        onClick={() => setWorkView({ mobileView: key })}
                        className={cn(
                            'rounded-[10px] transition-colors',
                            props.compact ? 'px-3 py-0.5 text-xs' : 'px-5 py-1 text-sm',
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
