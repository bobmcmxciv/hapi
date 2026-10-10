import type { SessionSummary } from '@/types/api'
import type { ApiClient } from '@/api/client'
import { useSessionActions } from '@/hooks/mutations/useSessionActions'
import { RenameSessionDialog } from '@/components/RenameSessionDialog'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { getSessionTitle } from '@/lib/sessionTitle'
import { useTranslation } from '@/lib/use-translation'
import { useWorkActions } from '../work-overview/workApi'
import { useWorkModel } from '../work-overview/useWorkModel'
import { AssignSelect, type AssignChoice } from '../work-overview/WorkParts'

export type TabSessionDialogKind = 'rename' | 'archive' | 'classify'

/**
 * fork(session-tabs): dialogs opened from a tab's menu. They outlive the menu,
 * so they are mounted by the tab bar, not inside the menu. Rename and archive
 * use the same actions and dialogs as the session list's long-press menu.
 */
export function TabSessionDialog(props: {
    api: ApiClient | null
    kind: TabSessionDialogKind
    session: SessionSummary
    onClose: () => void
}) {
    const { t } = useTranslation()
    const { session } = props
    const { archiveSession, renameSession, isPending } = useSessionActions(props.api, session.id, session.metadata?.flavor ?? null)
    const name = getSessionTitle(session) || t('tabs.untitled')

    if (props.kind === 'rename') {
        return (
            <RenameSessionDialog
                isOpen={true}
                onClose={props.onClose}
                currentName={name}
                onRename={renameSession}
                isPending={isPending}
            />
        )
    }
    if (props.kind === 'archive') {
        return (
            <ConfirmDialog
                isOpen={true}
                onClose={props.onClose}
                title={t('dialog.archive.title')}
                description={t('dialog.archive.description', { name })}
                confirmLabel={t('dialog.archive.confirm')}
                confirmingLabel={t('dialog.archive.confirming')}
                onConfirm={archiveSession}
                isPending={isPending}
                destructive
                centerTitle
            />
        )
    }
    return <ClassifySessionDialog session={session} name={name} onClose={props.onClose} />
}

function ClassifySessionDialog(props: { session: SessionSummary; name: string; onClose: () => void }) {
    const { t } = useTranslation()
    const { result, isLoading, error } = useWorkModel()
    const { setSession } = useWorkActions()
    const current = result?.model.sublineOfSession.get(props.session.id) ?? null
    const choose = (choice: AssignChoice) => {
        const patch = choice.kind === 'line'
            ? { sessionId: props.session.id, state: 'line' as const, lineId: choice.lineId }
            : choice.kind === 'ignored'
                ? { sessionId: props.session.id, state: 'ignored' as const }
                : { sessionId: props.session.id, state: 'follow' as const }
        setSession.mutate(patch, { onSuccess: props.onClose })
    }
    return (
        <Dialog open onOpenChange={open => { if (!open) props.onClose() }}>
            <DialogContent className="max-w-md" aria-describedby={undefined}>
                <DialogHeader className="text-left">
                    <DialogTitle>{t('tabs.classify.title')}</DialogTitle>
                </DialogHeader>
                <div className="mt-2 flex flex-col gap-3 text-sm" data-testid="tab-classify-dialog">
                    <div className="truncate text-[var(--app-hint)]">{props.name}</div>
                    {error ? <div className="text-xs text-[var(--app-badge-error-text)]">{error}</div> : null}
                    {isLoading || !result ? (
                        <div className="text-xs text-[var(--app-hint)]">{t('loading')}</div>
                    ) : (
                        <AssignSelect
                            mainlines={result.model.mainlines}
                            value={current}
                            allowUnassign
                            disabled={setSession.isPending}
                            onChoose={choose}
                            className="w-full"
                        />
                    )}
                    <p className="text-xs text-[var(--app-hint)]">{t('tabs.classify.hint')}</p>
                    {setSession.error ? <div className="text-xs text-[var(--app-badge-error-text)]">{setSession.error.message}</div> : null}
                </div>
            </DialogContent>
        </Dialog>
    )
}
