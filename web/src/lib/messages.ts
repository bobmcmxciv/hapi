import type { DecryptedMessage } from '@/types/api'
import { randomId } from '@/lib/randomId'

export function makeClientSideId(prefix: string): string {
 return `${prefix}-${randomId()}`
}

export function isUserMessage(msg: DecryptedMessage): boolean {
 const content = msg.content
 if (content && typeof content === 'object' && 'role' in content) {
  return (content as { role: string }).role === 'user'
 }
 return false
}

/** A user message that is still waiting for the CLI ack (messages-consumed).
 *  Strict null on `invokedAt` so a pre-V8 hub response that omits the field
 *  (`undefined`) is treated as already-invoked; only optimistic / V8-loaded
 *  rows that explicitly carry `invokedAt: null` are queued. `failed` rows are
 *  not queued either — they're surfaced as send errors, not pending work. */
export function isQueuedForInvocation(msg: DecryptedMessage): boolean {
 return isUserMessage(msg) && !msg.resolution && msg.invokedAt === null && msg.status !== 'failed'
}

/** True when the hub recorded a force-send request on this row
 *  (content.meta.forceSendRequestedAt). The row stays queued for invocation —
 *  dispatched ≠ consumed — but surfaces as "force requested, awaiting model"
 *  so the queue never looks like it lost the message. */
export function hasForceSendRequest(msg: DecryptedMessage): boolean {
 const content = msg.content
 if (typeof content !== 'object' || content === null || !('meta' in content)) return false
 const meta = content.meta
 if (typeof meta !== 'object' || meta === null || !('forceSendRequestedAt' in meta)) return false
 return typeof meta.forceSendRequestedAt === 'number'
}

function isOptimisticMessage(msg: DecryptedMessage): boolean {
 return Boolean(msg.localId && msg.id === msg.localId)
}

function compareMessages(a: DecryptedMessage, b: DecryptedMessage): number {
 const aAt = a.position?.at ?? a.invokedAt ?? a.createdAt
 const bAt = b.position?.at ?? b.invokedAt ?? b.createdAt
 if (aAt !== bAt) {
  return aAt - bAt
 }
 const aOrder = a.position?.order ?? 0
 const bOrder = b.position?.order ?? 0
 if (aOrder !== bOrder) {
  return aOrder - bOrder
 }
 const aEventOrder = a.position?.eventOrder ?? 0
 const bEventOrder = b.position?.eventOrder ?? 0
 if (aEventOrder !== bEventOrder) {
  return aEventOrder - bEventOrder
 }
 const aSeq = typeof a.seq === 'number' ? a.seq : null
 const bSeq = typeof b.seq === 'number' ? b.seq : null
 if (aSeq !== null && bSeq !== null && aSeq !== bSeq) {
  return aSeq - bSeq
 }
 return a.id.localeCompare(b.id)
}

export function mergeMessages(existing: DecryptedMessage[], incoming: DecryptedMessage[]): DecryptedMessage[] {
 if (existing.length === 0) {
  return [...incoming].sort(compareMessages)
 }
 if (incoming.length === 0) {
  return [...existing].sort(compareMessages)
 }

 const byId = new Map<string, DecryptedMessage>()
 for (const msg of existing) {
  byId.set(msg.id, msg)
 }
 for (const msg of incoming) {
  const prev = byId.get(msg.id)
  const resolution = prev?.resolution ?? msg.resolution
  const position = msg.position ?? prev?.position
  const withPosition = position ? { ...msg, position } : msg
  byId.set(msg.id, resolution
   ? { ...withPosition, resolution, invokedAt: null, status: 'sent' }
   : prev?.invokedAt != null && msg.invokedAt == null
    ? { ...withPosition, invokedAt: prev.invokedAt }
    : withPosition)
 }

 let merged = Array.from(byId.values())

 const incomingStoredLocalIds = new Set<string>()
 for (const msg of incoming) {
  if (msg.localId && !isOptimisticMessage(msg)) {
   incomingStoredLocalIds.add(msg.localId)
  }
 }

 // If we received stored messages with a localId, drop any optimistic bubbles with the same localId.
 // Preserve client-side status (e.g. 'queued') and invokedAt on the replacing server message.
 if (incomingStoredLocalIds.size > 0) {
  const optimisticStatusByLocalId = new Map<string, DecryptedMessage['status']>()
  const optimisticInvokedAtByLocalId = new Map<string, number | null | undefined>()
  const optimisticResolutionByLocalId = new Map<string, DecryptedMessage['resolution']>()
  const optimisticPositionByLocalId = new Map<string, DecryptedMessage['position']>()
  for (const msg of merged) {
   if (msg.localId && isOptimisticMessage(msg) && incomingStoredLocalIds.has(msg.localId)) {
    if (msg.status) {
     optimisticStatusByLocalId.set(msg.localId, msg.status)
    }
    if (msg.invokedAt !== undefined) {
     optimisticInvokedAtByLocalId.set(msg.localId, msg.invokedAt)
    }
    if (msg.resolution) optimisticResolutionByLocalId.set(msg.localId, msg.resolution)
    if (msg.position) optimisticPositionByLocalId.set(msg.localId, msg.position)
   }
  }
  merged = merged.filter((msg) => {
   if (!msg.localId || !incomingStoredLocalIds.has(msg.localId)) {
    return true
   }
   return !isOptimisticMessage(msg)
  })
  if (
   optimisticStatusByLocalId.size > 0
   || optimisticInvokedAtByLocalId.size > 0
   || optimisticResolutionByLocalId.size > 0
   || optimisticPositionByLocalId.size > 0
  ) {
   merged = merged.map((msg) => {
    if (!msg.localId) return msg
    const update: Partial<DecryptedMessage> = {}
    if (optimisticStatusByLocalId.has(msg.localId) && !msg.status) {
     update.status = optimisticStatusByLocalId.get(msg.localId)
    }
    if (optimisticInvokedAtByLocalId.has(msg.localId) && msg.invokedAt == null) {
     const optimisticInvokedAt = optimisticInvokedAtByLocalId.get(msg.localId)
     if (optimisticInvokedAt != null) {
      update.invokedAt = optimisticInvokedAt
     }
    }
    const position = msg.position ?? optimisticPositionByLocalId.get(msg.localId)
    if (position) {
     update.position = position
    }
    const resolution = msg.resolution ?? optimisticResolutionByLocalId.get(msg.localId)
    if (resolution) {
     update.resolution = resolution
     update.invokedAt = null
     update.status = 'sent'
    }
    if (Object.keys(update).length > 0) {
     return { ...msg, ...update }
    }
    return msg
   })
  }
 }

 // Time and text are not submission identities: another prompt can be echoed first.
 // Only the exact localId reconciliation above may replace an optimistic row.
 return merged.sort(compareMessages)
}
