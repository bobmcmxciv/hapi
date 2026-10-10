import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { ToolCallBlock } from '@/chat/types'
import { ToolCard } from '@/components/ToolCard/ToolCard'
import { I18nProvider } from '@/lib/i18n-context'
import { isUnanswerableQuestion, UNANSWERED_QUESTION_GRACE_MS } from '@/components/ToolCard/unansweredQuestion'

function questionBlock(startedAt: number, withPermission: boolean): ToolCallBlock {
    return {
        kind: 'tool-call',
        id: 'ask-1',
        localId: null,
        createdAt: startedAt,
        tool: {
            id: 'ask-1',
            name: 'AskUserQuestion',
            state: 'running',
            input: {
                questions: [{
                    question: '本次参赛采用哪种署名和公开提交范围？',
                    header: '参赛授权',
                    options: [{ label: '先制作，审核后公开（推荐）', description: '' }, { label: '授权当前账号正式投稿', description: '' }],
                    multiSelect: false
                }]
            },
            createdAt: startedAt,
            startedAt,
            completedAt: null,
            execStartedAt: null,
            execCompletedAt: null,
            description: null,
            result: undefined,
            ...(withPermission ? { permission: { id: 'ask-1', status: 'pending' as const } } : {})
        },
        children: []
    }
}

function renderQuestion(block: ToolCallBlock) {
    render(
        <I18nProvider>
            <ToolCard
                api={{} as ApiClient}
                sessionId="session-1"
                metadata={null}
                terminalToolDisplayMode="detailed"
                disabled={false}
                onDone={() => {}}
                block={block}
            />
        </I18nProvider>
    )
}

describe('isUnanswerableQuestion', () => {
    const base = { state: 'running' as const, startedAt: 1_000, createdAt: 1_000 }

    it('flags a running question without a permission request after the grace period', () => {
        expect(isUnanswerableQuestion(base, true, 1_000 + UNANSWERED_QUESTION_GRACE_MS)).toBe(true)
        expect(isUnanswerableQuestion(base, true, 1_000 + UNANSWERED_QUESTION_GRACE_MS - 1)).toBe(false)
    })

    it('leaves answerable, finished and non-question tools alone', () => {
        const late = 1_000 + UNANSWERED_QUESTION_GRACE_MS * 10
        expect(isUnanswerableQuestion({ ...base, permission: { id: 'x', status: 'pending' } } as never, true, late)).toBe(false)
        expect(isUnanswerableQuestion({ ...base, state: 'completed' }, true, late)).toBe(false)
        expect(isUnanswerableQuestion(base, false, late)).toBe(false)
    })
})

describe('ToolCard unanswerable question hint', () => {
    afterEach(() => {
        vi.useRealTimers()
    })

    it('tells the user to reply in the composer when a terminal-asked question has been waiting', () => {
        renderQuestion(questionBlock(Date.now() - 4 * 60 * 60 * 1000, false))
        expect(screen.getByTestId('unanswerable-question-hint')).toHaveTextContent('cannot be answered here')
    })

    it('appears only after the grace period for a fresh question', () => {
        vi.useFakeTimers({ shouldAdvanceTime: false })
        renderQuestion(questionBlock(Date.now(), false))
        expect(screen.queryByTestId('unanswerable-question-hint')).toBeNull()

        act(() => {
            vi.advanceTimersByTime(UNANSWERED_QUESTION_GRACE_MS + 100)
        })
        expect(screen.getByTestId('unanswerable-question-hint')).toBeInTheDocument()
    })

    it('does not show the hint when the question can be answered in the web', () => {
        renderQuestion(questionBlock(Date.now() - 4 * 60 * 60 * 1000, true))
        expect(screen.queryByTestId('unanswerable-question-hint')).toBeNull()
    })
})
