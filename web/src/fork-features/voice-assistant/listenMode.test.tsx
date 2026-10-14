import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { I18nProvider } from '@/lib/i18n-context'
import { readVoiceListenMode, writeVoiceListenMode } from './listenMode'

const talk = vi.fn<(active: boolean) => void>()
vi.mock('@/realtime/RealtimeSession', () => ({ setVoicePushToTalk: (active: boolean) => talk(active) }))

import { VoiceTalkButton } from './VoiceTalkButton'

beforeEach(() => {
    localStorage.clear()
    talk.mockReset()
})

afterEach(() => cleanup())

describe('voice listen mode preference', () => {
    it('defaults to hands-free and remembers the other modes', () => {
        expect(readVoiceListenMode()).toBe('auto')
        writeVoiceListenMode('verified')
        expect(readVoiceListenMode()).toBe('verified')
        writeVoiceListenMode('manual')
        expect(readVoiceListenMode()).toBe('manual')
        writeVoiceListenMode('auto')
        expect(localStorage.getItem('hapi-voice-listen-mode')).toBeNull()
    })

    it('ignores values it does not know', () => {
        localStorage.setItem('hapi-voice-listen-mode', 'always')
        expect(readVoiceListenMode()).toBe('auto')
    })
})

describe('VoiceTalkButton', () => {
    function renderButton() {
        render(<I18nProvider><VoiceTalkButton /></I18nProvider>)
        return screen.getByTestId('voice-talk-button')
    }

    it('opens the mic while held and sends the turn on release', () => {
        const button = renderButton()
        fireEvent.pointerDown(button, { pointerId: 1 })
        expect(talk.mock.calls).toEqual([[true]])
        fireEvent.pointerUp(button, { pointerId: 1 })
        expect(talk.mock.calls).toEqual([[true], [false]])
    })

    it('ends the turn when the finger slides off or the browser cancels it', () => {
        const button = renderButton()
        fireEvent.pointerDown(button, { pointerId: 1 })
        fireEvent.pointerLeave(button, { pointerId: 1 })
        fireEvent.pointerUp(button, { pointerId: 1 })
        expect(talk.mock.calls).toEqual([[true], [false]])
        fireEvent.pointerDown(button, { pointerId: 2 })
        fireEvent.pointerCancel(button, { pointerId: 2 })
        expect(talk.mock.calls).toEqual([[true], [false], [true], [false]])
    })

    it('does nothing on release without a press', () => {
        const button = renderButton()
        fireEvent.pointerUp(button, { pointerId: 1 })
        expect(talk).not.toHaveBeenCalled()
    })
})
