import { describe, expect, it, vi } from 'vitest'
import type { RuntimeItem, RuntimePatch, RuntimeRun, RuntimeSnapshot } from '@hapi/protocol/runtimeTimeline'
import { MAX_RUNTIME_ITEMS } from '@hapi/protocol/runtimeTimeline'
import type { AgentTextBlock, ToolCallBlock, UserTextBlock } from '@/chat/types'
import type { ToolGroupBlock, VisibleChatBlock } from '@/chat/toolGroups'
import { BetaTimelineStore, RuntimeTimelineResyncError } from './store'
import { normalizeDecryptedMessage } from '@/chat/normalize'
import { reduceChatBlocks } from '@/chat/reducer'

function agentText(id: string, overrides: Partial<AgentTextBlock> = {}): AgentTextBlock {
    return {
        kind: 'agent-text',
        id,
        localId: null,
        createdAt: 1,
        text: 'hello',
        ...overrides
    }
}

function userText(id: string, overrides: Partial<UserTextBlock> = {}): UserTextBlock {
    return {
        kind: 'user-text',
        id,
        localId: null,
        createdAt: 1,
        text: 'hi',
        ...overrides
    }
}

function toolBlock(id: string, toolId: string, overrides: Partial<ToolCallBlock> = {}): ToolCallBlock {
    return {
        kind: 'tool-call',
        id,
        localId: null,
        createdAt: 1,
        tool: {
            id: toolId,
            name: 'Bash',
            state: 'completed',
            input: {},
            createdAt: 1,
            startedAt: 1,
            completedAt: 2,
            execStartedAt: null,
            execCompletedAt: null,
            description: null
        },
        children: [],
        ...overrides
    }
}

function toolGroup(id: string, tools: ToolCallBlock[]): ToolGroupBlock {
    return {
        kind: 'tool-group',
        id,
        createdAt: 1,
        firstToolId: tools[0].id,
        lastToolId: tools[tools.length - 1].id,
        tools,
        defaultOpen: false,
        historyState: 'complete',
        needsOlderHistory: false,
        activityTitle: null,
        presentationMode: 'default',
        summary: {
            totalTools: tools.length,
            countsByKind: { read: 0, search: 0, command: 0, mutation: 0, web: 0, other: tools.length },
            fileTargets: [],
            commandTargets: [],
            searchTargets: [],
            urlTargets: [],
            otherTargets: [],
            errorCount: 0,
            runningCount: 0,
            pendingCount: 0
        }
    }
}

function runtimeItem(id: string, overrides: Partial<RuntimeItem> = {}): RuntimeItem {
    return {
        id,
        kind: 'assistant',
        runId: 'run-1',
        createdAt: 1,
        updatedAt: 1,
        state: 'running',
        ...overrides
    }
}

function run(id: string, state: RuntimeRun['state'] = 'running', overrides: Partial<RuntimeRun> = {}): RuntimeRun {
    return { id, state, startedAt: 1, ...overrides }
}

function snapshot(items: RuntimeItem[] = [], runState: RuntimeRun | null = null, seq = 0, epoch = 'e1'): RuntimeSnapshot {
    return { version: 1, epoch, seq, items, run: runState, updatedAt: 10 }
}

function patch(seq: number, changes: RuntimePatch['changes'], epoch = 'e1'): RuntimePatch {
    return { version: 1, epoch, seq, changes, updatedAt: 20 }
}

describe('BetaTimelineStore history rows', () => {
    it('publishes stable row refs and per-row payloads', () => {
        const store = new BetaTimelineStore()
        const blocks: VisibleChatBlock[] = [userText('u1'), agentText('a:0')]
        store.setHistory(blocks)

        expect(store.getRows().map((ref) => ref.id)).toEqual(['h:u1', 'h:a:0'])
        const row = store.getRow('h:a:0')
        expect(row?.kind).toBe('history')
        expect(row && row.kind === 'history' ? row.block : null).toBe(blocks[1])
    })

    it('does not notify structure when the same blocks are re-set', () => {
        const store = new BetaTimelineStore()
        const blocks: VisibleChatBlock[] = [userText('u1')]
        store.setHistory(blocks)
        const rowsRef = store.getRows()
        const listener = vi.fn()
        store.subscribeRows(listener)

        store.setHistory(blocks) // identical reference
        store.setHistory([...blocks]) // same blocks, new array
        expect(listener).not.toHaveBeenCalled()
        expect(store.getRows()).toBe(rowsRef)
    })

    it('notifies only the changed history row when a block object is replaced', () => {
        const store = new BetaTimelineStore()
        const u1 = userText('u1')
        const a0 = agentText('a:0')
        store.setHistory([u1, a0])

        const structure = vi.fn()
        const u1Row = vi.fn()
        const a0Row = vi.fn()
        store.subscribeRows(structure)
        store.subscribeRow('h:u1', u1Row)
        store.subscribeRow('h:a:0', a0Row)

        const updated = { ...a0, text: 'edited' }
        store.setHistory([u1, updated])

        expect(a0Row).toHaveBeenCalledTimes(1)
        expect(u1Row).not.toHaveBeenCalled()
        expect(structure).not.toHaveBeenCalled()
        const row = store.getRow('h:a:0')
        const block = row && row.kind === 'history' ? row.block : null
        expect(block && block.kind === 'agent-text' ? block.text : null).toBe('edited')
    })

    it('disambiguates repeated block ids with occurrence suffixes', () => {
        const store = new BetaTimelineStore()
        store.setHistory([agentText('dup'), userText('u1'), agentText('dup')])
        expect(store.getRows().map((ref) => ref.id)).toEqual(['h:dup', 'h:u1', 'h:dup#2'])
        expect(store.getRow('h:dup')).not.toBe(store.getRow('h:dup#2'))
    })
})

