import { useMemo, useState, type ReactNode } from 'react'
import { Navigate, useNavigate } from '@tanstack/react-router'
import type { SessionSummary } from '@/types/api'
import { useTranslation } from '@/lib/use-translation'
import { getSessionTitle } from '@/lib/sessionTitle'
import { cn } from '@/lib/utils'
import { MachineOsIcon } from '@/components/machinePresentation'
import { dailyActivity, findLine, projectKeyOfSession, type FolderStat, type MainlineView, type WorkModel } from './deriveWork'
import { useWorkModel } from './useWorkModel'
import { newLineId, useWorkActions } from './workApi'
import { setWorkView } from './workViewStore'
import {
    AssignSelect,
    CalendarIcon,
    CrossMachineIcon,
    ListTodoIcon,
    MapIcon,
    NeedBadge,
    RunDot,
    StageBadge,
    StatusBadge,
    heatColor,
    shortDate,
    stageDotColor,
    statusAccentStyle,
    useRelativeDay,
    type AssignChoice
} from './WorkParts'

export type WorkTab = 'map' | 'timeline' | 'triage'

type Selection = { kind: 'folder'; projectKey: string } | { kind: 'line'; lineId: string } | null

/**
 * /work：方案 B（主线 × 机器的工作地图）+ 方案 C（时间泳道，作为同页的一个视图）+ 待整理。
 * 只有 admin 能进；其他账号直接回会话页。
 */
export function WorkMapPage(props: { tab: WorkTab; onTabChange: (tab: WorkTab) => void }) {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const { enabled, isLoading, error, result } = useWorkModel()
    const [selection, setSelection] = useState<Selection>(null)
    const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
    const { upsertLine } = useWorkActions()

    if (!enabled) return <Navigate to="/sessions" replace />

    const model = result?.model
    const triageCount = model?.totals.unassignedSessions ?? 0
    const tabs: Array<{ key: WorkTab; label: string; icon: ReactNode; badge?: number }> = [
        { key: 'map', label: t('work.tab.map'), icon: <MapIcon className="h-3.5 w-3.5" /> },
        { key: 'timeline', label: t('work.tab.timeline'), icon: <CalendarIcon className="h-3.5 w-3.5" /> },
        { key: 'triage', label: t('work.tab.triage'), icon: <ListTodoIcon className="h-3.5 w-3.5" />, badge: triageCount }
    ]
    const addMainline = async () => {
        const name = window.prompt(t('work.prompt.newMainline'))?.trim()
        if (!name || !model) return
        const id = newLineId()
        await upsertLine.mutateAsync({ id, parentId: null, name, goal: '', sort: model.mainlines.length })
        setSelection({ kind: 'line', lineId: id })
    }

    return (
        <div className="flex h-full min-h-0 flex-col bg-[var(--wo-page)] pt-[env(safe-area-inset-top)]">
            <div className="flex h-[56px] shrink-0 items-center gap-2 border-b border-[var(--app-divider)] bg-[var(--app-bg)] px-3 split:px-5">
                <button type="button" className="rounded-full p-1.5 text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]" onClick={() => navigate({ to: '/sessions' })} aria-label={t('work.back')}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5"><path d="M15 18l-6-6 6-6" /></svg>
                </button>
                <h1 className="hidden text-[17px] font-semibold tracking-tight sm:block">{t('work.map.title')}</h1>
                <div className="mx-auto inline-flex rounded-xl p-[3px] sm:mx-4" style={{ background: 'var(--wo-chip)' }}>
                    {tabs.map(tab => (
                        <button
                            key={tab.key}
                            type="button"
                            onClick={() => { props.onTabChange(tab.key); setSelection(null) }}
                            className={cn(
                                'flex items-center gap-1.5 whitespace-nowrap rounded-[10px] px-3 py-1 text-xs transition-colors sm:text-sm',
                                props.tab === tab.key ? 'bg-[var(--app-bg)] font-semibold shadow-sm' : 'text-[var(--app-hint)] hover:text-[var(--app-fg)]'
                            )}
                        >
                            {tab.icon}
                            {tab.label}
                            {tab.badge ? <span className="rounded-full px-1.5 text-[10px] font-semibold tabular-nums" style={{ background: 'var(--wo-slow-bg)', color: 'var(--wo-slow-fg)' }}>{tab.badge}</span> : null}
                        </button>
                    ))}
                </div>
                <span className="hidden flex-1 sm:block" />
                <button type="button" className="wo-card wo-card-interactive hidden px-3 py-1.5 text-xs font-medium sm:block" onClick={() => { void addMainline() }}>{t('work.line.newMainline')}</button>
            </div>

            {error ? <div className="p-6 text-sm text-red-600">{t('work.loadFailed', { error })}</div> : null}
            {!error && (isLoading || !result || !model) ? <div className="p-6 text-sm text-[var(--app-hint)]">{t('loading')}</div> : null}

            {result && model ? (
                <div className="flex min-h-0 flex-1">
                    <div className="wo-scroll min-w-0 flex-1 overflow-auto p-3 split:p-6">
                        {props.tab === 'map' ? (
                            <WorkMatrix model={model} expanded={expanded} setExpanded={setExpanded} selection={selection} onSelect={setSelection} />
                        ) : props.tab === 'timeline' ? (
                            <WorkTimeline model={model} sessions={result.sessions} selection={selection} onSelect={setSelection} />
                        ) : (
                            <WorkTriage model={model} onSelect={setSelection} />
                        )}
                    </div>
                    {selection ? (
                        <aside className="wo-scroll fixed inset-x-0 bottom-0 z-30 max-h-[78vh] overflow-y-auto rounded-t-2xl border-t border-[var(--app-border)] bg-[var(--app-bg)] p-5 shadow-[0_-8px_24px_rgba(0,0,0,0.12)] split:static split:z-auto split:max-h-none split:w-[400px] split:shrink-0 split:rounded-none split:border-l split:border-t-0 split:shadow-none">
                            <button type="button" className="float-right -mr-1 -mt-1 flex h-7 w-7 items-center justify-center rounded-full text-lg leading-none text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]" onClick={() => setSelection(null)} aria-label={t('work.close')}>×</button>
                            {selection.kind === 'folder'
                                ? <FolderDetail model={model} sessions={result.sessions} projectKey={selection.projectKey} onSelectLine={lineId => setSelection({ kind: 'line', lineId })} />
                                : <LineDetail model={model} sessions={result.sessions} lineId={selection.lineId} onSelectFolder={projectKey => setSelection({ kind: 'folder', projectKey })} onDeleted={() => setSelection(null)} />}
                        </aside>
                    ) : null}
                </div>
            ) : null}
        </div>
    )
}

