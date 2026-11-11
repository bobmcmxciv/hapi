import { useAui, useAuiState } from '@assistant-ui/react'
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import type { ApiClient } from '@/api/client'
import { getMessageWindowState, subscribeMessageWindow } from '@/lib/message-window-store'
import { hasForceSendRequest, isQueuedForInvocation } from '@/lib/messages'
import {
 getQueuedOutboxItems,
 subscribeQueuedOutbox,
 type QueuedOutboxItem,
} from '@/lib/queued-outbox'
import { useForceSendQueued, type ForceSendSummary } from '@/hooks/mutations/useForceSendQueued'
import { useVirtualKeyboardOpen } from '@/hooks/useViewportHeight'
import { EMPTY_STATE } from '@/hooks/queries/useMessages'
import { normalizeDecryptedMessage } from '@/chat/normalize'
import type { DecryptedMessage } from '@/types/api'
import { useCancelQueuedMessage } from '@/hooks/mutations/useCancelQueuedMessage'
import { useTranslation } from '@/lib/use-translation'
import { useToast } from '@/lib/toast-context'
import type { PendingSchedule } from '@/components/AssistantChat/ScheduleTimePicker'
import { formatScheduledTime } from '@/lib/scheduledTime'
import {
 beginQueuedOperation,
 clearQueuedEditRecovery,
 endQueuedOperation,
 getQueuedEditRecovery,
 isQueuedOperationPending,
 saveQueuedEditRecovery,
 subscribeQueuedEditRecovery,
 subscribeQueuedOperation,
} from '@/lib/queued-edit-recovery'

const FORCE_SEND_CONFIRM_KEY = 'queuedMessages.forceSend.confirmScheduled'

function ClockIcon() {
 return (
  <svg
   className="h-[14px] w-[14px] shrink-0"
   viewBox="0 0 16 16"
   fill="none"
   aria-hidden="true"
  >
   <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
   <path
    d="M8 5v3.5l2.5 1.5"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
   />
  </svg>
 )
}

/**
 * Orders queued messages so the floating bar reads top-down as a single timeline:
 *   1. Immediate-queued messages first, in the order they were submitted.
 *   2. Scheduled messages after, ordered by their fire time (soonest first).
 *
 * Without this the bar follows insertion order, which mixes immediate and
 * scheduled rows arbitrarily and makes the "what fires next" question
 * harder to answer at a glance.
 *
 * @internal Exported for unit testing.
 */
export function sortQueuedMessages(msgs: DecryptedMessage[]): DecryptedMessage[] {
 return [...msgs].sort((a, b) => {
  const aSched = a.scheduledAt != null
  const bSched = b.scheduledAt != null
  if (aSched !== bSched) return aSched ? 1 : -1
  // Both scheduledAt values are non-null here (aSched && bSched is true above).
  if (aSched && bSched) return a.scheduledAt! - b.scheduledAt!
  return (a.createdAt ?? 0) - (b.createdAt ?? 0)
 })
}

/**
 * Returns user messages that haven't been invoked yet, including submissions
 * still awaiting HTTP acknowledgement. HTTP success and force-send dispatch
 * do not establish native consumption; only invokedAt/resolution closes a row.
 */
function useQueuedMessages(sessionId: string): DecryptedMessage[] {
 const state = useSyncExternalStore(
  useCallback((listener) => subscribeMessageWindow(sessionId, listener), [sessionId]),
  useCallback(() => getMessageWindowState(sessionId), [sessionId]),
  () => EMPTY_STATE
 )

 // `invokedAt` is the source of truth for invocation; see isQueuedForInvocation
 // (lib/messages) for the shared predicate used by the thread filter and the
 // window store trim helpers.
 // useSyncExternalStore guarantees a stable reference when the snapshot is
 // unchanged, so [state] as the dependency avoids unnecessary re-sorts.
 return useMemo(() => {
  return sortQueuedMessages(
   state.messages.filter(isQueuedForInvocation)
  )
 }, [state])
}

const EMPTY_OUTBOX: readonly QueuedOutboxItem[] = []

/** Browser-pending input the hub may never have received (reload-safe
 *  durable outbox). Rehydrates on mount/reload automatically. */