describe('BetaTimelineStore runtime publications', () => {
    it('rejects patches before any snapshot establishes the epoch', () => {
        const store = new BetaTimelineStore()
        expect(() => store.applyPublication({
            kind: 'patch',
            patch: patch(1, [])
        })).toThrow(RuntimeTimelineResyncError)
    })

    it('appends runtime rows and notifies structure once per patch', () => {
        const store = new BetaTimelineStore()
        store.applyPublication({ kind: 'snapshot', snapshot: snapshot() })
        const structure = vi.fn()
        store.subscribeRows(structure)

        store.applyPublication({
            kind: 'patch',
            patch: patch(1, [
                { type: 'item', item: runtimeItem('i1') },
                { type: 'item', item: runtimeItem('i2') }
            ])
        })

        expect(structure).toHaveBeenCalledTimes(1)
        expect(store.getRows().map((ref) => ref.id)).toEqual(['r:i1', 'r:i2'])
    })

    it('streams additional text without waking layout or unrelated row subscribers', () => {
        const store = new BetaTimelineStore()
        store.applyPublication({
            kind: 'snapshot',
            snapshot: snapshot([runtimeItem('i1'), runtimeItem('i2', { text: 'stream' })])
        })
        const rowsRef = store.getRows()
        const structure = vi.fn()
        const i1 = vi.fn()
        const i2 = vi.fn()
        store.subscribeRows(structure)
        store.subscribeRow('r:i1', i1)
        store.subscribeRow('r:i2', i2)

        store.applyPublication({
            kind: 'patch',
            patch: patch(1, [{ type: 'item', item: runtimeItem('i2', { text: 'streamed', updatedAt: 2 }) }])
        })

        expect(structure).not.toHaveBeenCalled()
        expect(store.getRows()).toBe(rowsRef)
        expect(i2).toHaveBeenCalledTimes(1)
        expect(i1).not.toHaveBeenCalled()
        const row = store.getRow('r:i2')
        expect(row && row.kind === 'runtime' ? row.item.text : null).toBe('streamed')
    })

    it('throws on a seq gap and ignores duplicate seqs', () => {
        const store = new BetaTimelineStore()
        store.applyPublication({ kind: 'snapshot', snapshot: snapshot([], null, 5) })

        store.applyPublication({ kind: 'patch', patch: patch(5, [{ type: 'item', item: runtimeItem('dup') }]) })
        expect(store.getRows()).toHaveLength(0)

        expect(() => store.applyPublication({
            kind: 'patch',
            patch: patch(7, [])
        })).toThrow(RuntimeTimelineResyncError)
    })

    it('throws on an epoch change until a new snapshot arrives', () => {
        const store = new BetaTimelineStore()
        store.applyPublication({ kind: 'snapshot', snapshot: snapshot([], null, 3, 'e1') })
        expect(() => store.applyPublication({
            kind: 'patch',
            patch: patch(1, [], 'e2')
        })).toThrow(RuntimeTimelineResyncError)

        store.applyPublication({ kind: 'snapshot', snapshot: snapshot([], null, 0, 'e2') })
        store.applyPublication({ kind: 'patch', patch: patch(1, [{ type: 'item', item: runtimeItem('x') }], 'e2') })
        expect(store.getRows().map((ref) => ref.id)).toEqual(['r:x'])
    })

    it('snapshot replaces runtime state and drops removed rows', () => {
        const store = new BetaTimelineStore()
        store.applyPublication({ kind: 'snapshot', snapshot: snapshot([runtimeItem('old-1'), runtimeItem('old-2')]) })
        const removed = vi.fn()
        store.subscribeRow('r:old-1', removed)

        store.applyPublication({ kind: 'snapshot', snapshot: snapshot([runtimeItem('new-1')], null, 0, 'e2') })

        expect(store.getRows().map((ref) => ref.id)).toEqual(['r:new-1'])
        expect(store.getRow('r:old-1')).toBeUndefined()
        expect(removed).toHaveBeenCalled()
    })

    it('ignores stale and revival item updates like the shared projection', () => {
        const store = new BetaTimelineStore()
        store.applyPublication({
            kind: 'snapshot',
            snapshot: snapshot([runtimeItem('i1', { updatedAt: 5, state: 'completed', text: 'final' })])
        })

        store.applyPublication({
            kind: 'patch',
            patch: patch(1, [
                { type: 'item', item: runtimeItem('i1', { updatedAt: 3, text: 'stale' }) },
                { type: 'item', item: runtimeItem('i1', { updatedAt: 6, state: 'running', text: 'revived' }) }
            ])
        })

        const row = store.getRow('r:i1')
        expect(row && row.kind === 'runtime' ? row.item.text : null).toBe('final')
        expect(row && row.kind === 'runtime' ? row.item.state : null).toBe('completed')
    })

    it('clear removes runtime rows and resets the run', () => {
        const store = new BetaTimelineStore()
        store.applyPublication({
            kind: 'snapshot',
            snapshot: snapshot([runtimeItem('i1')], run('r1'))
        })
        const status = vi.fn()
        store.subscribeStatus(status)

        store.applyPublication({
            kind: 'patch',
            patch: patch(1, [{ type: 'clear' }])
        })

        expect(store.getRows()).toHaveLength(0)
        expect(store.getStatus().run).toBeNull()
        expect(status).toHaveBeenCalled()
    })

    it('tracks run state through status subscriptions and preserves terminal stopReason', () => {
        const store = new BetaTimelineStore()
        store.applyPublication({ kind: 'snapshot', snapshot: snapshot() })
        const statuses: Array<RuntimeRun | null> = []
        store.subscribeStatus(() => statuses.push(store.getStatus().run))

        store.applyPublication({ kind: 'patch', patch: patch(1, [{ type: 'run', run: run('r1') }]) })
        store.applyPublication({
            kind: 'patch',
            patch: patch(2, [{ type: 'run', run: run('r1', 'idle', { endedAt: 9, stopReason: 'length' }) }])
        })

        const current = store.getStatus().run
        expect(current?.state).toBe('idle')
        expect(current?.stopReason).toBe('length')
        expect(statuses.at(-1)?.stopReason).toBe('length')
    })

    it('bounds runtime memory to MAX_RUNTIME_ITEMS', () => {
        const store = new BetaTimelineStore()
        const items = Array.from({ length: MAX_RUNTIME_ITEMS + 1 }, (_, index) =>
            runtimeItem(`item-${index}`, { updatedAt: index }))
        store.applyPublication({ kind: 'snapshot', snapshot: snapshot(items) })
        expect(store.getRows().length).toBe(MAX_RUNTIME_ITEMS)
        expect(store.getRow('r:item-0')).toBeUndefined()
    })
})

