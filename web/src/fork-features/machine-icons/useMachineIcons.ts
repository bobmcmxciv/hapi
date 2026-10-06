import { useEffect, useMemo } from 'react'
import type { MachineIconId } from '@hapi/protocol'
import type { Machine } from '@/types/api'
import { readCachedStrings, writeCachedStrings } from '@/hooks/useMachineLabels'
import { resolveMachineIcon } from './MachineDeviceIcon'

const STORAGE_KEY = 'hapi-machine-icons'

/**
 * machineId → 设备图标，与 useMachineLabels 同样落 localStorage：机器暂时不在
 * `/api/machines` 里（离线、查询未返回）时保留上次已知图标，不然侧栏分组标题
 * 会在系统图标与设备图标之间来回跳。实时数据里机器没有图标 = 已清掉，删缓存。
 */
export function mergeMachineIcons(
    cached: Record<string, string>,
    machines: Pick<Machine, 'id' | 'metadata'>[]
): Record<string, MachineIconId> {
    const merged: Record<string, MachineIconId> = {}
    for (const [id, value] of Object.entries(cached)) {
        const icon = resolveMachineIcon(value)
        if (icon) merged[id] = icon
    }
    for (const machine of machines) {
        const icon = resolveMachineIcon(machine.metadata?.icon)
        if (icon) merged[machine.id] = icon
        else delete merged[machine.id]
    }
    return merged
}

export function useMachineIcons(machines: Machine[]): Record<string, MachineIconId> {
    const icons = useMemo(
        () => mergeMachineIcons(readCachedStrings(STORAGE_KEY), machines),
        [machines]
    )

    useEffect(() => {
        writeCachedStrings(STORAGE_KEY, icons)
    }, [icons])

    return icons
}
