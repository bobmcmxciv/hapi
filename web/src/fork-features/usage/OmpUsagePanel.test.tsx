import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OmpUsageReport, OmpUsageResponse } from '@hapi/protocol/ompUsage'
import { OMP_USAGE_MAX_AGE_MS } from '@hapi/protocol/ompUsage'
import type { MachineWithOwner } from '@/types/api'
import { ApiClient } from '@/api/client'
import { AppContextProvider } from '@/lib/app-context'
import { I18nContext } from '@/lib/i18n-context'
import { SubscriptionUsageSection } from './OmpUsagePanel'

const clients: QueryClient[] = []
afterEach(() => {
    cleanup()
    clients.splice(0).forEach(client => client.clear())
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    window.localStorage.clear()
})

function machine(id: string, active = true, omp = true): MachineWithOwner {
    return {
        id, active, namespace: 'test', seq: 1, createdAt: 1, updatedAt: 1, activeAt: 1,
        metadata: { host: `host-${id}`, capabilities: { omp } }, metadataVersion: 1,
        runnerState: null, runnerStateVersion: 0
    }
}

function report(fetchedAt = Date.now()): OmpUsageReport {
    return {
        provider: 'extension-provider', accountId: 'opaque-account', fetchedAt,
        limits: [{
            id: 'weekly', label: 'Weekly pool', scope: { shared: true, sharedGroup: 'all-models' },
            window: { id: 'week', label: 'Week' },
            amount: { unit: 'requests', remaining: 0, limit: 100, used: 100, remainingFraction: 0 }, status: 'exhausted'
        }]
    }
}

function response(reports = [report()]): OmpUsageResponse {
    return { success: true, source: 'omp-native', generatedAt: Date.now(), reports, accountsWithoutUsage: [], disabledCredentialCount: 0 }
}

function setup(machines = [machine('a'), machine('b')], cached?: OmpUsageResponse) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    clients.push(client)
    if (cached) client.setQueryData(['omp-native-usage', 'http://hub', 7, machines[0]?.id], cached)
    const api = new ApiClient('jwt', { baseUrl: 'http://hub' })
    const view = render(
        <QueryClientProvider client={client}>
            <AppContextProvider value={{ api, token: 'jwt', baseUrl: 'http://hub', user: { id: 7, role: 'admin' } }}>
                <I18nContext.Provider value={{ t: key => key, locale: 'en', setLocale: () => { } }}>
                    <SubscriptionUsageSection machines={machines} />
                </I18nContext.Provider>
            </AppContextProvider>
        </QueryClientProvider>
    )
    return { ...view, client }
}

function mockFetch(body: OmpUsageResponse = response()) {
    const fetcher = vi.fn(async (_input: RequestInfo | URL) => new Response(JSON.stringify(body)))
    vi.stubGlobal('fetch', fetcher)
    return fetcher
}

