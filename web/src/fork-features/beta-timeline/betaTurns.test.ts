import { describe, expect, it } from 'vitest'
import type { VisibleChatBlock } from '@/chat/toolGroups'
import type { RuntimeItem } from '@hapi/protocol/runtimeTimeline'
import { BetaTimelineStore } from './store'
import { currentRunState, generatedArtifacts, orphanPendingBlocks, partitionBetaTurns, presentBetaTurns, processAttention } from './betaTurns'
import { runtimeItemToToolCallBlock } from './betaTimelineView'

const prompt = (id: string): VisibleChatBlock => ({ kind: 'user-text', id, localId: id, invokedAt: 1, createdAt: 1, text: id })
const answer = (id: string): Extract<VisibleChatBlock, { kind: 'agent-text' }> => ({ kind: 'agent-text', id, localId: null, createdAt: 2, text: id })
const native = (id: string): RuntimeItem => ({ id, kind: 'tool', runId: 'run', state: 'completed', createdAt: 2, updatedAt: 3, tool: { id, name: 'Bash', input: {} } })

describe('task-oriented beta turn projection', () => {
 it('bounds collapsed thousand-tool turns while keeping complete text messages visible and collapsing surrounding tool segments separately', () => {
  const store = new BetaTimelineStore()
  store.setHistory([
   prompt('u'),
   runtimeItemToToolCallBlock(native('pre-tool')),
   answer('narration'),
   ...Array.from({ length: 1000 }, (_, i) => runtimeItemToToolCallBlock(native(String(i)))),
   answer('result')
  ])
  const turns = partitionBetaTurns(store.getRows(), store.getRow)
  expect(turns[0].process).toHaveLength(1001)
  expect(turns[0].primary).toEqual(['h:u', 'h:narration', 'h:result'])
  expect(turns[0].segments).toHaveLength(2)
  const collapsed = presentBetaTurns(turns, new Set())
  expect(collapsed.map((row) => row.id)).toEqual(['h:u', 'process:turn:h:u', 'h:narration', 'process:turn:h:u:seg:1', 'h:result'])
  expect(presentBetaTurns(turns, new Set([turns[0].id, 'turn:h:u:seg:1']))).toHaveLength(1006)
  const firstOnly = presentBetaTurns(turns, new Set([turns[0].segments[0].id]))
  expect(firstOnly.filter((row) => row.kind === 'tool').map((row) => row.id)).toEqual(['process-tool:pre-tool'])
  const secondOnly = presentBetaTurns(turns, new Set([turns[0].segments[1].id]))
  expect(secondOnly.filter((row) => row.kind === 'tool')).toHaveLength(1000)
  expect(secondOnly.some((row) => row.id === 'process-tool:pre-tool')).toBe(false)
 })
 it.each(['patch', 'snapshot'] as const)('promotes completed text arriving through a %s without waiting for another row', (kind) => {
  const store = new BetaTimelineStore()
  const assistant: RuntimeItem = { id: 'prose', kind: 'assistant', runId: 'run', state: 'completed', createdAt: 2, updatedAt: 2, reasoning: 'Inspecting source' }
  const trailing = native('trailing')
  store.applyPublication({ kind: 'snapshot', snapshot: { version: 1, epoch: 'e', seq: 0, items: [assistant, trailing], run: null, updatedAt: 2 } })
  let visible = presentBetaTurns(partitionBetaTurns(store.getRows(), store.getRow), new Set())
  expect(visible.some((row) => row.id === 'r:prose')).toBe(false)
  const unsubscribe = store.subscribeRows(() => { visible = presentBetaTurns(partitionBetaTurns(store.getRows(), store.getRow), new Set()) })
  const complete = { ...assistant, text: 'The full result is available.', updatedAt: 3 }
  store.applyPublication(kind === 'patch'
   ? { kind: 'patch', patch: { version: 1, epoch: 'e', seq: 1, changes: [{ type: 'item', item: complete }], updatedAt: 3 } }
   : { kind: 'snapshot', snapshot: { version: 1, epoch: 'e', seq: 1, items: [complete, trailing], run: null, updatedAt: 3 } })
  expect(visible.map((row) => row.id)).toEqual(['r:prose', 'process:turn:continuation'])
  const stableRows = store.getRows()
  store.applyPublication({ kind: 'patch', patch: { version: 1, epoch: 'e', seq: 2, changes: [{ type: 'item', item: { ...complete, text: complete.text + ' More detail.', updatedAt: 4 } }], updatedAt: 4 } })
  expect(store.getRows()).toBe(stableRows)
  unsubscribe()
 })
 it('keeps the latest answer primary even when a final tool/result follows it and folds the trailing tool separately', () => {
  const store = new BetaTimelineStore()
  store.setHistory([prompt('u'), answer('result'), runtimeItemToToolCallBlock(native('last'))])
  const turn = partitionBetaTurns(store.getRows(), store.getRow)[0]
  expect(turn.primary).toEqual(['h:u', 'h:result'])
  expect(presentBetaTurns([turn], new Set()).map((row) => row.id)).toEqual(['h:u', 'h:result', 'process:turn:h:u'])
 })
 it('preserves turn and expansion identity after prepending history and canonical payload replacement', () => {
  const store = new BetaTimelineStore()
  const user = prompt('u')
  store.setHistory([user, runtimeItemToToolCallBlock(native('t')), answer('result')])
  const before = partitionBetaTurns(store.getRows(), store.getRow)[0]
  const expanded = new Set([before.id])
  store.setHistory([prompt('older'), answer('old-result'), user, runtimeItemToToolCallBlock({ ...native('t'), updatedAt: 8 }), answer('result')])
  const after = partitionBetaTurns(store.getRows(), store.getRow)[1]
  expect(after.id).toBe(before.id)
  expect(presentBetaTurns([after], expanded).some((row) => row.id === 'process-tool:t')).toBe(true)
 })
 it('reports nested pending questions/errors without requiring process expansion', () => {
  const outer = runtimeItemToToolCallBlock(native('outer'))
  const question = runtimeItemToToolCallBlock({ ...native('question'), state: 'error' })
  question.tool.permission = { id: 'permission', status: 'pending' }
  outer.children.push(question)
  expect(processAttention({ id: 'h:outer', kind: 'history', block: outer })).toEqual({ pending: true, error: true, running: false })
 })
 it('does not label an offline session as running based on a stale runtime run', () => {
  const status = { connection: 'live' as const, run: { id: 'run', state: 'running' as const, startedAt: 1 }, error: null }
  expect(currentRunState(status, { active: false, thinking: true }, false)).toBe('offline')
  expect(currentRunState(status, { active: true, thinking: true }, true)).toBe('waiting')
  expect(currentRunState({ ...status, connection: 'reconnecting' }, { active: true, thinking: true }, false)).toBe('reconnecting')
  expect(currentRunState({ ...status, run: { id: 'run', state: 'idle', startedAt: 1, endedAt: 2 } }, { active: true, thinking: false }, false)).toBe('completed')
 })
})

