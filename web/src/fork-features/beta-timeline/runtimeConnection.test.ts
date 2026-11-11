import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeItem, RuntimePublication, RuntimeRun, RuntimeSnapshot } from '@hapi/protocol/runtimeTimeline'
import { ApiClient, ApiError } from '@/api/client'
import {
    BetaRuntimeConnection,
    createRuntimeEventParser,
    type RuntimeConnectionCallbacks
} from './runtimeConnection'
import { BetaTimelineStore } from './store'

function runtimeItem(id: string, overrides: Partial<RuntimeItem> = {}): RuntimeItem {
    return {
        id,
        kind: 'assistant',
        runId: 'run-1',
        createdAt: 1,
        updatedAt: 1,
        state: 'running',
        ...overrides
    }
}

function runtimeRun(id: string): RuntimeRun {
    return { id, state: 'running', startedAt: 1 }
}

function snapshot(items: RuntimeItem[] = [], run: RuntimeRun | null = null, seq = 0): RuntimeSnapshot {
    return { version: 1, epoch: 'e1', seq, items, run, updatedAt: 5 }
}

function sseFrame(payload: unknown, event?: string, id?: string): string {
    let frame = ''
    if (event) frame += `event: ${event}\n`
    if (id) frame += `id: ${id}\n`
    frame += `data: ${JSON.stringify(payload)}\n\n`
    return frame
}

function sseResponse(text: string): Response {
    return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(new TextEncoder().encode(text))
            controller.close()
        }
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function sseChunkedResponse(chunks: string[]): Response {
    return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
            const encoder = new TextEncoder()
            for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
            controller.close()
        }
    }))
}

type Harness = {
    callbacks: RuntimeConnectionCallbacks
    publications: RuntimePublication[]
    statuses: Array<{ status: string; error: string | null | undefined }>
    sources: string[]
    revoked: Array<{ status: number; message: string }>
    unavailableCount: () => number
}

function makeCallbacks(): Harness {
    const publications: RuntimePublication[] = []
    const statuses: Array<{ status: string; error: string | null | undefined }> = []
    const sources: string[] = []
    const revoked: Array<{ status: number; message: string }> = []
    let unavailable = 0
    return {
        publications,
        statuses,
        sources,
        revoked,
        unavailableCount: () => unavailable,
        callbacks: {
            onPublication: (p) => publications.push(p),
            onStatus: (status, error) => statuses.push({ status, error }),
            onSource: (source) => sources.push(source),
            onUnavailable: () => { unavailable += 1 },
            onRevoked: (status, message) => revoked.push({ status, message })
        }
    }
}

function fakeApi(handler: (sessionId: string, signal?: AbortSignal) => Promise<Response>): ApiClient {
    const api = { openRuntimeEventsStream: vi.fn(handler) }
    return api as unknown as ApiClient
}

async function flush(microtasks = 30): Promise<void> {
    for (let i = 0; i < microtasks; i += 1) {
        await Promise.resolve()
    }
}

