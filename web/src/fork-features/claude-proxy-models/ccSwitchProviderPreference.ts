/**
 * fork(claude-proxy-models)：New Session 里为某台机器选定的 cc-switch 供应商（按机器记忆）。
 *
 * 语义：`null` = 跟随该机器 cc-switch 当前供应商（不注入任何 env，与以往完全一致）；
 * 字符串 = 只给**这一个** Claude 子进程注入该供应商的 env（runner 侧
 * getCcSwitchProviderLaunchEnv），不改机器上的 cc-switch 全局状态。
 */

const STORAGE_PREFIX = 'hapi:newSession:ccSwitchProvider:v1'

function storageKey(machineId: string): string {
    return `${STORAGE_PREFIX}:${machineId}`
}

export function loadPreferredCcSwitchProvider(machineId: string): string | null {
    try {
        const raw = localStorage.getItem(storageKey(machineId))
        return raw && raw.trim() ? raw : null
    } catch {
        return null
    }
}

export function savePreferredCcSwitchProvider(machineId: string, providerId: string | null): void {
    try {
        if (providerId) {
            localStorage.setItem(storageKey(machineId), providerId)
        } else {
            localStorage.removeItem(storageKey(machineId))
        }
    } catch {
        // storage unavailable (private mode / quota) — the choice simply does not persist
    }
}

/**
 * 真正随 spawn 发出的 providerId：只有当选择存在于该机器的供应商列表里、且**不是**当前
 * 供应商时才发；否则 undefined（走机器默认，行为与未选完全一致）。
 */
export function resolveSpawnCcSwitchProviderId(args: {
    selected: string | null
    available: boolean
    providerIds: readonly string[]
    currentProviderId: string | null
}): string | undefined {
    const { selected, available, providerIds, currentProviderId } = args
    if (!selected || !available) return undefined
    if (!providerIds.includes(selected)) return undefined
    if (selected === currentProviderId) return undefined
    return selected
}
