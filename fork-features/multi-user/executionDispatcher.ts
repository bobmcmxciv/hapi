import type { AccessLevel, Capability, DispatchDecision, ResourceType } from './domain'
import type { MultiUserGatewayStore } from './gatewayStore'
import { sessionAccessLevel, type SessionMachineResolver, type SessionPathResolver } from './machineInheritance'

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
        private readonly resolveSessionPath?: SessionPathResolver
    ) {}

    authorize(input: { accountId: number; capability: Capability; resource?: { type: ResourceType; id: string } }): DispatchDecision {
        const account = this.store.getAccount(input.accountId)
        if (!account || account.disabledAt !== null) return { kind: 'deny', reason: 'account-unavailable' }
        if (!input.resource) {
            return { kind: 'allow', context: { account, namespace: account.defaultNamespace, capability: input.capability, resource: null } }
        }
        const resource = this.store.getResource(input.resource.type, input.resource.id)
        if (!resource) return { kind: 'deny', reason: 'resource-not-found' }
        const level = input.resource.type === 'session'
            ? sessionAccessLevel(this.store, account.id, input.resource.id, this.resolveSessionMachineId, this.resolveSessionPath)
            : this.store.accessLevel('machine', input.resource.id, account.id)
        if (!permitted(level, input.capability)) return { kind: 'deny', reason: 'insufficient-access' }
        return { kind: 'allow', context: { account, namespace: resource.coreNamespace, capability: input.capability, resource } }
    }
}
