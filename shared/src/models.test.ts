import { describe, expect, test } from 'bun:test'
import {
    CLAUDE_MODEL_ID_LABELS,
    CLAUDE_MODEL_IDS,
    CLAUDE_MODEL_PRESETS,
    CLAUDE_MODEL_LABELS,
    CLAUDE_PROXY_MODEL_IDS,
    CLAUDE_PROXY_MODEL_LABELS,
    DEFAULT_GEMINI_MODEL,
    GEMINI_MODEL_LABELS,
    GEMINI_MODEL_PRESETS,
    getClaudeModelLabel,
    isClaudeModelPreset,
} from './models'

describe('isClaudeModelPreset', () => {
    test('accepts valid presets', () => {
        for (const preset of CLAUDE_MODEL_PRESETS) {
            expect(isClaudeModelPreset(preset)).toBe(true)
        }
    })

    test('rejects unknown model string', () => {
        expect(isClaudeModelPreset('claude-fable-5')).toBe(false)
    })

    test('rejects null and undefined', () => {
        expect(isClaudeModelPreset(null)).toBe(false)
        expect(isClaudeModelPreset(undefined)).toBe(false)
    })
})

describe('getClaudeModelLabel', () => {
    test('returns label for known presets', () => {
        expect(getClaudeModelLabel('sonnet')).toBe('Sonnet')
        expect(getClaudeModelLabel('opus')).toBe('Opus')
        expect(getClaudeModelLabel('fable')).toBe('Fable')
        expect(getClaudeModelLabel('haiku')).toBe('Haiku')
        expect(getClaudeModelLabel('opus[1m]')).toBe('Opus 1M')
    })

    test('trims whitespace before lookup', () => {
        expect(getClaudeModelLabel('  sonnet  ')).toBe('Sonnet')
    })

    test('returns null for unknown model', () => {
        expect(getClaudeModelLabel('claude-nonexistent-9')).toBeNull()
    })

    test('returns labels for specific model ids', () => {
        expect(getClaudeModelLabel('claude-opus-4-8')).toBe('Opus 4.8')
        expect(getClaudeModelLabel('claude-fable-5')).toBe('Fable 5')
    })

    // 代理别名的 label 故意等于 id 本身：选它的目的就是让界面显示真正在跑的模型。
    test('returns the raw id as the label for proxy-served models', () => {
        expect(getClaudeModelLabel('gpt-5.6-sol')).toBe('gpt-5.6-sol')
        expect(getClaudeModelLabel('gpt-5.6-sol[1m]')).toBe('gpt-5.6-sol[1m]')
    })

    test('returns null for empty/whitespace-only string', () => {
        expect(getClaudeModelLabel('')).toBeNull()
        expect(getClaudeModelLabel('   ')).toBeNull()
    })
})

describe('model constants consistency', () => {
    test('every CLAUDE_MODEL_PRESET has a label', () => {
        for (const preset of CLAUDE_MODEL_PRESETS) {
            expect(CLAUDE_MODEL_LABELS[preset]).toBeDefined()
        }
    })

    test('every GEMINI_MODEL_PRESET has a label', () => {
        for (const preset of GEMINI_MODEL_PRESETS) {
            expect(GEMINI_MODEL_LABELS[preset]).toBeDefined()
        }
    })

    test('every CLAUDE_MODEL_ID has a label and is not a preset', () => {
        for (const id of CLAUDE_MODEL_IDS) {
            expect(CLAUDE_MODEL_ID_LABELS[id]).toBeDefined()
            expect(isClaudeModelPreset(id)).toBe(false)
        }
    })

    test('proxy model ids stay out of the built-in preset namespace', () => {
        for (const id of CLAUDE_PROXY_MODEL_IDS) {
            expect(CLAUDE_PROXY_MODEL_LABELS[id]).toBe(id)
            expect(isClaudeModelPreset(id)).toBe(false)
            expect(CLAUDE_MODEL_IDS).not.toContain(id)
        }
    })

    test('DEFAULT_GEMINI_MODEL is a valid preset', () => {
        expect(GEMINI_MODEL_PRESETS).toContain(DEFAULT_GEMINI_MODEL)
    })
})
