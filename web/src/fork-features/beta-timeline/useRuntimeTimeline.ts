import { useEffect, useMemo } from 'react'
import type { ApiClient } from '@/api/client'
import type { VisibleChatBlock } from '@/chat/toolGroups'
import { BetaTimelineStore } from './store'
import { BetaRuntimeConnection } from './runtimeConnection'

/** No live subscription here: descendants select structure, status or one row. */
export function useRuntimeTimeline(
    api: ApiClient,
    sessionId: string,
    historyBlocks: readonly VisibleChatBlock[]
): BetaTimelineStore {
    // API identity is part of auth scope. Never reuse a previous account's
    // entities when its client/session happens to have the same session id.
    const entry = useMemo(() => {
        const store = new BetaTimelineStore()
        store.setHistory(historyBlocks)
        return { store, generation: 0 }
        // History changes update the existing store in the effect below.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [api, sessionId])
    const store = entry.store

    useEffect(() => { store.setHistory(historyBlocks) }, [store, historyBlocks])

    useEffect(() => {
        const generation = ++entry.generation
        const connection = new BetaRuntimeConnection(api, sessionId, {
            onPublication: publication => store.applyPublication(publication),
            onStatus: (status, error) => store.setConnection(status, error),
            onSource: source => {
                // runtime-source describes the runner socket, not the feed:
                // a legacy (pre-upgrade CLI) session stays legacy, and a
                // reconnecting stream is not live just because the CLI is.
                const connection = store.getStatus().connection
                if (connection === 'legacy' || connection === 'reconnecting' || connection === 'error') return
                store.setConnection('live', source === 'disconnected'
                    ? 'Session runner disconnected; waiting for it to resume'
                    : null)
            },
            onUnavailable: () => store.clearRuntime(),
            onRevoked: (_status, message) => {
                store.clearRuntime()
                store.setConnection('error', message)
            }
        })
        connection.start()
        return () => {
            // Stop I/O synchronously; defer only store disposal so React's
            // StrictMode setup-cleanup-setup replay can reuse its own store.
            connection.stop()
            queueMicrotask(() => {
                if (entry.generation === generation) store.dispose()
            })
        }
    }, [api, sessionId, entry, store])
    return store
}
