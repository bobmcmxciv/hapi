import { cleanup, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'

const scopes = vi.hoisted(() => ({ window: 'old', outbox: 'old' }))
vi.mock('@/lib/message-window-store', () => ({
 setMessageWindowScope: vi.fn((scope: string) => { scopes.window = scope }),
}))
vi.mock('@/lib/queued-outbox', () => ({
 setQueuedOutboxScope: vi.fn((scope: string) => { scopes.outbox = scope }),
}))
// This regression specifically covers the production build, not only Beta.
vi.mock('./enabled', () => ({ BETA_TIMELINE_ENABLED: false }))
import { BetaIdentityBoundary } from './BetaIdentityBoundary'

afterEach(cleanup)
describe('account identity boundary', () => {
 it('never renders children against another account window or outbox on production', () => {
  scopes.window = 'old'
  scopes.outbox = 'old'
  const queryClient = new QueryClient()
  const clear = vi.spyOn(queryClient, 'clear')
  const rendered: string[][] = []
  function Probe() {
   rendered.push([scopes.window, scopes.outbox])
   return <div data-testid="account-content">{scopes.window}</div>
  }
  const tree = (scope: string) => <QueryClientProvider client={queryClient}>
   <BetaIdentityBoundary scope={scope}><Probe /></BetaIdentityBoundary>
  </QueryClientProvider>
  const view = render(tree('account-A'))
  expect(screen.getByTestId('account-content')).toHaveTextContent('account-A')
  view.rerender(tree('account-B'))
  expect(screen.getByTestId('account-content')).toHaveTextContent('account-B')
  expect(rendered).toEqual([['account-A', 'account-A'], ['account-B', 'account-B']])
  expect(clear).toHaveBeenCalledTimes(2)
 })
})
