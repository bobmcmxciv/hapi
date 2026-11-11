import type { Database } from 'bun:sqlite'
import type { InputResolution } from '@hapi/protocol/types'

import type { StoredMessage } from './types'
import { initializeMessageResolutions, resolveMessages } from './messageResolutions'
import { initializeMessageOrdering, type NativeMessageOrder, type NativeDelivery } from './messageOrdering'
import {
    initializeMessageTurnIndex,
    prepareMessageTurnIndex,
    requireMessageTurnIndex,
    getTurnStartsBefore,
    getSelectedTurnBounds,
    getTurnHistoryRows
} from './messageTurnQueries'
import {
    addMessage,
    addImportedMessage,
    cancelQueuedMessage,
    deleteQueuedMessageById,
    lookupQueuedMessage,
    getMessages,
    getFirstMessages,
    getDeliverableMessagesAfter,
    getMessagesByPosition,
    getMessagesAfterPosition,
    getNewestMessagePosition,
    getMessageEpoch,
    bumpMessageEpoch,
    getLocalMessageStates,
    getUninvokedLocalMessages,
    getMatureScheduledMessages,
    getImmediateQueuedLocalMessages,
    getLocalMessagesByLocalIds,
    markForceSendRequested,
    countFutureScheduledBySessionIds,
    countFutureScheduledLocalMessages,
    minFutureScheduledAtBySessionIds,
    countMessages,
    markMessagesInvoked,
    markUninvokedImmediateMessages,
    mergeSessionMessages,
    moveUninvokedScheduledMessages,
    moveUninvokedMessages,
    copyMessageToSession as copyStoredMessageToSession,
    copyMessagesToSession as copyStoredMessagesToSession,
    getAllMessages,
    getMessagesAfterSeq,
    truncateMessagesFromLocalId,
    type CancelQueuedMessageResult,
    type LookupQueuedMessageResult,
    type LocalMessageState,
    type MessagePosition,
} from './messages'
import {
    aggregateUsageBuckets,
    aggregateUsageForSessions,
    aggregateUsageGroups,
    startUsageEventCacheWarmup,
    whenUsageEventCacheWarm,
    type UsageAggregateRow,
} from '../../../fork-features/usage/usageAggregate'

export class MessageStore {
    private readonly db: Database

    constructor(db: Database) {
        this.db = db
        initializeMessageOrdering(db)
        initializeMessageResolutions(db)
        initializeMessageTurnIndex(db)
    }

    prepareTurnIndex(sessionId: string): Promise<void> {
        return prepareMessageTurnIndex(this.db, sessionId)
    }

    requireTurnIndex(sessionId: string): void {
        requireMessageTurnIndex(this.db, sessionId)
    }

    getTurnStartsBefore(sessionId: string, before: MessagePosition, limit: number, inclusive = false) {
        return getTurnStartsBefore(this.db, sessionId, before, limit, inclusive)
    }

    getSelectedTurnBounds(sessionId: string, turnId: string) {
        return getSelectedTurnBounds(this.db, sessionId, turnId)
    }

    getTurnHistoryRows(sessionId: string, options: {
        before?: MessagePosition | null
        after?: MessagePosition | null
        from?: MessagePosition | null
        until?: MessagePosition | null
        limit: number
        descending: boolean
    }): StoredMessage[] {
        return getTurnHistoryRows(this.db, sessionId, options)
    }

    // fork-features/usage: token 用量统计的唯一存储接缝。SQL 与口径都在
    // fork-features/usage/usageAggregate.ts，这里只暴露私有 db 句柄。
    aggregateUsageForSessions(
        sessionIds: string[],
        opts?: { sinceIso?: string | null; untilIso?: string | null }
    ): UsageAggregateRow[] {
        return aggregateUsageForSessions(this.db, sessionIds, opts)
    }

