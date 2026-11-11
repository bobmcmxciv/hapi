import { SessionRuntimePayloadSchema } from '@hapi/protocol'
import type { SessionRuntimeAck } from '@hapi/protocol'
import type { Store, StoredSession } from '../../../store'
import type { RuntimeTimelineRegistry } from '../../../sync/runtimeTimeline'
import type { CliSocketWithData } from '../../socketTypes'
import type { AccessErrorReason, AccessResult } from './types'

type ResolveSessionAccess = (sessionId: string) => AccessResult<StoredSession>
type EmitAccessError = (scope: 'session' | 'machine', id: string, reason: AccessErrorReason) => void

export type RuntimeHandlersDeps = {
 store: Store
 registry: RuntimeTimelineRegistry
 resolveSessionAccess: ResolveSessionAccess
 emitAccessError: EmitAccessError
 /**
  * Server-bound authorization for runtime publications. Built once in
  * registerCliHandlers from the authenticated socket principal:
  * - runner/master CLI token (socket.data.cliTrusted): always allowed —
  *   the trusted runner credential intentionally publishes for its sessions;
  * - gateway API token (socket.data.gatewayAccountId + gatewayTokenId):
  *   the session must be operate-level accessible to that account AND the
  *   token row must still exist, be unrevoked, and belong to that account
  *   — rechecked per publication so revocation/disabling takes effect live.
  * When the dep is absent (tests / non-multi-user wiring) publications are
  * denied unless the socket is cliTrusted.
  */
 authorizeSessionPublication?: (sessionId: string) => boolean
 isCurrentSessionSource?: (sessionId: string) => boolean
}

/**
 * Dedicated handler for the live runtime timeline channel (HAPI beta).
 *
 * Publishing rules beyond the shared registry logic:
 * - Payload is schema-validated (`SessionRuntimePayloadSchema`) before any
 *   state changes — raw socket input is never trusted.
 * - The packet's `sid` must equal `handshake.auth.sessionId` AND pass the
 *   server-bound operate check. The client-chosen handshake field alone is
 *   NOT an authorization boundary: gateway tokens additionally require
 *   dispatcher 'operate' on that sid plus a live, unrevoked token row; only
 *   the trusted runner token skips account-level checks.
 * - `resolveSessionAccess` re-validates the session against the socket's
 *   namespace on every publication (existence + namespace guard).
 * - Ack contract (`SessionRuntimeAck`): 'ok' applied or safely ignored
 *   duplicate, 'resync' asks the CLI to replay the authoritative snapshot,
 *   'error' rejects invalid/unauthorized input.
 * - When the CLI doesn't pass an ack callback the registry's resync decision is
 *   delivered via the 'session-runtime:resync' server event instead.
 *
 * Lifecycle:
 * - `session-end` marks the session ended but retains final rows for readers.
 * - `disconnect` marks the source disconnected; it deliberately does NOT
 *   finalize the run — socket loss is not agent termination.
 */
export function registerRuntimeHandlers(socket: CliSocketWithData, deps: RuntimeHandlersDeps): void {
 const { registry, resolveSessionAccess, emitAccessError, authorizeSessionPublication } = deps

 const auth = socket.handshake.auth as Record<string, unknown> | undefined
 const authenticatedSessionId = typeof auth?.sessionId === 'string' ? auth.sessionId : null
 // Connection order is captured before publications arrive. An older socket
 // cannot reclaim authority after a newer connection replaces its snapshot.
 const sourceRegistered = authenticatedSessionId !== null && registry.connectSource(socket.id)

 socket.on('session-runtime', (data: unknown, ack?: (result: SessionRuntimeAck) => void) => {
  const respond = (result: SessionRuntimeAck) => {
   if (ack) {
    ack(result)
   } else if (result.result === 'resync' && authenticatedSessionId) {
    // No ack callback (older producer): deliver the resync request
    // through the explicit server event so the CLI still replays
    // its authoritative snapshot.
    socket.emit('session-runtime:resync', { sid: authenticatedSessionId })
   }
  }
  const deny = (sid: string, reason: AccessErrorReason) => {
   emitAccessError('session', sid, reason)
   respond({ result: 'error' })
  }

  const parsed = SessionRuntimePayloadSchema.safeParse(data)
  if (!parsed.success) {
   respond({ result: 'error' })
   return
  }
  const { sid, publication } = parsed.data

  if (!sourceRegistered || !authenticatedSessionId || authenticatedSessionId !== sid) {
   deny(sid, 'access-denied')
   return
  }

  const sessionAccess = resolveSessionAccess(sid)
  if (!sessionAccess.ok) {
   deny(sid, sessionAccess.reason)
   return
  }

  // operate-level authorization: the handshake sessionId is user input;
  // the authenticated principal must independently be allowed to drive
  // this session's runtime feed.
  if (!(authorizeSessionPublication?.(sid) ?? false) || !(deps.isCurrentSessionSource?.(sid) ?? false)) {
   deny(sid, 'access-denied')
   return
  }

  const outcome = registry.publish(sid, sessionAccess.value.namespace, socket.id, publication)
  if (outcome.result === 'ok') {
   respond({ result: 'ok' })
  } else if (outcome.result === 'resync') {
   respond({ result: 'resync' })
  } else {
   if (outcome.reason === 'namespace-mismatch') {
    // Capacity and source-fencing rejections are protocol errors,
    // not revoked access; only actual mismatches use this channel.
    deny(sid, 'access-denied')
    return
   }
   respond({ result: 'error' })
  }
 })

 // Session-end retains final rows. startHub drops the runtime projection on
 // the existing SyncEngine session-removed lifecycle event.
 socket.on('session-end', (data: unknown) => {
  if (!data || typeof data !== 'object' || !('sid' in data) || typeof data.sid !== 'string') return
  const sid = data.sid
  if (!authenticatedSessionId || authenticatedSessionId !== sid) return
  if (!resolveSessionAccess(sid).ok) return
  if (!(authorizeSessionPublication?.(sid) ?? false) || !(deps.isCurrentSessionSource?.(sid) ?? false)) return
  registry.markSessionEnded(sid, socket.id)
 })

 socket.on('disconnect', () => registry.disconnectSocket(socket.id))
}
