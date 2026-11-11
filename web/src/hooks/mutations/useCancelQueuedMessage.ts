import { useMutation } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { DecryptedMessage } from '@/types/api'
import {
 appendOptimisticMessage,
 captureMessageWindowScope,
 removeOptimisticMessage,
} from '@/lib/message-window-store'
import { usePlatform } from '@/hooks/usePlatform'

type CancelQueuedMessageInput = {
 sessionId: string
 messageId: string
 /** localId used for optimistic removal and revert on error. */
 localId: string
 /** Snapshot for onError revert (network failure path only).
  *  For the invoked-race path, the server-validated row from the response is used instead. */
 snapshot: DecryptedMessage
}

/**
 * Mutation: cancel a single queued (uninvoked) message.
 *
 * Optimistic flow:
 *  1. Remove message from store immediately (floating bar clears).
 *  2. Fire DELETE /sessions/:id/messages/:messageId.
 *  3a. On success with status='cancelled': nothing to do (SSE `message-cancelled` confirms server side).
 *  3b. On success with status='invoked': the CLI beat us to it.
 *      Restore using the server-validated row (with authoritative invokedAt), NOT the stale
 *      client snapshot (invokedAt: null / status: queued). The `messages-consumed` SSE may
 *      have already arrived while the web row was optimistically removed (markMessagesConsumed
 *      no-op on missing row), so no later event will fix the stuck chip.
 *      appendOptimisticMessage with status='sent' shows the message in the thread correctly.
 *  3c. Resolved restores terminal history; unconfirmed restores the queued row.
 *      Neither outcome is invocation evidence or permission to prefill a retry.
 *  4. On error: re-insert the snapshot so the bar comes back; haptic error feedback.
 */
export function useCancelQueuedMessage(api: ApiClient | null) {
 const { haptic } = usePlatform()

 const mutation = useMutation({
  mutationFn: async (input: CancelQueuedMessageInput) => {
   if (!api) {
    throw new Error('API unavailable')
   }
   return api.cancelMessage(input.sessionId, input.messageId)
  },
  onMutate: (input) => {
   // Optimistic: remove from the floating bar immediately.
   removeOptimisticMessage(input.sessionId, input.localId)
   return { isCurrentScope: captureMessageWindowScope() }
  },
  onSuccess: (result, input, context) => {
   if (!context?.isCurrentScope()) return
   if (result.status === 'unconfirmed') {
    appendOptimisticMessage(input.sessionId, { ...result.message, status: 'queued' })
    return
   }
   if (result.status === 'invoked' || result.status === 'resolved') {
    // Cancellation can lose to execution OR local terminal admission.
    // Preserve the server evidence without inventing an invoked turn.
    appendOptimisticMessage(input.sessionId, {
     ...result.message,
     status: 'sent',
    })
   }
   // status === 'cancelled': optimistic removal stands — nothing extra to do.
  },
  onError: (_error, input, context) => {
   if (!context?.isCurrentScope()) return
   // Revert: put the message back so it re-appears in the bar.
   appendOptimisticMessage(input.sessionId, input.snapshot)
   haptic.notification('error')
  },
 })

 return mutation
}
