import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MachineFilterItem } from './MachineFilterBar'
import { MachineFilterBar, MachineFilterMenu, getMachineFilterMenuClampStyle, groupMachinesByOwner } from './MachineFilterBar'
import { I18nProvider } from '@/lib/i18n-context'

afterEach(() => cleanup())

function machineItem(overrides: Partial<MachineFilterItem> & { id: string; label: string }): MachineFilterItem {
    return {
        sessionCount: 1,
        healthPresentation: null,
        platform: null,
        owner: null,
        displayName: null,
        host: null,
        canRename: false,
        ...overrides,
    }
}

const defaultMachines: MachineFilterItem[] = [
    machineItem({
        id: 'machine-1',
        label: 'Mint',
        sessionCount: 3,
        platform: 'darwin',
        host: 'mint.local',
        canRename: true,
    }),
    machineItem({
        id: 'machine-2',
        label: 'Teemo',
        sessionCount: 2,
        platform: 'win32',
        host: 'TEEMO-PC',
        displayName: 'Teemo',
        canRename: true,
        healthPresentation: {
            metrics: [
                { id: 'cpu', shortLabel: 'CPU', percent: 12, tone: 'ok' },
                { id: 'ram', shortLabel: 'RAM', percent: 88, tone: 'warn' },
            ],
            overallTone: 'warn',
            status: 'elevated',
        },
    }),
]

function renderBar(props: Partial<Parameters<typeof MachineFilterBar>[0]> = {}) {
    return render(
        <I18nProvider>
            <MachineFilterBar
                machines={defaultMachines}
                totalCount={5}
                value={null}
                onChange={vi.fn()}
                {...props}
            />
        </I18nProvider>
    )
}

function renderMenu(props: Partial<Parameters<typeof MachineFilterMenu>[0]> = {}) {
    return render(
        <I18nProvider>
            <MachineFilterMenu
                machines={defaultMachines}
                totalCount={5}
                value={null}
                onChange={vi.fn()}
                {...props}
            />
        </I18nProvider>
    )
}

