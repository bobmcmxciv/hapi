import { describe, expect, it } from 'bun:test'
import { extractTodoWriteTodosFromMessageContent as extractTodos } from './todos'

function nativeResult(details: unknown, options: { toolName?: string; isError?: boolean; outputError?: boolean } = {}) {
    const output = { toolName: options.toolName ?? 'todo', content: [], details, isError: options.outputError }
    return {
        role: 'agent',
        content: {
            type: 'output',
            data: {
                type: 'user',
                message: { role: 'user', content: [{ type: 'tool_result', content: output, is_error: options.isError }] },
                toolUseResult: output
            }
        }
    }
}

function codexResult(output: unknown, overrides: Record<string, unknown> = {}) {
    return { role: 'agent', content: { type: 'codex', data: { type: 'tool-call-result', name: 'todo', output, ...overrides } } }
}

const details = {
    op: 'view',
    phases: [{ name: 'Repair', tasks: [
        { id: '1', content: 'Waiting', status: 'pending' },
        { id: '2', content: 'Working', status: 'in_progress' },
        { id: '3', content: 'Done', status: 'completed' },
        { id: '4', content: 'Blocked', status: 'blocked' },
        { id: '5', content: 'Dropped', status: 'abandoned' }
    ] }]
} as const

const expected = details.phases[0]!.tasks.map((task) => ({
    id: task.id,
    content: task.content,
    priority: 'medium' as const,
    status: task.status === 'blocked' ? 'pending' : task.status === 'abandoned' ? 'completed' : task.status
}))

describe('OMP authoritative todo snapshots', () => {
    it('extracts successful canonical native tool_result details from agent and assistant envelopes', () => {
        const message = nativeResult(details)
        expect(extractTodos(message)).toEqual(expected)
        expect(extractTodos({ role: 'assistant', content: message.content })).toEqual(expected)
    })

    it('retains explicitly labelled ACP/codex completed result support', () => {
        expect(extractTodos(codexResult({ details }))).toEqual(expected)
        expect(extractTodos(codexResult(JSON.stringify({ details })))).toEqual(expected)
    })

    it('clears tasks for a successful explicitly empty snapshot', () => {
        expect(extractTodos(nativeResult({ op: 'init', phases: [] }))).toEqual([])
        expect(extractTodos(codexResult({ details: { op: 'view', phases: [] } }))).toEqual([])
    })

    it('ignores native and codex errors rather than clearing the previous snapshot', () => {
        expect(extractTodos(nativeResult(details, { isError: true }))).toBeNull()
        expect(extractTodos(nativeResult(details, { outputError: true }))).toBeNull()
        expect(extractTodos(codexResult({ details }, { is_error: true }))).toBeNull()
        expect(extractTodos(codexResult({ details, isError: true }))).toBeNull()
    })

    it('ignores non-todo tools, unlabelled results, and incremental inputs', () => {
        expect(extractTodos(nativeResult(details, { toolName: 'bash' }))).toBeNull()
        const unlabelled = nativeResult(details)
        const block = unlabelled.content.data.message.content[0]!
        expect(extractTodos({ role: 'agent', content: { type: 'output', data: {
            type: 'user', message: { content: [{ ...block, content: { details } }] }
        } } })).toBeNull()
        expect(extractTodos(codexResult({ details }, { name: 'bash' }))).toBeNull()
        expect(extractTodos(codexResult({ details }, { name: undefined }))).toBeNull()
        expect(extractTodos(codexResult({ details }, { type: 'tool-call', input: details }))).toBeNull()
        expect(extractTodos({ role: 'agent', content: { type: 'output', data: {
            type: 'assistant', message: { content: [{ type: 'tool_use', name: 'todo', input: details }] }
        } } })).toBeNull()
        expect(extractTodos({ role: 'user', content: nativeResult(details).content })).toBeNull()
    })

    it('rejects malformed snapshots atomically, including unknown statuses and missing details', () => {
        for (const invalid of [
            null,
            { phases: [] },
            { op: 'unknown', phases: [] },
            { op: 'view', phases: null },
            { op: 'view', phases: [{ tasks: [] }] },
            { op: 'view', phases: [{ name: 'Repair', tasks: null }] },
            { op: 'view', phases: [{ name: 'Repair', tasks: [{ content: 'Bad', status: 'unknown' }] }] },
            { op: 'view', phases: [{ name: 'Repair', tasks: [{ content: ' ', status: 'pending' }] }] },
            { op: 'view', phases: [details.phases[0], { name: 'Bad', tasks: [null] }] }
        ]) {
            expect(extractTodos(nativeResult(invalid))).toBeNull()
            expect(extractTodos(codexResult({ details: invalid }))).toBeNull()
        }
        expect(extractTodos(codexResult(details))).toBeNull()
        expect(extractTodos(codexResult('{bad json'))).toBeNull()
    })
})
