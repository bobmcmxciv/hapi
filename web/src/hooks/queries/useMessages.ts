import { useCallback, useEffect, useLayoutEffect, useSyncExternalStore } from 'react'
import type { ApiClient } from '@/api/client'
import type { DecryptedMessage } from '@/types/api'
import type { MessageTurnSegment } from '@hapi/protocol/messageTurns'
import {
    activateMessageWindow,
    cancelOlderMessageLoad,
    configureMessageWindowTurns,
    fetchOlderMessages,
    getMessageWindowState,
    setMessageViewMode,
    subscribeMessageWindow,
    syncTailMessages,
    type MessageViewMode,
    type MessageWindowState,
    type OlderLoadOutcome,
} from '@/lib/message-window-store'

export const EMPTY_STATE: MessageWindowState = {
    sessionId: 'unknown',
    messages: [],
    hasMore: false,
    oldestSeq: null,
    newestSeq: null,
    epoch: null,
    isSyncingTail: false,
    isLoadingMore: false,
    warning: null,
    viewMode: 'tail',
    messagesVersion: 0,
    historyVersion: 0,
    turnSegments: [],
}

export function useMessages(api: ApiClient | null, sessionId: string | null, options: { turns?: number } = {}): {
    messages: DecryptedMessage[]
    warning: string | null
    isSyncingTail: boolean
    isLoadingMore: boolean
    hasMore: boolean
    viewMode: MessageViewMode
    messagesVersion: number
    historyVersion: number
    turnSegments: MessageTurnSegment[]
    loadMore: (onBeforeApply?: (historyVersion: number) => boolean) => Promise<OlderLoadOutcome>
    cancelLoadMore: () => void
    refetch: () => Promise<void>
    setViewMode: (mode: MessageViewMode) => void
} {
    const state = useSyncExternalStore(
        useCallback((listener) => {
            if (!sessionId) return () => { }
            return subscribeMessageWindow(sessionId, listener)
        }, [sessionId]),
        useCallback(() => sessionId ? getMessageWindowState(sessionId) : EMPTY_STATE, [sessionId]),
        () => EMPTY_STATE
    )

    useLayoutEffect(() => {
        if (sessionId) {
            configureMessageWindowTurns(sessionId, options.turns)
            activateMessageWindow(sessionId)
        }
    }, [sessionId, options.turns])

    useEffect(() => {
        if (api && sessionId) {
            void syncTailMessages(api, sessionId)
        }
    }, [api, sessionId, options.turns])

    const loadMore = useCallback(async (onBeforeApply?: (historyVersion: number) => boolean) => {
        if (!api || !sessionId) {
            return { kind: 'stopped', reason: 'unavailable' } as const
        }
        return await fetchOlderMessages(api, sessionId, { onBeforeApply })
    }, [api, sessionId])

    const cancelLoadMore = useCallback(() => {
        if (sessionId) {
            cancelOlderMessageLoad(sessionId)
        }
    }, [sessionId])

    const refetch = useCallback(async () => {
        if (!api || !sessionId) return
        await syncTailMessages(api, sessionId, { ensureAfterCurrent: true })
    }, [api, sessionId])

    const setViewMode = useCallback((mode: MessageViewMode) => {
        if (!sessionId) return
        const previousMode = getMessageWindowState(sessionId).viewMode
        setMessageViewMode(sessionId, mode)
        if (mode === 'tail' && previousMode !== 'tail' && api) {
            void syncTailMessages(api, sessionId, { ensureAfterCurrent: true })
        }
    }, [api, sessionId])

    return {
        messages: state.messages,
        warning: state.warning,
        isSyncingTail: state.isSyncingTail,
        isLoadingMore: state.isLoadingMore,
        hasMore: state.hasMore,
        viewMode: state.viewMode,
        messagesVersion: state.messagesVersion,
        historyVersion: state.historyVersion,
        turnSegments: state.turnSegments,
        loadMore,
        cancelLoadMore,
        refetch,
        setViewMode,
    }
}
