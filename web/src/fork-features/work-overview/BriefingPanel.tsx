import { useEffect, useState } from 'react'
import type { SessionSummary } from '@/types/api'
import { useTranslation } from '@/lib/use-translation'
import { getSessionTitle } from '@/lib/sessionTitle'
import { cn } from '@/lib/utils'
import type { DigestIndexEntry } from '@/fork-features/session-digest/digestApi'
import type { WorkModelResult } from './useWorkModel'
import { useBriefing, useRefreshBriefing, type BriefingContext, type BriefingItem } from './workApi'

const RECENT_DAYS = 14

/** 从工作模型组装「梳理待办」的上下文：主线/支线与各项目下一步、等你处理的、正在跑的、最近两周的、已忽略的。 */
export function buildBriefingContext(result: WorkModelResult, digestIndex: Record<string, DigestIndexEntry>, now = Date.now()): BriefingContext {
    const { model, sessions, dismissed, digests } = result
    const title = (session: SessionSummary) => getSessionTitle(session) || session.id.slice(0, 8)
    const machine = (session: SessionSummary) => model.machines.find(item => item.id === (session.metadata?.machineId ?? null))?.label ?? session.metadata?.host ?? ''
    const lineOf = (session: SessionSummary) => model.sublineOfSession.get(session.id) ?? null
    const lines: BriefingContext['lines'] = []
    for (const main of model.mainlines) {
        lines.push({ id: main.id, name: main.name, parentId: null, goal: main.goal, status: main.status, lastActivity: main.lastActivity, nextSteps: main.nextStep ? [main.nextStep.text] : [] })
        for (const sub of main.sublines) {
            const nextSteps: string[] = []
            for (const project of sub.projects) {
                for (const folder of project.folders) {
                    const todo = digests[folder.projectKey]?.todo ?? []
                    for (const item of todo.slice(0, 2)) if (nextSteps.length < 5) nextSteps.push(`${project.name}：${item}`)
                }
            }
            lines.push({ id: sub.id, name: sub.name, parentId: main.id, goal: sub.goal, status: sub.status, lastActivity: sub.lastActivity, nextSteps })
        }
    }
    const visible = sessions.filter(session => !dismissed.has(session.id))
    const pending = visible.filter(session => session.pendingRequestsCount > 0).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 60)
    const active = visible.filter(session => session.active && session.pendingRequestsCount === 0).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 60)
    const recent = visible
        .filter(session => !session.active && session.pendingRequestsCount === 0 && now - session.updatedAt < RECENT_DAYS * 86_400_000)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 80)
    return {
        lines,
        pending: pending.map(session => ({
            sessionId: session.id, title: title(session), lineId: lineOf(session), machine: machine(session), updatedAt: session.updatedAt,
            detail: session.pendingRequests.map(request => request.tool).filter(Boolean).slice(0, 3).join('、')
        })),
        active: active.map(session => ({ sessionId: session.id, title: title(session), lineId: lineOf(session), machine: machine(session), thinking: session.thinking, status: digestIndex[session.id]?.status ?? '' })),
        recent: recent.map(session => ({ sessionId: session.id, title: title(session), lineId: lineOf(session), updatedAt: session.updatedAt, status: digestIndex[session.id]?.status ?? '', completed: Boolean(digestIndex[session.id]?.completed) })),
        dismissed: sessions.filter(session => dismissed.has(session.id)).slice(0, 200).map(session => ({ sessionId: session.id, title: title(session) }))
    }
}

