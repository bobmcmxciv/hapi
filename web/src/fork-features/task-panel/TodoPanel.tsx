import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { TodoItem } from '@hapi/protocol/types'
import { formatDuration } from '@/chat/presentation'
import type { SessionStatusData, SessionStatusSubagent } from '@/chat/sessionStatus'
import { ChecklistList, extractTodoChecklist } from '@/components/ToolCard/checklist'
import { useTranslation } from '@/lib/use-translation'

const COLLAPSED_STORAGE_KEY = 'hapi.todo-panel.collapsed'

function ChevronIcon(props: { open: boolean }) {
    return (
        <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`shrink-0 transition-transform duration-200 ${props.open ? 'rotate-90' : ''}`}>
            <polyline points="9 18 15 12 9 6" />
        </svg>
    )
}

function Section(props: { title: string; children: ReactNode }) {
    return (
        <section className="mt-2 min-w-0 border-t border-[var(--app-border)] pt-2">
            <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--app-hint)]">
                {props.title}
            </h3>
            {props.children}
        </section>
    )
}

function subagentTone(state: SessionStatusSubagent['state']): string {
    if (state === 'error') return 'text-red-600'
    if (state === 'waiting') return 'text-amber-600'
    return 'text-emerald-600'
}

function elapsedSince(startedAt: number | null, now: number): string | null {
    if (startedAt === null || startedAt <= 0) return null
    return formatDuration(Math.max(0, now - startedAt))
}

/**
 * 会话任务清单，兼作会话状态面板。
 *
 * fork 原本只渲染 TaskCreate/TaskUpdate 的任务清单；上游 #1301 另加了一个顶端的
 * 只读 SessionStatusPanel（目标 / 任务 / 子代理 / 后台终端），两者同屏时任务列表
 * 重复出现。这里把状态内容并进任务清单：保留 fork 的折叠头与进度计数形态，目标 /
 * 子代理 / 后台终端作为展开后的附加段落；顶端那个面板不再挂载。
 */
