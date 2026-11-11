import { isObject } from '@hapi/protocol'
import type { SyncEvent } from '@/types/api'

export type SseVisibility = 'visible' | 'hidden'

export type SseSubscription = {
 all?: boolean
 sessionId?: string
 machineId?: string
}

/**
 * Verdict the server attaches to the `connection-changed` handshake frame.
 * `resumed` is true when the hub replayed everything missed since the last
 * connection, so the caller can skip its full REST resync.
 */
export type SseHandshake = {
 subscriptionId: string | null
 resumed: boolean
}

export type SseTransportCallbacks = {
 /**
  * Receives every parsed sync event in wire order, heartbeats included.
  * Throwing here is treated like the old handler-crash path: the replay
  * cursor is NOT advanced, so the hub replays the event after reconnect.
  */
 onEvent: (event: SyncEvent) => void
 /**
  * Fires on the server `connection-changed` handshake, before `onEvent`
  * for the same frame. `resumed === true` means the gap was replayed.
  */
 onHandshake?: (info: SseHandshake) => void
 /** Fires once per dead attempt, before reconnect scheduling. */
 onDisconnect?: (reason: string) => void
 /** Fires on EventSource errors that are about to kill the attempt. */
 onError?: (error: unknown) => void
 /**
  * Fires when `onEvent`/`onHandshake` throws — the frame is reported and
  * the cursor stays behind it so the hub replays it (at-least-once).
  */
 onEventDispatchError?: (error: unknown, eventType: string) => void
}

export type SseEventSourceLike = {
 readonly readyState: number
 onmessage: ((event: MessageEvent<string>) => void) | null
 onopen: ((event: Event) => void) | null
 onerror: ((event: Event) => void) | null
 close(): void
}

export type SseTransportDeps = {
 createEventSource: (url: string) => SseEventSourceLike
 getVisibility: () => SseVisibility
 addVisibilityListener: (listener: () => void) => () => void
 now: () => number
 random: () => number
}

export type SseTransportOptions = {
 baseUrl: string
 token: string
 subscription: SseSubscription
 callbacks: SseTransportCallbacks
 deps?: Partial<SseTransportDeps>
}

export const SSE_CONNECT_TIMEOUT_MS = 10_000
export const SSE_FOREGROUND_RESUME_STALE_MS = 45_000
export const SSE_HEARTBEAT_STALE_MS = 90_000
export const SSE_HEARTBEAT_WATCHDOG_INTERVAL_MS = 10_000
export const SSE_RECONNECT_BASE_DELAY_MS = 1_000
export const SSE_RECONNECT_MAX_DELAY_MS = 30_000
export const SSE_RECONNECT_JITTER_MS = 500
// A hub that stays unreachable is usually offline for hours, not seconds.
// Retrying every 30s forever costs a full TLS handshake per attempt through
// the relay, so widen the ceiling once the fast retries have clearly failed.
export const SSE_RECONNECT_SLOW_AFTER_ATTEMPTS = 8
export const SSE_RECONNECT_SLOW_MAX_DELAY_MS = 300_000

export function buildSyncEventsUrl(
 baseUrl: string,
 token: string,
 subscription: SseSubscription,
 visibility: SseVisibility,
 lastEventId: string | null
): string {
 const params = new URLSearchParams()
 params.set('token', token)
 params.set('visibility', visibility)
 if (subscription.all) {
  params.set('all', 'true')
 }
 if (subscription.sessionId) {
  params.set('sessionId', subscription.sessionId)
 }
 if (subscription.machineId) {
  params.set('machineId', subscription.machineId)
 }
 if (lastEventId) {
  params.set('lastEventId', lastEventId)
 }

 const path = `/api/events?${params.toString()}`
 try {
  return new URL(path, baseUrl).toString()
 } catch {
  return path
 }
}

function defaultVisibility(): SseVisibility {
 if (typeof document === 'undefined') {
  return 'hidden'
 }
 return document.visibilityState === 'visible' ? 'visible' : 'hidden'
}

const defaultDeps: SseTransportDeps = {
 createEventSource: (url) => new EventSource(url),
 getVisibility: defaultVisibility,
 addVisibilityListener: (listener) => {
  if (typeof document === 'undefined') {
   return () => { }
  }
  document.addEventListener('visibilitychange', listener)
  return () => document.removeEventListener('visibilitychange', listener)
 },
 now: () => Date.now(),
 random: () => Math.random()
}
// DOM spec readyState values — referenced literally because jsdom provides no
// EventSource implementation (and therefore no OPEN/CLOSED statics).
const READY_STATE_OPEN = 1
const READY_STATE_CLOSED = 2