describe('OMP native subscription usage', () => {
    it('defaults to one available OMP machine, switches explicitly, preserves zero and shared pools', async () => {
        const fetcher = mockFetch()
        setup([machine('offline', false), machine('non-omp', true, false), machine('a'), machine('b')])
        const source = screen.getByRole('combobox', { name: 'ompUsage.source' }) as HTMLSelectElement
        const target = screen.getByRole('combobox', { name: 'ompUsage.machine' }) as HTMLSelectElement
        expect(source.value).toBe('omp-native')
        expect(Array.from(target.options, option => option.value)).toEqual(['a', 'b'])
        expect(target.value).toBe('a')
        expect((await screen.findByTestId('omp-amount-remaining')).getAttribute('value')).toBe('0')
        expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('100')
        expect(screen.getAllByTestId('omp-shared-pool')).toHaveLength(1)
        expect(fetcher).toHaveBeenCalledTimes(1)
        expect(fetcher.mock.calls[0]?.[0]).toBe('http://hub/api/subscription/omp/a')
        fireEvent.change(target, { target: { value: 'b' } })
        await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2))
        expect(fetcher.mock.calls[1]?.[0]).toBe('http://hub/api/subscription/omp/b')
        fireEvent.change(target, { target: { value: 'a' } })
        expect(fetcher).toHaveBeenCalledTimes(2)
        fireEvent.click(screen.getByRole('button', { name: 'ompUsage.refresh' }))
        await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3))
    })

    it('requests no native endpoint when no online OMP machine is available', () => {
        const fetcher = mockFetch()
        setup([machine('offline', false), machine('other', true, false)])
        expect((screen.getByRole('combobox', { name: 'ompUsage.machine' }) as HTMLSelectElement).disabled).toBe(true)
        expect((screen.getByRole('button', { name: 'ompUsage.refresh' }) as HTMLButtonElement).disabled).toBe(true)
        expect(fetcher).not.toHaveBeenCalled()
    })

    it('hides old fetchedAt even inside a freshly generated envelope and hides reset windows', () => {
        const fetcher = mockFetch()
        const old = report(Date.now() - OMP_USAGE_MAX_AGE_MS - 1)
        const reset = report()
        reset.limits[0]!.window!.resetsAt = Date.now() - 1
        setup([machine('a')], response([old, reset]))
        expect(screen.queryByTestId('omp-limit')).toBeNull()
        expect(screen.getByTestId('omp-hidden-stale')).toBeTruthy()
        expect(screen.getAllByTestId('omp-fetched-at')).toHaveLength(1)
        expect(fetcher).not.toHaveBeenCalled()
    })

    it('expires visible amounts while open without polling the machine or fetching on focus/reconnect', async () => {
        vi.useFakeTimers()
        const fetcher = mockFetch()
        const snapshot = report(Date.now() - OMP_USAGE_MAX_AGE_MS + 2_000)
        snapshot.limits[0]!.window!.resetsAt = Date.now() + 1_000
        setup([machine('a')], response([snapshot]))
        expect(screen.getByTestId('omp-limit')).toBeTruthy()
        await act(async () => { await vi.advanceTimersByTimeAsync(1_001) })
        expect(screen.queryByTestId('omp-limit')).toBeNull()
        expect(screen.getByTestId('omp-fetched-at')).toBeTruthy()
        await act(async () => { await vi.advanceTimersByTimeAsync(OMP_USAGE_MAX_AGE_MS) })
        expect(screen.queryByTestId('omp-fetched-at')).toBeNull()
        await act(async () => {
            window.dispatchEvent(new Event('focus'))
            window.dispatchEvent(new Event('online'))
            await vi.advanceTimersByTimeAsync(100)
        })
        expect(fetcher).not.toHaveBeenCalled()
    })

    it('renders a failure without disclosing native diagnostics or old quota values', async () => {
        mockFetch({ success: false, source: 'omp-native', errorCode: 'command_failed', error: 'private diagnostic must not be rendered' })
        setup()
        expect(await screen.findByRole('alert')).toBeTruthy()
        expect(screen.queryByTestId('omp-limit')).toBeNull()
        expect(screen.queryByText('private diagnostic must not be rendered')).toBeNull()
    })

    it('treats an old hub or runner HTTP endpoint as unsupported and allows a manual retry', async () => {
        const fetcher = vi.fn()
            .mockResolvedValueOnce(new Response('{}', { status: 404 }))
            .mockResolvedValueOnce(new Response(JSON.stringify(response())))
        vi.stubGlobal('fetch', fetcher)
        setup()
        await screen.findByRole('alert')
        expect(fetcher).toHaveBeenCalledTimes(1)
        fireEvent.click(screen.getByRole('button', { name: 'ompUsage.refresh' }))
        await screen.findByTestId('omp-limit')
        expect(screen.queryByRole('alert')).toBeNull()
    })

    it('does not retain successful amounts after a refresh failure', async () => {
        const fetcher = vi.fn()
            .mockResolvedValueOnce(new Response(JSON.stringify(response())))
            .mockResolvedValueOnce(new Response('{}', { status: 503 }))
        vi.stubGlobal('fetch', fetcher)
        setup()
        await screen.findByTestId('omp-limit')
        fireEvent.click(screen.getByRole('button', { name: 'ompUsage.refresh' }))
        await screen.findByRole('alert')
        expect(screen.queryByTestId('omp-limit')).toBeNull()
    })

    it('keeps a successful empty response distinct from a command failure', async () => {
        mockFetch(response([]))
        setup()
        await waitFor(() => expect(screen.queryByRole('button', { name: 'ompUsage.refresh' })?.hasAttribute('disabled')).toBe(false))
        expect(screen.queryByRole('alert')).toBeNull()
        expect(screen.queryByTestId('omp-limit')).toBeNull()
        expect(screen.getByRole('status')).toBeTruthy()
    })

    it('mounts the existing external monitor only when selected, then reuses native cache', async () => {
        const fetcher = vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify(
            String(input).endsWith('/api/subscription/summary') ? { snapshots: [], generatedAt: Date.now() } : response()
        )))
        vi.stubGlobal('fetch', fetcher)
        setup()
        await screen.findByTestId('omp-limit')
        fireEvent.change(screen.getByRole('combobox', { name: 'ompUsage.source' }), { target: { value: 'external' } })
        await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2))
        expect(fetcher.mock.calls[1]?.[0]).toBe('http://hub/api/subscription/summary')
        expect(screen.queryByTestId('omp-limit')).toBeNull()
        fireEvent.change(screen.getByRole('combobox', { name: 'ompUsage.source' }), { target: { value: 'omp-native' } })
        expect(screen.getByTestId('omp-limit')).toBeTruthy()
        expect(fetcher).toHaveBeenCalledTimes(2)
    })

    it('renders recognizable brand logos for common providers, monogram fallback for unknown providers, and deduplicates repeated window labels', async () => {
        const now = Date.now()
        mockFetch(response([
            {
                provider: 'cx2cc-ecs',
                accountId: 'acc-1',
                fetchedAt: now,
                limits: [{
                    id: 'w7',
                    label: '7 days',
                    scope: { shared: true },
                    window: { id: '7d', label: '7 days' },
                    amount: { unit: 'percent', used: 100, limit: 100, remaining: 0, usedFraction: 1 },
                    status: 'warning'
                }]
            },
            {
                provider: 'google-antigravity',
                accountId: 'acc-2',
                fetchedAt: now,
                limits: [{
                    id: 'gem',
                    label: 'Gemini',
                    scope: {},
                    window: { id: 'weekly', label: 'Weekly' },
                    amount: { unit: 'percent', used: 77.007, limit: 100, remaining: 22.993, usedFraction: 0.77007 },
                    status: 'ok'
                }]
            },
            {
                provider: 'openai-codex',
                accountId: 'acc-3',
                fetchedAt: now,
                limits: []
            },
            {
                provider: 'devin',
                accountId: 'acc-4',
                fetchedAt: now,
                limits: [{
                    id: 'daily',
                    label: 'Daily Quota',
                    scope: { tier: 'Pro' },
                    window: { id: 'daily', label: 'Daily Quota' },
                    amount: { unit: 'percent', used: 0, limit: 100, remaining: 100, usedFraction: 0 },
                    status: 'ok'
                }]
            },
            {
                provider: 'xai-oauth',
                accountId: 'acc-5',
                fetchedAt: now,
                limits: []
            },
            {
                provider: 'anthropic',
                accountId: 'acc-6',
                fetchedAt: now,
                limits: []
            },
            {
                provider: 'custom-gateway',
                accountId: 'acc-7',
                fetchedAt: now,
                limits: []
            }
        ]))
        setup()
        await screen.findAllByTestId('omp-limit')
        const logos = screen.getAllByTestId('provider-logo').map(node => node.getAttribute('data-provider-logo'))
        expect(logos).toEqual([
            'cx2cc',
            'google-antigravity',
            'openai-codex',
            'devin',
            'xai',
            'anthropic',
            'fallback'
        ])
        // Fallback renders 2-letter monogram CG
        expect(screen.getByText('CG')).toBeTruthy()
        // Duplicate "7 days" window label is collapsed into single heading, while distinct "Pro" and "Weekly" remain visible
        expect(screen.getAllByText('7 days')).toHaveLength(1)
        expect(screen.getByText(/· Weekly/)).toBeTruthy()
        expect(screen.getByText(/· Pro/)).toBeTruthy()
        expect(screen.getAllByText('Daily Quota')).toHaveLength(1)
    })

    it('remembers the last queried OMP machine and source per account across remounts and devices', async () => {
        const fetcher = mockFetch()
        const g14: MachineWithOwner = {
            ...machine('g14-id'),
            metadata: { host: 'WIN-03F1GUBQD2G', displayName: 'ROG-G14', capabilities: { omp: true } }
        }
        const view1 = setup([machine('a'), g14])
        const select1 = screen.getByRole('combobox', { name: 'ompUsage.machine' }) as HTMLSelectElement
        expect(select1.value).toBe('a')
        fireEvent.change(select1, { target: { value: 'g14-id' } })
        await waitFor(() => expect(fetcher.mock.calls.at(-1)?.[0]).toBe('http://hub/api/subscription/omp/g14-id'))
        view1.unmount()

        // Remount as same account (user.id = 7): prioritizes G14 immediately
        const view2 = setup([machine('a'), g14])
        const select2 = screen.getByRole('combobox', { name: 'ompUsage.machine' }) as HTMLSelectElement
        expect(select2.value).toBe('g14-id')
        view2.unmount()

        // Clear localStorage to simulate opening on a second device where Hub tagged preferredForOmpUsage
        window.localStorage.clear()
        const view3 = setup([machine('a'), { ...g14, preferredForOmpUsage: true }])
        const select3 = screen.getByRole('combobox', { name: 'ompUsage.machine' }) as HTMLSelectElement
        expect(select3.value).toBe('g14-id')
        view3.unmount()
    })
})