describe('MachineFilterBar', () => {
    it('renders an "All" chip plus one chip per machine with counts', () => {
        renderBar()

        expect(screen.getByRole('button', { name: /All 5/ })).toBeTruthy()
        expect(screen.getByRole('button', { name: /Mint 3/ })).toBeTruthy()
        expect(screen.getByRole('button', { name: /Teemo 2/ })).toBeTruthy()
    })

    it('marks the selected chip as pressed', () => {
        renderBar({ value: 'machine-1' })

        expect(screen.getByRole('button', { name: /Mint 3/ }).getAttribute('aria-pressed')).toBe('true')
        expect(screen.getByRole('button', { name: /All 5/ }).getAttribute('aria-pressed')).toBe('false')
    })

    it('reports machine selection and reset to All', () => {
        const onChange = vi.fn()
        renderBar({ value: 'machine-1', onChange })

        fireEvent.click(screen.getByRole('button', { name: /Teemo 2/ }))
        expect(onChange).toHaveBeenCalledWith('machine-2')

        fireEvent.click(screen.getByRole('button', { name: /All 5/ }))
        expect(onChange).toHaveBeenCalledWith(null)
    })

    it('shows machine health in a hover popup instead of reserving chip width', () => {
        renderBar()

        const chip = screen.getByRole('button', { name: /Teemo 2/ })
        const describedBy = chip.getAttribute('aria-describedby')
        expect(describedBy).toBeTruthy()

        const tooltip = document.getElementById(describedBy!)
        expect(tooltip).toBeTruthy()
        expect(tooltip!.getAttribute('role')).toBe('tooltip')
        expect(tooltip!.textContent).toContain('Machine capacity')
        expect(tooltip!.textContent).toContain('CPU')
        expect(tooltip!.textContent).toContain('12%')
        // Popup is hidden below the md breakpoint (mobile shows nothing)
        expect(tooltip!.className).toContain('max-md:hidden')
        // A pseudo-element bridges the mt-1 gap so the popup stays open while entered
        expect(tooltip!.className).toContain('before:-top-1')
    })

    it('keeps the entire visible chip clickable', () => {
        renderBar()

        // Chip with health popup: the button carries the chip padding, the
        // bordered wrapper adds no inert padding around it and stretches the
        // target to the full grid cell so counts stay aligned.
        const teemo = screen.getByRole('button', { name: /Teemo 2/ })
        expect(teemo.className).toContain('px-2')
        expect(teemo.className).toContain('w-full')
        const shell = teemo.parentElement!.parentElement!
        expect(shell.className).toContain('rounded-lg')
        expect(shell.className).toContain('border')
        expect(shell.className).not.toContain('px-2')
        expect(shell.className).toContain('[&>span:first-child]:w-full')

        // Chip without health: the button is the chip itself.
        const mint = screen.getByRole('button', { name: /Mint 3/ })
        expect(mint.className).toContain('rounded-lg')
        expect(mint.className).toContain('border')
        expect(mint.className).toContain('w-full')
    })

    it('lays chips out in an aligned auto-fill grid and never collapses at any width', () => {
        // fork：不再按视口断点折叠；布局是 auto-fill 网格，各要素纵向对齐。
        renderBar()

        const group = screen.getByRole('group', { name: 'Filter sessions by machine' })
        expect(group.className).not.toContain('max-md:hidden')
        const grid = group.firstElementChild!
        expect(grid.className).toContain('grid')
        expect(grid.className).toContain('auto-fill')
    })

    it('shows an OS icon matching each machine platform', () => {
        renderBar({
            machines: [
                ...defaultMachines,
                machineItem({ id: 'machine-3', label: 'Pengu', platform: 'linux' }),
                machineItem({ id: 'machine-4', label: 'Mystery' }),
            ],
        })

        const mint = screen.getByRole('button', { name: /Mint 3/ })
        expect(mint.querySelector('[data-os="darwin"]')).toBeTruthy()
        const teemo = screen.getByRole('button', { name: /Teemo 2/ })
        expect(teemo.querySelector('[data-os="win32"]')).toBeTruthy()
        expect(screen.getByRole('button', { name: /Pengu 1/ }).querySelector('[data-os="linux"]')).toBeTruthy()
        expect(screen.getByRole('button', { name: /Mystery 1/ }).querySelector('[data-os="unknown"]')).toBeTruthy()
    })

    it('groups machines under owner headings once two owners exist, unknown owners last', () => {
        renderBar({
            machines: [
                machineItem({ id: 'm-x', label: 'stray' }),
                machineItem({ id: 'm-a1', label: 'vircs', owner: 'admin' }),
                machineItem({ id: 'm-p1', label: 'WudeMac', owner: 'peter' }),
                machineItem({ id: 'm-a2', label: 'desktop', owner: 'admin' }),
            ],
        })

        const headings = screen.getAllByTestId('machine-owner-heading').map((el) => el.textContent)
        expect(headings).toEqual(['admin', 'peter', 'Unknown owner'])
        // 同归属人的机器聚在同一节里
        const adminSection = screen.getAllByTestId('machine-owner-heading')[0]!.parentElement!
        expect(adminSection.textContent).toContain('vircs')
        expect(adminSection.textContent).toContain('desktop')
        expect(adminSection.textContent).not.toContain('WudeMac')
    })

    it('keeps a flat grid without headings when fewer than two owners exist', () => {
        renderBar({
            machines: [
                machineItem({ id: 'm-a1', label: 'vircs', owner: 'admin' }),
                machineItem({ id: 'm-x', label: 'stray' }),
            ],
        })

        expect(screen.queryAllByTestId('machine-owner-heading')).toHaveLength(0)
    })

    it('opens the alias dialog from the context menu and submits the new name', async () => {
        const onRenameMachine = vi.fn().mockResolvedValue(undefined)
        renderBar({ onRenameMachine })

        fireEvent.contextMenu(screen.getByRole('button', { name: /Mint 3/ }))
        const input = await screen.findByPlaceholderText('mint.local')
        fireEvent.change(input, { target: { value: 'vircs' } })
        fireEvent.click(screen.getByRole('button', { name: 'Save' }))

        await vi.waitFor(() => expect(onRenameMachine).toHaveBeenCalledWith('machine-1', 'vircs'))
        await vi.waitFor(() => expect(screen.queryByPlaceholderText('mint.local')).toBeNull())
    })

    it('submitting an empty alias clears the custom name (falls back to hostname)', async () => {
        const onRenameMachine = vi.fn().mockResolvedValue(undefined)
        renderBar({ onRenameMachine })

        // Teemo already has displayName 'Teemo'; clearing it is a real change.
        fireEvent.contextMenu(screen.getByRole('button', { name: /Teemo 2/ }))
        const input = await screen.findByPlaceholderText('TEEMO-PC')
        fireEvent.change(input, { target: { value: '' } })
        fireEvent.click(screen.getByRole('button', { name: 'Save' }))

        await vi.waitFor(() => expect(onRenameMachine).toHaveBeenCalledWith('machine-2', ''))
    })

    it('does not open the alias dialog without a rename handler', () => {
        renderBar()

        fireEvent.contextMenu(screen.getByRole('button', { name: /Mint 3/ }))
        expect(screen.queryByRole('dialog')).toBeNull()
    })

    it('does not open the alias dialog for machines that cannot be renamed', () => {
        const onRenameMachine = vi.fn()
        renderBar({
            machines: [machineItem({ id: 'm-x', label: 'stray', sessionCount: 4 })],
            onRenameMachine,
        })

        fireEvent.contextMenu(screen.getByRole('button', { name: /stray 4/ }))
        expect(screen.queryByRole('dialog')).toBeNull()
    })
})