describe('BetaTimelineStore canonical reconciliation', () => {
    it('suppresses a runtime assistant row once its canonical message reaches history', () => {
        const store = new BetaTimelineStore()
        store.applyPublication({
            kind: 'snapshot',
            snapshot: snapshot([runtimeItem('live-1', { canonicalId: 'msg-9', text: 'partial' })])
        })
        expect(store.getRows().map((ref) => ref.id)).toEqual(['r:live-1'])

        // One canonical message expands to several `${id}:${idx}` blocks.
        store.setHistory([
            agentText('hub-row:0', { meta: { runtimeCanonicalId: 'msg-9' } }),
            agentText('hub-row:1', { meta: { runtimeCanonicalId: 'msg-9' } })
        ])

        expect(store.getRows().map((ref) => ref.id)).toEqual(['r:live-1', 'h:hub-row:1'])
        expect(store.getRow('r:live-1')?.kind).toBe('history')
        expect(store.getAllRows()).toHaveLength(2)
    })

    it('keeps unresolved runtime rows when unrelated canonical history lands', () => {
        const store = new BetaTimelineStore()
        store.applyPublication({
            kind: 'snapshot',
            snapshot: snapshot([runtimeItem('live-1', { canonicalId: 'msg-9' }), runtimeItem('live-2')])
        })
        store.setHistory([agentText('msg-9:0', { meta: { runtimeCanonicalId: 'msg-9' } })])
        // live-2 anchored after live-1; adoption of live-1's key preserves order.
        expect(store.getRows().map((ref) => ref.id)).toEqual(['r:live-1', 'r:live-2'])
    })

    it('suppresses a runtime tool row when the durable tool block exists', () => {
        const store = new BetaTimelineStore()
        store.applyPublication({
            kind: 'snapshot',
            snapshot: snapshot([
                runtimeItem('tool-live', {
                    kind: 'tool',
                    tool: { id: 'tool-1', name: 'Bash', input: { command: 'ls' } }
                })
            ])
        })
        expect(store.getRows().map((ref) => ref.id)).toEqual(['r:tool-live'])

        store.setHistory([toolBlock('msg-1:0', 'tool-1')])
        expect(store.getRows().map((ref) => ref.id)).toEqual(['r:tool-live'])
    })

    it('covers tool items inside tool-group members', () => {
        const store = new BetaTimelineStore()
        store.applyPublication({
            kind: 'snapshot',
            snapshot: snapshot([
                runtimeItem('tool-live', {
                    kind: 'tool',
                    tool: { id: 'tool-2', name: 'Read', input: {} }
                })
            ])
        })
        store.setHistory([
            toolGroup('tool-group:tool-1', [toolBlock('t1', 'tool-1'), toolBlock('t2', 'tool-2')])
        ])
        expect(store.getRows().map((ref) => ref.id)).toEqual(['r:tool-live'])
    })

    it('covers sidechain blocks nested under a tool-call children array', () => {
        const store = new BetaTimelineStore()
        store.applyPublication({
            kind: 'snapshot',
            snapshot: snapshot([
                runtimeItem('side-live', { canonicalId: 'side-msg' })
            ])
        })
        const parent = toolBlock('msg-1:0', 'tool-1', { children: [agentText('side-msg:0', { meta: { runtimeCanonicalId: 'side-msg' } })] })
        store.setHistory([parent])
        // The covered sidechain row hides; the parent tool row keeps its own key.
        expect(store.getRows().map((ref) => ref.id)).toEqual(['h:msg-1:0'])
    })

    it('re-shows a runtime row if the covering history row is removed', () => {
        const store = new BetaTimelineStore()
        store.applyPublication({
            kind: 'snapshot',
            snapshot: snapshot([runtimeItem('live-1', { canonicalId: 'msg-9' })])
        })
        store.setHistory([agentText('msg-9:0', { meta: { runtimeCanonicalId: 'msg-9' } })])
        expect(store.getRows().map((ref) => ref.id)).toEqual(['r:live-1'])

        store.setHistory([])
        expect(store.getRows().map((ref) => ref.id)).toEqual(['r:live-1'])
    })

    it('matches only the payload canonical UUID, never a coincident localId', () => {
        const store = new BetaTimelineStore()
        store.applyPublication({ kind: 'snapshot', snapshot: snapshot([runtimeItem('live-1', { canonicalId: 'payload-uuid' })]) })
        store.setHistory([agentText('srv-row:0', { localId: 'payload-uuid' })])
        expect(store.getRows()).toHaveLength(2)
        store.setHistory([agentText('srv-row:0', { meta: { runtimeCanonicalId: 'payload-uuid' } })])
        expect(store.getRows()).toHaveLength(1)
    })
})

