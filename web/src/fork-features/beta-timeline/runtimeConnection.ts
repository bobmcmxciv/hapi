import { ApiError, type ApiClient } from '@/api/client'
import {
 RuntimePublicationSchema,
 type RuntimePublication
} from '@hapi/protocol/runtimeTimeline'

/**
 * Dedicated runtime event stream for the beta thread.
 *
 * Wire contract (hub `GET /api/sessions/:id/runtime/events`):
 * - default `message` events carry one JSON publication per frame
 *   (`{kind:'snapshot',snapshot}` / `{kind:'patch',patch}`) or
 *   `{kind:'unavailable'}` for sessions whose CLI predates the runtime feed;
 * - `event: runtime-source` frames carry `{"source":"connected"|"disconnected"}`
 *   describing the runner socket, not this stream;
 * - `:hb` comment heartbeats keep the connection alive (~15s cadence);
 * - `id:` fields are informational (`epoch:seq`) — a fresh connection always
 *   resends an authoritative snapshot, so they are ignored here.
 *
 * Ordering/integrity is enforced downstream by BetaTimelineStore (strict
 * epoch + adjacent seq). Any gap surfaced as a resync error triggers an
 * immediate reconnect so the hub's fresh snapshot re-seeds the store.
 */

export type RuntimeConnectionStatus = 'connecting' | 'live' | 'reconnecting' | 'legacy' | 'error'

export type RuntimeStreamEvent =
 | { type: 'publication'; publication: RuntimePublication }
 | { type: 'unavailable' }
 | { type: 'source'; source: 'connected' | 'disconnected' }
 | { type: 'malformed'; reason: string }

export interface RuntimeEventParser {
 push(chunk: string): RuntimeStreamEvent[]
 end(): RuntimeStreamEvent[]
}

/**
 * Incremental SSE decoder: feed decoded text, receive dispatched events.
 * Handles multi-line `data:`, `event:`, `id:`, `retry:` and comment lines.
 * Exported for direct unit testing of the frame grammar.
 */
export function createRuntimeEventParser(): RuntimeEventParser {
 let buffer = ''
 let dataLines: string[] = []
 let eventType = ''
 let hasFrame = false

 const dispatch = (): RuntimeStreamEvent[] => {
  const events: RuntimeStreamEvent[] = []
  const data = dataLines.join('\n')
  const type = eventType
  dataLines = []
  eventType = ''
  hasFrame = false
  if (!type && !data) return events

  const parseJson = (): unknown | null => {
   try {
    return JSON.parse(data)
   } catch {
    return null
   }
  }

  if (type === 'runtime-source') {
   const parsed = parseJson()
   const source = parsed && typeof parsed === 'object' && 'source' in parsed ? parsed.source : null
   if (source === 'connected' || source === 'disconnected') {
    events.push({ type: 'source', source })
   }
   return events
  }

  const parsed = parseJson()
  if (parsed && typeof parsed === 'object') {
   const kind = 'kind' in parsed ? parsed.kind : null
   if (kind === 'unavailable') {
    events.push({ type: 'unavailable' })
    return events
   }
   const validated = RuntimePublicationSchema.safeParse(parsed)
   if (validated.success) {
    events.push({ type: 'publication', publication: validated.data })
    return events
   }
   events.push({ type: 'malformed', reason: 'runtime publication failed schema validation' })
   return events
  }
  if (data) events.push({ type: 'malformed', reason: 'runtime frame was not JSON' })
  return events
 }

 const pushLine = (line: string, events: RuntimeStreamEvent[]): void => {
  if (line === '') {
   if (hasFrame) events.push(...dispatch())
   return
  }
  hasFrame = true
  if (line.startsWith(':')) return // heartbeat/comment
  const colon = line.indexOf(':')
  if (colon <= 0) {
   // Bare field name (e.g. `data`) — value is empty string.
   if (line === 'data') dataLines.push('')
   else if (line === 'event') eventType = ''
   return
  }
  const field = line.slice(0, colon)
  let value = line.slice(colon + 1)
  if (value.startsWith(' ')) value = value.slice(1)
  if (field === 'data') dataLines.push(value)
  else if (field === 'event') eventType = value
  // `id:` and `retry:` are intentionally ignored.
 }

 const feed = (chunk: string, flush: boolean): RuntimeStreamEvent[] => {
  const events: RuntimeStreamEvent[] = []
  buffer += chunk
  let start = 0
  for (let index = 0; index < buffer.length; index += 1) {
   const char = buffer[index]
   if (char !== '\n' && char !== '\r') continue
   if (char === '\r' && index === buffer.length - 1 && !flush) break
   if (char === '\r' && buffer[index + 1] === '\n') {
    pushLine(buffer.slice(start, index), events)
    index += 1
    start = index + 1
    continue
   }
   pushLine(buffer.slice(start, index), events)
   start = index + 1
  }
  buffer = buffer.slice(start)
  if (flush && (buffer !== '' || hasFrame)) {
   if (buffer !== '') pushLine(buffer, events)
   buffer = ''
   if (hasFrame) events.push(...dispatch())
  }
  return events
 }

 return {
  push: (chunk: string) => feed(chunk, false),
  end: () => feed('', true)
 }
}

