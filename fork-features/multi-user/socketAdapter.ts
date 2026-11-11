import type { Capability, ResourceType } from './domain'
import type { MultiUserGatewayStore } from './gatewayStore'
import { ExecutionDispatcher } from './executionDispatcher'
import type { SessionMachineResolver, SessionPathResolver } from './machineInheritance'

/**
 * Authoritative terminal ACL for a gateway account: allow → the session's core
 * namespace, deny → null. Session access is direct grant OR machine-inherited
 * (directory-scoped machine grants included) via the same ExecutionDispatcher
 * semantics the HTTP routes use.
 *
 * No ownership binding happens here: claiming an unbound session would grant
 * owner, permanently bypassing the caller's (possibly directory-scoped) machine
 * grant. Admin/same-namespace claiming of unbound sessions stays in the HTTP
 * session-list flow; machine-mediated access already covers unbound sessions.
 */
export function resolveTerminalNamespace(params: {
 store: MultiUserGatewayStore
 accountId: number
 sessionId: string
 capability?: Capability
 resolveSessionMachineId?: SessionMachineResolver
 resolveSessionPath?: SessionPathResolver
 getCoreSession: (id: string) => { namespace: string } | null
 getCoreMachine?: (id: string) => { namespace: string } | null
 resolveResourceNamespace?: (type: ResourceType, id: string) => string | null
}): string | null {
 const account = params.store.getAccount(params.accountId)
 if (!account) return null
 const resolveResourceNamespace = params.resolveResourceNamespace
  ?? ((type: ResourceType, id: string) => (type === 'session'
   ? params.getCoreSession(id)?.namespace ?? null
   : params.getCoreMachine?.(id)?.namespace ?? null))
 const decision = new ExecutionDispatcher(
  params.store,
  params.resolveSessionMachineId,
  params.resolveSessionPath,
  resolveResourceNamespace
 ).authorize({
  accountId: account.id,
  capability: params.capability ?? 'operate',
  resource: { type: 'session', id: params.sessionId }
 })
 return decision.kind === 'allow' ? decision.context.namespace : null
}

/**
 * Live credential check for an already-verified gateway JWT payload: the
 * account must exist and not be disabled, and an API-token claim (`tid`) must
 * resolve to an unrevoked row still owned by that account. Signature/expiry are
 * the caller's job (jwtVerify). Same inventory rules as the HTTP middleware.
 */
export function gatewayCredentialIdentity(
 store: MultiUserGatewayStore,
 claims: { gaid?: unknown; tid?: unknown }
): { accountId: number; tokenId?: number } | null {
 if (typeof claims.gaid !== 'number') return null
 const account = store.getAccount(claims.gaid)
 if (!account || account.disabledAt !== null) return null
 if (typeof claims.tid === 'number') {
  const apiToken = store.getToken(claims.tid)
  if (!apiToken || apiToken.revokedAt !== null || apiToken.accountId !== account.id) return null
  return { accountId: account.id, tokenId: apiToken.id }
 }
 return { accountId: account.id }
}
