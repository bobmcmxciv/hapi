import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { I18nProvider } from '@/lib/i18n-context'
import { ApiError } from '@/api/client'
import type { VoiceSpeakerStatus } from './types'

const api = {
    getVoiceSpeakerStatus: vi.fn<() => Promise<VoiceSpeakerStatus>>(),
    enrollVoiceSpeaker: vi.fn<(pcm: Uint8Array) => Promise<unknown>>(),
    clearVoiceSpeaker: vi.fn<() => Promise<void>>()
}
vi.mock('@/lib/app-context', () => ({ useAppContext: () => ({ api, baseUrl: '', token: 't', user: { id: 1 } }) }))

const recorder = { started: 0, stopped: 0, onChunk: null as ((base64: string) => void) | null }
vi.mock('@/realtime/gemini/audioRecorder', () => ({
    GeminiAudioRecorder: class {
        async start(onChunk: (base64: string) => void) {
            recorder.started += 1
            recorder.onChunk = onChunk
        }
        stop() { recorder.stopped += 1 }
    }
}))

import { VoiceprintSettings } from './VoiceprintSettings'

function status(overrides: Partial<VoiceSpeakerStatus> = {}): VoiceSpeakerStatus {
    return { available: true, gate: { mode: 'observe', threshold: 0.4 }, enrolled: true, own: false, source: 'recording-helper owner voiceprint', samples: 2, updatedAt: null, recent: [], ...overrides }
}

function renderSettings() {
    return render(<I18nProvider><VoiceprintSettings /></I18nProvider>)
}

beforeEach(() => {
    localStorage.setItem('hapi-lang', 'en')
    recorder.started = 0
    recorder.stopped = 0
    recorder.onChunk = null
    api.getVoiceSpeakerStatus.mockReset()
    api.enrollVoiceSpeaker.mockReset()
    api.clearVoiceSpeaker.mockReset()
})

afterEach(() => {
    cleanup()
    vi.useRealTimers()
})

describe('VoiceprintSettings', () => {
    it('shows the imported voiceprint, the trial state and the recent verdicts', async () => {
        api.getVoiceSpeakerStatus.mockResolvedValue(status({
            recent: [
                { at: 1_000, seconds: 2.1, score: 0.62, decision: 'accept', reason: 'voiceprint match', enforced: false },
                { at: 2_000, seconds: 1.5, score: 0.12, decision: 'reject', reason: 'voiceprint mismatch', enforced: false }
            ]
        }))
        renderSettings()
        const list = await screen.findByTestId('voiceprint-recent')
        expect(list.textContent).toContain('0.62')
        expect(list.textContent).toContain('0.12')
        expect(list.querySelectorAll('li')).toHaveLength(2)
        expect(list.querySelector('li')?.textContent).toContain('0.12')
        expect(screen.getByTestId('voiceprint-enroll')).toBeInTheDocument()
    })

    it('records the reading and sends it for enrollment', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true })
        api.getVoiceSpeakerStatus.mockResolvedValue(status())
        api.enrollVoiceSpeaker.mockResolvedValue({ ok: true, voicedSeconds: 11.4, windows: 5, consistency: 0.71, previousScore: 0.48, samples: 1 })
        renderSettings()
        fireEvent.click(await screen.findByTestId('voiceprint-enroll'))
        await waitFor(() => expect(recorder.started).toBe(1))
        expect(screen.getByTestId('voiceprint-passage')).toBeInTheDocument()
        act(() => {
            recorder.onChunk?.(btoa('\u0001\u0002\u0003\u0004'))
            recorder.onChunk?.(btoa('\u0005\u0006'))
        })
        expect(screen.getByTestId('voiceprint-finish')).toBeDisabled()
        await act(async () => { vi.advanceTimersByTime(6_500) })
        expect(screen.getByTestId('voiceprint-finish')).toBeEnabled()
        fireEvent.click(screen.getByTestId('voiceprint-finish'))
        await waitFor(() => expect(api.enrollVoiceSpeaker).toHaveBeenCalledTimes(1))
        expect(Array.from(api.enrollVoiceSpeaker.mock.calls[0]![0])).toEqual([1, 2, 3, 4, 5, 6])
        expect(recorder.stopped).toBe(1)
        const message = await screen.findByTestId('voiceprint-message')
        expect(message.textContent).toContain('11.4')
        expect(message.textContent).toContain('0.71')
        expect(message.textContent).toContain('0.48')
        expect(api.getVoiceSpeakerStatus).toHaveBeenCalledTimes(2)
    })

    it('explains why the hub refused a recording', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true })
        api.getVoiceSpeakerStatus.mockResolvedValue(status())
        api.enrollVoiceSpeaker.mockRejectedValue(new ApiError('HTTP 422', 422, 'inconsistent'))
        renderSettings()
        fireEvent.click(await screen.findByTestId('voiceprint-enroll'))
        await waitFor(() => expect(recorder.started).toBe(1))
        await act(async () => { vi.advanceTimersByTime(7_000) })
        fireEvent.click(screen.getByTestId('voiceprint-finish'))
        const message = await screen.findByTestId('voiceprint-message')
        expect(message.textContent).toMatch(/several voices/)
    })

    it('stops by itself after the longest reading', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true })
        api.getVoiceSpeakerStatus.mockResolvedValue(status())
        api.enrollVoiceSpeaker.mockResolvedValue({ ok: true, voicedSeconds: 20, windows: 9, consistency: 0.8, previousScore: null, samples: 1 })
        renderSettings()
        fireEvent.click(await screen.findByTestId('voiceprint-enroll'))
        await waitFor(() => expect(recorder.started).toBe(1))
        await act(async () => { vi.advanceTimersByTime(26_000) })
        await waitFor(() => expect(api.enrollVoiceSpeaker).toHaveBeenCalledTimes(1))
    })

    it('offers to clear a voiceprint enrolled in hapi', async () => {
        api.getVoiceSpeakerStatus.mockResolvedValueOnce(status({ own: true, source: 'hapi web enrollment', samples: 1, updatedAt: '2026-10-13T10:00:00Z' }))
        api.getVoiceSpeakerStatus.mockResolvedValueOnce(status())
        api.clearVoiceSpeaker.mockResolvedValue()
        renderSettings()
        const clear = await screen.findByRole('button', { name: /Clear my enrolled voiceprint/ })
        fireEvent.click(clear)
        await waitFor(() => expect(api.clearVoiceSpeaker).toHaveBeenCalledTimes(1))
        await waitFor(() => expect(screen.queryByRole('button', { name: /Clear my enrolled voiceprint/ })).toBeNull())
    })

    it('renders nothing until the status is known', () => {
        api.getVoiceSpeakerStatus.mockReturnValue(new Promise(() => {}))
        const { container } = renderSettings()
        expect(container.textContent).toBe('')
    })
})
