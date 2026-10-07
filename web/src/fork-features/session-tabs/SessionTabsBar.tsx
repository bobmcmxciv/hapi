import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { useNavigate } from '@tanstack/react-router'
import type { SessionSummary } from '@/types/api'
import { useAppContext } from '@/lib/app-context'
import { useTranslation } from '@/lib/use-translation'
import { getSessionTitle } from '@/lib/sessionTitle'
import { getSessionLastSeenAt } from '@/lib/sessionLastSeen'
import { cn } from '@/lib/utils'
import {
    closeOtherTabs,
    closeTab,
    closeTabsToRight,
    moveTab,
    openTab,
    pruneTabs,
    togglePinTab,
    updateSessionTabs,
    useSessionTabsState
} from './sessionTabsStore'
import './sessionTabs.css'

/** 标签按 hub + 账号分开存：同一浏览器切账号不会串。 */
export function useSessionTabsScope(): string {
    const { baseUrl, user } = useAppContext()
    return `${baseUrl}|${user.id}`
}

/** 会话页每次打开一个会话就把它放进标签（已在就只更新激活时间，不挪位置）；会话被删就清掉。 */
export function useSessionTabsSync(selectedSessionId: string | null, sessions: SessionSummary[], loaded: boolean): void {
    const scope = useSessionTabsScope()
    useEffect(() => {
        if (selectedSessionId) updateSessionTabs(scope, state => openTab(state, selectedSessionId, Date.now()))
    }, [scope, selectedSessionId])
    useEffect(() => {
        if (!loaded || sessions.length === 0) return
        const existing = new Set(sessions.map(session => session.id))
        if (selectedSessionId) existing.add(selectedSessionId)
        updateSessionTabs(scope, state => pruneTabs(state, existing))
    }, [scope, loaded, sessions, selectedSessionId])
}

export function useHasSessionTabs(): boolean {
    return useSessionTabsState(useSessionTabsScope()).tabs.length > 0
}

type Menu = { id: string; x: number; y: number } | null

