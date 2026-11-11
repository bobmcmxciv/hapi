import type { VisibleChatBlock } from '@/chat/toolGroups'
import { isToolGroupBlock, visibleBlockRole } from '@/chat/toolGroups'
import type { ToolCallBlock } from '@/chat/types'
import type { RuntimeItem, RuntimeRun } from '@hapi/protocol/runtimeTimeline'
import { getConversationMessageAnchorId } from '@/chat/outline'
import { getEventPresentation } from '@/chat/presentation'
import { isEventVisibleForFlavor } from '@/fork-features/omp-product/eventVisibility'
import type { BetaRow } from './store'

/**
 * DOM anchor id + share/outline contract.
 *
 * History rows reuse the legacy `${kind}:${block.id}` threadMessageId scheme
 * so `outlineItems` targets (`user-text:${block.id}`), fork/rewind boundary
 * ids, and `hapi-message-*` anchors resolve identically to the old UI.
 * Runtime rows mint `runtime:${item.id}`.
 */
export function rowDomId(row: BetaRow): string {
 const raw = row.kind === 'history'
  ? `${row.block.kind}:${row.block.id}`
  : `runtime:${row.item.id}`
 return getConversationMessageAnchorId(raw)
}

/** The raw threadMessageId (no `hapi-message-` prefix) a row is known by. */
export function rowThreadMessageId(row: BetaRow): string {
 return row.kind === 'history'
  ? `${row.block.kind}:${row.block.id}`
  : `runtime:${row.item.id}`
}

export function rowRole(row: BetaRow): 'user' | 'assistant' | 'system' {
 if (row.kind === 'history') return visibleBlockRole(row.block)
 return 'assistant'
}

/** Copyable text a row contributes to message actions. */
export function rowCopyText(row: BetaRow): string {
 if (row.kind === 'runtime') return row.item.text?.trim() ?? ''
 const block = row.block
 switch (block.kind) {
  case 'user-text':
  case 'agent-text':
  case 'agent-reasoning':
  case 'cli-output':
   return block.text.trim()
  default:
   return ''
 }
}

/**
 * Map a native runtime tool item to the historical ToolCallBlock shape so the
 * existing ToolCard (permissions, results, details, timing) renders live tool
 * progress without a second presentation path.
 */
function extractRuntimeToolDescription(input: unknown): string | null {
 if (!input || typeof input !== 'object') return null
 const obj = input as Record<string, unknown>
 for (const key of ['i', 'description', 'title'] as const) {
  const value = obj[key]
  if (typeof value === 'string' && value.trim().length > 0) return value.trim()
 }
 return null
}

export function runtimeItemToToolCallBlock(item: RuntimeItem): ToolCallBlock {
 const state = item.state === 'running'
  ? 'running'
  : item.state === 'completed' && item.tool?.isError !== true
   ? 'completed'
   : 'error'
 const output = item.tool?.output
 const block: ToolCallBlock = {
  kind: 'tool-call',
  id: item.tool?.id ?? item.id,
  localId: null,
  createdAt: item.createdAt,
  tool: {
   id: item.tool?.id ?? item.id,
   name: item.tool?.name ?? 'tool',
   state,
   input: item.tool?.input ?? null,
   createdAt: item.createdAt,
   startedAt: item.createdAt,
   completedAt: state === 'running' ? null : item.updatedAt,
   execStartedAt: null,
   execCompletedAt: null,
   description: extractRuntimeToolDescription(item.tool?.input),
   result: output ?? item.errorMessage,
   permission: undefined
  },
  children: []
 }
 return block
}

/**
 * View-model block for response-group aggregation. Runtime assistant items
 * carry `localId:null` + `model` so turn dedup matches the historical rule;
 * tool items reuse the ToolCallBlock mapping.
 */
export function rowToVisibleBlock(row: BetaRow): VisibleChatBlock {
 if (row.kind === 'history') return row.block
 const item = row.item
 if (item.kind === 'tool') {
  return runtimeItemToToolCallBlock(item)
 }
 return {
  kind: 'agent-text',
  id: `runtime:${item.id}`,
  localId: null,
  createdAt: item.createdAt,
  text: item.text ?? '',
  model: item.model ?? null
 }
}

/** Footer label for non-clean terminal states, or null. */
export function runtimeTerminalLabel(item: RuntimeItem): string | null {
 if (item.state === 'completed') {
  if (item.stopReason === 'length') return 'beta.timeline.length'
  if (item.stopReason === 'error') return item.errorMessage?.trim() || 'beta.timeline.turnError'
  if (item.stopReason === 'aborted') return 'beta.timeline.aborted'
  return null
 }
 if (item.state === 'error') return item.errorMessage?.trim() || 'beta.timeline.turnError'
 if (item.state === 'aborted') return 'beta.timeline.aborted'
 return null
}

