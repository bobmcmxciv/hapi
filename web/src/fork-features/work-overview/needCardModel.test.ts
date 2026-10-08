import { describe, expect, it } from 'vitest'
import { cardRequestsOf, latestCardLines, pickCardSessions, questionAnswers, summarizeRequestArguments } from './needCardModel'

const user = (seq: number, text: string) => ({ seq, content: { role: 'user', content: { type: 'text', text } } })
const assistant = (seq: number, text: string) => ({
    seq,
    content: { role: 'agent', content: { type: 'output', data: { type: 'assistant', message: { content: [{ type: 'text', text }, { type: 'tool_use', name: 'Bash' }] } } } }
})
const codex = (seq: number, text: string) => ({ seq, content: { role: 'agent', content: { type: 'codex', data: { type: 'message', message: text } } } })
const toolResult = (seq: number) => ({ seq, content: { role: 'agent', content: { type: 'output', data: { type: 'user', message: { content: [{ type: 'tool_result' }] } } } } })

describe('need card helpers', () => {
    it('keeps the latest user/assistant text in order and drops tool traffic and injected blocks', () => {
        const lines = latestCardLines([
            assistant(5, '要不要部署？'),
            user(1, '<hapi_user_context user="admin">我的电脑</hapi_user_context>帮我部署'),
            toolResult(3),
            codex(4, '已经准备好了'),
            user(2, '继续')
        ], 3)
        expect(lines.map(line => [line.seq, line.role, line.text])).toEqual([[2, 'user', '继续'], [4, 'assistant', '已经准备好了'], [5, 'assistant', '要不要部署？']])
        expect(latestCardLines([user(1, '<hapi_user_context user="a">x</hapi_user_context>')])).toEqual([])
    })

    it('summarizes permission arguments and parses questions', () => {
        expect(summarizeRequestArguments('Bash', { command: 'git push origin main', description: 'push' })).toBe('git push origin main')
        expect(summarizeRequestArguments('Edit', { file_path: 'C:/a.ts', old_string: 'x' })).toBe('C:/a.ts')
        const requests = cardRequestsOf({
            q1: { tool: 'AskUserQuestion', arguments: { questions: [{ question: '选哪个？', options: [{ label: 'A' }, { label: 'B', description: '更稳' }] }] }, createdAt: 2 },
            p1: { tool: 'Bash', arguments: { command: 'rm -rf build' }, createdAt: 1 }
        })
        expect(requests.map(request => [request.id, request.kind])).toEqual([['p1', 'permission'], ['q1', 'question']])
        const question = requests[1]!
        if (question.kind !== 'question') throw new Error('expected question')
        expect(question.questions[0]!.options.map(option => option.label)).toEqual(['A', 'B'])
    })

    it('orders the sessions a to-do card can switch between and keeps the named one', () => {
        const s = (id: string, active: boolean, pending: number, updatedAt: number) => ({ id, active, pendingRequestsCount: pending, updatedAt })
        const pool = [s('old', false, 0, 1), s('run', true, 0, 5), s('wait', false, 2, 2), s('new', false, 0, 9), s('run', true, 0, 5)]
        expect(pickCardSessions(pool, null).list.map(x => x.id)).toEqual(['wait', 'run', 'new', 'old'])
        expect(pickCardSessions(pool, null).initial).toBe('wait')
        expect(pickCardSessions(pool, 'old').initial).toBe('old')
        const capped = pickCardSessions(pool, 'old', 2)
        expect(capped.list.map(x => x.id)).toEqual(['wait', 'old'])
        expect(pickCardSessions([], 'gone')).toEqual({ initial: null, list: [] })
    })

    it('builds answers keyed by question index like the chat footer, and refuses unanswered questions', () => {
        const questions = [
            { header: null, question: '选哪个？', options: [{ label: 'A', description: null }, { label: 'B', description: null }], multiSelect: false },
            { header: null, question: '还要什么？', options: [{ label: 'X', description: null }], multiSelect: true }
        ]
        expect(questionAnswers(questions, [[1], [0]], ['', '再加一条'])).toEqual({ '0': ['B'], '1': ['X', '再加一条'] })
        expect(questionAnswers(questions, [[1], []], ['', ''])).toBeNull()
    })
})
