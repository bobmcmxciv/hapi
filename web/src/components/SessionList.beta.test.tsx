import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { ApiClient } from '@/api/client'
import type { ReopenSessionResponse } from '@hapi/protocol/apiTypes'
import type { SessionSummary } from '@/types/api'
import { I18nProvider } from '@/lib/i18n-context'
import { ToastProvider } from '@/lib/toast-context'
import { DISABLED_SESSION_LIST_SCROLL_STABILITY } from '@/fork-features/session-list-scroll/sessionListScroll'
import { SessionList } from './SessionList'

vi.hoisted(() => { vi.stubEnv('VITE_HAPI_BETA', '1') })

function session(id: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
    return {
        id, active: true, thinking: false, activeAt: 0, updatedAt: 1000,
        metadata: { name: `Task ${id}`, path: '/project', machineId: 'machine-a', agentSessionId: `native-${id}`, flavor: 'omp' },
        metadataVersion: 0, agentStateVersion: 0, todosUpdatedAt: 0, todoProgress: null,
        pendingRequestsCount: 0, pendingRequestKinds: [], pendingRequests: [], backgroundTaskCount: 0,
        futureScheduledMessageCount: 0, nextScheduledAt: null, model: null, effort: null,
        ...overrides,
    }
}
function Providers({ children }: { children: ReactNode }) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    return <QueryClientProvider client={client}><ToastProvider><I18nProvider>{children}</I18nProvider></ToastProvider></QueryClientProvider>
}

beforeEach(() => {
    localStorage.setItem('hapi-pin-in-progress-sessions', 'false')
    localStorage.setItem('hapi-show-active-sessions-only', 'false')
    localStorage.setItem('hapi-fold-archived-sessions', 'false')
    vi.stubGlobal('ResizeObserver', class { observe() { } unobserve() { } disconnect() { } })
})
afterEach(() => {
    cleanup()
    localStorage.removeItem('hapi-pin-in-progress-sessions')
    localStorage.removeItem('hapi-show-active-sessions-only')
    localStorage.removeItem('hapi-fold-archived-sessions')
    vi.unstubAllGlobals()
})

const base = { api: null, scrollStability: DISABLED_SESSION_LIST_SCROLL_STABILITY, onRefresh: vi.fn(), isLoading: false, onNewSession: vi.fn() }

