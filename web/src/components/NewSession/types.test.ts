import { CLAUDE_MODEL_IDS, CLAUDE_MODEL_PRESETS, CLAUDE_PROXY_MODEL_IDS, getClaudeModelLabel } from '@hapi/protocol'
import { describe, expect, it } from 'vitest'
import { CLAUDE_EFFORT_OPTIONS, GROK_EFFORT_OPTIONS, MODEL_OPTIONS } from './types'

describe('Claude model options', () => {
    it('derives options from shared Claude model presets and specific ids', () => {
        expect(MODEL_OPTIONS.claude).toEqual([
            { value: 'auto', label: 'Default' },
            ...[...CLAUDE_MODEL_PRESETS, ...CLAUDE_MODEL_IDS, ...CLAUDE_PROXY_MODEL_IDS].map((model) => ({
                value: model,
                label: getClaudeModelLabel(model) ?? model
            }))
        ])
    })

    // 这几台机器（DESKTOP-HT3P09U / FA608_INDEX / TXFA608INDEX / DESKTOP-4SQALMG）
    // 的 Claude Code 指向 cx2cc，实际跑的是 gpt-5.6-sol。以前只能挑 sonnet[1m]
    // 之类的占位名，界面上显示的就是占位名；现在能直接选到真名和它的 1M 变体。
    it('offers the proxy-served ids after the built-in Claude models', () => {
        expect(MODEL_OPTIONS.claude.slice(-2)).toEqual([
            { value: 'gpt-5.6-sol', label: 'gpt-5.6-sol' },
            { value: 'gpt-5.6-sol[1m]', label: 'gpt-5.6-sol[1m]' },
        ])
    })

    it('exposes friendly labels for Claude model presets', () => {
        expect(CLAUDE_MODEL_PRESETS).toEqual(['fable', 'fable[1m]', 'sonnet', 'sonnet[1m]', 'opus', 'opus[1m]', 'haiku'])
        expect(getClaudeModelLabel('fable')).toBe('Fable')
        expect(getClaudeModelLabel('sonnet[1m]')).toBe('Sonnet 1M')
        expect(getClaudeModelLabel('opus[1m]')).toBe('Opus 1M')
        expect(getClaudeModelLabel('fable[1m]')).toBe('Fable 1M')
        expect(getClaudeModelLabel('haiku')).toBe('Haiku')
    })
})

describe('Claude effort options', () => {
    it('matches supported effort presets in expected order', () => {
        expect(CLAUDE_EFFORT_OPTIONS).toEqual([
            { value: 'auto', label: 'Auto' },
            { value: 'low', label: 'Low' },
            { value: 'medium', label: 'Medium' },
            { value: 'high', label: 'High' },
            { value: 'xhigh', label: 'XHigh' },
            { value: 'max', label: 'Max' },
        ])
    })
})

describe('Grok effort options', () => {
    it('offers only the effort levels supported by grok-4.5', () => {
        expect(GROK_EFFORT_OPTIONS).toEqual([
            { value: 'auto', label: 'Default' },
            { value: 'low', label: 'Low' },
            { value: 'medium', label: 'Medium' },
            { value: 'high', label: 'High' },
        ])
    })
})
