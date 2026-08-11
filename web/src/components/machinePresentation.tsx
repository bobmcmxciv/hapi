import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * Shared machine-list presentation.
 *
 * The session-list machine filter established the vocabulary — OS silhouette,
 * truncated name, right-aligned figure, and a per-owner section once more than
 * one person's machines are visible. Every other place that lists machines (new
 * session, token usage) reimplemented a plain `<select>` of bare names, so the
 * same fleet looked like three unrelated things and only one of them told you
 * anything quantitative. These primitives are the single source for all of them.
 */

/** The minimum a machine needs to be rendered in any of the shared lists. */
export type MachineListEntry = {
    id: string
    label: string
    /** node platform vocabulary (win32 / darwin / linux); unknown is null. */
    platform: string | null
    /** Owning account username from the multi-user gateway; null on a
     *  single-user hub or when ownership is unknown. */
    owner: string | null
}

/** Each owner gets a section, but only once at least two owners are present —
 *  a single-user hub degrades to a flat list with no headings, which is what it
 *  should look like when "grouping by owner" carries no information. */
export function groupMachinesByOwner<T extends { owner: string | null }>(machines: T[]): {
    grouped: boolean
    sections: { owner: string | null; machines: T[] }[]
} {
    const owners = new Set<string>()
    for (const machine of machines) {
        if (machine.owner) owners.add(machine.owner)
    }
    if (owners.size < 2) {
        return { grouped: false, sections: [{ owner: null, machines }] }
    }
    const byOwner = new Map<string | null, T[]>()
    for (const machine of machines) {
        const list = byOwner.get(machine.owner)
        if (list) list.push(machine)
        else byOwner.set(machine.owner, [machine])
    }
    // Machine order is already meaningful (activity), so section order follows
    // each owner's first machine; the unowned bucket sinks to the end.
    const sections = [...byOwner.entries()].map(([owner, ms]) => ({ owner, machines: ms }))
    sections.sort((a, b) => Number(a.owner === null) - Number(b.owner === null))
    return { grouped: true, sections }
}

function AppleLogoIcon(props: { className?: string }) {
    return (
        <svg viewBox="0 0 24 24" fill="currentColor" className={props.className}>
            <path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.031 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.56-1.702" />
        </svg>
    )
}

function WindowsLogoIcon(props: { className?: string }) {
    return (
        <svg viewBox="0 0 24 24" fill="currentColor" className={props.className}>
            <path d="M0 3.449 9.75 2.1v9.451H0m10.949-9.602L24 0v11.4H10.949M0 12.6h9.75v9.451L0 20.699M10.949 12.6H24V24l-13.051-1.801" />
        </svg>
    )
}

function LinuxTerminalIcon(props: { className?: string }) {
    return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={props.className}>
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <path d="m7 9 3 3-3 3M13 15h4" />
        </svg>
    )
}

function UnknownMachineIcon(props: { className?: string }) {
    return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={props.className}>
            <rect x="3" y="4" width="18" height="12" rx="2" />
            <path d="M8 20h8M12 16v4" />
        </svg>
    )
}

/** OS icon: one silhouette per win32/darwin/linux, generic monitor for unknown
 *  platforms. `data-os` is the test hook. */
export function MachineOsIcon(props: { platform: string | null; className?: string }) {
    const iconClass = props.className ?? 'h-3.5 w-3.5'
    const icon = props.platform === 'darwin' ? <AppleLogoIcon className={iconClass} />
        : props.platform === 'win32' ? <WindowsLogoIcon className={iconClass} />
        : props.platform === 'linux' ? <LinuxTerminalIcon className={iconClass} />
        : <UnknownMachineIcon className={iconClass} />
    return (
        <span aria-hidden="true" data-os={props.platform ?? 'unknown'} className="flex shrink-0 items-center opacity-60">
            {icon}
        </span>
    )
}

export const machineChipSelectedClass = 'border-[var(--app-link)] bg-[var(--app-subtle-bg)] text-[var(--app-link)] font-medium'
export const machineChipIdleClass = 'border-[var(--app-border)] text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]'
// Aligned grid: an auto-fill column floor gives two columns in the narrow
// sidebar and three on wide screens, so the icon / name / figure columns line
// up vertically without a fixed column count tearing gaps open when wide.
export const machineChipGridClass = 'grid grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] gap-1.5'
export const machineChipShellClass = 'h-7 min-w-0 rounded-lg border transition-colors'
export const machineChipContentClass = 'flex h-full w-full min-w-0 items-center gap-1.5 px-2 text-xs'

/** Owner section heading; rendered only when `groupMachinesByOwner` grouped. */
export function MachineOwnerHeading(props: { owner: string | null; unknownLabel: string }) {
    return (
        <div
            data-testid="machine-owner-heading"
            className="px-0.5 pb-1 pt-0.5 text-[10px] font-medium uppercase tracking-wider text-[var(--app-hint)]"
        >
            {props.owner ?? props.unknownLabel}
        </div>
    )
}

/**
 * A machine chip: OS icon, truncated name, right-aligned figure. The figure is
 * whatever the surface is counting — sessions in the sidebar, tokens on the
 * usage page — which is the point of sharing the chip rather than the data.
 */
export function MachineChip(props: {
    label: string
    platform: string | null
    stat: ReactNode
    selected: boolean
    title?: string
    onSelect: () => void
    onContextMenu?: (event: React.MouseEvent) => void
    className?: string
}) {
    return (
        <button
            type="button"
            onClick={props.onSelect}
            onContextMenu={props.onContextMenu}
            aria-pressed={props.selected}
            title={props.title}
            className={cn(
                machineChipShellClass,
                machineChipContentClass,
                props.selected ? machineChipSelectedClass : machineChipIdleClass,
                props.className
            )}
        >
            <MachineOsIcon platform={props.platform} />
            <span className="min-w-0 flex-1 truncate text-left">{props.label}</span>
            <span className="shrink-0 tabular-nums opacity-70">{props.stat}</span>
        </button>
    )
}
