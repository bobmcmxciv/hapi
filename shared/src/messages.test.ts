import { describe, expect, test } from 'bun:test'
import { isClaudeChatVisibleMessage } from './messages'

describe('isClaudeChatVisibleMessage', () => {
    test('keeps model refusal fallback system events visible for the web warning toast', () => {
        expect(isClaudeChatVisibleMessage({
            type: 'system',
            subtype: 'model_refusal_fallback'
        })).toBe(true)
    })

    // 长时间运行的工具每 30s 一条心跳,内容对用户毫无意义(工具卡片上已有实时计时器),
    // 但会被当成普通消息渲染成一坨原始 JSON。
    test('hides tool_progress heartbeats', () => {
        expect(isClaudeChatVisibleMessage({ type: 'tool_progress' })).toBe(false)
    })

    test('hides SDK control frames and logs', () => {
        expect(isClaudeChatVisibleMessage({ type: 'control_request' })).toBe(false)
        expect(isClaudeChatVisibleMessage({ type: 'control_response' })).toBe(false)
        expect(isClaudeChatVisibleMessage({ type: 'control_cancel_request' })).toBe(false)
        expect(isClaudeChatVisibleMessage({ type: 'log' })).toBe(false)
    })

    test('still hides rate limit events and keeps ordinary chat messages visible', () => {
        expect(isClaudeChatVisibleMessage({ type: 'rate_limit_event' })).toBe(false)
        expect(isClaudeChatVisibleMessage({ type: 'assistant' })).toBe(true)
        expect(isClaudeChatVisibleMessage({ type: 'user' })).toBe(true)
    })
})
