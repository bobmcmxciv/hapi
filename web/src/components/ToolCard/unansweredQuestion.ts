import { useEffect, useState } from 'react'
import type { ChatToolCall } from '@/chat/types'

/**
 * A question tool (AskUserQuestion / request_user_input) only gets answer
 * options in the web when the CLI registers it as a permission request. When
 * the session runs in local (terminal) mode the question is asked in the
 * terminal UI instead, so the card just spins with nothing to click: on
 * 2026-10-10 a session sat like that for hours and looked dead. The remote
 * permission request can lag the tool message by a moment, hence the grace
 * period before calling a running question unanswerable here.
 */
export const UNANSWERED_QUESTION_GRACE_MS = 15_000

export function questionStartedAt(tool: Pick<ChatToolCall, 'startedAt' | 'createdAt'>): number {
    return tool.startedAt ?? tool.createdAt
}

export function isUnanswerableQuestion(
    tool: Pick<ChatToolCall, 'state' | 'permission' | 'startedAt' | 'createdAt'>,
    isQuestionTool: boolean,
    now: number
): boolean {
    if (!isQuestionTool || tool.state !== 'running' || tool.permission) return false
    return now - questionStartedAt(tool) >= UNANSWERED_QUESTION_GRACE_MS
}

/** Re-renders once the grace period has passed so the hint appears without other updates. */
export function useUnanswerableQuestion(
    tool: Pick<ChatToolCall, 'state' | 'permission' | 'startedAt' | 'createdAt'>,
    isQuestionTool: boolean
): boolean {
    const candidate = isQuestionTool && tool.state === 'running' && !tool.permission
    const startedAt = questionStartedAt(tool)
    const [now, setNow] = useState(() => Date.now())

    useEffect(() => {
        if (!candidate) return
        const remaining = startedAt + UNANSWERED_QUESTION_GRACE_MS - Date.now()
        if (remaining <= 0) {
            setNow(Date.now())
            return
        }
        const timer = setTimeout(() => setNow(Date.now()), remaining + 50)
        return () => clearTimeout(timer)
    }, [candidate, startedAt])

    return candidate && isUnanswerableQuestion(tool, isQuestionTool, now)
}
