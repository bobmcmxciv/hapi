import { useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/lib/use-translation'
import { useDigestActions, useProjectDigests, useSessionDigest, type DigestJobState } from './digestApi'
import { refreshPhase, type RefreshBaseline } from './refreshProgress'

function formatTime(ms: number | null): string {
    return ms ? new Date(ms).toLocaleString() : ''
}

function Section(props: { title: string; items?: string[]; text?: string; empty: string }) {
    const hasItems = props.items && props.items.length > 0
    return (
        <section className="flex flex-col gap-1">
            <h3 className="text-xs font-medium text-[var(--app-hint)]">{props.title}</h3>
            {props.text !== undefined ? (
                <p className="text-sm leading-relaxed text-[var(--app-fg)]">{props.text || props.empty}</p>
            ) : hasItems ? (
                <ul className="list-disc space-y-0.5 pl-5 text-sm leading-relaxed text-[var(--app-fg)]">
                    {props.items!.map((item, index) => <li key={index}>{item}</li>)}
                </ul>
            ) : (
                <p className="text-sm text-[var(--app-hint)]">{props.empty}</p>
            )}
        </section>
    )
}

/**
 * 「重新总结」的进度：从点下按钮到服务端记下新的一次处理为止都算进行中（含排队），
 * 结束后短暂显示「已更新」，等太久显示超时说明。等待期间每 3 秒重算一次，超时判断不依赖数据变化。
 */
function useRefreshProgress(baseline: RefreshBaseline | null, setBaseline: (next: RefreshBaseline | null) => void, attempt: number | null, serverState: DigestJobState) {
    const [now, setNow] = useState(() => Date.now())
    const [outcome, setOutcome] = useState<'updated' | 'timeout' | null>(null)
    const phase = refreshPhase(baseline, attempt, serverState, now)
    useEffect(() => {
        if (!baseline) return
        const timer = setInterval(() => setNow(Date.now()), 3000)
        return () => clearInterval(timer)
    }, [baseline])
    useEffect(() => {
        if (phase === 'done' || phase === 'timeout') {
            setBaseline(null)
            setOutcome(phase === 'done' ? 'updated' : 'timeout')
        }
    }, [phase, setBaseline])
    useEffect(() => {
        if (outcome !== 'updated') return
        const timer = setTimeout(() => setOutcome(null), 6000)
        return () => clearTimeout(timer)
    }, [outcome])
    return {
        busy: phase === 'queued' || phase === 'running',
        queued: phase === 'queued',
        outcome,
        start: () => {
            setOutcome(null)
            setNow(Date.now())
            setBaseline({ attempt, startedAt: Date.now() })
        }
    }
}

function RefreshNotice(props: { busy: boolean; queued: boolean }) {
    const { t } = useTranslation()
    if (!props.busy) return null
    return (
        <p data-testid="digest-refresh-progress" className="rounded-md bg-[var(--app-subtle-bg)] px-3 py-2 text-xs text-[var(--app-fg)]">
            {props.queued ? t('digest.refreshQueued') : t('digest.refreshing')}
        </p>
    )
}

function RefreshOutcome(props: { outcome: 'updated' | 'timeout' | null; hasError: boolean; requestError: Error | null }) {
    const { t } = useTranslation()
    if (props.requestError) {
        return <span role="alert" className="mr-auto self-center text-xs text-red-600 dark:text-red-400">{t('digest.refreshFailed', { error: props.requestError.message })}</span>
    }
    if (props.outcome === 'updated' && !props.hasError) {
        return <span data-testid="digest-refresh-updated" className="mr-auto self-center text-xs text-[var(--app-badge-success-text)]">{t('digest.updated')}</span>
    }
    if (props.outcome === 'timeout') {
        return <span className="mr-auto self-center text-xs text-[var(--app-hint)]">{t('digest.refreshTimeout')}</span>
    }
    return null
}

export function DigestIcon(props: { className?: string }) {
    return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={props.className ?? 'h-[18px] w-[18px]'}>
            <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
            <path d="M14 3v5h5M9 13h6M9 17h4M9 9h1" />
        </svg>
    )
}

export function CompletedMark(props: { className?: string; title?: string }) {
    return (
        <span title={props.title} aria-label={props.title} className={`inline-flex shrink-0 items-center text-[var(--app-badge-success-text)] ${props.className ?? ''}`}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5">
                <circle cx="12" cy="12" r="9" />
                <path d="m8 12 3 3 5-6" />
            </svg>
        </span>
    )
}

