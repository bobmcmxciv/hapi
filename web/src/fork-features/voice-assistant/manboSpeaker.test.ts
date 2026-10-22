import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import { ManboSpeaker } from './manboSpeaker'
import { writeVoiceTtsCharacter } from './readerPreference'

class FakeAudioContext {
    currentTime = 0
    destination = {}
    buffers: Array<{ frames: number; sampleRate: number }> = []
    started: number[] = []
    createBuffer(_channels: number, frames: number, sampleRate: number) {
        this.buffers.push({ frames, sampleRate })
        return { duration: frames / sampleRate, getChannelData: () => new Float32Array(frames) }
    }
    createBufferSource() {
        const source = {
            buffer: null as unknown,
            onended: null as null | (() => void),
            connect: vi.fn(),
            start: (at: number) => { this.started.push(at) },
            stop: vi.fn()
        }
        return source
    }
}

function pcmResponse(chunks: number[][], sampleRate = 32000): Response {
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            for (const chunk of chunks) controller.enqueue(new Uint8Array(chunk))
            controller.close()
        }
    })
    return new Response(stream, { headers: { 'x-sample-rate': String(sampleRate) } })
}

describe('ManboSpeaker', () => {
    const speak = vi.fn()
    const cancel = vi.fn()

    beforeEach(() => {
        speak.mockReset()
        cancel.mockReset()
        writeVoiceTtsCharacter('manbo')
        Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: { speak, cancel, speaking: false } })
        vi.stubGlobal('SpeechSynthesisUtterance', class { lang = ''; constructor(public text: string) {} })
    })

    afterEach(() => {
        writeVoiceTtsCharacter('manbo')
        vi.unstubAllGlobals()
    })

    it('speaks complete sentences in order as the text streams in', async () => {
        const open = vi.fn(async (_text: string, _signal?: AbortSignal) => pcmResponse([[1, 0, 2, 0], [3, 0]]))
        const context = new FakeAudioContext()
        const speaker = new ManboSpeaker({ openVoiceTtsStream: open } as unknown as ApiClient, context as unknown as AudioContext)

        speaker.push('第一句话。第二')
        await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1))
        expect(open.mock.calls[0]![0]).toBe('第一句话。')
        speaker.push('句话')
        speaker.flush()
        await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(2))
        expect(open.mock.calls[1]![0]).toBe('第二句话')
        await vi.waitFor(() => expect(context.buffers.length).toBe(4))
        expect(context.buffers[0]).toEqual({ frames: 2, sampleRate: 32000 })
        // Chunks are scheduled back to back, never overlapping.
        for (let i = 1; i < context.started.length; i += 1) expect(context.started[i]!).toBeGreaterThanOrEqual(context.started[i - 1]!)
    })

    it('forwards the selected VoxCPM voice character to openVoiceTtsStream', async () => {
        writeVoiceTtsCharacter('skadi2')
        const open = vi.fn(async (_text: string, _signal?: AbortSignal, _voice?: string | null) => pcmResponse([[1, 0]]))
        const context = new FakeAudioContext()
        const speaker = new ManboSpeaker({ openVoiceTtsStream: open } as unknown as ApiClient, context as unknown as AudioContext)

        speaker.push('听见海浪了吗。')
        await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1))
        expect(open.mock.calls[0]![0]).toBe('听见海浪了吗。')
        expect(open.mock.calls[0]![2]).toBe('skadi2')
    })

    it('keeps an odd trailing byte for the next chunk instead of dropping it', async () => {
        const open = vi.fn(async (_text: string, _signal?: AbortSignal) => pcmResponse([[1, 0, 2], [0, 3, 0]]))
        const context = new FakeAudioContext()
        const speaker = new ManboSpeaker({ openVoiceTtsStream: open } as unknown as ApiClient, context as unknown as AudioContext)
        speaker.push('好的。')
        await vi.waitFor(() => expect(context.buffers.map((b) => b.frames)).toEqual([1, 2]))
    })

    it('cuts a long clause at a comma so speech starts before the full stop', async () => {
        const open = vi.fn(async (_text: string, _signal?: AbortSignal) => pcmResponse([[0, 0]]))
        const speaker = new ManboSpeaker({ openVoiceTtsStream: open } as unknown as ApiClient, new FakeAudioContext() as unknown as AudioContext)
        speaker.push('这个会话今天一共改了五个文件，主要是语音设置页和后端的问答接口')
        await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1))
        expect(open.mock.calls[0]![0]).toBe('这个会话今天一共改了五个文件，')
    })

    it('barge-in stops speech, aborts the request and lets the next reply start fresh', async () => {
        let signal: AbortSignal | undefined
        const open = vi.fn((_text: string, s?: AbortSignal) => {
            signal = s
            return new Promise<Response>(() => {})
        })
        const speaker = new ManboSpeaker({ openVoiceTtsStream: open } as unknown as ApiClient, new FakeAudioContext() as unknown as AudioContext)
        speaker.push('第一句。第二句。')
        await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1))
        speaker.stop()
        expect(signal?.aborted).toBe(true)
        expect(cancel).toHaveBeenCalled()
        open.mockImplementation(async () => pcmResponse([[0, 0]]))
        speaker.push('新的回答。')
        await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(2))
        expect(open.mock.calls[1]![0]).toBe('新的回答。')
    })

    it('falls back to browser speech when the voice service fails, and stays there for the reply', async () => {
        const onFallback = vi.fn()
        const open = vi.fn(async (_text: string, _signal?: AbortSignal): Promise<Response> => { throw new Error('HTTP 502') })
        const speaker = new ManboSpeaker({ openVoiceTtsStream: open } as unknown as ApiClient, new FakeAudioContext() as unknown as AudioContext, onFallback)
        speaker.push('第一句。第二句。')
        await vi.waitFor(() => expect(speak).toHaveBeenCalledTimes(2))
        expect(open).toHaveBeenCalledTimes(1)
        expect(onFallback).toHaveBeenCalledWith('HTTP 502')
        expect((speak.mock.calls[0]![0] as { text: string; lang: string }).lang).toBe('zh-CN')
    })

    it('uses the status sample rate when a cross-origin response hides x-sample-rate', async () => {
        const hidden = () => {
            const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array([0, 0, 0, 0])); c.close() } })
            return new Response(stream)
        }
        const open = vi.fn(async (_text: string, _signal?: AbortSignal) => hidden())
        const context = new FakeAudioContext()
        const speaker = new ManboSpeaker({ openVoiceTtsStream: open } as unknown as ApiClient, context as unknown as AudioContext, undefined, 16000)
        speaker.push('好的。')
        await vi.waitFor(() => expect(context.buffers).toEqual([{ frames: 2, sampleRate: 16000 }]))
    })

    it('skips fragments with nothing to say', async () => {
        const open = vi.fn(async (_text: string, _signal?: AbortSignal) => pcmResponse([[0, 0]]))
        const speaker = new ManboSpeaker({ openVoiceTtsStream: open } as unknown as ApiClient, new FakeAudioContext() as unknown as AudioContext)
        speaker.push('。。\n')
        speaker.flush()
        await new Promise((resolve) => setTimeout(resolve, 20))
        expect(open).not.toHaveBeenCalled()
    })

    it('schedules initial chunk with 280ms jitter cushion and applies smooth cosine fade-in on discontinuity', async () => {
        const chunkBytes: number[] = []
        for (let i = 0; i < 64; i += 1) {
            chunkBytes.push(0x00, 0x40) // 16384 in s16le
        }
        const open = vi.fn(async (_text: string, _signal?: AbortSignal) => pcmResponse([chunkBytes, chunkBytes], 16000))
        const channels: Float32Array[] = []
        class JitterFakeAudioContext extends FakeAudioContext {
            override createBuffer(_channels: number, frames: number, sampleRate: number) {
                this.buffers.push({ frames, sampleRate })
                const data = new Float32Array(frames)
                channels.push(data)
                return { duration: frames / sampleRate, getChannelData: () => data }
            }
        }
        const context = new JitterFakeAudioContext()
        const speaker = new ManboSpeaker({ openVoiceTtsStream: open } as unknown as ApiClient, context as unknown as AudioContext)
        speaker.push('测试防破音缓冲。')
        await vi.waitFor(() => expect(context.started.length).toBe(2))
        expect(context.started[0]).toBeCloseTo(0.28, 3)
        expect(context.started[1]).toBeCloseTo(0.28 + 64 / 16000, 4)
        // First chunk starts from silence -> first sample is faded to 0, interior sample is untouched (0.5).
        expect(channels[0]![0]).toBeCloseTo(0, 5)
        expect(channels[0]![32]).toBeCloseTo(0.5, 5)
        // Second chunk is contiguous -> first sample is not faded (0.5).
        expect(channels[1]![0]).toBeCloseTo(0.5, 5)
    })
})
