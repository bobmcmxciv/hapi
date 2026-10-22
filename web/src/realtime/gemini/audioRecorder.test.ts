import { afterEach, describe, expect, it, vi } from 'vitest'
import { GeminiAudioRecorder } from './audioRecorder'

describe('GeminiAudioRecorder hardware microphone release on mute', () => {
    afterEach(() => {
        vi.restoreAllMocks()
        vi.unstubAllGlobals()
    })

    function setupWebAudioMocks() {
        const tracks: Array<{ stop: ReturnType<typeof vi.fn>; onended: (() => void) | null }> = []
        const getUserMedia = vi.fn(async () => {
            const track = {
                stop: vi.fn(),
                onended: null as (() => void) | null,
            }
            tracks.push(track)
            return {
                getTracks: () => [track],
            } as unknown as MediaStream
        })

        const sourceNodes: Array<{ connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }> = []
        const scriptProcessor = {
            onaudioprocess: null as ((event: AudioProcessingEvent) => void) | null,
            connect: vi.fn(),
            disconnect: vi.fn(),
        }

        class MockAudioContext {
            state: AudioContextState = 'running'
            sampleRate = 16000
            destination = {}
            audioWorklet = undefined
            resume = vi.fn(async () => {})
            close = vi.fn(async () => {})
            createMediaStreamSource = vi.fn(() => {
                const node = {
                    connect: vi.fn(),
                    disconnect: vi.fn(),
                }
                sourceNodes.push(node)
                return node as unknown as MediaStreamAudioSourceNode
            })
            createScriptProcessor = vi.fn(() => scriptProcessor as unknown as ScriptProcessorNode)
        }

        vi.stubGlobal('AudioContext', MockAudioContext)
        Object.defineProperty(navigator, 'mediaDevices', {
            configurable: true,
            value: { getUserMedia },
        })

        return { tracks, getUserMedia, sourceNodes, scriptProcessor }
    }

    it('stops MediaStream tracks on setMuted(true) and re-acquires microphone on setMuted(false)', async () => {
        const { tracks, getUserMedia, sourceNodes } = setupWebAudioMocks()
        const recorder = new GeminiAudioRecorder()

        await recorder.start(
            () => {},
            () => {}
        )

        expect(getUserMedia).toHaveBeenCalledTimes(1)
        expect(tracks).toHaveLength(1)
        expect(tracks[0].stop).not.toHaveBeenCalled()

        recorder.setMuted(true)
        expect(tracks[0].stop).toHaveBeenCalledTimes(1)
        expect(sourceNodes[0].disconnect).toHaveBeenCalledTimes(1)

        recorder.setMuted(false)
        await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(2))
        expect(tracks).toHaveLength(2)
        expect(sourceNodes[1].connect).toHaveBeenCalledTimes(1)

        await recorder.stop()
        expect(tracks[1].stop).toHaveBeenCalledTimes(1)
    })

    it('defers getUserMedia when started while already muted until unmuted', async () => {
        const { tracks, getUserMedia } = setupWebAudioMocks()
        const recorder = new GeminiAudioRecorder()

        recorder.setMuted(true)
        await recorder.start(
            () => {},
            () => {}
        )

        expect(getUserMedia).not.toHaveBeenCalled()

        recorder.setMuted(false)
        await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1))
        expect(tracks).toHaveLength(1)

        await recorder.stop()
    })
})