export function SessionDigestDialog(props: { sessionId: string; onClose: () => void }) {
    const { t } = useTranslation()
    const [baseline, setBaseline] = useState<RefreshBaseline | null>(null)
    const query = useSessionDigest(props.sessionId, true, baseline !== null)
    const { refreshSession, setCompleted } = useDigestActions()
    const digest = query.data?.digest ?? null
    const serverState: DigestJobState = query.data?.state ?? (query.data?.running ? 'running' : null)
    const progress = useRefreshProgress(baseline, setBaseline, digest?.lastAttemptAt ?? null, serverState)
    const running = progress.busy || refreshSession.isPending
    const refresh = () => {
        progress.start()
        refreshSession.mutate(props.sessionId, { onError: () => setBaseline(null) })
    }

    return (
        <Dialog open onOpenChange={(open) => { if (!open) props.onClose() }}>
            <DialogContent className="max-w-lg">
                <DialogHeader className="pr-8">
                    <DialogTitle className="flex items-center gap-2">
                        {digest?.completed ? <CompletedMark title={t('digest.completed')} /> : null}
                        <span className="truncate">{digest?.title || t('digest.session.title')}</span>
                    </DialogTitle>
                </DialogHeader>
                <div className="mt-3 flex max-h-[60vh] flex-col gap-4 overflow-y-auto">
                    {query.isLoading ? (
                        <p className="text-sm text-[var(--app-hint)]">{t('misc.loading')}</p>
                    ) : !digest?.generatedAt ? (
                        running ? <RefreshNotice busy queued={progress.queued} /> : <p className="text-sm text-[var(--app-hint)]">{t('digest.none')}</p>
                    ) : (
                        <>
                            <RefreshNotice busy={running} queued={progress.queued} />
                            <Section title={t('digest.done')} items={digest.done} empty={t('digest.emptyList')} />
                            <Section title={t('digest.status')} text={digest.status} empty={t('digest.emptyList')} />
                            <Section title={t('digest.todo')} items={digest.todo} empty={t('digest.noTodo')} />
                            {digest.suggestComplete && !digest.completed ? (
                                <p className="rounded-md bg-[var(--app-subtle-bg)] px-3 py-2 text-xs text-[var(--app-fg)]">{t('digest.suggestComplete')}</p>
                            ) : null}
                        </>
                    )}
                    {digest?.error ? <p role="alert" className="text-xs text-red-600 dark:text-red-400">{digest.error}</p> : null}
                    {digest?.generatedAt ? (
                        <p className="text-[11px] text-[var(--app-hint)]">{t('digest.generatedBy', { model: digest.model ?? '', time: formatTime(digest.generatedAt) })}</p>
                    ) : null}
                </div>
                <div className="mt-4 flex flex-wrap justify-end gap-2">
                    <RefreshOutcome outcome={progress.outcome} hasError={Boolean(digest?.error)} requestError={refreshSession.error} />
                    <Button
                        type="button"
                        variant="secondary"
                        data-testid="digest-refresh"
                        disabled={running}
                        onClick={refresh}
                    >
                        {progress.queued ? t('digest.queued') : running ? t('digest.generating') : t('digest.refresh')}
                    </Button>
                    <Button
                        type="button"
                        variant={digest?.completed ? 'secondary' : 'default'}
                        disabled={setCompleted.isPending}
                        onClick={() => setCompleted.mutate({ sessionId: props.sessionId, completed: !digest?.completed })}
                    >
                        {digest?.completed ? t('digest.markIncomplete') : t('digest.markComplete')}
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    )
}

/** 会话页头的摘要按钮 + 对话框。 */
export function SessionDigestButton(props: { sessionId: string; className: string }) {
    const { t } = useTranslation()
    const [open, setOpen] = useState(false)
    return (
        <>
            <button
                type="button"
                onClick={() => setOpen(true)}
                className={props.className}
                title={t('digest.session.title')}
                aria-label={t('digest.session.title')}
            >
                <DigestIcon />
            </button>
            {open ? <SessionDigestDialog sessionId={props.sessionId} onClose={() => setOpen(false)} /> : null}
        </>
    )
}

