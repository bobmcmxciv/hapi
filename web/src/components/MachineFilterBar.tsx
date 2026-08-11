import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import { MACHINE_DISPLAY_NAME_MAX_LENGTH } from '@hapi/protocol'
import type { MachineHealthPresentation } from '@/lib/machineHealth'
import { resolveMachineOsLabel } from '@/lib/machineHealth'
import { MachineHealthTooltipBody } from '@/components/MachineHealthIndicator'
import { HoverTooltip } from '@/components/HoverTooltip'
import { CheckIcon } from '@/components/icons'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/lib/use-translation'

export type MachineFilterItem = {
    id: string
    label: string
    sessionCount: number
    healthPresentation: MachineHealthPresentation | null
    /** node 平台词表（win32 / darwin / linux）。机器对象缺失时由会话 metadata.os 兜底；未知为 null。 */
    platform: string | null
    /** 多用户 gateway 标注的归属账号用户名；单用户 hub 或未知为 null。 */
    owner: string | null
    /** 当前自定义别名原值（区别于 label 的 displayName→host→id 回退链），改名对话框回填用。 */
    displayName: string | null
    /** 主机名，改名对话框的占位与「清空后恢复成什么」提示。 */
    host: string | null
    /** 只有出现在 /api/machines 里的机器才能 PATCH 改名。 */
    canRename: boolean
}

const chipSelectedClass = 'border-[var(--app-link)] bg-[var(--app-subtle-bg)] text-[var(--app-link)] font-medium'
const chipIdleClass = 'border-[var(--app-border)] text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]'
// 对齐网格：auto-fill 定列宽下限，窄侧栏两列、宽屏三列上下——各要素纵向对齐，
// 又不像固定列数那样在宽屏拉出大空隙。
const chipGridClass = 'grid grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] gap-1.5'
const chipShellClass = 'h-7 min-w-0 rounded-lg border transition-colors'
const chipContentClass = 'flex h-full w-full min-w-0 items-center gap-1.5 px-2 text-xs'

/** 各归属人一节；不足两个归属人时不分组（单用户 hub 退化成原来的平铺）。 */
export function groupMachinesByOwner(machines: MachineFilterItem[]): {
    grouped: boolean
    sections: { owner: string | null; machines: MachineFilterItem[] }[]
} {
    const owners = new Set<string>()
    for (const machine of machines) {
        if (machine.owner) owners.add(machine.owner)
    }
    if (owners.size < 2) {
        return { grouped: false, sections: [{ owner: null, machines }] }
    }
    const byOwner = new Map<string | null, MachineFilterItem[]>()
    for (const machine of machines) {
        const list = byOwner.get(machine.owner)
        if (list) list.push(machine)
        else byOwner.set(machine.owner, [machine])
    }
    // 机器序已按活跃度排过：节序取各归属人首台机器的次序，无归属的挂尾。
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

/** OS 图标：win32/darwin/linux 各一个剪影，未知平台给通用显示器。`data-os` 供测试定位。 */
function MachineOsIcon(props: { platform: string | null }) {
    const iconClass = 'h-3.5 w-3.5'
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

function FilterIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
        </svg>
    )
}

function MachineFilterChip(props: {
    machine: MachineFilterItem
    selected: boolean
    onSelect: (id: string) => void
    onRenameRequest?: (machine: MachineFilterItem) => void
}) {
    const { t } = useTranslation()
    const { machine, selected, onSelect, onRenameRequest } = props
    const tooltipId = useId()
    const hasHealth = machine.healthPresentation && machine.healthPresentation.metrics.length > 0

    const osLabel = resolveMachineOsLabel(machine.platform)
    const osText = osLabel.kind === 'i18n' ? t(osLabel.key) : osLabel.value
    const titleLine = [machine.label, osText, machine.owner].filter(Boolean).join(' · ')
    const canRename = Boolean(machine.canRename && onRenameRequest)
    const title = canRename ? `${titleLine}\n${t('sessions.machineFilter.renameTooltip')}` : titleLine
    const handleContextMenu = canRename
        ? (event: ReactMouseEvent) => {
            event.preventDefault()
            onRenameRequest!(machine)
        }
        : undefined

    const content = (
        <>
            <MachineOsIcon platform={machine.platform} />
            <span className="min-w-0 flex-1 truncate text-left">{machine.label}</span>
            <span className="shrink-0 tabular-nums opacity-70">{machine.sessionCount}</span>
        </>
    )

    if (!hasHealth) {
        return (
            <button
                type="button"
                onClick={() => onSelect(machine.id)}
                onContextMenu={handleContextMenu}
                aria-pressed={selected}
                title={title}
                className={cn(chipShellClass, chipContentClass, selected ? chipSelectedClass : chipIdleClass)}
            >
                {content}
            </button>
        )
    }

    // The button carries the chip's padding so the entire visible chip is
    // clickable; the health-popup wrapper only draws the border.
    const button = (
        <button
            type="button"
            onClick={() => onSelect(machine.id)}
            onContextMenu={handleContextMenu}
            aria-pressed={selected}
            aria-describedby={tooltipId}
            title={title}
            className={cn(chipContentClass, 'rounded-lg px-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]')}
        >
            {content}
        </button>
    )

    return (
        // CPU/RAM details live in a hover popup so the chip stays compact;
        // hidden below the md breakpoint (touch devices). The `before:` bridge
        // spans the mt-1 gap so the popup stays open while the pointer enters it.
        // `[&>span:first-child]` 把 HoverTooltip 的 target 包装 span 撑满网格
        // 单元，否则 chip 缩成内容宽，计数列对不齐。
        <HoverTooltip
            id={tooltipId}
            target={button}
            side="bottom"
            align="start"
            className={cn(chipShellClass, '[&>span:first-child]:w-full [&>span:first-child]:min-w-0', selected ? chipSelectedClass : chipIdleClass)}
            tooltipClassName="pointer-events-auto before:absolute before:inset-x-0 before:-top-1 before:h-1 before:content-[''] px-3 py-2 min-w-[16rem] max-md:hidden"
        >
            <MachineHealthTooltipBody presentation={machine.healthPresentation!} />
        </HoverTooltip>
    )
}

