import type { SyncEngine } from '../../hub/src/sync/syncEngine'
import type { AccessLevel } from './domain'
import type { MultiUserGatewayStore } from './gatewayStore'

/**
 * 会话从「所在机器」继承访问权限。
 *
 * 修的缺口：把一台机器授权给某个账号后，该机器上**新建**的会话对他仍然不可见 ——
 * 会话是独立的 gateway_resources 行，owner 是创建者（通常 admin），没有任何 grant
 * 指向被授权人。此前唯一的办法是每建一个会话就手动再授权一次（生产库里 mnmn66
 * 已经攒了 50 多条逐条补的 session grant），机器授权形同虚设。
 *
 * 从属关系不在网关库里冗余存一份：会话属于哪台机器是 core 侧的事实
 * （`session.metadata.machineId`，CLI 建会话时必填），冗余一份就会漂移，
 * 而且存量会话也补不上。这里改成每次判权时按 sessionId 现查。
 */
export type SessionMachineResolver = (sessionId: string) => string | null

const RANK: Record<AccessLevel, number> = { none: 0, viewer: 1, operator: 2, owner: 3 }

export function createSessionMachineResolver(
    getSyncEngine: () => SyncEngine | null
): SessionMachineResolver {
    return (sessionId) => {
        const machineId = getSyncEngine()?.getSession(sessionId)?.metadata?.machineId
        return typeof machineId === 'string' && machineId.length > 0 ? machineId : null
    }
}

/**
 * 会话的实际权限 = max(会话自身的授权, 所在机器的授权)。
 *
 * 取 max 而不是覆盖：会话上单独给到的 operator 不会被机器上的 viewer 降级，
 * 反之亦然。没有 resolver（或查不到机器）时行为与继承前完全一致。
 */
export function sessionAccessLevel(
    store: MultiUserGatewayStore,
    accountId: number,
    sessionId: string,
    resolveMachineId?: SessionMachineResolver
): AccessLevel {
    const direct = store.accessLevel('session', sessionId, accountId)
    if (direct === 'owner' || !resolveMachineId) return direct
    const machineId = resolveMachineId(sessionId)
    if (!machineId) return direct
    const inherited = store.accessLevel('machine', machineId, accountId)
    return RANK[inherited] > RANK[direct] ? inherited : direct
}
