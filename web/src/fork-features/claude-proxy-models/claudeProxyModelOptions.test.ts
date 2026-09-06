import { describe, expect, it } from 'vitest'
import {
    buildClaudeProxyModelOptions,
    claudeProxyContextWindows,
    formatClaudeProxyFetchedAt,
    formatClaudeProxyModelLabel
} from './claudeProxyModelOptions'
import type { ClaudeProxyModelSummary } from './types'

function model(overrides: Partial<ClaudeProxyModelSummary> & { id: string }): ClaudeProxyModelSummary {
    return {
        displayName: null,
        contextWindow: null,
        maxContextWindow: null,
        reasoningEfforts: null,
        servedAs: null,
        isDefault: false,
        source: 'catalog',
        ...overrides
    }
}

describe('formatClaudeProxyModelLabel', () => {
    it('shows the raw id, the alias target and the default marker — never a prettified name', () => {
        expect(formatClaudeProxyModelLabel(model({ id: 'gpt-6-astra', displayName: 'GPT-6-Astra', isDefault: true })))
            .toBe('gpt-6-astra · default')
        expect(formatClaudeProxyModelLabel(model({ id: 'gpt-5.6-sol', servedAs: 'gpt-6-astra' })))
            .toBe('gpt-5.6-sol → gpt-6-astra')
        expect(formatClaudeProxyModelLabel(model({ id: 'gpt-5.6-terra' }))).toBe('gpt-5.6-terra')
    })
})

describe('buildClaudeProxyModelOptions', () => {
    it('keeps hub order, dedupes ids and drops blank ids', () => {
        const options = buildClaudeProxyModelOptions([
            model({ id: 'gpt-6-astra', isDefault: true }),
            model({ id: 'gpt-5.6-sol', servedAs: 'gpt-6-astra' }),
            model({ id: 'gpt-5.6-sol' }),
            model({ id: '   ' })
        ])
        expect(options).toEqual([
            { value: 'gpt-6-astra', label: 'gpt-6-astra · default' },
            { value: 'gpt-5.6-sol', label: 'gpt-5.6-sol → gpt-6-astra' }
        ])
    })
})

describe('claudeProxyContextWindows', () => {
    it('maps only entries with a positive contract window (max window is not the default metering)', () => {
        expect(claudeProxyContextWindows([
            model({ id: 'gpt-6-astra', contextWindow: 272_000, maxContextWindow: 872_000 }),
            model({ id: 'gpt-5.4', contextWindow: null, maxContextWindow: 1_000_000 }),
            model({ id: 'bad', contextWindow: 0 })
        ])).toEqual({ 'gpt-6-astra': 272_000 })
    })
})

describe('formatClaudeProxyFetchedAt', () => {
    it('returns null for missing timestamps and a short clock time otherwise', () => {
        expect(formatClaudeProxyFetchedAt(null)).toBeNull()
        expect(formatClaudeProxyFetchedAt(Number.NaN)).toBeNull()
        expect(formatClaudeProxyFetchedAt(Date.UTC(2026, 8, 6, 12, 34), 'en-US')).toMatch(/\d{1,2}:\d{2}/)
    })
})