describe('wired Beta SessionList', () => {
    it('virtualizes directory headers and sessions instead of mounting all 1900 trees', () => {
        const sessions = Array.from({ length: 1900 }, (_, index) => session(String(index), { metadata: { name: `Task ${index}`, path: `/project/${index}`, agentSessionId: `native-${index}` } }))
        const view = render(<Providers><SessionList {...base} sessions={sessions} onSelect={vi.fn()} /></Providers>)
        expect(view.container.querySelector('[data-beta-sidebar]')).toBeInTheDocument()
        expect(view.container.querySelectorAll('[data-sidebar-row]').length).toBeLessThan(30)
        expect(view.container.querySelectorAll('[data-session-id]').length).toBeLessThan(20)
    })

    it('keeps directory controls, native selection and search wired to real session rows', () => {
        const onSelect = vi.fn()
        const beforeSelect = vi.fn()
        const onNewSessionInDirectory = vi.fn()
        const view = render(<Providers><SessionList {...base} scrollStability={{ ...DISABLED_SESSION_LIST_SCROLL_STABILITY, beforeSelect }} sessions={[session('first'), session('second')]} onSelect={onSelect} onNewSessionInDirectory={onNewSessionInDirectory} /></Providers>)
        fireEvent.click(screen.getByRole('button', { name: 'New session in this directory' }))
        expect(onNewSessionInDirectory).toHaveBeenCalledWith({ machineId: 'machine-a', directory: '/project' })
        fireEvent.click(view.container.querySelector<HTMLButtonElement>('[data-session-id="first"]')!)
        expect(beforeSelect).toHaveBeenCalledWith('first')
        expect(onSelect).toHaveBeenCalledWith('first')
        expect(beforeSelect.mock.invocationCallOrder[0]).toBeLessThan(onSelect.mock.invocationCallOrder[0])
        fireEvent.click(screen.getByRole('button', { name: 'Search sessions' }))
        fireEvent.change(screen.getByPlaceholderText('Search sessions…'), { target: { value: 'second' } })
        expect(view.container.querySelector('[data-session-id="first"]')).toBeNull()
        expect(view.container.querySelector('[data-session-id="second"]')).toBeInTheDocument()
    })

    it('offers touch-visible actions and retains the existing rename/export/archive and reference menu', () => {
        const view = render(<Providers><SessionList {...base} sessions={[session('first')]} onSelect={vi.fn()} /></Providers>)
        const row = view.container.querySelector('[data-sidebar-row="first"]')
        expect(row).not.toBeNull()
        const actions = row?.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')
        expect(actions).not.toBeNull()
        fireEvent.click(actions!)
        const menu = screen.getByRole('menu')
        expect(within(menu).getAllByRole('menuitem').length).toBeGreaterThanOrEqual(4)
        expect(within(menu).getByRole('menuitem', { name: 'Export conversation' })).toBeInTheDocument()
        expect(within(menu).getByRole('menuitem', { name: /Rename/ })).toBeInTheDocument()
        expect(within(menu).getByRole('menuitem', { name: /Archive/ })).toBeInTheDocument()
        expect(actions).toHaveAttribute('aria-expanded', 'true')
    })

    it('supports context menus and waits for archived native reopen before selection', async () => {
        const onSelect = vi.fn()
        const readiness = Promise.withResolvers<ReopenSessionResponse>()
        const reopenSession = vi.fn(() => readiness.promise)
        const api = { reopenSession, getFlavorCapabilities: async () => ({ capabilities: {} }) } as unknown as ApiClient
        const view = render(<Providers><SessionList {...base} api={api} sessions={[session('archived', { active: false })]} selectedSessionId="archived" onSelect={onSelect} /></Providers>)
        const row = view.container.querySelector<HTMLButtonElement>('[data-session-id="archived"]')
        expect(row).not.toBeNull()
        fireEvent.contextMenu(row!, { clientX: 25, clientY: 40 })
        const menu = screen.getByRole('menu')
        expect(within(menu).getByRole('menuitem', { name: /Reopen/ })).toBeInTheDocument()
        fireEvent.click(within(menu).getByRole('menuitem', { name: /Reopen/ }))
        await waitFor(() => expect(reopenSession).toHaveBeenCalledWith('archived'))
        expect(onSelect).not.toHaveBeenCalled()
        await act(async () => { readiness.resolve({ ok: true, sessionId: 'archived', resumed: true }) })
        await waitFor(() => expect(onSelect).toHaveBeenCalledWith('archived'))
    })

    it('opens the original action menu on long press without selecting the session', () => {
        vi.useFakeTimers()
        try {
            const onSelect = vi.fn()
            const view = render(<Providers><SessionList {...base} sessions={[session('touch')]} onSelect={onSelect} /></Providers>)
            const row = view.container.querySelector<HTMLButtonElement>('[data-session-id="touch"]')!
            fireEvent.touchStart(row, { touches: [{ clientX: 20, clientY: 30 }] })
            act(() => { vi.advanceTimersByTime(500) })
            fireEvent.touchEnd(row)
            fireEvent.click(row)
            expect(screen.getByRole('menu')).toBeInTheDocument()
            expect(onSelect).not.toHaveBeenCalled()
        } finally {
            vi.useRealTimers()
        }
    })
    it('keeps pinned work, unread and active-only filters in the actual Beta presentation', () => {
        localStorage.setItem('hapi-pin-in-progress-sessions', 'true')
        localStorage.setItem('hapi-show-active-sessions-only', 'true')
        localStorage.setItem('hapi.sessionLastSeen.v1', JSON.stringify({ seen: 1000 }))
        const view = render(<Providers><SessionList {...base} sessions={[session('working', { thinking: true }), session('seen'), session('archived', { active: false })]} onSelect={vi.fn()} /></Providers>)
        fireEvent.click(view.container.querySelector<HTMLButtonElement>('[data-project-mode="directories"]')!)
        expect(view.container.querySelector('[data-sidebar-row="section:running"]')).toBeInTheDocument()
        expect(view.container.querySelector('[data-session-id="working"]')).toBeInTheDocument()
        expect(view.container.querySelector('[data-session-id="archived"]')).toBeNull()
        fireEvent.click(screen.getByRole('button', { name: 'Unread only' }))
        expect(view.container.querySelector('[data-session-id="seen"]')).toBeNull()
        expect(view.container.querySelector('[data-session-id="working"]')).toBeInTheDocument()
        localStorage.removeItem('hapi.sessionLastSeen.v1')
    })

    it('applies the calendar range without expanding search', () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date(2026, 6, 18, 12))
        try {
            const view = render(<Providers><SessionList {...base} sessions={[session('recent', { updatedAt: Date.now() }), session('old', { updatedAt: new Date(2020, 0, 1).getTime() })]} onSelect={vi.fn()} /></Providers>)
            fireEvent.click(screen.getByRole('button', { name: 'Filter sessions by last activity' }))
            fireEvent.click(screen.getByRole('button', { name: new Date(2026, 6, 17).toLocaleDateString() }))
            fireEvent.click(screen.getByRole('button', { name: `${new Date(2026, 6, 18).toLocaleDateString()}, has session activity` }))
            expect(view.container.querySelector('[data-session-id="recent"]')).toBeInTheDocument()
            expect(view.container.querySelector('[data-session-id="old"]')).toBeNull()
            expect(screen.queryByPlaceholderText('Search sessions…')).toBeNull()
        } finally {
            vi.useRealTimers()
        }
    })

    it('aggregates real origins and requires an explicit source before creating a multi-machine session', () => {
        const onNewSessionInDirectory = vi.fn()
        const sessions = [
            session('win', { metadata: { name: 'Windows task', machineId: 'win', path: 'C:\\code\\hapi', flavor: 'omp' } }),
            session('linux', { metadata: { name: 'Linux task', machineId: 'linux', path: '/srv/code/hapi', flavor: 'omp' } }),
        ]
        const view = render(<Providers><SessionList {...base} sessions={sessions} onSelect={vi.fn()} machineOwnersById={{ win: 'alice', linux: 'alice' }} machineLabelsById={{ win: 'Windows', linux: 'Linux' }} onNewSessionInDirectory={onNewSessionInDirectory} /></Providers>)
        expect(view.container.querySelectorAll('[data-project-key]')).toHaveLength(1)
        expect(view.container.querySelector('[data-session-id="win"]')).toBeInTheDocument()
        expect(view.container.querySelector('[data-session-id="linux"]')).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'New session in this directory' }))
        expect(onNewSessionInDirectory).not.toHaveBeenCalled()
        const dialog = screen.getByRole('dialog')
        expect(within(dialog).getByText('Windows: C:\\code\\hapi · 1')).toBeInTheDocument()
        expect(within(dialog).getByText('Linux: /srv/code/hapi · 1')).toBeInTheDocument()
        fireEvent.click(within(dialog).getAllByRole('button', { name: 'New session in this directory' })[1]!)
        expect(onNewSessionInDirectory).toHaveBeenCalledWith({ machineId: 'linux', directory: '/srv/code/hapi' })
    })

    it('keeps favorites, all-collapse and explicit project folds through status updates', () => {
        const sessions = [session('one', { metadata: { name: 'First', path: '/code/one', machineId: 'a' } }), session('two', { metadata: { name: 'Second', path: '/code/two', machineId: 'a' } })]
        const renderList = (rows: SessionSummary[]) => <Providers><SessionList {...base} sessions={rows} onSelect={vi.fn()} sidebarPreferenceScope="test-hub|alice" /></Providers>
        const view = render(renderList(sessions))
        const firstProject = view.container.querySelector('[data-project-key]')!
        fireEvent.click(firstProject.querySelector<HTMLButtonElement>('button[aria-pressed]')!)
        fireEvent.click(view.container.querySelector<HTMLButtonElement>('[data-project-mode="favorites"]')!)
        expect(view.container.querySelectorAll('[data-project-key]')).toHaveLength(1)
        expect(view.container.querySelector('[data-session-id="one"]')).toBeInTheDocument()
        expect(view.container.querySelector('[data-session-id="two"]')).toBeNull()
        fireEvent.click(view.container.querySelector<HTMLButtonElement>('[data-project-mode="projects"]')!)
        fireEvent.click(screen.getByTestId('beta-project-collapse-all'))
        expect(view.container.querySelectorAll('[data-session-id]')).toHaveLength(0)
        view.rerender(renderList(sessions.map(row => ({ ...row, thinking: true, updatedAt: row.updatedAt + 100 }))))
        expect(view.container.querySelectorAll('[data-session-id]')).toHaveLength(0)
        expect(view.container.querySelectorAll('[data-project-toggle][aria-expanded="false"]')).toHaveLength(2)
        fireEvent.click(view.container.querySelector<HTMLButtonElement>('[data-project-toggle]')!)
        expect(view.container.querySelector('[data-session-id="one"]')).toBeInTheDocument()
        view.rerender(renderList(sessions.map(row => ({ ...row, updatedAt: row.updatedAt + 200 }))))
        expect(view.container.querySelector('[data-session-id="one"]')).toBeInTheDocument()
        localStorage.removeItem('hapi.beta.projects.v1:test-hub|alice')
    })

    it('collects miscellaneous sessions without deleting home-directory projects or their original actions', () => {
        const sessions = [session('home', { metadata: { name: 'Home task', path: '/home/alice', machineId: 'a' } }), session('probe', { metadata: { name: 'Probe task', path: '/tmp/live-probe', machineId: 'a' } }), session('named', { metadata: { name: 'Named project', path: '/home/alice/hapi', machineId: 'a' } })]
        const view = render(<Providers><SessionList {...base} sessions={sessions} onSelect={vi.fn()} /></Providers>)
        expect(view.container.querySelector('[data-session-id="named"]')).toBeInTheDocument()
        expect(view.container.querySelector('[data-session-id="home"]')).toBeNull()
        expect(view.container.querySelector('[data-session-id="probe"]')).toBeNull()
        fireEvent.click(screen.getByTestId('beta-project-miscellaneous'))
        expect(view.container.querySelector('[data-session-id="home"]')).toBeInTheDocument()
        expect(view.container.querySelector('[data-session-id="probe"]')).toBeInTheDocument()
        const row = view.container.querySelector('[data-sidebar-row="home"]')!
        fireEvent.click(row.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!)
        expect(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Export conversation' })).toBeInTheDocument()
    })

    it('copies an explicitly selected real origin and saves only a local project alias', async () => {
        const writeText = vi.fn(async (_path: string) => { })
        const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
        try {
            const sessions = [session('win', { metadata: { name: 'Win', machineId: 'win', path: 'C:\\code\\hapi' } }), session('linux', { metadata: { name: 'Linux', machineId: 'linux', path: '/srv/hapi' } })]
            const view = render(<Providers><SessionList {...base} sessions={sessions} onSelect={vi.fn()} machineOwnersById={{ win: 'alice', linux: 'alice' }} sidebarPreferenceScope="test-hub|alice" /></Providers>)
            fireEvent.click(screen.getByRole('button', { name: 'Project actions for hapi' }))
            const dialog = screen.getByRole('dialog')
            const linuxSource = within(dialog).getByText('linux: /srv/hapi · 1').parentElement!
            fireEvent.click(within(linuxSource).getByRole('button', { name: 'Copy path' }))
            await waitFor(() => expect(writeText).toHaveBeenCalledWith('/srv/hapi'))
            expect(writeText).toHaveBeenCalledTimes(1)
            fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: '本地项目名' } })
            fireEvent.click(within(dialog).getByRole('button', { name: 'Save alias' }))
            expect(view.container.querySelector('[data-project-toggle]')).toHaveTextContent('本地项目名')
            expect(sessions[0]!.metadata!.path).toBe('C:\\code\\hapi')
            expect(sessions[1]!.metadata!.path).toBe('/srv/hapi')
        } finally {
            if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard)
            else Reflect.deleteProperty(navigator, 'clipboard')
            localStorage.removeItem('hapi.beta.projects.v1:test-hub|alice')
        }
    })
})
