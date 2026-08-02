import type { SyncEvent } from '../../hub/src/sync/syncEngine'
import type { MultiUserGatewayStore } from './gatewayStore'

/**
 * SSE 事件的账号级可见性过滤。
 *
 * 修的缺口：`/api/events?all=true` 此前按 core namespace 广播，而多用户网关下
 * 所有账号共享同一个 core namespace——未被授权的会话在完成时照样把
 * session-updated 等事件推给别的账号，前端据此弹完成提醒（点进去才 403）。
 * Web Push 一侧早有 audience 过滤（notificationAdapter.endpointsForAudience），
 * SSE 这一侧一直是裸的。
 *
 * 可见性判定与 GET /api/sessions / /api/usage/summary 同构（executionMount）：
 * admin 全可见；owner / grantee 可见；其他账号不可见。差异只有一处——
 * **未绑定**（尚无 gateway_resources 行）的资源放行：绑定发生在首次列表
 * （bind-on-view）或创建回调（registerCreatedSession），刚 spawn 的会话在
 * 绑定落地前有一个短暂窗口，拦掉会让创建者自己的首帧流丢失；本部署里
 * 任何账号一刷列表就会把它认领掉，窗口极短。
 *
 * 不带 sessionId/machineId 的事件（connection-changed、update 计数等）放行。
 */
export function createSseEventFilterFactory(
    store: MultiUserGatewayStore
): (accountId: number) => ((event: SyncEvent) => boolean) | null {
    function canRead(accountId: number, type: 'session' | 'machine', id: string): boolean {
        const resource = store.getResource(type, id)
        if (!resource) return true
        if (resource.ownerAccountId === accountId) return true
        return store.listGrants(type, id).some(grant => grant.accountId === accountId)
    }

    return (accountId) => {
        const account = store.getAccount(accountId)
        if (!account || account.disabledAt !== null) {
            // 账号已禁用/不存在：不给任何资源事件（连接本身会被 auth 层挡，
            // 这里是纵深防御）。
            return (event) => !('sessionId' in event) && !('machineId' in event)
        }
        if (account.role === 'admin') return null

        return (event) => {
            const sessionId = 'sessionId' in event ? (event as { sessionId?: unknown }).sessionId : undefined
            if (typeof sessionId === 'string' && sessionId) {
                return canRead(accountId, 'session', sessionId)
            }
            const machineId = 'machineId' in event ? (event as { machineId?: unknown }).machineId : undefined
            if (typeof machineId === 'string' && machineId) {
                return canRead(accountId, 'machine', machineId)
            }
            return true
        }
    }
}
