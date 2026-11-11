import { memo, useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import { useNavigate } from '@tanstack/react-router'
import type { ChatBlock, ToolCallBlock, UserTextBlock } from '@/chat/types'
import type { VisibleChatBlock } from '@/chat/toolGroups'
import type { MessageMetadataProps } from '@/components/AssistantChat/messages/MessageMetadata'
import { useHappyChatContext } from '@/components/AssistantChat/context'
import { MarkdownRenderer } from '@/components/MarkdownRenderer'
import { CliOutputBlock } from '@/components/CliOutputBlock'
import { CodexReviewCard } from '@/components/AssistantChat/messages/CodexReviewCard'
import { EventNotice } from '@/components/AssistantChat/messages/EventNotice'
import { GeneratedFileCard, GeneratedImageCard } from '@/components/AssistantChat/messages/ToolMessage'
import { MessageAttachments } from '@/components/AssistantChat/messages/MessageAttachments'
import { MessageStatusIndicator } from '@/components/AssistantChat/messages/MessageStatusIndicator'
import { SpeakSummaryButton } from '@/components/AssistantChat/messages/SpeakSummaryButton'
import { UserBubbleContent, getUserBubbleClassName, shouldShowMessageStatus } from '@/components/AssistantChat/messages/user-bubble'
import { ToolCard } from '@/components/ToolCard/ToolCard'
import { ToolGroupCard } from '@/components/ToolCard/ToolGroupCard'
import { isSubagentToolName } from '@/chat/subagentTool'
import { useSessionActions } from '@/hooks/mutations/useSessionActions'
import { getFlavorForkCapability, useFlavorCapabilities } from '@/hooks/queries/useFlavorCapabilities'
import { setForkedFromText } from '@/lib/fork-restore'
import { formatMessageTimestamp, formatMessageTimestampTitle } from '@/chat/presentation'
import { RewindIcon } from '@/components/icons'
import { BetaMessageActions } from './BetaMessageActions'
import type { BetaTimelineStore, BetaRow as BetaRowData } from './store'
import { agentEventPresentation, hasPendingRequest, historyTerminalLabel, rowDomId, rowThreadMessageId, runtimeItemToToolCallBlock, runtimeTerminalLabel } from './betaTimelineView'
import { useTranslation } from '@/lib/use-translation'
import { generatedArtifacts } from './betaTurns'
import { BetaDetails, BetaExpansionRow } from './BetaExpansion'

export type BetaRowViewProps = {
 row: BetaRowData
 isRunning?: boolean
 hideShare?: boolean
 metadata?: Omit<MessageMetadataProps, 'className'>
 /** Share renders a complete data-selected turn offscreen, without actions. */
 capture?: boolean
 embedded?: boolean
}

function Timestamp({ at }: { at: number }) {
 const date = new Date(at)
 return <time className="text-[10px] tabular-nums text-[var(--app-hint)]" dateTime={date.toISOString()} title={formatMessageTimestampTitle(date)}>{formatMessageTimestamp(date)}</time>
}

function Reasoning({ text, running }: { text: string; running?: boolean }) {
 const { t } = useTranslation()
 return <BetaDetails id="reasoning" className="aui-reasoning-group beta-reasoning">
  <summary className="sticky top-0 z-10 cursor-pointer rounded bg-[var(--app-bg)] py-1 text-xs text-[var(--app-hint)]">{t('beta.timeline.thinking')}{running ? '…' : ''}</summary>
  <div className="border-l border-[var(--app-border)] pl-3 text-[var(--app-hint)]"><MarkdownRenderer content={text} /></div>
 </BetaDetails>
}

/** Full ChatBlock renderer, reused inside nested tools and share capture. */
export function BetaBlockContent({ block }: { block: VisibleChatBlock }) {
 const ctx = useHappyChatContext()
 switch (block.kind) {
  case 'user-text':
   return <div className={getUserBubbleClassName(block.resolution ? undefined : block.status)}>
    <UserBubbleContent text={block.text} />
    {block.attachments?.length ? <MessageAttachments attachments={block.attachments} /> : null}
   </div>
  case 'agent-text':
   return <MarkdownRenderer content={block.text} />
  case 'agent-reasoning':
   return <Reasoning text={block.text} />
  case 'codex-review':
   return <CodexReviewCard review={block.review} />
  case 'cli-output':
   return <div className={block.source === 'user' ? 'ml-auto w-full max-w-[92%]' : ''}><CliOutputBlock text={block.text} /></div>
  case 'generated-image':
   return <GeneratedImageCard block={block} />
  case 'generated-file':
   return <div className="beta-generated-file"><GeneratedFileCard block={block} /></div>
  case 'agent-event': {
   const presentation = agentEventPresentation(block, ctx.metadata?.flavor ?? null)
   return presentation ? <EventNotice {...presentation} trailing={<Timestamp at={block.createdAt} />} /> : null
  }
  case 'tool-group':
   return <div data-hapi-share-exclude="true"><ToolGroupCard block={block} metadata={ctx.metadata} /></div>
  case 'tool-call':
   return <BetaToolBlock block={block} />
 }
}

function BetaNestedBlocks({ blocks }: { blocks: ChatBlock[] }) {
 return <div className="flex flex-col gap-3">{blocks.map((block) => <BetaBlockContent key={`${block.kind}:${block.id}`} block={block} />)}</div>
}

function BetaToolBlock({ block }: { block: ToolCallBlock }) {
 const ctx = useHappyChatContext()
 const { t } = useTranslation()
 const task = isSubagentToolName(block.tool.name)
 // Keep every pending branch outside collapsed task details, including nested
 // CodexAgent requests whose noninteractive content remains hidden.
 const pending = block.children.filter((child) => hasPendingRequest(child))
 const rest = block.children.filter((child) => !hasPendingRequest(child))
 return <div data-hapi-share-exclude="true" className="py-1 min-w-0 max-w-full overflow-x-clip">
  <ToolCard api={ctx.api} sessionId={ctx.sessionId} metadata={ctx.metadata} terminalToolDisplayMode={ctx.terminalToolDisplayMode} disabled={ctx.disabled} onDone={ctx.onRefresh} block={block} />
  {pending.length > 0 ? <div className="mt-2 pl-3"><BetaNestedBlocks blocks={pending} /></div> : null}
  {block.tool.name !== 'CodexAgent' && rest.length > 0 ? task
   ? <BetaDetails id={`task:${block.tool.id}`} className="mt-2"><summary className="sticky top-0 z-10 cursor-pointer bg-[var(--app-bg)] py-1 text-xs text-[var(--app-hint)]">{t('beta.timeline.taskDetails', { n: rest.length })}</summary><div className="mt-2 pl-3"><BetaNestedBlocks blocks={rest} /></div></BetaDetails>
   : <div className="mt-2 pl-3"><BetaNestedBlocks blocks={rest} /></div> : null}
 </div>
}

function BetaUserContent({ block, messageId, hideShare, isRunning }: {
 block: UserTextBlock
 messageId: string
 hideShare?: boolean
 isRunning?: boolean
}) {
 const ctx = useHappyChatContext()
 const { t } = useTranslation()
 const navigate = useNavigate()
 const [error, setError] = useState<string | null>(null)
 const sessionFlavor = ctx.metadata?.flavor ?? null
 const { data: capabilities } = useFlavorCapabilities(ctx.api)
 const { forkSession, isPending } = useSessionActions(ctx.api, ctx.sessionId, sessionFlavor)
 const rewindSupported = Boolean(sessionFlavor) && getFlavorForkCapability(capabilities, sessionFlavor).fork === 'at-message'
 const history = ctx.metadata?.capabilities?.conversationHistory
 const nativePoint = Boolean(block.localId && ctx.metadata?.conversationHistoryPoints?.[block.localId])
 const latest = ctx.isLatestCompletedBoundary?.(messageId) === true
 const currentFork = Boolean(!block.resolution && history?.forkCurrent && latest && !ctx.disabled && ctx.onForkConversation)
 const historicalFork = Boolean(!block.resolution && history?.forkAtMessage && nativePoint && !latest && !ctx.disabled && ctx.onForkConversation)
 const rewind = Boolean(!block.resolution && history?.rewindToMessage && nativePoint && !ctx.disabled && ctx.onRewindConversation)
 const effectiveStatus = block.invokedAt != null ? 'sent' : !block.resolution && block.invokedAt === null && block.status !== 'failed' && block.status !== 'sending' ? 'queued' : block.status
 const canRetry = !block.resolution && effectiveStatus === 'failed' && Boolean(block.localId && ctx.onRetryMessage)
 const copyText = block.text ? block.resolution ? `${t(historyTerminalLabel(block)!)}\n${block.text}` : block.text : undefined
 const handleLegacyRewind = async () => {
  setError(null)
  try {
   const result = await forkSession({ forkPoint: { messageId: block.id } })
   if (result.type === 'blocked') return
   if (block.text) setForkedFromText(result.newSessionId, block.text)
   await navigate({ to: '/sessions/$sessionId', params: { sessionId: result.newSessionId } })
  } catch (err) {
   setError(err instanceof Error ? err.message : t('beta.timeline.rewindFailed'))
  }
 }
 const hasForceSend = Boolean(block.meta && typeof block.meta === 'object' && 'forceSendRequestedAt' in block.meta && typeof block.meta.forceSendRequestedAt === 'number')
 const delivering = block.invokedAt === null && hasForceSend
 return <div className="flex flex-col gap-1">
  <div className={effectiveStatus === 'queued' ? 'flex flex-col gap-1' : 'flex items-start gap-2'}>
   <div className="min-w-0 flex-1">
    {block.text ? <UserBubbleContent text={block.text} /> : null}
    {block.attachments?.length ? <MessageAttachments attachments={block.attachments} /> : null}
   </div>
   {!block.resolution && (block.invokedAt === null || shouldShowMessageStatus(effectiveStatus)) ? <div className="happy-message-actions-first-line shrink-0"><MessageStatusIndicator status={effectiveStatus} delivering={delivering} onRetry={canRetry ? () => ctx.onRetryMessage!(block.localId!) : undefined} /></div> : null}
  </div>
  <div className="flex flex-wrap items-center justify-end gap-1">
   {rewindSupported && !block.resolution && block.invokedAt !== null && effectiveStatus !== 'failed' && effectiveStatus !== 'sending' && effectiveStatus !== 'queued' && !ctx.disabled ? <button type="button" title={t('message.rewind')} aria-label={t('message.rewind')} className="beta-action text-[var(--app-hint)]" disabled={isPending || isRunning} onClick={() => void handleLegacyRewind()}><RewindIcon className="h-3.5 w-3.5" /></button> : null}
   <BetaMessageActions align="end" copyText={copyText} createdAt={block.invokedAt ?? block.createdAt} messageElementId={`hapi-message-${messageId}`} hideShare={hideShare || Boolean(block.resolution)} threadIsRunning={isRunning}
    showFork={currentFork || historicalFork} showRewind={rewind} historyActionPending={ctx.historyActionPending}
    onFork={currentFork ? () => ctx.onForkConversation!() : historicalFork ? () => ctx.onForkConversation!(block.localId!) : undefined}
    onRewind={rewind ? () => ctx.onRewindConversation!(block.localId!) : undefined} />
  </div>
  {error ? <div className="text-right text-xs text-red-500" role="alert">{error}</div> : null}
 </div>
}

/** Pure data presentation — no AUI message/thread subscriptions. */
export function BetaRowView({ row, isRunning = false, hideShare = false, metadata, capture = false, embedded = false }: BetaRowViewProps) {
 const ctx = useHappyChatContext()
 const { t } = useTranslation()
 const messageId = rowThreadMessageId(row)
 if (capture && (row.kind === 'runtime' ? row.item.kind === 'tool' : row.block.kind === 'tool-call' || row.block.kind === 'tool-group')) {
  const artifacts = row.kind === 'history' ? generatedArtifacts(row.block) : []
  return artifacts.length ? <div data-hapi-message-role="assistant">{artifacts.map((block) => <BetaBlockContent key={block.id} block={block} />)}</div> : null
 }
 const elementId = rowDomId(row)
 if (row.kind === 'history') {
  const block = row.block
  const role = block.kind === 'user-text' ? 'user' : block.kind === 'agent-event' ? 'system' : block.kind === 'cli-output' ? block.source === 'user' ? 'user' : 'assistant' : 'assistant'
  const text = 'text' in block ? block.text : ''
  const baseMetadata = 'durationMs' in block || 'usage' in block || 'model' in block ? {
   durationMs: 'durationMs' in block ? block.durationMs : undefined,
   usage: 'usage' in block ? block.usage : undefined,
   model: 'model' in block ? block.model : null
  } : undefined
  const forkCurrent = Boolean(ctx.metadata?.capabilities?.conversationHistory?.forkCurrent && ctx.isLatestCompletedBoundary?.(messageId) && !ctx.disabled && ctx.onForkConversation)
  return <div id={capture || embedded ? undefined : elementId} tabIndex={-1} data-beta-row-id={row.id} data-hapi-message-role={role} className={`happy-message beta-row scroll-mt-4 min-w-0 max-w-full overflow-x-clip ${block.kind === 'user-text' ? getUserBubbleClassName(block.resolution || block.invokedAt != null ? 'sent' : block.invokedAt === null && block.status !== 'failed' && block.status !== 'sending' ? 'queued' : block.status) : 'px-1'}`}>
   {block.kind === 'user-text' && !capture
    ? <BetaUserContent block={block} messageId={messageId} hideShare={hideShare} isRunning={isRunning} />
    : block.kind === 'user-text'
     ? <><UserBubbleContent text={block.text} />{block.attachments?.length ? <MessageAttachments attachments={block.attachments} /> : null}</>
     : <BetaBlockContent block={block} />}
   {historyTerminalLabel(block) ? <div className="mt-1 text-xs text-[var(--app-hint)]" role="status">{t(historyTerminalLabel(block)!)}</div> : null}
   {!capture && block.kind !== 'user-text' && role !== 'system' ? <div className="flex flex-wrap items-center gap-1">
    <BetaMessageActions align={role === 'user' ? 'end' : 'start'} copyText={text || undefined} createdAt={block.createdAt} metadata={metadata ?? baseMetadata} messageElementId={elementId} hideShare={hideShare} threadIsRunning={isRunning}
     showFork={forkCurrent} historyActionPending={ctx.historyActionPending} onFork={forkCurrent ? () => ctx.onForkConversation!() : undefined} />
    {block.kind === 'agent-text' && text ? <SpeakSummaryButton messageId={messageId} text={text} /> : null}
   </div> : null}
  </div>
 }
 const item = row.item
 const terminalLabel = runtimeTerminalLabel(item)
 return <div id={capture || embedded ? undefined : elementId} tabIndex={-1} data-beta-row-id={row.id} data-hapi-message-role="assistant" data-runtime-state={item.state} className="happy-message beta-row scroll-mt-4 px-1 min-w-0 max-w-full overflow-x-clip">
  {item.kind === 'tool' ? <BetaBlockContent block={runtimeItemToToolCallBlock(item)} /> : <>
   {item.reasoning ? <Reasoning text={item.reasoning} running={item.state === 'running' && !item.text} /> : null}
   {item.text ? <MarkdownRenderer content={item.text} /> : item.state === 'running' && !item.reasoning && !item.previewOmitted ? <span className="text-sm text-[var(--app-hint)]" role="status">{t('beta.timeline.thinking')}…</span> : null}
  </>}
  {item.previewOmitted ? <div className="mt-1 text-xs text-[var(--app-hint)]" role="status" data-hapi-share-exclude="true">{t('beta.timeline.previewDeferred')}</div> : null}
  {terminalLabel ? <div className={`mt-1 text-xs ${item.state === 'error' || item.stopReason === 'error' ? 'text-red-500' : 'text-[var(--app-hint)]'}`} role="status">{t(terminalLabel)}</div> : null}
  {!capture ? <div className="flex flex-wrap items-center gap-1">
   <BetaMessageActions align="start" copyText={item.text || undefined} createdAt={item.createdAt} metadata={metadata ?? { model: item.model }} messageElementId={elementId} hideShare={hideShare} threadIsRunning={isRunning} />
   {item.kind === 'assistant' && item.text ? <SpeakSummaryButton messageId={messageId} text={item.text} /> : null}
  </div> : null}
 </div>
}

/** Only the named row subscribes to its payload; live token updates never
 * invalidate the virtual list or unrelated row snapshots. */
export const BetaRow = memo(function BetaRow({ store, id, isRunning, hideShare, metadata, measureRef }: {
 store: BetaTimelineStore
 id: string
 isRunning: boolean
 hideShare: boolean
 metadata?: Omit<MessageMetadataProps, 'className'>
 measureRef?: (node: HTMLDivElement | null) => void
}) {
 const subscribe = useCallback((listener: () => void) => store.subscribeRow(id, listener), [store, id])
 const getSnapshot = useCallback(() => store.getRow(id), [store, id])
 const row = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
 const stableMetadata = useMemo(() => metadata, [metadata])
 if (!row) return null
 const role = row.kind === 'runtime' ? 'assistant' : row.block.kind === 'user-text' ? 'user' : row.block.kind === 'agent-event' ? 'system' : row.block.kind === 'cli-output' && row.block.source === 'user' ? 'user' : 'assistant'
 const turnStart = row.kind === 'history' && row.block.kind === 'user-text' && !row.block.resolution && row.block.invokedAt !== null && row.block.status !== 'failed'
 return <div id={rowDomId(row)} data-hapi-message-role={role} data-beta-turn-id={turnStart ? `turn:${id}` : undefined} ref={measureRef} data-beta-measure-id={id} className={`beta-row-slot ${turnStart ? 'beta-turn-start' : ''}`}>
  <BetaExpansionRow id={id}><BetaRowView row={row} isRunning={isRunning} hideShare={hideShare} metadata={stableMetadata} embedded /></BetaExpansionRow>
 </div>
})
