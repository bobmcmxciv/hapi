import type { Attachment } from '@assistant-ui/react'
import type { MutableRefObject } from 'react'
import type { CopilotAgentMode, MessageDeliveryMode } from '@hapi/protocol'
import type { ApiClient } from '@/api/client'
import type { AgentState, CodexCollaborationMode, OmpThinkingState, PermissionMode, PiModelSummary, ThreadGoal } from '@/types/api'
import type { Suggestion } from '@/hooks/useActiveSuggestions'
import type { AttachmentDraftInput } from '@/lib/composer-attachment-drafts'
import type { ComposerSendIntent } from '@/lib/messageDelivery'
import type { ScratchlistParkResult } from '@/lib/scratchlistAttachmentFlow'
import type { ConversationStatus } from '@/realtime/types'
import type { SessionMentionResolveResult } from './RichComposerInput'
import type { PendingSchedule } from './ScheduleTimePicker'

export interface TextInputState {
    text: string
    selection: { start: number; end: number }
}

/** A session-owned failed attempt; editor recovery never overwrites a newer draft. */
export type ComposerSendError = {
    id: number
    text: string
    message: string
    scheduledAt: number | null
    mutationStarted: boolean
    deliveryMode?: MessageDeliveryMode
    restoreSuppressed: boolean
    action?: { label: string; onClick: () => void; pending?: boolean } | null
}

export type HappyComposerProps = {
    sessionId?: string
    onUploadDraftSnapshot?: (text: string, attachments: AttachmentDraftInput[]) => void
    canRestoreAttachments?: boolean
    disabled?: boolean
    permissionMode?: PermissionMode
    collaborationMode?: CodexCollaborationMode
    copilotAgentMode?: CopilotAgentMode
    model?: string | null
    modelReasoningEffort?: string | null
    effort?: string | null
    resumeWithSessionModel?: boolean
    active?: boolean
    allowSendWhenInactive?: boolean
    thinking?: boolean
    agentState?: AgentState | null
    backgroundTaskCount?: number
    contextSize?: number
    contextCacheRead?: number
    contextWindow?: number | null
    contextModel?: string | null
    controlledByUser?: boolean
    agentFlavor?: string | null
    availableModelOptions?: Array<{ value: string | null; label: string }>
    claudeProxyModelOptions?: Array<{ value: string; label: string }> | null
    piModels?: PiModelSummary[]
    piSelectedModel?: { provider: string; modelId: string } | null
    availableModelReasoningEffortOptions?: Array<{ value: string; name?: string }>
    availableEffortOptions?: Array<{ value: string; name?: string }>
    ompThinkingState?: OmpThinkingState
    ompModelsLoading?: boolean
    ompModelsError?: string | null
    onRefreshOmpModels?: () => void
    threadGoal?: ThreadGoal | null
    selectedModelBase?: string | null
    selectedModelVariant?: string | null
    modelEffortOptions?: Array<{ value: string; label: string }>
    resolveModelVariantsForBase?: (baseKey: string) => readonly { value: string; label: string }[]
    onCollaborationModeChange?: (mode: CodexCollaborationMode) => void
    onCopilotAgentModeChange?: (mode: CopilotAgentMode) => void
    onPermissionModeChange?: (mode: PermissionMode) => void
    onModelChange?: (model: { provider: string; modelId: string } | string | null) => void
    onCycleModel?: () => void
    ccSwitchProviders?: Array<{ id: string; name: string; isCurrent: boolean }>
    currentCcSwitchProviderId?: string | null
    onCcSwitchProviderChange?: (providerId: string) => void
    onResumeWithSessionModelChange?: (enabled: boolean) => void
    onModelEffortChange?: (wireId: string | null) => void
    onModelReasoningEffortChange?: (modelReasoningEffort: string | null) => void
    onEffortChange?: (effort: string | null) => void
    serviceTier?: string | null
    onServiceTierChange?: (serviceTier: string | null) => void
    onSwitchToRemote?: () => void
    onTerminal?: () => void
    terminalUnsupported?: boolean
    autocompletePrefixes?: string[]
    autocompleteSuggestions?: (query: string) => Promise<Suggestion[]>
    voiceStatus?: ConversationStatus
    voiceMicMuted?: boolean
    onVoiceToggle?: () => void
    onVoiceMicToggle?: () => void
    voiceTranscriptionApi?: ApiClient
    pendingSchedule?: PendingSchedule | null
    onSchedule?: (pending: PendingSchedule) => void
    onClearSchedule?: () => void
    scratchlistMode?: boolean
    scratchlistCount?: number
    onScratchlistToggle?: () => void
    /** Parking is a transaction: snapshot validation precedes commit and editor clearing. */
    onParkScratchlist?: (text: string, pending: readonly Attachment[]) => Promise<ScratchlistParkResult>
    onScratchlistParkingChange?: (parking: boolean) => void
    sendError?: ComposerSendError | null
    onClearSendError?: () => void
    onSuppressSendErrorRestore?: (id: number) => void
    sendAcceptance?: { attemptId: string | null } | null
    sendSettlement?: { attemptId: string; status: 'success' | 'error' } | null
    onResumeStoredDraft?: () => void | Promise<void>
    /** Consumed once by the external composer runtime's onNew callback. */
    pendingSendIntentRef?: MutableRefObject<ComposerSendIntent>
    resolveSessionMentionTooltip?: (id: string, title: string) => SessionMentionResolveResult
}
