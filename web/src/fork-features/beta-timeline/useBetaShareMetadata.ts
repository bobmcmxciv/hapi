import { useMemo } from 'react'
import type { ApiClient } from '@/api/client'
import type { Session } from '@/types/api'
import { useSessionHeaderMetadata } from '@/hooks/useSessionHeaderMetadata'
import { useMachines } from '@/hooks/queries/useMachines'
import { useMachineLabels } from '@/hooks/useMachineLabels'
import { resolveSessionHeaderMachineLabel } from '@/components/SessionHeader'
import { getSessionModelLabel } from '@/lib/sessionModelLabel'
import { getShareTurnReasoningLabel, selectShareTurnMetadata } from '@/lib/shareTurnMetadata'
import { isFastServiceTier } from '@/components/AssistantChat/codexFastMode'
import { formatRelativeTime } from '@/lib/relativeTime'
import { formatSessionHeaderTimestamp } from '@/lib/sessionHeaderTimestamp'
import { useMinuteTick } from '@/hooks/useMinuteTick'
import { useTranslation } from '@/lib/use-translation'

/** Preserve the legacy share dialog's configured session-header metadata. */
export function useBetaShareMetadata(api: ApiClient, session: Session, serviceTier: string | null | undefined, open: boolean) {
    const { t, locale } = useTranslation()
    const { preferences } = useSessionHeaderMetadata()
    const { machines } = useMachines(api, true)
    const machineLabels = useMachineLabels(machines)
    const tick = useMinuteTick(preferences.lastActive && open)
    return useMemo(() => {
        const flavor = session.metadata?.flavor ?? null
        const machine = resolveSessionHeaderMachineLabel(session, machineLabels)
        const model = getSessionModelLabel(session)
        const reasoning = getShareTurnReasoningLabel(flavor, session.modelReasoningEffort, session.effort, preferences.showLabels)
        const activeAt = session.activeAt || session.updatedAt || session.createdAt
        const active = activeAt > 0 ? formatRelativeTime(activeAt, t) : null
        const created = formatSessionHeaderTimestamp(session.createdAt, locale)
        const updated = formatSessionHeaderTimestamp(session.updatedAt, locale)
        const branch = session.metadata?.worktree?.branch?.trim()
        return selectShareTurnMetadata(preferences, {
            agent: flavor?.trim() ? { text: flavor.trim(), flavor } : undefined,
            machine: machine ? { text: `${preferences.showLabels ? `${t('session.item.machine')}: ` : ''}${machine}` } : undefined,
            lastActive: active ? { text: active } : undefined,
            model: model ? { text: `${preferences.showLabels ? `${t(model.key)}: ` : ''}${model.value}` } : undefined,
            reasoning: reasoning ? { text: reasoning } : undefined,
            fastMode: flavor === 'codex' && isFastServiceTier(serviceTier ?? session.serviceTier) ? { text: 'fast' } : undefined,
            createdAt: created ? { text: `${preferences.showLabels ? `${t('session.header.createdAt')}: ` : ''}${created}` } : undefined,
            updatedAt: updated ? { text: `${preferences.showLabels ? `${t('session.header.updatedAt')}: ` : ''}${updated}` } : undefined,
            worktree: branch ? { text: `${preferences.showLabels ? `${t('session.item.worktree')}: ` : ''}${branch}` } : undefined
        })
    }, [preferences, session, serviceTier, machineLabels, t, locale, tick])
}
