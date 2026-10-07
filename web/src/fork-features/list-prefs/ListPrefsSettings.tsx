import { SettingsChoiceGroup, SettingsSection, SettingsSwitch } from '@/components/settings/SettingsPrimitives'
import { useTranslation } from '@/lib/use-translation'
import { isToolbarButtonHidden, setMachineLayout, setToolbarButtonHidden, TOOLBAR_BUTTON_KEYS, useListPrefs } from './listPrefs'
import type { ToolbarButtonKey } from './listPrefs'

const LABEL_KEYS: Record<ToolbarButtonKey, string> = {
    calendar: 'settings.listPrefs.toolbar.calendar',
    archive: 'settings.listPrefs.toolbar.archive',
    unread: 'settings.listPrefs.toolbar.unread',
    work: 'settings.listPrefs.toolbar.work',
    browse: 'settings.listPrefs.toolbar.browse',
    usage: 'settings.listPrefs.toolbar.usage',
    new: 'settings.listPrefs.toolbar.new'
}

export function ListPrefsSettings() {
    const { t } = useTranslation()
    const prefs = useListPrefs()
    return (
        <SettingsSection title={t('settings.listPrefs.title')}>
            {TOOLBAR_BUTTON_KEYS.map(key => (
                <SettingsSwitch
                    key={key}
                    label={t(LABEL_KEYS[key])}
                    checked={!isToolbarButtonHidden(prefs, key)}
                    onChange={visible => setToolbarButtonHidden(key, !visible)}
                />
            ))}
            <SettingsChoiceGroup
                label={t('settings.listPrefs.machineLayout')}
                value={prefs.machineLayout}
                onChange={setMachineLayout}
                columns={2}
                options={[
                    { value: 'grid', label: t('settings.listPrefs.grid') },
                    { value: 'compact', label: t('settings.listPrefs.compact') },
                    { value: 'icons', label: t('settings.listPrefs.icons') }
                ]}
            />
        </SettingsSection>
    )
}
