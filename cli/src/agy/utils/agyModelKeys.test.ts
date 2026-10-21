import { describe, expect, it } from 'vitest'
import { buildAgyModelNavigationKeys, buildAgyModelPickerTarget, findAgyCurrentModelRow } from './agyModelKeys'

describe('buildAgyModelPickerTarget', () => {
    it.each([
        ['gemini-4-argon-high', 0, 2, 'Gemini 4 Argon (High)'],
        ['gemini-3.8-flash-low', 1, 0, 'Gemini 3.8 Flash (Low)'],
        ['claude-opus-5-5-high', 2, 2, 'Claude Opus 5.5 (High)'],
        ['claude-sonnet-5-5-medium', 3, 1, 'Claude Sonnet 5.5 (Medium)'],
        ['gpt-oss-120b-medium', 4, null, 'GPT-OSS 120B (Medium)'],
    ] as const)('maps %s to the verified AGY 1.4.2 picker row', (modelId, row, effort, label) => {
        expect(buildAgyModelPickerTarget(modelId)).toEqual({ row, effort, label })
    })

    it('rejects null and unknown future picker rows', () => {
        expect(() => buildAgyModelPickerTarget(null)).toThrow('Live AGY model reset is not supported')
        expect(() => buildAgyModelPickerTarget('gemini-9-future')).toThrow('Unsupported live AGY model')
    })
})

describe('AGY model picker navigation', () => {
    it('finds the current row and moves relatively without relying on Home', () => {
        const picker = [
            '  Gemini 4 Argon',
            '> Gemini 3.8 Flash             (current)',
            '  Claude Opus 5.5',
        ].join('\n')
        const target = buildAgyModelPickerTarget('gemini-4-argon-low')

        expect(findAgyCurrentModelRow(picker)).toBe(1)
        expect(findAgyCurrentModelRow(picker.replaceAll('\n', ''))).toBe(1)
        expect(buildAgyModelNavigationKeys(target, 1)).toBe(`\x1b[A${'\x1b[D'.repeat(3)}`)
    })

    it('moves down from the current row and does not move vertically for the same row', () => {
        const target = buildAgyModelPickerTarget('claude-opus-5-5-high')
        expect(buildAgyModelNavigationKeys(target, 0)).toBe(`${'\x1b[B'.repeat(2)}${'\x1b[D'.repeat(3)}${'\x1b[C'.repeat(2)}`)
        expect(buildAgyModelNavigationKeys(target, 2)).toBe(`${'\x1b[D'.repeat(3)}${'\x1b[C'.repeat(2)}`)
    })

    it('fails closed when the picker does not identify its current row', () => {
        expect(findAgyCurrentModelRow('Switch Model\n  Gemini 4 Argon')).toBeNull()
    })
})
