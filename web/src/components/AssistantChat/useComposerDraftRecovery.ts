import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { Attachment } from '@assistant-ui/react'
import { useComposerDraft } from '@/hooks/useComposerDraft'
import {
    attachmentDraftRevision,
    persistInactiveComposerAttachments,
    resetInactiveComposerAttachmentVisibility,
    setComposerDraftSnapshot,
    updateComposerDraftTextSnapshot,
} from '@/lib/composer-draft-transfer'
import type { AttachmentDraftInput } from '@/lib/composer-attachment-drafts'
import type { ComposerSendError } from './composerTypes'
import type { PendingSchedule } from './ScheduleTimePicker'

type InteractionVersion = { text: number; schedule: number; attachments: number }
type RecoveryState = {
    version: InteractionVersion
    guard: InteractionVersion | null
    observedAttachments: Set<string>
    consumedErrorId: number | null
    restored: { id: number; text: string; observed: boolean } | null
}

/** Session-keyed editor transaction owner; transport outcomes never overwrite newer user work. */
export function useComposerDraftRecovery(options: {
    sessionId?: string
    composerText: string
    attachments: readonly Attachment[]
    canRestoreAttachments: boolean
    setText: (text: string) => void
    addAttachment: (file: File) => Promise<void>
    onUploadDraftSnapshot?: (text: string, attachments: AttachmentDraftInput[]) => void
    sendError: ComposerSendError | null
    onClearSendError?: () => void
    onSuppressSendErrorRestore?: (id: number) => void
    pendingSchedule: PendingSchedule | null
    onRestoreSchedule?: (schedule: PendingSchedule) => void
}) {
    const { sessionId, composerText, attachments, canRestoreAttachments, sendError, pendingSchedule } = options
    const state = useMemo<RecoveryState>(() => ({
        version: { text: 0, schedule: 0, attachments: 0 },
        guard: null,
        observedAttachments: new Set(attachments.map(attachment => attachment.id)),
        consumedErrorId: null,
        restored: null,
        // Initial attachment IDs are the baseline for this mounted session.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }), [sessionId])
    const attachmentDrafts = useMemo(() => attachments.flatMap(attachment => {
        if (!attachment.file) return []
        const upload = attachment as Attachment & { path?: string; previewUrl?: string; uploadSessionId?: string }
        return [{ id: attachment.id, file: attachment.file, path: upload.path, previewUrl: upload.previewUrl, uploadSessionId: upload.uploadSessionId }]
    }), [attachments])
    const revision = attachmentDraftRevision(attachmentDrafts)
    const latestText = useRef(composerText)
    latestText.current = composerText
    const latestAttachments = useRef(attachmentDrafts)
    latestAttachments.current = attachmentDrafts
    const draftHydration = useComposerDraft(sessionId, composerText, attachmentDrafts, canRestoreAttachments, options.setText, options.addAttachment)
    const hiddenAttachmentStatePending = !canRestoreAttachments && (draftHydration.sessionId !== sessionId || !draftHydration.complete)
    const hasHiddenAttachments = !canRestoreAttachments && draftHydration.hasStoredAttachments

    useEffect(() => {
        if (sessionId && !canRestoreAttachments) resetInactiveComposerAttachmentVisibility(sessionId)
    }, [sessionId, canRestoreAttachments])
    useEffect(() => {
        if (!sessionId || draftHydration.sessionId !== sessionId || !draftHydration.complete) return
        if (canRestoreAttachments) {
            setComposerDraftSnapshot(sessionId, composerText, latestAttachments.current)
            options.onUploadDraftSnapshot?.(composerText, latestAttachments.current)
        } else {
            // Text is synchronous; blob persistence is driven only by attachment revisions.
            updateComposerDraftTextSnapshot(sessionId, composerText)
        }
    }, [sessionId, canRestoreAttachments, composerText, revision, draftHydration.complete, draftHydration.sessionId, options.onUploadDraftSnapshot])
    useEffect(() => {
        if (!sessionId || canRestoreAttachments || draftHydration.sessionId !== sessionId || !draftHydration.complete) return
        void persistInactiveComposerAttachments(sessionId, latestText.current, latestAttachments.current).catch(error => {
            console.warn('[composer-draft] inactive persistence failed', error)
        })
    }, [sessionId, canRestoreAttachments, revision, draftHydration.complete, draftHydration.sessionId])

    useEffect(() => {
        if (!sendError || state.consumedErrorId === sendError.id) return
        if (sendError.restoreSuppressed) {
            state.consumedErrorId = sendError.id
            return
        }
        const guard = state.guard
        if (!guard) {
            if (draftHydration.sessionId !== sessionId || !draftHydration.complete) return
            if (draftHydration.restoredAny) {
                state.consumedErrorId = sendError.id
                options.onClearSendError?.()
                return
            }
        }
        const changed = guard
            ? state.version.text !== guard.text || state.version.schedule !== guard.schedule || state.version.attachments !== guard.attachments
            : state.version.text !== 0 || state.version.schedule !== 0 || state.version.attachments !== 0
        if (changed || composerText.length !== 0 || attachments.length !== 0) {
            state.consumedErrorId = sendError.id
            options.onClearSendError?.()
            return
        }
        // Parent clears an accepted schedule after its asynchronous acceptance.
        // Restore text and the absolute timestamp only after that clear is visible.
        if (sendError.mutationStarted && pendingSchedule !== null) return
        state.consumedErrorId = sendError.id
        state.restored = { id: sendError.id, text: sendError.text, observed: false }
        options.setText(sendError.text)
        if (sendError.scheduledAt !== null) options.onRestoreSchedule?.({ type: 'absolute', ms: sendError.scheduledAt })
    }, [sendError, state, draftHydration, sessionId, composerText, attachments, pendingSchedule, options.setText, options.onRestoreSchedule, options.onClearSendError])

    useEffect(() => {
        const restored = state.restored
        if (!sendError || !restored || restored.id !== sendError.id) return
        if (!restored.observed) {
            if (composerText === restored.text && attachments.length === 0) restored.observed = true
            return
        }
        if (composerText !== restored.text || attachments.length !== 0) options.onClearSendError?.()
    }, [sendError, state, composerText, attachments, options.onClearSendError])
    useEffect(() => {
        for (const attachment of attachments) {
            if (state.observedAttachments.has(attachment.id)) continue
            state.observedAttachments.add(attachment.id)
            state.version.attachments += 1
        }
    }, [state, attachments])

    const recordUserEdit = useCallback(() => { state.version.text += 1 }, [state])
    const recordScheduleEdit = useCallback(() => { state.version.schedule += 1 }, [state])
    const prepareSend = useCallback(() => {
        state.restored = null
        if (sendError) options.onSuppressSendErrorRestore?.(sendError.id)
        state.guard = { ...state.version }
    }, [state, sendError, options.onSuppressSendErrorRestore])
    return { draftHydration, hiddenAttachmentStatePending, hasHiddenAttachments, recordUserEdit, recordScheduleEdit, prepareSend }
}
