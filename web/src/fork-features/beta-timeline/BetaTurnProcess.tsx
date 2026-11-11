import { memo, useCallback, useMemo, useSyncExternalStore } from 'react'
import { useTranslation } from '@/lib/use-translation'
import { basename } from '@/utils/path'
import type { BetaTimelineStore, BetaRow } from './store'
import { BetaRowView } from './BetaRow'
import { generatedArtifacts, processAttention } from './betaTurns'
import { rowDomId } from './betaTimelineView'
import { BetaExpansionRow } from './BetaExpansion'
import { createBetaToolSnapshot } from './betaToolEntity'

function cleanTextSnippet(text: string, maxLen = 52): string {
 const lines = text
  .split(/\r?\n/)
  .map((line) => line.replace(/^[#*>\-\s`]+|[#*`]+$/g, '').trim())
  .filter((line) => line.length > 0)
 const last = lines[lines.length - 1] ?? ''
 if (!last) return ''
 return last.length > maxLen ? `${last.slice(0, maxLen - 1)}…` : last
}


function describeToolInput(name: string, input: unknown, description?: string | null): string {
 const obj = input && typeof input === 'object' ? (input as Record<string, unknown>) : null
 const intent = (typeof description === 'string' && description.trim())
  || (typeof obj?.i === 'string' && obj.i.trim())
  || (typeof obj?.title === 'string' && obj.title.trim())
  || (typeof obj?.description === 'string' && obj.description.trim())
  || ''
 let target = ''
 const file = typeof obj?.file_path === 'string' ? obj.file_path
  : typeof obj?.path === 'string' ? obj.path
   : typeof obj?.filePath === 'string' ? obj.filePath
    : typeof obj?.file === 'string' ? obj.file
     : typeof obj?.notebook_path === 'string' ? obj.notebook_path
      : ''
 if (file.trim()) {
  target = basename(file.trim())
 } else if (typeof obj?.input === 'string') {
  const match = obj.input.match(/^\[([^\n#]+)#([0-9A-Fa-f]{4})\]/m)
  if (match?.[1]) target = basename(match[1].trim())
 } else if (typeof obj?.command === 'string' && obj.command.trim()) {
  target = cleanTextSnippet(obj.command.trim(), 36)
 } else if (typeof obj?.cmd === 'string' && obj.cmd.trim()) {
  target = cleanTextSnippet(obj.cmd.trim(), 36)
 } else if (typeof obj?.pattern === 'string' && obj.pattern.trim()) {
  target = cleanTextSnippet(obj.pattern.trim(), 32)
 } else if (typeof obj?.query === 'string' && obj.query.trim()) {
  target = cleanTextSnippet(obj.query.trim(), 32)
 } else if (typeof obj?.task === 'string' && obj.task.trim()) {
  target = cleanTextSnippet(obj.task.trim(), 36)
 }
 if (intent && target && !intent.toLowerCase().includes(target.toLowerCase())) {
  return cleanTextSnippet(`${intent} (${target})`, 60)
 }
 if (intent) return cleanTextSnippet(intent, 56)
 if (target) return cleanTextSnippet(`${name}: ${target}`, 56)
 return ''
}

export function describeBetaRowActivity(row: BetaRow | undefined): string {
 if (!row) return ''
 if (row.kind === 'runtime') {
  const item = row.item
  if (item.kind === 'tool' && item.tool) {
   return describeToolInput(item.tool.name, item.tool.input, null)
  }
  if (item.kind === 'assistant' && item.reasoning && !item.text) {
   return cleanTextSnippet(item.reasoning, 48)
  }
  return ''
 }
 const block = row.block
 if (block.kind === 'tool-call') {
  return describeToolInput(block.tool.name, block.tool.input, block.tool.nativeTitle ?? block.tool.description)
 }
 if (block.kind === 'tool-group') {
  const active = [...block.tools].reverse().find((tool) => tool.tool.state === 'running') ?? block.tools[block.tools.length - 1]
  if (active) {
   return describeToolInput(active.tool.name, active.tool.input, active.tool.nativeTitle ?? active.tool.description ?? block.activityTitle)
  }
  return block.activityTitle ?? ''
 }
 if (block.kind === 'agent-reasoning') {
  return cleanTextSnippet(block.text, 48)
 }
 return ''
}

export function BetaLiveActivity({ store, id }: { store: BetaTimelineStore; id: string }) {
 const subscribe = useCallback((listener: () => void) => store.subscribeRow(id, listener), [store, id])
 const getSnapshot = useCallback(() => {
  const row = store.getRow(id)
  return row && processAttention(row).running ? describeBetaRowActivity(row) : ''
 }, [store, id])
 const label = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
 return label ? <span className="min-w-0 truncate">· {label}</span> : null
}

/** Cache classifications, not payloads. Each event recomputes one entity only. */
function attentionSubscription(store: BetaTimelineStore, ids: readonly string[]) {
 const states = new Map<string, { error: boolean; pending: boolean; running: boolean; label: string }>()
 const errors = new Set<string>()
 let pending = 0; let running = 0
 let snapshot = '0:0:0\n'
 const computeLabel = (): string => {
  for (let i = ids.length - 1; i >= 0; i -= 1) {
   const st = states.get(ids[i])
   if (st?.running && st.label) return st.label
  }
  for (let i = ids.length - 1; i >= 0; i -= 1) {
   const st = states.get(ids[i])
   if (st?.label) return st.label
  }
  return ''
 }
 const update = (id: string) => {
  const row = store.getRow(id)
  const att = row ? processAttention(row) : { error: false, pending: false, running: false }
  const label = describeBetaRowActivity(row)
  const old = states.get(id)
  if (old && old.error === att.error && old.pending === att.pending && old.running === att.running && old.label === label) return false
  states.set(id, { ...att, label })
  pending += Number(att.pending) - Number(old?.pending ?? false)
  running += Number(att.running) - Number(old?.running ?? false)
  if (att.error) errors.add(id); else errors.delete(id)
  snapshot = `${errors.size}:${pending}:${running}\n${computeLabel()}`
  return true
 }
 for (const id of ids) update(id)
 return {
  getSnapshot: () => snapshot,
  subscribe: (listener: () => void) => {
   const cleanups = ids.map((id) => store.subscribeRow(id, () => { if (update(id)) listener() }))
   // Close the render->subscribe race without scanning the window on ticks.
   for (const id of ids) update(id)
   return () => { for (const cleanup of cleanups) cleanup() }
  }
 }
}

/** Payload subscriptions stay here: a tool tick never invalidates turn layout. */
export const BetaTurnProcess = memo(function BetaTurnProcess({ store, ids, count = ids.length, expanded, onToggle, measureRef, id, sticky = false }: {
 store: BetaTimelineStore; ids: readonly string[]; count?: number; expanded: boolean; onToggle: () => void; id: string; measureRef?: (node: HTMLDivElement | null) => void; sticky?: boolean
}) {
 const { t } = useTranslation()
 const source = useMemo(() => attentionSubscription(store, ids), [store, ids])
 const state = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot)
 const newlineIdx = state.indexOf('\n')
 const countsPart = newlineIdx >= 0 ? state.slice(0, newlineIdx) : state
 const stepLabel = newlineIdx >= 0 ? state.slice(newlineIdx + 1) : ''
 const [errors, pending, running] = countsPart.split(':').map(Number)
 return <div ref={measureRef} data-beta-measure-id={sticky ? undefined : id} data-beta-row-id={sticky ? undefined : id} data-beta-sticky-process={sticky ? id : undefined} className={sticky ? 'beta-sticky-process' : 'beta-row-slot beta-process'}>
  <button type="button" className="beta-process-toggle" aria-expanded={expanded} onClick={onToggle}>
   <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>
   <span className="shrink-0 font-medium text-[var(--app-fg)]">{t('beta.timeline.process', { n: count })}</span>
   {running > 0 ? (
    <span className="inline-flex shrink-0 items-center gap-1.5 font-medium text-sky-600 dark:text-sky-400">
     <span className="inline-block h-1.5 w-1.5 rounded-full bg-current animate-pulse" aria-hidden="true" />
     <span>{t('beta.timeline.processRunning', { n: running })}</span>
    </span>
   ) : null}
   {pending > 0 ? <strong className="shrink-0 text-amber-600">{t('beta.timeline.processPending', { n: pending })}</strong> : null}
   {errors > 0 ? <strong className="shrink-0 text-red-500" role="alert">{t('beta.timeline.processErrors', { n: errors })}</strong> : null}
   {stepLabel && (!expanded || running > 0) ? (
    <span className="min-w-0 flex-1 truncate text-xs text-[var(--app-hint)]" data-beta-process-step="true">
     · {stepLabel}
    </span>
   ) : null}
  </button>
 </div>
})

export const BetaTurnArtifact = memo(function BetaTurnArtifact({ store, sourceId, blockId, id, measureRef, hideShare, isRunning }: {
 store: BetaTimelineStore; sourceId: string; blockId: string; id: string; measureRef: (node: HTMLDivElement | null) => void; hideShare: boolean; isRunning: boolean
}) {
 const subscribe = useCallback((listener: () => void) => store.subscribeRow(sourceId, listener), [store, sourceId])
 const snapshot = useCallback(() => store.getRow(sourceId), [store, sourceId])
 const source = useSyncExternalStore(subscribe, snapshot, snapshot)
 const block = source?.kind === 'history' ? generatedArtifacts(source.block).find((artifact) => artifact.id === blockId) : undefined
 if (!block) return null
 const row: BetaRow = { id, kind: 'history', block }
 return <div ref={measureRef} data-beta-measure-id={id} className="beta-row-slot beta-artifact"><BetaRowView row={row} embedded hideShare={hideShare} isRunning={isRunning} /></div>
})


/** Group ancestry changes do not invalidate an unchanged child tool snapshot. */
export const BetaTurnTool = memo(function BetaTurnTool({ store, sourceId, toolIndex, id, measureRef, hideShare, isRunning }: {
 store: BetaTimelineStore; sourceId: string; toolIndex?: number; id: string; measureRef: (node: HTMLDivElement | null) => void; hideShare: boolean; isRunning: boolean
}) {
 const subscribe = useCallback((listener: () => void) => store.subscribeRow(sourceId, listener), [store, sourceId])
 const snapshot = useMemo(() => createBetaToolSnapshot(store, sourceId, id, toolIndex), [store, sourceId, toolIndex, id])
 const row = useSyncExternalStore(subscribe, snapshot, snapshot)
 if (!row) return null
 return <div id={rowDomId(row)} ref={measureRef} data-beta-measure-id={id} className="beta-row-slot" data-hapi-message-role="assistant">
  <BetaExpansionRow id={id}><BetaRowView row={row} embedded hideShare={hideShare} isRunning={isRunning} /></BetaExpansionRow>
 </div>
})
