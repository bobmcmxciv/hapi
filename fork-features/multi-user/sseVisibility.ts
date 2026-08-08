import type { SyncEvent } from '../../hub/src/sync/syncEngine'
import type { MultiUserGatewayStore } from './gatewayStore'
import { sessionAccessLevel, type SessionMachineResolver } from './machineInheritance'

/**
 * 事件携带的会话 id。**toast 把 sessionId 放在 `data` 里，顶层没有**
 * （shared/src/schemas.ts 的 SyncEventSchema）——只认顶层的话，谓词对每条 toast 都恒真，
 * 「任务完成 / 等待输入」提醒照旧发给整个 namespace 的所有账号，正是本模块要堵的洞。
 */
function eventSessionId(event: SyncEvent): string | null {
    if (event.type === 'toast') return event.data.sessionId || null
    const value = 'sessionId' in event ? (event as { sessionId?: unknown }).sessionId : undefined
    return typeof value === 'string' && value ? value : null
}

function eventMachineId(event: SyncEvent): string | null {
    const value = 'machineId' in event ? (event as { machineId?: unknown }).machineId : undefined
    return typeof value === 'string' && value ? value : null
}

/** 真正与任何资源无关的事件（心跳、connection-changed 等）才无条件放行。 */
function carriesResourceId(event: SyncEvent): boolean {
    return eventSessionId(event) !== null || eventMachineId(event) !== null
}

/**
 * SSE 事件的账号级可见性过滤。
 *
 * 修的缺口：`/api/events?all=true` 此前按 core namespace 广播，而多用户网关下
 * 所有账号共享同一个 core namespace——未被授权的会话在完成时照样把
 * session-updated 等事件推给别的账号，前端据此弹完成提醒（点进去才 403）。
 * Web Push 一侧早有 audience 过滤（notificationAdapter.endpointsForAudience），
 * SSE 这一侧一直是裸的。
 *
 * 谓词同时管两条投递路径，缺一条洞就还在：`SSEManager.broadcast`（同步事件流）
 * 与 `SSEManager.sendToast`（提醒弹窗）。toast 只按 namespace 投给所有 visible
 * 连接，2026-08-08 前它压根不问谓词——这正是「mnmn66 看到别人会话动态」的那条路。
 *
 * 可见性判定与 GET /api/sessions / /api/usage/summary 同构（executionMount）：
 * admin 全可见；owner / grantee 可见；会话还继承所在机器上的授权
 * （machineInheritance）——被授权某台机器的账号，该机器上**新建**的会话事件
 * 也要投递，否则新会话不会自动出现在他的列表里。其他账号不可见。
 *
 * 差异只有一处——**未绑定**（尚无 gateway_resources 行）的资源，在**账号自己的
 * namespace 里**放行：绑定发生在首次列表（bind-on-view）或创建回调
 * （registerCreatedSession），刚 spawn 的会话在绑定落地前有一个短暂窗口，
 * 拦掉会让创建者自己的首帧流丢失。这个窗口不能扩到别的 namespace：订阅现在是
 * 按 namespace 铺开的（executionMount），一律放行就等于把别人 namespace 里
 * 尚未绑定的会话全抄送过去。
 *
 * 不带 sessionId/machineId 的事件（connection-changed、update 计数等）放行。
 */
export function createSseEventFilterFactory(
    store: MultiUserGatewayStore,
    resolveSessionMachineId?: SessionMachineResolver
): (accountId: number) => ((event: SyncEvent) => boolean) | null {
    function canReadMachine(accountId: number, id: string, ownNamespace: boolean): boolean {
        if (store.accessLevel('machine', id, accountId) !== 'none') return true
        return ownNamespace && !store.getResource('machine', id)
    }

    function canReadSession(accountId: number, id: string, ownNamespace: boolean): boolean {
        if (sessionAccessLevel(store, accountId, id, resolveSessionMachineId) !== 'none') return true
        // 已绑定但无权 → 拒。
        if (store.getResource('session', id)) return false
        if (!ownNamespace) return false
        // 未绑定的短暂窗口。但只要能查到它跑在一台**有主**的机器上，归属就已经
        // 判定得了（上面那句 sessionAccessLevel 已经算过），不必再放行。
        const machineId = resolveSessionMachineId?.(id) ?? null
        return !machineId || !store.getResource('machine', machineId)
    }

    return (accountId) => {
        const account = store.getAccount(accountId)
        if (!account || account.disabledAt !== null) {
            // 账号已禁用/不存在：不给任何资源事件（连接本身会被 auth 层挡，
            // 这里是纵深防御）。
            return (event) => !carriesResourceId(event)
        }
        if (account.role === 'admin') return null

        return (event) => {
            const ownNamespace = event.namespace === account.defaultNamespace
            const sessionId = eventSessionId(event)
            if (sessionId) return canReadSession(accountId, sessionId, ownNamespace)
            const machineId = eventMachineId(event)
            if (machineId) return canReadMachine(accountId, machineId, ownNamespace)
            return true
        }
    }
}

/**
 * 路由侧适配器：从请求的 JWT 里取**网关账号 id（`gaid`）**再构造谓词。
 *
 * 必须用 `gaid` 而不是 `uid`：网关下所有账号共享同一个 core user（`uid` 恒为 1），
 * 用 `uid` 会把每个登录者都判成账号 1——admin 之外的人全部被误杀，连被授权的
 * 会话也收不到事件（2026-08-02 生产实测：授权后仍 0 事件）。
 */
export function createSseRequestFilterFactory(
    store: MultiUserGatewayStore,
    resolveAccountId: (request: Request) => Promise<number | null>,
    resolveSessionMachineId?: SessionMachineResolver
): (request: Request) => Promise<((event: SyncEvent) => boolean) | null> {
    const byAccount = createSseEventFilterFactory(store, resolveSessionMachineId)
    return async (request) => {
        const accountId = await resolveAccountId(request)
        // 解析不出账号身份时不放行任何带资源 id 的事件（fail-closed）。
        if (accountId === null) return (event) => !carriesResourceId(event)
        return byAccount(accountId)
    }
}
