import { useMutation } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import type { ApiClient } from '@/api/client'
import type { AttachmentMetadata, DecryptedMessage } from '@/types/api'
import { makeClientSideId } from '@/lib/messages'
import {
 appendOptimisticMessage,
 getMessageWindowState,
 updateMessageStatus,
} from '@/lib/message-window-store'
import {
 captureQueuedOutboxScope,
 markQueuedOutboxFailed,
 recordQueuedOutboxItem,
 removeQueuedOutboxItem,
} from '@/lib/queued-outbox'
import { usePlatform } from '@/hooks/usePlatform'
import type { MessageDeliveryMode } from '@hapi/protocol'
import { getRetryDeliveryMode } from '@/lib/messageDelivery'
import { clearDraftsAfterSend } from '@/lib/clearDraftsAfterSend'
import { captureComposerDraft, type ComposerDraftCheckpoint } from '@/lib/composer-drafts'

type SendMessageInput = {
 sessionId: string
 text: string
 localId: string
 createdAt: number
 attachments?: AttachmentMetadata[]
 scheduledAt?: number | null
 deliveryMode: MessageDeliveryMode
 draftCheckpoints?: readonly ComposerDraftCheckpoint[]
 isCurrentScope: () => boolean
}

export type SendMessageAcceptance = {
 attemptId: string
}

export type SendMessageSettlement = {
 attemptId: string
 status: 'success' | 'error'
}

type BlockedReason = 'no-api' | 'no-session' | 'pending'

/**
 * Information about a send that the underlying mutation rejected.
 *
 * Surfaced via the `onError` option so the consumer can keep the typed
 * text in the composer (composer must NOT clear on 4xx/5xx or network
 * failure) and render an inline affordance.
 *
 * - `sessionId` is the session the failed send was actually targeting
 *   (post-`resolveSessionId`).  Inactive-session resume can resolve a
 *   target id, kick off async navigation, and then have the POST fail
 *   before navigation completes; without this id the consumer would
 *   restore the text into the wrong composer (the old session) and the
 *   sessionId-change effect would clear it again.
 * - `text` is the original input the user typed, captured before the
 *   mutation cleared the composer.
 * - `error` is the raw thrown value (typically `Error`) so the consumer
 *   can inspect status / message.
 * - `scheduledAt` is the absolute epoch-ms the send was bound for, or
 *   null for an immediate send.  Carried through so a failed scheduled
 *   send can be restored as a scheduled send instead of silently
 *   downgrading to immediate -- `SessionChat.handleSend` clears the
 *   pendingSchedule the moment the mutation is accepted, so without
 *   this the schedule is gone by the time onError fires.
 * - `deliveryMode` records the original intent. A retry retains its localId,
 *   but uncertain Pi steer is downgraded to queue so an unadmitted retry
 *   cannot steer a later generation. Hub duplicate admission reuses the stored
 *   payload; native OMP input-mode hashes are independent of this Pi field.
 *
 * Preserved failed rows own retries; never restore them as a new identity.
 */
export type SendErrorInfo = {
 sessionId: string
 text: string
 error: unknown
 scheduledAt: number | null
 deliveryMode: MessageDeliveryMode
 /** True only after the message mutation was started. */
 mutationStarted: boolean
 /** True when the failed optimistic row was kept as `failed` in the thread
 *  (identity-preserving retry via the in-thread retry button and the durable
 *  outbox) instead of being deleted for composer-restore. Consumers must NOT
 *  re-seat the text into the composer — that would clone the row's identity. */
 rowPreserved?: boolean
}

export type ResolvedSession = {
 sessionId: string
 /** True after an inactive-session resume, even when the hub returns the same id. */
 resumed: boolean
}

export type SessionResolution = {
 attachments?: AttachmentMetadata[]
 /** Transfer moved hidden drafts; wait for the active composer to hydrate/re-upload. */
 deferUntilDraftHydrated?: boolean
}

export type SessionResolvedContext = {
 text: string
 attachments?: AttachmentMetadata[]
}

