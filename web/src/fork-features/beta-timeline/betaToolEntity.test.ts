import { describe, expect, it } from 'vitest'
import { buildVisibleChatBlocks } from '@/chat/toolGroups'
import { runtimeItemToToolCallBlock } from './betaTimelineView'
import { BetaTimelineStore } from './store'
import { createBetaToolSnapshot } from './betaToolEntity'
import { partitionBetaTurns, presentBetaTurns } from './betaTurns'

const tools = Array.from({ length: 1000 }, (_, i) => runtimeItemToToolCallBlock({ id: `item-${i}`, runId: 'run', kind: 'tool', state: 'completed', createdAt: 1, updatedAt: 2, tool: { id: `tool-${i}`, name: 'Bash', input: { command: `echo ${i}` } } }))

describe('grouped process entity isolation', () => {
 it('virtualizes individual tools instead of mounting a thousand-button expanded group', () => {
  const store = new BetaTimelineStore()
  const groups = buildVisibleChatBlocks(tools, { hasMoreMessages: false })
  expect(groups).toHaveLength(1)
  store.setHistory(groups)
  const turns = partitionBetaTurns(store.getRows(), store.getRow)
  const rows = presentBetaTurns(turns, new Set([turns[0].id]))
  expect(rows.filter((row) => row.kind === 'tool')).toHaveLength(1000)
  expect(rows.filter((row) => row.kind === 'row')).toHaveLength(0)
  expect(rows[501]).toMatchObject({ id: 'process-tool:tool-500', toolIndex: 500 })
 })
 it('retains an unchanged sibling snapshot when its storage group receives another tool output', () => {
  const store = new BetaTimelineStore()
  const group = buildVisibleChatBlocks(tools.slice(0, 2), { hasMoreMessages: false })[0]
  if (group.kind !== 'tool-group') throw new Error('Expected canonical grouping')
  store.setHistory([group])
  const sourceId = store.getRows()[0].id
  const first = createBetaToolSnapshot(store, sourceId, 'process-tool:tool-0', 0)
  const second = createBetaToolSnapshot(store, sourceId, 'process-tool:tool-1', 1)
  const beforeFirst = first()
  const beforeSecond = second()
  store.setHistory([{ ...group, tools: [{ ...group.tools[0], tool: { ...group.tools[0].tool, result: 'new output' } }, group.tools[1]] }])
  expect(first()).not.toBe(beforeFirst)
  expect(second()).toBe(beforeSecond)
 })
})