function MachineRenameDialog(props: {
    machine: MachineFilterItem
    onClose: () => void
    onSubmit: (machineId: string, displayName: string) => Promise<void>
}) {
    const { t } = useTranslation()
    const [draft, setDraft] = useState(props.machine.displayName ?? '')
    const [pending, setPending] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const inputRef = useRef<HTMLInputElement>(null)

    useEffect(() => {
        const timer = setTimeout(() => {
            inputRef.current?.focus()
            inputRef.current?.select()
        }, 100)
        return () => clearTimeout(timer)
    }, [])

    const handleSubmit = async (event: React.FormEvent) => {
        event.preventDefault()
        const next = draft.trim()
        // 与机器改名 API 的语义一致：空串是合法输入，表示清掉别名回落主机名。
        if (next === (props.machine.displayName ?? '')) {
            props.onClose()
            return
        }
        setPending(true)
        setError(null)
        try {
            await props.onSubmit(props.machine.id, next)
            props.onClose()
        } catch {
            setError(t('settings.machines.error'))
            setPending(false)
        }
    }

    return (
        <Dialog open onOpenChange={(open) => { if (!open && !pending) props.onClose() }}>
            <DialogContent className="max-w-sm">
                <DialogHeader className="pr-0">
                    <DialogTitle className="min-h-6 px-10 text-center leading-6">
                        {t('sessions.machineFilter.renameTitle', { name: props.machine.host ?? props.machine.label })}
                    </DialogTitle>
                </DialogHeader>
                <form onSubmit={handleSubmit} className="mt-4 flex flex-col gap-3">
                    <input
                        ref={inputRef}
                        type="text"
                        value={draft}
                        maxLength={MACHINE_DISPLAY_NAME_MAX_LENGTH}
                        placeholder={props.machine.host ?? t('settings.machines.namePlaceholder')}
                        disabled={pending}
                        onChange={(event) => setDraft(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === 'Escape' && !pending) props.onClose()
                        }}
                        className="w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2.5 text-[var(--app-fg)] placeholder:text-[var(--app-hint)] focus:border-transparent focus:outline-none focus:ring-2 focus:ring-[var(--app-button)]"
                    />
                    <p className="text-xs text-[var(--app-hint)]">{t('sessions.machineFilter.renameHint')}</p>
                    {error ? (
                        <div role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-600 dark:bg-red-900/20 dark:text-red-400">
                            {error}
                        </div>
                    ) : null}
                    <div className="flex justify-end gap-2">
                        <Button type="button" variant="secondary" onClick={props.onClose} disabled={pending}>
                            {t('button.cancel')}
                        </Button>
                        <Button type="submit" disabled={pending}>
                            {pending ? t('dialog.rename.saving') : t('button.save')}
                        </Button>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    )
}

/**
 * 各主机排成对齐网格，一次点击即切换筛选。
 *
 * 全宽度常显（此前是 `max-md:hidden`，窄屏折叠成漏斗二级菜单）：会话侧栏是
 * 固定宽度（默认 420px），而 Tailwind 断点看的是**视口**宽度，于是桌面用户也
 * 落进折叠分支，切主机从"一次点击"退化成"点漏斗 → 再选"。
 *
 * 布局从 flex-wrap 胶囊流改成 auto-fill 网格：每格「OS 图标 + 名称 + 计数」
 * 纵向对齐；有两个以上归属人（多用户 gateway 的 ownerUsername）时按人分节。
 * 右键任一机器格可设置别名（onRenameMachine 注入时）。
 */
