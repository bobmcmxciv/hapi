import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SyncEvent } from '@/types/api'
import {
    SseTransport,
    type SseEventSourceLike,
    type SseTransportCallbacks,
    type SseTransportDeps
} from './sse-transport'
class FakeEventSource implements SseEventSourceLike {
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

    transportError(): void {
        this.readyState = 0
        this.onerror?.({} as Event)
    }
}

function harness(overrides: {
    callbacks?: Partial<SseTransportCallbacks>
    visibility?: 'visible' | 'hidden'
} = {}) {
    FakeEventSource.instances = []
    let visibility = overrides.visibility ?? 'visible'
    let visibilityListener: (() => void) | null = null
    let now = 1_000_000

    const events: SyncEvent[] = []
    const disconnects: string[] = []
    const handshakes: Array<{ subscriptionId: string | null; resumed: boolean }> = []

    const deps: Partial<SseTransportDeps> = {
        createEventSource: (url) => new FakeEventSource(url),
        getVisibility: () => visibility,
        addVisibilityListener: (listener) => {
            visibilityListener = listener
            return () => { visibilityListener = null }
        },
        now: () => now,
        random: () => 0
    }

    const transport = new SseTransport({
        baseUrl: 'https://hub.example.test',
        token: 'tok',
        subscription: { sessionId: 's-1' },
        callbacks: {
            onEvent: (event) => { events.push(event); overrides.callbacks?.onEvent?.(event) },
            onHandshake: (info) => { handshakes.push(info); overrides.callbacks?.onHandshake?.(info) },
            onDisconnect: (reason) => { disconnects.push(reason); overrides.callbacks?.onDisconnect?.(reason) },
            onError: overrides.callbacks?.onError,
            onEventDispatchError: overrides.callbacks?.onEventDispatchError
        },
        deps
    })

    return {
        transport,
        events,
        disconnects,
        handshakes,
        setVisibility(value: 'visible' | 'hidden') { visibility = value },
        fireVisibility() { visibilityListener?.() },
        advance(ms: number) { now += ms },
        lastSource() { return FakeEventSource.instances.at(-1)! },
        sources() { return FakeEventSource.instances }
    }
}

afterEach(() => {
    vi.useRealTimers()
})

describe('SseTransport URL + cursor', () => {
    it('builds the events URL with subscription, visibility and no cursor on first connect', () => {
        const h = harness()
        h.transport.start()
        const url = new URL(h.lastSource().url)
        expect(url.pathname).toBe('/api/events')
        expect(url.searchParams.get('sessionId')).toBe('s-1')
        expect(url.searchParams.get('visibility')).toBe('visible')
        expect(url.searchParams.get('lastEventId')).toBeNull()
        h.transport.dispose()
    })

    it('commits lastEventId only after successful handling and resumes with it', () => {
        vi.useFakeTimers()
        const h = harness()
        h.transport.start()
        const first = h.lastSource()
        first.open()
        first.frame({ type: 'heartbeat' }, 'evt-42')
        expect(h.transport.lastEventCursor).toBe('evt-42')

        first.transportError()
        vi.advanceTimersByTime(2_000)

        const second = h.lastSource()
        expect(second).not.toBe(first)
        expect(new URL(second.url).searchParams.get('lastEventId')).toBe('evt-42')
        h.transport.dispose()
    })

    it('does not commit the cursor when the event handler throws (at-least-once replay)', () => {
        vi.useFakeTimers()
        const dispatchErrors: unknown[] = []
        const h = harness({
            callbacks: {
                onEvent: (event) => {
                    if (event.type === 'session-removed') {
                        throw new Error('handler exploded')
                    }
                },
                onEventDispatchError: (error) => { dispatchErrors.push(error) }
            }
        })
        h.transport.start()
        const first = h.lastSource()
        first.open()
        first.frame({ type: 'heartbeat' }, 'evt-1')
        first.frame({ type: 'session-removed', sessionId: 's-1' }, 'evt-2')
        expect(dispatchErrors).toHaveLength(1)
        // Cursor stayed at evt-1 — the failed frame must be replayed.
        expect(h.transport.lastEventCursor).toBe('evt-1')

        first.transportError()
        vi.advanceTimersByTime(2_000)
        expect(new URL(h.lastSource().url).searchParams.get('lastEventId')).toBe('evt-1')
        h.transport.dispose()
    })

    it('ignores malformed frames without committing the cursor', () => {
        const h = harness()
        h.transport.start()
        const source = h.lastSource()
        source.open()
        source.onmessage?.({ data: 'not json', lastEventId: 'evt-x' } as MessageEvent<string>)
        source.onmessage?.({ data: JSON.stringify([1, 2]), lastEventId: 'evt-y' } as MessageEvent<string>)
        expect(h.events).toHaveLength(0)
        expect(h.transport.lastEventCursor).toBeNull()
        h.transport.dispose()
    })
})

