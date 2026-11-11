import type { SyncEvent } from '@/types/api'
import {
 clearMessageWindow,
 ingestIncomingMessages,
 markMessagesConsumed,
 markMessagesResolved,
 removeOptimisticMessage
} from '@/lib/message-window-store'

export type FeederScope = 'global' | 'full'

/**
 * The message-stream subset of the sync protocol. On the global `all`
 * subscription these events arrive alongside session/machine events but must
 * not drive the message window — the session-scoped connection owns that.
 * They still get their consumed/cancelled side effects so the queued bar and
 * optimistic rows are cleaned up during session-SSE gaps.
 */
export const MESSAGE_STREAM_EVENT_TYPES = {
 'message-received': true,
 'messages-consumed': true,
 'messages-resolved': true,
 'message-cancelled': true,
 'scheduled-matured': true
} as const satisfies Partial<Record<SyncEvent['type'], true>>

/**
 * True when this event is part of the message stream on the global
 * connection — i.e. the caller should treat it as fully handled by the
 * feeder and not fall through to cache-projection consumers beyond what the
 * projector itself sees.
 */
export function isGlobalScopedMessageStreamEvent(scope: FeederScope, eventType: SyncEvent['type']): boolean {
 return scope === 'global' && eventType in MESSAGE_STREAM_EVENT_TYPES
}

/**
 * Write boundary between the sync event stream and the message-window store.
 * Pure feeding only — no React Query work, no network. Which connection feeds
 * which events is driven by `scope`:
 *
 * - `full` (session-scoped): every message-stream event mutates the window.
 * - `global` (all): only the optimistic/queued-state side effects run, so a
 *   reconnect gap on the session connection cannot pin a consumed message or
 *   a cancelled optimistic row on screen. `message-received` ingestion is
 *   deliberately skipped — duplicating server-authoritative rows into the
 *   window from two connections would corrupt ordering.
 *
 * `session-removed` clears the whole window on any scope (the session no
 * longer exists). `session-ended` deliberately does NOT: end ≠ removal — held
 * history, queued optimistic prompts and pending messages all survive a CLI
 * exit, matching hub semantics (immediate non-OMP rows are swept via
 * `messages-consumed` before `session-ended`; OMP and cleared-session rows
 * are preserved for re-attach).
 */
export class MessageStoreFeeder {
 readonly #scope: FeederScope

 constructor(options: { scope: FeederScope }) {
  this.#scope = options.scope
 }

 feed(event: SyncEvent): void {
  switch (event.type) {
   case 'messages-consumed':
    markMessagesConsumed(event.sessionId, event.localIds, event.invokedAt, event.positions)
    break
   case 'messages-resolved':
    markMessagesResolved(event.sessionId, event.resolutions)
    break
   case 'message-cancelled':
    // Remove the cancelled message from the store. If the local
    // optimistic removal already cleared it, this is a no-op.
    removeOptimisticMessage(event.sessionId, event.messageId)
    break
   case 'message-received':
    if (this.#scope !== 'global') {
     ingestIncomingMessages(event.sessionId, [event.message])
    }
    break
   case 'session-removed':
    clearMessageWindow(event.sessionId)
    break
   case 'session-ended':
    // End is a lifecycle terminal marker, not history removal.
    // Do not clear the window: held messages and pending queued
    // rows remain (re-attach / re-open may consume them later).
    break
   default:
    break
  }
 }
}