type UseSendMessageOptions = {
 resolveSessionId?: (sessionId: string) => Promise<ResolvedSession>
 onSessionResolved?: (
  sessionId: string,
  context: SessionResolvedContext,
 ) => void | Promise<void | SessionResolution>
 onBlocked?: (reason: BlockedReason) => void
 onSuccess?: (sessionId: string, drafts: readonly ComposerDraftCheckpoint[]) => void
 onError?: (info: SendErrorInfo) => void
 isSessionThinking?: boolean
}

/** Create an optimistic message for display. Extracted as an extension point
 *  so a future floating-UI PR can route queued messages to a separate area. */
function createOptimisticMessage(input: SendMessageInput, status: 'queued' | 'sending'): DecryptedMessage {
 return {
  id: input.localId,
  seq: null,
  localId: input.localId,
  content: {
   role: 'user',
   content: {
    type: 'text',
    text: input.text,
    attachments: input.attachments
   },
   meta: {
    deliveryMode: input.deliveryMode,
   },
  },
  createdAt: input.createdAt,
  // Explicit null so the strict-null queued check matches. A pre-V8 hub
  // response that omits the field entirely (`undefined`) is treated as
  // already-invoked and stays in the thread, not the floating bar.
  invokedAt: null,
  scheduledAt: input.scheduledAt ?? null,
  status,
  originalText: input.text,
 }
}

function findMessageByLocalId(
 sessionId: string,
 localId: string,
): DecryptedMessage | null {
 const state = getMessageWindowState(sessionId)
 for (const message of state.messages) {
  if (message.localId === localId) return message
 }
 return null
}

/** Pull attachments off a stored optimistic user message.  The schema types
 *  `content` as `unknown`, so this is a defensive narrow: we accept only the
 *  exact shape `createOptimisticMessage` produces (`role: 'user'`, text-typed
 *  content, attachments array) and return undefined otherwise.  Used by
 *  retryMessage so an attachment send retried from the failed-bubble button
 *  re-fires with its attachments instead of becoming a text-only send. */
function getMessageAttachments(message: DecryptedMessage): AttachmentMetadata[] | undefined {
 const content = message.content as unknown
 if (
  typeof content !== 'object' ||
  content === null
 ) {
  return undefined
 }
 const outer = content as { role?: unknown; content?: unknown }
 if (outer.role !== 'user') return undefined
 const inner = outer.content as { type?: unknown; attachments?: unknown } | null
 if (!inner || inner.type !== 'text') return undefined
 if (!Array.isArray(inner.attachments) || inner.attachments.length === 0) {
  return undefined
 }
 return inner.attachments as AttachmentMetadata[]
}

/** Read the durable delivery intent from an optimistic or failed user row.
 * Old rows predate the field, and the cross-layer compatibility rule is that
 * absence means ordinary queued delivery. */
function getMessageDeliveryMode(message: DecryptedMessage): MessageDeliveryMode {
 const content = message.content as unknown
 if (typeof content !== 'object' || content === null) return 'queue'
 const meta = (content as { meta?: unknown }).meta
 if (typeof meta !== 'object' || meta === null) return 'queue'
 return (meta as { deliveryMode?: unknown }).deliveryMode === 'steer'
  ? 'steer'
  : 'queue'
}

