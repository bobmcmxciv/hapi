import { isObject } from './utils'

type RoleWrappedRecord = {
    role: string
    content: unknown
    meta?: unknown
}

const VISIBLE_CLAUDE_SYSTEM_SUBTYPES = new Set([
    'api_error',
    'turn_duration',
    'microcompact_boundary',
    'compact_boundary',
    'model_refusal_fallback'
])

// Claude 消息流里混着一批「非会话内容」的类型：心跳与控制帧，不承载任何用户可读
// 的对话内容。tool_progress 就是长时间运行的工具每 30s 发一次的心跳（heartbeat /
// elapsed_time_seconds），它想说的「这个工具跑了多久」工具卡片上的计时器已经在实时
// 显示了。这类消息一旦当成普通消息渲染，只能退化成一大坨原始 JSON 糊在会话流里，
// 所以统一在这里判成不可见：CLI 不上报、hub 不导出、web 不渲染（历史会话里已经存下
// 来的也会被跳过）。
const NON_CHAT_CLAUDE_MESSAGE_TYPES = new Set([
    'rate_limit_event',
    'tool_progress',
    'control_request',
    'control_response',
    'control_cancel_request',
    'log'
])

export function isNonChatClaudeMessageType(type: unknown): boolean {
    return typeof type === 'string' && NON_CHAT_CLAUDE_MESSAGE_TYPES.has(type)
}

export function isRoleWrappedRecord(value: unknown): value is RoleWrappedRecord {
    if (!isObject(value)) return false
    return typeof value.role === 'string' && 'content' in value
}

export function unwrapRoleWrappedRecordEnvelope(value: unknown): RoleWrappedRecord | null {
    if (isRoleWrappedRecord(value)) return value
    if (!isObject(value)) return null

    const direct = value.message
    if (isRoleWrappedRecord(direct)) return direct

    const data = value.data
    if (isObject(data) && isRoleWrappedRecord(data.message)) return data.message as RoleWrappedRecord

    const payload = value.payload
    if (isObject(payload) && isRoleWrappedRecord(payload.message)) return payload.message as RoleWrappedRecord

    return null
}

export function isClaudeChatVisibleSystemSubtype(subtype: unknown): subtype is string {
    return typeof subtype === 'string' && VISIBLE_CLAUDE_SYSTEM_SUBTYPES.has(subtype)
}

export function isClaudeChatVisibleMessage(message: { type: unknown; subtype?: unknown }): boolean {
    if (isNonChatClaudeMessageType(message.type)) {
        return false
    }

    if (message.type !== 'system') {
        return true
    }

    return isClaudeChatVisibleSystemSubtype(message.subtype)
}

export function isRedundantGoalStatusMessageText(value: unknown): boolean {
    if (typeof value !== 'string') return false
    const message = value.trim()
    return message === 'Goal cleared'
        || /^Goal (active|paused|complete|limited by budget)(?:$|\s+·\s+)/.test(message)
}

export function isRedundantGoalStatusEventContent(value: unknown): boolean {
    const record = unwrapRoleWrappedRecordEnvelope(value)
    if (record?.role !== 'agent') return false

    const eventContent = record.content
    if (!isObject(eventContent) || eventContent.type !== 'event') return false

    const data = isObject(eventContent.data) ? eventContent.data : null
    if (!data || data.type !== 'message') return false

    return isRedundantGoalStatusMessageText(data.message)
}

export type { RoleWrappedRecord }
