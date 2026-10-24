import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import { updateCurrentSessionId } from '@/realtime/RealtimeSession'
import {
    noteVoiceToolCall,
    onVoiceResponseWithoutTool,
    onVoiceUserTranscript,
    realtimeClientTools,
    registerSessionStore,
    registerVoiceAssistantApi,
    resetVoiceAssistantState
} from '@/realtime/realtimeClientTools'
import { composeVoiceInstructionText, getVoiceInstructionDraft } from './instructionDraft'
import { classifyVoiceModeSwitch, readVoiceToolMode, writeVoiceToolMode } from './toolMode'

function fakeApi() {
    return {
        askVoiceSessionStatus: vi.fn(async () => ({ answer: '在写测试，还剩部署。', model: 'deepseek-flash', ms: 900 })),
        prepareVoiceInstruction: vi.fn(async () => ({
            status: 'ready' as const,
            target: { id: 'target-1', title: '视频渲染' },
            instruction: '渲染先暂停，等我回来再开始。',
            readback: '渲染先停，等你回来再开',
            original: '跟做视频那个说渲染先等等',
            model: 'deepseek-flash'
        })),
        sendMessage: vi.fn(async () => undefined)
    }
}

describe('voice assistant client tools', () => {
    let api: ReturnType<typeof fakeApi>
    const sendMessage = vi.fn()

    beforeEach(() => {
        localStorage.clear()
        api = fakeApi()
        registerVoiceAssistantApi(api as unknown as ApiClient)
        registerSessionStore({
            getSession: () => ({ agentState: { requests: { r1: {} } } }),
            sendMessage,
            approvePermission: vi.fn(async () => undefined),
            denyPermission: vi.fn(async () => undefined)
        })
        updateCurrentSessionId('current-1')
        resetVoiceAssistantState()
        sendMessage.mockReset()
    })

    afterEach(() => {
        registerVoiceAssistantApi(null)
        updateCurrentSessionId(null)
    })

    it('defaults to read-only', () => {
        expect(readVoiceToolMode()).toBe('readonly')
    })

    it('read-only mode refuses every action tool and sends nothing', async () => {
        expect(await realtimeClientTools.messageCodingAgent({ message: 'refactor it' })).toContain('read-only')
        expect(await realtimeClientTools.processPermissionRequest({ decision: 'allow' })).toContain('read-only')
        expect(await realtimeClientTools.prepareInstruction({ instruction: '跑测试' })).toContain('read-only')
        expect(await realtimeClientTools.confirmInstruction({ decision: 'send' })).toContain('read-only')
        expect(sendMessage).not.toHaveBeenCalled()
        expect(api.prepareVoiceInstruction).not.toHaveBeenCalled()
        expect(api.sendMessage).not.toHaveBeenCalled()
    })

    it('answers questions in read-only mode and carries the previous turn into the next lookup', async () => {
        const first = await realtimeClientTools.askSessionStatus({ question: '做到哪了？' })
        expect(first).toContain('在写测试，还剩部署。')
        expect(api.askVoiceSessionStatus).toHaveBeenLastCalledWith({ sessionId: 'current-1', question: '做到哪了？', history: [] })

        await realtimeClientTools.askSessionStatus({ question: '部署卡在哪？' })
        expect(api.askVoiceSessionStatus).toHaveBeenLastCalledWith({
            sessionId: 'current-1',
            question: '部署卡在哪？',
            history: [{ q: '做到哪了？', a: '在写测试，还剩部署。' }]
        })
        expect(api.sendMessage).not.toHaveBeenCalled()
    })

    it('drafts, reads back, and only sends after confirmation', async () => {
        writeVoiceToolMode('assistant')
        const prepared = await realtimeClientTools.prepareInstruction({ instruction: '跟做视频那个说渲染先等等', target: '做视频那个' })
        expect(api.prepareVoiceInstruction).toHaveBeenCalledWith({
            currentSessionId: 'current-1',
            utterance: '跟做视频那个说渲染先等等',
            targetHint: '做视频那个',
            history: []
        })
        expect(prepared).toContain('发给《视频渲染》：渲染先停，等你回来再开。确认发送吗？')
        expect(prepared).toContain('NOT sent')
        expect(api.sendMessage).not.toHaveBeenCalled()
        expect(getVoiceInstructionDraft()?.target.id).toBe('target-1')

        const sent = await realtimeClientTools.confirmInstruction({ decision: 'send' })
        expect(sent).toContain('sent to "视频渲染"')
        expect(api.sendMessage).toHaveBeenCalledWith(
            'target-1',
            '渲染先暂停，等我回来再开始。\n\n（语音原话：跟做视频那个说渲染先等等）',
            null, undefined, undefined, undefined, undefined
        )
        expect(getVoiceInstructionDraft()).toBeNull()
    })

    it('steer delivery interrupts the running turn', async () => {
        writeVoiceToolMode('assistant')
        await realtimeClientTools.prepareInstruction({ instruction: '马上停下' })
        await realtimeClientTools.confirmInstruction({ decision: 'send', delivery: 'steer' })
        expect(api.sendMessage).toHaveBeenCalledWith('target-1', expect.any(String), null, undefined, undefined, undefined, 'steer')
    })

    it('cancel drops the draft without sending', async () => {
        writeVoiceToolMode('assistant')
        await realtimeClientTools.prepareInstruction({ instruction: '渲染先等等' })
        expect(await realtimeClientTools.confirmInstruction({ decision: 'cancel' })).toContain('cancelled')
        expect(getVoiceInstructionDraft()).toBeNull()
        expect(api.sendMessage).not.toHaveBeenCalled()
    })

    it('confirm without a draft is an error, not a send', async () => {
        writeVoiceToolMode('assistant')
        expect(await realtimeClientTools.confirmInstruction({ decision: 'send' })).toContain('no drafted instruction')
        expect(api.sendMessage).not.toHaveBeenCalled()
    })

    it('passes the clarifying question back instead of drafting', async () => {
        writeVoiceToolMode('assistant')
        api.prepareVoiceInstruction.mockResolvedValueOnce({
            status: 'ambiguous',
            candidates: [{ id: 'a', title: '山海经出图' }, { id: 'b', title: '浦东成片' }],
            ask: '你指的是哪一个：《山海经出图》、《浦东成片》？'
        } as never)
        const result = await realtimeClientTools.prepareInstruction({ instruction: '先停', target: '做视频的' })
        expect(result).toContain('你指的是哪一个')
        expect(getVoiceInstructionDraft()).toBeNull()
    })

    it('reads back whether a busy target will be interrupted and sends with that delivery', async () => {
        writeVoiceToolMode('assistant')
        api.prepareVoiceInstruction.mockResolvedValueOnce({
            status: 'ready', target: { id: 'target-1', title: '视频渲染' }, instruction: '马上停下渲染。', readback: '停下渲染',
            original: '让它先停下渲染', model: 'deepseek-flash', delivery: 'steer', deliveryReason: '要它停下', targetBusy: true
        } as never)
        const prepared = await realtimeClientTools.prepareInstruction({ instruction: '让它先停下渲染' })
        expect(prepared).toContain('停下渲染（会插进它正在做的这一轮）。确认发送吗？')
        await realtimeClientTools.confirmInstruction({ decision: 'send' })
        expect(api.sendMessage).toHaveBeenLastCalledWith('target-1', expect.any(String), null, undefined, undefined, undefined, 'steer')
    })

    it('sends the pending draft when the model hands the spoken yes to the lookup tool instead', async () => {
        writeVoiceToolMode('assistant')
        await realtimeClientTools.prepareInstruction({ instruction: '跟做视频那个说渲染先等等' })
        const reply = await realtimeClientTools.askSessionStatus({ question: '对，确认发送。' })
        expect(reply).toContain('sent to "视频渲染"')
        expect(api.askVoiceSessionStatus).not.toHaveBeenCalled()
        expect(api.sendMessage).toHaveBeenCalledTimes(1)
        expect(getVoiceInstructionDraft()).toBeNull()
    })

    it('sends the pending draft when the model drafts the spoken yes again, and honours an explicit interrupt', async () => {
        writeVoiceToolMode('assistant')
        await realtimeClientTools.prepareInstruction({ instruction: '跟做视频那个说渲染先等等' })
        const reply = await realtimeClientTools.prepareInstruction({ instruction: '插队发吧' })
        expect(reply).toContain('sent to "视频渲染"')
        expect(api.prepareVoiceInstruction).toHaveBeenCalledTimes(1)
        expect(api.sendMessage).toHaveBeenLastCalledWith('target-1', expect.any(String), null, undefined, undefined, undefined, 'steer')
    })

    it('drops the pending draft on a spoken no that reached the wrong tool', async () => {
        writeVoiceToolMode('assistant')
        await realtimeClientTools.prepareInstruction({ instruction: '跟做视频那个说渲染先等等' })
        expect(await realtimeClientTools.askSessionStatus({ question: '算了' })).toContain('cancelled')
        expect(getVoiceInstructionDraft()).toBeNull()
        expect(api.sendMessage).not.toHaveBeenCalled()
    })

    it('treats a yes as a normal question when nothing is waiting, and never acts in read-only mode', async () => {
        await realtimeClientTools.askSessionStatus({ question: '确认' })
        expect(api.askVoiceSessionStatus).toHaveBeenCalledTimes(1)
        expect(api.sendMessage).not.toHaveBeenCalled()
    })

    it('sends on the spoken yes itself, and the model confirm right after does not send again', async () => {
        writeVoiceToolMode('assistant')
        await realtimeClientTools.prepareInstruction({ instruction: '跟做视频那个说渲染先等等' })
        await onVoiceUserTranscript('对，确认发送。')
        expect(api.sendMessage).toHaveBeenCalledTimes(1)
        expect(await realtimeClientTools.confirmInstruction({ decision: 'send' })).toContain('already sent to "视频渲染"')
        expect(api.sendMessage).toHaveBeenCalledTimes(1)
    })

    it('sends exactly once when the spoken yes and the tool call race', async () => {
        writeVoiceToolMode('assistant')
        await realtimeClientTools.prepareInstruction({ instruction: '跟做视频那个说渲染先等等' })
        let release: () => void = () => {}
        api.sendMessage.mockImplementationOnce(() => new Promise<undefined>((resolve) => { release = () => resolve(undefined) }))
        const spoken = onVoiceUserTranscript('确认')
        const tool = realtimeClientTools.confirmInstruction({ decision: 'send' })
        release()
        await spoken
        expect(await tool).toContain('sent to "视频渲染"')
        expect(api.sendMessage).toHaveBeenCalledTimes(1)
    })

    it('puts the draft back when sending fails so it can be retried', async () => {
        writeVoiceToolMode('assistant')
        await realtimeClientTools.prepareInstruction({ instruction: '跟做视频那个说渲染先等等' })
        api.sendMessage.mockRejectedValueOnce(new Error('HTTP 503'))
        expect(await realtimeClientTools.confirmInstruction({ decision: 'send' })).toContain('sending failed')
        expect(getVoiceInstructionDraft()?.target.id).toBe('target-1')
    })

    it('drafts an instruction the model answered by itself, once, and asks it to read the draft back', async () => {
        writeVoiceToolMode('assistant')
        await onVoiceUserTranscript('让他回复收到两个字，别做别的。')
        const note = await onVoiceResponseWithoutTool()
        expect(note).toContain('Read this back to the user exactly')
        expect(api.prepareVoiceInstruction).toHaveBeenCalledWith(expect.objectContaining({ utterance: '让他回复收到两个字，别做别的。' }))
        expect(await onVoiceResponseWithoutTool()).toBeNull()
        expect(getVoiceInstructionDraft()).not.toBeNull()
    })

    it('leaves questions and tool-handled utterances alone', async () => {
        writeVoiceToolMode('assistant')
        await onVoiceUserTranscript('现在做到哪了？')
        expect(await onVoiceResponseWithoutTool()).toBeNull()
        await onVoiceUserTranscript('让它跑一下测试')
        noteVoiceToolCall()
        expect(await onVoiceResponseWithoutTool()).toBeNull()
        expect(api.prepareVoiceInstruction).not.toHaveBeenCalled()
    })

    it('never drafts or sends from transcripts in read-only mode', async () => {
        await onVoiceUserTranscript('让他回复收到')
        expect(await onVoiceResponseWithoutTool()).toBeNull()
        expect(api.prepareVoiceInstruction).not.toHaveBeenCalled()
        expect(api.sendMessage).not.toHaveBeenCalled()
    })

    it('leaves the text unchanged when the spoken original equals the instruction', () => {
        expect(composeVoiceInstructionText({ instruction: '跑测试', original: '跑测试' })).toBe('跑测试')
    })

    it('classifies spoken commands to switch between read-only and work/assistant mode', () => {
        expect(classifyVoiceModeSwitch('批准操作')).toEqual({ mode: 'assistant', isApprovePhrase: true })
        expect(classifyVoiceModeSwitch('Luna，切换到工作模式吧')).toEqual({ mode: 'assistant' })
        expect(classifyVoiceModeSwitch('允许发送消息')).toEqual({ mode: 'assistant' })
        expect(classifyVoiceModeSwitch('退出只读模式')).toEqual({ mode: 'assistant' })
        expect(classifyVoiceModeSwitch('切换回只读模式')).toEqual({ mode: 'readonly' })
        expect(classifyVoiceModeSwitch('退出工作模式')).toEqual({ mode: 'readonly' })
        expect(classifyVoiceModeSwitch('只读模式')).toEqual({ mode: 'readonly' })
        expect(classifyVoiceModeSwitch('批准操作，让它把测试跑一下')).toEqual({
            mode: 'assistant',
            isApprovePhrase: true,
            trailingText: '让它把测试跑一下'
        })
    })

    it('switches from read-only to assistant mode via voice command and back to read-only mode', async () => {
        expect(readVoiceToolMode()).toBe('readonly')

        await onVoiceUserTranscript('批准操作')
        expect(readVoiceToolMode()).toBe('assistant')

        const switchReply = await realtimeClientTools.setVoiceToolMode({ mode: 'assistant' })
        expect(switchReply).toContain('switched to assistant/work mode')
        expect(readVoiceToolMode()).toBe('assistant')

        const draftReply = await realtimeClientTools.prepareInstruction({ instruction: '跟做视频那个说渲染先等等' })
        expect(draftReply).toContain('Draft ready')
        expect(getVoiceInstructionDraft()).not.toBeNull()

        const backReply = await realtimeClientTools.setVoiceToolMode({ mode: 'readonly' })
        expect(backReply).toContain('switched to read-only mode')
        expect(readVoiceToolMode()).toBe('readonly')
        expect(getVoiceInstructionDraft()).toBeNull()
    })

    it('switches to assistant mode and drafts trailing instruction in one compound spoken command', async () => {
        expect(readVoiceToolMode()).toBe('readonly')

        const reply = await realtimeClientTools.askSessionStatus({ question: '批准操作，跟做视频那个说渲染先等等' })
        expect(readVoiceToolMode()).toBe('assistant')
        expect(reply).toContain('Draft ready')
        expect(getVoiceInstructionDraft()?.target.id).toBe('target-1')
    })
})