export function MachineFilterBar(props: {
    machines: MachineFilterItem[]
    totalCount: number
    value: string | null
    onChange: (id: string | null) => void
    /** 注入后启用右键改名；SessionList 里包了 renameMachine API + 机器列表刷新。 */
    onRenameMachine?: (machineId: string, displayName: string) => Promise<void>
}) {
    const { t } = useTranslation()
    const [renameTarget, setRenameTarget] = useState<MachineFilterItem | null>(null)
    const { grouped, sections } = useMemo(() => groupMachinesByOwner(props.machines), [props.machines])
    const onRenameRequest = props.onRenameMachine
        ? (machine: MachineFilterItem) => setRenameTarget(machine)
        : undefined

    const allChip = (
        <button
            type="button"
            onClick={() => props.onChange(null)}
            aria-pressed={props.value === null}
            className={cn(chipShellClass, chipContentClass, props.value === null ? chipSelectedClass : chipIdleClass)}
        >
            <span className="min-w-0 flex-1 truncate text-left">{t('sessions.machineFilter.all')}</span>
            <span className="shrink-0 tabular-nums opacity-70">{props.totalCount}</span>
        </button>
    )

    const renderGrid = (machines: MachineFilterItem[], leading?: ReactNode) => (
        <div className={chipGridClass}>
            {leading}
            {machines.map((machine) => (
                <MachineFilterChip
                    key={machine.id}
                    machine={machine}
                    selected={props.value === machine.id}
                    onSelect={props.onChange}
                    onRenameRequest={onRenameRequest}
                />
            ))}
        </div>
    )

    return (
        <div
            role="group"
            aria-label={t('sessions.machineFilter.label')}
            className="flex flex-col gap-1 px-2 pb-2"
        >
            {grouped ? (
                <>
                    {renderGrid([], allChip)}
                    {sections.map((section) => (
                        <div key={section.owner ?? '__unknown__'}>
                            <div data-testid="machine-owner-heading" className="px-0.5 pb-1 pt-0.5 text-[10px] font-medium uppercase tracking-wider text-[var(--app-hint)]">
                                {section.owner ?? t('sessions.machineFilter.unknownOwner')}
                            </div>
                            {renderGrid(section.machines)}
                        </div>
                    ))}
                </>
            ) : renderGrid(sections[0]?.machines ?? [], allChip)}
            {renameTarget && props.onRenameMachine ? (
                <MachineRenameDialog
                    machine={renameTarget}
                    onClose={() => setRenameTarget(null)}
                    onSubmit={props.onRenameMachine}
                />
            ) : null}
        </div>
    )
}

function MachineFilterMenuRow(props: {
    label: string
    count: number
    selected: boolean
    healthPresentation: MachineHealthPresentation | null
    onSelect: () => void
}) {
    const hasHealth = props.healthPresentation && props.healthPresentation.metrics.length > 0
    return (
        <button
            type="button"
            role="menuitemradio"
            aria-checked={props.selected}
            onClick={props.onSelect}
            className="flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors hover:bg-[var(--app-subtle-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
        >
            <span className="flex h-5 w-4 shrink-0 items-center justify-center text-[var(--app-link)]">
                {props.selected ? <CheckIcon className="h-4 w-4" /> : null}
            </span>
            <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-1.5">
                    <span className="truncate text-[var(--app-fg)]">{props.label}</span>
                    <span className="shrink-0 tabular-nums text-xs text-[var(--app-hint)]">({props.count})</span>
                </span>
                {hasHealth ? (
                    <span className="mt-0.5 block truncate text-xs tabular-nums text-[var(--app-hint)]">
                        {props.healthPresentation!.metrics.map((metric) => `${metric.shortLabel} ${metric.percent}%`).join(' · ')}
                    </span>
                ) : null}
            </span>
        </button>
    )
}

// Clamp the menu to the space actually remaining left of/below the trigger
// (the menu is right-anchored to the trigger): the rem-based design caps
// (w-64 / max-h-80) grow with the font-scale setting, and safe-area insets
// shrink usable space on notched devices. The height chain mirrors the body
// sizing in index.css.
const MENU_VIEWPORT_MARGIN_PX = 8
const MENU_TOP_GAP_PX = 4 // mt-1

