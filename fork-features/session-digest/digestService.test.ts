import { describe, expect, it } from 'bun:test'
import { DigestStore } from './digestStore'
import { DigestService, IDLE_MS, PROJECT_DEBOUNCE_MS, projectKeyOf, type DigestSessionView } from './digestService'
import { extractTranscriptLine, parseSessionDigest, renderTranscript, type TranscriptMessage } from './transcript'

const user = (seq: number, text: string): TranscriptMessage => ({ seq, content: { role: 'user', content: { type: 'text', text } } })
const assistant = (seq: number, text: string): TranscriptMessage => ({
    seq,
    content: { role: 'agent', content: { type: 'output', data: { type: 'assistant', message: { content: [{ type: 'text', text }, { type: 'tool_use', name: 'Bash' }] } } } }
})
const toolResult = (seq: number): TranscriptMessage => ({
    seq,
    content: { role: 'agent', content: { type: 'output', data: { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'x'.repeat(5000) }] } } } }
})

const REPLY = JSON.stringify({ title: '机器图标', done: ['加了图标选择'], status: '已上线', todo: [], suggestComplete: true })

function setup(options: { sessions: DigestSessionView[]; messages: Record<string, TranscriptMessage[]>; reply?: string; now?: number }) {
    const store = new DigestStore(':memory:')
    const calls: Array<{ model: string; prompt: string; system: string }> = []
    const renames: Array<{ id: string; name: string }> = []
    let now = options.now ?? 10 * IDLE_MS
    const sessions = options.sessions
    const service = new DigestService({
        store,
        getSessions: () => sessions,
        getSession: id => sessions.find(session => session.id === id),
        getRecentMessages: (id, limit) => (options.messages[id] ?? []).slice(-limit),
        getFirstMessages: (id, limit) => (options.messages[id] ?? []).slice(0, limit),
        renameSession: async (id, name) => {
            renames.push({ id, name })
            const session = sessions.find(entry => entry.id === id)
            if (session?.metadata) session.metadata.name = name
        },
        llm: async (params) => {
            calls.push(params)
            return options.reply ?? REPLY
        },
        defaults: { enabled: true, model: 'gpt-6-luna', autoRename: true, maxPerHour: 60 },
        now: () => now
    })
    return { store, service, calls, renames, advance: (ms: number) => { now += ms } }
}

const idleSession = (id: string, extra: Partial<DigestSessionView['metadata']> = {}): DigestSessionView => ({
    id, updatedAt: 1000, thinking: false, metadata: { path: '/repo', machineId: 'm1', ...extra }
})

describe('transcript', () => {
    it('keeps user text and assistant text, drops tool results and injected blocks', () => {
        expect(extractTranscriptLine(user(1, '<hapi_user_context user="a">我的电脑</hapi_user_context>修一下'))).toEqual({ seq: 1, role: 'user', text: '修一下' })
        expect(extractTranscriptLine(assistant(2, '改好了'))).toEqual({ seq: 2, role: 'assistant', text: '改好了' })
        expect(extractTranscriptLine(toolResult(3))).toBeNull()
        expect(extractTranscriptLine({ seq: 4, content: { role: 'agent', content: { type: 'codex', data: { type: 'message', message: 'codex 回复' } } } }))
            .toEqual({ seq: 4, role: 'assistant', text: 'codex 回复' })
    })

    it('keeps the opening and the most recent lines when over budget', () => {
        const lines = Array.from({ length: 200 }, (_, i) => ({ seq: i, role: 'user' as const, text: `第${i}条`.padEnd(50, '。') }))
        const text = renderTranscript(lines, 2000)
        expect(text.length).toBeLessThanOrEqual(2100)
        expect(text).toContain('第0条')
        expect(text).toContain('第199条')
        expect(text).toContain('中间省略')
    })

    it('parses JSON wrapped in prose and rejects garbage', () => {
        expect(parseSessionDigest(`好的：\n${REPLY}\n`)?.title).toBe('机器图标')
        expect(parseSessionDigest('无法总结')).toBeNull()
    })
})

