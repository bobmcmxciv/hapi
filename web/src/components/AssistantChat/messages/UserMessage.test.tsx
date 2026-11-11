import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'

// vi.mock is hoisted; the state object must exist by then. vi.hoisted runs
// even earlier, and vi is safe to use inside its factory (documented behavior).
const state = vi.hoisted(() => {
    return {
        forkSession: vi.fn(async () => ({ type: 'success' as const, newSessionId: 'new-forked-id' })),
        navigate: vi.fn(async () => undefined),
        setForkedFromText: vi.fn<(sessionId: string, text: string) => void>(),
        isPending: false,
        // `messageId` is the composed threadMessageId assistant-ui hands to
        // consumers; `hubMessageId` is the raw hub-DB id (unprefixed) that
        // reducerTimeline writes into `metadata.custom` and that fork RPC
        // must receive. Real production flow: composed = `user-text:${hubId}`.
        messageId: 'user-text:msg-42' as string,
        hubMessageId: 'msg-42' as string | undefined,
        text: 'source user prompt' as string,
        resolution: undefined as { outcome: 'handled' | 'cancelled'; resolvedAt: number } | undefined,
        status: undefined as 'queued' | 'sending' | 'sent' | 'failed' | undefined,
        invokedAt: undefined as number | null | undefined,
        localId: 'local-msg-42',
        retryMessage: vi.fn(),
        flavor: 'codex' as string | null,
        capabilities: {
            capabilities: {
                codex: { fork: 'at-message', files: 'none' },
                // #60 c3 flipped claude to at-message once
                // --resume-session-at was confirmed. Reflect real cap here so
                // tests exercise the same path production does.
                claude: { fork: 'at-message', files: 'none' },
                cursor: { fork: 'none', files: 'none' }
            }
        } as any
    }
})

vi.mock('@assistant-ui/react', () => ({
    MessagePrimitive: {
        Root: (props: { children?: ReactNode; id?: string; className?: string }) => (
            <div data-testid="msg-root" id={props.id} className={props.className}>
                {props.children}
            </div>
        )
    },
    useAuiState: (selector: (state: unknown) => unknown) =>
        selector({
            message: {
                role: 'user',
                id: state.messageId,
                content: [{ type: 'text', text: state.text }],
                metadata: { custom: { hubMessageId: state.hubMessageId, localId: state.localId, resolution: state.resolution, status: state.status, invokedAt: state.invokedAt } }
            }
        })
}))

vi.mock('@tanstack/react-router', () => ({
    useNavigate: () => state.navigate
}))

vi.mock('@/components/AssistantChat/messages/MessageActions', () => ({
    MessageActions: ({ copyText }: { copyText?: string }) => (
        copyText ? <button type="button" aria-label="Copy">Copy</button> : null
    )
}))
vi.mock('@/hooks/queries/useFlavorCapabilities', () => ({
    useFlavorCapabilities: () => ({ data: state.capabilities }),
    getFlavorForkCapability: (caps: any, flavor: string | null | undefined) => {
        if (!caps || !flavor) return { fork: 'none', files: 'none' }
        return caps.capabilities[flavor] ?? { fork: 'none', files: 'none' }
    }
}))

vi.mock('@/hooks/mutations/useSessionActions', () => ({
    useSessionActions: () => ({
        forkSession: state.forkSession,
        isPending: state.isPending,
        // Stubs unused by the rewind path but kept to satisfy the interface.
        abortSession: vi.fn(),
        archiveSession: vi.fn(),
        reopenSession: vi.fn(),
        switchSession: vi.fn(),
        setPermissionMode: vi.fn(),
        setCollaborationMode: vi.fn(),
        setModel: vi.fn(),
        setResumeWithSessionModel: vi.fn(),
        setModelReasoningEffort: vi.fn(),
        setEffort: vi.fn(),
        setServiceTier: vi.fn(),
        renameSession: vi.fn(),
        deleteSession: vi.fn()
    })
}))

vi.mock('@/components/AssistantChat/context', () => ({
    useHappyChatContext: () => ({
        api: {} as any,
        sessionId: 'sess-src',
        metadata: { flavor: state.flavor },
        terminalToolDisplayMode: 'auto',
        disabled: false,
        onRefresh: () => { },
        onRetryMessage: state.retryMessage,
        hasMoreMessages: false,
        isLoadingMoreMessages: false,
        loadOlderMessagesPreservingScroll: async () => 'terminal-stop'
    })
}))

vi.mock('@/lib/fork-restore', () => ({
    setForkedFromText: state.setForkedFromText
}))