export function SessionTabsBar(props: { sessions: SessionSummary[]; selectedSessionId: string | null; machineLabel: (session: SessionSummary) => string }) {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const scope = useSessionTabsScope()
    const { tabs } = useSessionTabsState(scope)
    const [menu, setMenu] = useState<Menu>(null)
    const [dragging, setDragging] = useState<string | null>(null)
    const scroller = useRef<HTMLDivElement>(null)
    const byId = useMemo(() => new Map(props.sessions.map(session => [session.id, session])), [props.sessions])

    useEffect(() => {
        if (!props.selectedSessionId || !scroller.current) return
        const element = scroller.current.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(props.selectedSessionId)}"]`)
        element?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    }, [props.selectedSessionId, tabs.length])

    useEffect(() => {
        if (!menu) return
        const close = () => setMenu(null)
        window.addEventListener('click', close)
        window.addEventListener('scroll', close, true)
        return () => {
            window.removeEventListener('click', close)
            window.removeEventListener('scroll', close, true)
        }
    }, [menu])

    if (tabs.length === 0) return null

    const go = (id: string | null) => {
        if (id) navigate({ to: '/sessions/$sessionId', params: { sessionId: id } })
        else navigate({ to: '/sessions' })
    }
    const close = (id: string) => {
        let neighbor: string | null = null
        updateSessionTabs(scope, state => {
            const result = closeTab(state, id)
            neighbor = result.neighbor
            return result.state
        })
        if (id === props.selectedSessionId) go(neighbor)
    }
    const onAuxClick = (event: ReactMouseEvent, id: string) => {
        if (event.button === 1) {
            event.preventDefault()
            close(id)
        }
    }

    return (
        <div className="session-tabs-bar shrink-0 border-b border-[var(--app-divider)] bg-[var(--app-secondary-bg)] pt-[env(safe-area-inset-top)]" role="tablist" aria-label={t('tabs.label')}>
            <div ref={scroller} className="session-tabs-scroll flex items-end gap-0.5 overflow-x-auto px-1.5 pt-1.5">
                {tabs.map(tab => {
                    const session = byId.get(tab.id)
                    const active = tab.id === props.selectedSessionId
                    const title = session ? getSessionTitle(session) || t('tabs.untitled') : t('tabs.loading')
                    const unread = !!session && !active && session.updatedAt > getSessionLastSeenAt(session.id)
                    const pending = session?.pendingRequestsCount ?? 0
                    return (
                        <div
                            key={tab.id}
                            data-tab-id={tab.id}
                            role="tab"
                            aria-selected={active}
                            tabIndex={0}
                            draggable
                            title={session ? `${title} · ${props.machineLabel(session)}` : title}
                            onClick={() => go(tab.id)}
                            onKeyDown={event => { if (event.key === 'Enter') go(tab.id) }}
                            onAuxClick={event => onAuxClick(event, tab.id)}
                            onMouseDown={event => { if (event.button === 1) event.preventDefault() }}
                            onContextMenu={event => { event.preventDefault(); setMenu({ id: tab.id, x: event.clientX, y: event.clientY }) }}
                            onDragStart={event => { setDragging(tab.id); event.dataTransfer.effectAllowed = 'move' }}
                            onDragOver={event => { if (dragging && dragging !== tab.id) event.preventDefault() }}
                            onDrop={event => { event.preventDefault(); if (dragging) updateSessionTabs(scope, state => moveTab(state, dragging, tab.id)); setDragging(null) }}
                            onDragEnd={() => setDragging(null)}
                            className={cn(
                                'session-tab group relative flex h-8 shrink-0 cursor-pointer select-none items-center gap-1.5 rounded-t-lg pl-2.5 pr-1 text-xs transition-colors',
                                tab.pinned ? 'max-w-[120px]' : 'max-w-[200px] split:max-w-[220px]',
                                active
                                    ? 'bg-[var(--app-bg)] font-medium text-[var(--app-fg)] shadow-[0_-1px_0_var(--app-border),1px_0_0_var(--app-border),-1px_0_0_var(--app-border)]'
                                    : 'text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]',
                                dragging === tab.id && 'opacity-50'
                            )}
                        >
                            {tab.pinned ? <PinGlyph className="h-3 w-3 shrink-0" /> : null}
                            <StatusDot session={session} unread={unread} />
                            <span className="min-w-0 truncate">{title}</span>
                            {pending > 0 ? <span className="shrink-0 rounded-full bg-[var(--app-badge-error-bg)] px-1.5 text-[10px] font-semibold text-[var(--app-badge-error-text)]">{pending}</span> : null}
                            <button
                                type="button"
                                aria-label={t('tabs.close')}
                                onClick={event => { event.stopPropagation(); close(tab.id) }}
                                className={cn(
                                    'flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]',
                                    active ? 'opacity-100' : 'opacity-60 split:opacity-0 split:group-hover:opacity-100'
                                )}
                            >
                                ×
                            </button>
                        </div>
                    )
                })}
            </div>
            {menu ? (
                <div
                    className="fixed z-50 min-w-[160px] rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] py-1 text-xs shadow-lg"
                    style={{ left: Math.min(menu.x, window.innerWidth - 180), top: menu.y + 4 }}
                    onClick={event => event.stopPropagation()}
                >
                    {[
                        { key: 'pin', label: tabs.find(tab => tab.id === menu.id)?.pinned ? t('tabs.unpin') : t('tabs.pin'), run: () => updateSessionTabs(scope, state => togglePinTab(state, menu.id)) },
                        { key: 'close', label: t('tabs.close'), run: () => close(menu.id) },
                        { key: 'others', label: t('tabs.closeOthers'), run: () => { updateSessionTabs(scope, state => closeOtherTabs(state, menu.id)); if (props.selectedSessionId !== menu.id) go(menu.id) } },
                        {
                            key: 'right', label: t('tabs.closeRight'), run: () => {
                                const index = tabs.findIndex(tab => tab.id === menu.id)
                                const selectedIndex = tabs.findIndex(tab => tab.id === props.selectedSessionId)
                                updateSessionTabs(scope, state => closeTabsToRight(state, menu.id))
                                if (selectedIndex > index && !tabs[selectedIndex]?.pinned) go(menu.id)
                            }
                        }
                    ].map(item => (
                        <button key={item.key} type="button" className="block w-full px-3 py-1.5 text-left hover:bg-[var(--app-subtle-bg)]" onClick={() => { item.run(); setMenu(null) }}>
                            {item.label}
                        </button>
                    ))}
                </div>
            ) : null}
        </div>
    )
}

function StatusDot(props: { session: SessionSummary | undefined; unread: boolean }) {
    const session = props.session
    if (session?.thinking) return <span className="session-tab-thinking h-2 w-2 shrink-0 rounded-full bg-[#22c55e]" />
    if (session?.active) return <span className="h-2 w-2 shrink-0 rounded-full bg-[#22c55e]" />
    if (props.unread) return <span className="h-2 w-2 shrink-0 rounded-full bg-[#3b82f6]" />
    return <span className="h-2 w-2 shrink-0 rounded-full border border-[var(--app-border)]" />
}

function PinGlyph(props: { className?: string }) {
    return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={props.className}>
            <path d="M12 17v5" />
            <path d="M9 10.76V6h6v4.76l2 2.24v2H7v-2z" />
            <path d="M8 2h8" />
        </svg>
    )
}
