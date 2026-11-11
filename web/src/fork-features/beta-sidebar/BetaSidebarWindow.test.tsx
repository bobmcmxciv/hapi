import { memo, useRef } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BetaSidebarWindow } from './BetaSidebarWindow'
import { sameSidebarValue } from './sidebarWindow'

type Row = { id: string; title: string; focusable?: boolean }
const rows: Row[] = Array.from({ length: 1900 }, (_, index) => ({ id: `s-${index}`, title: `Session ${index}` }))
const renders = new Map<string, number>()
const measuredHeights = new Map<string, number>()
const resizeCallbacks = new Map<Element, () => void>()
const RowButton = memo(function RowButton({ row }: { row: Row }) {
    renders.set(row.id, (renders.get(row.id) ?? 0) + 1)
    return <button>{row.title}</button>
}, sameSidebarValue)

function Harness(props: { rows?: Row[]; resetKey?: string; pinnedIds?: string[] }) {
    const ref = useRef<HTMLDivElement>(null)
    return <div ref={ref} data-testid="viewport" style={{ height: 640, overflow: 'auto' }}>
        <BetaSidebarWindow rows={props.rows ?? rows} resetKey={props.resetKey ?? ''} scrollRef={ref} pinnedIds={props.pinnedIds ?? []} renderRow={row => row.focusable === false ? <span>{row.title}</span> : <RowButton row={row} />} />
    </div>
}

beforeEach(() => {
    renders.clear()
    measuredHeights.clear()
    resizeCallbacks.clear()
    const originalRect = HTMLElement.prototype.getBoundingClientRect
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function(this: HTMLElement) {
        if (!this.dataset.sidebarRow && this.dataset.testid !== 'viewport') return originalRect.call(this)
        const height = this.dataset.sidebarRow ? measuredHeights.get(this.dataset.sidebarRow) ?? 64 : 640
        return new DOMRect(0, 0, 320, height)
    })
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function(this: HTMLElement) {
        return this.dataset.testid === 'viewport' ? 640 : 0
    })
    vi.stubGlobal('ResizeObserver', class {
        private readonly elements = new Set<Element>()
        constructor(private readonly callback: () => void) { }
        observe(element: Element) {
            this.elements.add(element)
            resizeCallbacks.set(element, this.callback)
        }
        unobserve(element: Element) {
            this.elements.delete(element)
            resizeCallbacks.delete(element)
        }
        disconnect() {
            for (const element of this.elements) resizeCallbacks.delete(element)
            this.elements.clear()
        }
    })
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('Beta sidebar measured window', () => {
    it('mounts a bounded window out of 1900 sessions and reaches the tail by scrolling', () => {
        render(<Harness />)
        expect(screen.getAllByRole('button').length).toBeLessThan(30)
        expect(screen.getByTestId('viewport').firstElementChild).toHaveStyle({ height: `${1900 * 64}px` })
        expect(screen.queryByText('Session 1899')).toBeNull()
        const viewport = screen.getByTestId('viewport')
        viewport.scrollTop = 1890 * 64
        fireEvent.scroll(viewport)
        expect(screen.getByText('Session 1899')).toBeInTheDocument()
        expect(screen.getAllByRole('button').length).toBeLessThan(30)
    })

    it('retains the exact anchor and offset when rows are inserted above it', () => {
        const view = render(<Harness />)
        const viewport = screen.getByTestId('viewport')
        viewport.scrollTop = 500 * 64 + 17
        fireEvent.scroll(viewport)
        view.rerender(<Harness rows={[{ id: 'new', title: 'Inserted' }, ...rows]} />)
        expect(viewport.scrollTop).toBe(501 * 64 + 17)
        expect(screen.getByText('Session 500')).toBeInTheDocument()
    })

    it('preserves the anchor pixel when a measured row above it grows', () => {
        const view = render(<Harness />)
        const viewport = screen.getByTestId('viewport')
        viewport.scrollTop = 500 * 64 + 17
        fireEvent.scroll(viewport)
        const anchor = view.container.querySelector<HTMLElement>('[data-sidebar-row="s-500"]')!
        const before = Number.parseFloat(anchor.style.top) - viewport.scrollTop
        const resized = view.container.querySelector<HTMLElement>('[data-sidebar-row="s-495"]')!
        expect(resized).not.toBeNull()
        act(() => {
            measuredHeights.set('s-495', 100)
            resizeCallbacks.get(resized)!()
        })
        expect(viewport.scrollTop).toBe(500 * 64 + 17 + 36)
        expect(Number.parseFloat(anchor.style.top) - viewport.scrollTop).toBe(before)
        expect(screen.getByText('Session 500')).toBeInTheDocument()
    })

    it('resets the viewport on filtering and restores rows after clearing a filter', () => {
        const view = render(<Harness />)
        const viewport = screen.getByTestId('viewport')
        viewport.scrollTop = 500 * 64
        fireEvent.scroll(viewport)
        view.rerender(<Harness rows={[rows[1200]]} resetKey="search:1200" />)
        expect(viewport.scrollTop).toBe(0)
        expect(screen.getAllByRole('button')).toHaveLength(1)
        expect(screen.getByText('Session 1200')).toBeInTheDocument()
        view.rerender(<Harness resetKey="" />)
        expect(screen.getByText('Session 0')).toBeInTheDocument()
    })

    it('pins an interaction without mounting the intervening 1800 rows', () => {
        const view = render(<Harness pinnedIds={['s-0']} />)
        const viewport = screen.getByTestId('viewport')
        viewport.scrollTop = 1800 * 64
        fireEvent.scroll(viewport)
        expect(screen.getByText('Session 0')).toBeInTheDocument()
        expect(screen.getByText('Session 1800')).toBeInTheDocument()
        expect(screen.getAllByRole('button').length).toBeLessThan(30)
        view.rerender(<Harness />)
        expect(screen.queryByText('Session 0')).toBeNull()
    })

    it('preserves focus across scrolling and can navigate to the last row using End', () => {
        render(<Harness />)
        act(() => screen.getByText('Session 0').focus())
        const viewport = screen.getByTestId('viewport')
        viewport.scrollTop = 1000 * 64
        fireEvent.scroll(viewport)
        expect(screen.getByText('Session 0')).toHaveFocus()
        expect(screen.getByText('Session 1000')).toBeInTheDocument()
        expect(screen.getAllByRole('button').length).toBeLessThan(30)
        fireEvent.keyDown(screen.getByText('Session 0'), { key: 'End' })
        expect(screen.getByText('Session 1899')).toHaveFocus()
        expect(screen.getAllByRole('button').length).toBeLessThan(30)
        fireEvent.keyDown(screen.getByText('Session 1899'), { key: 'Home' })
        expect(screen.getByText('Session 0')).toHaveFocus()
    })

    it('skips noninteractive bucket labels during arrow navigation', () => {
        render(<Harness rows={[rows[0], { id: 'label', title: 'Working', focusable: false }, rows[1]]} />)
        act(() => screen.getByText('Session 0').focus())
        fireEvent.keyDown(screen.getByText('Session 0'), { key: 'ArrowDown' })
        expect(screen.getByText('Session 1')).toHaveFocus()
    })

    it('does not rerender stable row bodies when a different entity changes or a snapshot is cloned', () => {
        const view = render(<Harness />)
        const before = renders.get('s-1')
        view.rerender(<Harness rows={rows.map(row => ({ ...row, title: row.id === 's-0' ? 'Updated' : row.title }))} />)
        expect(screen.getByText('Updated')).toBeInTheDocument()
        expect(renders.get('s-1')).toBe(before)
    })
})
