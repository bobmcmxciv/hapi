import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import type { SessionSummary } from '@/types/api'
import { useTranslation } from '@/lib/use-translation'
import { getSessionTitle } from '@/lib/sessionTitle'
import { useDigestIndex } from '@/fork-features/session-digest/digestApi'
import type { WorkModel } from './deriveWork'
import { lineDetailOf, type LineDetailSession } from './lineDetail'
import { RunDot, StageBadge, useRelativeDay } from './WorkParts'

const OPEN_KEY = 'hapi-work-line-detail-open'

/** 详情默认展开；用户收起后记住（同一浏览器）。 */
export function useLineDetailOpen(): [boolean, () => void] {
    const [open, setOpen] = useState(() => {
        try {
            return localStorage.getItem(OPEN_KEY) !== '0'
        } catch {
            return true
        }
    })
    const toggle = () => setOpen(value => {
        try {
            localStorage.setItem(OPEN_KEY, value ? '0' : '1')
        } catch {
            // 隐私模式等写不进去就只在本页生效
        }
        return !value
    })
    return [open, toggle]
}

/** 会话列表按主线/支线过滤时，过滤条下面那块「这条线现在在做什么」。 */
export function LineDetailPanel(props: { model: WorkModel; sessions: SessionSummary[]; lineId: string }) {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const digestIndex = useDigestIndex()
    const relativeDay = useRelativeDay()
    const detail = lineDetailOf(props.model, props.sessions, props.lineId, digestIndex)
    if (!detail) return null
    const open = (sessionId: string) => navigate({ to: '/sessions/$sessionId', params: { sessionId } })
    const empty = !detail.goal && detail.running.length === 0 && detail.recent.length === 0 && detail.nextSteps.length === 0 && detail.projects.length === 0

    const sessionRow = (item: LineDetailSession) => (
        <button
            key={item.session.id}
            type="button"
            onClick={() => open(item.session.id)}
            className="wo-clickable flex w-full items-start gap-2 px-1.5 py-1 text-left"
        >
            <RunDot active={item.session.active} thinking={item.session.thinking} className="mt-1" />
            <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                    <span className="min-w-0 flex-1 truncate font-medium text-[var(--wo-ink)]">{getSessionTitle(item.session) || t('work.untitled')}</span>
                    {item.completed ? <span className="shrink-0 text-[10px] text-[var(--wo-muted)]">{t('work.lineDetail.completed')}</span> : null}
                    {item.session.active ? null : <span className="shrink-0 text-[10px] text-[var(--wo-muted)]">{relativeDay(item.session.updatedAt)}</span>}
                </span>
                {item.status ? <span className="line-clamp-2 text-[11px] leading-snug text-[var(--wo-muted)]">{item.status}</span> : null}
            </span>
        </button>
    )

    return (
        <div data-testid="work-line-detail" className="wo-scroll mt-2 max-h-[45vh] space-y-2.5 overflow-y-auto border-t border-[var(--wo-border)] pt-2">
            {empty ? <div className="text-[var(--wo-muted)]">{t('work.lineDetail.empty')}</div> : null}
            {detail.goal ? (
                <div className="text-[var(--wo-ink)]"><span className="font-semibold">{t('work.lineDetail.goal')}</span>{detail.goal}</div>
            ) : null}
            {detail.running.length > 0 ? (
                <section>
                    <div className="mb-0.5 font-semibold text-[var(--wo-ink)]">{t('work.lineDetail.running', { n: detail.running.length })}</div>
                    {detail.running.map(sessionRow)}
                </section>
            ) : null}
            {detail.nextSteps.length > 0 ? (
                <section>
                    <div className="mb-0.5 font-semibold text-[var(--wo-ink)]">{t('work.lineDetail.next')}</div>
                    <ul className="space-y-0.5 px-1.5">
                        {detail.nextSteps.map(step => (
                            <li key={step.text} className="flex items-start gap-1.5 text-[var(--wo-ink)]">
                                <span className="mt-[6px] h-1 w-1 shrink-0 rounded-full bg-[var(--wo-push)]" />
                                <span className="min-w-0 flex-1">{step.text}<span className="ml-1 text-[10px] text-[var(--wo-muted)]">· {step.project}</span></span>
                            </li>
                        ))}
                    </ul>
                </section>
            ) : null}
            {detail.recent.length > 0 ? (
                <section>
                    <div className="mb-0.5 font-semibold text-[var(--wo-ink)]">{t('work.lineDetail.recent')}</div>
                    {detail.recent.map(sessionRow)}
                </section>
            ) : null}
            {detail.projects.length > 0 ? (
                <section>
                    <div className="mb-0.5 font-semibold text-[var(--wo-ink)]">{t('work.lineDetail.projects')}</div>
                    <ul className="space-y-1 px-1.5">
                        {detail.projects.map(project => (
                            <li key={`${project.subline ?? ''}/${project.name}`} className="min-w-0">
                                <div className="flex items-center gap-1.5">
                                    <span className="min-w-0 truncate font-medium text-[var(--wo-ink)]">{project.name}</span>
                                    <StageBadge stage={project.stage} />
                                    {project.activeCount > 0 ? <RunDot active /> : null}
                                    {project.subline ? <span className="min-w-0 truncate text-[10px] text-[var(--wo-muted)]">· {project.subline}</span> : null}
                                </div>
                                {project.overview ? <div className="line-clamp-2 text-[11px] leading-snug text-[var(--wo-muted)]">{project.overview}</div> : null}
                            </li>
                        ))}
                    </ul>
                </section>
            ) : null}
        </div>
    )
}
