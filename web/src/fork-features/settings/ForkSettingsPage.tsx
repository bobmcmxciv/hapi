import { useNavigate } from '@tanstack/react-router'
import { useAppContext } from '@/lib/app-context'
import { useTranslation } from '@/lib/use-translation'
import { SettingsLinkRow, SettingsPageContent, SettingsSection } from '@/components/settings/SettingsPrimitives'
import { HistoryImportSettingsRow } from '../history-import/HistoryImportSettingsRow'
import { OmpProviderSettingsRow } from '../omp-host-integration/OmpProviderSettingsRow'
import { DigestSettingsSection } from '../session-digest/DigestSettingsSection'
import { ListPrefsSettings } from '../list-prefs/ListPrefsSettings'

export default function ForkSettingsPage() {
    const navigate = useNavigate()
    const { user } = useAppContext()
    const { t } = useTranslation()

    return (
        <SettingsPageContent title={t('settings.fork.title')} description={t('settings.fork.description')}>
            <ListPrefsSettings />

            <SettingsSection>
                <HistoryImportSettingsRow />
                {user.role === 'admin' ? (
                    <SettingsLinkRow
                        label={t('settings.fork.grants.title')}
                        description={t('settings.fork.grants.description')}
                        onClick={() => navigate({ to: '/settings/fork/grants' })}
                    />
                ) : null}
                <OmpProviderSettingsRow />
            </SettingsSection>
            {user.role === 'admin' ? <DigestSettingsSection /> : null}
        </SettingsPageContent>
    )
}
