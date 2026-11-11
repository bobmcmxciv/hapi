import { useCallback, useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { ApiError, type ApiClient } from '@/api/client'
import type { Session } from '@/types/api'
import type { MessageDeliveryMode } from '@hapi/protocol'
import type { ComposerSendError } from '@/components/AssistantChat/composerTypes'
import { useSendMessage, type SendErrorInfo } from '@/hooks/mutations/useSendMessage'
import { clearDraftsAfterSend } from '@/lib/clearDraftsAfterSend'
import { transferComposerDraftThenNavigate } from '@/lib/composer-draft-transfer'
import { getDraftAttachments } from '@/lib/composer-attachment-drafts'
import { seedMessageWindowFromSession, syncTailMessages } from '@/lib/message-window-store'
import { refreshSessionDetailPreservingActive } from '@/lib/session-detail-optimistic'
import { migrateSuppressedSendError } from '@/lib/suppressed-send-error'
import { queryKeys } from '@/lib/query-keys'
import { useToast } from '@/lib/toast-context'
import { useTranslation } from '@/lib/use-translation'

type SendFailure = {
    id: number
    text: string
    message: string
    code: string | null
    scheduledAt: number | null
    deliveryMode: MessageDeliveryMode
    mutationStarted: boolean
    restoreSuppressed: boolean
}

/** Owns target resolution and send outcomes; queue consumption remains authoritative in the message store. */
export function useSessionComposerController(options: {
    api: ApiClient | null
    sessionId: string
    session: Session | null
    canResume: boolean
}) {
    const { api, sessionId, session, canResume } = options
    const queryClient = useQueryClient()
    const navigate = useNavigate()
    const { addToast } = useToast()
    const { t } = useTranslation()
    const [failures, setFailures] = useState<Record<string, SendFailure>>({})
    const [reopeningSessionId, setReopeningSessionId] = useState<string | null>(null)
    const errorId = useRef(0)
    const resolvedTarget = useRef<{ source: string; target: Promise<string> } | null>(null)
    const reopenFlights = useRef(new Map<string, Promise<void>>())

    // A same-id session may have completed another archive/resume cycle while
    // this route was hidden. A lifecycle generation invalidates its old target.
    useEffect(() => {
        resolvedTarget.current = null
    }, [api, session?.id, session?.active, session?.metadata?.lifecycleStateSince])

    const clearFailure = useCallback((id: string) => {
        setFailures(previous => {
            if (!(id in previous)) return previous
            const next = { ...previous }
            delete next[id]
            return next
        })
    }, [])
    const clearSendError = useCallback(() => clearFailure(sessionId), [clearFailure, sessionId])
    const suppressSendErrorRestore = useCallback((id: number) => {
        setFailures(previous => {
            const failure = previous[sessionId]
            if (!failure || failure.id !== id || failure.restoreSuppressed) return previous
            return { ...previous, [sessionId]: { ...failure, restoreSuppressed: true } }
        })
    }, [sessionId])
    const receiveFailure = useCallback((info: SendErrorInfo) => {
        const inactive = info.error instanceof ApiError && info.error.status === 409 && info.error.code === 'session_inactive'
        const message = inactive
            ? t('chat.sendError.sessionInactive')
            : info.error instanceof Error && info.error.message
                ? info.error.message
                : t('chat.sendError.fallback')
        const failure: SendFailure = {
            id: ++errorId.current,
            text: info.text,
            message,
            code: info.error instanceof ApiError ? info.error.code ?? null : null,
            scheduledAt: info.scheduledAt,
            deliveryMode: info.deliveryMode,
            mutationStarted: info.mutationStarted,
            // Identity-preserving failures keep their failed row as the retry
            // surface — restoring the same text into the composer would fork
            // a second send identity for one message.
            restoreSuppressed: info.rowPreserved === true,
        }
        setFailures(previous => ({ ...previous, [info.sessionId]: failure }))
    }, [t])

    const handleSessionResolved = useCallback((targetId: string) => {
        if (session) {
            if (targetId !== session.id) seedMessageWindowFromSession(session.id, targetId)
            queryClient.setQueryData(queryKeys.session(targetId), (previous: { session?: Session } | undefined) => ({
                session: { ...(previous?.session ?? session), id: targetId, active: true },
            }))
            void queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
        }
        void navigate({ to: '/sessions/$sessionId', params: { sessionId: targetId }, replace: true })
        if (api) {
            void refreshSessionDetailPreservingActive(queryClient, targetId, () => api.getSession(targetId))
            void syncTailMessages(api, targetId).catch(() => { })
        }
    }, [api, navigate, queryClient, session])

    const resolveSessionId = useCallback(async (sourceId: string) => {
        if (!api || !session || session.active) return { sessionId: sourceId, resumed: false }
        const existing = resolvedTarget.current
        if (existing?.source === sourceId) return { sessionId: await existing.target, resumed: true }
        if (!canResume) throw new ApiError(t('chat.sendError.sessionInactive'), 409, 'session_inactive')
        const target = api.resumeSession(sourceId, { permissionMode: session.permissionMode ?? undefined })
        resolvedTarget.current = { source: sourceId, target }
        try {
            return { sessionId: await target, resumed: true }
        } catch (error) {
            if (resolvedTarget.current?.target === target) resolvedTarget.current = null
            const message = error instanceof Error ? error.message : t('dialog.error.default')
            addToast({ title: t('resume.failed.title'), body: message, sessionId: sourceId, url: '' })
            // Keep the real failure (offline machine, missing native journal,
            // denied access, unsupported state), not a generic inactive label.
            throw error
        }
    }, [api, session, canResume, t, addToast])

    const reopen = useCallback((sourceId: string): Promise<void> => {
        if (!api) return Promise.resolve()
        const existing = reopenFlights.current.get(sourceId)
        if (existing) return existing
        setReopeningSessionId(sourceId)
        const operation = (async () => {
            try {
                const result = await api.reopenSession(sourceId)
                clearFailure(sourceId)
                await queryClient.invalidateQueries({ queryKey: queryKeys.session(result.sessionId) })
                await queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
                if (result.sessionId !== sourceId) {
                    await transferComposerDraftThenNavigate(sourceId, result.sessionId, () => navigate({
                        to: '/sessions/$sessionId', params: { sessionId: result.sessionId }, replace: true,
                    }))
                }
            } catch (error) {
                addToast({
                    title: t('resume.failed.title'),
                    body: error instanceof Error ? error.message : t('dialog.error.default'),
                    sessionId: sourceId,
                    url: '',
                })
            } finally {
                reopenFlights.current.delete(sourceId)
                setReopeningSessionId(current => current === sourceId ? null : current)
            }
        })()
        reopenFlights.current.set(sourceId, operation)
        return operation
    }, [api, clearFailure, queryClient, navigate, addToast, t])

    const mutation = useSendMessage(api, sessionId, {
        isSessionThinking: session?.thinking ?? false,
        onSuccess: (targetId, drafts) => {
            clearDraftsAfterSend(drafts)
            clearFailure(targetId)
        },
        onError: receiveFailure,
        resolveSessionId,
        onSessionResolved: async (targetId, context) => {
            setFailures(previous => migrateSuppressedSendError(previous, sessionId, targetId))
            await transferComposerDraftThenNavigate(
                sessionId, targetId, () => handleSessionResolved(targetId), [], { textOverride: context.text },
            )
            const stored = await getDraftAttachments(targetId)
            if ((context.attachments?.length ?? 0) > 0 || stored.length > 0) {
                return { deferUntilDraftHydrated: true }
            }
            return undefined
        },
        onBlocked: reason => {
            if (reason === 'no-api') addToast({
                title: t('send.blocked.title'), body: t('send.blocked.noConnection'), sessionId, url: '',
            })
        },
    })
    const failure = failures[sessionId] ?? null
    const sendError: ComposerSendError | null = failure ? {
        ...failure,
        action: failure.code === 'session_inactive' && canResume ? {
            label: t('chat.sendError.sessionInactive.action'),
            onClick: () => { void reopen(sessionId) },
            pending: reopeningSessionId === sessionId,
        } : null,
    } : null
    const restoreAbortedMessage = useCallback((text: string) => {
        const failure: SendFailure = {
            id: ++errorId.current,
            text,
            message: t('chat.sendError.aborted'),
            code: 'abort',
            scheduledAt: null,
            deliveryMode: 'steer',
            mutationStarted: true,
            restoreSuppressed: false,
        }
        setFailures(previous => ({ ...previous, [sessionId]: failure }))
    }, [sessionId, t])

    return {
        ...mutation,
        sendError,
        clearSendError,
        suppressSendErrorRestore,
        resolveSessionId,
        handleSessionResolved,
        restoreAbortedMessage,
    }
}
