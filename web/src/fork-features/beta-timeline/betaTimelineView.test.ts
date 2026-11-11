import { describe, expect, it } from 'vitest'
import type { BetaRow } from './store'
import type { RuntimeItem } from '@hapi/protocol/runtimeTimeline'
import { buildBetaShareHiddenIds, hasPendingRequest, historyTerminalLabel, rowDomId, runtimeItemToToolCallBlock, runtimeTerminalLabel, selectShareTurnRows } from './betaTimelineView'

const user = (id: string): BetaRow => ({ id, kind: 'history', block: { kind: 'user-text', id, localId: id, createdAt: 1, invokedAt: 1, text: `Prompt ${id}` } })
const answer = (id: string): BetaRow => ({ id, kind: 'history', block: { kind: 'agent-text', id, localId: null, createdAt: 2, text: `Answer ${id}` } })
const native = (extra: Partial<RuntimeItem> = {}): RuntimeItem => ({ id: 'live', kind: 'assistant', runId: 'run', state: 'running', createdAt: 2, updatedAt: 3, text: 'partial', ...extra })

describe('beta timeline presentation contracts', () => {
    it('selects the entire data turn even when it spans hundreds of unmounted rows', () => {
        const turn = [user('first'), ...Array.from({ length: 500 }, (_, i) => answer(String(i)))]
        const rows = [...turn, user('next'), answer('next-answer')]
        expect(selectShareTurnRows(rows, '450')).toEqual(turn)
        expect(selectShareTurnRows(rows, 'first')).toEqual(turn)
        expect(selectShareTurnRows(rows, 'next-answer')).toEqual(rows.slice(501))
    })
    it('includes finalized native rows in the selected turn and keeps legacy anchors', () => {
        const runtime: BetaRow = { id: 'runtime-row', kind: 'runtime', item: native({ state: 'completed' }) }
        const rows = [user('prompt'), answer('a'), runtime]
        expect(selectShareTurnRows(rows, runtime.id)).toEqual(rows)
        expect(rowDomId(rows[0])).toBe('hapi-message-user-text:prompt')
        expect(rowDomId(runtime)).toBe('hapi-message-runtime:live')
    })
    it('hides only the active turn while native execution is running', () => {
        const rows = [user('old'), answer('old-answer'), user('new'), answer('new-answer'), { id: 'runtime', kind: 'runtime' as const, item: native() }]
        expect(Array.from(buildBetaShareHiddenIds(rows, true))).toEqual(['new', 'new-answer', 'runtime'])
        expect(buildBetaShareHiddenIds(rows, false).size).toBe(0)
    })
    it('exposes length, error, and abort before and after canonical reconciliation', () => {
        expect(runtimeTerminalLabel(native({ state: 'completed', stopReason: 'length' }))).toBe('beta.timeline.length')
        expect(runtimeTerminalLabel(native({ state: 'aborted', stopReason: 'aborted' }))).toBe('beta.timeline.aborted')
        expect(runtimeTerminalLabel(native({ state: 'error', errorMessage: 'upstream failure' }))).toBe('upstream failure')
        expect(runtimeTerminalLabel(native({ state: 'completed', stopReason: 'toolUse' }))).toBeNull()
        const block = { kind: 'agent-text' as const, id: 'canonical:0', localId: null, text: 'complete', createdAt: 2 }
        expect(historyTerminalLabel({ ...block, meta: { runtimeStopReason: 'length' } })).toBe('beta.timeline.length')
        expect(historyTerminalLabel({ ...block, meta: { runtimeStopReason: 'error', runtimeErrorMessage: 'provider failed' } })).toBe('provider failed')
        expect(historyTerminalLabel({ ...block, meta: { runtimeStopReason: 'aborted' } })).toBe('beta.timeline.aborted')
    })
    it('retains full native tool input/output and timing in the existing ToolCard shape', () => {
        const output = { content: [{ type: 'text', text: 'result detail' }], details: { path: '/tmp/a' } }
        const item = native({ kind: 'tool', state: 'completed', tool: { id: 'tool-id', name: 'Read', input: { path: '/tmp/a' }, output } })
        const block = runtimeItemToToolCallBlock(item)
        expect(block.tool.id).toBe('tool-id')
        expect(block.tool.input).toEqual({ path: '/tmp/a' })
        expect(block.tool.result).toBe(output)
        expect(block.tool.state).toBe('completed')
        expect(block.tool.completedAt).toBe(3)
        expect(runtimeItemToToolCallBlock({ ...item, state: 'aborted' }).tool.state).toBe('error')
    })

    it('does not treat a failed uninvoked send as an execution boundary', () => {
        const failed = user('failed')
        if (failed.kind !== 'history' || failed.block.kind !== 'user-text') throw new Error('invalid test row')
        const boundary: BetaRow = { ...failed, block: { ...failed.block, status: 'failed', invokedAt: null } }
        expect(selectShareTurnRows([user('first'), answer('one'), boundary, answer('two')], 'one').map((row) => row.id)).toEqual(['first', 'one', 'failed', 'two'])
    })

    it.each(['handled', 'cancelled'] as const)('does not split share selection at a %s terminal input', (outcome) => {
        const terminal: BetaRow = { id: 'terminal', kind: 'history', block: { kind: 'user-text', id: 'terminal', localId: 'terminal', createdAt: 3, text: '/local command', resolution: { outcome, resolvedAt: 4 } } }
        const rows = [user('first'), answer('one'), terminal, answer('two'), user('next')]
        expect(selectShareTurnRows(rows, 'two')).toEqual(rows.slice(0, 4))
        expect(historyTerminalLabel(terminal.block)).toBe(`message.resolution.${outcome}`)
    })

    it('finds interactive requests through collapsed nested task branches', () => {
        const tool = runtimeItemToToolCallBlock(native({ kind: 'tool', tool: { id: 'outer', name: 'Task', input: {} } }))
        const child = runtimeItemToToolCallBlock(native({ id: 'child', kind: 'tool', tool: { id: 'inner', name: 'AskUserQuestion', input: {} } }))
        child.tool.permission = { id: 'question', status: 'pending' }
        tool.children.push(child)
        expect(hasPendingRequest(tool)).toBe(true)
        expect(hasPendingRequest(tool, new Set(['question']))).toBe(true)
        expect(hasPendingRequest(tool, new Set(['other']))).toBe(false)
        expect(runtimeItemToToolCallBlock(native({ kind: 'tool', state: 'completed', tool: { id: 'error', name: 'Bash', input: {}, isError: true } })).tool.state).toBe('error')
    })

    it('does not invent tool output or content for deferred live previews', () => {
        const item = native({ kind: 'tool', state: 'running', previewOmitted: true, tool: { id: 'big', name: 'Read', input: { path: 'x' } } })
        const block = runtimeItemToToolCallBlock(item)
        expect(block.tool.state).toBe('running')
        expect(block.tool.result).toBeUndefined()
        expect(block.tool.input).toEqual({ path: 'x' })
    })
})
