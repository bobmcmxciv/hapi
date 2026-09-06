import { describe, expect, it } from 'vitest'
import { getClaudeComposerModelOptions, getNextClaudeComposerModel, isListedClaudeModel, normalizeCustomClaudeModelId } from './claudeModelOptions'

const SPECIFIC_MODEL_IDS = [
    'claude-fable-5-1',
    'claude-fable-5',
    'claude-opus-4-8',
    'claude-opus-4-7',
    'claude-opus-4-6',
    'claude-opus-4-5',
    'claude-sonnet-5',
    'claude-sonnet-4-6',
    'claude-haiku-4-5',
]

const SPECIFIC_MODEL_OPTIONS = [
    { value: 'claude-fable-5-1', label: 'Fable 5.1' },
    { value: 'claude-fable-5', label: 'Fable 5' },
    { value: 'claude-opus-4-8', label: 'Opus 4.8' },
    { value: 'claude-opus-4-7', label: 'Opus 4.7' },
    { value: 'claude-opus-4-6', label: 'Opus 4.6' },
    { value: 'claude-opus-4-5', label: 'Opus 4.5' },
    { value: 'claude-sonnet-5', label: 'Sonnet 5' },
    { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
    { value: 'claude-haiku-4-5', label: 'Haiku 4.5' },
]

const PROXY_MODEL_OPTIONS = [
    { value: 'gpt-5.6-sol', label: 'gpt-5.6-sol' },
    { value: 'gpt-5.4[1m]', label: 'gpt-5.4[1m]' },
]

describe('getClaudeComposerModelOptions', () => {
    it('keeps custom ids out of the listed options because the custom radio owns them', () => {
        expect(getClaudeComposerModelOptions('claude-opus-4-1-20250805')).toEqual([
            { value: null, label: 'Default' },
            { value: 'fable', label: 'Fable' },
            { value: 'fable[1m]', label: 'Fable 1M' },
            { value: 'sonnet', label: 'Sonnet' },
            { value: 'sonnet[1m]', label: 'Sonnet 1M' },
            { value: 'opus', label: 'Opus' },
            { value: 'opus[1m]', label: 'Opus 1M' },
            { value: 'haiku', label: 'Haiku' },
            ...SPECIFIC_MODEL_OPTIONS,
            ...PROXY_MODEL_OPTIONS,
        ])
    })

    it('does not duplicate preset Claude models', () => {
        expect(getClaudeComposerModelOptions('opus')).toEqual([
            { value: null, label: 'Default' },
            { value: 'fable', label: 'Fable' },
            { value: 'fable[1m]', label: 'Fable 1M' },
            { value: 'sonnet', label: 'Sonnet' },
            { value: 'sonnet[1m]', label: 'Sonnet 1M' },
            { value: 'opus', label: 'Opus' },
            { value: 'opus[1m]', label: 'Opus 1M' },
            { value: 'haiku', label: 'Haiku' },
            ...SPECIFIC_MODEL_OPTIONS,
            ...PROXY_MODEL_OPTIONS,
        ])
    })

    it('includes every specific model id once', () => {
        const options = getClaudeComposerModelOptions('vendor-claude-ultra')
        for (const modelId of SPECIFIC_MODEL_IDS) {
            expect(options.filter((option) => option.value === modelId)).toHaveLength(1)
        }
    })
})

describe('isListedClaudeModel', () => {
    it('distinguishes listed presets and ids from provider-defined ids', () => {
        expect(isListedClaudeModel('opus')).toBe(true)
        expect(isListedClaudeModel('claude-opus-4-8')).toBe(true)
        expect(isListedClaudeModel('vendor-claude-ultra')).toBe(false)
        expect(isListedClaudeModel(null)).toBe(false)
    })

    it('counts the proxy-served ids as listed, not custom', () => {
        expect(isListedClaudeModel('gpt-5.6-sol')).toBe(true)
        expect(isListedClaudeModel('gpt-5.4[1m]')).toBe(true)
        // sol[1m] 已从推荐移除（272k 契约上谎报 1M）；存量会话走 custom 分支。
        expect(isListedClaudeModel('gpt-5.6-sol[1m]')).toBe(false)
    })
})

describe('getNextClaudeComposerModel', () => {
    it('cycles from a custom Claude model to Default', () => {
        expect(getNextClaudeComposerModel('claude-opus-4-1-20250805')).toBeNull()
    })

    it('cycles from the last built-in id into the proxy-served ids', () => {
        expect(getNextClaudeComposerModel('claude-haiku-4-5')).toBe('gpt-5.6-sol')
    })

    it('cycles from the final option back to Default', () => {
        expect(getNextClaudeComposerModel('gpt-5.4[1m]')).toBeNull()
    })
})

describe('normalizeCustomClaudeModelId', () => {
    it('passes a provider model id through after trimming surrounding whitespace', () => {
        expect(normalizeCustomClaudeModelId('  vendor-claude-ultra  ')).toBe('vendor-claude-ultra')
    })

    it('rejects an empty custom model id', () => {
        expect(normalizeCustomClaudeModelId('   ')).toBeNull()
    })
})

// fork(claude-proxy-models)：hub 动态目录到达后替换静态代理项。
describe('dynamic proxy catalog (fork claude-proxy-models)', () => {
    const DYNAMIC = [
        { value: 'gpt-6-astra', label: 'gpt-6-astra · default' },
        { value: 'gpt-5.6-sol', label: 'gpt-5.6-sol → gpt-6-astra' }
    ]

    it('replaces the static proxy tail with the dynamic catalog, keeping presets and ids', () => {
        const options = getClaudeComposerModelOptions(null, DYNAMIC)
        expect(options[0]).toEqual({ value: null, label: 'Default' })
        expect(options.some((o) => o.value === 'opus')).toBe(true)
        expect(options.some((o) => o.value === 'claude-fable-5-1')).toBe(true)
        // Retired static proxy id is gone once the catalog is authoritative.
        expect(options.some((o) => o.value === 'gpt-5.4[1m]')).toBe(false)
        expect(options.slice(-2)).toEqual(DYNAMIC)
    })

    it('an empty catalog means "no proxy models", not "fall back to the static list"', () => {
        const options = getClaudeComposerModelOptions(null, [])
        expect(options.some((o) => o.value === 'gpt-5.6-sol')).toBe(false)
        expect(options.some((o) => o.value === 'gpt-5.4[1m]')).toBe(false)
    })

    it('null/undefined catalog keeps the static fallback', () => {
        expect(getClaudeComposerModelOptions(null, null)).toEqual(getClaudeComposerModelOptions(null))
    })

    it('does not double-list a dynamic id that is also a built-in id', () => {
        const options = getClaudeComposerModelOptions(null, [{ value: 'claude-opus-4-8', label: 'x' }])
        expect(options.filter((o) => o.value === 'claude-opus-4-8')).toHaveLength(1)
    })

    it('isListedClaudeModel consults the dynamic catalog instead of the static proxy ids', () => {
        expect(isListedClaudeModel('gpt-6-astra', DYNAMIC)).toBe(true)
        expect(isListedClaudeModel('gpt-5.4[1m]', DYNAMIC)).toBe(false)
        expect(isListedClaudeModel('gpt-5.4[1m]')).toBe(true)
        expect(isListedClaudeModel('opus', DYNAMIC)).toBe(true)
        expect(isListedClaudeModel('vendor-claude-ultra', DYNAMIC)).toBe(false)
    })

    it('cycles through the dynamic catalog entries', () => {
        expect(getNextClaudeComposerModel('gpt-6-astra', DYNAMIC)).toBe('gpt-5.6-sol')
        expect(getNextClaudeComposerModel('gpt-5.6-sol', DYNAMIC)).toBeNull()
    })
})
