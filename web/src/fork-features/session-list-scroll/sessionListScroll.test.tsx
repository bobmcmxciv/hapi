import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSessionListScrollStability, type SessionListScrollStabilityMode } from './sessionListScroll'

function Fixture({ revision, mode = 'all' }: { revision: number; mode?: SessionListScrollStabilityMode }) {
    const stability = useSessionListScrollStability('/sessions/selected', mode)
    return <>
        <button onClick={() => stability.beforeSelect('selected')}>Select session</button>
        <div ref={stability.bindContainer} data-testid="scroll-owner" data-revision={revision}>
            <div data-session-id="selected" data-testid="selected-row">Selected row</div>
        </div>
    </>
}

beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
    vi.stubGlobal('CSS', { escape: (value: string) => value })
})
afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
})

async function setup(mode: SessionListScrollStabilityMode = 'all') {
    const view = render(<Fixture revision={0} mode={mode} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(40) })
    const container = screen.getByTestId('scroll-owner')
    const row = screen.getByTestId('selected-row')
    let contentTop = 1000
    vi.spyOn(container, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, 100, 200, 400))
    vi.spyOn(row, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, 100 + contentTop - container.scrollTop, 200, 40))
    container.scrollTop = 300
    fireEvent.click(screen.getByRole('button', { name: 'Select session' }))
    return { container, render: () => view.rerender(<Fixture revision={1} mode={mode} />), moveRow: (delta: number) => { contentTop += delta } }
}

describe('sidebar scroll ownership during live updates', () => {
    it('does not undo native scrolling without a preceding wheel or pointer event', async () => {
        const fixture = await setup()
        fixture.container.scrollTop = 500
        fireEvent.scroll(fixture.container)
        fixture.render()
        expect(fixture.container.scrollTop).toBe(500)
    })

    it('compensates only row layout movement while retaining the newer scroll position', async () => {
        const fixture = await setup()
        fixture.container.scrollTop = 500
        fireEvent.scroll(fixture.container)
        fixture.moveRow(40)
        fixture.render()
        expect(fixture.container.scrollTop).toBe(540)
    })

    it('leaves geometry correction to the virtual list in preserve-only mode', async () => {
        const fixture = await setup('preserve-only')
        fixture.container.scrollTop = 500
        fixture.moveRow(40)
        fixture.render()
        expect(fixture.container.scrollTop).toBe(500)
    })
})
