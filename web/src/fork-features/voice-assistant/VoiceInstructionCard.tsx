import { useState } from 'react'
import type { ApiClient } from '@/api/client'
import { useTranslation } from '@/lib/use-translation'
import {
    sendVoiceInstructionDraft,
    setVoiceInstructionDraft,
    updateVoiceInstructionText,
    useVoiceInstructionDraft
} from './instructionDraft'
import type { VoiceDelivery } from './types'

/**
 * The instruction the voice assistant read back. Saying yes to the assistant sends it and the card
 * goes away; the card is the fallback for checking, editing, sending or dropping it by hand. While
 * the target is busy it shows whether the instruction interrupts the current turn or waits for it.
 */
export function VoiceInstructionCard(props: { api: ApiClient }) {
    const { t } = useTranslation()
    const draft = useVoiceInstructionDraft()
    const [state, setState] = useState<{ sending: boolean; error: string | null }>({ sending: false, error: null })

    if (!draft) return null

    const send = async (delivery?: VoiceDelivery) => {
        setState({ sending: true, error: null })
        try {
            await sendVoiceInstructionDraft(props.api, delivery)
            setState({ sending: false, error: null })
        } catch (error) {
            setState({ sending: false, error: error instanceof Error ? error.message : String(error) })
        }
    }
    const other: VoiceDelivery = draft.delivery === 'steer' ? 'queue' : 'steer'

    return (
        <div
            className="mx-auto mb-2 w-full max-w-content rounded-lg border border-[var(--app-border)] bg-[var(--app-subtle-bg)] p-3 text-sm"
            data-testid="voice-instruction-card"
        >
            <div className="mb-2 flex items-baseline justify-between gap-2">
                <span className="font-medium text-[var(--app-fg)]">{t('voice.instruction.title')}</span>
                <span className="truncate text-xs text-[var(--app-hint)]">
                    {t('voice.instruction.target', { title: draft.target.title })}
                    {draft.targetBusy ? ` · ${t(`voice.instruction.delivery.${draft.delivery}`)}` : ''}
                </span>
            </div>
            <textarea
                className="w-full resize-y rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] p-2 text-sm text-[var(--app-fg)]"
                rows={Math.min(6, Math.max(2, draft.instruction.split('\n').length))}
                value={draft.instruction}
                onChange={(event) => updateVoiceInstructionText(event.target.value)}
                disabled={state.sending}
                aria-label={t('voice.instruction.title')}
            />
            {draft.original.trim() && draft.original.trim() !== draft.instruction.trim() ? (
                <div className="mt-1 text-xs text-[var(--app-hint)]">
                    {t('voice.instruction.original', { text: draft.original })}
                </div>
            ) : null}
            {state.error ? (
                <div className="mt-1 text-xs text-red-600">{t('voice.instruction.failed', { error: state.error })}</div>
            ) : null}
            <div className="mt-2 flex flex-wrap justify-end gap-2">
                <button
                    type="button"
                    className="rounded-md px-3 py-1.5 text-[var(--app-hint)] hover:bg-[var(--app-bg)]"
                    onClick={() => setVoiceInstructionDraft(null)}
                    disabled={state.sending}
                >
                    {t('voice.instruction.cancel')}
                </button>
                {draft.targetBusy ? (
                    <button
                        type="button"
                        className="rounded-md border border-[var(--app-border)] px-3 py-1.5 text-[var(--app-fg)] hover:bg-[var(--app-bg)]"
                        onClick={() => { void send(other) }}
                        disabled={state.sending || !draft.instruction.trim()}
                    >
                        {t(`voice.instruction.sendAs.${other}`)}
                    </button>
                ) : null}
                <button
                    type="button"
                    className="rounded-md bg-[var(--app-button)] px-3 py-1.5 text-[var(--app-button-text)] disabled:opacity-50"
                    onClick={() => { void send() }}
                    disabled={state.sending || !draft.instruction.trim()}
                >
                    {state.sending ? t('voice.instruction.sending') : t('voice.instruction.send')}
                </button>
            </div>
        </div>
    )
}
