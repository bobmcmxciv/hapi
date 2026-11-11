import { useTranslation } from '@/lib/use-translation'

/**
 * Prefer session `selectedModelVariant` only when it is still among the rows
 * currently shown. After a multi-variant base switch, session state can lag
 * while `cursorDrillDownDefaultVariant` already points at the new base's
 * default — stale variants must not win highlight.
 */
export function resolveVisibleModelEffortSelectedValue(args: {
 options: ReadonlyArray<{ value: string }> | null | undefined
 selectedModelVariant?: string | null
 cursorDrillDownDefaultVariant?: string | null
 model?: string | null
}): string | null | undefined {
 const {
  options,
  selectedModelVariant,
  cursorDrillDownDefaultVariant,
  model
 } = args
 const selectedVisibleVariant = options?.some((option) => option.value === selectedModelVariant)
  ? selectedModelVariant
  : null
 return selectedVisibleVariant ?? cursorDrillDownDefaultVariant ?? model
}

export function ModelEffortSettingsSection(props: {
 agentFlavor?: string | null
 options: Array<{ value: string; label: string }>
 selectedValue: string | null | undefined
 controlsDisabled: boolean
 onChange: (value: string) => void
 /** Override the section title (e.g. Cursor base id during nested drill-down). */
 title?: string | null
 /** When set, show a back control above the title (Cursor nested variant drill-down). */
 onBack?: () => void
 backLabel?: string
}) {
 const { t } = useTranslation()
 const {
  agentFlavor,
  options,
  selectedValue,
  controlsDisabled,
  onChange,
  title,
  onBack,
  backLabel
 } = props

 const heading = title
  ?? (agentFlavor === 'cursor' ? t('misc.variant') : t('misc.effort'))

 return (
  <div className="py-2">
   {onBack ? (
    <button
     type="button"
     disabled={controlsDisabled}
     className={`flex w-full items-center px-3 pb-1 text-left text-xs text-[var(--app-hint)] transition-colors ${controlsDisabled
      ? 'cursor-not-allowed opacity-50'
      : 'cursor-pointer hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-link)]'
      }`}
     onClick={onBack}
     onMouseDown={(e) => e.preventDefault()}
     aria-label={backLabel ?? t('misc.backToModelList')}
    >
     {backLabel ?? t('misc.backToModelList')}
    </button>
   ) : null}
   <div className="px-3 pb-1 text-xs font-semibold text-[var(--app-hint)]">
    {heading}
   </div>
   {options.map((option) => {
    const isSelected = selectedValue === option.value
    return (
     <button
      key={option.value}
      type="button"
      disabled={controlsDisabled}
      className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${controlsDisabled
       ? 'cursor-not-allowed opacity-50'
       : 'cursor-pointer hover:bg-[var(--app-secondary-bg)]'
       }`}
      onClick={() => onChange(option.value)}
      onMouseDown={(e) => e.preventDefault()}
     >
      <div
       className={`flex h-4 w-4 items-center justify-center rounded-full border-2 ${isSelected
        ? 'border-[var(--app-link)]'
        : 'border-[var(--app-hint)]'
        }`}
      >
       {isSelected && (
        <div className="h-2 w-2 rounded-full bg-[var(--app-link)]" />
       )}
      </div>
      <span className={isSelected ? 'text-[var(--app-link)]' : ''}>
       {option.label}
      </span>
     </button>
    )
   })}
  </div>
 )
}
