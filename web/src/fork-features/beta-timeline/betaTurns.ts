import type { ChatBlock } from '@/chat/types'
import type { VisibleChatBlock } from '@/chat/toolGroups'
import type { BetaRow, BetaRowRef, BetaTimelineStatus } from './store'
import { hasPendingRequest } from './betaTimelineView'
import type { AgentState } from '@/types/api'
import { ensureToolBlock, getPermissions } from '@/chat/reducerTools'

export type BetaProcessEntity = Readonly<{ id: string; sourceId?: string; toolIndex?: number; kind: 'row' | 'tool' }>
export type BetaArtifactRef = Readonly<{ id: string; sourceId: string; blockId: string }>
export type BetaProcessSegment = Readonly<{
 id: string
 rowId: string
 turnId: string
 process: readonly string[]
 entities: readonly BetaProcessEntity[]
 artifacts: readonly BetaArtifactRef[]
}>
export type BetaTurnStep =
 | Readonly<{ kind: 'row'; id: string }>
 | Readonly<{ kind: 'segment'; segment: BetaProcessSegment }>
export type BetaTurn = Readonly<{
 id: string
 userId?: string
 primary: readonly string[]
 process: readonly string[]
 entities: readonly BetaProcessEntity[]
 artifacts: readonly BetaArtifactRef[]
 segments: readonly BetaProcessSegment[]
 steps: readonly BetaTurnStep[]
}>
export type BetaPresentationRow = Readonly<{
 id: string
 turnId: string
 segmentId?: string
 kind: 'row' | 'tool' | 'process' | 'artifact'
 sourceId?: string
 blockId?: string
 toolIndex?: number
}>

export function generatedArtifacts(block: VisibleChatBlock): ChatBlock[] {
 if (block.kind === 'generated-file' || block.kind === 'generated-image') return [block]
 if (block.kind === 'tool-call') return block.children.flatMap(generatedArtifacts)
 if (block.kind === 'tool-group') return block.tools.flatMap(generatedArtifacts)
 return []
}

function isDirectPrimaryRow(row: BetaRow, index: number, total: number): boolean {
 if (row.kind === 'runtime') {
  if (row.item.kind !== 'assistant') return false
  if (Boolean(row.item.text && row.item.text.trim().length > 0)) return true
  return index === total - 1 && row.item.state === 'running'
 }
 const block = row.block
 if (block.kind === 'user-text') return true
 if (block.kind === 'codex-review') return true
 if (block.kind === 'agent-text') return block.text.trim().length > 0
 if (block.kind === 'generated-file' || block.kind === 'generated-image') return true
 if (block.kind === 'cli-output' && block.source === 'user') return true
 return false
}

/** IDs belong to the invoked user row, not a changing response/tool grouping. */
export function partitionBetaTurns(refs: readonly BetaRowRef[], getRow: (id: string) => BetaRow | undefined, continuationTurnId?: string | null): readonly BetaTurn[] {
 const groups: { id: string; userId?: string; rows: BetaRow[] }[] = []
 for (const ref of refs) {
  const row = getRow(ref.id)
  if (!row) continue
  const user = row.kind === 'history' && row.block.kind === 'user-text' && !row.block.resolution && row.block.invokedAt !== null && row.block.status !== 'failed'
  if (user || groups.length === 0) groups.push({ id: user ? `turn:${row.id}` : continuationTurnId ? `turn:h:${continuationTurnId}` : 'turn:continuation', userId: user ? row.id : undefined, rows: [] })
  groups[groups.length - 1].rows.push(row)
 }
 return groups.map((group) => {
  const primary: string[] = []
  const process: string[] = []
  const entities: BetaProcessEntity[] = []
  const artifacts: BetaArtifactRef[] = []
  const segments: BetaProcessSegment[] = []
  const steps: BetaTurnStep[] = []
  let currentProcess: string[] = []
  let currentEntities: BetaProcessEntity[] = []
  let currentArtifacts: BetaArtifactRef[] = []
  const flushSegment = () => {
   if (currentProcess.length === 0) return
   const segIndex = segments.length
   const segId = segIndex === 0 ? group.id : `${group.id}:seg:${segIndex}`
   const rowId = `process:${segId}`
   const segment: BetaProcessSegment = {
    id: segId,
    rowId,
    turnId: group.id,
    process: currentProcess,
    entities: currentEntities,
    artifacts: currentArtifacts
   }
   segments.push(segment)
   steps.push({ kind: 'segment', segment })
   currentProcess = []
   currentEntities = []
   currentArtifacts = []
  }
  group.rows.forEach((row, i) => {
   const block = row.kind === 'history' ? row.block : null
   if (isDirectPrimaryRow(row, i, group.rows.length)) {
    flushSegment()
    primary.push(row.id)
    steps.push({ kind: 'row', id: row.id })
    return
   }
   process.push(row.id)
   currentProcess.push(row.id)
   if (block?.kind === 'tool-group') {
    block.tools.forEach((tool, toolIndex) => {
     const entity: BetaProcessEntity = { id: `process-tool:${tool.tool.id}`, sourceId: row.id, toolIndex, kind: 'tool' }
     entities.push(entity)
     currentEntities.push(entity)
    })
   } else if (block?.kind === 'tool-call' || (row.kind === 'runtime' && row.item.kind === 'tool')) {
    const entity: BetaProcessEntity = { id: `process-tool:${block?.kind === 'tool-call' ? block.tool.id : row.kind === 'runtime' ? row.item.tool?.id ?? row.item.id : row.id}`, sourceId: row.id, kind: 'tool' }
    entities.push(entity)
    currentEntities.push(entity)
   } else {
    const entity: BetaProcessEntity = { id: row.id, kind: 'row' }
    entities.push(entity)
    currentEntities.push(entity)
   }
   if (block?.kind === 'tool-call' || block?.kind === 'tool-group') {
    for (const artifact of generatedArtifacts(block)) {
     const ref: BetaArtifactRef = { id: `artifact:${row.id}:${artifact.id}`, sourceId: row.id, blockId: artifact.id }
     artifacts.push(ref)
     currentArtifacts.push(ref)
    }
   }
  })
  flushSegment()
  return { id: group.id, userId: group.userId, primary, process, entities, artifacts, segments, steps }
 })
}

