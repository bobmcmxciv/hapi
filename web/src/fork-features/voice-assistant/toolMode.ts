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
export const VOICE_TOOL_MODE_CHANGE_EVENT = CHANGE_EVENT

export interface VoiceModeSwitchIntent {
    mode: VoiceAssistantToolMode
    trailingText?: string
    isApprovePhrase?: boolean
}

const LEADING_ADDRESS_RE = /^(?:(?:luna|露娜|卢娜|语音助手|助手|小助手|hapi)[\s,，.。!！:：;；、-]*)+/i
const LEADING_POLITE_RE = /^(?:请|麻烦|帮我|请你|麻烦你|现在|先|立即|马上|直接)[\s,，]*/i
const TRAILING_FILLER_RE = /[\s,，.。!！?？;；:：、~～]*(?:吧|呀|啊|呢|哦|喔|哈|呗|好吗|好吧|行吗|可以吗|谢谢|thanks|thank\s+you|please)[\s,，.。!！?？;；:：、~～]*$/i
const TRAILING_PUNCT_RE = /[\s,，.。!！?？;；:：、~～]+$/

const TO_ASSISTANT_CLAUSE_RE = /^(?:(?:切换|切|进入|开启|打开|改|转|调|变成|设为|设置)(?:到|回|为|成)?(?:工作|助手|可操作|操作|可发送(?:消息)?|发送消息|发消息|读写|非只读)(?:模式|状态|权限)?|(?:退出|关闭|解除|取消|停用|离开|关掉)只读(?:模式|状态|限制)?|批准操作|允许操作|同意操作|授权操作|(?:开启|开放)操作(?:权限)?|(?:允许|可以|开启)(?:发送|发)(?:消息|指令)?(?:权限)?|(?:切换|切)(?:到|成)?可以(?:发送|发)(?:消息|指令)?|switch(?:\s+back)?\s+to\s+(?:work|working|assistant|action|write)\s+mode|(?:enter|enable|turn\s+on|activate)\s+(?:work|working|assistant|action|write)\s+mode|(?:exit|leave|disable|turn\s+off)\s+read[- ]?only(?:\s+mode)?|approve\s+operations?|allow\s+operations?|allow\s+sending(?:\s+messages?)?)$/i

const APPROVE_PHRASE_RE = /^(?:批准操作|允许操作|同意操作|授权操作|approve\s+operations?|allow\s+operations?)$/i

const TO_READONLY_CLAUSE_RE = /^(?:(?:切换|切|进入|开启|打开|改|转|调|回到|退回|恢复|变成|设为|设置)(?:到|回|为|成)?只读(?:模式|状态)?|只读模式|(?:退出|关闭|结束|停止|离开|取消|关掉)(?:工作|助手|可操作|操作|发送消息|发消息)(?:模式|状态|权限)?|(?:禁止|停止|不允许|不要再?)(?:发送消息|发消息|发送指令|操作)|switch(?:\s+back)?\s+to\s+read[- ]?only(?:\s+mode)?|(?:enter|enable|turn\s+on|return\s+to|back\s+to)\s+read[- ]?only(?:\s+mode)?|read[- ]?only\s+mode|(?:exit|leave|disable|turn\s+off|stop)\s+(?:work|working|assistant|action)\s+mode)$/i

function matchModeClause(rawClause: string): { mode: VoiceAssistantToolMode; isApprovePhrase?: boolean } | null {
    const cleaned = rawClause
        .trim()
        .replace(LEADING_ADDRESS_RE, '')
        .replace(LEADING_POLITE_RE, '')
        .replace(TRAILING_FILLER_RE, '')
        .replace(TRAILING_PUNCT_RE, '')
        .trim()
    if (!cleaned) return null
    if (TO_ASSISTANT_CLAUSE_RE.test(cleaned)) {
        return {
            mode: 'assistant',
            isApprovePhrase: APPROVE_PHRASE_RE.test(cleaned) || undefined
        }
    }
    if (TO_READONLY_CLAUSE_RE.test(cleaned)) {
        return { mode: 'readonly' }
    }
    return null
}

/**
 * Recognizes spoken voice commands that switch between `readonly` and `assistant` (work) mode,
 * including compound utterances where a mode switch is immediately followed by an instruction
 * (e.g. "批准操作，让它跑一下测试").
 */
export function classifyVoiceModeSwitch(text: string): VoiceModeSwitchIntent | null {
    const trimmed = text.trim()
    if (!trimmed) return null

    const whole = matchModeClause(trimmed)
    if (whole) return whole

    const withoutAddress = trimmed.replace(LEADING_ADDRESS_RE, '').trim()
    const splitMatch = withoutAddress.match(/^([^,，.。!！?？;；\n]+?)(?:[,，.。!！?？;；\n]+|\s+(?:然后|并且|并|再)\s*)(.+)$/s)
    if (!splitMatch) return null

    const firstClause = matchModeClause(splitMatch[1] ?? '')
    if (!firstClause) return null

    const remainder = (splitMatch[2] ?? '')
        .replace(/^[\s,，.。!！?？;；:：、~～]+/, '')
        .replace(/^(?:然后|并且|并|再)[\s,，]*/, '')
        .trim()

    if (!remainder || !remainder.replace(TRAILING_FILLER_RE, '').replace(TRAILING_PUNCT_RE, '').trim()) {
        return firstClause
    }

    return {
        ...firstClause,
        trailingText: remainder
    }
}

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