/* ---------------------------------------------------------------- 方案 B：主线 × 机器 */

function MachineHead(props: { machine: WorkModel['machines'][number] }) {
    const { t } = useTranslation()
    return (
        <div className="flex items-center gap-2">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg" style={{ background: 'var(--wo-chip)' }}>
                <MachineOsIcon platform={props.machine.platform} icon={props.machine.icon} className="h-3.5 w-3.5" />
            </span>
            <div className="min-w-0">
                <div className="truncate text-xs font-semibold">{props.machine.label}</div>
                <div className="text-[10px] font-normal text-[var(--app-hint)]">{t('work.folderCount', { n: props.machine.folderCount })}</div>
            </div>
        </div>
    )
}

function WorkMatrix(props: {
    model: WorkModel
    expanded: Set<string>
    setExpanded: (next: Set<string>) => void
    selection: Selection
    onSelect: (selection: Selection) => void
}) {
    const { t } = useTranslation()
    const { model } = props
    const machines = model.machines
    const toggle = (id: string) => {
        const next = new Set(props.expanded)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        props.setExpanded(next)
    }
    const foldersOf = (lineIds: string[], machineId: string | null): FolderStat[] =>
        [...model.folders.values()]
            .filter(folder => folder.lineId !== null && lineIds.includes(folder.lineId) && folder.machineId === machineId)
            .sort((a, b) => b.sessionCount - a.sessionCount)
    const selectedKey = props.selection?.kind === 'folder' ? props.selection.projectKey : null
    const selectedLine = props.selection?.kind === 'line' ? props.selection.lineId : null
    const crossMachineProjects = useMemo(() => {
        const result = new Set<string>()
        for (const main of model.mainlines) for (const sub of main.sublines) for (const project of sub.projects) {
            if (project.machines.length > 1) result.add(project.name)
        }
        return result
    }, [model])

    const chip = (folder: FolderStat, compact = false) => {
        const selected = selectedKey === folder.projectKey
        return (
            <button
                key={folder.projectKey}
                type="button"
                title={`${folder.machineLabel} · ${folder.path}`}
                onClick={() => props.onSelect({ kind: 'folder', projectKey: folder.projectKey })}
                className={cn('flex max-w-full items-center gap-1.5 rounded-lg px-2 py-[3px] text-[11px]', selected ? 'text-white' : 'wo-chip')}
                style={selected ? { background: 'var(--wo-push)' } : undefined}
            >
                {folder.activeCount > 0
                    ? <RunDot active className="h-1.5 w-1.5" />
                    : <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: stageDotColor(folder.digest?.stage) }} />}
                <span className={cn('truncate', compact ? 'max-w-[110px]' : 'max-w-[150px]')}>{folder.displayName.split('/').pop()}</span>
                <span className={selected ? 'opacity-80' : 'text-[var(--app-hint)]'}>{folder.sessionCount}</span>
                {crossMachineProjects.has(folder.project) ? <CrossMachineIcon className="h-3 w-3 shrink-0" /> : null}
            </button>
        )
    }

    const cell = (lineIds: string[], machineId: string | null) => {
        const folders = foldersOf(lineIds, machineId)
        if (folders.length === 0) return <span className="block h-1 w-4 rounded-full" style={{ background: 'var(--wo-chip)' }} />
        const shown = folders.length > 3 ? folders.slice(0, 2) : folders
        return (
            <div className="flex flex-col items-start gap-1">
                {shown.map(folder => chip(folder))}
                {folders.length > shown.length ? <span className="px-1 text-[10px] text-[var(--app-hint)]">{t('work.moreFolders', { n: folders.length - shown.length })}</span> : null}
            </div>
        )
    }

    const stickyCol = 'sticky left-0 z-[5] bg-[var(--wo-card)]'

    return (
        <>
            {/* 桌面：矩阵 */}
            <div className="wo-card wo-scroll hidden max-h-[calc(100dvh-150px)] overflow-auto split:block">
                <table className="w-full border-separate border-spacing-0 text-left text-xs">
                    <thead>
                        <tr>
                            <th className={cn(stickyCol, 'top-0 z-10 w-[220px] min-w-[220px] rounded-tl-[14px] border-b border-[var(--app-divider)] px-4 py-3 text-xs font-semibold text-[var(--app-hint)]')}>{t('work.matrix.lines')}</th>
                            {machines.map((machine, index) => (
                                <th key={machine.id ?? '?'} className={cn('sticky top-0 z-[6] min-w-[150px] border-b border-[var(--app-divider)] bg-[var(--wo-card)] px-3 py-2.5', index === machines.length - 1 && 'rounded-tr-[14px]')}>
                                    <MachineHead machine={machine} />
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {model.mainlines.map(main => {
                            const open = props.expanded.has(main.id)
                            const rowSelected = selectedLine === main.id
                            return [
                                <tr key={main.id} className="group align-top">
                                    <td className={cn(stickyCol, 'border-b border-[var(--app-divider)] px-0 py-0', rowSelected && 'bg-[var(--wo-push-bg)]')}>
                                        <div className="wo-accent flex items-start gap-1.5 py-3 pl-4 pr-3" style={statusAccentStyle(main.status)}>
                                            <button type="button" className="mt-[3px] flex h-4 w-4 shrink-0 items-center justify-center rounded text-[10px] text-[var(--app-hint)] hover:bg-[var(--wo-chip)]" onClick={() => toggle(main.id)} aria-label={t('work.expand')}>{open ? '▾' : '▸'}</button>
                                            <button type="button" className="min-w-0 text-left" onClick={() => props.onSelect({ kind: 'line', lineId: main.id })}>
                                                <div className="text-[13px] font-semibold leading-snug hover:underline">{main.name}</div>
                                                <div className="mt-1 flex items-center gap-1.5 whitespace-nowrap text-[11px] text-[var(--app-hint)]"><StatusBadge status={main.status} />{t('work.sessionCount', { n: main.sessionCount })}</div>
                                            </button>
                                        </div>
                                    </td>
                                    {machines.map(machine => (
                                        <td key={machine.id ?? '?'} className={cn('border-b border-[var(--app-divider)] px-3 py-3 transition-colors group-hover:bg-[var(--app-subtle-bg)]', rowSelected && 'bg-[var(--wo-push-bg)]')}>
                                            {cell(main.sublines.map(sub => sub.id), machine.id)}
                                        </td>
                                    ))}
                                </tr>,
                                ...(open ? main.sublines.map(sub => {
                                    const subSelected = selectedLine === sub.id
                                    return (
                                        <tr key={sub.id} className="group align-top">
                                            <td className={cn(stickyCol, 'border-b border-[var(--app-divider)] py-2 pl-10 pr-3', subSelected ? 'bg-[var(--wo-push-bg)]' : 'bg-[var(--wo-card)]')}>
                                                <button type="button" className="text-left" onClick={() => props.onSelect({ kind: 'line', lineId: sub.id })}>
                                                    <div className="text-xs hover:underline">{sub.name}</div>
                                                    <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 whitespace-nowrap text-[11px] text-[var(--app-hint)]">
                                                        <StatusBadge status={sub.status} />
                                                        {t('work.sessionCount', { n: sub.sessionCount })}
                                                        {sub.looseSessionCount > 0 ? <span>· {t('work.looseCount', { n: sub.looseSessionCount })}</span> : null}
                                                    </div>
                                                </button>
                                            </td>
                                            {machines.map(machine => (
                                                <td key={machine.id ?? '?'} className={cn('border-b border-[var(--app-divider)] px-3 py-2 transition-colors group-hover:bg-[var(--app-subtle-bg)]', subSelected ? 'bg-[var(--wo-push-bg)]' : 'bg-[color-mix(in_srgb,var(--wo-chip)_40%,transparent)]')}>
                                                    {cell([sub.id], machine.id)}
                                                </td>
                                            ))}
                                        </tr>
                                    )
                                }) : [])
                            ]
                        })}
                    </tbody>
                </table>
                <div className="sticky left-0 flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-[11px] text-[var(--app-hint)]">
                    <span>{t('work.matrix.hint')}</span>
                    <span className="flex items-center gap-3">
                        <span className="flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full" style={{ background: 'var(--wo-push)' }} />{t('work.legend.developing')}</span>
                        <span className="flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full" style={{ background: 'var(--wo-slow)' }} />{t('work.legend.trial')}</span>
                        <span className="flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full" style={{ background: 'var(--app-badge-success-text)' }} />{t('work.legend.live')}</span>
                        <span className="flex items-center gap-1"><RunDot active className="h-1.5 w-1.5" />{t('work.legend.running')}</span>
                        <span className="flex items-center gap-1"><CrossMachineIcon className="h-3 w-3" />{t('work.legend.cross')}</span>
                    </span>
                </div>
            </div>

            {/* 手机：每条主线一张卡，按机器列目录 */}
            <div className="space-y-2.5 split:hidden">
                {model.mainlines.map(main => (
                    <div key={main.id} className="wo-card wo-accent p-3.5" style={statusAccentStyle(main.status)}>
                        <button type="button" className="flex w-full items-center gap-2 text-left" onClick={() => props.onSelect({ kind: 'line', lineId: main.id })}>
                            <span className="min-w-0 flex-1 truncate text-sm font-semibold">{main.name}</span>
                            <StatusBadge status={main.status} />
                            <span className="text-[11px] text-[var(--app-hint)]">{main.sessionCount}</span>
                        </button>
                        <div className="mt-2.5 space-y-2">
                            {machines.map(machine => {
                                const folders = foldersOf(main.sublines.map(sub => sub.id), machine.id)
                                if (folders.length === 0) return null
                                return (
                                    <div key={machine.id ?? '?'} className="flex items-start gap-2 text-[11px]">
                                        <span className="flex w-24 shrink-0 items-center gap-1.5 pt-0.5 font-medium">
                                            <MachineOsIcon platform={machine.platform} icon={machine.icon} className="h-3 w-3" />
                                            <span className="truncate">{machine.label}</span>
                                        </span>
                                        <div className="flex min-w-0 flex-wrap gap-1">
                                            {folders.slice(0, 2).map(folder => chip(folder, true))}
                                            {folders.length > 2 ? <span className="pt-0.5 text-[var(--app-hint)]">{t('work.moreFolders', { n: folders.length - 2 })}</span> : null}
                                        </div>
                                    </div>
                                )
                            })}
                        </div>
                    </div>
                ))}
            </div>
        </>
    )
}

/* ---------------------------------------------------------------- 方案 C：时间泳道 */

const RANGES = [14, 42, 90] as const

function WorkTimeline(props: { model: WorkModel; sessions: SessionSummary[]; selection: Selection; onSelect: (selection: Selection) => void }) {
    const { t } = useTranslation()
    const relative = useRelativeDay()
    const [days, setDays] = useState<number>(() => (typeof window !== 'undefined' && window.matchMedia?.('(min-width: 920px)').matches ? 42 : 14))
    const timeline = useMemo(() => dailyActivity(props.model, props.sessions, days, Date.now()), [props.model, props.sessions, days])
    const selectedLine = props.selection?.kind === 'line' ? props.selection.lineId : null
    const rows = [...props.model.mainlines].sort((a, b) => b.lastActivity - a.lastActivity)
    const isWeekStart = (day: number) => new Date(day).getDay() === 1

    return (
        <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
                <div className="inline-flex rounded-xl p-[3px]" style={{ background: 'var(--wo-chip)' }}>
                    {RANGES.map(range => (
                        <button key={range} type="button" onClick={() => setDays(range)} className={cn('rounded-[10px] px-3 py-1 text-xs', days === range ? 'bg-[var(--app-bg)] font-semibold shadow-sm' : 'text-[var(--app-hint)]')}>
                            {t(`work.range.${range}`)}
                        </button>
                    ))}
                </div>
                <span className="text-xs text-[var(--app-hint)]">{shortDate(timeline.days[0]!)} — {shortDate(timeline.days[timeline.days.length - 1]!)} · {t('work.timeline.perCell')}</span>
            </div>
            <div className="wo-card p-4 split:p-5">
                <div className="grid items-center gap-x-4 gap-y-1" style={{ gridTemplateColumns: 'minmax(130px, 210px) 1fr' }}>
                    <div />
                    <div className="grid pb-1 text-[10px] text-[var(--app-hint)]" style={{ gridTemplateColumns: `repeat(${days}, minmax(0, 1fr))` }}>
                        {timeline.days.map((day, index) => {
                            const isToday = index === days - 1
                            const label = isToday ? t('work.today') : (days <= 14 ? index % 2 === 1 : isWeekStart(day)) ? shortDate(day) : ''
                            return <span key={day} className={cn('overflow-visible whitespace-nowrap', isToday && 'font-semibold text-[var(--wo-push-fg)]')}>{label}</span>
                        })}
                    </div>
                    {rows.map(main => {
                        const counts = timeline.byMainline.get(main.id) ?? []
                        const total = counts.reduce((sum, n) => sum + n, 0)
                        const selected = selectedLine === main.id
                        return [
                            <button key={`${main.id}-label`} type="button" onClick={() => props.onSelect({ kind: 'line', lineId: main.id })} className={cn('wo-accent min-w-0 rounded-lg py-1.5 pl-3 pr-2 text-left hover:bg-[var(--app-subtle-bg)]', selected && 'bg-[var(--wo-push-bg)]')} style={statusAccentStyle(main.status)}>
                                <div className="flex items-center gap-1.5"><span className="truncate text-xs font-semibold">{main.name}</span><StatusBadge status={main.status} /></div>
                                <div className="mt-0.5 text-[10px] text-[var(--app-hint)]">{t('work.timeline.rowMeta', { last: relative(main.lastActivity), n: total })}</div>
                            </button>,
                            <button key={`${main.id}-cells`} type="button" onClick={() => props.onSelect({ kind: 'line', lineId: main.id })} className={cn('grid rounded-lg p-1 hover:bg-[var(--app-subtle-bg)]', selected && 'bg-[var(--wo-push-bg)]')} style={{ gridTemplateColumns: `repeat(${days}, minmax(0, 1fr))`, gap: days > 60 ? 2 : 3 }}>
                                {counts.map((n, index) => (
                                    <span
                                        key={index}
                                        title={`${shortDate(timeline.days[index]!)}: ${n}`}
                                        className={cn('aspect-square max-h-[18px] w-full rounded-[4px]', index === days - 1 && 'ring-1 ring-[var(--wo-push)] ring-offset-1 ring-offset-[var(--wo-card)]')}
                                        style={{ background: heatColor(n) }}
                                    />
                                ))}
                            </button>
                        ]
                    })}
                </div>
                <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-[var(--app-divider)] pt-3 text-[11px] text-[var(--app-hint)]">
                    <span>{t('work.timeline.legend')}</span>
                    {[0, 1, 2, 3, 4].map(n => <span key={n} className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: heatColor(n) }} />{n === 4 ? '4+' : n}</span>)}
                    <span className="ml-auto">{t('work.timeline.unmapped', { n: timeline.unmapped })}</span>
                </div>
            </div>
        </div>
    )
}

