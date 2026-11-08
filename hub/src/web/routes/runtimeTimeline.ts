import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { RuntimeFrame, RuntimeTimelineRegistry } from '../../sync/runtimeTimeline'
import type { SyncEngine } from '../../sync/syncEngine'
import type { MultiUserGatewayStore } from '../../../../fork-features/multi-user/gatewayStore'
import { ExecutionDispatcher } from '../../../../fork-features/multi-user/executionDispatcher'
import { createSessionMachineResolver, createSessionPathResolver } from '../../../../fork-features/multi-user/machineInheritance'
import { validateGatewayCredential } from '../../../../fork-features/multi-user/executionMount'
import type { WebAppEnv } from '../middleware/auth'
import { requireSession } from './guards'

const HEARTBEAT_INTERVAL_MS = 15_000
const WRITE_TIMEOUT_MS = 15_000

/** Separate runtime transport: never broadcasts into legacy /api/events.
 * Reconnect always starts with an authoritative snapshot, not a patch replay.
 */
export function createRuntimeTimelineRoutes(
 getRegistry: () => RuntimeTimelineRegistry | null,
 getSyncEngine: () => SyncEngine | null,
 deps: { gatewayStore: MultiUserGatewayStore; jwtSecret: Uint8Array }
): Hono<WebAppEnv> {
 const app = new Hono<WebAppEnv>()
 const dispatcher = new ExecutionDispatcher(
  deps.gatewayStore,
  createSessionMachineResolver(getSyncEngine),
  createSessionPathResolver(getSyncEngine),
  (type, id) => (type === 'session' ? getSyncEngine()?.getSession(id) : getSyncEngine()?.getMachine(id))?.namespace ?? null
 )

 const canReadSession = async (request: Request, sessionId: string, namespace: string) => {
  // Shared gateway credential validation — must not drift from core auth:
  // jwtVerify (exp enforced) + live account + tid token-row revocation.
  const credential = await validateGatewayCredential(request, deps.gatewayStore, deps.jwtSecret)
  if (!credential.ok) return false
  const session = getSyncEngine()?.getSession(sessionId)
  if (!session || session.namespace !== namespace) return false
  const decision = dispatcher.authorize({ accountId: credential.accountId, capability: 'read', resource: { type: 'session', id: sessionId } })
  return decision.kind === 'allow' && decision.context.namespace === namespace
 }

 app.get('/sessions/:id/runtime', async c => {
  const registry = getRegistry()
  const engine = getSyncEngine()
  if (!registry || !engine) return c.json({ error: 'Not connected' }, 503)
  const access = requireSession(c, engine, c.req.param('id'))
  if (access instanceof Response) return access
  if (!(await canReadSession(c.req.raw, access.sessionId, access.session.namespace))) {
   return c.json({ error: 'Session access denied' }, 403)
  }
  const state = registry.snapshot(access.sessionId, access.session.namespace)
  return state?.snapshot
   ? c.json({ available: true, snapshot: state.snapshot, source: state.source })
   : c.json({ available: false, source: state?.source ?? 'none' })
 })

 app.get('/sessions/:id/runtime/events', async c => {
  const registry = getRegistry()
  const engine = getSyncEngine()
  if (!registry || !engine) return c.json({ error: 'Not connected' }, 503)
  const access = requireSession(c, engine, c.req.param('id'))
  if (access instanceof Response) return access
  const { sessionId, session } = access
  if (!(await canReadSession(c.req.raw, sessionId, session.namespace))) {
   return c.json({ error: 'Session access denied' }, 403)
  }
  // Register and capture the snapshot synchronously: no missing delta window.
  const subscription = registry.subscribe(sessionId, session.namespace)
  if (!subscription) return c.json({ error: 'Runtime subscription capacity reached' }, 503)

  return streamSSE(c, async stream => {
   let stopped = false
   let heartbeatTimer: Timer | undefined
   let writeTimer: Timer | undefined
   const stop = () => {
    stopped = true
    subscription.close()
    stream.abort()
   }
   c.req.raw.signal.addEventListener('abort', stop, { once: true })
   stream.onAbort(stop)
   if (c.req.raw.signal.aborted) stop()
   const send = async (frame: RuntimeFrame | { kind: 'unavailable' }) => {
    // Recheck account, grants, path, namespace and token expiry for
    // EVERY write, including initial snapshots and source frames.
    if (stopped || !(await canReadSession(c.req.raw, sessionId, session.namespace))) return false
    const { promise: timeout, resolve } = Promise.withResolvers<'timeout'>()
    writeTimer = setTimeout(() => resolve('timeout'), WRITE_TIMEOUT_MS)
    const id = frame.kind === 'snapshot' ? `${encodeURIComponent(frame.snapshot.epoch)}:${frame.snapshot.seq}`
     : frame.kind === 'patch' ? `${encodeURIComponent(frame.patch.epoch)}:${frame.patch.seq}` : undefined
    const result = await Promise.race([
     stream.writeSSE({ data: JSON.stringify(frame), event: frame.kind === 'runtime-source' ? 'runtime-source' : undefined, id }).then(() => 'written' as const),
     timeout
    ])
    clearTimeout(writeTimer)
    writeTimer = undefined
    return result === 'written'
   }
   try {
    if (!(await send(subscription.initial))) return
    if (subscription.source !== 'none' && !(await send({ kind: 'runtime-source', source: subscription.source }))) return
    while (!stopped) {
     // Drain queued publications before waiting; a patch may have
     // arrived while the preceding asynchronous write was pending.
     const frame = subscription.pending.shift()
     if (frame) {
      if (!(await send(frame))) break
      continue
     }
     const { promise: heartbeat, resolve } = Promise.withResolvers<'heartbeat'>()
     heartbeatTimer = setTimeout(() => resolve('heartbeat'), HEARTBEAT_INTERVAL_MS)
     const woke = await Promise.race([subscription.wait(), heartbeat])
     clearTimeout(heartbeatTimer)
     heartbeatTimer = undefined
     if (woke === null) break
     if (woke === 'heartbeat') {
      if (!(await canReadSession(c.req.raw, sessionId, session.namespace))) break
      // Comments do not enter the RuntimePublication parser.
      const { promise: timeout, resolve: expire } = Promise.withResolvers<'timeout'>()
      writeTimer = setTimeout(() => expire('timeout'), WRITE_TIMEOUT_MS)
      const result = await Promise.race([stream.write(':hb\n\n').then(() => 'written' as const), timeout])
      clearTimeout(writeTimer)
      writeTimer = undefined
      if (result !== 'written') break
     }
    }
   } catch {
    // Disconnect/write failure ends this stream; reconnect gets a snapshot.
   } finally {
    clearTimeout(heartbeatTimer)
    clearTimeout(writeTimer)
    c.req.raw.signal.removeEventListener('abort', stop)
    stop()
   }
  })
 })
 return app
}
