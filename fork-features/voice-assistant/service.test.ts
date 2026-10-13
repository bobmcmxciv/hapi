import { describe, expect, it } from 'bun:test'
import type { TranscriptMessage } from '../session-digest/transcript'
import { buildSessionMaterial, recentToolActivity, type VoiceDigestView, type VoiceSessionView } from './material'
import { parseJsonObject } from './prompts'
import { VoiceAssistant, VoiceAssistantUnavailableError, type VoiceLlmProvider } from './service'

const NOW = 1_800_000_000_000
const user = (seq: number, text: string): TranscriptMessage => ({ seq, content: { role: 'user', content: { type: 'text', text } } })
const assistant = (seq: number, text: string, tool?: { name: string; input: Record<string, unknown> }): TranscriptMessage => ({
    seq,
    content: {
        role: 'agent',
        content: {
            type: 'output',
            data: {
                type: 'assistant',
                message: { content: [{ type: 'text', text }, ...(tool ? [{ type: 'tool_use', name: tool.name, input: tool.input }] : [])] }
            }
        }
    }
})

function session(id: string, name: string, extra: Partial<VoiceSessionView> = {}): VoiceSessionView {
    return { id, active: true, thinking: false, updatedAt: NOW - 60_000, metadata: { name, path: `C:\\work\\${id}` }, ...extra }
}

const digest = (title: string, status: string, sourceSeq: number): VoiceDigestView => ({
    title, status, done: ['读完代码'], todo: ['补测试'], generatedAt: NOW - 10 * 60_000, sourceSeq
})

function fakeProvider(label: string, replies: Array<string | Error>): VoiceLlmProvider & { prompts: Array<{ system: string; prompt: string }> } {
    const prompts: Array<{ system: string; prompt: string }> = []
    return {
        label,
        model: `${label}-model`,
        prompts,
        call: async ({ system, prompt }) => {
            prompts.push({ system, prompt })
            const reply = replies.shift()
            if (reply === undefined) throw new Error(`${label}: no scripted reply`)
            if (reply instanceof Error) throw reply
            return reply
        }
    }
}

function assistantWith(options: {
    sessions: VoiceSessionView[]
    digests?: Record<string, VoiceDigestView>
    messages?: Record<string, TranscriptMessage[]>
    providers: VoiceLlmProvider[]
}) {
    return new VoiceAssistant({
        getSession: (id) => options.sessions.find((s) => s.id === id),
        getRecentMessages: (id) => options.messages?.[id] ?? [],
        getDigest: (id) => options.digests?.[id] ?? null,
        getProject: () => null,
        providers: options.providers,
        now: () => NOW
    })
}

describe('voice-assistant material', () => {
    it('puts live state, the digest and only messages newer than the digest into the material', () => {
        const material = buildSessionMaterial({
            session: session('s1', '语音改造', {
                thinking: true,
                activeTurnStartedAt: NOW - 5 * 60_000,
                agentState: { requests: { r1: { tool: 'Bash', arguments: { command: 'rm -rf build' } } } },
                todos: [{ content: '写测试', status: 'in_progress' }]
            }),
            digest: digest('语音改造', '在写 hub 模块', 2),
            project: null,
            messages: [user(1, '旧消息不该出现'), assistant(2, '旧回复也不该出现'), user(3, '新的问题'), assistant(4, '新的回复', { name: 'Bash', input: { description: '跑单元测试' } })],
            now: NOW
        })
        expect(material).toContain('代理正在工作')
        expect(material).toContain('5 分钟')
        expect(material).toContain('正在等用户批准：Bash：rm -rf build')
        expect(material).toContain('[进行中] 写测试')
        expect(material).toContain('现状：在写 hub 模块')
        expect(material).toContain('新的问题')
        expect(material).not.toContain('旧消息不该出现')
        expect(material).toContain('Bash：跑单元测试')
    })

    it('lists recent tool calls oldest first and caps the count', () => {
        const messages = Array.from({ length: 12 }, (_, i) => assistant(i + 1, `第${i}步`, { name: 'Edit', input: { file_path: `f${i}.ts` } }))
        const lines = recentToolActivity(messages, 3)
        expect(lines).toEqual(['Edit：f9.ts', 'Edit：f10.ts', 'Edit：f11.ts'])
    })

    it('parses JSON wrapped in a code fence', () => {
        expect(parseJsonObject('```json\n{"a": 1}\n```')).toEqual({ a: 1 })
        expect(parseJsonObject('no json here')).toBeNull()
    })
})