export function presentBetaTurns(turns: readonly BetaTurn[], expanded: ReadonlySet<string>): readonly BetaPresentationRow[] {
 return turns.flatMap((turn) => {
  const rows: BetaPresentationRow[] = []
  for (const step of turn.steps) {
   if (step.kind === 'row') {
    rows.push({ id: step.id, turnId: turn.id, kind: 'row' })
   } else {
    const seg = step.segment
    const isExpanded = expanded.has(seg.id)
    rows.push({ id: seg.rowId, turnId: turn.id, segmentId: seg.id, kind: 'process' })
    if (isExpanded) {
     for (const entity of seg.entities) rows.push({ ...entity, turnId: turn.id, segmentId: seg.id })
    }
    for (const artifact of seg.artifacts) rows.push({ ...artifact, turnId: turn.id, segmentId: seg.id, kind: 'artifact' })
   }
  }
  return rows
 })
}
export function processAttention(row: BetaRow): { pending: boolean; error: boolean; running: boolean } {
 if (row.kind === 'runtime') return { pending: false, error: row.item.state === 'error' || row.item.stopReason === 'error' || row.item.tool?.isError === true, running: row.item.state === 'running' }
 const inspect = (block: VisibleChatBlock): boolean => block.kind === 'tool-call'
  ? block.tool.state === 'error' || block.children.some(inspect)
  : block.kind === 'tool-group' ? block.tools.some(inspect)
   : block.kind === 'user-text' ? !block.resolution && block.status === 'failed'
    : block.kind === 'agent-event' ? block.event.type.includes('error') || ('level' in block.event && block.event.level === 'error')
     : 'meta' in block && Boolean(block.meta && typeof block.meta === 'object' && 'runtimeStopReason' in block.meta && block.meta.runtimeStopReason === 'error')
 const running = (block: VisibleChatBlock): boolean => block.kind === 'tool-call' ? block.tool.state === 'running' || block.children.some(running) : block.kind === 'tool-group' && block.tools.some(running)
 return { pending: hasPendingRequest(row.block), error: inspect(row.block), running: running(row.block) }
}

export function currentRunState(status: BetaTimelineStatus, session: { active: boolean; thinking: boolean }, pending: boolean): 'waiting' | 'running' | 'completed' | 'aborted' | 'error' | 'offline' | 'reconnecting' | 'idle' {
 if (status.connection === 'error' || status.error) return 'error'
 if (status.connection === 'connecting' || status.connection === 'reconnecting') return 'reconnecting'
 if (!session.active) return 'offline'
 if (pending) return 'waiting'
 if (status.run?.state === 'running' || (!status.run && session.thinking)) return 'running'
 if (status.run) return status.run.state === 'idle' && status.run.endedAt ? 'completed' : status.run.state
 return 'idle'
}

/** Pending agent state is actionable even when its transcript is out of window. */
export function orphanPendingBlocks(agentState: AgentState | null | undefined, rows: readonly BetaRow[]): ChatBlock[] {
 const blocks: ChatBlock[] = []
 const tools = new Map<string, Extract<ChatBlock, { kind: 'tool-call' }>>()
 for (const [id, entry] of getPermissions(agentState)) {
  if (entry.permission.status !== 'pending') continue
  const requestIds = new Set([id])
  if (rows.some((row) => row.kind === 'history' && hasPendingRequest(row.block, requestIds))) continue
  ensureToolBlock(blocks, tools, id, { createdAt: entry.permission.createdAt ?? Date.now(), localId: null, name: entry.toolName, input: entry.input, description: null, permission: entry.permission })
 }
 return blocks
}