describe('BetaTimelineStore lifecycle', () => {
    it('exposes setConnection through status', () => {
        const store = new BetaTimelineStore()
        const statuses: string[] = []
        store.subscribeStatus(() => statuses.push(store.getStatus().connection))
        store.setConnection('live')
        store.setConnection('error', 'boom')
        expect(store.getStatus().error).toBe('boom')
        expect(statuses).toEqual(['live', 'error'])
    })

    it('clearRuntime keeps history and drops live rows', () => {
        const store = new BetaTimelineStore()
        store.setHistory([userText('u1')])
        store.applyPublication({
            kind: 'snapshot',
            snapshot: snapshot([runtimeItem('i1')], run('r1'))
        })
        store.clearRuntime()
        expect(store.getRows().map((ref) => ref.id)).toEqual(['h:u1'])
        expect(store.getStatus().run).toBeNull()
    })

    it('dispose clears listeners and makes mutations no-ops', () => {
        const store = new BetaTimelineStore()
        const structure = vi.fn()
        store.subscribeRows(structure)
        store.setHistory([userText('u1')])
        store.dispose()

        store.setHistory([userText('u2')])
        store.applyPublication({ kind: 'snapshot', snapshot: snapshot([runtimeItem('i1')]) })
        expect(structure).toHaveBeenCalledTimes(1) // only the pre-dispose call
        expect(store.getRows()).toHaveLength(0)
        expect(store.getRow('h:u2')).toBeUndefined()
    })

    it('getAllRows materializes only visible rows', () => {
        const store = new BetaTimelineStore()
        store.applyPublication({
            kind: 'snapshot',
            snapshot: snapshot([
                runtimeItem('covered', { canonicalId: 'msg-1' }),
                runtimeItem('open')
            ])
        })
        store.setHistory([agentText('hub-row:0', { meta: { runtimeCanonicalId: 'msg-1' } })])
        expect(store.getAllRows().map((row) => row.id)).toEqual(['r:covered', 'r:open'])
    })
})