/** Abort marker for the staleness watchdog vs an external stop(). */
class StreamStaleAbort extends Error {
 constructor() {
  super('runtime stream heartbeat stale')
  this.name = 'StreamStaleAbort'
 }
}

/** Internal: publication ordering broke — reconnect for an authoritative snapshot. */
class StreamResyncRequested extends Error {
 constructor(message: string) {
  super(message)
  this.name = 'StreamResyncRequested'
 }
}

const FIRST_CONNECT_STATUS: RuntimeConnectionStatus = 'connecting'
const STALE_AFTER_MS = 45_000
const STALE_CHECK_MS = 10_000
const RESYNC_DELAY_MS = 250
const BACKOFF_BASE_MS = 1_000
const BACKOFF_MAX_MS = 15_000
const BACKOFF_JITTER_MS = 250
/** After this many consecutive failures, poll slowly instead of giving up. */
const BACKOFF_SLOW_AFTER = 8
const BACKOFF_SLOW_MS = 60_000

export type RuntimeConnectionCallbacks = {
 /**
  * Apply a validated publication to the store. Throwing (e.g.
  * RuntimeTimelineResyncError for a seq gap) requests an authoritative
  * resync: the stream reconnects so the hub replays a fresh snapshot.
  */
 onPublication(publication: RuntimePublication): void
 /** Connection/banner state; `error` is a human-readable detail or null. */
 onStatus(status: RuntimeConnectionStatus, error?: string | null): void
 /** Runner socket liveness, for the "CLI disconnected" banner distinction. */
 onSource?(source: 'connected' | 'disconnected'): void
 /** The peer's runtime feed is unavailable (pre-upgrade CLI). */
 onUnavailable?(): void
 /** Access denied/expired token: drop live rows; history stays readable. */
 onRevoked?(status: number, message: string): void
}

export type RuntimeConnectionOptions = {
 /** Test hook: override the staleness budget (ms). */
 staleAfterMs?: number
 /** Test hook: deterministic backoff (ms) replacing jittered exponential. */
 scheduleRetry?: (consecutiveFailures: number) => number
}

function isAbortError(error: unknown): boolean {
 return (
  (error instanceof DOMException && error.name === 'AbortError')
  || (error instanceof Error && error.name === 'AbortError')
 )
}

export class BetaRuntimeConnection {
 #stopped = false
 #abort: AbortController | null = null
 #staleTimer: ReturnType<typeof setInterval> | null = null
 #retryTimer: ReturnType<typeof setTimeout> | null = null
 #lastActivity = 0
 #staleAbort = false
 #lastErrorMessage: string | null = null
 #task: Promise<void> | null = null
 #awaitingInitial = true
 #finishRetry: (() => void) | null = null

 constructor(
  private readonly api: ApiClient,
  private readonly sessionId: string,
  private readonly callbacks: RuntimeConnectionCallbacks,
  private readonly options: RuntimeConnectionOptions = {}
 ) { }

 start(): void {
  if (this.#task) return
  this.#task = this.#loop()
 }

 stop(): void {
  this.#stopped = true
  if (this.#retryTimer !== null) {
   clearTimeout(this.#retryTimer)
   this.#retryTimer = null
  }
  this.#finishRetry?.()
  this.#finishRetry = null
  this.#abortController(this.#abort, new DOMException('stopped', 'AbortError'))
  this.#task = null
 }

 /** Aborts `controller` if it is still the live one; clears the watchdog. */
 #abortController(controller: AbortController | null, reason: unknown): void {
  if (this.#staleTimer !== null) {
   clearInterval(this.#staleTimer)
   this.#staleTimer = null
  }
  if (!controller) return
  try {
   controller.abort(reason)
  } catch {
   controller.abort()
  }
  if (this.#abort === controller) this.#abort = null
 }

 #retryDelay(failures: number): number {
  if (this.options.scheduleRetry) return this.options.scheduleRetry(failures)
  if (failures > BACKOFF_SLOW_AFTER) return BACKOFF_SLOW_MS
  const base = Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1), BACKOFF_MAX_MS)
  return base + Math.floor(Math.random() * BACKOFF_JITTER_MS)
 }

