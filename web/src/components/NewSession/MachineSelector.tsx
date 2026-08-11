import { useMemo } from 'react'
import type { Machine, MachineWithOwner } from '@/types/api'
import { useTranslation } from '@/lib/use-translation'
import { useMachineOwners } from '@/hooks/useMachineLabels'
import { getMachinePlatform } from '@/lib/machineHealth'
import {
    MachineChip,
    MachineOwnerHeading,
    groupMachinesByOwner,
    machineChipGridClass
} from '@/components/machinePresentation'

export function getMachineTitle(machine: Machine): string {
    if (machine.metadata?.displayName) return machine.metadata.displayName
    if (machine.metadata?.host) return machine.metadata.host
    return machine.id.slice(0, 8)
}

/**
 * Machine picker for the new-session form.
 *
 * Was a bare `<select>` of `name (platform)` — the same fleet the sidebar shows
 * as an owner-grouped, OS-tagged, counted grid appeared here as an
 * undifferentiated dropdown with no indication of who owns what or where the
 * work already is. On a multi-user hub that made picking a target machine
 * guesswork. It now speaks the same vocabulary as the session-list filter, and
 * carries the one figure that matters when starting work: how many sessions the
 * machine is already carrying.
 */
export function MachineSelector(props: {
    machines: Machine[]
    machineId: string | null
    isLoading?: boolean
    isDisabled: boolean
    onChange: (machineId: string) => void
    /** machineId → 已有会话数，作为每格右侧的统计值。 */
    sessionCountByMachineId?: Record<string, number>
}) {
    const { t } = useTranslation()
    const owners = useMachineOwners(props.machines as MachineWithOwner[])
    const counts = props.sessionCountByMachineId ?? {}

    const entries = useMemo(
        () => props.machines.map((machine) => ({
            id: machine.id,
            label: getMachineTitle(machine),
            platform: getMachinePlatform(machine),
            owner: (machine as MachineWithOwner).ownerUsername ?? owners[machine.id] ?? null,
            sessionCount: counts[machine.id] ?? 0
        })),
        [props.machines, owners, counts]
    )
    const { grouped, sections } = useMemo(() => groupMachinesByOwner(entries), [entries])

    const renderGrid = (items: typeof entries) => (
        <div className={machineChipGridClass}>
            {items.map((item) => (
                <MachineChip
                    key={item.id}
                    label={item.label}
                    platform={item.platform}
                    stat={item.sessionCount}
                    selected={props.machineId === item.id}
                    title={[item.label, item.owner].filter(Boolean).join(' · ')}
                    onSelect={() => { if (!props.isDisabled) props.onChange(item.id) }}
                    className={props.isDisabled ? 'pointer-events-none opacity-50' : undefined}
                />
            ))}
        </div>
    )

    return (
        <div className="flex flex-col gap-1.5 px-3 py-3">
            <label className="text-xs font-medium text-[var(--app-hint)]">
                {t('newSession.machine')}
            </label>
            {props.isLoading ? (
                <div className="text-xs text-[var(--app-hint)]">{t('loading.machines')}</div>
            ) : entries.length === 0 ? (
                <div className="text-xs text-[var(--app-hint)]">{t('misc.noMachines')}</div>
            ) : grouped ? (
                <div className="flex flex-col gap-1">
                    {sections.map((section) => (
                        <div key={section.owner ?? '__unknown__'}>
                            <MachineOwnerHeading
                                owner={section.owner}
                                unknownLabel={t('sessions.machineFilter.unknownOwner')}
                            />
                            {renderGrid(section.machines)}
                        </div>
                    ))}
                </div>
            ) : renderGrid(sections[0]?.machines ?? [])}
        </div>
    )
}