describe('BetaTimelineStore identity and control transitions', () => {
    it('keeps the optimistic user key after canonical echo replaces its server id', () => {
        const store = new BetaTimelineStore()
        store.setHistory([userText('optimistic-1', { localId: 'local-1' })])
        const refs = store.getRows()
        store.setHistory([userText('server-1', { localId: 'local-1' })])
        expect(store.getRows()).toBe(refs)
        const row = store.getRow('h:optimistic-1')
        expect(row?.kind === 'history' && row.block.id).toBe('server-1')
    })

    it('ignores stale same-epoch snapshots and retired-epoch snapshots', () => {
        const store = new BetaTimelineStore()
        store.applyPublication({ kind: 'snapshot', snapshot: snapshot([runtimeItem('current')], null, 10) })
        store.applyPublication({ kind: 'snapshot', snapshot: snapshot([runtimeItem('stale')], null, 9) })
        expect(store.getRows().map(row => row.id)).toEqual(['r:current'])
        store.applyPublication({ kind: 'snapshot', snapshot: snapshot([runtimeItem('next')], null, 0, 'e2') })
        store.applyPublication({ kind: 'snapshot', snapshot: snapshot([runtimeItem('old-epoch')], null, 11) })
        expect(store.getRows().map(row => row.id)).toEqual(['r:next'])
    })

    it('overlays progress/final output on the durable tool without duplicate cards or stale permission', () => {
        const store = new BetaTimelineStore()
        const base = toolBlock('tool-1', 'tool-1')
        const pending: ToolCallBlock = { ...base, tool: { ...base.tool, state: 'pending', permission: { id: 'approval', status: 'pending' } } }
        store.setHistory([pending, userText('unrelated')])
        store.applyPublication({ kind: 'snapshot', snapshot: snapshot() })
        const structure = vi.fn()
        const unrelated = vi.fn()
        const affected = vi.fn()
        const refs = store.getRows()
        store.subscribeRows(structure)
        store.subscribeRow('h:unrelated', unrelated)
        store.subscribeRow('h:tool-1', affected)
        store.applyPublication({ kind: 'patch', patch: patch(1, [{ type: 'item', item: runtimeItem('native-tool', { kind: 'tool', tool: { id: 'tool-1', name: 'Bash', input: {}, output: 'progress' } }) }]) })
        expect(store.getRows()).toBe(refs)
        expect(structure).not.toHaveBeenCalled()
        expect(unrelated).not.toHaveBeenCalled()
        expect(affected).toHaveBeenCalledTimes(1)
        let row = store.getRow('h:tool-1')
        expect(row?.kind === 'history' && row.block.kind === 'tool-call' && row.block.tool.permission?.status).toBe('pending')

        const approved: ToolCallBlock = { ...pending, tool: { ...pending.tool, state: 'running', permission: { id: 'approval', status: 'approved' } } }
        store.setHistory([approved, userText('unrelated')])
        store.applyPublication({ kind: 'patch', patch: patch(2, [{ type: 'item', item: runtimeItem('native-tool', { kind: 'tool', state: 'completed', updatedAt: 2, tool: { id: 'tool-1', name: 'Bash', input: {}, output: 'final output' } }) }]) })
        row = store.getRow('h:tool-1')
        expect(row?.kind === 'history' && row.block.kind === 'tool-call' && row.block.tool.permission?.status).toBe('approved')
        expect(row?.kind === 'history' && row.block.kind === 'tool-call' && row.block.tool.result).toBe('final output')
        expect(row?.kind === 'history' && row.block.kind === 'tool-call' && row.block.tool.state).toBe('completed')
        expect(store.getRows()).toHaveLength(2)
    })

    it('does not confuse a tool canonical message UUID with its native tool id', () => {
        const store = new BetaTimelineStore()
        store.setHistory([agentText('hub-row:0', { meta: { runtimeCanonicalId: 'assistant-uuid' } })])
        store.applyPublication({ kind: 'snapshot', snapshot: snapshot([runtimeItem('tool-live', { kind: 'tool', canonicalId: 'assistant-uuid', tool: { id: 'native-tool', name: 'Bash', input: {} } })]) })
        expect(store.getRows()).toHaveLength(2)
    })
})

describe('canonical runtime to durable pipeline', () => {
    it('keeps thinking plus text exactly once and retains length stopReason through a real Hub record', () => {
        const store = new BetaTimelineStore()
        store.applyPublication({
            kind: 'snapshot',
            snapshot: snapshot([
                runtimeItem('display-id', { canonicalId: 'display-id', state: 'completed', reasoning: 'Consider the constraints', text: 'Final answer', stopReason: 'length' })
            ], run('r', 'idle', { stopReason: 'length', endedAt: 3 }))
        })
        const liveKey = store.getRows()[0].id
        const normalized = normalizeDecryptedMessage({
            id: 'hub-generated-row-id',
            localId: null,
            seq: 17,
            createdAt: 3,
            content: {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'assistant',
                        uuid: 'display-id',
                        stopReason: 'length',
                        runId: 'r',
                        message: {
                            role: 'assistant',
                            model: 'p/m',
                            content: [
                                { type: 'thinking', thinking: 'Consider the constraints' },
                                { type: 'text', text: 'Final answer' }
                            ]
                        }
                    }
                }
            }
        })
        if (!normalized) throw new Error('Expected canonical assistant record to normalize')
        store.setHistory(reduceChatBlocks([normalized], null).blocks)
        const rows = store.getAllRows()
        expect(rows).toHaveLength(2)
        expect(rows.every(row => row.kind === 'history')).toBe(true)
        expect(rows[0].id).toBe(liveKey)
        expect(rows.map(row => row.kind === 'history' && 'text' in row.block ? row.block.text : null))
            .toEqual(['Consider the constraints', 'Final answer'])
        for (const row of rows) {
            expect(row.kind === 'history' && 'meta' in row.block && row.block.meta).toMatchObject({
                runtimeCanonicalId: 'display-id', runtimeRunId: 'r', runtimeStopReason: 'length'
            })
        }
        expect(store.getStatus().run?.stopReason).toBe('length')
        expect(store.getStatus().run?.state).toBe('idle')
    })
})