    // 同一时间窗多组会话 / 整段 + 多个时间桶，一趟扫描算完（结果与逐个调用相同）。
    aggregateUsageGroups(
        sessionIds: string[],
        window: { sinceIso?: string | null; untilIso?: string | null },
        groups: string[][]
    ): UsageAggregateRow[][] {
        return aggregateUsageGroups(this.db, sessionIds, window, groups)
    }

    aggregateUsageBuckets(
        sessionIds: string[],
        total: { sinceIso?: string | null; untilIso?: string | null },
        buckets: Array<{ sinceIso: string; untilIso: string }>
    ): { total: UsageAggregateRow[]; buckets: UsageAggregateRow[][] } {
        return aggregateUsageBuckets(this.db, sessionIds, total, buckets)
    }

    /** hub 启动后在后台分段预热用量事件缓存。 */
    warmUsageCache(options?: { shouldStop?: () => boolean }): Promise<{ sessions: number; rows: number }> {
        return startUsageEventCacheWarmup(this.db, options)
    }

    /** 用量缓存预热完成（没开始就开始）时为 true；等满 maxWaitMs 仍未完成为 false。 */
    whenUsageCacheWarm(maxWaitMs?: number): Promise<boolean> {
        return whenUsageEventCacheWarm(this.db, maxWaitMs)
    }

    addMessage(sessionId: string, content: unknown, localId?: string, scheduledAt?: number | null, createdAt?: number, nativeOrder?: NativeMessageOrder): StoredMessage {
        return addMessage(this.db, sessionId, content, localId, scheduledAt, createdAt, nativeOrder)
    }

    addImportedMessage(sessionId: string, content: unknown, localId: string, createdAt: number): { message: StoredMessage; inserted: boolean } {
        return addImportedMessage(this.db, sessionId, content, localId, createdAt)
    }

    copyMessageToSession(
        sessionId: string,
        message: Pick<StoredMessage, 'content' | 'createdAt' | 'localId' | 'invokedAt' | 'scheduledAt' | 'resolution' | 'position'>
    ): StoredMessage {
        // 中文注释：重复会话合并时需要保留源消息的时间戳和排队信息，因此走专门的复制入口而不是普通 addMessage。
        return copyStoredMessageToSession(this.db, sessionId, message)
    }

    copyMessagesToSession(
        sessionId: string,
        messages: Array<Pick<StoredMessage, 'content' | 'createdAt' | 'localId' | 'invokedAt' | 'scheduledAt' | 'resolution' | 'position'>>
    ): number {
        return copyStoredMessagesToSession(this.db, sessionId, messages)
    }

    getAllMessages(sessionId: string): StoredMessage[] {
        return getAllMessages(this.db, sessionId)
    }

    getMessagesAfterSeq(sessionId: string, afterSeq: number): StoredMessage[] {
        return getMessagesAfterSeq(this.db, sessionId, afterSeq)
    }

    getMessages(sessionId: string, limit: number = 200): StoredMessage[] {
        return getMessages(this.db, sessionId, limit)
    }

    getFirstMessages(sessionId: string, limit: number = 50): StoredMessage[] {
        return getFirstMessages(this.db, sessionId, limit)
    }

    getDeliverableMessagesAfter(sessionId: string, afterSeq: number, now: number, limit: number = 200): StoredMessage[] {
        return getDeliverableMessagesAfter(this.db, sessionId, afterSeq, now, limit)
    }

    getMessagesByPosition(sessionId: string, limit: number, before?: MessagePosition, legacyPosition = false): StoredMessage[] {
        return getMessagesByPosition(this.db, sessionId, limit, before, legacyPosition)
    }

    getMessagesAfterPosition(
        sessionId: string,
        limit: number,
        after: MessagePosition,
        until?: MessagePosition,
        legacyPosition = false
    ): StoredMessage[] {
        return getMessagesAfterPosition(this.db, sessionId, limit, after, until, legacyPosition)
    }

    getNewestMessagePosition(sessionId: string, legacyPosition = false): MessagePosition | null {
        return getNewestMessagePosition(this.db, sessionId, legacyPosition)
    }

    getMessageEpoch(sessionId: string): number {
        return getMessageEpoch(this.db, sessionId)
    }