vi.mock('@/hooks/useCopyToClipboard', () => ({
    useCopyToClipboard: () => ({ copied: false, copy: vi.fn() })
}))
vi.mock('@/lib/use-translation', () => ({
    useTranslation: () => ({
        t: (key: string) => (({
            'message.resolution.handled': 'Handled locally · not executed',
            'message.resolution.cancelled': 'Cancelled · not executed',
            'message.waitingForInvocation': 'Waiting for the model',
            'queuedMessages.forceSend.sending': 'Sending…',
            'queuedMessages.forceSend.awaiting': 'Force send requested · waiting for the model',
        } as Record<string, string>)[key] ?? key)
    })
}))

vi.mock('@/components/AssistantChat/messages/MessageAttachments', () => ({
    MessageAttachments: () => null
}))
vi.mock('@/components/LazyRainbowText', () => ({
    LazyRainbowText: ({ text }: { text: string }) => <span>{text}</span>
}))
vi.mock('@/components/CliOutputBlock', () => ({ CliOutputBlock: () => null }))
vi.mock('@/components/icons', () => ({
    CopyIcon: () => null,
    CheckIcon: () => null
}))
vi.mock('@/chat/outline', () => ({
    getConversationMessageAnchorId: (id: string) => `anchor-${id}`
}))
vi.mock('@/components/AssistantChat/messages/MessageMetadata', () => ({
    MessageMetadata: () => null
}))
vi.mock('@/components/AssistantChat/messages/MessageTimestamp', () => ({
    MessageTimestamp: (props: { className?: string }) => (
        <span className={props.className}>ts</span>
    )
}))

// Import SUT after mocks so its module graph picks them up.
import { HappyUserMessage } from './UserMessage'

afterEach(() => {
    cleanup()
    state.forkSession.mockClear()
    state.navigate.mockClear()
    state.setForkedFromText.mockClear()
    state.forkSession.mockImplementation(async () => ({ type: 'success', newSessionId: 'new-forked-id' }))
    state.navigate.mockImplementation(async () => undefined)
    state.isPending = false
    state.messageId = 'user-text:msg-42'
    state.hubMessageId = 'msg-42'
    state.text = 'source user prompt'
    state.flavor = 'codex'
    state.resolution = undefined
    state.status = undefined
    state.invokedAt = undefined
    state.retryMessage.mockClear()
})

describe('HappyUserMessage actions', () => {
    it('renders one copy action for a text message', () => {
        render(<HappyUserMessage />)
        expect(screen.getAllByRole('button', { name: 'Copy' })).toHaveLength(1)
    })

    it('shows an unconsumed authoritative user row without enabling rewind', () => {
        state.invokedAt = null
        render(<HappyUserMessage />)
        expect(screen.getByText('source user prompt')).toBeInTheDocument()
        expect(screen.getByRole('status', { name: 'Queued' })).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: /Rewind to this message/i })).toBeNull()
    })

    it.each(['queued', 'sent', undefined] as const)('keeps %s unconsumed receipts pending, without claiming force-send', (status) => {
        state.status = status
        state.invokedAt = null
        render(<HappyUserMessage />)
        expect(screen.getAllByText('source user prompt')).toHaveLength(1)
        expect(screen.getByRole('status', { name: 'Queued' })).toHaveTextContent('Waiting for the model')
        expect(screen.queryByText(/Force send requested/)).toBeNull()
        expect(screen.queryByRole('button', { name: /Rewind to this message/i })).toBeNull()
    })

    it('transitions a preserved failed bubble through retry, HTTP acceptance and native consumption', () => {
        state.status = 'failed'
        state.invokedAt = null
        const view = render(<HappyUserMessage />)
        fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
        expect(state.retryMessage).toHaveBeenCalledWith('local-msg-42')
        expect(screen.queryByRole('button', { name: /Rewind to this message/i })).toBeNull()

        state.status = 'sending'
        view.rerender(<HappyUserMessage />)
        expect(screen.getByRole('status', { name: 'Sending' })).toHaveTextContent('Sending…')
        expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
        expect(screen.queryByRole('button', { name: /Rewind to this message/i })).toBeNull()

        state.status = 'sent'
        view.rerender(<HappyUserMessage />)
        expect(screen.getByRole('status', { name: 'Queued' })).toHaveTextContent('Waiting for the model')

        state.invokedAt = 1234
        view.rerender(<HappyUserMessage />)
        expect(screen.queryByRole('status')).toBeNull()
        expect(screen.getAllByText('source user prompt')).toHaveLength(1)
        expect(screen.getByRole('button', { name: /Rewind to this message/i })).toBeInTheDocument()
    })

    it.each(['queued', 'sending', 'failed'] as const)('native consumption wins over late %s settlement state', (status) => {
        state.status = status
        state.invokedAt = 1234
        render(<HappyUserMessage />)
        expect(screen.queryByRole('status')).toBeNull()
        expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
        expect(screen.getByRole('button', { name: /Rewind to this message/i })).toBeInTheDocument()
    })

    it.each(['handled', 'cancelled'] as const)('keeps %s prompts visible without queue or rewind actions', (outcome) => {
        state.resolution = { outcome, resolvedAt: 1234 }
        state.status = 'queued'
        render(<HappyUserMessage />)
        expect(screen.getByText('source user prompt')).toBeInTheDocument()
        expect(screen.getByRole('status')).toHaveTextContent(outcome === 'handled' ? 'Handled locally · not executed' : 'Cancelled · not executed')
        expect(screen.queryByRole('button', { name: /Rewind to this message/i })).toBeNull()
        expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument()
    })
})