describe('BetaTimelineStore review regressions', () => {
    it('anchors an aborted partial row to the row that preceded it, not to its timestamp', () => {
        const store = new BetaTimelineStore()
        store.setHistory([
            userText('u-old', { createdAt: 10 }),
            agentText('mid:0', { createdAt: 20 }),
            userText('u-new', { createdAt: 30 })
        ])
        store.applyPublication({ kind: 'snapshot', snapshot: snapshot() })
        // An aborted/partial item whose commit never produced blocks stays
        // after the last visible row even though a later durable turn has a
        // larger clock value — placement is structural, not temporal.
        store.applyPublication({
            kind: 'patch',
            patch: patch(1, [{ type: 'item', item: runtimeItem('ghost', { createdAt: 5, updatedAt: 5, state: 'aborted', text: 'partial output' }) }])
        })
        expect(store.getRows().map(ref => ref.id)).toEqual(['h:u-old', 'h:mid:0', 'h:u-new', 'r:ghost'])
        store.setHistory([
            userText('u-old', { createdAt: 10 }),
            agentText('mid:0', { createdAt: 20 }),
            userText('u-new', { createdAt: 30 }),
            userText('next', { createdAt: 40 })
        ])
        expect(store.getRows().map(ref => ref.id)).toEqual(['h:u-old', 'h:mid:0', 'h:u-new', 'r:ghost', 'h:next'])
    })

    it('does not let runner/hub clock skew push a live row above older history', () => {
        const store = new BetaTimelineStore()
        store.setHistory([userText('u1', { createdAt: 1000 })])
        // Runner clock far behind the hub: createdAt 1 << 1000 must not matter.
        store.applyPublication({ kind: 'snapshot', snapshot: snapshot([runtimeItem('live', { createdAt: 1, updatedAt: 1 })]) })
        expect(store.getRows().map(ref => ref.id)).toEqual(['h:u1', 'r:live'])
    })

    it('does not churn an overlaid history row when unrelated history updates', () => {
        const store = new BetaTimelineStore()
        const raw = toolBlock('msg:0', 'tool-1', { tool: { id: 'tool-1', name: 'Bash', state: 'running', input: { command: 'ls' }, createdAt: 1, startedAt: 1, completedAt: null, execStartedAt: null, execCompletedAt: null, description: null } })
        const user = userText('u1')
        store.setHistory([raw, user])
        store.applyPublication({ kind: 'snapshot', snapshot: snapshot() })
        store.applyPublication({
            kind: 'patch',
            patch: patch(1, [{ type: 'item', item: runtimeItem('tool-live', { kind: 'tool', tool: { id: 'tool-1', name: 'Bash', input: { command: 'ls' }, output: 'progress' } }) }])
        })
        const overlaid = store.getRow('h:msg:0')
        expect(overlaid?.kind).toBe('history')
        expect(overlaid && overlaid.kind === 'history' && overlaid.block.kind === 'tool-call' ? overlaid.block.tool.result : null).toBe('progress')

        const listener = vi.fn()
        const otherListener = vi.fn()
        store.subscribeRow('h:msg:0', listener)
        store.subscribeRow('h:u1', otherListener)
        store.setHistory([raw, user, agentText('new:0')])

        expect(store.getRow('h:msg:0')).toBe(overlaid)
        expect(listener).not.toHaveBeenCalled()
        expect(otherListener).not.toHaveBeenCalled()
    })

    it('adopts the native tool key, not the assistant canonical key, for tool-only messages', () => {
        const store = new BetaTimelineStore()
        store.applyPublication({
            kind: 'snapshot',
            snapshot: snapshot([
                runtimeItem('assistant-uuid', { canonicalId: 'assistant-uuid' }),
                runtimeItem('native-tool', { kind: 'tool', canonicalId: 'assistant-uuid', tool: { id: 'native-tool', name: 'Bash', input: {} } })
            ])
        })
        store.setHistory([toolBlock('hub:0', 'native-tool', { meta: { runtimeCanonicalId: 'assistant-uuid' } })])
        const refs = store.getRows()
        expect(refs).toHaveLength(1)
        expect(refs[0].id).toBe('r:native-tool')
        const row = store.getRow('r:native-tool')
        // Identity and content matter; the adopted row now holds durable data.
        expect(row?.kind).toBe('history')
        expect(row && row.kind === 'history' && row.block.kind === 'tool-call' ? row.block.tool.id : null).toBe('native-tool')
    })

    it('recomputes tool-group summary counts on overlay completion', () => {
        const store = new BetaTimelineStore()
        const group = toolGroup('tool-group:t1', [
            toolBlock('t1', 'tool-1', { tool: { id: 'tool-1', name: 'Bash', state: 'running', input: {}, createdAt: 1, startedAt: 1, completedAt: null, execStartedAt: null, execCompletedAt: null, description: null } }),
            toolBlock('t2', 'tool-2', { tool: { id: 'tool-2', name: 'Bash', state: 'running', input: {}, createdAt: 2, startedAt: 2, completedAt: null, execStartedAt: null, execCompletedAt: null, description: null } })
        ])
        store.setHistory([group])
        store.applyPublication({ kind: 'snapshot', snapshot: snapshot() })
        store.applyPublication({
            kind: 'patch',
            patch: patch(1, [{ type: 'item', item: runtimeItem('live-tool', { kind: 'tool', state: 'error', updatedAt: 5, tool: { id: 'tool-1', name: 'Bash', input: {}, isError: true } }) }])
        })
        const row = store.getRow('h:tool-group:t1')
        const block = row && row.kind === 'history' ? row.block : null
        expect(block?.kind).toBe('tool-group')
        if (block?.kind === 'tool-group') {
            expect(block.summary.runningCount).toBe(1)
            expect(block.summary.errorCount).toBe(1)
            const first = block.tools[0]
            expect(first.tool.state).toBe('error')
        }
    })

    it('preserves durable tool input when the runtime item lacks one', () => {
        const store = new BetaTimelineStore()
        const raw = toolBlock('msg:0', 'tool-1', { tool: { id: 'tool-1', name: 'Bash', state: 'running', input: { command: 'ls -la' }, createdAt: 1, startedAt: 1, completedAt: null, execStartedAt: null, execCompletedAt: null, description: null } })
        store.setHistory([raw])
        store.applyPublication({ kind: 'snapshot', snapshot: snapshot() })
        store.applyPublication({
            kind: 'patch',
            patch: patch(1, [{ type: 'item', item: runtimeItem('tool-live', { kind: 'tool', state: 'completed', updatedAt: 4, tool: { id: 'tool-1', name: 'Bash', input: null, output: 'done' } }) }])
        })
        const row = store.getRow('h:msg:0')
        const tool = row && row.kind === 'history' && row.block.kind === 'tool-call' ? row.block.tool : null
        expect(tool?.input).toEqual({ command: 'ls -la' })
        expect(tool?.result).toBe('done')
        expect(tool?.state).toBe('completed')
    })
})