function useQueuedOutboxItems(sessionId: string): readonly QueuedOutboxItem[] {
 return useSyncExternalStore(
  useCallback((listener) => subscribeQueuedOutbox(listener), []),
  useCallback(() => getQueuedOutboxItems(sessionId), [sessionId]),
  () => EMPTY_OUTBOX
 )
}

/** @internal Exported for unit testing. */
export function getQueuedMessagePreview(msg: DecryptedMessage): { text: string; attachmentNames: string[] } {
 const normalized = normalizeDecryptedMessage(msg)
 if (!normalized || normalized.role !== 'user') {
  return { text: '', attachmentNames: [] }
 }
 const text = (normalized.content.text ?? '').trim()
 const attachments = normalized.content.attachments ?? []
 return {
  text,
  attachmentNames: attachments.map((a) => a.filename ?? 'attachment'),
 }
}

/** @internal Exported for unit testing. */
export function getQueuedMessageEditText(preview: { text: string; attachmentNames: string[] }): string {
 return preview.text || preview.attachmentNames.join(', ')
}

/**
 * Computes the PendingSchedule to restore when editing a queued message.
 *
 * - If the message has a future scheduledAt, return { type: 'absolute', ms } so the
 *   user can re-send with the same specific time (or adjust it).
 * - If scheduledAt is null, undefined, or in the past (message already matured),
 *   return null so the re-sent message goes out immediately.
 *
 * @internal Exported for unit testing.
 */
export function computeEditPendingSchedule(
 scheduledAt: number | null | undefined,
 now: number
): PendingSchedule | null {
 if (scheduledAt == null || scheduledAt <= now) return null
 return { type: 'absolute', ms: scheduledAt }
}

function pendingSchedulesEqual(a: PendingSchedule | null, b: PendingSchedule | null): boolean {
 if (a === b) return true
 if (a === null || b === null) return false
 switch (a.type) {
  case 'preset':
   return b.type === 'preset' && a.preset === b.preset
  case 'absolute':
   return b.type === 'absolute' && a.ms === b.ms
 }
 const exhaustive: never = a
 return exhaustive
}

/**
 * Determines whether the user can cancel or edit a queued message.
 *
 * Two conditions must both be true:
 * 1. hasServerEcho: the hub has persisted the row.
 *    useSendMessage.onMutate creates { id: localId, localId } before POST /messages
 *    completes. Only after the server echo (message-received SSE) does the store
 *    replace the row with a server-assigned UUID id, making id !== localId.
 *    Sending DELETE before that echo would find no row in the hub and return
 *    cancelled/localId:null; the original POST could then still insert and broadcast
 *    the message, letting a canceled message reappear and be invoked.
 * 2. !isPending: no cancel mutation is already in-flight.
 *
 * @internal Exported for unit testing.
 */
export function computeCanCancel({
 id,
 localId,
 isPending,
}: {
 id: string
 localId: string | null | undefined
 isPending: boolean
}): boolean {
 const hasServerEcho = localId ? id !== localId : true
 return hasServerEcho && !isPending
}

/**
 * Floating bar above the composer showing queued (pending invocation) messages.
 * Each item has an edit button (✎) and a cancel button (✕).
 *
 * Edit = client-side cancel + prefill composer with message text (Codex dialect).
 * Cancel = DELETE /sessions/:id/messages/:messageId with optimistic removal.
 */
