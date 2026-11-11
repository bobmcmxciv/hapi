import type { VisibleChatBlock } from '@/chat/toolGroups'
import type { BetaRow } from './store'

export type BetaCompleteTurnLoader = (turnId: string, signal?: AbortSignal) => Promise<readonly VisibleChatBlock[]>

/** Collect outside the bounded viewport cache; never accept a missing/wrong turn. */
export async function hydrateBetaShareRows(turnId: string, loader: BetaCompleteTurnLoader, signal: AbortSignal): Promise<readonly BetaRow[]> {
 signal.throwIfAborted()
 const blocks = await loader(turnId, signal)
 signal.throwIfAborted()
 const user = blocks.find((block) => block.kind === 'user-text')
 if (!user || user.id !== turnId) throw new Error('beta.timeline.shareIncomplete')
 return blocks.map((block) => ({ id: `share:${block.kind}:${block.id}`, kind: 'history', block }))
}