    bumpMessageEpoch(sessionId: string): number {
        return bumpMessageEpoch(this.db, sessionId)
    }

    getLocalMessageStates(sessionId: string, localIds: string[]): LocalMessageState[] {
        return getLocalMessageStates(this.db, sessionId, localIds)
    }

    getUninvokedLocalMessages(sessionId: string): StoredMessage[] {
        return getUninvokedLocalMessages(this.db, sessionId)
    }

    getMatureScheduledMessages(beforeTime: number): StoredMessage[] {
        return getMatureScheduledMessages(this.db, beforeTime)
    }

    getImmediateQueuedLocalMessages(sessionId: string): StoredMessage[] {
        return getImmediateQueuedLocalMessages(this.db, sessionId)
    }

    getLocalMessagesByLocalIds(sessionId: string, localIds: string[]): StoredMessage[] {
        return getLocalMessagesByLocalIds(this.db, sessionId, localIds)
    }

    markForceSendRequested(sessionId: string, localIds: string[], requestedAt: number): StoredMessage[] {
        return markForceSendRequested(this.db, sessionId, localIds, requestedAt)
    }

    countFutureScheduledLocalMessages(sessionId: string, now: number = Date.now()): number {
        return countFutureScheduledLocalMessages(this.db, sessionId, now)
    }

    countFutureScheduledBySessionIds(sessionIds: string[], now: number = Date.now()): Map<string, number> {
        return countFutureScheduledBySessionIds(this.db, sessionIds, now)
    }

    minFutureScheduledAtBySessionIds(sessionIds: string[], now: number = Date.now()): Map<string, number> {
        return minFutureScheduledAtBySessionIds(this.db, sessionIds, now)
    }

    countMessages(sessionId: string): number {
        return countMessages(this.db, sessionId)
    }

    cancelQueuedMessage(sessionId: string, messageId: string): CancelQueuedMessageResult {
        return cancelQueuedMessage(this.db, sessionId, messageId)
    }

    lookupQueuedMessage(sessionId: string, messageId: string): LookupQueuedMessageResult {
        return lookupQueuedMessage(this.db, sessionId, messageId)
    }

    deleteQueuedMessageById(sessionId: string, messageId: string): boolean {
        return deleteQueuedMessageById(this.db, sessionId, messageId)
    }

    markMessagesInvoked(sessionId: string, localIds: string[], invokedAt: number, nativeDelivery?: NativeDelivery): number {
        return markMessagesInvoked(this.db, sessionId, localIds, invokedAt, nativeDelivery)
    }

    resolveMessages(sessionId: string, resolutions: Array<{ localId: string; outcome: InputResolution['outcome']; nativeOrder?: NativeMessageOrder }>, resolvedAt: number) {
        return resolveMessages(this.db, sessionId, resolutions, resolvedAt)
    }

    markUninvokedImmediateMessages(sessionId: string, invokedAt: number): string[] {
        return markUninvokedImmediateMessages(this.db, sessionId, invokedAt)
    }

    moveUninvokedScheduledMessages(fromSessionId: string, toSessionId: string): number {
        return moveUninvokedScheduledMessages(this.db, fromSessionId, toSessionId)
    }

    moveUninvokedMessages(fromSessionId: string, toSessionId: string): number {
        return moveUninvokedMessages(this.db, fromSessionId, toSessionId)
    }

    mergeSessionMessages(fromSessionId: string, toSessionId: string): { moved: number; oldMaxSeq: number; newMaxSeq: number } {
        return mergeSessionMessages(this.db, fromSessionId, toSessionId)
    }

    truncateMessagesFromLocalId(
        sessionId: string,
        localId: string,
        replacement: Array<{
            content: unknown
            localId?: string | null
            createdAt?: number
            invokedAt?: number | null
            resolution?: InputResolution
        }> = []
    ): { deleted: number; inserted: number; epoch: number } {
        return truncateMessagesFromLocalId(this.db, sessionId, localId, replacement)
    }
}