/** 总览顶部的「梳理待办」：调用 Luna 把当前所有要做的事整理一遍，结果里的会话/主线都可点。 */
export function BriefingPanel(props: {
    result: WorkModelResult
    digestIndex: Record<string, DigestIndexEntry>
    mobile: boolean
    onSession: (sessionId: string) => void
    onLine: (lineId: string) => void
}) {
    const { t } = useTranslation()
    /** 点击时刻；非空表示在等这一次梳理的结果（期间 3 秒轮询）。 */
    const [startedAt, setStartedAt] = useState<number | null>(null)
    const query = useBriefing(true, startedAt !== null)
    const refresh = useRefreshBriefing()
    const briefing = query.data?.briefing ?? null
    const running = refresh.isPending || Boolean(query.data?.running) || startedAt !== null
    useEffect(() => {
        // 点击之后拿到的一次新结果里服务端已不在跑：结束等待（成功结果或错误都已在 briefing 里）。
        if (startedAt !== null && !refresh.isPending && query.data && !query.data.running && query.dataUpdatedAt > startedAt) setStartedAt(null)
    }, [startedAt, refresh.isPending, query.data, query.dataUpdatedAt])
    const start = () => {
        setStartedAt(Date.now())
        refresh.mutate(buildBriefingContext(props.result, props.digestIndex), { onError: () => setStartedAt(null) })
    }
    const lineName = (lineId: string) => {
        for (const main of props.result.model.mainlines) {
            if (main.id === lineId) return main.name
            const sub = main.sublines.find(item => item.id === lineId)
            if (sub) return sub.name
        }
        return null
    }

    return (
        <div data-testid="work-briefing" className={cn('wo-card mt-5', props.mobile ? 'px-4 py-3.5' : 'px-5 py-4')}>
            <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                    <div className="text-[15px] font-bold text-[var(--wo-ink)]">{t('work.briefing.title')}</div>
                    <div className="mt-0.5 truncate text-xs text-[var(--wo-muted)]">
                        {running
                            ? t('work.briefing.running')
                            : briefing
                                ? t('work.briefing.generated', { model: briefing.model ?? '', time: new Date(briefing.generatedAt).toLocaleString() })
                                : t('work.briefing.hint')}
                    </div>
                </div>
                <button
                    type="button"
                    data-testid="work-briefing-refresh"
                    disabled={running}
                    onClick={start}
                    className="wo-btn-primary flex shrink-0 items-center gap-1.5 px-3.5 py-1.5 text-xs disabled:opacity-60"
                >
                    <SyncIcon className={cn('h-3.5 w-3.5', running && 'animate-spin')} />
                    {running ? t('work.briefing.runningShort') : t('work.briefing.refresh')}
                </button>
            </div>
            {briefing?.error ? <p role="alert" className="mt-2 text-xs text-red-600 dark:text-red-400">{t('work.briefing.failed', { error: briefing.error })}</p> : null}
            {briefing && (briefing.summary || briefing.groups.length > 0) ? (
                <div className={cn('mt-3', running && 'opacity-60')}>
                    {briefing.summary ? <p className="text-[13px] leading-relaxed text-[var(--wo-ink)]">{briefing.summary}</p> : null}
                    <div className={cn('mt-2 grid gap-3', props.mobile ? 'grid-cols-1' : 'grid-cols-2')}>
                        {briefing.groups.map(group => (
                            <div key={group.title}>
                                <div className="mb-1 text-xs font-semibold text-[var(--wo-muted)]">{group.title}</div>
                                <ul className="space-y-0.5">
                                    {group.items.map((item, index) => (
                                        <li key={index}>
                                            <BriefingRow item={item} lineName={item.lineId ? lineName(item.lineId) : null} onSession={props.onSession} onLine={props.onLine} />
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        ))}
                    </div>
                </div>
            ) : null}
        </div>
    )
}

function BriefingRow(props: { item: BriefingItem; lineName: string | null; onSession: (id: string) => void; onLine: (id: string) => void }) {
    const { item } = props
    const clickable = Boolean(item.sessionId || item.lineId)
    const body = (
        <>
            <span className={cn('mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full', item.priority === 'high' ? 'bg-[var(--wo-need)]' : 'bg-[var(--wo-push)]')} />
            <span className="min-w-0 flex-1 text-[13px] leading-relaxed text-[var(--wo-ink)]">
                {item.text}
                {props.lineName ? <span className="ml-1.5 text-[11px] text-[var(--wo-muted)]">· {props.lineName}</span> : null}
            </span>
        </>
    )
    if (!clickable) return <div className="flex items-start gap-2 px-1.5 py-1">{body}</div>
    return (
        <button
            type="button"
            className="wo-clickable flex w-full items-start gap-2 px-1.5 py-1 text-left"
            onClick={() => (item.sessionId ? props.onSession(item.sessionId) : props.onLine(item.lineId!))}
        >
            {body}
        </button>
    )
}

function SyncIcon(props: { className?: string }) {
    return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={props.className}>
            <path d="M21 12a9 9 0 0 1-15.5 6.2L3 16" />
            <path d="M3 12a9 9 0 0 1 15.5-6.2L21 8" />
            <path d="M21 3v5h-5M3 21v-5h5" />
        </svg>
    )
}