describe('createRuntimeEventParser', () => {
    it('parses a snapshot frame followed by patch frames', () => {
        const parser = createRuntimeEventParser()
        const events = parser.push(
            sseFrame({ kind: 'snapshot', snapshot: snapshot([runtimeItem('i1')]) }, undefined, 'e1:0')
            + sseFrame({ kind: 'patch', patch: { version: 1, epoch: 'e1', seq: 1, changes: [], updatedAt: 6 } }, undefined, 'e1:1')
        )
        expect(events).toHaveLength(2)
        expect(events[0].type).toBe('publication')
        expect(events[1].type).toBe('publication')
    })

    it('reassembles frames split across chunks', () => {
        const parser = createRuntimeEventParser()
        const full = sseFrame({ kind: 'snapshot', snapshot: snapshot() })
        const mid = Math.floor(full.length / 2)
        expect(parser.push(full.slice(0, mid))).toHaveLength(0)
        const events = parser.push(full.slice(mid))
        expect(events).toHaveLength(1)
        expect(events[0].type).toBe('publication')
    })

    it('joins multi-line data fields', () => {
        const parser = createRuntimeEventParser()
        const events = parser.push('data: {"kind":\ndata: "unavailable"}\n\n')
        expect(events).toEqual([{ type: 'unavailable' }])
    })

    it('emits unavailable for the legacy marker frame', () => {
        const parser = createRuntimeEventParser()
        expect(parser.push(sseFrame({ kind: 'unavailable' }))).toEqual([{ type: 'unavailable' }])
    })

    it('emits source events for runtime-source frames and ignores comments', () => {
        const parser = createRuntimeEventParser()
        const events = parser.push(
            ':hb\n'
            + sseFrame({ source: 'disconnected' }, 'runtime-source')
            + ':hb\n'
            + sseFrame({ source: 'connected' }, 'runtime-source')
        )
        expect(events).toEqual([
            { type: 'source', source: 'disconnected' },
            { type: 'source', source: 'connected' }
        ])
    })

    it('flags non-JSON and schema-invalid payloads as malformed', () => {
        const parser = createRuntimeEventParser()
        const events = parser.push('data: not-json\n\n' + 'data: {"kind":"patch","patch":{"nope":1}}\n\n')
        expect(events.map((e) => e.type)).toEqual(['malformed', 'malformed'])
    })

    it('handles CRLF line endings', () => {
        const parser = createRuntimeEventParser()
        const events = parser.push('data: {"kind":"unavailable"}\r\n\r\n')
        expect(events).toEqual([{ type: 'unavailable' }])
    })
})