describe('DigestService', () => {
    it('skips busy or recently active sessions and summarizes idle ones', async () => {
        const busy = { ...idleSession('busy'), thinking: true }
        const recent = { ...idleSession('recent'), updatedAt: 10 * IDLE_MS - 1000 }
        const idle = idleSession('idle')
        const { service, calls } = setup({
            sessions: [busy, recent, idle],
            messages: { busy: [user(1, 'a')], recent: [user(1, 'b')], idle: [user(1, '做个图标'), assistant(2, '做好了')] }
        })
        expect(await service.tick()).toBe('session:idle')
        expect(calls).toHaveLength(1)
        expect(calls[0]!.model).toBe('gpt-6-luna')
        expect(calls[0]!.prompt).toContain('用户：做个图标')
        expect(service.store.getSession('idle')?.status).toBe('已上线')
        // 下一拍轮到项目汇总；之后没有新消息就不再调用模型。
        expect(await service.tick()).toBe(`project:${projectKeyOf(idle).key}`)
        expect(await service.tick()).toBeNull()
        expect(calls).toHaveLength(2)
    })

    it('auto-renames unnamed sessions but never overrides a manual name', async () => {
        const unnamed = idleSession('a')
        const manual = idleSession('b', { name: '我自己起的名' })
        const { service, renames } = setup({
            sessions: [unnamed, manual],
            messages: { a: [user(1, 'x')], b: [user(1, 'y')] }
        })
        await service.tick()
        await service.tick()
        expect(renames).toEqual([{ id: 'a', name: '机器图标' }])
        expect(service.store.getSession('a')?.autoName).toBe('机器图标')
        expect(manual.metadata?.name).toBe('我自己起的名')
    })

    it('sends only messages after the last digest together with the previous digest', async () => {
        const session = idleSession('s')
        const messages = { s: [user(1, '第一件事'), assistant(2, '完成第一件')] }
        const { service, calls } = setup({ sessions: [session], messages })
        await service.tick()
        messages.s.push(user(3, '第二件事'))
        session.updatedAt += 1
        await service.tick()
        expect(calls).toHaveLength(2)
        expect(calls[1]!.prompt).toContain('此前的摘要')
        expect(calls[1]!.prompt).toContain('第二件事')
        expect(calls[1]!.prompt).not.toContain('第一件事')
    })

    it('records failures and backs off instead of retrying every tick', async () => {
        const { service, calls } = setup({ sessions: [idleSession('s')], messages: { s: [user(1, 'x')] }, reply: '不是 JSON' })
        await service.tick()
        expect(service.store.getSession('s')?.error).toContain('unparseable')
        expect(await service.tick()).toBeNull()
        expect(calls).toHaveLength(1)
    })

    it('honours the hourly cap but lets a manual refresh through', async () => {
        const { service, store } = setup({ sessions: [idleSession('s')], messages: { s: [user(1, 'x')] } })
        service.updateSettings({ maxPerHour: 1 })
        store.recordRun(10 * IDLE_MS)
        expect(await service.tick()).toBeNull()
        service.requestSession('s')
        expect(await service.tick()).toBe('session:s')
    })

    it('rolls session digests up into a project digest after the debounce', async () => {
        const a = idleSession('a')
        const b = idleSession('b')
        const messages = { a: [user(1, 'x')], b: [user(1, 'y')] }
        const { service, calls, advance } = setup({
            sessions: [a, b],
            messages,
            reply: JSON.stringify({ title: 't', done: [], status: 's', todo: [], capabilities: ['能做 A'], suggestComplete: false })
        })
        await service.tick()
        await service.tick()
        expect(await service.tick()).toBe(`project:${projectKeyOf(a).key}`)
        expect(calls[2]!.system).toContain('项目')
        expect(service.store.getProject(projectKeyOf(a).key)?.capabilities).toEqual(['能做 A'])
        // 会话 b 有了新消息、摘要更新；项目刚生成过，未到去抖时间不重算。
        advance(60_000)
        messages.b.push(user(2, 'z'))
        b.updatedAt += 1
        expect(await service.tick()).toBe('session:b')
        expect(await service.tick()).toBeNull()
        advance(PROJECT_DEBOUNCE_MS)
        expect(await service.tick()).toBe(`project:${projectKeyOf(a).key}`)
    })

    it('marks and unmarks completion without touching the digest text', async () => {
        const { service } = setup({ sessions: [idleSession('s')], messages: { s: [user(1, 'x')] } })
        await service.tick()
        expect(service.setCompleted('s', true).completed).toBe(true)
        expect(service.store.getSession('s')?.title).toBe('机器图标')
        expect(service.setCompleted('s', false).completedAt).toBeNull()
    })
})