describe('SseTransport handshake', () => {
    it('emits handshake with subscriptionId and resume verdict before onEvent', () => {
        const order: string[] = []
        const h = harness({
            callbacks: {
                onHandshake: () => { order.push('handshake') },
                onEvent: () => { order.push('event') }
            }
        })
        h.transport.start()
        const source = h.lastSource()
        source.open()
        source.frame({ type: 'connection-changed', data: { status: 'connected', subscriptionId: 'sub-9', resume: 'ok' } }, 'e-1')
        expect(order).toEqual(['handshake', 'event'])
        expect(h.handshakes).toEqual([{ subscriptionId: 'sub-9', resumed: true }])
        expect(h.events).toHaveLength(1)
        h.transport.dispose()
    })

    it('reads missing resume as a full-resync verdict', () => {
        const h = harness()
        h.transport.start()
        h.lastSource().open()
        h.lastSource().frame({ type: 'connection-changed', data: { status: 'connected' } })
        expect(h.handshakes).toEqual([{ subscriptionId: null, resumed: false }])
        h.transport.dispose()
    })
})

describe('SseTransport reconnect lifecycle', () => {
    it('schedules reconnect with exponential backoff capped by slow ceiling', () => {
        vi.useFakeTimers()
        const h = harness()
        h.transport.start()

        for (let i = 0; i < 11; i += 1) {
            const source = h.lastSource()
            // Failed connection attempts do not open. A successful open resets
            // the outage streak; exercise that separately below.
            source.transportError()
            const expected = Math.min(i >= 8 ? 300_000 : 30_000, 1_000 * 2 ** i)
            vi.advanceTimersByTime(expected - 1)
            expect(h.lastSource()).toBe(source)
            vi.advanceTimersByTime(1)
            expect(h.lastSource()).not.toBe(source)
        }
        h.transport.dispose()
    })

    it('resets the outage backoff after a successful open', () => {
        vi.useFakeTimers()
        const h = harness()
        h.transport.start()
        h.lastSource().transportError()
        vi.advanceTimersByTime(1_000)
        h.lastSource().transportError()
        vi.advanceTimersByTime(2_000)

        const recovered = h.lastSource()
        recovered.open()
        recovered.transportError()
        vi.advanceTimersByTime(999)
        expect(h.lastSource()).toBe(recovered)
        vi.advanceTimersByTime(1)
        expect(h.lastSource()).not.toBe(recovered)
        h.transport.dispose()
    })

    it('defers reconnect while hidden and retries immediately on visibility', () => {
        vi.useFakeTimers()
        const h = harness()
        h.transport.start()
        const first = h.lastSource()
        first.open()
        h.setVisibility('hidden')
        first.transportError()
        vi.advanceTimersByTime(300_000)
        expect(h.lastSource()).toBe(first)
        expect(h.disconnects).toEqual(['transport-error'])

        h.setVisibility('visible')
        h.fireVisibility()
        expect(h.lastSource()).not.toBe(first)
        h.transport.dispose()
    })

    it('reconnects a stale connection when the tab becomes visible (visibility-recovery)', () => {
        const h = harness()
        h.transport.start()
        const first = h.lastSource()
        first.open()
        h.setVisibility('hidden')
        h.advance(46_000)
        h.setVisibility('visible')
        h.fireVisibility()
        expect(h.disconnects).toEqual(['visibility-recovery'])
        h.transport.dispose()
    })

    it('keeps a fresh connection when the tab becomes visible', () => {
        const h = harness()
        h.transport.start()
        const first = h.lastSource()
        first.open()
        h.advance(10_000)
        h.fireVisibility()
        expect(h.disconnects).toEqual([])
        h.transport.dispose()
    })

    it('fires heartbeat-timeout when no activity for 90s while visible', () => {
        vi.useFakeTimers()
        const h = harness()
        h.transport.start()
        const first = h.lastSource()
        first.open()
        // Age the injected clock past the staleness threshold, then let the
        // next watchdog tick observe it.
        h.advance(100_000)
        vi.advanceTimersByTime(10_000)
        expect(h.disconnects).toEqual(['heartbeat-timeout'])
        h.transport.dispose()
    })

    it('does not heartbeat-timeout while hidden', () => {
        vi.useFakeTimers()
        const h = harness()
        h.transport.start()
        h.lastSource().open()
        h.setVisibility('hidden')
        h.advance(200_000)
        vi.advanceTimersByTime(200_000)
        expect(h.disconnects).toEqual([])
        h.transport.dispose()
    })

    it('notifies disconnect only once per failed attempt', () => {
        vi.useFakeTimers()
        const h = harness()
        h.transport.start()
        const first = h.lastSource()
        first.open()
        first.transportError()
        first.transportError()
        expect(h.disconnects).toEqual(['transport-error'])
        h.transport.dispose()
    })

    it('kills a connect that never opens (connect-timeout)', () => {
        vi.useFakeTimers()
        const h = harness()
        h.transport.start()
        vi.advanceTimersByTime(10_000)
        expect(h.disconnects).toEqual(['connect-timeout'])
        h.transport.dispose()
    })

    it('stops all timers and closes the source on dispose', () => {
        vi.useFakeTimers()
        const h = harness()
        h.transport.start()
        const first = h.lastSource()
        first.open()
        h.transport.dispose()
        expect(first.closed).toBe(true)
        vi.advanceTimersByTime(600_000)
        expect(h.disconnects).toEqual([])
        expect(h.sources()).toHaveLength(1)
    })
})