describe('artifact and pending request reachability', () => {
 it('promotes real nested generated files outside collapsed tools without changing file identity', () => {
  const file = { kind: 'generated-file' as const, id: 'artifact', localId: null, createdAt: 2, fileId: 'download-id', fileName: 'result.zip', mimeType: 'application/zip', size: 42 }
  const tool = runtimeItemToToolCallBlock(native('task'))
  tool.children.push(file)
  const store = new BetaTimelineStore()
  store.setHistory([prompt('u'), tool, answer('result')])
  const turns = partitionBetaTurns(store.getRows(), store.getRow)
  const presentation = presentBetaTurns(turns, new Set())
  expect(presentation.find((row) => row.kind === 'artifact')).toMatchObject({ sourceId: 'h:task', blockId: 'artifact' })
  expect(generatedArtifacts(tool)).toEqual([file])
  expect(generatedArtifacts(tool)[0]).toBe(file)
 })
 it('keeps older orphan OMP questions actionable and preserves transient arguments', () => {
  const argumentsValue = { ompTransientRequest: true }
  const blocks = orphanPendingBlocks({ requests: { question: { tool: 'request_user_input', arguments: argumentsValue, createdAt: 1 } } }, [{ id: 'newer', kind: 'history', block: { ...prompt('newer'), createdAt: 100 } }])
  expect(blocks).toHaveLength(1)
  const block = blocks[0]
  if (block.kind !== 'tool-call') throw new Error('Expected an actionable tool card')
  expect(block.tool.input).toBe(argumentsValue)
  expect(block.tool.permission).toMatchObject({ id: 'question', status: 'pending' })
  expect(orphanPendingBlocks({ requests: { question: { tool: 'request_user_input', arguments: argumentsValue } } }, [{ id: 'matched', kind: 'history', block }])).toEqual([])
 })
 it('preserves native answer and turn IDs when the streamed entity becomes canonical', () => {
  const store = new BetaTimelineStore()
  const user = prompt('u')
  store.setHistory([user])
  store.applyPublication({ kind: 'snapshot', snapshot: { version: 1, epoch: 'epoch', seq: 0, updatedAt: 3, run: null, items: [{ id: 'live', runId: 'run', kind: 'assistant', state: 'running', createdAt: 2, updatedAt: 3, canonicalId: 'native', text: 'partial' }] } })
  const before = partitionBetaTurns(store.getRows(), store.getRow)[0]
  store.setHistory([user, { ...answer('canonical'), meta: { runtimeCanonicalId: 'native' } }])
  const after = partitionBetaTurns(store.getRows(), store.getRow)[0]
  expect(after.id).toBe(before.id)
  expect(after.primary).toEqual(before.primary)
 })
})