describe('BetaRuntimeConnection', () => {
    beforeEach(() => {
        vi.useFakeTimers()
    })
    afterEach(() => {
        vi.useRealTimers()
    })

    it('delivers the initial snapshot then live patches and reports live', async () => {
        const harness = makeCallbacks()
        const api = fakeApi(async () => sseChunkedResponse([
            sseFrame({ kind: 'snapshot', snapshot: snapshot([runtimeItem('i1')], runtimeRun('r1')) }),
            sseFrame({ kind: 'patch', patch: { version: 1, epoch: 'e1', seq: 1, changes: [{ type: 'item', item: runtimeItem('i1', { updatedAt: 2, text: 'x' }) }], updatedAt: 7 } })
        ]))
        const connection = new BetaRuntimeConnection(api, 's1', harness.callbacks)
        connection.start()
        await vi.waitFor(() => expect(harness.publications.length).toBeGreaterThanOrEqual(2))

        expect(harness.publications[0].kind).toBe('snapshot')
        expect(harness.publications[1].kind).toBe('patch')
        expect(harness.statuses.some(entry => entry.status === 'live')).toBe(true)
        connection.stop()
    })

    it('reconnects for an authoritative snapshot after clean EOF', async () => {
        const harness = makeCallbacks()
        let calls = 0
        const api = fakeApi(async () => {
            calls += 1
            return sseResponse(sseFrame({ kind: 'snapshot', snapshot: snapshot([], null, calls) }))
        })
        const connection = new BetaRuntimeConnection(api, 's1', harness.callbacks, {
            scheduleRetry: () => 1000
        })
        connection.start()
        await vi.waitFor(() => expect(api.openRuntimeEventsStream).toHaveBeenCalledTimes(1))
        await flush()
        await vi.advanceTimersByTimeAsync(1000)
        await vi.waitFor(() => expect(api.openRuntimeEventsStream).toHaveBeenCalledTimes(2))
        connection.stop()
    })

    it('resyncs immediately when onPublication throws a seq-gap error', async () => {
        const statuses: string[] = []
        const publications: RuntimePublication[] = []
        let calls = 0
        const api = fakeApi(async () => {
            calls += 1
            return sseResponse(sseFrame({ kind: 'snapshot', snapshot: snapshot([], null, calls) }))
        })
        const connection = new BetaRuntimeConnection(api, 's1', {
            onPublication: (p) => {
                publications.push(p)
                if (publications.length === 1) throw new Error('Runtime seq gap')
            },
            onStatus: (status) => statuses.push(status)
        }, { scheduleRetry: () => 1000 })
        connection.start()
        await vi.waitFor(() => expect(api.openRuntimeEventsStream).toHaveBeenCalledTimes(2))
        // Resync path does not wait for the normal backoff chain.
        connection.stop()
    })

    it('reports legacy on unavailable and keeps listening', async () => {
        const harness = makeCallbacks()
        const api = fakeApi(async () => sseResponse(
            sseFrame({ kind: 'unavailable' })
            + sseFrame({ kind: 'snapshot', snapshot: snapshot([runtimeItem('i1')]) })
        ))
        const connection = new BetaRuntimeConnection(api, 's1', harness.callbacks)
        connection.start()
        await vi.waitFor(() => expect(harness.publications.length).toBe(1))
        expect(harness.statuses.some((s) => s.status === 'legacy')).toBe(true)
        expect(harness.unavailableCount()).toBe(1)
        expect(harness.statuses.some(entry => entry.status === 'live')).toBe(true)
        connection.stop()
    })

    it('forwards runtime-source events', async () => {
        const harness = makeCallbacks()
        const api = fakeApi(async () => sseResponse(
            sseFrame({ source: 'disconnected' }, 'runtime-source')
        ))
        const connection = new BetaRuntimeConnection(api, 's1', harness.callbacks)
        connection.start()
        await vi.waitFor(() => expect(harness.sources).toEqual(['disconnected']))
        connection.stop()
    })

    it('stops retrying and notifies onRevoked for 403/404', async () => {
        const harness = makeCallbacks()
        const api = fakeApi(async () => {
            throw new ApiError('forbidden', 403, 'forbidden')
        })
        const connection = new BetaRuntimeConnection(api, 's1', harness.callbacks, { scheduleRetry: () => 0 })
        connection.start()
        await vi.waitFor(() => expect(harness.revoked).toHaveLength(1))
        expect(harness.revoked[0].status).toBe(403)
        await vi.advanceTimersByTimeAsync(100_000)
        expect(api.openRuntimeEventsStream).toHaveBeenCalledTimes(1)
        expect(harness.statuses.at(-1)?.status).toBe('error')
        connection.stop()
    })

    it('treats an unrecoverable 401 as revoked (after ApiClient refresh)', async () => {
        const originalFetch = globalThis.fetch
        const fetchMock = vi.fn().mockResolvedValue(new Response('{"error":"expired"}', { status: 401 }))
        globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
        try {
            const api = new ApiClient('stale-token', { onUnauthorized: async () => null })
            const harness = makeCallbacks()
            const connection = new BetaRuntimeConnection(api, 's1', harness.callbacks)
            connection.start()
            await vi.waitFor(() => expect(harness.revoked).toHaveLength(1))
            expect(harness.revoked[0].status).toBe(401)
            connection.stop()
        } finally {
            globalThis.fetch = originalFetch
        }
    })

    it('retries once through onUnauthorized before streaming', async () => {
        const originalFetch = globalThis.fetch
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(new Response('{}', { status: 401 }))
            .mockResolvedValueOnce(sseResponse(sseFrame({ kind: 'snapshot', snapshot: snapshot() })))
        globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
        try {
            const api = new ApiClient('old', { onUnauthorized: async () => 'fresh-token' })
            const harness = makeCallbacks()
            const connection = new BetaRuntimeConnection(api, 's1', harness.callbacks)
            connection.start()
            await vi.waitFor(() => expect(harness.publications).toHaveLength(1))
            expect(fetchMock).toHaveBeenCalledTimes(2)
            const secondCall = fetchMock.mock.calls[1]
            const headers = new Headers(secondCall[1]?.headers)
            expect(headers.get('authorization')).toBe('Bearer fresh-token')
            connection.stop()
        } finally {
            globalThis.fetch = originalFetch
        }
    })

    it('applies exponential backoff between failed attempts', async () => {
        const harness = makeCallbacks()
        const api = fakeApi(async () => {
            throw new Error('hub down')
        })
        const connection = new BetaRuntimeConnection(api, 's1', harness.callbacks, {
            scheduleRetry: (failures) => failures * 1000
        })
        connection.start()
        await vi.waitFor(() => expect(api.openRuntimeEventsStream).toHaveBeenCalledTimes(1))
        await vi.advanceTimersByTimeAsync(999)
        expect(api.openRuntimeEventsStream).toHaveBeenCalledTimes(1)
        await vi.advanceTimersByTimeAsync(1)
        await vi.waitFor(() => expect(api.openRuntimeEventsStream).toHaveBeenCalledTimes(2))
        connection.stop()
        expect(harness.statuses.some((s) => s.status === 'reconnecting')).toBe(true)
    })

    it('stop() aborts the in-flight stream and suppresses late frames', async () => {
        const harness = makeCallbacks()
        let released = false
        const api = fakeApi(async (_sessionId, signal) => new Response(new ReadableStream<Uint8Array>({
            start(controller) {
                signal?.addEventListener('abort', () => {
                    released = true
                    controller.error(new DOMException('aborted', 'AbortError'))
                })
            }
        })))
        const connection = new BetaRuntimeConnection(api, 's1', harness.callbacks)
        connection.start()
        await vi.waitFor(() => expect(api.openRuntimeEventsStream).toHaveBeenCalled())
        connection.stop()
        await flush()
        expect(released).toBe(true)
    })
})