export function TodoPanel(props: {
    sessionId: string
    todos: TodoItem[] | undefined
    status?: SessionStatusData | null
}) {
    const { t } = useTranslation()
    const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSED_STORAGE_KEY) === '1')
    const items = useMemo(() => extractTodoChecklist({ todos: props.todos }, null), [props.todos])
    const completed = items.filter((item) => item.status === 'completed').length
    const inProgress = items.find((item) => item.status === 'in_progress') ?? null

    const status = props.status ?? null
    const goal = status?.goal ?? null
    const subagents = status?.subagents ?? []
    const terminals = status?.terminals ?? []
    const undiscoveredTerminalCount = status?.undiscoveredTerminalCount ?? 0
    const possibleTerminalCommands = status?.possibleTerminalCommands ?? []

    // 子代理 / 终端的耗时要走秒表；没有在跑的就不空转定时器。
    const hasLiveElapsed = terminals.length > 0
        || subagents.some((subagent) => subagent.endedAt === null && subagent.startedAt !== null)
    const [now, setNow] = useState(() => Date.now())
    useEffect(() => {
        if (!hasLiveElapsed) return
        const timer = window.setInterval(() => setNow(Date.now()), 1000)
        return () => window.clearInterval(timer)
    }, [hasLiveElapsed])

    const hasStatusSections = Boolean(goal)
        || subagents.length > 0
        || terminals.length > 0
        || undiscoveredTerminalCount > 0
    if (items.length === 0 && !hasStatusSections) return null

    const toggleCollapsed = () => {
        const next = !collapsed
        localStorage.setItem(COLLAPSED_STORAGE_KEY, next ? '1' : '0')
        setCollapsed(next)
    }

    // 折叠态的一行摘要：优先显示进行中的任务，没有就退到会话目标。
    const collapsedSummary = inProgress ? `◉ ${inProgress.text}` : goal ? goal.objective : null

    return (
        <div className="mx-auto mb-1 w-full max-w-content">
            <div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-subtle-bg)]" data-testid="todo-panel">
                <button type="button" onClick={toggleCollapsed} aria-expanded={!collapsed} aria-controls={`todo-panel-body-${props.sessionId}`} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs font-medium text-[var(--app-fg)] hover:opacity-90">
                    <ChevronIcon open={!collapsed} />
                    <span aria-hidden="true" className="shrink-0 text-[var(--app-hint)]">☑</span>
                    <span className="shrink-0">{t('todoPanel.title')}</span>
                    {collapsed && collapsedSummary ? (
                        <span className="min-w-0 flex-1 truncate font-normal text-[var(--app-link)]">{collapsedSummary}</span>
                    ) : <span className="flex-1" />}
                    {items.length > 0 ? (
                        <span className="shrink-0 text-[11px] tabular-nums text-[var(--app-hint)]">{completed}/{items.length}</span>
                    ) : null}
                </button>
                <div id={`todo-panel-body-${props.sessionId}`} className="collapsible-panel" aria-hidden={collapsed} {...(!collapsed ? { 'data-open': '' } : {})}>
                    <div className="collapsible-inner" inert={collapsed}>
                        <div className="max-h-[min(50dvh,20rem)] overflow-y-auto px-3 pb-2">
                            {items.length > 0 ? <ChecklistList items={items} /> : null}

                            {goal ? (
                                <Section title={t('session.status.goal')}>
                                    <div className="break-words text-sm text-[var(--app-fg)]">{goal.objective}</div>
                                    <div className="mt-0.5 text-xs text-[var(--app-hint)]">
                                        {t(`session.status.goal.${goal.status}`)}
                                        {goal.timeUsedSeconds > 0 ? ` · ${formatDuration(goal.timeUsedSeconds * 1000)}` : ''}
                                    </div>
                                </Section>
                            ) : null}

                            {subagents.length > 0 ? (
                                <Section title={t('session.status.subagents')}>
                                    <div className="flex flex-col gap-1.5">
                                        {subagents.map((subagent) => {
                                            const elapsed = elapsedSince(subagent.startedAt, subagent.endedAt ?? now)
                                            return (
                                                <div key={subagent.id} className="min-w-0 text-sm">
                                                    <div className="flex min-w-0 items-baseline gap-1.5">
                                                        <span className={`shrink-0 text-xs ${subagentTone(subagent.state)}`}>●</span>
                                                        <span className="min-w-0 break-words text-[var(--app-fg)]">{subagent.title}</span>
                                                        <span className={`ml-auto shrink-0 text-xs ${subagentTone(subagent.state)}`}>
                                                            {t(`session.status.subagent.${subagent.state}`)}
                                                            {elapsed ? ` · ${elapsed}` : ''}
                                                        </span>
                                                    </div>
                                                    {subagent.detail ? (
                                                        <div className="ml-3.5 break-words text-xs text-[var(--app-hint)]">{subagent.detail}</div>
                                                    ) : null}
                                                </div>
                                            )
                                        })}
                                    </div>
                                </Section>
                            ) : null}

                            {terminals.length > 0 || undiscoveredTerminalCount > 0 ? (
                                <Section title={t('session.status.terminals')}>
                                    <div className="flex flex-col gap-1.5">
                                        {terminals.map((terminal) => {
                                            const elapsed = elapsedSince(terminal.startedAt, now)
                                            return (
                                                <div key={terminal.id} className="min-w-0">
                                                    <code className="block overflow-hidden text-ellipsis whitespace-nowrap text-xs text-[var(--app-fg)]" title={terminal.command}>
                                                        {terminal.command}
                                                    </code>
                                                    {(terminal.cwd || elapsed) ? (
                                                        <div className="overflow-hidden text-ellipsis whitespace-nowrap text-[11px] text-[var(--app-hint)]">
                                                            {[terminal.cwd, elapsed].filter(Boolean).join(' · ')}
                                                        </div>
                                                    ) : null}
                                                </div>
                                            )
                                        })}
                                        {undiscoveredTerminalCount > 0 ? (
                                            <>
                                                <div className="text-xs text-[var(--app-hint)]">
                                                    {t('session.status.terminalsUnavailable', { count: undiscoveredTerminalCount })}
                                                </div>
                                                {possibleTerminalCommands.length > 0 ? (
                                                    <div className="text-[11px] text-[var(--app-hint)]">
                                                        {t('session.status.terminalsPossible')}
                                                        {possibleTerminalCommands.map((command, index) => (
                                                            <code key={`${command}:${index}`} className="block overflow-hidden text-ellipsis whitespace-nowrap" title={command}>{command}</code>
                                                        ))}
                                                    </div>
                                                ) : null}
                                            </>
                                        ) : null}
                                    </div>
                                </Section>
                            ) : null}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    )
}