function readHandshake(event: SyncEvent): SseHandshake | null {
 if (event.type !== 'connection-changed') {
  return null
 }
 const data = event.data
 const subscriptionId = data && typeof data.subscriptionId === 'string' && data.subscriptionId.length > 0
  ? data.subscriptionId
  : null
 // Older hubs omit `resume`, which safely reads as a full resync.
 return { subscriptionId, resumed: data?.resume === 'ok' }
}

/**
 * EventSource lifecycle owner for one subscription: connect, handshake,
 * heartbeat watchdog, connect timeout, hidden-tab-aware backoff and the
 * Last-Event-ID replay cursor. Contains no cache/store knowledge — every
 * parsed event is handed to `callbacks.onEvent` and only after that call
 * returns successfully is the replay cursor committed (at-least-once
 * semantics: a failed handler leaves the cursor behind so the hub replays).
 *
 * One transport per enabled subscription lifetime. Reconnects reuse the same
 * transport (and its committed cursor); configuration changes belong to the
 * caller disposing and recreating the transport.
 */
export class SseTransport {
 readonly #options: SseTransportOptions
 readonly #callbacks: SseTransportCallbacks
 readonly #deps: SseTransportDeps

 #disposed = false
 #eventSource: SseEventSourceLike | null = null
 /** Last event id committed after a successfully handled frame. */
 #cursor: string | null = null
 #lastActivityAt = 0
 /** Dead-attempt latch: one disconnect notification per connection attempt. */
 #attemptClosed = false
 #attempt = 0
 #reconnectTimer: ReturnType<typeof setTimeout> | null = null
 #connectTimeoutTimer: ReturnType<typeof setTimeout> | null = null
 #watchdogTimer: ReturnType<typeof setInterval> | null = null
 /** A retry fell due while hidden; run it the moment the tab is visible. */
 #reconnectDeferred = false
 #removeVisibilityListener: (() => void) | null = null

 constructor(options: SseTransportOptions) {
  this.#options = options
  this.#callbacks = options.callbacks
  this.#deps = { ...defaultDeps, ...options.deps }
 }

 /** The replay cursor this transport will resume from. Test/introspection hook. */
 get lastEventCursor(): string | null {
  return this.#cursor
 }

 get isConnected(): boolean {
  return this.#eventSource !== null && !this.#attemptClosed
 }

 start(): void {
  if (this.#disposed) {
   return
  }
  this.#removeVisibilityListener = this.#deps.addVisibilityListener(() => this.#onVisibilityChange())
  this.#connect()
 }

 dispose(): void {
  this.#disposed = true
  this.#removeVisibilityListener?.()
  this.#removeVisibilityListener = null
  this.#clearConnectTimeout()
  this.#clearWatchdog()
  this.#clearReconnectTimer()
  this.#closeSource()
 }

 #connect(): void {
  if (this.#disposed) {
   return
  }
  this.#attemptClosed = false
  const url = buildSyncEventsUrl(
   this.#options.baseUrl,
   this.#options.token,
   this.#options.subscription,
   this.#deps.getVisibility(),
   this.#cursor
  )
  const eventSource = this.#deps.createEventSource(url)
  this.#eventSource = eventSource
  this.#lastActivityAt = this.#deps.now()

