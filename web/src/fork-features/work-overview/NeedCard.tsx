import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useAppContext } from '@/lib/app-context'
import { useTranslation } from '@/lib/use-translation'
import { cn } from '@/lib/utils'
import type { AskUserQuestionQuestion } from '@/components/ToolCard/askUserQuestion'
import { cardRequestsOf, latestCardLines, questionAnswers, type CardRequest } from './needCardModel'
import { useWorkActions } from './workApi'

export type CardCandidate = { id: string; title: string; sub: string; active: boolean; pending: number }

/**
 * 待办卡片：不跳到会话页，直接看最近几条消息、批准/拒绝审批、回答提问、给会话发消息，
 * 或者把这条会话忽略掉（不再提醒，梳理待办与项目概况也会当作不需要再关注）。
 * 从「梳理待办」打开时顶部显示这条待办，并可在同一条线的几个会话之间切换。
 */
export function NeedCard(props: {
    sessionId: string
    title: string
    sub: string
    dismissedIds: ReadonlySet<string>
    onClose: () => void
    context?: { text: string; line: string | null }
    candidates?: CardCandidate[]
}) {
    const { t } = useTranslation()
    const [selected, setSelected] = useState(props.sessionId)
    const candidates = props.candidates ?? []
    const current = candidates.find(candidate => candidate.id === selected)
    const title = current?.title ?? props.title
    const sub = current?.sub ?? props.sub

    return (
        <Dialog open onOpenChange={open => { if (!open) props.onClose() }}>
            <DialogContent className="max-w-xl">
                <DialogHeader className="pr-8">
                    <DialogTitle className="truncate">{title}</DialogTitle>
                    <div className="mt-0.5 truncate text-xs text-[var(--app-hint)]">{sub}</div>
                </DialogHeader>
                {props.context ? (
                    <div data-testid="need-card-context" className="mt-2 rounded-xl border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-3 py-2">
                        <div className="flex items-center gap-2 text-[11px] text-[var(--app-hint)]">
                            <span className="font-semibold text-[var(--app-fg)]">{t('work.card2.todo')}</span>
                            {props.context.line ? <span className="truncate">· {props.context.line}</span> : null}
                        </div>
                        <div className="mt-0.5 text-[13px] leading-relaxed">{props.context.text}</div>
                    </div>
                ) : null}
                {candidates.length > 1 ? (
                    <div data-testid="need-card-switch" className="mt-2">
                        <div className="mb-1 text-[11px] text-[var(--app-hint)]">{t('work.card2.sessions', { n: candidates.length })}</div>
                        <div className="flex gap-1.5 overflow-x-auto pb-1 [scrollbar-width:thin]">
                            {candidates.map(candidate => (
                                <button
                                    key={candidate.id}
                                    type="button"
                                    data-session-id={candidate.id}
                                    aria-pressed={candidate.id === selected}
                                    onClick={() => setSelected(candidate.id)}
                                    className={cn(
                                        'flex max-w-[220px] shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1 text-left text-xs transition-colors',
                                        candidate.id === selected ? 'border-[var(--app-link)] bg-[var(--app-chat-user-chip-bg)]' : 'border-[var(--app-border)] hover:bg-[var(--app-subtle-bg)]'
                                    )}
                                >
                                    <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', candidate.active ? 'bg-[#22c55e]' : 'border border-[var(--app-border)]')} />
                                    <span className="truncate">{candidate.title}</span>
                                    {candidate.pending > 0 ? <span className="shrink-0 rounded-full bg-[var(--app-badge-error-bg)] px-1.5 text-[10px] font-semibold text-[var(--app-badge-error-text)]">{candidate.pending}</span> : null}
                                </button>
                            ))}
                        </div>
                    </div>
                ) : null}
                <NeedCardBody key={selected} sessionId={selected} dismissed={props.dismissedIds.has(selected)} onClose={props.onClose} />
            </DialogContent>
        </Dialog>
    )
}

/** 一个会话的卡片内容；切换会话时整块重建，回复框与提示随之清空。 */
function NeedCardBody(props: { sessionId: string; dismissed: boolean; onClose: () => void }) {
    const { t } = useTranslation()
    const { api } = useAppContext()
    const navigate = useNavigate()
    const queryClient = useQueryClient()
    const { setDismissed } = useWorkActions()
    const [reply, setReply] = useState('')
    const [busy, setBusy] = useState<string | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [notice, setNotice] = useState<string | null>(null)

    const detail = useQuery({
        queryKey: ['fork-work', 'need-card', props.sessionId],
        queryFn: async () => {
            const [session, messages] = await Promise.all([
                api.getSession(props.sessionId),
                api.getMessages(props.sessionId, { limit: 60 })
            ])
            return { session: session.session, messages: messages.messages }
        },
        refetchInterval: 5000
    })
    const session = detail.data?.session
    const active = Boolean(session?.active)
    const lines = latestCardLines((detail.data?.messages ?? []) as Array<{ seq: number; content: unknown; createdAt?: number | null }>, 6)
    const requests = cardRequestsOf(session?.agentState?.requests ?? null)

    const run = async (key: string, action: () => Promise<void>, done: string) => {
        setBusy(key)
        setError(null)
        try {
            await action()
            setNotice(done)
            await detail.refetch()
            void queryClient.invalidateQueries({ queryKey: ['sessions'] })
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
        } finally {
            setBusy(null)
        }
    }
    const openSession = () => {
        props.onClose()
        navigate({ to: '/sessions/$sessionId', params: { sessionId: props.sessionId } })
    }

    return (
        <>
            <div data-testid="need-card" className="mt-2 flex max-h-[56vh] flex-col gap-4 overflow-y-auto pr-1">
                <div className="flex items-center gap-2 text-xs text-[var(--app-hint)]">
                    <span className={cn('h-2 w-2 rounded-full', active ? 'bg-[#22c55e]' : 'border border-[var(--app-border)]')} />
                    <span>{active ? t('work.card2.online') : t('work.card2.offline')}</span>
                </div>
                <section>
                    <h3 className="mb-1.5 text-xs font-medium text-[var(--app-hint)]">{t('work.card2.latest')}</h3>
                    {detail.isLoading ? <p className="text-xs text-[var(--app-hint)]">{t('loading')}</p> : lines.length === 0 ? (
                        <p className="text-xs text-[var(--app-hint)]">{t('work.card2.noText')}</p>
                    ) : (
                        <div className="flex flex-col gap-1.5">
                            {lines.map(line => (
                                <div key={line.seq} className={cn('max-w-[92%] whitespace-pre-wrap break-words rounded-xl px-3 py-2 text-[13px] leading-relaxed', line.role === 'user' ? 'self-end bg-[var(--app-chat-user-chip-bg)] text-[var(--app-chat-user-chip-fg)]' : 'self-start bg-[var(--app-subtle-bg)] text-[var(--app-fg)]')}>
                                    {line.text}
                                </div>
                            ))}
                        </div>
                    )}
                </section>

                <section data-testid="need-card-requests">
                    <h3 className="mb-1.5 text-xs font-medium text-[var(--app-hint)]">{t('work.card2.requests', { n: requests.length })}</h3>
                    {!active && requests.length > 0 ? <p className="mb-2 rounded-md bg-[var(--app-subtle-bg)] px-3 py-2 text-xs">{t('work.card2.offlineHint')}</p> : null}
                    {requests.length === 0 ? <p className="text-xs text-[var(--app-hint)]">{t('work.card2.noRequests')}</p> : (
                        <div className="flex flex-col gap-2">
                            {requests.map(request => (
                                <RequestBlock
                                    key={request.id}
                                    request={request}
                                    disabled={!active || busy !== null}
                                    busyKey={busy}
                                    onApprove={(decision) => run(`${request.id}:${decision}`, () => api.approvePermission(props.sessionId, request.id, { decision }), t('work.card2.done'))}
                                    onDeny={() => run(`${request.id}:deny`, () => api.denyPermission(props.sessionId, request.id, { decision: 'denied' }), t('work.card2.done'))}
                                    onAnswer={(answers) => run(`${request.id}:answer`, () => api.approvePermission(props.sessionId, request.id, { answers }), t('work.card2.done'))}
                                />
                            ))}
                        </div>
                    )}
                </section>

                <section>
                    <h3 className="mb-1.5 text-xs font-medium text-[var(--app-hint)]">{t('work.card2.reply')}</h3>
                    <textarea
                        data-testid="need-card-reply"
                        value={reply}
                        onChange={event => setReply(event.target.value)}
                        rows={3}
                        placeholder={t('work.card2.replyPlaceholder')}
                        className="w-full resize-y rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-sm outline-none focus:border-[var(--app-link)]"
                    />
                    <div className="mt-1.5 flex justify-end">
                        <Button
                            type="button"
                            size="sm"
                            disabled={!reply.trim() || busy !== null}
                            onClick={() => run('reply', async () => { await api.sendMessage(props.sessionId, reply.trim(), `need-card-${Date.now()}`); setReply('') }, t('work.card2.sent'))}
                        >
                            {busy === 'reply' ? t('work.card2.sending') : t('work.card2.send')}
                        </Button>
                    </div>
                </section>
                {notice ? <p className="text-xs text-[var(--app-badge-success-text)]">{notice}</p> : null}
                {error ? <p role="alert" className="text-xs text-red-600 dark:text-red-400">{error}</p> : null}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-[var(--app-divider)] pt-3">
                <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    data-testid="need-card-dismiss"
                    disabled={setDismissed.isPending}
                    onClick={() => setDismissed.mutate({ sessionId: props.sessionId, dismissed: !props.dismissed }, { onSuccess: () => { if (!props.dismissed) props.onClose() } })}
                >
                    {props.dismissed ? t('work.need.restore') : t('work.need.dismiss')}
                </Button>
                <span className="flex-1" />
                <Button type="button" size="sm" onClick={openSession}>{t('work.card2.open')} →</Button>
            </div>
        </>
    )
}

function RequestBlock(props: {
    request: CardRequest
    disabled: boolean
    busyKey: string | null
    onApprove: (decision: 'approved' | 'approved_for_session') => void
    onDeny: () => void
    onAnswer: (answers: Record<string, string[]>) => void
}) {
    const { t } = useTranslation()
    const { request } = props
    if (request.kind === 'question') {
        return <QuestionBlock questions={request.questions} disabled={props.disabled} busy={props.busyKey === `${request.id}:answer`} onSubmit={props.onAnswer} />
    }
    return (
        <div className="rounded-xl border border-[var(--app-border)] px-3 py-2.5">
            <div className="text-xs font-semibold">{request.tool}</div>
            {request.summary ? <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-md bg-[var(--app-subtle-bg)] px-2 py-1.5 font-mono text-[11px]">{request.summary}</pre> : null}
            <div className="mt-2 flex flex-wrap gap-2">
                <Button type="button" size="sm" data-testid="need-card-approve" disabled={props.disabled} onClick={() => props.onApprove('approved')}>{t('work.card2.approve')}</Button>
                <Button type="button" size="sm" variant="secondary" disabled={props.disabled} onClick={() => props.onApprove('approved_for_session')}>{t('work.card2.approveSession')}</Button>
                <Button type="button" size="sm" variant="secondary" disabled={props.disabled} onClick={props.onDeny}>{t('work.card2.deny')}</Button>
            </div>
        </div>
    )
}

function QuestionBlock(props: { questions: AskUserQuestionQuestion[]; disabled: boolean; busy: boolean; onSubmit: (answers: Record<string, string[]>) => void }) {
    const { t } = useTranslation()
    const [selected, setSelected] = useState<number[][]>(() => props.questions.map(() => []))
    const [other, setOther] = useState<string[]>(() => props.questions.map(() => ''))
    const [missing, setMissing] = useState(false)
    const toggle = (qIdx: number, optIdx: number) => {
        setSelected(previous => previous.map((list, index) => {
            if (index !== qIdx) return list
            if (props.questions[qIdx]?.multiSelect) return list.includes(optIdx) ? list.filter(item => item !== optIdx) : [...list, optIdx]
            return [optIdx]
        }))
    }
    return (
        <div className="rounded-xl border border-[var(--app-border)] px-3 py-2.5">
            {props.questions.map((question, qIdx) => (
                <div key={qIdx} className={cn(qIdx > 0 && 'mt-3')}>
                    {question.header ? <div className="text-[11px] text-[var(--app-hint)]">{question.header}</div> : null}
                    <div className="text-[13px] font-medium">{question.question}</div>
                    <div className="mt-1.5 flex flex-col gap-1">
                        {question.options.map((option, optIdx) => {
                            const checked = selected[qIdx]?.includes(optIdx) ?? false
                            return (
                                <button
                                    key={optIdx}
                                    type="button"
                                    role={question.multiSelect ? 'checkbox' : 'radio'}
                                    aria-checked={checked}
                                    disabled={props.disabled}
                                    onClick={() => toggle(qIdx, optIdx)}
                                    className={cn('rounded-lg border px-3 py-1.5 text-left text-[13px] transition-colors disabled:opacity-50', checked ? 'border-[var(--app-link)] bg-[var(--app-chat-user-chip-bg)]' : 'border-[var(--app-border)] hover:bg-[var(--app-subtle-bg)]')}
                                >
                                    <span className="font-medium">{option.label}</span>
                                    {option.description ? <span className="block text-[11px] text-[var(--app-hint)]">{option.description}</span> : null}
                                </button>
                            )
                        })}
                        <input
                            value={other[qIdx] ?? ''}
                            onChange={event => setOther(previous => previous.map((value, index) => (index === qIdx ? event.target.value : value)))}
                            disabled={props.disabled}
                            placeholder={t('work.card2.other')}
                            className="rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-1.5 text-[13px] outline-none focus:border-[var(--app-link)]"
                        />
                    </div>
                </div>
            ))}
            {missing ? <p className="mt-1.5 text-xs text-red-600">{t('work.card2.answerAll')}</p> : null}
            <div className="mt-2 flex justify-end">
                <Button
                    type="button"
                    size="sm"
                    data-testid="need-card-answer"
                    disabled={props.disabled}
                    onClick={() => {
                        const answers = questionAnswers(props.questions, selected, other)
                        if (!answers) { setMissing(true); return }
                        setMissing(false)
                        props.onSubmit(answers)
                    }}
                >
                    {props.busy ? t('work.card2.sending') : t('work.card2.submit')}
                </Button>
            </div>
        </div>
    )
}