export function ProjectDigestDialog(props: { projectKey: string; title: string; onClose: () => void }) {
    const { t } = useTranslation()
    const [baseline, setBaseline] = useState<RefreshBaseline | null>(null)
    const query = useProjectDigests(true, baseline !== null)
    const { refreshProject } = useDigestActions()
    const digest = query.data?.projects.find(project => project.projectKey === props.projectKey) ?? null
    const progress = useRefreshProgress(baseline, setBaseline, digest?.lastAttemptAt ?? null, query.data?.pending?.[props.projectKey] ?? null)
    const running = progress.busy || refreshProject.isPending
    const refresh = () => {
        progress.start()
        refreshProject.mutate(props.projectKey, { onError: () => setBaseline(null) })
    }

    return (
        <Dialog open onOpenChange={(open) => { if (!open) props.onClose() }}>
            <DialogContent className="max-w-lg">
                <DialogHeader className="pr-8">
                    <DialogTitle className="truncate">{t('digest.project.title', { name: props.title })}</DialogTitle>
                </DialogHeader>
                <div className="mt-3 flex max-h-[60vh] flex-col gap-4 overflow-y-auto">
                    {query.isLoading ? (
                        <p className="text-sm text-[var(--app-hint)]">{t('misc.loading')}</p>
                    ) : !digest?.generatedAt ? (
                        running ? <RefreshNotice busy queued={progress.queued} /> : <p className="text-sm text-[var(--app-hint)]">{t('digest.project.none')}</p>
                    ) : (
                        <>
                            <RefreshNotice busy={running} queued={progress.queued} />
                            {digest.stage ? (
                                <div className="flex flex-wrap items-baseline gap-2">
                                    <StageBadge stage={digest.stage} />
                                    {digest.stageReason ? <span className="text-xs text-[var(--app-hint)]">{digest.stageReason}</span> : null}
                                </div>
                            ) : null}
                            {digest.overview ? <Section title={t('digest.overview')} text={digest.overview} empty="" /> : null}
                            <Section title={t('digest.capabilities')} items={digest.capabilities} empty={t('digest.emptyList')} />
                            {digest.artifacts.length > 0 ? <Section title={t('digest.artifacts')} items={digest.artifacts} empty="" /> : null}
                            <Section title={t('digest.status')} text={digest.status} empty={t('digest.emptyList')} />
                            <Section title={t('digest.todo')} items={digest.todo} empty={t('digest.noTodo')} />
                            {digest.judgement ? <Section title={t('digest.judgement')} text={digest.judgement} empty="" /> : null}
                            <p className="text-[11px] text-[var(--app-hint)]">{t('digest.generatedBy', { model: digest.model ?? '', time: formatTime(digest.generatedAt) })}</p>
                        </>
                    )}
                    {digest?.error ? <p role="alert" className="text-xs text-red-600 dark:text-red-400">{digest.error}</p> : null}
                </div>
                <div className="mt-4 flex flex-wrap justify-end gap-2">
                    <RefreshOutcome outcome={progress.outcome} hasError={Boolean(digest?.error)} requestError={refreshProject.error} />
                    <Button
                        type="button"
                        variant="secondary"
                        data-testid="digest-refresh"
                        disabled={running}
                        onClick={refresh}
                    >
                        {progress.queued ? t('digest.queued') : running ? t('digest.generating') : t('digest.refresh')}
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    )
}

export function StageBadge(props: { stage: string; className?: string }) {
    return (
        <span className={`inline-flex shrink-0 items-center rounded-full border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-1.5 py-px text-[10px] font-medium leading-4 text-[var(--app-fg)] ${props.className ?? ''}`}>
            {props.stage}
        </span>
    )
}

/** 左侧列表里项目分组标题下的一行概况：阶段 + 总体情况，点开看全文。 */
export function ProjectDigestLine(props: { projectKey: string; title: string; stage: string; text: string }) {
    const [open, setOpen] = useState(false)
    return (
        <>
            <button
                type="button"
                data-testid="project-digest-line"
                onClick={(event) => { event.stopPropagation(); setOpen(true) }}
                title={props.text}
                className="ml-8 mr-2 -mt-0.5 mb-0.5 flex w-[calc(100%-2.5rem)] min-w-0 items-center gap-1.5 rounded px-1 py-0.5 text-left text-[11px] leading-4 text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
            >
                {props.stage ? <StageBadge stage={props.stage} /> : null}
                <span className="min-w-0 truncate">{props.text}</span>
            </button>
            {open ? (
                <div onClick={(event) => event.stopPropagation()}>
                    <ProjectDigestDialog projectKey={props.projectKey} title={props.title} onClose={() => setOpen(false)} />
                </div>
            ) : null}
        </>
    )
}

/** 项目分组标题上的摘要按钮（悬停出现，与复制路径按钮同风格）。 */
export function ProjectDigestButton(props: { projectKey: string; title: string; className?: string }) {
    const { t } = useTranslation()
    const [open, setOpen] = useState(false)
    return (
        <>
            <button
                type="button"
                onClick={(event) => { event.stopPropagation(); setOpen(true) }}
                className={`flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] ${props.className ?? ''}`}
                title={t('digest.project.button')}
                aria-label={t('digest.project.button')}
            >
                <DigestIcon className="h-3.5 w-3.5" />
            </button>
            {open ? (
                <div onClick={(event) => event.stopPropagation()}>
                    <ProjectDigestDialog projectKey={props.projectKey} title={props.title} onClose={() => setOpen(false)} />
                </div>
            ) : null}
        </>
    )
}
