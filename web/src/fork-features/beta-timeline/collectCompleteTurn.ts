import type { ApiClient } from '@/api/client'
import type { DecryptedMessage } from '@/types/api'
import { compareTurnPosition, TURN_PAGE_ROW_LIMIT, type TurnPosition } from '@hapi/protocol/messageTurns'
import { SESSION_EXPORT_MESSAGE_LIMIT } from '@hapi/protocol/sessionExport'

export class TurnCollectionError extends Error {
    constructor(readonly reason: 'unsupported' | 'changed' | 'incomplete' | 'too-large') {
        super(reason)
        this.name = 'TurnCollectionError'
    }
}

/** On-demand fenced export; never changes the bounded scrolling message window. */
export async function collectCompleteTurn(
    api: Pick<ApiClient, 'getMessages'>,
    sessionId: string,
    turnId: string,
    signal?: AbortSignal,
): Promise<DecryptedMessage[]> {
    let messages: DecryptedMessage[] = []
    const ids = new Set<string>()
    let after: TurnPosition | undefined
    let head: TurnPosition | undefined
    let epoch: number | undefined
    let resets = 0
    let pages = 0
    const maximumPages = Math.ceil(SESSION_EXPORT_MESSAGE_LIMIT / TURN_PAGE_ROW_LIMIT) + 1
    while (true) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
        if (++pages > maximumPages) throw new TurnCollectionError('too-large')
        const response = await api.getMessages(sessionId, {
            turnId,
            ...(after ? {
                afterAt: after.at,
                afterSeq: after.seq,
                ...(after.order ? { afterOrder: after.order } : {}),
                ...(after.eventOrder ? { afterEventOrder: after.eventOrder } : {}),
            } : {}),
            ...(head ? {
                untilAt: head.at,
                untilSeq: head.seq,
                ...(head.order ? { untilOrder: head.order } : {}),
                ...(head.eventOrder ? { untilEventOrder: head.eventOrder } : {}),
            } : {}),
            ...(epoch !== undefined ? { epoch } : {}),
            signal,
        })
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
        const page = response.page
        if (!page.turns || typeof page.hasMoreAfter !== 'boolean') throw new TurnCollectionError('unsupported')
        if (page.reset) {
            if (++resets > 2) throw new TurnCollectionError('changed')
            messages = []
            ids.clear()
            after = undefined
            head = undefined
            epoch = undefined
            pages = 1
        }
        if (page.turns.segments.some(segment => segment.turnId !== turnId)) throw new TurnCollectionError('incomplete')
        if (!head) {
            if (response.messages[0]?.id !== turnId || page.turns.segments[0]?.completeBefore !== true) {
                throw new TurnCollectionError('incomplete')
            }
            if (page.snapshotHeadAt === null || page.snapshotHeadSeq === null) throw new TurnCollectionError('incomplete')
            head = {
                at: page.snapshotHeadAt,
                order: page.snapshotHeadOrder ?? 0,
                eventOrder: page.snapshotHeadEventOrder ?? 0,
                seq: page.snapshotHeadSeq,
            }
            epoch = page.epoch
        } else if (
            page.epoch !== epoch
            || page.snapshotHeadAt !== head.at
            || (page.snapshotHeadOrder ?? 0) !== (head.order ?? 0)
            || (page.snapshotHeadEventOrder ?? 0) !== (head.eventOrder ?? 0)
            || page.snapshotHeadSeq !== head.seq
        ) {
            throw new TurnCollectionError('changed')
        }
        for (const message of response.messages) {
            if (ids.has(message.id)) throw new TurnCollectionError('incomplete')
            ids.add(message.id)
            messages.push(message)
        }
        if (messages.length > SESSION_EXPORT_MESSAGE_LIMIT) throw new TurnCollectionError('too-large')
        if (!page.hasMoreAfter) {
            const last = page.turns.segments.at(-1)
            if (last && !last.completeAfter) throw new TurnCollectionError('incomplete')
            return messages
        }
        if (page.nextAfterAt === null || page.nextAfterSeq === null) throw new TurnCollectionError('incomplete')
        const next: TurnPosition = {
            at: page.nextAfterAt,
            order: page.nextAfterOrder ?? 0,
            eventOrder: page.nextAfterEventOrder ?? 0,
            seq: page.nextAfterSeq,
        }
        if ((after && compareTurnPosition(next, after) <= 0) || compareTurnPosition(next, head) >= 0) {
            throw new TurnCollectionError('incomplete')
        }
        after = next
    }
}
