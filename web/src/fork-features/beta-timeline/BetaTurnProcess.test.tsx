import { Profiler } from 'react'
import { act, fireEvent, render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { BetaTimelineStore } from './store'
import { runtimeItemToToolCallBlock } from './betaTimelineView'
import { BetaLiveActivity, BetaTurnProcess } from './BetaTurnProcess'
import { BetaDetails, BetaExpansionProvider, BetaExpansionRow } from './BetaExpansion'

const tool = runtimeItemToToolCallBlock({ id: 'tool', runId: 'run', kind: 'tool', state: 'running', createdAt: 1, updatedAt: 2, tool: { id: 'tool', name: 'Bash', input: {} } })

describe('process entity subscriptions and persistent disclosures', () => {
 it('does not commit the process summary for payload-only tool changes, but reveals a new error', () => {
  const store = new BetaTimelineStore()
  store.setHistory([tool])
  const commits = vi.fn()
  const toggle = vi.fn()
  const view = render(<I18nProvider><Profiler id="process" onRender={commits}><BetaTurnProcess store={store} ids={['h:tool']} expanded={false} onToggle={toggle} id="process:u" measureRef={() => { }} /></Profiler></I18nProvider>)
  commits.mockClear()
  act(() => store.setHistory([{ ...tool, tool: { ...tool.tool, result: 'a new partial output' } }]))
  expect(commits).not.toHaveBeenCalled()
  act(() => store.setHistory([{ ...tool, tool: { ...tool.tool, state: 'error', result: 'failure' } }]))
  expect(view.getAllByRole('alert')).toHaveLength(1)
  const buttons = view.getAllByRole('button')
  fireEvent.click(buttons[0])
  expect(toggle).toHaveBeenCalledOnce()
  expect(buttons[0].getAttribute('aria-expanded')).toBe('false')
 })
 it('keeps Windows file targets and streamed activity changes visible without a layout publication', () => {
  const store = new BetaTimelineStore()
  const toolWithIntent = runtimeItemToToolCallBlock({
   id: 'tool-intent', runId: 'run', kind: 'tool', state: 'running', createdAt: 1, updatedAt: 2,
   tool: { id: 'tool-intent', name: 'read', input: { i: 'Inspecting source', path: 'C:/workspace/First.tsx:10-30' } }
  })
  store.setHistory([toolWithIntent])
  const view = render(<I18nProvider><BetaTurnProcess store={store} ids={['h:tool-intent']} expanded={false} onToggle={() => { }} id="process:u" /><div data-testid="live"><BetaLiveActivity store={store} id="h:tool-intent" /></div></I18nProvider>)
  expect(view.getByTestId('live').textContent).toContain('First.tsx')
  const layoutChanges = vi.fn()
  const unsubscribe = store.subscribeRows(layoutChanges)
  act(() => store.setHistory([{ ...toolWithIntent, tool: { ...toolWithIntent.tool, input: { i: 'Inspecting source', path: 'C:/workspace/Next.tsx:40-60' } } }]))
  expect(layoutChanges).not.toHaveBeenCalled()
  expect(view.getByTestId('live').textContent).toContain('Next.tsx')
  expect(view.container.querySelector('[data-beta-process-step="true"]')?.textContent).toContain('Next.tsx')
  act(() => store.setHistory([{ ...toolWithIntent, tool: { ...toolWithIntent.tool, state: 'completed' } }]))
  expect(view.getByTestId('live').textContent).toBe('')
  unsubscribe()
 })
 it('retains expanded reasoning across virtual unmount and canonical remount with the same row key', () => {
  const Disclosure = ({ visible }: { visible: boolean }) => <BetaExpansionProvider>{visible ? <BetaExpansionRow id="r:assistant"><BetaDetails id="reasoning"><summary>Reasoning</summary><p>Detailed reasoning</p></BetaDetails></BetaExpansionRow> : null}</BetaExpansionProvider>
  const view = render(<Disclosure visible />)
  const details = view.container.querySelector('details')!
  details.open = true
  fireEvent(details, new Event('toggle', { bubbles: false }))
  view.rerender(<Disclosure visible={false} />)
  view.rerender(<Disclosure visible />)
  expect(view.container.querySelector('details')!.open).toBe(true)
 })
})
