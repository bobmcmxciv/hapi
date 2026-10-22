import { useSyncExternalStore } from 'react'

/**
 * Who speaks the assistant's replies. `manbo` (default) uses the hub's own VoxCPM voice service
 * (supporting Manbo + 11 Arknights operators) when it is reachable and falls back to the realtime
 * model's built-in voice when it is not; `builtin` always uses the realtime model's voice.
 */
export type VoiceReader = 'manbo' | 'builtin'

export type VoxcpmVoiceOption = {
    id: string
    name: string
    enName: string
    subtitle: string
}

export const DEFAULT_VOXCPM_VOICE_ID = 'manbo'

export const VOXCPM_VOICE_OPTIONS: readonly VoxcpmVoiceOption[] = [
    { id: 'manbo', name: '曼波', enName: 'Manbo', subtitle: '默认旁白声线' },
    { id: 'nian', name: '年', enName: 'Nian', subtitle: '明日方舟 · 重装（CV 杨鸥）' },
    { id: 'dusk', name: '夕', enName: 'Dusk', subtitle: '明日方舟 · 术师（CV 空无的念）' },
    { id: 'almond', name: '杏仁', enName: 'Almond', subtitle: '明日方舟 · 特种（CV 二娇）' },
    { id: 'skadi2', name: '浊心斯卡蒂', enName: 'Skadi the Corrupting Heart', subtitle: '明日方舟 · 辅助（CV 张琦）' },
    { id: 'aglina', name: '安洁莉娜', enName: 'Angelina', subtitle: '明日方舟 · 辅助（CV 何雨薇）' },
    { id: 'surtr', name: '史尔特尔', enName: 'Surtr', subtitle: '明日方舟 · 近卫（CV 云鹤追）' },
    { id: 'helage', name: '赫拉格', enName: 'Hellagur', subtitle: '明日方舟 · 近卫（CV 刘若班）' },
    { id: 'mizuki', name: '水月', enName: 'Mizuki', subtitle: '明日方舟 · 特种（CV 绿绮）' },
    { id: 'kalts', name: '凯尔希', enName: "Kal'tsit", subtitle: '明日方舟 · 医疗（CV 刘雪）' },
    { id: 'amiya', name: '阿米娅', enName: 'Amiya', subtitle: '明日方舟 · 术师（CV 陶典）' },
    { id: 'closur', name: '可露希尔', enName: 'Closure', subtitle: '明日方舟 · 辅助（CV 侯小菲）' },
]

const VALID_VOICE_IDS = new Set(VOXCPM_VOICE_OPTIONS.map((v) => v.id))

const STORAGE_KEY = 'hapi-voice-reader'
const CHANGE_EVENT = 'hapi-voice-reader-change'
const CHARACTER_STORAGE_KEY = 'hapi-voice-tts-character'
const CHARACTER_CHANGE_EVENT = 'hapi-voice-tts-character-change'

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

export function readVoiceTtsCharacter(): string {
    try {
        const raw = localStorage.getItem(CHARACTER_STORAGE_KEY)?.trim()
        return raw && VALID_VOICE_IDS.has(raw) ? raw : DEFAULT_VOXCPM_VOICE_ID
    } catch {
        return DEFAULT_VOXCPM_VOICE_ID
    }
}

export function writeVoiceTtsCharacter(voiceId: string): void {
    const normalized = VALID_VOICE_IDS.has(voiceId) ? voiceId : DEFAULT_VOXCPM_VOICE_ID
    try {
        if (normalized === DEFAULT_VOXCPM_VOICE_ID) localStorage.removeItem(CHARACTER_STORAGE_KEY)
        else localStorage.setItem(CHARACTER_STORAGE_KEY, normalized)
    } catch { /* storage unavailable */ }
    window.dispatchEvent(new Event(CHARACTER_CHANGE_EVENT))
}

function subscribe(onChange: () => void): () => void {
    window.addEventListener(CHANGE_EVENT, onChange)
    window.addEventListener('storage', onChange)
    return () => {
        window.removeEventListener(CHANGE_EVENT, onChange)
        window.removeEventListener('storage', onChange)
    }
}

function subscribeCharacter(onChange: () => void): () => void {
    window.addEventListener(CHARACTER_CHANGE_EVENT, onChange)
    window.addEventListener('storage', onChange)
    return () => {
        window.removeEventListener(CHARACTER_CHANGE_EVENT, onChange)
        window.removeEventListener('storage', onChange)
    }
}

export function useVoiceReader(): [VoiceReader, (reader: VoiceReader) => void] {
    const reader = useSyncExternalStore(subscribe, readVoiceReader, () => 'manbo' as const)
    return [reader, writeVoiceReader]
}

export function useVoiceTtsCharacter(): [string, (voiceId: string) => void] {
    const voiceId = useSyncExternalStore(subscribeCharacter, readVoiceTtsCharacter, () => DEFAULT_VOXCPM_VOICE_ID)
    return [voiceId, writeVoiceTtsCharacter]
}