/* ---------------------------------------------------------------- 待整理 */

function WorkTriage(props: { model: WorkModel; onSelect: (selection: Selection) => void }) {
    const { t } = useTranslation()
    const { setFolder, setSession } = useWorkActions()
    const [limit, setLimit] = useState(50)
    const { model } = props
    const busy = setFolder.isPending || setSession.isPending
    const machineOf = new Map(model.machines.map(machine => [machine.id, machine]))
    const machineIcon = (machineId: string | null) => {
        const machine = machineOf.get(machineId)
        return (
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg" style={{ background: 'var(--wo-chip)' }}>
                <MachineOsIcon platform={machine?.platform ?? null} icon={machine?.icon ?? null} className="h-3.5 w-3.5" />
            </span>
        )
    }
    const chooseFolder = (folder: FolderStat, choice: AssignChoice) => {
        if (choice.kind === 'line') setFolder.mutate({ projectKey: folder.projectKey, mode: 'line', lineId: choice.lineId, project: folder.project })
        else if (choice.kind === 'ignored') setFolder.mutate({ projectKey: folder.projectKey, mode: 'ignored' })
    }
    const chooseSession = (sessionId: string, choice: AssignChoice) => {
        if (choice.kind === 'line') setSession.mutate({ sessionId, state: 'line', lineId: choice.lineId })
        else if (choice.kind === 'ignored') setSession.mutate({ sessionId, state: 'ignored' })
    }
    const mixedFolder = (folder: FolderStat) => setFolder.mutate({ projectKey: folder.projectKey, mode: 'mixed' })

    return (
        <div className="mx-auto max-w-4xl space-y-6">
            <section>
                <h2 className="text-[15px] font-semibold tracking-tight">{t('work.triage.folders', { n: model.unassignedFolders.length })}</h2>
                <p className="mb-3 mt-1 text-xs text-[var(--app-hint)]">{t('work.triage.foldersHint')}</p>
                {model.unassignedFolders.length === 0 ? <Empty>{t('work.triage.noneFolders')}</Empty> : (
                    <div className="wo-card divide-y divide-[var(--app-divider)] overflow-hidden">
                        {model.unassignedFolders.map(folder => (
                            <div key={folder.projectKey} className="flex flex-wrap items-center gap-3 px-4 py-3 transition-colors hover:bg-[var(--app-subtle-bg)]">
                                {machineIcon(folder.machineId)}
                                <button type="button" className="min-w-0 flex-1 text-left" onClick={() => props.onSelect({ kind: 'folder', projectKey: folder.projectKey })}>
                                    <div className="flex items-center gap-2">
                                        <span className="truncate text-sm font-medium">{folder.displayName}</span>
                                        <StageBadge stage={folder.digest?.stage} />
                                    </div>
                                    <div className="truncate text-[11px] text-[var(--app-hint)]">{folder.machineLabel} · {folder.path} · {t('work.sessionCount', { n: folder.sessionCount })} · {shortDate(folder.lastActivity)}</div>
                                    {folder.digest?.overview ? <div className="mt-0.5 truncate text-[11px] text-[var(--app-hint)]">{folder.digest.overview}</div> : null}
                                </button>
                                <button type="button" disabled={busy} className="rounded-lg border border-[var(--app-border)] px-2.5 py-1 text-[11px] text-[var(--app-hint)] hover:text-[var(--app-fg)]" onClick={() => mixedFolder(folder)}>{t('work.triage.markMixed')}</button>
                                <AssignSelect mainlines={model.mainlines} value={null} disabled={busy} onChoose={choice => chooseFolder(folder, choice)} className="w-44" />
                            </div>
                        ))}
                    </div>
                )}
            </section>
            <section>
                <h2 className="text-[15px] font-semibold tracking-tight">{t('work.triage.sessions', { n: model.looseSessions.length })}</h2>
                <p className="mb-3 mt-1 text-xs text-[var(--app-hint)]">{t('work.triage.sessionsHint')}</p>
                {model.looseSessions.length === 0 ? <Empty>{t('work.triage.noneSessions')}</Empty> : (
                    <div className="wo-card divide-y divide-[var(--app-divider)] overflow-hidden">
                        {model.looseSessions.slice(0, limit).map(({ session, machineLabel }) => (
                            <div key={session.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5 transition-colors hover:bg-[var(--app-subtle-bg)]">
                                {machineIcon(session.metadata?.machineId ?? null)}
                                <div className="min-w-0 flex-1">
                                    <div className="flex items-center gap-2"><RunDot active={session.active} thinking={session.thinking} /><span className="truncate text-sm">{getSessionTitle(session) || t('work.untitled')}</span></div>
                                    <div className="text-[11px] text-[var(--app-hint)]">{machineLabel} · {shortDate(session.updatedAt)}</div>
                                </div>
                                <AssignSelect mainlines={model.mainlines} value={null} disabled={busy} onChoose={choice => chooseSession(session.id, choice)} className="w-44" />
                            </div>
                        ))}
                        {model.looseSessions.length > limit ? (
                            <button type="button" className="w-full px-3 py-2.5 text-xs font-medium text-[var(--wo-push-fg)] hover:bg-[var(--app-subtle-bg)]" onClick={() => setLimit(limit + 50)}>{t('work.triage.more', { n: model.looseSessions.length - limit })}</button>
                        ) : null}
                    </div>
                )}
            </section>
        </div>
    )
}

function Empty(props: { children: ReactNode }) {
    return <div className="rounded-xl border border-dashed border-[var(--app-border)] px-3 py-6 text-center text-xs text-[var(--app-hint)]">{props.children}</div>
}

/* ---------------------------------------------------------------- 详情面板 */

function RecentSessions(props: { sessions: SessionSummary[]; machineLabel: (session: SessionSummary) => string }) {
    const { t } = useTranslation()
    const navigate = useNavigate()
    if (props.sessions.length === 0) return <div className="text-xs text-[var(--app-hint)]">—</div>
    return (
        <div className="-mx-2 space-y-0.5">
            {props.sessions.map(session => (
                <button key={session.id} type="button" className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-[var(--app-subtle-bg)]" onClick={() => navigate({ to: '/sessions/$sessionId', params: { sessionId: session.id } })}>
                    <RunDot active={session.active} thinking={session.thinking} />
                    <span className="min-w-0 flex-1 truncate text-xs">{getSessionTitle(session) || t('work.untitled')}</span>
                    {session.pendingRequestsCount > 0 ? <NeedBadge>{t('work.needApproval')}</NeedBadge> : null}
                    <span className="shrink-0 text-[10px] text-[var(--app-hint)]">{props.machineLabel(session)} · {shortDate(session.updatedAt)}</span>
                </button>
            ))}
        </div>
    )
}

function SectionTitle(props: { children: ReactNode }) {
    return <div className="mb-1.5 mt-5 text-[11px] font-semibold uppercase tracking-wide text-[var(--app-hint)]">{props.children}</div>
}

function PrimaryButton(props: { children: ReactNode; onClick: () => void }) {
    return <button type="button" className="flex-1 rounded-lg bg-[var(--app-button)] px-3 py-2 text-xs font-medium text-[var(--app-button-text)] hover:opacity-90" onClick={props.onClick}>{props.children}</button>
}

function GhostButton(props: { children: ReactNode; onClick: () => void; danger?: boolean }) {
    return <button type="button" className={cn('rounded-lg border border-[var(--app-border)] px-2.5 py-1.5 text-xs hover:bg-[var(--app-subtle-bg)]', props.danger && 'text-[var(--wo-need)]')} onClick={props.onClick}>{props.children}</button>
}

function FolderDetail(props: { model: WorkModel; sessions: SessionSummary[]; projectKey: string; onSelectLine: (lineId: string) => void }) {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const { setFolder } = useWorkActions()
    const folder = props.model.folders.get(props.projectKey)
    const recent = useMemo(
        () => props.sessions.filter(session => projectKeyOfSession(session) === props.projectKey).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 6),
        [props.sessions, props.projectKey]
    )
    if (!folder) return <div className="text-sm text-[var(--app-hint)]">{t('work.detail.gone')}</div>
    const line = folder.lineId ? findLine(props.model, folder.lineId) : null
    const machine = props.model.machines.find(item => item.id === folder.machineId)
    const choose = (choice: AssignChoice) => {
        if (choice.kind === 'line') setFolder.mutate({ projectKey: folder.projectKey, mode: 'line', lineId: choice.lineId, project: folder.project })
        else if (choice.kind === 'ignored') setFolder.mutate({ projectKey: folder.projectKey, mode: 'ignored' })
        else setFolder.mutate({ projectKey: folder.projectKey, mode: null })
    }
    const renameProject = () => {
        if (!folder.lineId) return
        const name = window.prompt(t('work.prompt.projectName'), folder.project)?.trim()
        if (name) setFolder.mutate({ projectKey: folder.projectKey, mode: 'line', lineId: folder.lineId, project: name })
    }
    return (
        <div>
            <div className="text-[11px] text-[var(--app-hint)]">{line ? `${line.main.name}${line.sub ? ` / ${line.sub.name}` : ''}` : t(folder.mode === 'mixed' ? 'work.mode.mixed' : folder.mode === 'ignored' ? 'work.mode.ignored' : 'work.mode.unassigned')}</div>
            <div className="mt-1 flex items-center gap-2 pr-6">
                <h2 className="min-w-0 truncate text-xl font-semibold tracking-tight">{folder.project}</h2>
                <StageBadge stage={folder.digest?.stage} />
            </div>
            <div className="mt-3 flex items-center gap-2.5 rounded-xl px-3 py-2.5" style={{ background: 'var(--wo-chip)' }}>
                <MachineOsIcon platform={machine?.platform ?? null} icon={machine?.icon ?? null} className="h-4 w-4" />
                <div className="min-w-0">
                    <div className="text-xs font-semibold">{folder.machineLabel}</div>
                    <div className="break-all font-mono text-[11px] text-[var(--app-hint)]">{folder.path}</div>
                </div>
            </div>
            <div className="mt-3 flex items-center gap-4 text-xs text-[var(--app-hint)]">
                <span><b className="text-[var(--app-fg)] tabular-nums">{folder.sessionCount}</b> {t('work.unit.sessions')}</span>
                <span className="flex items-center gap-1.5"><RunDot active={folder.activeCount > 0} /><b className="text-[var(--app-fg)] tabular-nums">{folder.activeCount}</b> {t('work.unit.running')}</span>
            </div>
            {folder.digest?.overview ? <p className="mt-3 text-[13px] leading-relaxed">{folder.digest.overview}</p> : null}
            {folder.digest?.todo?.length ? (
                <>
                    <SectionTitle>{t('work.detail.todo')}</SectionTitle>
                    <ol className="space-y-1 text-xs">
                        {folder.digest.todo.slice(0, 3).map((item, index) => (
                            <li key={item} className="flex gap-2"><span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold" style={{ background: 'var(--wo-push-bg)', color: 'var(--wo-push-fg)' }}>{index + 1}</span><span>{item}</span></li>
                        ))}
                    </ol>
                </>
            ) : null}
            <SectionTitle>{t('work.detail.recent')}</SectionTitle>
            <RecentSessions sessions={recent} machineLabel={() => folder.machineLabel} />
            <SectionTitle>{t('work.detail.assign')}</SectionTitle>
            <div className="flex flex-wrap items-center gap-2">
                <AssignSelect mainlines={props.model.mainlines} value={folder.lineId} allowUnassign={folder.mode !== 'unassigned'} disabled={setFolder.isPending} onChoose={choose} className="min-w-0 flex-1" />
                {folder.lineId ? <GhostButton onClick={renameProject}>{t('work.detail.renameProject')}</GhostButton> : null}
            </div>
            <div className="mt-5 flex gap-2">
                {folder.lineId ? <PrimaryButton onClick={() => { setWorkView({ lineId: folder.lineId, mobileView: 'sessions' }); navigate({ to: '/sessions' }) }}>{t('work.detail.openSessions')}</PrimaryButton> : null}
                {line ? <GhostButton onClick={() => props.onSelectLine(line.sub?.id ?? line.main.id)}>{t('work.detail.viewLine')}</GhostButton> : null}
            </div>
        </div>
    )
}