 #sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  this.#finishRetry = resolve
  this.#retryTimer = setTimeout(() => {
   this.#retryTimer = null
   this.#finishRetry = null
   resolve()
  }, ms)
  return promise
 }

 #armWatchdog(controller: AbortController): void {
  this.#staleTimer = setInterval(() => {
   const staleAfter = this.options.staleAfterMs ?? STALE_AFTER_MS
   if (Date.now() - this.#lastActivity >= staleAfter) {
    this.#staleAbort = true
    this.#abortController(controller, new StreamStaleAbort())
   }
  }, STALE_CHECK_MS)
 }

 async #loop(): Promise<void> {
  let failures = 0
  let firstAttempt = true
  while (!this.#stopped) {
   this.callbacks.onStatus(
    firstAttempt ? FIRST_CONNECT_STATUS : 'reconnecting',
    failures === 0 ? null : this.#lastErrorMessage
   )
   const controller = new AbortController()
   this.#abort = controller
   this.#staleAbort = false
   this.#lastActivity = Date.now()
   let resync = false
   this.#awaitingInitial = true
   this.#armWatchdog(controller)
   try {
    const response = await this.api.openRuntimeEventsStream(this.sessionId, controller.signal)
    if (this.#stopped || controller.signal.aborted) {
     await response.body?.cancel().catch(() => { })
     if (this.#staleAbort) throw new StreamStaleAbort()
     return
    }
    const body = response.body
    if (!body) throw new Error('runtime stream has no body')
    const reader = body.getReader()
    const cancelReader = () => { void reader.cancel().catch(() => { }) }
    controller.signal.addEventListener('abort', cancelReader, { once: true })
    const decoder = new TextDecoder()
    const parser = createRuntimeEventParser()
    try {
     for (; ;) {
      const { done, value } = await reader.read()
      if (done) break
      this.#lastActivity = Date.now()
      const events = parser.push(decoder.decode(value, { stream: true }))
      this.#dispatch(events)
      if (events.some(event => event.type === 'publication' || event.type === 'unavailable')) failures = 0
     }
     const tail = parser.push(decoder.decode())
     this.#dispatch([...tail, ...parser.end()])
     // Clean EOF: hub closed the stream (grant revocation,
     // hub restart). Reconnect for an authoritative snapshot.
     if (this.#staleAbort) throw new StreamStaleAbort()
     this.#lastErrorMessage = 'Live timeline stream closed; reconnecting'
     failures += 1
    } finally {
     if (this.#staleTimer !== null) {
      clearInterval(this.#staleTimer)
      this.#staleTimer = null
     }
     controller.signal.removeEventListener('abort', cancelReader)
     await reader.cancel().catch(() => { })
     reader.releaseLock()
    }
   } catch (error) {
    if (this.#stopped) return
    if (error instanceof ApiError && (error.status === 401 || error.status === 403 || error.status === 404)) {
     this.callbacks.onStatus('error', error.message)
     this.callbacks.onRevoked?.(error.status, error.message)
     return
    }
    if (error instanceof StreamResyncRequested) {
     resync = true
     this.#lastErrorMessage = 'Resynchronizing live timeline'
    } else if (error instanceof StreamStaleAbort || this.#staleAbort) {
     failures += 1
     this.#lastErrorMessage = 'Live timeline stream stalled; reconnecting'
    } else if (!isAbortError(error)) {
     failures += 1
     this.#lastErrorMessage = error instanceof Error ? error.message : 'Live timeline connection failed'
    } else {
     // Controller aborted without the stale marker (e.g. hub
     // reset the socket): reconnect like a clean EOF.
     this.#lastErrorMessage = null
    }
   } finally {
    this.#abortController(controller, new DOMException('iteration end', 'AbortError'))
   }
   if (this.#stopped) return
   firstAttempt = false
   if (resync) failures = 0
   this.callbacks.onStatus('reconnecting', this.#lastErrorMessage)
   await this.#sleep(resync ? RESYNC_DELAY_MS : this.#retryDelay(failures))
  }
 }

 #dispatch(events: RuntimeStreamEvent[]): void {
  for (const event of events) {
   if (this.#stopped) return
   switch (event.type) {
    case 'publication':
     if (this.#awaitingInitial && event.publication.kind !== 'snapshot') throw new StreamResyncRequested('Stream must begin with an authoritative snapshot')
     this.#awaitingInitial = false
     try {
      this.callbacks.onPublication(event.publication)
     } catch (error) {
      throw new StreamResyncRequested(
       error instanceof Error ? error.message : 'runtime publication rejected'
      )
     }
     this.callbacks.onStatus('live', null)
     break
    case 'unavailable':
     this.#awaitingInitial = false
     // Older CLI: no runtime feed yet. Stay connected — an
     // upgraded/new producer may appear without reconnecting.
     this.callbacks.onStatus('legacy', null)
     this.callbacks.onUnavailable?.()
     break
    case 'source':
     this.callbacks.onSource?.(event.source)
     break
    case 'malformed':
     throw new StreamResyncRequested(event.reason)
   }
  }
 }
}
