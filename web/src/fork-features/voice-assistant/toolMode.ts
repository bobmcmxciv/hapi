import { useSyncExternalStore } from 'react'

/**
 * What the spoken assistant may do. `readonly` (default) only looks things up, so nothing a
 * question triggers can land in a session; `assistant` may draft and send instructions after a
 * spoken confirmation and answer permission requests. Sent to the hub as `?tools=` so the realtime
 * model only ever sees the matching tools.
 */
export type VoiceAssistantToolMode = 'readonly' | 'assistant'

const STORAGE_KEY = 'hapi-voice-tool-mode'
const CHANGE_EVENT = 'hapi-voice-tool-mode-change'

export function readVoiceToolMode(): VoiceAssistantToolMode {
    try {
        return localStorage.getItem(STORAGE_KEY) === 'assistant' ? 'assistant' : 'readonly'
    } catch {
        return 'readonly'
    }
}

export function writeVoiceToolMode(mode: VoiceAssistantToolMode): void {
    try {
        if (mode === 'assistant') localStorage.setItem(STORAGE_KEY, 'assistant')
        else localStorage.removeItem(STORAGE_KEY)
    } catch { /* storage unavailable: stays read-only */ }
    // `storage` events only reach other documents; tell this one too.
    window.dispatchEvent(new Event(CHANGE_EVENT))
}

function subscribe(onChange: () => void): () => void {
    window.addEventListener(CHANGE_EVENT, onChange)
    window.addEventListener('storage', onChange)
    return () => {
        window.removeEventListener(CHANGE_EVENT, onChange)
        window.removeEventListener('storage', onChange)
    }
}

export function useVoiceToolMode(): [VoiceAssistantToolMode, (mode: VoiceAssistantToolMode) => void] {
    const mode = useSyncExternalStore(subscribe, readVoiceToolMode, () => 'readonly' as const)
    return [mode, writeVoiceToolMode]
}
