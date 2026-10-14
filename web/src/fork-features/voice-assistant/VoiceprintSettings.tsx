import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError } from '@/api/client'
import { useAppContext } from '@/lib/app-context'
import { useTranslation } from '@/lib/use-translation'
import { SettingsRow, SettingsSection } from '@/components/settings/SettingsPrimitives'
import { GeminiAudioRecorder } from '@/realtime/gemini/audioRecorder'
import { base64ToArrayBuffer } from '@/realtime/gemini/pcmUtils'
import type { VoiceSpeakerRecord, VoiceSpeakerStatus } from './types'

/** Enough reading for several 3-second windows once pauses are dropped. */
export const ENROLL_MIN_SECONDS = 6
const ENROLL_MAX_SECONDS = 25
const RECENT_SHOWN = 8

type Phase = 'idle' | 'recording' | 'uploading'

const BUTTON = 'rounded-lg bg-[var(--app-button)] px-3 py-2 text-sm font-medium text-[var(--app-button-text)] disabled:opacity-50'

function joinChunks(chunks: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0))
    let offset = 0
    for (const chunk of chunks) {
        out.set(chunk, offset)
        offset += chunk.byteLength
    }
    return out
}

/**
 * “我的声纹”：录一段朗读交给 hub 算声纹（hub 只存向量，不存录音），并显示门的状态与最近几轮的判断，
 * 方便按真实分数调阈值。录音走与语音对话同一套麦克风处理（GeminiAudioRecorder，16 kHz），
 * 这样录入时和使用时的声音经过的是同一条链路。
 */