it('preserves segmented process expansion identity when the missing user boundary is prepended', () => {
 const store = new BetaTimelineStore()
 const tool = runtimeItemToToolCallBlock(native('t'))
 store.setHistory([tool, answer('result')])
 const before = partitionBetaTurns(store.getRows(), store.getRow, 'u')[0]
 const expanded = new Set([before.id])
 store.setHistory([prompt('u'), tool, answer('result')])
 const after = partitionBetaTurns(store.getRows(), store.getRow, 'u')[0]
 expect(after.id).toBe(before.id)
 expect(presentBetaTurns([after], expanded).some((row) => row.id === 'process-tool:t')).toBe(true)
})

it('keeps queued and failed sends visible without creating a new execution shell', () => {
 const store = new BetaTimelineStore()
 store.setHistory([prompt('invoked'), answer('result'), { kind: 'user-text', id: 'queued', localId: 'queued', invokedAt: null, createdAt: 3, text: 'next task' }, { kind: 'user-text', id: 'failed', localId: 'failed', invokedAt: null, createdAt: 4, text: 'retry me', status: 'failed' }])
 const turns = partitionBetaTurns(store.getRows(), store.getRow)
 expect(turns).toHaveLength(1)
 expect(turns[0].userId).toBe('h:invoked')
 expect(turns[0].primary).toContain('h:queued')
 expect(turns[0].primary).toContain('h:failed')
 expect(processAttention(store.getRow('h:failed')!).error).toBe(true)
})

it.each(['handled', 'cancelled'] as const)('keeps %s input visible without minting an executed turn', (outcome) => {
 const store = new BetaTimelineStore()
 store.setHistory([prompt('invoked'), answer('result'), { kind: 'user-text', id: 'terminal', localId: 'terminal', createdAt: 3, text: '/local command', status: 'failed', resolution: { outcome, resolvedAt: 4 } }])
 const turns = partitionBetaTurns(store.getRows(), store.getRow)
 expect(turns).toHaveLength(1)
 expect(turns[0].userId).toBe('h:invoked')
 expect(turns[0].primary).toContain('h:terminal')
 expect(processAttention(store.getRow('h:terminal')!).error).toBe(false)
})
