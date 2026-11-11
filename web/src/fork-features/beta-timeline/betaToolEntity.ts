import type { BetaTimelineStore, BetaRow } from './store'

/** A canonical tool-group is storage, not a React subscription boundary. */
export function createBetaToolSnapshot(store: Pick<BetaTimelineStore, 'getRow'>, sourceId: string, id: string, toolIndex?: number): () => BetaRow | undefined {
 let previousSource: BetaRow | undefined
 let previousBlock: Extract<BetaRow, { kind: 'history' }>['block'] | undefined
 let value: BetaRow | undefined
 return () => {
  const source = store.getRow(sourceId)
  if (source === previousSource) return value
  previousSource = source
  if (!source) { value = undefined; previousBlock = undefined; return value }
  if (source.kind === 'runtime') { value = { ...source, id }; previousBlock = undefined; return value }
  const block = source.block.kind === 'tool-group' && toolIndex !== undefined ? source.block.tools[toolIndex] : source.block
  if (block === previousBlock) return value
  previousBlock = block
  value = block ? { id, kind: 'history', block } : undefined
  return value
 }
}
