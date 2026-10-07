import { beforeEach, describe, expect, it } from 'vitest'
import {
    MAX_SESSION_TABS,
    __resetSessionTabsForTests,
    closeOtherTabs,
    closeTab,
    closeTabsToRight,
    moveTab,
    openTab,
    pruneTabs,
    togglePinTab,
    updateSessionTabs,
    type SessionTabsState
} from './sessionTabsStore'

const ids = (state: SessionTabsState) => state.tabs.map(tab => tab.id)
const open = (...list: string[]) => list.reduce<SessionTabsState>((state, id, index) => openTab(state, id, index + 1), { tabs: [] })

describe('session tabs', () => {
    beforeEach(() => {
        localStorage.clear()
        __resetSessionTabsForTests()
    })

    it('appends new sessions and keeps the order when an existing tab is re-opened', () => {
        let state = open('a', 'b', 'c')
        state = openTab(state, 'a', 99)
        expect(ids(state)).toEqual(['a', 'b', 'c'])
        expect(state.tabs[0]!.activatedAt).toBe(99)
    })

    it('evicts the least recently activated unpinned tab beyond the limit, never the one being opened', () => {
        let state = open(...Array.from({ length: MAX_SESSION_TABS }, (_, i) => `s${i}`))
        state = togglePinTab(state, 's0')
        state = openTab(state, 's1', 1000)
        state = openTab(state, 'new', 1001)
        expect(state.tabs).toHaveLength(MAX_SESSION_TABS)
        expect(ids(state)).toContain('s0')
        expect(ids(state)).toContain('s1')
        expect(ids(state)).not.toContain('s2')
        expect(ids(state).at(-1)).toBe('new')
    })

    it('closing picks the right neighbour, then the left one', () => {
        const state = open('a', 'b', 'c')
        expect(closeTab(state, 'b')).toMatchObject({ neighbor: 'c' })
        expect(closeTab(state, 'c')).toMatchObject({ neighbor: 'b' })
        expect(closeTab(open('a'), 'a')).toMatchObject({ neighbor: null })
        expect(ids(closeTab(state, 'missing').state)).toEqual(['a', 'b', 'c'])
    })

    it('pins move to the front, close-others and close-to-right keep pinned tabs', () => {
        let state = open('a', 'b', 'c', 'd')
        state = togglePinTab(state, 'c')
        expect(ids(state)).toEqual(['c', 'a', 'b', 'd'])
        expect(ids(closeOtherTabs(state, 'b'))).toEqual(['c', 'b'])
        expect(ids(closeTabsToRight(state, 'a'))).toEqual(['c', 'a'])
        // 取消固定后留在非固定区的最前面（与浏览器一致），而不是跳回固定前的位置。
        state = togglePinTab(state, 'c')
        expect(ids(state)).toEqual(['c', 'a', 'b', 'd'])
        expect(state.tabs.every(tab => !tab.pinned)).toBe(true)
    })

    it('drag reorders within the same pin group only', () => {
        let state = open('a', 'b', 'c')
        expect(ids(moveTab(state, 'c', 'a'))).toEqual(['c', 'a', 'b'])
        state = togglePinTab(state, 'b')
        expect(ids(moveTab(state, 'c', 'b'))).toEqual(['b', 'a', 'c'])
    })

    it('prunes tabs whose session no longer exists', () => {
        const state = open('a', 'b')
        expect(ids(pruneTabs(state, new Set(['b'])))).toEqual(['b'])
        expect(pruneTabs(state, new Set(['a', 'b']))).toBe(state)
    })

    it('persists per scope in localStorage', () => {
        updateSessionTabs('hub|1', state => openTab(state, 'x', 1))
        updateSessionTabs('hub|2', state => openTab(state, 'y', 1))
        expect(JSON.parse(localStorage.getItem('hapi-session-tabs:hub|1')!).tabs.map((tab: { id: string }) => tab.id)).toEqual(['x'])
        expect(JSON.parse(localStorage.getItem('hapi-session-tabs:hub|2')!).tabs.map((tab: { id: string }) => tab.id)).toEqual(['y'])
    })
})
