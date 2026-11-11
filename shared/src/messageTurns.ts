import { unwrapRoleWrappedRecordEnvelope } from './messages'
import type { InputResolution } from './schemas'

export type TurnPosition = { at: number; order?: number; eventOrder?: number; seq: number }

/** Coverage of a user turn, not a claim that the agent has finished executing. */
export type MessageTurnSegment = {
 turnId: string | null
 from: TurnPosition
 to: TurnPosition
 completeBefore: boolean
 completeAfter: boolean
}

export const TURN_PAGE_ROW_LIMIT = 2000
export const DEFAULT_MESSAGE_TURNS = 8

export function compareTurnPosition(a: TurnPosition, b: TurnPosition): number {
 return a.at - b.at || (a.order ?? 0) - (b.order ?? 0) || (a.eventOrder ?? 0) - (b.eventOrder ?? 0) || a.seq - b.seq
}

export function isUserTurnContent(content: unknown): boolean {
 return unwrapRoleWrappedRecordEnvelope(content)?.role === 'user'
}

export function isInvokedUserTurn(message: { content: unknown; invokedAt?: number | null; resolution?: InputResolution }): boolean {
 return !message.resolution && message.invokedAt !== null && isUserTurnContent(message.content)
}

/** Merge coverage only when ranges overlap or the caller proves adjacency.
 * Never combine separated windows into a falsely complete shareable turn. */
export function mergeTurnSegments(
 previous: MessageTurnSegment[],
 incoming: MessageTurnSegment[],
 adjacent = false
): MessageTurnSegment[] {
 const result = previous.slice()
 for (const segment of incoming) {
  const index = result.findIndex((held) => held.turnId === segment.turnId && (
   adjacent || (compareTurnPosition(held.from, segment.to) <= 0
    && compareTurnPosition(segment.from, held.to) <= 0)
  ))
  if (index < 0) {
   result.push(segment)
   continue
  }
  const held = result[index]
  const fromComparison = compareTurnPosition(held.from, segment.from)
  const toComparison = compareTurnPosition(held.to, segment.to)
  result[index] = {
   turnId: held.turnId,
   from: fromComparison <= 0 ? held.from : segment.from,
   to: toComparison >= 0 ? held.to : segment.to,
   completeBefore: fromComparison < 0 ? held.completeBefore
    : fromComparison > 0 ? segment.completeBefore
     : held.completeBefore || segment.completeBefore,
   completeAfter: toComparison > 0 ? held.completeAfter
    : toComparison < 0 ? segment.completeAfter
     : held.completeAfter || segment.completeAfter
  }
 }
 return result.sort((a, b) => compareTurnPosition(a.from, b.from))
}
