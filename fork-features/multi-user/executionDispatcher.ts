import type { AccessLevel, Capability, DispatchDecision, ResourceType } from './domain'
import type { MultiUserGatewayStore } from './gatewayStore'
import { machineInheritedLevel, sessionAccessLevel, type SessionMachineResolver, type SessionPathResolver } from './machineInheritance'

const permitted = (level: AccessLevel, capability: Capability): boolean => {
 if (capability === 'read') return level !== 'none'
 if (capability === 'operate') return level === 'operator' || level === 'owner'
 return level === 'owner'
}

export class ExecutionDispatcher {
 /**
  * `resolveSessionMachineId` 让会话继承所在机器上的授权（见 machineInheritance）。
  * 不传时行为与继承前一致 —— 只看会话自身的 owner/grant。
  */
 constructor(
  private readonly store: MultiUserGatewayStore,
  private readonly resolveSessionMachineId?: SessionMachineResolver,
  private readonly resolveSessionPath?: SessionPathResolver,
  private readonly resolveResourceNamespace?: (type: ResourceType, id: string) => string | null
 ) { }

 authorize(input: { accountId: number; capability: Capability; resource?: { type: ResourceType; id: string } }): DispatchDecision {
  const account = this.store.getAccount(input.accountId)
  if (!account || account.disabledAt !== null) return { kind: 'deny', reason: 'account-unavailable' }
  if (!input.resource) {
   return { kind: 'allow', context: { account, namespace: account.defaultNamespace, capability: input.capability, resource: null } }
  }
  const resource = this.store.getResource(input.resource.type, input.resource.id)
  if (!resource) {
   // A newly-created core session can publish readiness before the spawn
   // response binds its gateway row. Authorize from its existing machine,
   // without claiming ownership or trusting a shared namespace alone.
   if (input.resource.type === 'session' && input.capability !== 'administer') {
    const namespace = this.resolveResourceNamespace?.('session', input.resource.id)
    const machineId = this.resolveSessionMachineId?.(input.resource.id)
    const machine = machineId ? this.store.getResource('machine', machineId) : null
    if (namespace != null && machine
     && machine.coreNamespace === namespace
     && this.resolveResourceNamespace?.('machine', machine.resourceId) === namespace) {
     const inherited = machineInheritedLevel(this.store, machine.resourceId, account.id,
      () => this.resolveSessionPath?.(input.resource!.id) ?? null)
     if (permitted(inherited, input.capability)) {
      return { kind: 'allow', context: { account, namespace, capability: input.capability, resource: null } }
     }
    }
   }
   // Global admin visibility must not require claiming a foreign resource first.
   // Resolve the real core namespace without fabricating an ownership binding.
   const namespace = account.role === 'admin' && input.capability === 'read'
    ? this.resolveResourceNamespace?.(input.resource.type, input.resource.id)
    : null
   return namespace != null
    ? { kind: 'allow', context: { account, namespace, capability: input.capability, resource: null } }
    : { kind: 'deny', reason: 'resource-not-found' }
  }
  const level = input.resource.type === 'session'
   ? sessionAccessLevel(this.store, account.id, input.resource.id, this.resolveSessionMachineId, this.resolveSessionPath)
   : this.store.accessLevel('machine', input.resource.id, account.id)
  if (!permitted(level, input.capability)) return { kind: 'deny', reason: 'insufficient-access' }
  return { kind: 'allow', context: { account, namespace: resource.coreNamespace, capability: input.capability, resource } }
 }
}