export function QueuedMessagesBar({
 sessionId,
 api,
 pendingSchedule,
 pendingScheduleRevision,
 onEdit,
}: {
 sessionId: string
 api: ApiClient | null
 /** Current composer schedule, used only to guard an asynchronous edit restore. */
 pendingSchedule: PendingSchedule | null
 /** Monotonic per-session revision; schedule selections win over an async edit restore. */
 pendingScheduleRevision: number
 /**
  * Called when the user clicks Edit on a queued message.
  * The parent should restore `text` into the composer and `pendingSchedule` into the schedule state.
  * Edit is always cancel + prefill, regardless of whether the message is scheduled or immediate.
  */
 onEdit?: (params: { text: string; pendingSchedule: PendingSchedule | null }) => void
}) {
 const queued = useQueuedMessages(sessionId)
 const outboxItems = useQueuedOutboxItems(sessionId)
 const forceSend = useForceSendQueued(api, sessionId)
 const keyboardCompact = useVirtualKeyboardOpen()
 const assistantApi = useAui()
 const composerText = useAuiState((state) => state.composer.text)
 const cancelMutation = useCancelQueuedMessage(api)
 const { t } = useTranslation()
 const { addToast } = useToast()
 const pendingScheduleRef = useRef(pendingSchedule)
 const pendingScheduleRevisionRef = useRef(pendingScheduleRevision)
 const composerTextRef = useRef(composerText)
 const onEditRef = useRef(onEdit)
 const mountedRef = useRef(true)
 const attemptedRecoveryIdsRef = useRef(new Set<string>())
 // onSuccess runs after the cancel request completes, so it must read the
 // newest schedule rather than the render that initiated the request.
 pendingScheduleRef.current = pendingSchedule
 pendingScheduleRevisionRef.current = pendingScheduleRevision
 composerTextRef.current = composerText
 onEditRef.current = onEdit

 const queuedOperationPending = useSyncExternalStore(
  useCallback((listener) => subscribeQueuedOperation(sessionId, listener), [sessionId]),
  useCallback(() => isQueuedOperationPending(sessionId), [sessionId]),
  () => false,
 )

 useEffect(() => {
  mountedRef.current = true
  return () => {
   mountedRef.current = false
  }
 }, [])

 const restoreQueuedEditRecovery = useCallback(() => {
  const recovery = getQueuedEditRecovery(sessionId)
  if (!recovery || attemptedRecoveryIdsRef.current.has(recovery.id)) return
  attemptedRecoveryIdsRef.current.add(recovery.id)

  const currentText = assistantApi.composer().getState().text
  // A new session starts at revision 0. Any schedule interaction, even
  // select-then-clear back to null, increments it and wins over recovery.
  const textCompatible = currentText === recovery.composerTextAtEdit
  const scheduleCompatible = pendingScheduleRevisionRef.current === 0
  if (!textCompatible || !scheduleCompatible) {
   if (mountedRef.current) {
    addToast({
     title: t('queuedMessages.editCurrentDraftKept'),
     body: '',
     sessionId,
     url: window.location.href,
    })
   }
   clearQueuedEditRecovery(sessionId)
   return
  }

  if (recovery.text) {
   assistantApi.composer().setText(recovery.text)
  }
  onEditRef.current?.({ text: recovery.text, pendingSchedule: recovery.pendingSchedule })
  clearQueuedEditRecovery(sessionId)
 }, [addToast, assistantApi, sessionId, t])

 useEffect(() => {
  let disposed = false
  let generation = 0
  const scheduledHandles = new Set<number>()
  const scheduleFrame = (callback: FrameRequestCallback): number => {
   if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(callback)
   return window.setTimeout(() => callback(Date.now()), 0)
  }
  const cancelFrame = (handle: number): void => {
   if (typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(handle)
   } else {
    window.clearTimeout(handle)
   }
  }
  const attemptAfterComposerDraft = () => {
   const attemptGeneration = ++generation
   const scheduleAttemptFrame = (callback: FrameRequestCallback) => {
    let handle = 0
    handle = scheduleFrame((timestamp) => {
     scheduledHandles.delete(handle)
     if (disposed || attemptGeneration !== generation) return
     callback(timestamp)
    })
    scheduledHandles.add(handle)
   }
   scheduleAttemptFrame(() => {
    scheduleAttemptFrame(restoreQueuedEditRecovery)
   })
  }
  attemptAfterComposerDraft()
  const unsubscribe = subscribeQueuedEditRecovery(sessionId, attemptAfterComposerDraft)
  return () => {
   disposed = true
   generation++
   unsubscribe()
   for (const handle of scheduledHandles) {
    cancelFrame(handle)
   }
   scheduledHandles.clear()
  }
 }, [restoreQueuedEditRecovery, sessionId])

 // Web-only outbox rows already visible in the window (a failed bubble for
 // the same localId) must not double-list; the bar covers them via force-send.
 const windowMessages = getMessageWindowState(sessionId).messages
 const hiddenOutboxIds = new Set(
  windowMessages
   .map((message) => message.localId)
   .filter((localId): localId is string => typeof localId === 'string')
 )
 // A native acknowledgement can precede a late HTTP error. Its consumed or
 // resolved receipt must not reappear as browser-pending work in the bar.
 const terminalLocalIds = new Set(windowMessages
  .filter((message) => message.invokedAt != null || message.resolution)
  .map((message) => message.localId))
 const pendingOutbox = outboxItems.filter((item) => !terminalLocalIds.has(item.localId))
 const visibleOutbox = pendingOutbox.filter((item) => !hiddenOutboxIds.has(item.localId))
 const legacyFailed = windowMessages.filter(message => message.status === 'failed' && message.localId && message.invokedAt == null && !message.resolution)
 const totalPending = new Set([...queued.map(message => message.localId ?? message.id), ...pendingOutbox.map(item => item.localId), ...legacyFailed.map(message => message.localId)]).size

 const handleForceSend = () => {
  if (forceSend.isForceSending || !api) return
  const hasFutureScheduled =
   queued.some((msg) => msg.scheduledAt != null && msg.scheduledAt > Date.now())
   || pendingOutbox.some((item) => item.scheduledAt != null && item.scheduledAt > Date.now())
  let includeScheduled = false
  if (hasFutureScheduled) {
   // Explicit opt-in only: future-scheduled input fires early when set.
   includeScheduled = window.confirm(t(FORCE_SEND_CONFIRM_KEY))
  }
  void forceSend.forceSendAll({ includeScheduled }).then((summary) => {
   if (!summary) return
   reportForceSendSummary(summary)
  })
 }

 const reportForceSendSummary = (summary: ForceSendSummary) => {
  const failed = summary.results.filter((result) => result.status === 'failed')
  const uploadFailures = summary.uploadFailures
  if (summary.forceError) {
   addToast({
    title: t('queuedMessages.forceSend.unavailable'),
    body: summary.forceError,
    sessionId,
    url: window.location.href,
   })
   return
  }
  if (failed.length > 0 || uploadFailures.length > 0) {
   const detail = [...failed.map((result) => result.error ?? 'failed'), ...uploadFailures.map((f) => f.error)]
   addToast({
    title: t('queuedMessages.forceSend.partial', { count: String(failed.length + uploadFailures.length) }),
    body: detail.slice(0, 3).join(' · '),
    sessionId,
    url: window.location.href,
   })
   return
  }
  const pending = summary.results.filter(result => result.status === 'pending').length
  if (pending > 0) {
   addToast({ title: t('queuedMessages.forceSend.pending', { count: String(pending) }), body: '', sessionId, url: window.location.href })
   return
  }
  addToast({
   title: t('queuedMessages.forceSend.done', { count: String(new Set(summary.results.map(result => result.localId)).size) }),
   body: '',
   sessionId,
   url: window.location.href,
  })
 }

 const handleRetryOutboxItem = async (item: QueuedOutboxItem) => {
  if (!api || forceSend.isForceSending) return
  const error = await forceSend.uploadOutboxItem(item)
  if (error !== null) {
   addToast({ title: t('queuedMessages.outbox.retryFailed'), body: error, sessionId, url: window.location.href })
  }
 }

 if (totalPending === 0) {
  return null
 }

 return (
  <div
   role="status"
   aria-label={`${totalPending} queued message${totalPending === 1 ? '' : 's'} pending invocation`}
   className="mx-auto w-full max-w-content mb-1"
  >
   <div className="px-3 py-2 text-sm text-[var(--app-fg-muted)]">
    <div className="flex items-center gap-1.5 mb-1.5 text-xs font-medium text-[var(--app-hint)]">
     <ClockIcon />
     <span>Queued · {totalPending}</span>
     <button
      type="button"
      data-testid="force-send-queued"
      aria-label={t('queuedMessages.forceSend.button')}
      disabled={!api || forceSend.isForceSending}
      onClick={handleForceSend}
      onMouseDown={(event) => event.preventDefault()}
      className="ml-auto inline-flex items-center gap-1 rounded-md border border-[var(--app-border)] px-2 py-0.5 text-[11px] font-medium text-[var(--app-fg)] transition-colors hover:bg-[var(--app-secondary-bg)] disabled:cursor-not-allowed disabled:opacity-40"
     >
      <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" aria-hidden="true">
       <path d="M2 8h10M9 4.5 13 8l-4 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {forceSend.isForceSending ? t('queuedMessages.forceSend.sending') : t('queuedMessages.forceSend.button')}
     </button>
     <button
      type="button"
      data-testid="force-send-queued-scheduled"
      disabled={!api || forceSend.isForceSending}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => {
       if (!window.confirm(t(FORCE_SEND_CONFIRM_KEY))) return
       void forceSend.forceSendAll({ includeScheduled: true }).then(summary => {
        if (summary) reportForceSendSummary(summary)
       })
      }}
      className="rounded-md px-2 py-1 text-xs hover:bg-[var(--app-secondary-bg)] disabled:opacity-40"
     >{t('queuedMessages.forceSend.includeScheduled')}</button>
    </div>
    <ul
     data-queued-list
     hidden={keyboardCompact}
     className={keyboardCompact ? 'hidden' : 'flex flex-col gap-1.5 max-h-32 sm:max-h-48 overflow-y-auto'}
     aria-label="Queued messages"
    >
     {queued.map((msg) => {
      const preview = getQueuedMessagePreview(msg)
      const { text, attachmentNames } = preview
      const editText = getQueuedMessageEditText(preview)
      const hasAttachments = attachmentNames.length > 0
      const scheduledAt = msg.scheduledAt
      const isFutureScheduled = scheduledAt != null && scheduledAt > Date.now()
      // Immediate input already has a full bubble in the thread. This row is
      // only a compact reference for its pending edit/cancel controls.
      const actionPreview = (text || attachmentNames.join(', ')).replace(/\s+/g, ' ')
      const compactPreview = actionPreview.length > 80 ? `${actionPreview.slice(0, 80)}…` : actionPreview
      const localId = msg.localId ?? msg.id
      const isPending = cancelMutation.isPending || queuedOperationPending || forceSend.isForceSending
      const canCancel = computeCanCancel({ id: msg.id, localId: msg.localId, isPending })

      const handleCancel = () => {
       if (!canCancel) return
       const token = beginQueuedOperation(sessionId)
       if (!token) return
       void cancelMutation.mutateAsync({
        sessionId,
        messageId: msg.id,
        localId,
        snapshot: msg,
       }).then((result) => {
        if (result.status === 'unconfirmed' && mountedRef.current) {
         addToast({ title: t('queuedMessages.cancelUnconfirmed'), body: '', sessionId, url: window.location.href })
        }
       }).catch(() => {
        // useCancelQueuedMessage restores the optimistic row and gives haptic feedback.
       }).finally(() => {
        endQueuedOperation(sessionId, token)
       })
      }

      const handleEdit = async () => {
       if (!canCancel) return
       // Edit = cancel + restore composer (text + schedule).
       // Works the same for immediate-queued and future-scheduled messages.
       const restoredPendingSchedule = computeEditPendingSchedule(msg.scheduledAt, Date.now())
       // The cancel request is asynchronous. Keep the exact composer text from the
       // click so a newer draft or schedule is never replaced when success arrives.
       const composerTextAtEdit = assistantApi.composer().getState().text
       const pendingScheduleAtEdit = pendingScheduleRef.current
       const pendingScheduleRevisionAtEdit = pendingScheduleRevisionRef.current
       const token = beginQueuedOperation(sessionId)
       if (!token) return

       try {
        const result = await cancelMutation.mutateAsync({
         sessionId,
         messageId: msg.id,
         localId,
         snapshot: msg,
        })
        if (result.status === 'unconfirmed') {
         if (mountedRef.current) {
          addToast({ title: t('queuedMessages.cancelUnconfirmed'), body: '', sessionId, url: window.location.href })
         }
         return
        }
        if (result.status === 'resolved') {
         if (mountedRef.current) {
          addToast({
           title: t(result.message.resolution?.outcome === 'handled' ? 'message.resolution.handled' : 'message.resolution.cancelled'),
           body: '',
           sessionId,
           url: window.location.href,
          })
         }
         return
        }
        // Race guard: if the agent already consumed this message, skip prefill
        // and inform the user so they aren't confused by the row disappearing.
        if (result.status === 'invoked') {
         if (mountedRef.current) {
          addToast({
           title: t('queuedMessages.editAlreadyInvoked'),
           body: '',
           sessionId,
           url: window.location.href,
          })
         }
         return
        }

        const currentText = mountedRef.current
         ? assistantApi.composer().getState().text
         : composerTextRef.current
        const composerChanged = currentText !== composerTextAtEdit
        const scheduleChanged = pendingScheduleRevisionRef.current !== pendingScheduleRevisionAtEdit
         || !pendingSchedulesEqual(pendingScheduleRef.current, pendingScheduleAtEdit)
        // Restore text and schedule as one unit. If either changed while the
        // cancel was pending, the user's newer composer state wins.
        if (composerChanged || scheduleChanged) {
         if (mountedRef.current) {
          addToast({
           title: t('queuedMessages.editCurrentDraftKept'),
           body: '',
           sessionId,
           url: window.location.href,
          })
         }
         return
        }
        if (!mountedRef.current) {
         // The original composer is gone. Persist both values and notify a
         // same-session remount so the result is not lost or delayed until a
         // later navigation cycle.
         saveQueuedEditRecovery(sessionId, {
          text: editText,
          pendingSchedule: restoredPendingSchedule,
          composerTextAtEdit,
          pendingScheduleAtEdit,
         })
         return
        }
        if (editText) {
         assistantApi.composer().setText(editText)
        }
        onEdit?.({ text: editText, pendingSchedule: restoredPendingSchedule })
       } catch {
        // useCancelQueuedMessage restores the optimistic row and gives haptic feedback.
       } finally {
        endQueuedOperation(sessionId, token)
       }
      }

      const canEdit = canCancel

      return (
       <li
        key={msg.localId ?? msg.id}
        className="flex items-start gap-2 min-w-0 rounded-lg bg-[var(--app-secondary-bg)] px-3 py-2 shadow-sm"
       >
        <div className="flex-1 min-w-0">
         {!isFutureScheduled ? (
          <span className="block truncate text-xs text-[var(--app-hint)]" title={text || attachmentNames.join(', ')}>
           {compactPreview}
          </span>
         ) : text ? (
          <span className="line-clamp-3 whitespace-pre-wrap break-words text-[var(--app-fg)]">
           {text}
          </span>
         ) : null}
         {isFutureScheduled && hasAttachments ? (
          <div className={text ? 'mt-1 flex flex-wrap gap-1' : 'flex flex-wrap gap-1'}>
           {attachmentNames.map((name, index) => (
            <span
             key={`${name}-${index}`}
             className="inline-flex max-w-full items-center gap-1 rounded-md bg-[var(--app-bg)] px-2 py-0.5 text-xs text-[var(--app-hint)]"
             title={name}
            >
             <span aria-hidden="true">📎</span>
             <span className="truncate">{name}</span>
            </span>
           ))}
          </div>
         ) : null}
         {isFutureScheduled && (
          <div className="mt-1 flex items-center gap-1 text-xs text-[var(--app-hint)]">
           <ClockIcon />
           <span>
            {t('queuedMessages.scheduledFor', { time: formatScheduledTime(scheduledAt) })}
           </span>
          </div>
         )}
         {msg.status === 'sending' && (
          <div className="mt-1 text-xs text-[var(--app-hint)]">
           {t('queuedMessages.forceSend.sending')}
          </div>
         )}
         {hasForceSendRequest(msg) && (
          <div className="mt-1 text-xs text-[var(--app-hint)]">
           {t('queuedMessages.forceSend.awaiting')}
          </div>
         )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
         <button
          type="button"
          aria-label="Edit queued message"
          disabled={!canEdit}
          onClick={handleEdit}
          onMouseDown={(e) => e.preventDefault()}
          className="flex h-6 w-6 items-center justify-center rounded text-[var(--app-hint)] transition-colors hover:bg-[var(--app-border)] hover:text-[var(--app-fg)] disabled:cursor-not-allowed disabled:opacity-40"
         >
          <svg
           viewBox="0 0 16 16"
           fill="none"
           className="h-3.5 w-3.5"
           aria-hidden="true"
          >
           <path
            d="M11.5 2.5a1.414 1.414 0 0 1 2 2L5 13H3v-2L11.5 2.5Z"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
           />
          </svg>
         </button>
         <button
          type="button"
          aria-label="Cancel queued message"
          disabled={!canCancel}
          onClick={handleCancel}
          onMouseDown={(e) => e.preventDefault()}
          className="flex h-6 w-6 items-center justify-center rounded text-[var(--app-hint)] transition-colors hover:bg-[var(--app-border)] hover:text-[var(--app-fg)] disabled:cursor-not-allowed disabled:opacity-40"
         >
          <svg
           viewBox="0 0 16 16"
           fill="none"
           className="h-3.5 w-3.5"
           aria-hidden="true"
          >
           <path
            d="M4 4l8 8M12 4l-8 8"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
           />
          </svg>
         </button>
        </div>
       </li>
      )
     })}
     {visibleOutbox.map((item) => {
      const attachmentNames = (item.attachments ?? [])
       .map((attachment) => attachment.filename ?? 'attachment')
      const retryDisabled = !api || forceSend.isForceSending
      return (
       <li
        key={`outbox-${item.localId}`}
        data-outbox-item={item.localId}
        className="flex items-start gap-2 min-w-0 rounded-lg border border-dashed border-[var(--app-border)] bg-[var(--app-secondary-bg)] px-3 py-2 shadow-sm"
       >
        <div className="flex-1 min-w-0">
         {item.text ? (
          <span className="line-clamp-3 whitespace-pre-wrap break-words text-[var(--app-fg)]">
           {item.text}
          </span>
         ) : null}
         {attachmentNames.length > 0 ? (
          <div className={item.text ? 'mt-1 flex flex-wrap gap-1' : 'flex flex-wrap gap-1'}>
           {attachmentNames.map((name, index) => (
            <span
             key={`${name}-${index}`}
             className="inline-flex max-w-full items-center gap-1 rounded-md bg-[var(--app-bg)] px-2 py-0.5 text-xs text-[var(--app-hint)]"
             title={name}
            >
             <span aria-hidden="true">📎</span>
             <span className="truncate">{name}</span>
            </span>
           ))}
          </div>
         ) : null}
         {item.scheduledAt != null && item.scheduledAt > Date.now() && (
          <div className="mt-1 flex items-center gap-1 text-xs text-[var(--app-hint)]">
           <ClockIcon />
           <span>
            {t('queuedMessages.scheduledFor', { time: formatScheduledTime(item.scheduledAt) })}
           </span>
          </div>
         )}
         <div className={`mt-1 text-xs ${item.status === 'failed' ? 'text-red-600' : 'text-[var(--app-hint)]'}`}>
          {item.status === 'failed'
           ? t('queuedMessages.outbox.failed', { error: item.lastError ?? '' })
           : t('queuedMessages.outbox.pending')}
         </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
         <button
          type="button"
          aria-label={t('queuedMessages.outbox.retry')}
          title={t('queuedMessages.outbox.retry')}
          disabled={retryDisabled}
          onClick={() => { void handleRetryOutboxItem(item) }}
          onMouseDown={(e) => e.preventDefault()}
          className="flex h-6 w-6 items-center justify-center rounded text-[var(--app-hint)] transition-colors hover:bg-[var(--app-border)] hover:text-[var(--app-fg)] disabled:cursor-not-allowed disabled:opacity-40"
         >
          <svg
           viewBox="0 0 16 16"
           fill="none"
           className="h-3.5 w-3.5"
           aria-hidden="true"
          >
           <path
            d="M13.5 8a5.5 5.5 0 1 1-1.62-3.9M13.5 2.5v2.2h-2.2"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
           />
          </svg>
         </button>
        </div>
       </li>
      )
     })}
    </ul>
   </div>
  </div>
 )
}
