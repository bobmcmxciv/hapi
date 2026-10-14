import { useState } from 'react'
import { useTranslation } from '@/lib/use-translation'
import { setVoicePushToTalk } from '@/realtime/RealtimeSession'

/**
 * Push-to-talk: hold to speak, release to send the turn. Pointer events cover mouse, touch and pen;
 * leaving the button or the browser cancelling the pointer also ends the turn, so a finger that
 * slides off never leaves the mic open.
 */
export function VoiceTalkButton() {
    const { t } = useTranslation()
    const [holding, setHolding] = useState(false)

    const start = (event: React.PointerEvent<HTMLButtonElement>) => {
        event.preventDefault()
        event.currentTarget.setPointerCapture?.(event.pointerId)
        setHolding(true)
        setVoicePushToTalk(true)
    }
    const stop = () => {
        if (!holding) return
        setHolding(false)
        setVoicePushToTalk(false)
    }

    return (
        <button
            type="button"
            aria-label={holding ? t('voice.talk.release') : t('voice.talk.hold')}
            title={holding ? t('voice.talk.release') : t('voice.talk.hold')}
            data-testid="voice-talk-button"
            className={`flex h-8 select-none items-center gap-1 rounded-full px-3 text-xs font-medium transition-colors ${
                holding ? 'bg-red-500 text-white' : 'bg-[var(--app-subtle-bg)] text-[var(--app-fg)] hover:bg-[var(--app-bg)]'
            }`}
            style={{ touchAction: 'none', WebkitUserSelect: 'none' }}
            onPointerDown={start}
            onPointerUp={stop}
            onPointerLeave={stop}
            onPointerCancel={stop}
            onContextMenu={(event) => event.preventDefault()}
        >
            {holding ? t('voice.talk.release') : t('voice.talk.hold')}
        </button>
    )
}