  this.#connectTimeoutTimer = setTimeout(() => {
   this.#connectTimeoutTimer = null
   if (this.#eventSource === eventSource && eventSource.readyState !== READY_STATE_OPEN) {
    this.#fail('connect-timeout')
   }
  }, SSE_CONNECT_TIMEOUT_MS)

  eventSource.onmessage = (message) => this.#onFrame(message)
  eventSource.onopen = () => {
   if (this.#disposed || this.#attemptClosed) {
    return
   }
   this.#clearConnectTimeout()
   this.#clearReconnectTimer()
   this.#attempt = 0
   this.#reconnectDeferred = false
   this.#lastActivityAt = this.#deps.now()
   // The handshake frame — not this event — carries the resume verdict.
  }
  eventSource.onerror = (error) => {
   if (this.#disposed || this.#attemptClosed) {
    return
   }
   this.#callbacks.onError?.(error)
   if (eventSource.readyState === READY_STATE_CLOSED) {
    this.#fail('closed')
    return
   }
   // CONNECTING means the browser would keep retrying natively — at
   // its own few-second interval, with the original (stale) URL, and
   // regardless of tab visibility. Take the source down and route the
   // retry through our scheduler so hidden-tab deferral and the slow
   // backoff actually govern every reconnect path.
   this.#fail('transport-error')
  }
  this.#watchdogTimer = setInterval(() => {
   if (this.#eventSource !== eventSource) {
    return
   }
   if (this.#deps.getVisibility() === 'hidden') {
    return
   }
   if (this.#deps.now() - this.#lastActivityAt < SSE_HEARTBEAT_STALE_MS) {
    return
   }
   this.#fail('heartbeat-timeout')
  }, SSE_HEARTBEAT_WATCHDOG_INTERVAL_MS)
 }

 #onFrame(message: MessageEvent<string>): void {
  if (this.#disposed || this.#attemptClosed) {
   return
  }
  if (typeof message.data !== 'string') {
   return
  }
  let parsed: unknown
  try {
   parsed = JSON.parse(message.data)
  } catch {
   return
  }
  if (!isObject(parsed) || typeof parsed.type !== 'string') {
   return
  }

  this.#lastActivityAt = this.#deps.now()
  const event = parsed as SyncEvent
  const handshake = readHandshake(event)

  // 事件处理链会写 store 与 queryClient——一条意外结构的服务端事件
  // 不能变成未捕获异常炸掉整个页面，收拢后上报再继续消费后续事件。
  // 但**失败时不推进重放游标**：上游 0.27 的 at-least-once 依赖
  // "handler 抛错→游标停在事件之前→重连重放"，吞掉异常后这条链断了，
  // 这里用提前 return 复刻同一语义——页面活着，事件也不丢。
  try {
   if (handshake) {
    this.#callbacks.onHandshake?.(handshake)
   }
   this.#callbacks.onEvent(event)
  } catch (error) {
   this.#callbacks.onEventDispatchError?.(error, event.type)
   return
  }

  // Track the hub's replay cursor — after handling, so a failed handler
  // leaves the cursor behind the event and the hub replays it on the
  // next reconnect (at-least-once). EventSource keeps lastEventId
  // sticky across frames, so heartbeats (no id field) simply repeat
  // the previous cursor.
  if (message.lastEventId) {
   this.#cursor = message.lastEventId
  }
 }

 #fail(reason: string): void {
  if (this.#disposed || this.#attemptClosed) {
   return
  }
  this.#attemptClosed = true
  this.#clearConnectTimeout()
  this.#clearWatchdog()
  this.#callbacks.onDisconnect?.(reason)
  this.#closeSource()
  this.#scheduleReconnect()
 }

 #scheduleReconnect(): void {
  // Nobody is looking at a hidden tab, and every retry through the
  // relay costs a TLS handshake. Defer until the tab is visible again;
  // onVisibilityChange reconnects immediately at that point.
  if (this.#deps.getVisibility() === 'hidden') {
   this.#reconnectDeferred = true
   this.#clearReconnectTimer()
   return
  }

  const attempt = this.#attempt
  const maxDelay = attempt >= SSE_RECONNECT_SLOW_AFTER_ATTEMPTS
   ? SSE_RECONNECT_SLOW_MAX_DELAY_MS
   : SSE_RECONNECT_MAX_DELAY_MS
  const exponentialDelay = Math.min(maxDelay, SSE_RECONNECT_BASE_DELAY_MS * (2 ** attempt))
  const jitter = Math.floor(this.#deps.random() * (SSE_RECONNECT_JITTER_MS + 1))
  this.#attempt = attempt + 1
  this.#clearReconnectTimer()
  this.#reconnectTimer = setTimeout(() => {
   if (this.#disposed) {
    return
   }
   this.#reconnectTimer = null
   this.#connect()
  }, exponentialDelay + jitter)
 }

 #onVisibilityChange(): void {
  if (this.#deps.getVisibility() !== 'visible') {
   return
  }
  // A retry fell due while the tab was hidden and was deliberately not
  // scheduled. Run it now, before the identity guard below: #fail has
  // already cleared #eventSource.
  if (this.#reconnectDeferred) {
   this.#reconnectDeferred = false
   this.#connect()
   return
  }
  if (this.#eventSource === null || this.#attemptClosed) {
   return
  }
  // The watchdog skips checks for hidden tabs, so a connection that went
  // stale in the background is probed immediately when the tab returns
  // instead of waiting out the interval.
  if (this.#deps.now() - this.#lastActivityAt >= SSE_FOREGROUND_RESUME_STALE_MS) {
   this.#fail('visibility-recovery')
  }
 }

 #closeSource(): void {
  const source = this.#eventSource
  this.#eventSource = null
  source?.close()
 }

 #clearConnectTimeout(): void {
  if (this.#connectTimeoutTimer !== null) {
   clearTimeout(this.#connectTimeoutTimer)
   this.#connectTimeoutTimer = null
  }
 }

 #clearWatchdog(): void {
  if (this.#watchdogTimer !== null) {
   clearInterval(this.#watchdogTimer)
   this.#watchdogTimer = null
  }
 }

 #clearReconnectTimer(): void {
  if (this.#reconnectTimer !== null) {
   clearTimeout(this.#reconnectTimer)
   this.#reconnectTimer = null
  }
 }
}
