import { useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { SyncEvent } from '@/types/api'
import { reportCrash } from '@/lib/crashGuard'
import {
 SseTransport,
 type SseHandshake,
 type SseSubscription
} from '@/lib/sse-transport'
import { MessageStoreFeeder } from '@/lib/message-store-feeder'
import { QueryCacheProjector } from '@/lib/query-cache-projector'
import { captureMessageWindowScope } from '@/lib/message-window-store'

type ToastEvent = Extract<SyncEvent, { type: 'toast' }>
export type SSEScope = 'global' | 'full'
/**
 * React composition layer for a single sync subscription. The work is split
 * across three non-React owners, created once per enabled-subscription
 * lifetime:
 *
 * - `SseTransport` — EventSource lifecycle: connect timeout, heartbeat
 *   watchdog, hidden-tab deferred backoff, and the Last-Event-ID replay
 *   cursor, which is committed only after the dispatch chain below returns
 *   successfully (at-least-once).
 * - `QueryCacheProjector` — every React Query cache write: session/machine
 *   upserts, versioned patch folds, batched invalidations, and the
 *   session-ended authoritative revalidation.
 * - `MessageStoreFeeder` — every message-window-store write: ingestion,
 *   consume/cancel side effects and window clearing on removal.
 *
 * Disabling the hook or changing the subscription disposes all three; the
 * replay cursor dies with the transport so a different subscription or
 * account can never replay against a stale cursor (auth boundary).
 */
export function useSSE(options: {
 enabled: boolean
 token: string
 baseUrl: string
 subscription?: SseSubscription
 scope?: SSEScope
 onEvent: (event: SyncEvent) => void
 /**
  * Fires on the server's connection-changed handshake. `resumed` is true
  * when the hub replayed everything missed since the last connection, so
  * the caller can skip its full REST resync.
  */
 onConnect?: (info: { resumed: boolean }) => void
 onDisconnect?: (reason: string) => void
 onError?: (error: unknown) => void
 onToast?: (event: ToastEvent) => void
}): { subscriptionId: string | null } {
 const queryClient = useQueryClient()
 const onEventRef = useRef(options.onEvent)
 const onConnectRef = useRef(options.onConnect)
 const onDisconnectRef = useRef(options.onDisconnect)
 const onErrorRef = useRef(options.onError)
 const onToastRef = useRef(options.onToast)
 const [subscriptionId, setSubscriptionId] = useState<string | null>(null)

 useEffect(() => {
  onEventRef.current = options.onEvent
 }, [options.onEvent])

 useEffect(() => {
  onErrorRef.current = options.onError
 }, [options.onError])

 useEffect(() => {
  onConnectRef.current = options.onConnect
 }, [options.onConnect])

 useEffect(() => {
  onDisconnectRef.current = options.onDisconnect
 }, [options.onDisconnect])

 useEffect(() => {
  onToastRef.current = options.onToast
 }, [options.onToast])

 const subscription = options.subscription ?? {}
 const scope = options.scope ?? 'full'

 const subscriptionKey = useMemo(() => {
  return `${scope}|${subscription.all ? '1' : '0'}|${subscription.sessionId ?? ''}|${subscription.machineId ?? ''}`
 }, [scope, subscription.all, subscription.sessionId, subscription.machineId])

 useEffect(() => {
  if (!options.enabled) {
   setSubscriptionId(null)
   return
  }

  setSubscriptionId(null)

  const feeder = new MessageStoreFeeder({ scope })
  const projector = new QueryCacheProjector({ queryClient, scope })
  const isCurrentScope = captureMessageWindowScope()

  const handleSyncEvent = (event: SyncEvent) => {
   if (!isCurrentScope()) return
   if (subscription.sessionId && 'sessionId' in event && event.sessionId !== subscription.sessionId) return
   if (event.type === 'heartbeat') {
    // Activity is already tracked by the transport (watchdog / staleness);
    // heartbeats carry no projectable state.
    return
   }

   if (event.type === 'toast') {
    onToastRef.current?.(event)
    return
   }

   // Window feeding first, then cache projection — identical to the
   // old inline ordering (consumption marks land before summary
   // patches sort the list).
   feeder.feed(event)
   projector.project(event)

   onEventRef.current(event)
  }

  const handleHandshake = (info: SseHandshake) => {
   if (info.subscriptionId) {
    setSubscriptionId(info.subscriptionId)
   }
   // The connect callback fires on the handshake, not EventSource
   // open: only the server knows whether the gap was replayed
   // (`resume: 'ok'`) or the caller must resync. Older hubs omit the
   // field, which safely reads as a full resync.
   onConnectRef.current?.({ resumed: info.resumed })
  }

  const transport = new SseTransport({
   baseUrl: options.baseUrl,
   token: options.token,
   subscription,
   callbacks: {
    onEvent: handleSyncEvent,
    onHandshake: handleHandshake,
    onDisconnect: (reason) => {
     setSubscriptionId(null)
     onDisconnectRef.current?.(reason)
    },
    onError: (error) => onErrorRef.current?.(error),
    onEventDispatchError: (error, eventType) => {
     console.error('[SSE] event handler failed', eventType, error)
     reportCrash(error, 'sse')
    }
   }
  })
  transport.start()

  return () => {
   transport.dispose()
   projector.dispose()
   setSubscriptionId(null)
  }
 }, [options.baseUrl, options.enabled, options.token, scope, subscriptionKey, queryClient])

 return { subscriptionId }
}
