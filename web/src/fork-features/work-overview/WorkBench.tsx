import { useMemo, useState, type ReactNode } from 'react'
import { useNavigate } from '@tanstack/react-router'
import type { SessionSummary } from '@/types/api'
import { useTranslation } from '@/lib/use-translation'
import { getSessionTitle } from '@/lib/sessionTitle'
import { cn } from '@/lib/utils'
import { MachineOsIcon } from '@/components/machinePresentation'
import { useDigestIndex } from '@/fork-features/session-digest/digestApi'
import {
    findLine,
    latestSessionInFolder,
    projectKeyOfSession,
    type FolderStat,
    type MainlineView,
    type SublineView,
    type WorkModel
} from './deriveWork'
import { newLineId, useWorkActions } from './workApi'
import { setWorkFilter } from './workViewStore'
import { ArrowRightIcon, NeedBadge, RunDot, StageBadge, StatusBadge, shortDate, useRelativeDay } from './WorkParts'

/**
 * /work「主线」视图（版式参照 GPT 方案 2「主线工作台」）：左边主线/支线树，中间这条线的焦点、项目与目录、产物，
 * 右边相关会话与「在此项目继续」。所有条目都跳到实际对象：会话、目录详情、过滤后的会话列表、预填好的新建会话。
 */
export function WorkBench(props: {
    model: WorkModel
    sessions: SessionSummary[]
    lineId: string | null
    onSelectLine: (lineId: string) => void
    onOpenFolder: (projectKey: string) => void
    onTriage: () => void
}) {
    const { t } = useTranslation()
    const { model } = props
    const found = (props.lineId ? findLine(model, props.lineId) : null) ?? (model.mainlines[0] ? { main: model.mainlines[0], sub: null } : null)
    const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
    const { upsertLine } = useWorkActions()
    if (!found) return <div className="p-6 text-sm text-[var(--wo-muted)]">{t('work.empty.title')}</div>

    const addMainline = async () => {
        const name = window.prompt(t('work.prompt.newMainline'))?.trim()
        if (!name) return
        const id = newLineId()
        await upsertLine.mutateAsync({ id, parentId: null, name, goal: '', sort: model.mainlines.length })
        props.onSelectLine(id)
    }

    return (
        <div className="grid gap-4 split:grid-cols-[250px_minmax(0,1fr)_300px]">
            <aside className="wo-card h-max p-3 split:sticky split:top-0">
                <div className="mb-2 flex items-center justify-between px-2">
                    <span className="text-[15px] font-bold text-[var(--wo-ink)]">{t('work.bench.tree')}</span>
                    <button type="button" className="wo-clickable flex h-6 w-6 items-center justify-center text-lg leading-none text-[var(--wo-push)]" onClick={() => { void addMainline() }} aria-label={t('work.line.newMainline')}>＋</button>
                </div>
                <nav className="space-y-0.5" data-testid="work-bench-tree">
                    {model.mainlines.map(main => {
                        const open = !collapsed.has(main.id)
                        const mainSelected = found.main.id === main.id && !found.sub
                        return (
                            <div key={main.id}>
                                <div className={cn('wo-clickable flex items-center gap-1.5 px-2 py-1.5', mainSelected && 'bg-[var(--wo-soft)]')}>
                                    <button
                                        type="button"
                                        className="w-4 shrink-0 text-[10px] text-[var(--wo-muted)]"
                                        onClick={() => {
                                            const next = new Set(collapsed)
                                            if (next.has(main.id)) next.delete(main.id)
                                            else next.add(main.id)
                                            setCollapsed(next)
                                        }}
                                        aria-label={t('work.expand')}
                                    >
                                        {open ? '▾' : '▸'}
                                    </button>
                                    <button type="button" className={cn('min-w-0 flex-1 truncate text-left text-[13px] font-semibold', mainSelected ? 'text-[var(--wo-push-fg)]' : 'text-[var(--wo-ink)]')} onClick={() => props.onSelectLine(main.id)}>
                                        {main.name}
                                    </button>
                                    <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: main.status === 'push' ? 'var(--wo-push)' : main.status === 'slow' ? 'var(--wo-slow)' : 'var(--wo-stall)' }} />
                                </div>
                                {open ? (
                                    <div className="ml-[18px] border-l border-[var(--wo-border)] pl-2">
                                        {main.sublines.map(sub => {
                                            const selected = found.sub?.id === sub.id
                                            return (
                                                <button
                                                    key={sub.id}
                                                    type="button"
                                                    onClick={() => props.onSelectLine(sub.id)}
                                                    className={cn('wo-clickable flex w-full items-center gap-1.5 px-2 py-1 text-left text-xs', selected ? 'bg-[var(--wo-soft)] font-semibold text-[var(--wo-push-fg)]' : 'text-[var(--wo-ink)]')}
                                                >
                                                    <span className="min-w-0 flex-1 truncate">{sub.name}</span>
                                                    {sub.activeCount > 0 ? <RunDot active className="h-1.5 w-1.5" /> : null}
                                                    <span className="shrink-0 text-[10px] text-[var(--wo-muted)]">{sub.sessionCount}</span>
                                                </button>
                                            )
                                        })}
                                    </div>
                                ) : null}
                            </div>
                        )
                    })}
                </nav>
                <button type="button" onClick={props.onTriage} className="wo-clickable mt-3 flex w-full items-center justify-between border-t border-[var(--wo-border)] px-2 pb-1 pt-3 text-xs text-[var(--wo-muted)]">
                    <span>{t('work.tab.triage')}</span>
                    <span className="rounded-full px-1.5 text-[10px] font-semibold" style={{ background: 'var(--wo-slow-bg)', color: 'var(--wo-slow-fg)' }}>{model.totals.unassignedSessions}</span>
                </button>
            </aside>

            <LineDetailCenter model={model} sessions={props.sessions} main={found.main} sub={found.sub} onSelectLine={props.onSelectLine} onOpenFolder={props.onOpenFolder} />
            <RelatedSessions model={model} sessions={props.sessions} main={found.main} sub={found.sub} />
        </div>
    )
}