describe('VoiceAssistant.ask', () => {
    it('answers from the primary model and sends the session material', async () => {
        const primary = fakeProvider('primary', ['现在在写测试，还剩部署。'])
        const va = assistantWith({ sessions: [session('s1', '语音改造')], digests: { s1: digest('语音改造', '在写测试', 0) }, providers: [primary] })
        const result = await va.ask({ sessionId: 's1', question: '做到哪了？' })
        expect(result).toEqual({ answer: '现在在写测试，还剩部署。', model: 'primary-model', ms: 0 })
        expect(primary.prompts[0]!.prompt).toContain('现状：在写测试')
        expect(primary.prompts[0]!.prompt).toContain('问题：做到哪了？')
    })

    it('falls back to the next model when the primary fails', async () => {
        const primary = fakeProvider('primary', [new Error('LLM HTTP 402: Payment Required')])
        const fallback = fakeProvider('fallback', ['luna 的回答'])
        const va = assistantWith({ sessions: [session('s1', 'x')], providers: [primary, fallback] })
        const result = await va.ask({ sessionId: 's1', question: '怎么样了' })
        expect(result.answer).toBe('luna 的回答')
        expect(result.model).toBe('fallback-model')
    })

    it('reports unavailable when no model is configured', async () => {
        const va = assistantWith({ sessions: [session('s1', 'x')], providers: [] })
        await expect(va.ask({ sessionId: 's1', question: '怎么样了' })).rejects.toBeInstanceOf(VoiceAssistantUnavailableError)
    })
})

describe('VoiceAssistant.prepareInstruction', () => {
    const readyReply = JSON.stringify({ instruction: '跑一下测试，告诉我哪些失败。先别改代码。', readback: '跑测试，报失败项，不改代码', ask: null })

    it('targets the current session when the user names no other session, without asking the model to pick', async () => {
        const primary = fakeProvider('primary', [readyReply])
        const sessions = [session('aaaa1111', '语音改造'), session('bbbb2222', '视频渲染')]
        const va = assistantWith({ sessions, providers: [primary] })
        const result = await va.prepareInstruction({ currentSessionId: 'aaaa1111', utterance: '让它跑下测试，先别改代码', candidates: sessions })
        expect(result).toMatchObject({ status: 'ready', target: { id: 'aaaa1111', title: '语音改造' }, readback: '跑测试，报失败项，不改代码' })
        expect(primary.prompts).toHaveLength(1)
        expect(primary.prompts[0]!.prompt).toContain('用户原话：让它跑下测试，先别改代码')
    })

    it('picks a named session by title without a model call for the target', async () => {
        const primary = fakeProvider('primary', [readyReply])
        const sessions = [session('aaaa1111', '语音改造'), session('bbbb2222', '视频渲染')]
        const va = assistantWith({ sessions, providers: [primary] })
        const result = await va.prepareInstruction({ currentSessionId: 'aaaa1111', utterance: '渲染先停', targetHint: '视频渲染', candidates: sessions })
        expect(result).toMatchObject({ status: 'ready', target: { id: 'bbbb2222' } })
        expect(primary.prompts).toHaveLength(1)
    })

    it('returns the candidates when the model is not sure which session the user means', async () => {
        const primary = fakeProvider('primary', [JSON.stringify({ matches: ['bbbb2222', 'cccc3333'], confident: false })])
        const sessions = [session('aaaa1111', '语音改造'), session('bbbb2222', '山海经出图'), session('cccc3333', '浦东成片')]
        const va = assistantWith({ sessions, providers: [primary] })
        const result = await va.prepareInstruction({ currentSessionId: 'aaaa1111', utterance: '先停一下', targetHint: '做视频的那个', candidates: sessions })
        expect(result).toMatchObject({ status: 'ambiguous', candidates: [{ id: 'bbbb2222' }, { id: 'cccc3333' }] })
        if (result.status === 'ambiguous') expect(result.ask).toContain('《山海经出图》')
    })

    it('ignores empty or too-short ids from the model instead of matching every session', async () => {
        const primary = fakeProvider('primary', [JSON.stringify({ matches: [''], confident: true })])
        const sessions = [session('aaaa1111', '语音改造'), session('bbbb2222', '视频渲染')]
        const va = assistantWith({ sessions, providers: [primary] })
        const result = await va.prepareInstruction({ currentSessionId: 'aaaa1111', utterance: 'x', targetHint: '那个', candidates: sessions })
        expect(result.status).toBe('no_target')
    })

    it('passes the model question through when the instruction cannot be executed as said', async () => {
        const primary = fakeProvider('primary', [JSON.stringify({ instruction: '跑测试', readback: '跑测试', ask: '要跑哪一组测试？' })])
        const sessions = [session('aaaa1111', '语音改造')]
        const va = assistantWith({ sessions, providers: [primary] })
        const result = await va.prepareInstruction({ currentSessionId: 'aaaa1111', utterance: '跑那个测试', candidates: sessions })
        expect(result).toEqual({ status: 'need_info', target: { id: 'aaaa1111', title: '语音改造' }, ask: '要跑哪一组测试？' })
    })

    it('refuses to draft for a stopped session', async () => {
        const primary = fakeProvider('primary', [])
        const sessions = [session('aaaa1111', '已停的会话', { active: false })]
        const va = assistantWith({ sessions, providers: [primary] })
        const result = await va.prepareInstruction({ currentSessionId: 'aaaa1111', utterance: '继续', candidates: sessions })
        expect(result).toEqual({ status: 'target_inactive', target: { id: 'aaaa1111', title: '已停的会话' } })
        expect(primary.prompts).toHaveLength(0)
    })
})
