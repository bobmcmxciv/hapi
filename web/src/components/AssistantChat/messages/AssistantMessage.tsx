import { MessagePrimitive, useAuiState, type TextMessagePart } from '@assistant-ui/react'
import { MarkdownText } from '@/components/assistant-ui/markdown-text'
import { Reasoning, ReasoningGroup } from '@/components/assistant-ui/reasoning'
import { HappyToolMessage } from '@/components/AssistantChat/messages/ToolMessage'
import { CliOutputBlock } from '@/components/CliOutputBlock'
import type { HappyChatMessageMetadata } from '@/lib/assistant-runtime'
import { getAssistantCopyText } from '@/components/AssistantChat/messages/assistantCopyText'
import { getConversationMessageAnchorId } from '@/chat/outline'
import { CodexReviewCard } from '@/components/AssistantChat/messages/CodexReviewCard'
import { MessageActions } from '@/components/AssistantChat/messages/MessageActions'
import { useHappyChatContext } from '@/components/AssistantChat/context'
import { SpeakSummaryButton } from '@/components/AssistantChat/messages/SpeakSummaryButton'

const TOOL_COMPONENTS = {
    Fallback: HappyToolMessage
} as const

const MESSAGE_PART_COMPONENTS = {
    Text: MarkdownText,
    Reasoning: Reasoning,
    ReasoningGroup: ReasoningGroup,
    tools: TOOL_COMPONENTS
} as const

export function HappyAssistantMessage() {
    const ctx = useHappyChatContext()
    const messageId = useAuiState((s) => s.message.id)
    const elementId = getConversationMessageAnchorId(messageId)
    const isCliOutput = useAuiState((s) => {
        const custom = s.message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined
        return custom?.kind === 'cli-output'
    })
    const codexReview = useAuiState((s) => {
        const custom = s.message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined
        return custom?.kind === 'codex-review' ? custom.review : undefined
    })
    const cliText = useAuiState((s) => {
        const custom = s.message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined
        if (custom?.kind !== 'cli-output') return ''
        return s.message.content.find((part): part is TextMessagePart => part.type === 'text')?.text ?? ''
    })
    const toolOnly = useAuiState((s) => {
        if (s.message.role !== 'assistant') return false
        const parts = s.message.content
        return parts.length > 0 && parts.every((part) => part.type === 'tool-call')
    })
    const copyText = useAuiState((s) => {
        if (s.message.role !== 'assistant') return ''
        return getAssistantCopyText(s.message.content)
    })

    const durationMs = useAuiState(({ message }) => (message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined)?.durationMs)
    const usage = useAuiState(({ message }) => (message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined)?.usage)
    const messageModel = useAuiState(({ message }) => (message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined)?.model)
    const turnCount = useAuiState(({ message }) => (message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined)?.turnCount)

    const metadata = { durationMs, usage, model: messageModel ?? null, turnCount }

    const history = ctx.metadata?.capabilities?.conversationHistory
    const showForkCurrent = Boolean(
        history?.forkCurrent
        && ctx.isLatestCompletedBoundary?.(messageId)
        && !ctx.disabled
        && ctx.onForkConversation
    )

    // 裁剪必须用 overflow-x-clip，不能用 overflow-x-hidden：hidden 会让 overflow-y
    // 计算成 auto，把本消息根变成滚动容器，reasoning 折叠手柄的 `sticky top-0` 就会
    // 吸在这个矮盒子上、而不是聊天视口，长推理滚动时按钮跟着划走（回归于 afe0e8b8）。
    // clip 同样裁掉横向溢出但不建立滚动上下文，与 User/Tool 消息层一致。
    const rootClass = toolOnly
        ? 'py-1 min-w-0 max-w-full overflow-x-clip'
        : 'px-1 min-w-0 max-w-full overflow-x-clip'

    return (
        <MessagePrimitive.Root
            id={elementId}
            data-hapi-message-role="assistant"
            className={`happy-message ${rootClass} scroll-mt-4`}
        >
            {isCliOutput
                ? <CliOutputBlock text={cliText} />
                : codexReview
                    ? <CodexReviewCard review={codexReview} />
                    : <MessagePrimitive.Content components={MESSAGE_PART_COMPONENTS} />}
<div className="flex items-center gap-1">
                <MessageActions
                    align="start"
                    copyText={copyText || undefined}
                    metadata={metadata}
                    messageElementId={elementId}
                    showFork={showForkCurrent}
                    historyActionPending={ctx.historyActionPending}
                    onFork={showForkCurrent ? () => ctx.onForkConversation!() : undefined}
                />
                {!isCliOutput && !codexReview && copyText ? (
                    <SpeakSummaryButton messageId={messageId} text={copyText} />
                ) : null}
            </div>
        </MessagePrimitive.Root>
    )
}