function Section(props: { title: ReactNode; children: ReactNode; extra?: ReactNode }) {
    return (
        <section className="mt-6">
            <div className="mb-2.5 flex items-center justify-between">
                <h3 className="text-[15px] font-bold text-[var(--wo-ink)]">{props.title}</h3>
                {props.extra}
            </div>
            {props.children}
        </section>
    )
}

function LineDetailCenter(props: {
    model: WorkModel
    sessions: SessionSummary[]
    main: MainlineView
    sub: SublineView | null
    onSelectLine: (lineId: string) => void
    onOpenFolder: (projectKey: string) => void
}) {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const relative = useRelativeDay()
    const { upsertLine, deleteLine } = useWorkActions()
    const { model, main, sub } = props
    const line = sub ?? main
    const projects = (sub ? sub.projects : main.sublines.flatMap(item => item.projects)).slice().sort((a, b) => b.lastActivity - a.lastActivity)
    const folders = projects.flatMap(project => project.folders)
    const focus = useMemo(() => {
        const withTodo = folders.filter(folder => folder.digest?.todo?.[0]).sort((a, b) => b.lastActivity - a.lastActivity)[0]
        if (!withTodo) return null
        return { text: withTodo.digest!.todo[0]!, folder: withTodo, session: latestSessionInFolder(props.sessions, withTodo.projectKey) }
    }, [folders, props.sessions])
    const artifacts = useMemo(() => {
        const out: Array<{ text: string; folder: FolderStat }> = []
        for (const folder of folders) for (const item of folder.digest?.artifacts ?? []) if (out.length < 6) out.push({ text: item, folder })
        return out
    }, [folders])
    const machineOf = new Map(model.machines.map(machine => [machine.id, machine]))

    const openLineSessions = () => { setWorkFilter({ lineId: line.id }, { showSessions: true }); navigate({ to: '/sessions' }) }
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
        if (name) upsertLine.mutate({ id: newLineId(), parentId: main.id, name, goal: '', sort: main.sublines.length })
    }
    const remove = async () => {
        if (!window.confirm(t('work.prompt.delete', { name: line.name }))) return
        try {
            await deleteLine.mutateAsync(line.id)
            props.onSelectLine(sub ? main.id : model.mainlines.find(item => item.id !== main.id)?.id ?? '')
        } catch (error) {
            window.alert(error instanceof Error ? error.message : String(error))
        }
    }

    return (
        <div className="wo-card min-w-0 p-6" data-testid="work-bench-detail">
            <div className="text-xs text-[var(--wo-muted)]">
                {sub ? (
                    <button type="button" className="hover:underline" onClick={() => props.onSelectLine(main.id)}>{main.name}</button>
                ) : t('work.detail.mainlineLabel')}
                {sub ? <span> / {t('work.bench.subline')}</span> : null}
            </div>
            <div className="mt-1.5 flex items-center gap-3">
                <h2 className="min-w-0 truncate text-[26px] font-bold tracking-tight text-[var(--wo-ink)]">{line.name}</h2>
                <StatusBadge status={line.status} />
                {line.pendingCount > 0 ? <NeedBadge>{t('work.pending', { n: line.pendingCount })}</NeedBadge> : null}
            </div>
            <p className="mt-1.5 text-sm text-[var(--wo-muted)]">
                {line.goal ? t('work.bench.goal', { text: line.goal }) : <button type="button" className="hover:underline" onClick={editGoal}>{t('work.bench.addGoal')}</button>}
            </p>
            <div className="mt-2 text-xs text-[var(--wo-muted)]">{t('work.bench.stats', { sessions: line.sessionCount, running: line.activeCount, machines: line.machineLabels.length, when: relative(line.lastActivity) })}</div>

            <Section title={t('work.bench.focus')}>
                {focus ? (
                    <button
                        type="button"
                        onClick={() => { if (focus.session) navigate({ to: '/sessions/$sessionId', params: { sessionId: focus.session.id } }) }}
                        className="block w-full rounded-xl px-4 py-3.5 text-left transition hover:brightness-[0.98]"
                        style={{ background: 'var(--wo-soft)' }}
                    >
                        <div className="text-[15px] font-bold text-[var(--wo-push-fg)]">{focus.text}</div>
                        <div className="mt-1 text-xs text-[var(--wo-muted)]">
                            {focus.folder.project} · {focus.folder.machineLabel}
                            {focus.session ? <span className="ml-2 font-semibold text-[var(--wo-push-fg)]">{t('work.bench.openFocus')} →</span> : null}
                        </div>
                    </button>
                ) : <div className="text-xs text-[var(--wo-muted)]">{t('work.bench.noFocus')}</div>}
            </Section>

            <Section title={t('work.bench.projects', { n: projects.length })}>
                <div className="space-y-2.5">
                    {projects.slice(0, 8).map(project => (
                        <div key={project.name} className="rounded-xl border border-[var(--wo-border)] p-3.5">
                            <div className="flex items-center gap-2">
                                <span className="min-w-0 truncate text-[15px] font-semibold text-[var(--wo-ink)]">{project.name}</span>
                                <StageBadge stage={project.stage} />
                                <span className="flex-1" />
                                <span className="text-[11px] text-[var(--wo-muted)]">{t('work.sessionCount', { n: project.sessionCount })} · {shortDate(project.lastActivity)}</span>
                            </div>
                            {project.folders[0]?.digest?.overview ? <div className="mt-1 line-clamp-2 text-xs text-[var(--wo-muted)]">{project.folders[0].digest.overview}</div> : null}
                            <div className="mt-2 space-y-1">
                                {project.folders.map(folder => {
                                    const machine = machineOf.get(folder.machineId)
                                    return (
                                        <div key={folder.projectKey} className="flex items-center gap-2 text-xs">
                                            <button type="button" onClick={() => props.onOpenFolder(folder.projectKey)} className="wo-clickable flex min-w-0 flex-1 items-center gap-2 px-1.5 py-1 text-left">
                                                <MachineOsIcon platform={machine?.platform ?? null} icon={machine?.icon ?? null} className="h-3.5 w-3.5" />
                                                <span className="shrink-0 font-semibold text-[var(--wo-ink)]">{folder.machineLabel}</span>
                                                <span className="min-w-0 truncate font-mono text-[11px] text-[var(--wo-muted)]">{folder.path}</span>
                                            </button>
                                            {folder.activeCount > 0 ? <RunDot active /> : null}
                                            <button type="button" className="wo-link shrink-0 text-[11px]" onClick={() => { setWorkFilter({ projectKey: folder.projectKey }, { showSessions: true }); navigate({ to: '/sessions' }) }}>
                                                {t('work.bench.folderSessions', { n: folder.sessionCount })}
                                            </button>
                                        </div>
                                    )
                                })}
                            </div>
                        </div>
                    ))}
                    {projects.length > 8 ? <div className="text-xs text-[var(--wo-muted)]">{t('work.bench.moreProjects', { n: projects.length - 8 })}</div> : null}
                    {projects.length === 0 ? <div className="text-xs text-[var(--wo-muted)]">{t('work.bench.noProjects')}</div> : null}
                </div>
            </Section>

            {artifacts.length > 0 ? (
                <Section title={t('work.bench.artifacts')}>
                    <ul className="space-y-1.5">
                        {artifacts.map((item, index) => (
                            <li key={index} className="flex items-start gap-2 text-[13px]">
                                <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: 'var(--wo-push)' }} />
                                <span className="min-w-0 flex-1 text-[var(--wo-ink)]">{item.text}</span>
                                <button type="button" className="shrink-0 text-[11px] text-[var(--wo-muted)] hover:underline" onClick={() => props.onOpenFolder(item.folder.projectKey)}>{item.folder.project}</button>
                            </li>
                        ))}
                    </ul>
                </Section>
            ) : null}

            {!sub ? (
                <Section title={t('work.detail.sublines', { n: main.sublines.length })}>
                    <div className="divide-y divide-[var(--wo-border)]">
                        {main.sublines.map(item => (
                            <button key={item.id} type="button" onClick={() => props.onSelectLine(item.id)} className="wo-clickable flex w-full items-center gap-2 px-1.5 py-2 text-left text-[13px]">
                                <span className="min-w-0 flex-1 truncate font-medium text-[var(--wo-ink)]">{item.name}</span>
                                <StatusBadge status={item.status} />
                                <span className="w-28 shrink-0 text-right text-[11px] text-[var(--wo-muted)]">{t('work.sessionCount', { n: item.sessionCount })} · {shortDate(item.lastActivity)}</span>
                            </button>
                        ))}
                    </div>
                </Section>
            ) : null}

            <div className="mt-7 flex flex-wrap items-center gap-2 border-t border-[var(--wo-border)] pt-4">
                <button type="button" className="wo-btn-primary px-4 py-2 text-[13px]" onClick={openLineSessions}>{t('work.detail.openLineSessions')}</button>
                <button type="button" className="wo-clickable border border-[var(--wo-border)] px-3 py-2 text-xs" onClick={rename}>{t('work.line.rename')}</button>
                <button type="button" className="wo-clickable border border-[var(--wo-border)] px-3 py-2 text-xs" onClick={editGoal}>{t('work.line.goal')}</button>
                {!sub ? <button type="button" className="wo-clickable border border-[var(--wo-border)] px-3 py-2 text-xs" onClick={addSubline}>{t('work.line.addSubline')}</button> : null}
                <button type="button" className="wo-clickable border border-[var(--wo-border)] px-3 py-2 text-xs text-[var(--wo-need)]" onClick={() => { void remove() }}>{t('work.line.delete')}</button>
            </div>
        </div>
    )
}

