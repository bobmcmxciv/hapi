import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, act, cleanup } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement, type ReactNode } from 'react'
import type { SessionSummary, SyncEvent } from '@/types/api'
import { clearMessageWindow, getMessageWindowState, ingestIncomingMessages, setMessageWindowScope } from '@/lib/message-window-store'
import { queryKeys } from '@/lib/query-keys'
import { useSSE } from './useSSE'

class FakeEventSource {
    static instances: FakeEventSource[] = []

    readonly url: string
    readyState = 0
    onmessage: ((event: MessageEvent<string>) => void) | null = null
    onopen: ((event: Event) => void) | null = null
    onerror: ((event: Event) => void) | null = null
    closed = false

    constructor(url: string) {
        this.url = url
        FakeEventSource.instances.push(this)
    }

    close(): void {
        this.closed = true
        this.readyState = 2
    }

    open(): void {
        this.readyState = 1
        this.onopen?.({} as Event)
    }

    frame(data: unknown, lastEventId = ''): void {
        this.onmessage?.({ data: JSON.stringify(data), lastEventId } as MessageEvent<string>)
    }
}

function makeSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
    return {
        id: 'session-1',
        active: true,
        thinking: false,
        activeAt: 1_000,
        updatedAt: 2_000,
        metadata: null,
        metadataVersion: 0,
        agentStateVersion: 0,
        todosUpdatedAt: 0,
        todoProgress: null,
        pendingRequestsCount: 0,
        pendingRequestKinds: [],
        pendingRequests: [],
        backgroundTaskCount: 0,
        futureScheduledMessageCount: 0,
        nextScheduledAt: null,
        model: null,
        effort: null,
        ...overrides
    } as SessionSummary
}

function makeWrapper(queryClient: QueryClient) {
    return ({ children }: { children: ReactNode }) => (
        createElement(QueryClientProvider, { client: queryClient }, children)
    )
}

function mount(options: {
    subscription?: { all?: boolean; sessionId?: string; machineId?: string }
    scope?: 'global' | 'full'
    sessions?: SessionSummary[]
    onEvent?: (event: SyncEvent) => void
}) {
    const queryClient = new QueryClient()
    if (options.sessions) {
        queryClient.setQueryData(queryKeys.sessions, { sessions: options.sessions })
    }
    const onEvent = vi.fn(options.onEvent ?? (() => { }))
    const onConnect = vi.fn()
    const onToast = vi.fn()
    const view = renderHook(
        () => useSSE({
            enabled: true,
            token: 'tok',
            baseUrl: 'https://hub.example.test',
            subscription: options.subscription,
            scope: options.scope,
            onEvent,
            onConnect,
            onToast
        }),
        { wrapper: makeWrapper(queryClient) }
    )
    return { view, queryClient, onEvent, onConnect, onToast }
}

const ORIGINAL_EVENT_SOURCE = globalThis.EventSource
const ORIGINAL_VISIBILITY = Object.getOwnPropertyDescriptor(document, 'visibilityState')

beforeEach(() => {
    FakeEventSource.instances = []
})

function stubEventSource(): void {
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource
}

afterEach(() => {
    cleanup()
    clearMessageWindow('compose-session')
    setMessageWindowScope('')
    if (ORIGINAL_VISIBILITY) {
        Object.defineProperty(document, 'visibilityState', ORIGINAL_VISIBILITY)
    } else {
        Reflect.deleteProperty(document, 'visibilityState')
    }
    globalThis.EventSource = ORIGINAL_EVENT_SOURCE
    vi.useRealTimers()
})

