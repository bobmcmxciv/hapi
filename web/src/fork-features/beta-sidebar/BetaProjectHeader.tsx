import { useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { CopyIcon } from '@/components/icons'
import { ProjectDigestDialog, StageBadge } from '@/fork-features/session-digest/DigestDialogs'
import { useTranslation } from '@/lib/use-translation'
import type { SidebarProject } from './projectAggregation'

export function BetaProjectHeader(props: {
    project: SidebarProject
    collapsed: boolean
    favorite: boolean
    alias?: string
    machineLabels: Record<string, string>
    onToggle: () => void
    onFavorite: () => void
    onAlias: (alias: string) => void
    onNewSession?: (origin: { machineId: string | null; directory: string }) => void
    onInteraction: (id: string, active: boolean) => void
}) {
    const { t } = useTranslation()
    const { project } = props
    const [action, setAction] = useState<'new' | 'details' | null>(null)
    const [digestKey, setDigestKey] = useState<string | null>(null)
    const [aliasDraft, setAliasDraft] = useState('')
    const [copyState, setCopyState] = useState<string | null>(null)
    const [copyError, setCopyError] = useState(false)
    const label = props.alias || project.displayName
    const sources = project.origins.map(origin => `${origin.machineId ? props.machineLabels[origin.machineId] || origin.machineId.slice(0, 8) : t('machine.unknown')}: ${origin.directory}`)
    const machines = new Set(project.origins.map(origin => origin.machineId))
    const machineLabel = machines.size === 1 ? sources[0]!.split(': ')[0] : t('beta.projects.machines', { n: machines.size })
    const interactionActive = action !== null || digestKey !== null
    useEffect(() => {
        props.onInteraction(`group:${project.key}`, interactionActive)
        return () => props.onInteraction(`group:${project.key}`, false)
    }, [project.key, interactionActive, props.onInteraction])
    const copy = async (path: string) => {
        setCopyError(false)
        try { await navigator.clipboard.writeText(path); setCopyState(path) } catch { setCopyError(true) }
    }
    const chooseAction = (next: 'new' | 'details') => {
        setCopyState(null)
        setCopyError(false)
        if (next === 'new' && project.origins.length === 1) {
            const { machineId, directory } = project.origins[0]!
            props.onNewSession?.({ machineId, directory })
        }
        else { setAliasDraft(props.alias ?? ''); setAction(next) }
    }
    return <>
        <div data-project-key={project.key} className="flex min-h-9 pointer-coarse:min-h-11 min-w-0 items-center rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)]">
            <button type="button" aria-label={t(props.favorite ? 'beta.projects.unfavorite' : 'beta.projects.favorite', { name: label })} aria-pressed={props.favorite} onClick={props.onFavorite} className="flex h-8 w-8 pointer-coarse:h-11 pointer-coarse:w-11 shrink-0 items-center justify-center rounded-lg text-lg text-[var(--app-hint)] focus-visible:ring-2 focus-visible:ring-[var(--app-link)]">
                <span aria-hidden="true" className={props.favorite ? 'text-amber-500' : ''}>{props.favorite ? '★' : '☆'}</span>
            </button>
            <button type="button" data-project-toggle={project.key} aria-expanded={!props.collapsed} title={sources.join('\n')} onClick={props.onToggle} className="flex min-h-9 pointer-coarse:min-h-11 min-w-0 flex-1 items-center gap-1.5 rounded-lg py-1 pointer-coarse:py-1.5 text-left focus-visible:ring-2 focus-visible:ring-[var(--app-link)]">
                <span aria-hidden="true" className="shrink-0 text-xs text-[var(--app-hint)]">{props.collapsed ? '▸' : '▾'}</span>
                <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate text-sm font-semibold">{label}</span>
                        {project.hasActiveSession ? <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--app-badge-success-text)]" /> : null}
                        {props.collapsed && project.digest && (project.digest.overview || project.digest.status) ? <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--app-hint)]" title={project.digest.overview || project.digest.status}>— {project.digest.overview || project.digest.status}</span> : null}
                    </span>
                    {!props.collapsed && project.digest && (project.digest.overview || project.digest.status) ? <span className="block truncate text-[11px] text-[var(--app-hint)]" title={project.digest.overview || project.digest.status}>{project.digest.overview || project.digest.status}</span> : null}
                    <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-[10px] text-[var(--app-hint)]">
                        {project.digest?.stage ? <StageBadge stage={project.digest.stage} className="max-w-full truncate" /> : null}
                        <span className="max-w-24 truncate" title={sources.join('\n')}>{machineLabel}</span>
                        <span className="shrink-0" aria-label={t('beta.projects.sessionCounts', { active: project.activeCount, total: project.sessions.length })}>{project.activeCount}/{project.sessions.length}</span>
                    </span>
                </span>
            </button>
            <button type="button" aria-label={t('beta.projects.details', { name: label })} title={t('digest.project.button')} onClick={() => chooseAction('details')} className="flex h-8 w-8 pointer-coarse:h-11 pointer-coarse:w-11 shrink-0 items-center justify-center rounded-lg text-[var(--app-hint)]"><span aria-hidden="true">⋯</span></button>
            {props.onNewSession && project.origins.some(origin => origin.directory !== 'Other') ? <button type="button" aria-label={t('sessions.group.new')} onClick={() => chooseAction('new')} className="flex h-8 w-8 pointer-coarse:h-11 pointer-coarse:w-11 shrink-0 items-center justify-center rounded-lg text-xl text-[var(--app-link)]">+</button> : null}
        </div>
        {action ? <Dialog open onOpenChange={open => { if (!open) setAction(null) }}><DialogContent className="max-h-[85dvh] overflow-y-auto"><DialogHeader><DialogTitle>{t(action === 'new' ? 'beta.projects.chooseNewOrigin' : 'beta.projects.projectDetails', { name: label })}</DialogTitle></DialogHeader>
            {action === 'details' ? <form onSubmit={event => { event.preventDefault(); props.onAlias(aliasDraft.trim()); setAction(null) }} className="flex min-w-0 flex-wrap gap-2">
                <label className="w-full text-sm" htmlFor={`alias-${project.key}`}>{t('beta.projects.alias')}</label>
                <input id={`alias-${project.key}`} value={aliasDraft} onChange={event => setAliasDraft(event.target.value)} placeholder={project.displayName} maxLength={120} className="min-h-11 min-w-0 flex-1 rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-2" />
                <button type="submit" className="min-h-11 rounded-lg px-3 text-[var(--app-link)]">{t('beta.projects.saveAlias')}</button>
            </form> : null}
            <div className="flex min-w-0 flex-col gap-3">{project.origins.map((origin, index) => <div key={origin.key} className="min-w-0 rounded-lg border border-[var(--app-border)] p-2">
                <div className="break-all text-xs" title={sources[index]}>{sources[index]} · {origin.sessions.length}</div>
                <div className="flex flex-wrap gap-2">
                    {props.onNewSession && origin.directory !== 'Other' ? <button type="button" onClick={() => { props.onNewSession?.({ machineId: origin.machineId, directory: origin.directory }); setAction(null) }} className="min-h-11 rounded-lg px-3 text-sm text-[var(--app-link)]">{t('sessions.group.new')}</button> : null}
                    {action !== 'new' ? <button type="button" onClick={() => void copy(origin.directory)} className="flex min-h-11 items-center gap-2 rounded-lg px-3 text-sm"><CopyIcon className="h-4 w-4" />{t(copyState === origin.directory ? 'beta.sidebar.copiedPath' : 'beta.projects.copyPath', { path: origin.directory })}</button> : null}
                    {action === 'details' ? <button type="button" onClick={() => { setDigestKey(origin.key); setAction(null) }} className="min-h-11 rounded-lg px-3 text-sm">{t('digest.project.button')}</button> : null}
                </div>
            </div>)}</div>
            {copyError ? <p role="alert" className="text-sm text-red-600">{t('beta.projects.copyFailed')}</p> : null}
        </DialogContent></Dialog> : null}
        {digestKey ? <ProjectDigestDialog projectKey={digestKey} title={label} onClose={() => setDigestKey(null)} /> : null}
    </>
}