function RelatedSessions(props: { model: WorkModel; sessions: SessionSummary[]; main: MainlineView; sub: SublineView | null }) {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const relative = useRelativeDay()
    const digestIndex = useDigestIndex()
    const { model } = props
    const lineIds = new Set(props.sub ? [props.sub.id] : props.main.sublines.map(item => item.id))
    const related = props.sessions
        .filter(session => {
            const sub = model.sublineOfSession.get(session.id)
            return sub !== undefined && lineIds.has(sub)
        })
        .sort((a, b) => (Number(b.active) - Number(a.active)) || b.updatedAt - a.updatedAt)
    const folders = (props.sub ? props.sub.projects : props.main.sublines.flatMap(item => item.projects)).flatMap(project => project.folders)
    const home = folders.slice().sort((a, b) => b.lastActivity - a.lastActivity)[0] ?? null
    const machineLabelOf = (session: SessionSummary) => model.folders.get(projectKeyOfSession(session))?.machineLabel ?? session.metadata?.host ?? '?'

    return (
        <aside className="wo-card h-max p-4 split:sticky split:top-0" data-testid="work-bench-sessions">
            <div className="mb-3 flex items-center justify-between">
                <span className="text-[15px] font-bold text-[var(--wo-ink)]">{t('work.bench.related')}</span>
                <span className="rounded-full px-2 text-[11px] font-semibold" style={{ background: 'var(--wo-push-bg)', color: 'var(--wo-push-fg)' }}>{related.length}</span>
            </div>
            <div className="space-y-2">
                {related.slice(0, 8).map(session => (
                    <button
                        key={session.id}
                        type="button"
                        onClick={() => navigate({ to: '/sessions/$sessionId', params: { sessionId: session.id } })}
                        className="block w-full rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-[var(--wo-chip)]"
                        style={{ background: 'var(--wo-next-bg)' }}
                    >
                        <div className="flex items-center gap-2">
                            <RunDot active={session.active} thinking={session.thinking} />
                            <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-[var(--wo-ink)]">{getSessionTitle(session) || t('work.untitled')}</span>
                            {session.pendingRequestsCount > 0 ? <NeedBadge>{session.pendingRequestsCount}</NeedBadge> : null}
                        </div>
                        {digestIndex[session.id]?.status ? <div className="mt-1 line-clamp-2 text-[11px] text-[var(--wo-muted)]">{digestIndex[session.id]!.status}</div> : null}
                        <div className="mt-1 text-[10px] text-[var(--wo-muted)]">{machineLabelOf(session)} · {relative(session.updatedAt)}</div>
                    </button>
                ))}
                {related.length === 0 ? <div className="text-xs text-[var(--wo-muted)]">{t('work.bench.noSessions')}</div> : null}
                {related.length > 8 ? (
                    <button type="button" className="wo-link w-full pt-1 text-center text-xs" onClick={() => { setWorkFilter({ lineId: (props.sub ?? props.main).id }, { showSessions: true }); navigate({ to: '/sessions' }) }}>
                        {t('work.bench.allSessions', { n: related.length })} →
                    </button>
                ) : null}
            </div>
            {home ? (
                <div className="mt-4 border-t border-[var(--wo-border)] pt-4">
                    <div className="text-[13px] font-bold text-[var(--wo-ink)]">{t('work.bench.continueHere')}</div>
                    <div className="mt-1 truncate text-[11px] text-[var(--wo-muted)]" title={home.path}>{home.machineLabel} · {home.displayName}</div>
                    <button
                        type="button"
                        data-testid="work-bench-new-session"
                        className="wo-btn-primary mt-3 flex w-full items-center justify-center gap-1.5 py-2.5 text-[13px]"
                        onClick={() => navigate({ to: '/sessions/new', search: home.machineId ? { directory: home.path, machineId: home.machineId } : { directory: home.path } })}
                    >
                        ＋ {t('work.bench.newSession')}
                    </button>
                </div>
            ) : null}
        </aside>
    )
}

export { ArrowRightIcon }