describe('useSSE composition wiring', () => {
    it('applies terminal admission only to the subscribed detail and ignores stale account lifetimes', () => {
        stubEventSource()
        const held = {
            id: 'terminal-server', seq: 1, localId: 'terminal-local', createdAt: 1000, invokedAt: null,
            content: { role: 'user', content: { type: 'text', text: 'original command' } },
        }
        ingestIncomingMessages('compose-session', [held])
        mount({ subscription: { sessionId: 'compose-session' }, scope: 'full' })
        const source = FakeEventSource.instances[0]!
        act(() => {
            source.frame({
                type: 'messages-resolved', sessionId: 'unrelated-session', resolutions: [
                    { localId: 'terminal-local', resolution: { outcome: 'handled', resolvedAt: 2000 } },
                ]
            })
        })
        expect(getMessageWindowState('compose-session').messages[0].resolution).toBeUndefined()
        act(() => {
            source.frame({
                type: 'messages-resolved', sessionId: 'compose-session', resolutions: [
                    { localId: 'terminal-local', resolution: { outcome: 'handled', resolvedAt: 2000 } },
                ]
            })
        })
        expect(getMessageWindowState('compose-session').messages[0]).toMatchObject({
            resolution: { outcome: 'handled' }, invokedAt: null, content: held.content,
        })
        act(() => {
            setMessageWindowScope('new-account')
            ingestIncomingMessages('compose-session', [held])
            source.frame({
                type: 'messages-resolved', sessionId: 'compose-session', resolutions: [
                    { localId: 'terminal-local', resolution: { outcome: 'cancelled', resolvedAt: 3000 } },
                ]
            })
        })
        expect(getMessageWindowState('compose-session').messages[0].resolution).toBeUndefined()
    })
    it('does not open a connection while disabled', () => {
        stubEventSource()
        const queryClient = new QueryClient()
        renderHook(
            () => useSSE({
                enabled: false,
                token: 'tok',
                baseUrl: 'https://hub.example.test',
                onEvent: () => { }
            }),
            { wrapper: makeWrapper(queryClient) }
        )
        expect(FakeEventSource.instances).toHaveLength(0)
    })

    it('feeds session-scoped message events into the message window and the event callback', () => {
        stubEventSource()
        const { onEvent } = mount({
            subscription: { sessionId: 'compose-session' },
            scope: 'full'
        })
        const source = FakeEventSource.instances[0]
        act(() => {
            source.open()
            source.frame({
                type: 'message-received',
                sessionId: 'compose-session',
                message: {
                    id: 'srv-1',
                    seq: 3,
                    localId: null,
                    content: { role: 'user', content: { type: 'text', text: 'hi' } },
                    createdAt: 1_000
                }
            }, 'evt-1')
        })

        expect(getMessageWindowState('compose-session').messages.map((m) => m.id)).toContain('srv-1')
        expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'message-received' }))
    })

    it('patches the session summary cache from the global connection without touching unrelated rows', () => {
        stubEventSource()
        const sibling = makeSummary({ id: 'sibling' })
        const { queryClient } = mount({
            subscription: { all: true },
            scope: 'global',
            sessions: [makeSummary(), sibling]
        })
        const source = FakeEventSource.instances[0]
        act(() => {
            source.open()
            source.frame({
                type: 'session-updated',
                sessionId: 'session-1',
                data: { thinking: true }
            }, 'evt-2')
        })

        const sessions = queryClient.getQueryData<{ sessions: SessionSummary[] }>(queryKeys.sessions)!
        expect(sessions.sessions.find((s) => s.id === 'session-1')?.thinking).toBe(true)
        expect(sessions.sessions.find((s) => s.id === 'sibling')).toBe(sibling)
    })

    it('does NOT ingest global-scope message-received into the window but still forwards the event', () => {
        stubEventSource()
        const { onEvent } = mount({ subscription: { all: true }, scope: 'global' })
        const source = FakeEventSource.instances[0]
        act(() => {
            source.open()
            source.frame({
                type: 'message-received',
                sessionId: 'compose-session',
                message: {
                    id: 'srv-9',
                    seq: 4,
                    localId: null,
                    content: { role: 'user', content: { type: 'text', text: 'x' } },
                    createdAt: 2_000
                }
            })
        })
        expect(getMessageWindowState('compose-session').messages).toHaveLength(0)
        expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'message-received' }))
    })

    it('routes the handshake to onConnect with the resume verdict and exposes subscriptionId', () => {
        stubEventSource()
        const { view, onConnect } = mount({ subscription: { all: true }, scope: 'global' })
        const source = FakeEventSource.instances[0]
        act(() => {
            source.open()
            source.frame({
                type: 'connection-changed',
                data: { status: 'connected', subscriptionId: 'sub-77', resume: 'ok' }
            })
        })

        expect(onConnect).toHaveBeenCalledWith({ resumed: true })
        expect(view.result.current.subscriptionId).toBe('sub-77')
    })

    it('routes toast events only to onToast, not onEvent', () => {
        stubEventSource()
        const { onEvent, onToast } = mount({ subscription: { all: true }, scope: 'global' })
        const source = FakeEventSource.instances[0]
        act(() => {
            source.open()
            source.frame({
                type: 'toast',
                data: { title: 't', body: 'b', sessionId: 's-1', url: 'https://x' }
            })
        })

        expect(onToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'toast' }))
        expect(onEvent).not.toHaveBeenCalled()
    })

    it('session-ended preserves cached activity and held messages until authoritative revalidation', () => {
        stubEventSource()
        const { queryClient } = mount({
            subscription: { all: true },
            scope: 'global',
            sessions: [makeSummary()]
        })
        const source = FakeEventSource.instances[0]
        act(() => {
            source.open()
            // A session-scoped connection would normally have ingested this
            // row; emulate it directly to exercise the ended-preservation
            // contract.
            ingestIncomingMessages('compose-session', [{
                id: 'srv-hold',
                seq: 8,
                localId: null,
                content: { role: 'user', content: { type: 'text', text: 'held' } },
                createdAt: 3_000
            } as Parameters<typeof ingestIncomingMessages>[1][number]])
            source.frame({ type: 'session-ended', sessionId: 'compose-session', reason: 'terminated' })
            source.frame({ type: 'session-ended', sessionId: 'session-1', reason: 'terminated' })
        })

        expect(getMessageWindowState('compose-session').messages.map((m) => m.id)).toContain('srv-hold')
        const sessions = queryClient.getQueryData<{ sessions: SessionSummary[] }>(queryKeys.sessions)!
        expect(sessions.sessions[0].active).toBe(true)
        expect(sessions.sessions).toHaveLength(1)
    })
    it('a crashing onEvent handler does not commit the replay cursor', () => {
        stubEventSource()
        vi.useFakeTimers()
        Object.defineProperty(document, 'visibilityState', {
            configurable: true,
            value: 'visible'
        })
        const onEvent = vi.fn((event: SyncEvent) => {
            if (event.type === 'session-removed') {
                throw new Error('boom')
            }
        })
        const queryClient = new QueryClient()
        renderHook(
            () => useSSE({
                enabled: true,
                token: 'tok',
                baseUrl: 'https://hub.example.test',
                subscription: { all: true },
                scope: 'global',
                onEvent
            }),
            { wrapper: makeWrapper(queryClient) }
        )
        const first = FakeEventSource.instances[0]
        act(() => {
            first.open()
            first.frame({ type: 'heartbeat' }, 'evt-good')
            // The handler throws: the frame must NOT be committed, so the
            // hub replays it after reconnect (at-least-once).
            first.frame({ type: 'session-removed', sessionId: 's-x' }, 'evt-bad')
            // Kill the transport → reconnect picks up the committed cursor.
            first.readyState = 0
            first.onerror?.({} as Event)
        })
        act(() => {
            vi.advanceTimersByTime(2_000)
        })

        const second = FakeEventSource.instances[1]
        expect(second).toBeDefined()
        // Cursor must be evt-good — the failed evt-bad frame replays.
        expect(new URL(second.url).searchParams.get('lastEventId')).toBe('evt-good')
    })

    it('closes the transport on unmount', () => {
        stubEventSource()
        const { view } = mount({ subscription: { all: true }, scope: 'global' })
        const source = FakeEventSource.instances[0]
        act(() => {
            view.unmount()
        })
        expect(source.closed).toBe(true)
        expect(view.result.current.subscriptionId).toBeNull()
    })
})
