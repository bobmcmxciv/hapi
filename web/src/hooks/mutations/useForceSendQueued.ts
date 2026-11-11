import { useCallback, useState } from 'react'
import type { ApiClient, ForceSendQueuedResult } from '@/api/client'
import { appendOptimisticMessage, getMessageWindowState, ingestIncomingMessages, updateMessageStatus } from '@/lib/message-window-store'
import { isQueuedForInvocation } from '@/lib/messages'
import { captureQueuedOutboxScope, getQueuedOutboxItems, getQueuedOutboxScope, markQueuedOutboxFailed, recordQueuedOutboxItem, removeQueuedOutboxItem, type QueuedOutboxItem } from '@/lib/queued-outbox'
import { normalizeDecryptedMessage } from '@/chat/normalize'
import { getRetryDeliveryMode } from '@/lib/messageDelivery'

export type ForceSendSummary = {
 uploadedLocalIds: string[]
 uploadFailures: Array<{ localId: string; error: string }>
 results: ForceSendQueuedResult[]
 forceError: string | null
}
const flights = new Set<string>()
function errorMessage(error: unknown) {
 return error instanceof Error ? error.message : String(error)
}
/** First upload submitted browser input in order, then force the Hub snapshot.
 * No composer access, run abort, invented invocation timestamp, or cancellation. */
export function useForceSendQueued(api: ApiClient | null, sessionId: string) {
 const [isForceSending, setIsForceSending] = useState(false)
 const uploadOutboxItem = useCallback(async (item: QueuedOutboxItem): Promise<string | null> => {
  if (!api) return 'API unavailable'
  const isCurrent = captureQueuedOutboxScope()
  try {
   await api.sendMessage(item.sessionId, item.text, item.localId, item.attachments, item.scheduledAt, undefined, getRetryDeliveryMode(item.deliveryMode))
   if (!isCurrent()) return 'Account changed'
   // Keep the receipt visible even if the POST ack beats the server echo.
   const exists = getMessageWindowState(item.sessionId).messages.some(message => message.localId === item.localId)
   if (!exists) appendOptimisticMessage(item.sessionId, {
    id: item.localId, localId: item.localId, seq: null, createdAt: item.createdAt,
    invokedAt: null, scheduledAt: item.scheduledAt, originalText: item.text, status: 'queued',
    content: { role: 'user', content: { type: 'text', text: item.text, attachments: item.attachments }, meta: { deliveryMode: item.deliveryMode } },
   })
   updateMessageStatus(item.sessionId, item.localId, 'queued')
   // Hub durable admission is not model consumption. Window row stays queued.
   removeQueuedOutboxItem(item.localId)
   return null
  } catch (error) {
   const message = errorMessage(error)
   if (isCurrent()) {
    try { markQueuedOutboxFailed(item.localId, message) } catch { /* Original durable payload remains. */ }
   }
   return message
  }
 }, [api])
 const forceSendAll = useCallback(async (options?: { includeScheduled?: boolean }): Promise<ForceSendSummary | null> => {
  const key = JSON.stringify([getQueuedOutboxScope(), sessionId])
  if (!api || !sessionId || flights.has(key)) return null
  flights.add(key)
  setIsForceSending(true)
  const isCurrent = captureQueuedOutboxScope()
  const summary: ForceSendSummary = { uploadedLocalIds: [], uploadFailures: [], results: [], forceError: null }
  try {
   // Migrate pre-outbox failed/optimistic input still held by the window.
   // Exact localId/payload is retained; never cancel/recreate these rows.
   const recorded = new Set(getQueuedOutboxItems(sessionId).map(item => item.localId))
   for (const message of getMessageWindowState(sessionId).messages) {
    if (!message.localId || recorded.has(message.localId) || message.invokedAt != null || message.resolution) continue
    if (message.id !== message.localId && message.status !== 'failed') continue
    const normalized = normalizeDecryptedMessage(message)
    if (!normalized || normalized.role !== 'user') continue
    const content = message.content
    const meta = content && typeof content === 'object' && 'meta' in content ? content.meta : null
    const deliveryMode = meta && typeof meta === 'object' && 'deliveryMode' in meta && meta.deliveryMode === 'steer' ? 'steer' : 'queue'
    try {
     recordQueuedOutboxItem({
      localId: message.localId, sessionId,
      text: normalized.content.text ?? '', attachments: normalized.content.attachments,
      scheduledAt: message.scheduledAt ?? null, deliveryMode, createdAt: message.createdAt
     })
    } catch (error) {
     summary.uploadFailures.push({ localId: message.localId, error: errorMessage(error) })
    }
   }
   for (const item of getQueuedOutboxItems(sessionId)) {
    if (!isCurrent()) return null
    const error = await uploadOutboxItem(item)
    if (error === null) summary.uploadedLocalIds.push(item.localId)
    else summary.uploadFailures.push({ localId: item.localId, error })
   }
   if (!isCurrent()) return null
   try {
    const response = await api.forceSendQueuedMessages(sessionId, { includeScheduled: options?.includeScheduled === true })
    if (!isCurrent()) return null
    if (!Array.isArray(response.results) || !Array.isArray(response.messages)) throw new Error('Invalid force-send response; queued input kept')
    // Only authoritative Hub rows supply forceSendRequestedAt, invokedAt,
    // resolution. A dispatch request is NEVER native consumption evidence.
    ingestIncomingMessages(sessionId, response.messages)
    summary.results = response.results
    for (const message of response.messages) {
     if (!message.localId) continue
     updateMessageStatus(sessionId, message.localId, message.invokedAt != null || message.resolution ? 'sent' : 'queued')
    }
   } catch (error) {
    summary.forceError = errorMessage(error)
   }
   return summary
  } finally {
   flights.delete(key)
   setIsForceSending(false)
  }
 }, [api, sessionId, uploadOutboxItem])
 const hasPendingWork = useCallback(() => getQueuedOutboxItems(sessionId).length > 0 || getMessageWindowState(sessionId).messages.some(isQueuedForInvocation), [sessionId])
 return { forceSendAll, uploadOutboxItem, isForceSending, hasPendingWork }
}
