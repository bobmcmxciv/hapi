import { useSyncExternalStore } from 'react'

/**
 * How the voice assistant listens. `auto` (default) is hands-free with semantic turn detection;
 * `verified` is hands-free but the hub only lets turns spoken in the user's own voice through;
 * `manual` is push-to-talk — nothing is heard unless the talk button is held.
 */
export type VoiceListenPreference = 'auto' | 'verified' | 'manual'

const STORAGE_KEY = 'hapi-voice-listen-mode'
const CHANGE_EVENT = 'hapi-voice-listen-mode-change'

export function readVoiceListenMode(): VoiceListenPreference {
    try {
        const raw = localStorage.getItem(STORAGE_KEY)
        return raw === 'verified' || raw === 'manual' ? raw : 'auto'
    } catch {
        return 'auto'
    }
}

export function writeVoiceListenMode(mode: VoiceListenPreference): void {
    try {
        if (mode === 'auto') localStorage.removeItem(STORAGE_KEY)
        else localStorage.setItem(STORAGE_KEY, mode)
    } catch { /* storage unavailable: stays hands-free */ }
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

export function useVoiceListenMode(): [VoiceListenPreference, (mode: VoiceListenPreference) => void] {
    const mode = useSyncExternalStore(subscribe, readVoiceListenMode, () => 'auto' as const)
    return [mode, writeVoiceListenMode]
}
