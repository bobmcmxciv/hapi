import { settingsInputClass, type Grant } from './settingsApi'

export function grantScopeDraft(grant?: Pick<Grant, 'pathScopes' | 'pathPrefix'>): string | null {
    if (grant?.pathScopes !== undefined) return grant.pathScopes === null ? null : grant.pathScopes.join('\n')
    return grant?.pathPrefix ?? null
}

export function scopeFromDraft(draft: string | null): string[] | null {
    return draft === null ? null : draft.split(/\r?\n/).map(path => path.trim()).filter(Boolean)
}

export function MachineScopeField({ value, onChange, disabled = false }: {
    value: string | null
    onChange: (value: string | null) => void
    disabled?: boolean
}) {
    return <div className="space-y-2 text-sm">
        <label className="flex items-center gap-2"><input type="checkbox" checked={value === null} disabled={disabled} onChange={event => onChange(event.target.checked ? null : '')} />整机授权（不限制工作目录）</label>
        {value !== null && <label className="block">允许的目录（每行一个，含子目录）<textarea aria-label="允许的目录" className={settingsInputClass} rows={3} value={value} disabled={disabled} onChange={event => onChange(event.target.value)} placeholder={'C:\\Users\\Tadokoro\nC:\\Peter'} /></label>}
        <p className="text-xs text-[var(--app-hint)]">限制 HAPI 的工作目录与会话继承，不是 Windows 沙箱；Agent 和终端仍以主机账户执行。</p>
    </div>
}