function LineDetail(props: { model: WorkModel; sessions: SessionSummary[]; lineId: string; onSelectFolder: (projectKey: string) => void; onDeleted: () => void }) {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const relative = useRelativeDay()
    const { upsertLine, deleteLine } = useWorkActions()
    const found = findLine(props.model, props.lineId)
    const recent = useMemo(() => {
        if (!found) return []
        const sublines = new Set(found.sub ? [found.sub.id] : found.main.sublines.map(sub => sub.id))
        return props.sessions.filter(session => {
            const sub = props.model.sublineOfSession.get(session.id)
            return sub !== undefined && sublines.has(sub)
        }).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 6)
    }, [found, props.model, props.sessions])
    if (!found) return <div className="text-sm text-[var(--app-hint)]">{t('work.detail.gone')}</div>
    const line = found.sub ?? found.main
    const isMain = !found.sub
    const machineLabelOf = (session: SessionSummary) => props.model.folders.get(projectKeyOfSession(session))?.machineLabel ?? '?'

    const rename = () => {
        const name = window.prompt(t('work.prompt.rename'), line.name)?.trim()
        if (name) upsertLine.mutate({ id: line.id, parentId: line.parentId, name, goal: line.goal, sort: line.sort })
    }
    const editGoal = () => {
        const goal = window.prompt(t('work.prompt.goal'), line.goal)
        if (goal !== null && goal !== undefined) upsertLine.mutate({ id: line.id, parentId: line.parentId, name: line.name, goal: goal.trim(), sort: line.sort })
    }
    const addSubline = () => {
        const name = window.prompt(t('work.prompt.newSubline'))?.trim()
        if (name) upsertLine.mutate({ id: newLineId(), parentId: found.main.id, name, goal: '', sort: found.main.sublines.length })
    }
    const remove = async () => {
        if (!window.confirm(t('work.prompt.delete', { name: line.name }))) return
        try {
            await deleteLine.mutateAsync(line.id)
            props.onDeleted()
        } catch (error) {
            window.alert(error instanceof Error ? error.message : String(error))
        }
    }

    return (
        <div>
            <div className="text-[11px] text-[var(--app-hint)]">{found.sub ? found.main.name : t('work.detail.mainlineLabel')}</div>
            <div className="mt-1 flex items-center gap-2 pr-6">
                <h2 className="min-w-0 truncate text-xl font-semibold tracking-tight">{line.name}</h2>
                <StatusBadge status={line.status} />
            </div>
            {line.goal ? <p className="mt-1.5 text-[13px] text-[var(--app-hint)]">{line.goal}</p> : null}
            <div className="mt-3 grid grid-cols-3 gap-2">
                {[
                    { value: line.sessionCount, label: t('work.unit.sessions') },
                    { value: line.activeCount, label: t('work.unit.running') },
                    { value: line.machineLabels.length, label: t('work.unit.machines') }
                ].map(item => (
                    <div key={item.label} className="rounded-xl px-3 py-2" style={{ background: 'var(--wo-chip)' }}>
                        <div className="text-lg font-semibold tabular-nums leading-tight">{item.value}</div>
                        <div className="text-[10px] text-[var(--app-hint)]">{item.label}</div>
                    </div>
                ))}
            </div>
            <div className="mt-2 text-[11px] text-[var(--app-hint)]">{t('work.detail.lastActive', { when: relative(line.lastActivity) })} · {line.machineLabels.join(' · ')}</div>
            {isMain && found.main.nextStep ? (
                <div className="mt-3 rounded-xl px-3 py-2.5 text-xs" style={{ background: 'var(--wo-push-bg)' }}>
                    <div className="font-semibold" style={{ color: 'var(--wo-push-fg)' }}>{t('work.detail.nextStep', { project: found.main.nextStep.project })}</div>
                    <div className="mt-0.5">{found.main.nextStep.text}</div>
                </div>
            ) : null}
            {isMain ? (
                <>
                    <SectionTitle>{t('work.detail.sublines', { n: found.main.sublines.length })}</SectionTitle>
                    <div className="divide-y divide-[var(--app-divider)]">
                        {found.main.sublines.map(sub => (
                            <div key={sub.id} className="flex items-center gap-2 py-2 text-xs">
                                <span className="min-w-0 flex-1 truncate font-medium">{sub.name}</span>
                                <StatusBadge status={sub.status} />
                                <span className="w-24 shrink-0 text-right text-[10px] text-[var(--app-hint)]">{shortDate(sub.lastActivity)} · {t('work.sessionCount', { n: sub.sessionCount })}</span>
                            </div>
                        ))}
                    </div>
                </>
            ) : (
                <>
                    <SectionTitle>{t('work.detail.projects', { n: found.sub!.projects.length })}</SectionTitle>
                    <div className="space-y-1.5">
                        {found.sub!.projects.map(project => (
                            <div key={project.name} className="rounded-xl border border-[var(--app-border)] px-3 py-2">
                                <div className="flex items-center gap-2 text-xs font-medium">{project.name}<StageBadge stage={project.stage} /><span className="ml-auto text-[10px] font-normal text-[var(--app-hint)]">{t('work.sessionCount', { n: project.sessionCount })}</span></div>
                                <div className="mt-1.5 flex flex-wrap gap-1">
                                    {project.folders.map(folder => (
                                        <button key={folder.projectKey} type="button" className="wo-chip rounded-md px-1.5 py-0.5 text-[10px]" onClick={() => props.onSelectFolder(folder.projectKey)}>{folder.machineLabel} · {folder.displayName.split('/').pop()}</button>
                                    ))}
                                </div>
                            </div>
                        ))}
                    </div>
                </>
            )}
            <SectionTitle>{t('work.detail.recentLine')}</SectionTitle>
            <RecentSessions sessions={recent} machineLabel={machineLabelOf} />
            <div className="mt-5 flex gap-2">
                <PrimaryButton onClick={() => { setWorkView({ lineId: line.id, mobileView: 'sessions' }); navigate({ to: '/sessions' }) }}>{t('work.detail.openLineSessions')}</PrimaryButton>
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
                <GhostButton onClick={rename}>{t('work.line.rename')}</GhostButton>
                <GhostButton onClick={editGoal}>{t('work.line.goal')}</GhostButton>
                {isMain ? <GhostButton onClick={addSubline}>{t('work.line.addSubline')}</GhostButton> : null}
                <GhostButton danger onClick={() => { void remove() }}>{t('work.line.delete')}</GhostButton>
            </div>
        </div>
    )
}

export type { MainlineView }
