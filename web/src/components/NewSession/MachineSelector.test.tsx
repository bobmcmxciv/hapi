import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Machine, MachineWithOwner } from '@/types/api'
import { MachineSelector } from './MachineSelector'
import { I18nProvider } from '@/lib/i18n-context'

afterEach(cleanup)

function machine(id: string, overrides: Partial<MachineWithOwner> = {}): MachineWithOwner {
    return {
        id,
        namespace: 'default',
        seq: 1,
        createdAt: 0,
        updatedAt: 0,
        active: true,
        activeAt: 0,
        metadata: { host: id, platform: 'win32', happyCliVersion: '0.27.0' },
        metadataVersion: 1,
        runnerState: null,
        runnerStateVersion: 0,
        ...overrides
    } as MachineWithOwner
}

function renderSelector(props: Partial<Parameters<typeof MachineSelector>[0]> = {}) {
    return render(
        <I18nProvider>
            <MachineSelector
                machines={[]}
                machineId={null}
                isDisabled={false}
                onChange={() => {}}
                {...props}
            />
        </I18nProvider>
    )
}

describe('MachineSelector', () => {
    beforeEach(() => {
        window.localStorage.clear()
    })

    // Was a bare `<select>` of "name (platform)": no owner, no OS, no figures.
    it('shows an OS icon and the machine session count per machine', () => {
        renderSelector({
            machines: [machine('vircs'), machine('mac', { metadata: { host: 'mac', platform: 'darwin', happyCliVersion: '0.27.0' } })],
            sessionCountByMachineId: { vircs: 12, mac: 3 }
        })

        expect(screen.getByRole('button', { name: /vircs/ }).textContent).toContain('12')
        expect(screen.getByRole('button', { name: /mac/ }).textContent).toContain('3')
        expect(document.querySelectorAll('[data-os="win32"]').length).toBe(1)
        expect(document.querySelectorAll('[data-os="darwin"]').length).toBe(1)
    })

    it('groups machines under their owner once two owners are visible', () => {
        renderSelector({
            machines: [
                machine('vircs', { ownerUsername: 'admin' }),
                machine('peter-mac', { ownerUsername: 'peter' })
            ]
        })

        expect(screen.getAllByTestId('machine-owner-heading').map((n) => n.textContent)).toEqual(['admin', 'peter'])
    })

    // A single-user hub should not sprout a section heading that says nothing.
    it('stays flat with only one owner', () => {
        renderSelector({ machines: [machine('vircs', { ownerUsername: 'admin' }), machine('other', { ownerUsername: 'admin' })] })

        expect(screen.queryAllByTestId('machine-owner-heading')).toHaveLength(0)
    })

    it('selects a machine on click and marks the current one pressed', () => {
        const onChange = vi.fn()
        renderSelector({ machines: [machine('vircs'), machine('mac')], machineId: 'vircs', onChange })

        expect(screen.getByRole('button', { name: /vircs/ }).getAttribute('aria-pressed')).toBe('true')
        fireEvent.click(screen.getByRole('button', { name: /mac/ }))
        expect(onChange).toHaveBeenCalledWith('mac')
    })

    it('does not fire a selection while the form is disabled', () => {
        const onChange = vi.fn()
        renderSelector({ machines: [machine('vircs')], isDisabled: true, onChange })

        fireEvent.click(screen.getByRole('button', { name: /vircs/ }))
        expect(onChange).not.toHaveBeenCalled()
    })

    it('falls back to the remembered owner when the machine arrives undecorated', () => {
        // Same stability guarantee as the sidebar: ownership only ever rides on
        // /api/machines, so a gap in it must not flatten the grouping.
        window.localStorage.setItem('hapi-machine-owners', JSON.stringify({ vircs: 'admin', 'peter-mac': 'peter' }))
        renderSelector({ machines: [machine('vircs'), machine('peter-mac')] })

        expect(screen.getAllByTestId('machine-owner-heading').map((n) => n.textContent)).toEqual(['admin', 'peter'])
    })

    it('reports an empty fleet instead of rendering an empty grid', () => {
        renderSelector({ machines: [] })
        expect(screen.getByText(/no machines/i)).toBeTruthy()
    })
})
