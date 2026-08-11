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
/** 会话的工作目录（`metadata.path`）。目录限定的机器授权靠它判定是否越界。 */
export type SessionPathResolver = (sessionId: string) => string | null

const RANK: Record<AccessLevel, number> = { none: 0, viewer: 1, operator: 2, owner: 3 }

export function createSessionMachineResolver(
    getSyncEngine: () => SyncEngine | null
): SessionMachineResolver {
    return (sessionId) => {
        const machineId = getSyncEngine()?.getSession(sessionId)?.metadata?.machineId
        return typeof machineId === 'string' && machineId.length > 0 ? machineId : null
    }
}

export function createSessionPathResolver(
    getSyncEngine: () => SyncEngine | null
): SessionPathResolver {
    return (sessionId) => {
        const path = getSyncEngine()?.getSession(sessionId)?.metadata?.path
        return typeof path === 'string' && path.length > 0 ? path : null
    }
}

const isWindowsPath = (value: string): boolean => /^[a-zA-Z]:[\\/]/.test(value)

/**
 * 比较用归一化：分隔符统一成 `/`、去重、去尾。
 * 大小写敏感性按**路径自身形态**决定 —— Windows 盘符路径不区分大小写，POSIX 区分。
 * 两边形态不一致时归一化结果必然不等，即判越界（fail-closed）。
 */
const normalizePath = (value: string): string => {
    const unified = value.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/\/+$/, '')
    return isWindowsPath(value) ? unified.toLowerCase() : unified
}

/**
 * `candidate` 是否落在 `prefix` 限定的目录子树内。
 *
 * - `prefix` 为空 → 未限定，恒真（保持加此列之前的行为）
 * - `candidate` 取不到 → 假（**fail-closed**：证明不了在范围内就当越界）
 * - 含 `..` 段 → 假。不碰文件系统就解析不了它，只能拒
 * - 边界按整段比较，`…\peter` 不会匹配到 `…\peterX`
 */
export function pathWithinScope(candidate: string | null | undefined, prefix: string | null | undefined): boolean {
    if (prefix === null || prefix === undefined || prefix.trim() === '') return true
    if (!candidate) return false
    if (candidate.split(/[\\/]/).includes('..')) return false
    const normalizedPrefix = normalizePath(prefix.trim())
    if (normalizedPrefix === '') return true
    const normalizedCandidate = normalizePath(candidate)
    return normalizedCandidate === normalizedPrefix
        || normalizedCandidate.startsWith(`${normalizedPrefix}/`)
}

/**
 * 机器授权继承到某个会话时的实际档位。
 *
 * 目录限定是 **grant 的属性**，不约束机器主人，也不约束 admin —— 两者
 * `accessLevel` 直接返回 `owner`，本函数原样放行。只有被授权者那条 grant 带了
 * `path_prefix` 时，才要求会话工作目录落在前缀下，否则这台机器上的会话对他
 * 不继承任何档位。
 */
export function machineInheritedLevel(
    store: MultiUserGatewayStore,
    machineId: string,
    accountId: number,
    resolvePath: () => string | null
): AccessLevel {
    const level = store.accessLevel('machine', machineId, accountId)
    if (level === 'none' || level === 'owner') return level
    const scope = store.machineGrantScope(machineId, accountId)
    if (scope === null) return level
    return pathWithinScope(resolvePath(), scope) ? level : 'none'
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
    resolveMachineId?: SessionMachineResolver,
    resolveSessionPath?: SessionPathResolver
): AccessLevel {
    const direct = store.accessLevel('session', sessionId, accountId)
    if (direct === 'owner' || !resolveMachineId) return direct
    const machineId = resolveMachineId(sessionId)
    if (!machineId) return direct
    const inherited = machineInheritedLevel(
        store,
        machineId,
        accountId,
        () => resolveSessionPath?.(sessionId) ?? null
    )
    return RANK[inherited] > RANK[direct] ? inherited : direct
}
