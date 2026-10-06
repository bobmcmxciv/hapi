import type { MachineIconId } from '@hapi/protocol'
import { MachineOsIcon, machineChipIdleClass, machineChipSelectedClass } from '@/components/machinePresentation'
import { useTranslation } from '@/lib/use-translation'
import { cn } from '@/lib/utils'
import { MACHINE_ICON_PICKER_ORDER, MachineDeviceGlyph, machineIconLabelKey } from './MachineDeviceIcon'

const optionClass = 'flex min-w-0 flex-col items-center gap-1 rounded-lg border px-1 py-2 text-[11px] leading-tight transition-colors disabled:opacity-50'

/**
 * fork(machine-icons)：设备图标选择网格。第一格「自动」= 不设图标，按系统
 * （platform）显示；其余是 MACHINE_ICON_PICKER_ORDER 的设备外形。
 */
export function MachineIconPicker(props: {
    value: MachineIconId | null
    platform: string | null
    onChange: (icon: MachineIconId | null) => void
    disabled?: boolean
    className?: string
}) {
    const { t } = useTranslation()

    const option = (icon: MachineIconId | null) => {
        const selected = props.value === icon
        const label = icon ? t(machineIconLabelKey(icon)) : t('machineIcon.auto')
        return (
            <button
                key={icon ?? 'auto'}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={label}
                title={label}
                disabled={props.disabled}
                onClick={() => props.onChange(icon)}
                className={cn(optionClass, selected ? machineChipSelectedClass : machineChipIdleClass)}
            >
                {icon
                    ? <MachineDeviceGlyph icon={icon} className="h-6 w-6" />
                    : <MachineOsIcon platform={props.platform} className="h-6 w-6" />}
                <span className="w-full truncate text-center">{label}</span>
            </button>
        )
    }

    return (
        <div
            role="radiogroup"
            aria-label={t('machineIcon.label')}
            className={cn('grid grid-cols-4 gap-1.5', props.className)}
        >
            {option(null)}
            {MACHINE_ICON_PICKER_ORDER.map(option)}
        </div>
    )
}