export function VoiceprintSettings() {
    const { api } = useAppContext()
    const { t } = useTranslation()
    const [status, setStatus] = useState<VoiceSpeakerStatus | null>(null)
    const [phase, setPhase] = useState<Phase>('idle')
    const [elapsed, setElapsed] = useState(0)
    const [message, setMessage] = useState<string | null>(null)
    const recorderRef = useRef<GeminiAudioRecorder | null>(null)
    const chunksRef = useRef<Uint8Array[]>([])
    const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
    const finishRef = useRef<() => void>(() => {})

    const refresh = useCallback(() => {
        api.getVoiceSpeakerStatus().then(setStatus).catch(() => setStatus(null))
    }, [api])

    useEffect(() => { refresh() }, [refresh])

    const stopRecorder = useCallback(() => {
        if (timerRef.current) clearInterval(timerRef.current)
        timerRef.current = null
        recorderRef.current?.stop()
        recorderRef.current = null
    }, [])

    useEffect(() => stopRecorder, [stopRecorder])

    const finish = useCallback(async () => {
        stopRecorder()
        const pcm = joinChunks(chunksRef.current)
        chunksRef.current = []
        setPhase('uploading')
        try {
            const result = await api.enrollVoiceSpeaker(pcm)
            const done = t('settings.voice.speaker.done', { seconds: String(result.voicedSeconds), consistency: result.consistency.toFixed(2) })
            setMessage(result.previousScore === null ? done : `${done}${t('settings.voice.speaker.donePrevious', { score: result.previousScore.toFixed(2) })}`)
        } catch (error) {
            const code = error instanceof ApiError ? error.code : undefined
            setMessage(code === 'too-little-speech' || code === 'inconsistent' || code === 'service-unavailable'
                ? t(`settings.voice.speaker.error.${code}`)
                : t('settings.voice.speaker.error.generic', { message: error instanceof Error ? error.message : String(error) }))
        } finally {
            setPhase('idle')
            refresh()
        }
    }, [api, refresh, stopRecorder, t])
    finishRef.current = () => { void finish() }

    const start = useCallback(async () => {
        setMessage(null)
        chunksRef.current = []
        setElapsed(0)
        const recorder = new GeminiAudioRecorder()
        recorderRef.current = recorder
        try {
            await recorder.start((base64) => { chunksRef.current.push(new Uint8Array(base64ToArrayBuffer(base64))) })
        } catch (error) {
            recorderRef.current = null
            setMessage(t('settings.voice.speaker.error.mic', { message: error instanceof Error ? error.message : String(error) }))
            return
        }
        setPhase('recording')
        const startedAt = Date.now()
        timerRef.current = setInterval(() => {
            const seconds = Math.floor((Date.now() - startedAt) / 1000)
            setElapsed(seconds)
            if (seconds >= ENROLL_MAX_SECONDS) finishRef.current()
        }, 250)
    }, [t])

    const clear = useCallback(async () => {
        setMessage(null)
        await api.clearVoiceSpeaker().catch(() => {})
        refresh()
    }, [api, refresh])

    if (!status) return null

    const gateText = !status.available || !status.gate
        ? t('settings.voice.speaker.unavailable')
        : t(`settings.voice.speaker.gate.${status.gate.mode}`, { threshold: status.gate.threshold.toFixed(2) })
    const enrolledText = !status.enrolled
        ? t('settings.voice.speaker.none')
        : status.own
            ? t('settings.voice.speaker.own', { count: String(status.samples), date: status.updatedAt ? new Date(status.updatedAt).toLocaleString() : '' })
            : t('settings.voice.speaker.imported')
    const verdictText = (record: VoiceSpeakerRecord) => record.decision === 'accept'
        ? t('settings.voice.speaker.verdict.accept')
        : record.enforced ? t('settings.voice.speaker.verdict.reject') : t('settings.voice.speaker.verdict.wouldReject')
    const recent = status.recent.slice(-RECENT_SHOWN).reverse()

    return (
        <SettingsSection title={t('settings.voice.speaker.title')} description={gateText}>
            <SettingsRow
                label={t('settings.voice.speaker.title')}
                description={enrolledText}
                trailing={status.available ? (
                    phase === 'recording' ? (
                        <button type="button" className={BUTTON} disabled={elapsed < ENROLL_MIN_SECONDS} onClick={() => { void finish() }} data-testid="voiceprint-finish">
                            {t('settings.voice.speaker.finish', { seconds: String(elapsed) })}
                        </button>
                    ) : (
                        <button type="button" className={BUTTON} disabled={phase === 'uploading'} onClick={() => { void start() }} data-testid="voiceprint-enroll">
                            {phase === 'uploading'
                                ? t('settings.voice.speaker.uploading')
                                : status.own ? t('settings.voice.speaker.reenroll') : t('settings.voice.speaker.enroll')}
                        </button>
                    )
                ) : undefined}
            >
                {phase === 'recording' ? (
                    <div className="mt-2 text-sm text-[var(--app-fg)]">
                        <div className="text-xs text-[var(--app-hint)]">{t('settings.voice.speaker.prompt')}</div>
                        <p className="mt-1 leading-relaxed" data-testid="voiceprint-passage">{t('settings.voice.speaker.passage')}</p>
                    </div>
                ) : null}
                {message ? <div className="mt-2 text-xs text-[var(--app-fg)]" data-testid="voiceprint-message">{message}</div> : null}
            </SettingsRow>
            {recent.length > 0 ? (
                <SettingsRow label={t('settings.voice.speaker.recent')}>
                    <ul className="mt-1 space-y-0.5 text-xs text-[var(--app-hint)]" data-testid="voiceprint-recent">
                        {recent.map((record) => (
                            <li key={record.at}>
                                {new Date(record.at).toLocaleTimeString()} · {t('settings.voice.speaker.seconds', { seconds: String(record.seconds) })} · {record.score === null ? '—' : record.score.toFixed(2)} · {verdictText(record)}
                            </li>
                        ))}
                    </ul>
                </SettingsRow>
            ) : null}
            {status.own ? (
                <SettingsRow
                    label={t('settings.voice.speaker.clear')}
                    trailing={<button type="button" className={BUTTON} disabled={phase !== 'idle'} onClick={() => { void clear() }}>{t('settings.voice.speaker.clear')}</button>}
                />
            ) : null}
        </SettingsSection>
    )
}