describe('runtime delete and tombstones', () => {
    it('removes an uncovered live row on explicit delete and keeps durable rows intact', () => {
        const store = new BetaTimelineStore()
        store.setHistory([userText('u1')])
        store.applyPublication({
            kind: 'snapshot',
            snapshot: snapshot([runtimeItem('live-1'), runtimeItem('live-2')])
        })
        expect(store.getRows().map(ref => ref.id)).toEqual(['h:u1', 'r:live-1', 'r:live-2'])
        const structure = vi.fn()
        const removedRow = vi.fn()
        const unaffectedRow = vi.fn()
        store.subscribeRows(structure)
        store.subscribeRow('r:live-1', removedRow)
        store.subscribeRow('r:live-2', unaffectedRow)
        store.applyPublication({ kind: 'patch', patch: patch(1, [{ type: 'delete', id: 'live-1' }]) })
        expect(store.getRows().map(ref => ref.id)).toEqual(['h:u1', 'r:live-2'])
        expect(store.getRow('r:live-1')).toBeUndefined()
        expect(structure).toHaveBeenCalledTimes(1)
        expect(removedRow).toHaveBeenCalledTimes(1)
        expect(unaffectedRow).not.toHaveBeenCalled()
    })

    it('keeps the durable row that adopted a deleted runtime key and reverts its overlay', () => {
        const store = new BetaTimelineStore()
        store.applyPublication({
            kind: 'snapshot',
            snapshot: snapshot([runtimeItem('tool-live', { kind: 'tool', tool: { id: 'tool-1', name: 'Bash', input: { command: 'ls' }, output: 'progress' } })])
        })
        const raw = toolBlock('msg:0', 'tool-1', { tool: { id: 'tool-1', name: 'Bash', state: 'running', input: { command: 'ls' }, createdAt: 1, startedAt: 1, completedAt: null, execStartedAt: null, execCompletedAt: null, description: null } })
        store.setHistory([raw])
        const adopted = store.getRow('r:tool-live')
        expect(adopted?.kind).toBe('history')
        expect(adopted && adopted.kind === 'history' && adopted.block.kind === 'tool-call' ? adopted.block.tool.result : null).toBe('progress')
        const refs = store.getRows()
        const structure = vi.fn()
        const rowListener = vi.fn()
        store.subscribeRows(structure)
        store.subscribeRow('r:tool-live', rowListener)
        store.applyPublication({ kind: 'patch', patch: patch(1, [{ type: 'delete', id: 'tool-live' }]) })
        const after = store.getRow('r:tool-live')
        expect(store.getRows().map(ref => ref.id)).toEqual(['r:tool-live'])
        expect(after?.kind).toBe('history')
        expect(after && after.kind === 'history' ? after.block : null).toBe(raw)
        expect(store.getRows()).toBe(refs)
        expect(structure).not.toHaveBeenCalled()
        expect(rowListener).toHaveBeenCalledTimes(1)
    })

    it('ignores a stale replay of a deleted item but accepts a newer emission', () => {
        const store = new BetaTimelineStore()
        store.applyPublication({ kind: 'snapshot', snapshot: snapshot([runtimeItem('live', { updatedAt: 5, text: 'a' })]) })
        store.applyPublication({ kind: 'patch', patch: patch(1, [{ type: 'delete', id: 'live' }]) })
        expect(store.getRows()).toHaveLength(0)
        store.applyPublication({ kind: 'patch', patch: patch(2, [{ type: 'item', item: runtimeItem('live', { updatedAt: 4, text: 'stale' }) }]) })
        expect(store.getRows()).toHaveLength(0)
        store.applyPublication({ kind: 'patch', patch: patch(3, [{ type: 'item', item: runtimeItem('live', { updatedAt: 5, text: 'equal' }) }]) })
        expect(store.getRows()).toHaveLength(0)
        store.applyPublication({ kind: 'patch', patch: patch(4, [{ type: 'item', item: runtimeItem('live', { updatedAt: 6, text: 'new' }) }]) })
        expect(store.getRows().map(ref => ref.id)).toEqual(['r:live'])
        expect(store.getRow('r:live')?.kind).toBe('runtime')
    })

    it('restores the raw durable row when the overlaying item is deleted', () => {
        const store = new BetaTimelineStore()
        const raw = toolBlock('msg:0', 'tool-1', { tool: { id: 'tool-1', name: 'Bash', state: 'running', input: { command: 'ls' }, createdAt: 1, startedAt: 1, completedAt: null, execStartedAt: null, execCompletedAt: null, description: null } })
        store.setHistory([raw])
        store.applyPublication({ kind: 'snapshot', snapshot: snapshot() })
        store.applyPublication({
            kind: 'patch',
            patch: patch(1, [{ type: 'item', item: runtimeItem('tool-live', { kind: 'tool', tool: { id: 'tool-1', name: 'Bash', input: { command: 'ls' }, output: 'progress' } }) }])
        })
        store.applyPublication({ kind: 'patch', patch: patch(2, [{ type: 'delete', id: 'tool-live' }]) })
        const row = store.getRow('h:msg:0')
        expect(row?.kind).toBe('history')
        expect(row && row.kind === 'history' ? row.block : null).toBe(raw)
    })

    it('does not resurrect a deleted terminal item in the same run but permits a new run', () => {
        const store = new BetaTimelineStore()
        store.applyPublication({ kind: 'snapshot', snapshot: snapshot([runtimeItem('reused', { runId: 'old', state: 'aborted', updatedAt: 5 })]) })
        store.applyPublication({ kind: 'patch', patch: patch(1, [{ type: 'delete', id: 'reused' }]) })
        store.applyPublication({ kind: 'patch', patch: patch(2, [{ type: 'item', item: runtimeItem('reused', { runId: 'old', state: 'running', updatedAt: 6 }) }]) })
        expect(store.getRows()).toHaveLength(0)
        const next = runtimeItem('reused', { runId: 'new', state: 'running', updatedAt: 1, previewOmitted: true })
        store.applyPublication({ kind: 'patch', patch: patch(3, [{ type: 'item', item: next }]) })
        const row = store.getRow('r:reused')
        expect(row?.kind === 'runtime' && row.item).toBe(next)
    })

    it('deletes one grouped tool overlay without losing the other tool or durable permission', () => {
        const store = new BetaTimelineStore()
        const first = toolBlock('first', 't1')
        const second = toolBlock('second', 't2')
        first.tool = { ...first.tool, state: 'running' }
        second.tool = { ...second.tool, state: 'running' }
        const group = toolGroup('group', [first, second])
        store.setHistory([group])
        const rowId = store.getRows()[0].id
        store.applyPublication({
            kind: 'snapshot', snapshot: snapshot([
                runtimeItem('one', { kind: 'tool', tool: { id: 't1', name: 'Bash', input: {}, output: 'one preview' } }),
                runtimeItem('two', { kind: 'tool', tool: { id: 't2', name: 'Bash', input: {}, output: 'two preview' } })
            ])
        })
        store.applyPublication({ kind: 'patch', patch: patch(1, [{ type: 'delete', id: 'one' }]) })
        const row = store.getRow(rowId)
        expect(row?.kind).toBe('history')
        if (row?.kind === 'history' && row.block.kind === 'tool-group') {
            expect(row.block.tools[0]).toBe(first)
            expect(row.block.tools[1].tool.result).toBe('two preview')
            expect(row.block.tools[1].tool.permission).toBe(second.tool.permission)
        } else {
            throw new Error('Expected preserved durable tool group')
        }
    })
})
