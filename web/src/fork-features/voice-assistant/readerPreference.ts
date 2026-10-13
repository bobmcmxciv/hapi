import { useSyncExternalStore } from 'react'

/**
 * Who speaks the assistant's replies. `manbo` (default) uses the hub's own voice service when it
 * is reachable and falls back to the realtime model's built-in voice when it is not; `builtin`
 * always uses the realtime model's voice.
 */
export type VoiceReader = 'manbo' | 'builtin'

const STORAGE_KEY = 'hapi-voice-reader'
const CHANGE_EVENT = 'hapi-voice-reader-change'

export function readVoiceReader(): VoiceReader {
    try {
        return localStorage.getItem(STORAGE_KEY) === 'builtin' ? 'builtin' : 'manbo'
    } catch {
        return 'manbo'
    }
}

export function writeVoiceReader(reader: VoiceReader): void {
    try {
        if (reader === 'builtin') localStorage.setItem(STORAGE_KEY, 'builtin')
        else localStorage.removeItem(STORAGE_KEY)
    } catch { /* storage unavailable */ }
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

export function useVoiceReader(): [VoiceReader, (reader: VoiceReader) => void] {
    const reader = useSyncExternalStore(subscribe, readVoiceReader, () => 'manbo' as const)
    return [reader, writeVoiceReader]
}
