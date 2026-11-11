import { StrictMode, type PropsWithChildren } from 'react'
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ApiClient } from '@/api/client'
import type { VisibleChatBlock } from '@/chat/toolGroups'
import { useRuntimeTimeline } from './useRuntimeTimeline'

const history: readonly VisibleChatBlock[] = [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hello' }]

function streamApi() {
    const api = new ApiClient('test')
    const signals: AbortSignal[] = []
    const canceled = vi.fn()
    const controllers: ReadableStreamDefaultController<Uint8Array>[] = []
    vi.spyOn(api, 'openRuntimeEventsStream').mockImplementation(async (_sessionId, signal) => {
        if (signal) signals.push(signal)
        return new Response(new ReadableStream<Uint8Array>({
            start(controller) { controllers.push(controller) },
            cancel: canceled
        }))
    })
    return { api, signals, controllers, canceled }
}

async function flush() {
    await act(async () => {
        for (let index = 0; index < 20; index += 1) await Promise.resolve()
    })
}

function send(controller: ReadableStreamDefaultController<Uint8Array>, epoch: string, text: string) {
    controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({
        kind: 'snapshot',
        snapshot: { version: 1, epoch, seq: 0, items: [{ id: 'live', kind: 'assistant', runId: 'run', state: 'running', text, createdAt: 1, updatedAt: 1 }], run: null, updatedAt: 1 }
    })}\n\n`))
}

describe('useRuntimeTimeline lifecycle', () => {
    it('returns a stable unsubscribed store and aborts/cancels on unmount', async () => {
        const harness = streamApi()
        const { result, rerender, unmount } = renderHook(() => useRuntimeTimeline(harness.api, 's1', history))
        const store = result.current
        expect(store.getRows().map(row => row.id)).toEqual(['h:u1'])
        await flush()
        send(harness.controllers[0], 'epoch', 'streamed')
        await flush()
        expect(store.getRows().map(row => row.id)).toEqual(['h:u1', 'r:live'])
        rerender()
        expect(result.current).toBe(store)
        unmount()
        expect(harness.signals[0].aborted).toBe(true)
        await flush()
        expect(harness.canceled).toHaveBeenCalled()
        expect(store.getRows()).toHaveLength(0)
    })

    it('isolates sessions and account API instances, disposing the old stores', async () => {
        const first = streamApi()
        const second = streamApi()
        const { result, rerender, unmount } = renderHook(
            ({ api, id }) => useRuntimeTimeline(api, id, history),
            { initialProps: { api: first.api, id: 's1' } }
        )
        const sessionOne = result.current
        await flush()
        send(first.controllers[0], 'one', 'private session one')
        await flush()
        rerender({ api: first.api, id: 's2' })
        const sessionTwo = result.current
        await flush()
        expect(sessionTwo).not.toBe(sessionOne)
        expect(first.signals[0].aborted).toBe(true)
        expect(sessionOne.getRows()).toHaveLength(0)
        expect(sessionTwo.getRows().map(row => row.id)).toEqual(['h:u1'])
        rerender({ api: second.api, id: 's2' })
        await flush()
        expect(result.current).not.toBe(sessionTwo)
        expect(sessionTwo.getRows()).toHaveLength(0)
        expect(result.current.getRows().map(row => row.id)).toEqual(['h:u1'])
        unmount()
        await flush()
    })

    it('ignores a stale response resolving after a session switch', async () => {
        const api = new ApiClient('test')
        const deferred = Promise.withResolvers<Response>()
        const canceled = vi.fn()
        vi.spyOn(api, 'openRuntimeEventsStream')
            .mockImplementationOnce(async () => deferred.promise)
            .mockImplementation(async () => new Response(new ReadableStream()))
        const { result, rerender, unmount } = renderHook(
            ({ id }) => useRuntimeTimeline(api, id, history),
            { initialProps: { id: 'old' } }
        )
        const old = result.current
        rerender({ id: 'new' })
        const current = result.current
        deferred.resolve(new Response(new ReadableStream({
            start(controller) {
                controller.enqueue(new TextEncoder().encode('data: {"kind":"unavailable"}\n\n'))
            },
            cancel: canceled
        })))
        await flush()
        expect(canceled).toHaveBeenCalled()
        expect(old.getRows()).toHaveLength(0)
        expect(current.getStatus().connection).toBe('connecting')
        expect(current.getRows().map(row => row.id)).toEqual(['h:u1'])
        unmount()
        await flush()
    })

    it('survives StrictMode setup/cleanup replay without disposing the active store', async () => {
        const harness = streamApi()
        const wrapper = ({ children }: PropsWithChildren) => <StrictMode>{children}</StrictMode>
        const { result, unmount } = renderHook(() => useRuntimeTimeline(harness.api, 's1', history), { wrapper })
        await flush()
        send(harness.controllers.at(-1)!, 'strict', 'active')
        await flush()
        expect(result.current.getRows().map(row => row.id)).toEqual(['h:u1', 'r:live'])
        expect(result.current.getStatus().connection).toBe('live')
        unmount()
        await flush()
    })
})

it('keeps legacy status when the runner socket reports connected/disconnected', async () => {
    const harness = streamApi()
    const { result, unmount } = renderHook(() => useRuntimeTimeline(harness.api, 's1', history))
    await flush()
    const controller = harness.controllers[0]
    controller.enqueue(new TextEncoder().encode('data: {"kind":"unavailable"}\n\n'))
    await flush()
    expect(result.current.getStatus().connection).toBe('legacy')
    controller.enqueue(new TextEncoder().encode('event: runtime-source\ndata: {"source":"disconnected"}\n\n'))
    await flush()
    expect(result.current.getStatus().connection).toBe('legacy')
    controller.enqueue(new TextEncoder().encode('event: runtime-source\ndata: {"source":"connected"}\n\n'))
    await flush()
    expect(result.current.getStatus().connection).toBe('legacy')
    unmount()
    await flush()
})
