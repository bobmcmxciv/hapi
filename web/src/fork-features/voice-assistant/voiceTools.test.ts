import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import { updateCurrentSessionId } from '@/realtime/RealtimeSession'
import {
    realtimeClientTools,
    registerSessionStore,
    registerVoiceAssistantApi,
    resetVoiceAssistantState
} from '@/realtime/realtimeClientTools'
import { composeVoiceInstructionText, getVoiceInstructionDraft } from './instructionDraft'
import { readVoiceToolMode, writeVoiceToolMode } from './toolMode'

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

    it('leaves the text unchanged when the spoken original equals the instruction', () => {
        expect(composeVoiceInstructionText({
            target: { id: 'x', title: 'x' }, instruction: '跑测试', original: '跑测试', readback: '跑测试', createdAt: 0
        })).toBe('跑测试')
    })
})
