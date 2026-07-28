import { useTranslation, type Locale } from '@/lib/use-translation'
import { useNotificationSound } from '@/hooks/useNotificationSound'
import { playNotificationChime } from '@/lib/notificationChime'
import { SettingsChoiceGroup, SettingsPageContent, SettingsSection, SettingsSwitch } from '@/components/settings/SettingsPrimitives'

const locales: ReadonlyArray<{ value: Locale; label: string }> = [
    { value: 'en', label: 'English' },
    { value: 'zh-CN', label: '简体中文' },
]

export default function SettingsGeneralPage() {
    const { t, locale, setLocale } = useTranslation()
    const { notificationSoundEnabled, setNotificationSoundEnabled } = useNotificationSound()
    return (
        <SettingsPageContent title={t('settings.general.title')} description={t('settings.general.description')}>
            <SettingsSection>
                <SettingsChoiceGroup label={t('settings.language.label')} value={locale} options={locales} onChange={setLocale} />
            </SettingsSection>
            <SettingsSection title={t('settings.notifications.title')}>
                <SettingsSwitch
                    label={t('settings.notifications.sound')}
                    description={t('settings.notifications.sound.description')}
                    checked={notificationSoundEnabled}
                    onChange={(checked) => {
                        setNotificationSoundEnabled(checked)
                        if (checked) {
                            // Instant feedback + unlocks the AudioContext
                            // inside this user gesture.
                            playNotificationChime()
                        }
                    }}
                />
            </SettingsSection>
        </SettingsPageContent>
    )
}