export function getMachineFilterMenuClampStyle(anchor: { right: number; bottom: number }): CSSProperties {
    return {
        maxWidth: `min(16rem, calc(${anchor.right}px - ${MENU_VIEWPORT_MARGIN_PX}px - env(safe-area-inset-left)))`,
        maxHeight: `min(20rem, calc(var(--tg-viewport-stable-height, var(--app-viewport-height, 100dvh)) - ${anchor.bottom + MENU_TOP_GAP_PX}px - ${MENU_VIEWPORT_MARGIN_PX}px - env(safe-area-inset-bottom)))`
    }
}

// Mobile (below md) counterpart of MachineFilterBar: collapses the machine
// filter into a single header icon button with a dropdown, so the chip row
// does not consume vertical space on small screens. A blue dot mirrors the
// search/date picker's active-filter indicator; health metrics render inline
// because hover tooltips are unavailable on touch devices.
export function MachineFilterMenu(props: {
    machines: MachineFilterItem[]
    totalCount: number
    value: string | null
    onChange: (id: string | null) => void
}) {
    const { t } = useTranslation()
    const [open, setOpen] = useState(false)
    const triggerRef = useRef<HTMLButtonElement>(null)
    const wrapperRef = useRef<HTMLDivElement>(null)
    const menuRef = useRef<HTMLDivElement>(null)
    const [anchor, setAnchor] = useState<{ right: number; bottom: number } | null>(null)

    const close = useCallback(() => {
        setOpen(false)
        triggerRef.current?.focus()
    }, [])

    const select = (id: string | null) => {
        props.onChange(id)
        close()
    }

    useLayoutEffect(() => {
        if (!open) {
            setAnchor(null)
            return
        }
        const updateAnchor = () => {
            const rect = wrapperRef.current?.getBoundingClientRect()
            if (!rect) return
            setAnchor({ right: rect.right, bottom: rect.bottom })
        }
        updateAnchor()
        window.addEventListener('resize', updateAnchor)
        return () => window.removeEventListener('resize', updateAnchor)
    }, [open])

    // Focus the selected (or first) row on open; Escape closes and Arrow keys
    // move between rows, matching SessionActionMenu's keyboard behavior.
    useEffect(() => {
        if (!open) return

        const frame = window.requestAnimationFrame(() => {
            const selected = menuRef.current?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]')
            const first = menuRef.current?.querySelector<HTMLElement>('[role="menuitemradio"]')
            ;(selected ?? first)?.focus()
        })

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault()
                close()
                return
            }
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
            const items = Array.from(
                menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? []
            )
            if (items.length === 0) return
            event.preventDefault()
            const delta = event.key === 'ArrowDown' ? 1 : -1
            const currentIndex = items.indexOf(document.activeElement as HTMLElement)
            const nextIndex = currentIndex === -1
                ? (delta === 1 ? 0 : items.length - 1)
                : (currentIndex + delta + items.length) % items.length
            items[nextIndex]?.focus()
        }

        document.addEventListener('keydown', handleKeyDown)
        return () => {
            window.cancelAnimationFrame(frame)
            document.removeEventListener('keydown', handleKeyDown)
        }
    }, [open, close])

    return (
        <div ref={wrapperRef} className="relative shrink-0 md:hidden">
            <button
                ref={triggerRef}
                type="button"
                onClick={() => setOpen(value => !value)}
                aria-label={t('sessions.machineFilter.label')}
                title={t('sessions.machineFilter.label')}
                aria-haspopup="menu"
                aria-expanded={open}
                className="relative flex rounded-full p-1.5 text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
            >
                <FilterIcon className="h-5 w-5" />
                {props.value !== null ? (
                    <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-[var(--app-link)]" />
                ) : null}
            </button>
            {open ? (
                <>
                    <button
                        type="button"
                        aria-label={t('button.close')}
                        tabIndex={-1}
                        className="fixed inset-0 z-20 cursor-default"
                        onClick={close}
                    />
                    <div
                        ref={menuRef}
                        role="menu"
                        aria-label={t('sessions.machineFilter.label')}
                        style={anchor ? getMachineFilterMenuClampStyle(anchor) : undefined}
                        className="absolute right-0 top-full z-30 mt-1 max-h-80 w-64 overflow-y-auto rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] p-1 shadow-xl"
                    >
                        <MachineFilterMenuRow
                            label={t('sessions.machineFilter.all')}
                            count={props.totalCount}
                            selected={props.value === null}
                            healthPresentation={null}
                            onSelect={() => select(null)}
                        />
                        {props.machines.map((machine) => (
                            <MachineFilterMenuRow
                                key={machine.id}
                                label={machine.label}
                                count={machine.sessionCount}
                                selected={props.value === machine.id}
                                healthPresentation={machine.healthPresentation}
                                onSelect={() => select(machine.id)}
                            />
                        ))}
                    </div>
                </>
            ) : null}
        </div>
    )
}