describe('HappyUserMessage rewind button (#62 c5)', () => {
    it('Codex flavor (at-message) → rewind button renders', () => {
        render(<HappyUserMessage />)
        expect(screen.getByRole('button', { name: /Rewind to this message/i })).toBeInTheDocument()
    })

    it('Claude flavor (at-message via --resume-session-at) → rewind button renders', () => {
        state.flavor = 'claude'
        render(<HappyUserMessage />)
        expect(screen.getByRole('button', { name: /Rewind to this message/i })).toBeInTheDocument()
    })

    it('Cursor flavor (none) → NO rewind button', () => {
        state.flavor = 'cursor'
        render(<HappyUserMessage />)
        expect(screen.queryByRole('button', { name: /Rewind to this message/i })).toBeNull()
    })

    it('Unknown flavor falls back to none → NO rewind button', () => {
        state.flavor = 'never-heard-of-it'
        render(<HappyUserMessage />)
        expect(screen.queryByRole('button', { name: /Rewind to this message/i })).toBeNull()
    })

    it('Missing hubMessageId in metadata (older stored messages) → NO rewind button (cannot fork without hub id)', () => {
        // Guards the c9 regression: dropping the metadata.custom.hubMessageId
        // path would silently regress to passing the composed threadMessageId
        // to hub and getting "fork point not found" 400s.
        state.hubMessageId = undefined
        render(<HappyUserMessage />)
        expect(screen.queryByRole('button', { name: /Rewind to this message/i })).toBeNull()
    })

    it('Click calls forkSession with RAW hub messageId (not composed threadMessageId)', async () => {
        render(<HappyUserMessage />)
        fireEvent.click(screen.getByRole('button', { name: /Rewind to this message/i }))
        await waitFor(() =>
            // Must be 'msg-42', NOT 'user-text:msg-42'. Hub's fork endpoint
            // matches raw hub-DB ids; composed id would 400.
            expect(state.forkSession).toHaveBeenCalledWith({ forkPoint: { messageId: 'msg-42' } })
        )
        await waitFor(() =>
            expect(state.setForkedFromText).toHaveBeenCalledWith('new-forked-id', 'source user prompt')
        )
        await waitFor(() =>
            expect(state.navigate).toHaveBeenCalledWith({
                to: '/sessions/$sessionId',
                params: { sessionId: 'new-forked-id' }
            })
        )
    })

    it('Does not stash forked-from text when source message text is empty', async () => {
        state.text = ''
        render(<HappyUserMessage />)
        // With empty text UserMessage still renders trailing row but bubble is
        // hidden; the rewind button is capability-gated on flavor, not text.
        // If click still fires, setForkedFromText should be skipped.
        const btn = screen.queryByRole('button', { name: /Rewind to this message/i })
        if (btn) {
            fireEvent.click(btn)
            await waitFor(() => expect(state.forkSession).toHaveBeenCalled())
            expect(state.setForkedFromText).not.toHaveBeenCalled()
        }
    })

    it('stays on the source session when the server reports that fork is blocked', async () => {
        state.forkSession.mockResolvedValueOnce({ type: 'blocked' } as any)
        render(<HappyUserMessage />)

        fireEvent.click(screen.getByRole('button', { name: /Rewind to this message/i }))

        await waitFor(() => expect(state.forkSession).toHaveBeenCalled())
        expect(state.navigate).not.toHaveBeenCalled()
        expect(state.setForkedFromText).not.toHaveBeenCalled()
        expect(screen.queryByRole('alert')).toBeNull()
    })

    it('When aggregated isPending is true → button is disabled', () => {
        state.isPending = true
        render(<HappyUserMessage />)
        expect(
            screen.getByRole('button', { name: /Rewind to this message/i })
        ).toBeDisabled()
    })
})
