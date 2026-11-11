import { useEffect, useMemo, useRef } from 'react'
import type { ApiClient } from '@/api/client'
import type { ConversationStatus } from '@/realtime/types'
import { useVoiceInputPreferences } from '@/hooks/useVoiceInputPreferences'
import { useDictation } from '@/hooks/useDictation'

/** Exactly one microphone owner: switching mode closes the previous voice path. */
export function useComposerVoice(options: {
    api: ApiClient | null
    voiceStatus: ConversationStatus
    onVoiceToggle?: () => void
    getCurrentText: () => string
    setText: (text: string) => void
}) {
    const voiceInput = useVoiceInputPreferences(options.api)
    const config = useMemo(() => ({
        api: options.api,
        provider: voiceInput.provider,
        mode: voiceInput.transcriptionMode,
        getCurrentText: options.getCurrentText,
        onTextChange: options.setText,
    }), [options.api, voiceInput.provider, voiceInput.transcriptionMode, options.getCurrentText, options.setText])
    const dictation = useDictation(config)
    const dictationActive = voiceInput.voiceMode === 'dictation'
    const previousMode = useRef(voiceInput.voiceMode)
    useEffect(() => {
        if (previousMode.current === voiceInput.voiceMode) return
        previousMode.current = voiceInput.voiceMode
        if (dictationActive && (options.voiceStatus === 'connected' || options.voiceStatus === 'connecting')) {
            options.onVoiceToggle?.()
        } else if (!dictationActive && (dictation.status === 'connected' || dictation.status === 'connecting')) {
            void dictation.toggle()
        }
    }, [dictationActive, voiceInput.voiceMode, options.voiceStatus, options.onVoiceToggle, dictation.status, dictation.toggle])
    return {
        voiceInput,
        dictation,
        dictationActive,
        effectiveVoiceStatus: dictationActive ? dictation.status : options.voiceStatus,
        effectiveVoiceToggle: dictationActive
            ? (dictation.supported ? dictation.toggle : undefined)
            : options.onVoiceToggle,
    }
}