describe('groupMachinesByOwner', () => {
    it('preserves machine activity order inside sections and orders sections by first appearance', () => {
        const grouped = groupMachinesByOwner([
            machineItem({ id: '1', label: 'p-first', owner: 'peter' }),
            machineItem({ id: '2', label: 'a-first', owner: 'admin' }),
            machineItem({ id: '3', label: 'p-second', owner: 'peter' }),
        ])

        expect(grouped.grouped).toBe(true)
        expect(grouped.sections.map((s) => s.owner)).toEqual(['peter', 'admin'])
        expect(grouped.sections[0]!.machines.map((m) => m.label)).toEqual(['p-first', 'p-second'])
    })

    it('does not group when every machine shares one owner', () => {
        const grouped = groupMachinesByOwner([
            machineItem({ id: '1', label: 'a', owner: 'admin' }),
            machineItem({ id: '2', label: 'b', owner: 'admin' }),
        ])

        expect(grouped.grouped).toBe(false)
        expect(grouped.sections).toHaveLength(1)
    })
})

describe('MachineFilterMenu', () => {
    it('renders a compact icon button only below the md breakpoint', () => {
        const { container } = renderMenu()

        const button = screen.getByRole('button', { name: 'Filter sessions by machine' })
        expect(button.getAttribute('aria-haspopup')).toBe('menu')
        expect(button.getAttribute('aria-expanded')).toBe('false')
        expect(container.firstElementChild!.className).toContain('md:hidden')
        // Menu stays closed until the button is pressed
        expect(screen.queryByRole('menu')).toBeNull()
    })

    it('shows an active-filter dot only when a machine is selected', () => {
        const { unmount } = renderMenu()
        const button = screen.getByRole('button', { name: 'Filter sessions by machine' })
        expect(button.querySelector('span')).toBeNull()
        unmount()

        renderMenu({ value: 'machine-1' })
        expect(screen.getByRole('button', { name: 'Filter sessions by machine' }).querySelector('span')).toBeTruthy()
    })

    it('opens a radio menu listing All plus every machine with counts', () => {
        renderMenu({ value: 'machine-1' })

        fireEvent.click(screen.getByRole('button', { name: 'Filter sessions by machine' }))

        expect(screen.getByRole('button', { name: 'Filter sessions by machine' }).getAttribute('aria-expanded')).toBe('true')
        const all = screen.getByRole('menuitemradio', { name: /All \(5\)/ })
        const mint = screen.getByRole('menuitemradio', { name: /Mint \(3\)/ })
        const teemo = screen.getByRole('menuitemradio', { name: /Teemo \(2\)/ })
        expect(all.getAttribute('aria-checked')).toBe('false')
        expect(mint.getAttribute('aria-checked')).toBe('true')
        expect(teemo.getAttribute('aria-checked')).toBe('false')
    })

    it('reports machine selection and closes the menu', () => {
        const onChange = vi.fn()
        renderMenu({ onChange })

        fireEvent.click(screen.getByRole('button', { name: 'Filter sessions by machine' }))
        fireEvent.click(screen.getByRole('menuitemradio', { name: /Teemo \(2\)/ }))

        expect(onChange).toHaveBeenCalledWith('machine-2')
        expect(screen.queryByRole('menu')).toBeNull()
    })

    it('reports reset to All and closes via the backdrop', () => {
        const onChange = vi.fn()
        renderMenu({ value: 'machine-1', onChange })

        fireEvent.click(screen.getByRole('button', { name: 'Filter sessions by machine' }))
        fireEvent.click(screen.getByRole('menuitemradio', { name: /All \(5\)/ }))
        expect(onChange).toHaveBeenCalledWith(null)

        fireEvent.click(screen.getByRole('button', { name: 'Filter sessions by machine' }))
        const backdrop = screen.getByRole('button', { name: 'Close' })
        // The invisible full-screen backdrop must not be a Tab stop
        expect(backdrop.getAttribute('tabindex')).toBe('-1')
        fireEvent.click(backdrop)
        expect(screen.queryByRole('menu')).toBeNull()
    })

    it('shows a compact inline health summary (touch devices have no hover tooltip)', () => {
        renderMenu()

        fireEvent.click(screen.getByRole('button', { name: 'Filter sessions by machine' }))

        const teemo = screen.getByRole('menuitemradio', { name: /Teemo \(2\)/ })
        expect(teemo.textContent).toContain('CPU 12%')
        expect(teemo.textContent).toContain('RAM 88%')
    })

    it('clamps the menu to the viewport space remaining around the trigger', () => {
        const style = getMachineFilterMenuClampStyle({ right: 280, bottom: 100 })

        // Right-anchored menu: width is limited by the space left of the trigger
        expect(style.maxWidth).toContain('min(16rem, calc(280px')
        expect(style.maxWidth).toContain('env(safe-area-inset-left)')
        expect(style.maxHeight).toContain('min(20rem, calc(')
        // mt-1 gap (4px) below the trigger is part of the clamp
        expect(style.maxHeight).toContain('- 104px')
        expect(style.maxHeight).toContain('--app-viewport-height')
        expect(style.maxHeight).toContain('env(safe-area-inset-bottom)')
    })

    it('focuses the selected row when the menu opens', async () => {
        renderMenu({ value: 'machine-1' })

        fireEvent.click(screen.getByRole('button', { name: 'Filter sessions by machine' }))

        await vi.waitFor(() => {
            expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: /Mint \(3\)/ }))
        })
    })

    it('moves focus with Arrow keys, wrapping at both ends', async () => {
        renderMenu()

        fireEvent.click(screen.getByRole('button', { name: 'Filter sessions by machine' }))
        const all = screen.getByRole('menuitemradio', { name: /All \(5\)/ })
        await vi.waitFor(() => expect(document.activeElement).toBe(all))

        fireEvent.keyDown(document, { key: 'ArrowUp' })
        expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: /Teemo \(2\)/ }))

        fireEvent.keyDown(document, { key: 'ArrowDown' })
        expect(document.activeElement).toBe(all)

        fireEvent.keyDown(document, { key: 'ArrowDown' })
        expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: /Mint \(3\)/ }))
    })

    it('closes on Escape and restores focus to the trigger', async () => {
        renderMenu()
        const trigger = screen.getByRole('button', { name: 'Filter sessions by machine' })

        fireEvent.click(trigger)
        await vi.waitFor(() => expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: /All \(5\)/ })))

        fireEvent.keyDown(document, { key: 'Escape' })

        expect(screen.queryByRole('menu')).toBeNull()
        expect(document.activeElement).toBe(trigger)
    })
})
