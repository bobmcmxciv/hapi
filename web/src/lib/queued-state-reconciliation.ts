import type { ApiClient } from '@/api/client'
import type { DecryptedMessage } from '@/types/api'
import { getQueuedOutboxItems, removeQueuedOutboxItem } from './queued-outbox'
import {
    appendOptimisticMessage,
    getMessageWindowState,
    updateMessageStatus,
    getQueuedReconcileCandidateLocalIds,
    captureMessageWindowScope,
    markMessagesConsumed,
    markMessagesResolved,
    reconcileQueuedLocalIds,
    syncTailMessages,
} from './message-window-store'

const QUEUED_STATE_BATCH_SIZE = 1000

export async function reconcileQueuedStateAfterConnect(
    api: ApiClient,
    sessionId: string
): Promise<void> {
    const isCurrentScope = captureMessageWindowScope()
    await syncTailMessages(api, sessionId, { ensureAfterCurrent: true })
    if (!isCurrentScope()) return
    const candidateLocalIds = getQueuedReconcileCandidateLocalIds(sessionId)
    // Durable outbox items are verified too: a landed-but-not-echoed localId
    // closes its receipt here instead of surfacing a false "lost" row.
    const outboxLocalIds = getQueuedOutboxItems(sessionId).map((item) => item.localId)
    const queryLocalIds = [...new Set([...candidateLocalIds, ...outboxLocalIds])]
    if (queryLocalIds.length === 0) {
        return
    }
    const queuedLocalIds: string[] = []
    const invokedLocalMessages: Array<{
        localId: string
        invokedAt: number
        position?: DecryptedMessage['position']
    }> = []
    const resolvedLocalMessages: Array<{
        localId: string
        resolution: NonNullable<DecryptedMessage['resolution']>
        position?: DecryptedMessage['position']
    }> = []
    for (let index = 0; index < queryLocalIds.length; index += QUEUED_STATE_BATCH_SIZE) {
        const batch = queryLocalIds.slice(index, index + QUEUED_STATE_BATCH_SIZE)
        const state = await api.getQueuedState(sessionId, batch)
        if (!isCurrentScope()) return
        queuedLocalIds.push(...state.queuedLocalIds)
        invokedLocalMessages.push(...state.invokedLocalMessages)
        resolvedLocalMessages.push(...(state.resolvedLocalMessages ?? []))
    }
    markMessagesResolved(sessionId, resolvedLocalMessages)
    const invokedByTimestamp = new Map<number, {
        localIds: string[]
        positions: Array<{ localId: string; position: NonNullable<DecryptedMessage['position']> }>
    }>()
    for (const message of invokedLocalMessages) {
        const group = invokedByTimestamp.get(message.invokedAt) ?? { localIds: [], positions: [] }
        group.localIds.push(message.localId)
        if (message.position) {
            group.positions.push({ localId: message.localId, position: message.position })
        }
        invokedByTimestamp.set(message.invokedAt, group)
    }
    for (const [invokedAt, group] of invokedByTimestamp) {
        markMessagesConsumed(
            sessionId,
            group.localIds,
            invokedAt,
            group.positions.length > 0 ? group.positions : undefined
        )
    }
    reconcileQueuedLocalIds(sessionId, candidateLocalIds, queuedLocalIds)
    // Close durable outbox receipts for ids the hub acknowledges (queued,
    // invoked, or resolved rows all prove the payload landed). Web-only
    // records stay 'failed' and retryable — never dropped.
    const known = new Set([
        ...queuedLocalIds,
        ...invokedLocalMessages.map((m) => m.localId),
        ...resolvedLocalMessages.map((m) => m.localId),
    ])
    for (const item of getQueuedOutboxItems(sessionId)) {
        if (known.has(item.localId)) {
            if (queuedLocalIds.includes(item.localId)) updateMessageStatus(sessionId, item.localId, 'queued')
            // A queued id can be older than the fetched transcript tail. Keep
            // its payload visible before closing the browser upload receipt.
            if (!getMessageWindowState(sessionId).messages.some(message => message.localId === item.localId)) {
                const invoked = invokedLocalMessages.find(message => message.localId === item.localId)
                const resolved = resolvedLocalMessages.find(message => message.localId === item.localId)
                appendOptimisticMessage(sessionId, {
                    id: item.localId, localId: item.localId, seq: null, createdAt: item.createdAt,
                    invokedAt: invoked?.invokedAt ?? null, scheduledAt: item.scheduledAt,
                    status: invoked || resolved ? 'sent' : 'queued', originalText: item.text,
                    ...(resolved ? { resolution: resolved.resolution } : {}),
                    ...(invoked?.position || resolved?.position ? { position: invoked?.position ?? resolved?.position } : {}),
                    content: { role: 'user', content: { type: 'text', text: item.text, attachments: item.attachments }, meta: { deliveryMode: item.deliveryMode } },
                })
            }
            removeQueuedOutboxItem(item.localId)
        }
    }
}
