import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { VOICE_BACKEND_LABELS } from '@hapi/protocol/voicePickerCatalog'
import { getLanguageDisplayName } from '@/lib/languages'
import { useTranslation } from '@/lib/use-translation'
import { VoiceRespondsControls } from '@/components/settings/VoiceAdvancedControls'
import { SettingsChoiceGroup, SettingsLinkRow, SettingsPageContent, SettingsSection } from '@/components/settings/SettingsPrimitives'
import { SelectControl } from '@/components/ui/select-control'
import { useVoiceSettings } from './useVoiceSettings'
import { useVoiceToolMode } from '@/fork-features/voice-assistant/toolMode'
import { VOXCPM_VOICE_OPTIONS, useVoiceReader, useVoiceTtsCharacter } from '@/fork-features/voice-assistant/readerPreference'
import { useVoiceListenMode, type VoiceListenPreference } from '@/fork-features/voice-assistant/listenMode'
import { VoiceprintSettings } from '@/fork-features/voice-assistant/VoiceprintSettings'

export default function SettingsVoicePage() {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const voice = useVoiceSettings()
    const [opening, setOpening] = useState<'greet' | 'brief'>(() => localStorage.getItem('hapi-voice-proactive') === 'true' ? 'brief' : 'greet')
    const [toolMode, setToolMode] = useVoiceToolMode()
    const [reader, setReader] = useVoiceReader()
    const [ttsCharacter, setTtsCharacter] = useVoiceTtsCharacter()
    const [listenMode, setListenMode] = useVoiceListenMode()
    const listenOptions: VoiceListenPreference[] = ['auto', 'verified', 'manual']
    const selectedLanguage = voice.voiceLanguages.find((language) => language.code === voice.voiceLanguage)
    const selectedVoice = voice.voices.find((option) => option.id === voice.voiceId)
    const selectedCharacter = VOXCPM_VOICE_OPTIONS.find((option) => option.id === ttsCharacter) ?? VOXCPM_VOICE_OPTIONS[0]

    const setVoiceOpening = (value: 'greet' | 'brief') => {
        setOpening(value)
        if (value === 'brief') localStorage.setItem('hapi-voice-proactive', 'true')
        else localStorage.removeItem('hapi-voice-proactive')
    }

    return (
        <SettingsPageContent description={t('settings.voice.description')}>
            <SettingsSection title={t('settings.voice.inputMode.title')} description={t('settings.voice.inputMode.hint')}>
                <SettingsChoiceGroup
                    hideLabel
                    label={t('settings.voice.inputMode.title')}
                    value={voice.voiceMode}
                    options={[
                        { value: 'assistant', label: t('settings.voice.inputMode.assistant'), description: t('settings.voice.inputMode.assistant.hint') },
                        { value: 'dictation', label: t('settings.voice.inputMode.dictation'), description: t('settings.voice.inputMode.dictation.hint') }
                    ]}
                    onChange={voice.setVoiceMode}
                />
            </SettingsSection>

            <SettingsSection title={t('settings.voice.connection.title')} description={t('settings.voice.group.hint')}>
                {voice.voiceMode === 'assistant' && voice.configuredBackends.length > 1 && voice.backend ? (
                    <SettingsChoiceGroup
                        label={t('settings.voice.backend')}
                        value={voice.backend}
                        options={voice.configuredBackends.map((backend) => ({ value: backend, label: VOICE_BACKEND_LABELS[backend] }))}
                        onChange={voice.setBackend}
                    />
                ) : null}
                {voice.voiceMode === 'dictation' && voice.provider ? (
                    <SettingsChoiceGroup
                        label={t('settings.voice.transcriptionProvider')}
                        value={voice.provider}
                        options={voice.providers.map((provider) => ({ value: provider.id, label: provider.label }))}
                        onChange={voice.setProvider}
                    />
                ) : null}
                {voice.voiceMode === 'dictation' && voice.providers.length === 0 ? (
                    <div className="px-3 py-3 text-sm text-[var(--app-hint)]">
                        {t('settings.voice.noTranscriptionProvider')}
                    </div>
                ) : null}
                {voice.voiceMode === 'dictation' && voice.provider && voice.modes.length > 1 ? (
                    <SettingsChoiceGroup
                        label={t('settings.voice.transcriptionMode')}
                        value={voice.transcriptionMode}
                        options={voice.modes.map((mode) => ({
                            value: mode,
                            label: t(`settings.voice.transcriptionMode.${mode}`),
                            description: t(`settings.voice.transcriptionMode.${mode}.hint`)
                        }))}
                        onChange={voice.setTranscriptionMode}
                    />
                ) : null}
                <label className="flex min-h-12 items-center justify-between gap-3 px-3 py-3">
                    <span className="text-sm font-medium text-[var(--app-fg)]">{t('settings.voice.language')}</span>
                    <SelectControl
                        value={voice.voiceLanguage ?? ''}
                        onChange={(event) => {
                            const language = voice.voiceLanguages.find((option) => (option.code ?? '') === event.target.value)
                            if (language) voice.setVoiceLanguage(language)
                        }}
                        containerClassName="w-full max-w-[55%]"
                        className="rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] py-1.5 pl-2 text-sm text-[var(--app-fg)]"
                    >
                        {voice.voiceLanguages.map((language) => <option key={language.code ?? 'auto'} value={language.code ?? ''}>{language.code === null ? t('settings.voice.autoDetect') : getLanguageDisplayName(language)}</option>)}
                    </SelectControl>
                </label>
                {voice.voiceMode === 'assistant' ? (
                    <SettingsLinkRow
                        label={t('settings.voice.voice')}
                        value={selectedVoice?.name ?? t('settings.voice.voiceDefault')}
                        description={selectedLanguage?.code ? getLanguageDisplayName(selectedLanguage) : t('settings.voice.autoDetect')}
                        onClick={() => navigate({ to: '/settings/voice/voices' })}
                    />
                ) : null}
            </SettingsSection>

            {voice.voiceMode === 'assistant' ? (
                <>
                    <SettingsSection title={t('settings.voice.behaves.title')}>
                        <SettingsChoiceGroup
                            label={t('settings.voice.toolMode.label')}
                            value={toolMode}
                            options={(['readonly', 'assistant'] as const).map((value) => ({ value, label: t(`settings.voice.toolMode.${value}`), description: t(`settings.voice.toolMode.${value}.hint`) }))}
                            onChange={setToolMode}
                        />
                        {voice.backend === 'qwen-realtime' ? (
                            <SettingsChoiceGroup
                                label={t('settings.voice.listen.label')}
                                value={listenMode}
                                options={listenOptions.map((value) => ({ value, label: t(`settings.voice.listen.${value}`), description: t(`settings.voice.listen.${value}.hint`) }))}
                                onChange={setListenMode}
                            />
                        ) : null}
                        {voice.backend === 'qwen-realtime' ? (
                            <>
                                <SettingsChoiceGroup
                                    label={t('settings.voice.reader.label')}
                                    value={reader}
                                    options={(['manbo', 'builtin'] as const).map((value) => ({ value, label: t(`settings.voice.reader.${value}`), description: t(`settings.voice.reader.${value}.hint`) }))}
                                    onChange={setReader}
                                />
                                {reader === 'manbo' ? (
                                    <label className="flex min-h-12 items-center justify-between gap-3 px-3 py-3">
                                        <div className="min-w-0">
                                            <div className="text-sm font-medium text-[var(--app-fg)]">{t('settings.voice.reader.character')}</div>
                                            <div className="text-xs text-[var(--app-hint)]">{selectedCharacter?.subtitle ?? ''}</div>
                                        </div>
                                        <SelectControl
                                            aria-label={t('settings.voice.reader.character')}
                                            value={ttsCharacter}
                                            onChange={(event) => setTtsCharacter(event.target.value)}
                                            containerClassName="w-full max-w-[55%]"
                                            className="rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] py-1.5 pl-2 text-sm text-[var(--app-fg)]"
                                        >
                                            {VOXCPM_VOICE_OPTIONS.map((option) => (
                                                <option key={option.id} value={option.id}>
                                                    {`${option.name} — ${option.subtitle}`}
                                                </option>
                                            ))}
                                        </SelectControl>
                                    </label>
                                ) : null}
                            </>
                        ) : null}
                        <SettingsChoiceGroup
                            label={t('settings.voice.opening.label')}
                            value={opening}
                            options={(['greet', 'brief'] as const).map((value) => ({ value, label: t(`settings.voice.opening.${value}`), description: t(`settings.voice.opening.${value}.hint`) }))}
                            onChange={setVoiceOpening}
                        />
                        <VoiceRespondsControls t={t} voiceBackend={voice.backend} />
                    </SettingsSection>
                    {voice.backend === 'qwen-realtime' ? <VoiceprintSettings /> : null}
                    <SettingsSection>
                        <SettingsLinkRow label={t('settings.voice.advanced.title')} description={t('settings.voice.advanced.hint')} onClick={() => navigate({ to: '/settings/voice/advanced' })} />
                    </SettingsSection>
                </>
            ) : null}
        </SettingsPageContent>
    )
}
