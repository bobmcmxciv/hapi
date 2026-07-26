import { MessagePrimitive, useAuiState } from '@assistant-ui/react'
import { getEventPresentation } from '@/chat/presentation'
import type { HappyChatMessageMetadata } from '@/lib/assistant-runtime'
import { getConversationMessageAnchorId } from '@/chat/outline'
import { EventNotice } from '@/components/AssistantChat/messages/EventNotice'
import { MessageTimestamp } from '@/components/AssistantChat/messages/MessageTimestamp'

export function HappySystemMessage() {
    const role = useAuiState((s) => s.message.role)
    const messageId = useAuiState((s) => s.message.id)
    const text = useAuiState((s) => {
        if (s.message.role !== 'system') return ''
        return s.message.content[0]?.type === 'text' ? s.message.content[0].text : ''
    })
    // icon / details 都来自事件本身，文本仍取 message.content（和 runtime 的
    // renderEventLabel 保持一致）。这里逐个选出标量而不是整个 presentation 对象：
    // selector 每次返回新对象会让快照永远"变了"，触发无谓重渲染。
    // （原实现用的 useAssistantState 在 0.14 后段已改名 useAuiState。）
    const icon = useAuiState((s) => {
        if (s.message.role !== 'system') return null
        const custom = s.message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined
        const event = custom?.kind === 'event' ? custom.event : undefined
        return event ? getEventPresentation(event).icon : null
    })
    const details = useAuiState((s) => {
        if (s.message.role !== 'system') return null
        const custom = s.message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined
        const event = custom?.kind === 'event' ? custom.event : undefined
        return (event ? getEventPresentation(event).details : null) ?? null
    })

    if (role !== 'system') return null

    return (
        <MessagePrimitive.Root id={getConversationMessageAnchorId(messageId)} className="scroll-mt-4 py-1">
            <EventNotice
                icon={icon}
                text={text}
                details={details}
                trailing={<MessageTimestamp className="text-[10px]" />}
            />
        </MessagePrimitive.Root>
    )
}