describe('runtime stream authoritative recovery', () => {
    it('recovers an actual store sequence gap using the next connection snapshot', async () => {
        vi.useFakeTimers()
        const store = new BetaTimelineStore()
        let calls = 0
        const api = fakeApi(async () => {
            calls += 1
            if (calls === 1) {
                return sseResponse(
                    sseFrame({ kind: 'snapshot', snapshot: snapshot([runtimeItem('i1', { text: 'before gap' })]) })
                    + sseFrame({ kind: 'patch', patch: { version: 1, epoch: 'e1', seq: 2, changes: [{ type: 'item', item: runtimeItem('i1', { text: 'must not apply', updatedAt: 2 }) }], updatedAt: 2 } })
                )
            }
            return new Response(new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(new TextEncoder().encode(sseFrame({
                        kind: 'snapshot', snapshot: snapshot([runtimeItem('i1', { text: 'authoritative output', updatedAt: 3 })], null, 3)
                    })))
                }
            }))
        })
        const connection = new BetaRuntimeConnection(api, 's1', {
            onPublication: store.applyPublication,
            onStatus: store.setConnection
        }, { scheduleRetry: () => 1000 })
        try {
            connection.start()
            await flush()
            let row = store.getRow('r:i1')
            expect(row?.kind === 'runtime' && row.item.text).toBe('before gap')
            expect(store.getStatus().connection).toBe('reconnecting')
            await vi.advanceTimersByTimeAsync(250)
            await flush()
            expect(api.openRuntimeEventsStream).toHaveBeenCalledTimes(2)
            row = store.getRow('r:i1')
            expect(row?.kind === 'runtime' && row.item.text).toBe('authoritative output')
            expect(store.getRows().map(ref => ref.id)).toEqual(['r:i1'])
            expect(store.getStatus().connection).toBe('live')
        } finally {
            connection.stop()
            store.dispose()
            vi.useRealTimers()
        }
    })

    it('does not dispatch frames early when a CRLF is split across byte chunks', () => {
        const parser = createRuntimeEventParser()
        expect(parser.push('data: {"kind":\r')).toEqual([])
        expect(parser.push('\ndata: "unavailable"}\r')).toEqual([])
        expect(parser.push('\n\r\n')).toEqual([{ type: 'unavailable' }])
    })
})