export function useSendMessage(
 api: ApiClient | null,
 sessionId: string | null,
 options?: UseSendMessageOptions
): {
 // Returns the started mutation's attempt id, or false when the call was
 // rejected pre-mutation (no-api / no-session / pending) OR the async
 // resolveSessionId step threw. Async is required because inactive-session
 // resume happens before mutation.mutate(), and a sync `true` would let the
 // caller clear UI state (e.g. pendingSchedule) before knowing whether
 // resume succeeded — see SessionChat.handleSend.
 sendMessage: (
  text: string,
  attachments?: AttachmentMetadata[],
  scheduledAt?: number | null,
  deliveryMode?: MessageDeliveryMode,
 ) => Promise<SendMessageAcceptance | false>
 retryMessage: (localId: string) => boolean
 isSending: boolean
 sendSettlement: SendMessageSettlement | null
} {
 const { haptic } = usePlatform()
 const [isResolving, setIsResolving] = useState(false)
 const [sendSettlement, setSendSettlement] = useState<SendMessageSettlement | null>(null)
 const resolveGuardRef = useRef(false)
 const submitGuardRef = useRef(false)
 const isSessionThinkingRef = useRef(options?.isSessionThinking ?? false)
 isSessionThinkingRef.current = options?.isSessionThinking ?? false

 const mutation = useMutation({
  mutationFn: async (input: SendMessageInput) => {
   if (!input.isCurrentScope()) throw new Error('Account changed')
   if (!api) {
    throw new Error('API unavailable')
   }
   await api.sendMessage(
    input.sessionId,
    input.text,
    input.localId,
    input.attachments,
    input.scheduledAt,
    undefined,
    input.deliveryMode,
   )
  },
  onMutate: async (input) => {
   if (!input.isCurrentScope()) throw new Error('Account changed')
   const successStatus = isSessionThinkingRef.current ? 'queued' as const : 'sent' as const
   appendOptimisticMessage(input.sessionId, createOptimisticMessage(input, 'sending'))
   return { successStatus }
  },
  onSuccess: (_, input, context) => {
   if (!input.isCurrentScope()) return
   setSendSettlement({ attemptId: input.localId, status: 'success' })
   // Hub acknowledged the payload — the durable receipt can close.
   removeQueuedOutboxItem(input.localId)
   updateMessageStatus(
    input.sessionId,
    input.localId,
    context?.successStatus ?? 'sent'
   )
   haptic.notification('success')
   options?.onSuccess?.(input.sessionId, input.draftCheckpoints ?? [])
  },
  onError: (error, input) => {
   if (!input.isCurrentScope()) return
   setSendSettlement({ attemptId: input.localId, status: 'error' })
   const errorText = error instanceof Error ? error.message : String(error)
   markQueuedOutboxFailed(input.localId, errorText)
   // Attachment sends keep the legacy failed-bubble UX: no onError so the
   // composer never tries to re-seat attachment metadata it cannot restore.
   if (input.attachments && input.attachments.length > 0) {
    updateMessageStatus(input.sessionId, input.localId, 'failed')
    haptic.notification('error')
    return
   }
   // Text-only sends now ALSO keep the failed row: deleting the optimistic
   // row destroyed the send's identity — a composer-restored resend
   // regenerated localId, so a request that had actually landed at the hub
   // would duplicate while the visible copy looked lost (input-loss bug).
   // The row becomes the single retry surface: the in-thread retry button and
   // the durable outbox both re-fire with the SAME localId, and the hub's
   // idempotent store dedupes a landed request.  onError still fires (with
   // rowPreserved) so the route shows the inline error banner; it must not
   // restore text into the composer.
   updateMessageStatus(input.sessionId, input.localId, 'failed')
   haptic.notification('error')
   options?.onError?.({
    sessionId: input.sessionId,
    text: input.text,
    error,
    scheduledAt: input.scheduledAt ?? null,
    deliveryMode: input.deliveryMode,
    mutationStarted: true,
    rowPreserved: true,
   })
  },
  onSettled: () => { submitGuardRef.current = false },
 })

 const sendMessage = async (
  text: string,
  attachments?: AttachmentMetadata[],
  scheduledAt?: number | null,
  deliveryMode: MessageDeliveryMode = 'queue',
 ): Promise<SendMessageAcceptance | false> => {
  if (!api) {
   options?.onBlocked?.('no-api')
   haptic.notification('error')
   return false
  }
  if (!sessionId) {
   options?.onBlocked?.('no-session')
   haptic.notification('error')
   return false
  }
  if (mutation.isPending || resolveGuardRef.current || submitGuardRef.current) {
   options?.onBlocked?.('pending')
   return false
  }
  const isCurrentScope = captureQueuedOutboxScope()
  const localId = makeClientSideId('local')
  const createdAt = Date.now()
  const sourceDraft = captureComposerDraft(sessionId)
  let targetSessionId = sessionId
  let sendAttachments = attachments
  if (options?.resolveSessionId) {
   resolveGuardRef.current = true
   setIsResolving(true)
   try {
    const resolved = await options.resolveSessionId(sessionId)
    if (!isCurrentScope()) return false
    targetSessionId = resolved.sessionId
    if (resolved.resumed) {
     // Await draft transfer / navigation before the mutation so
     // hidden inactive attachments move with the resumed id
     // (including same-id PTY/Pi/Cursor resumes).
     const resolution = await options.onSessionResolved?.(
      targetSessionId,
      { text, attachments },
     )
     if (resolution?.deferUntilDraftHydrated) {
      // Target composer still needs to hydrate/re-upload files.
      return false
     }
     if (resolution?.attachments) {
      sendAttachments = resolution.attachments
     }
    }
   } catch (error) {
    if (!isCurrentScope()) return false
    haptic.notification('error')
    console.error('Failed to resolve session before send:', error)
    // #918: surface the failure via onError so the route can render
    // an inline affordance instead of silently swallowing the
    // typed text.  This covers the "no resume target" branch
    // (inactiveSessionCanResume === false) and also any failure
    // from api.resumeSession itself.  The mutation never started
    // (no optimistic row to clean up); onError is the only
    // visibility hook the consumer has for this pre-mutation
    // path.  Key by the ORIGINAL sessionId because navigation
    // hasn't happened yet -- the operator is still on the
    // archived session's route.
    options?.onError?.({
     sessionId,
     text,
     error,
     scheduledAt: scheduledAt ?? null,
     deliveryMode,
     mutationStarted: false,
    })
    return false
   } finally {
    resolveGuardRef.current = false
    setIsResolving(false)
   }
  }
  if (!isCurrentScope()) return false
  const input: SendMessageInput = {
   sessionId: targetSessionId, text, localId, createdAt,
   attachments: sendAttachments, scheduledAt, deliveryMode,
   draftCheckpoints: targetSessionId === sessionId
    ? [sourceDraft]
    : [sourceDraft, captureComposerDraft(targetSessionId)],
   isCurrentScope,
  }
  try {
   recordQueuedOutboxItem({ ...input, scheduledAt: scheduledAt ?? null })
  } catch (error) {
   options?.onError?.({
    sessionId: targetSessionId, text, error,
    scheduledAt: scheduledAt ?? null, deliveryMode, mutationStarted: false
   })
   return false
  }
  // The durable outbox now owns this exact submitted snapshot; do not
  // restore it as a new composer identity after reload/lost HTTP ack.
  clearDraftsAfterSend(input.draftCheckpoints ?? [])
  submitGuardRef.current = true
  mutation.mutate(input)
  return { attemptId: localId }
 }

 const retryMessage = (localId: string): boolean => {
  if (!api) {
   options?.onBlocked?.('no-api')
   haptic.notification('error')
   return false
  }
  if (!sessionId) {
   options?.onBlocked?.('no-session')
   haptic.notification('error')
   return false
  }
  if (mutation.isPending || resolveGuardRef.current || submitGuardRef.current) {
   options?.onBlocked?.('pending')
   return false
  }

  const message = findMessageByLocalId(sessionId, localId)
  if (!message || typeof message.originalText !== 'string') return false
  const input: SendMessageInput = {
   sessionId, text: message.originalText, localId, createdAt: message.createdAt,
   attachments: getMessageAttachments(message), scheduledAt: message.scheduledAt ?? null,
   deliveryMode: getRetryDeliveryMode(getMessageDeliveryMode(message)),
   isCurrentScope: captureQueuedOutboxScope(),
  }
  try {
   recordQueuedOutboxItem({ ...input, scheduledAt: input.scheduledAt ?? null })
  } catch {
   haptic.notification('error')
   return false
  }
  updateMessageStatus(sessionId, localId, 'sending')
  submitGuardRef.current = true
  mutation.mutate(input)
  return true
 }

 return {
  sendMessage,
  retryMessage,
  isSending: mutation.isPending || isResolving,
  sendSettlement,
 }
}