export function runtimeRunTerminalLabel(run: RuntimeRun | null): string | null {
 if (!run) return null
 if (run.state === 'aborted') return 'beta.timeline.runAborted'
 if (run.state === 'error') return run.errorMessage?.trim() || 'beta.timeline.runError'
 if (run.stopReason === 'length') return 'beta.timeline.length'
 return null
}

/** Canonical rows keep terminal state when the temporary runtime row merges. */
export function historyTerminalLabel(block: VisibleChatBlock): string | null {
 if (block.kind === 'user-text' && block.resolution) return `message.resolution.${block.resolution.outcome}`
 if (!('meta' in block) || !block.meta || typeof block.meta !== 'object') return null
 const meta = block.meta as Record<string, unknown>
 if (meta.runtimeStopReason === 'length') return 'beta.timeline.length'
 if (meta.runtimeStopReason === 'aborted') return 'beta.timeline.aborted'
 if (meta.runtimeStopReason === 'error') {
  return typeof meta.runtimeErrorMessage === 'string' && meta.runtimeErrorMessage.trim()
   ? meta.runtimeErrorMessage
   : 'beta.timeline.turnError'
 }
 return null
}

export function isShareableUserRow(row: BetaRow): boolean {
 return row.kind === 'history'
  && row.block.kind === 'user-text'
  && row.block.status !== 'failed'
  && row.block.invokedAt !== null
  && !row.block.resolution
}

/**
 * Mirror of `buildShareHiddenByMessageId` over beta rows: while the run is
 * active, rows from the latest shareable user message onward belong to the
 * in-flight turn and must not be shareable. Runtime rows are hidden while a
 * run is active and shareable once it ends.
 */
export function buildBetaShareHiddenIds(
 rows: readonly BetaRow[],
 isRunning: boolean
): ReadonlySet<string> {
 const hidden = new Set<string>()
 if (!isRunning) return hidden
 const activeUserIndex = rows.findLastIndex(isShareableUserRow)
 for (let i = 0; i < rows.length; i += 1) {
  const row = rows[i]
  if (row.kind === 'runtime' || activeUserIndex < 0 || i >= activeUserIndex) {
   hidden.add(row.id)
  }
 }
 return hidden
}

/**
 * Turn selection for share: walk back from the target row to the nearest
 * preceding shareable user row, then forward until the next shareable user
 * row. Queued/failed messages and user CLI output are content, not execution
 * boundaries. User/assistant snapshots include the entire selected turn;
 * system notices remain outside the share presentation.
 */
export function selectShareTurnRows(
 allRows: readonly BetaRow[],
 targetRowId: string
): readonly BetaRow[] {
 const targetIndex = allRows.findIndex((row) => row.id === targetRowId)
 if (targetIndex < 0) return []

 let start = 0
 for (let i = targetIndex; i >= 0; i -= 1) {
  if (isShareableUserRow(allRows[i])) {
   start = i
   break
  }
 }

 const out: BetaRow[] = []
 for (let i = start; i < allRows.length; i += 1) {
  const row = allRows[i]
  if (i !== start && isShareableUserRow(row)) break
  if (rowRole(row) === 'user' || rowRole(row) === 'assistant') {
   out.push(row)
  }
 }
 if (out.length === 0) out.push(allRows[targetIndex])
 return out
}

/** Nearest preceding shareable user text — ShareTurnButton fallback. */
export function fallbackUserTextForRow(
 allRows: readonly BetaRow[],
 targetRowId: string
): string {
 const targetIndex = allRows.findIndex((row) => row.id === targetRowId)
 for (let i = targetIndex; i >= 0; i -= 1) {
  const row = allRows[i]
  if (row && row.kind === 'history' && row.block.kind === 'user-text' && isShareableUserRow(row)) {
   return row.block.text.trim()
  }
 }
 return ''
}

/** Is this row a grouped tool presentation? */
export function isGroupRow(row: BetaRow): boolean {
 return row.kind === 'history' && isToolGroupBlock(row.block)
}

/**
 * Event presentation for `agent-event` blocks, with the flavor visibility
 * filter applied. Centralizes so BetaRow and share agree.
 */
export function agentEventPresentation(
 block: Extract<VisibleChatBlock, { kind: 'agent-event' }>,
 flavor: string | null
) {
 if (!isEventVisibleForFlavor(block.event, flavor) && !block.event.type.includes('error') && !('level' in block.event && block.event.level === 'error')) return null
 return getEventPresentation(block.event)
}

/** Pending descendants must remain reachable even inside collapsed task rows. */
export function hasPendingRequest(block: VisibleChatBlock, requestIds?: ReadonlySet<string>): boolean {
 if (block.kind === 'tool-group') return block.tools.some((tool) => hasPendingRequest(tool, requestIds))
 if (block.kind !== 'tool-call') return false
 const permission = block.tool.permission
 return Boolean(permission?.status === 'pending' && (!requestIds || requestIds.has(permission.id)))
  || block.children.some((child) => hasPendingRequest(child, requestIds))
}
