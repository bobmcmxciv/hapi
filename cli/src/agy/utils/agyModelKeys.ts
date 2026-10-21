export type AgyModelPickerTarget = {
    row: number
    effort: 0 | 1 | 2 | null
    label: string
}

const TARGETS: Record<string, AgyModelPickerTarget> = {
    'gemini-4-argon-low': { row: 0, effort: 0, label: 'Gemini 4 Argon (Low)' },
    'gemini-4-argon-medium': { row: 0, effort: 1, label: 'Gemini 4 Argon (Medium)' },
    'gemini-4-argon-high': { row: 0, effort: 2, label: 'Gemini 4 Argon (High)' },
    'gemini-3.8-flash-low': { row: 1, effort: 0, label: 'Gemini 3.8 Flash (Low)' },
    'gemini-3.8-flash-medium': { row: 1, effort: 1, label: 'Gemini 3.8 Flash (Medium)' },
    'gemini-3.8-flash-high': { row: 1, effort: 2, label: 'Gemini 3.8 Flash (High)' },
    'claude-opus-5-5-low': { row: 2, effort: 0, label: 'Claude Opus 5.5 (Low)' },
    'claude-opus-5-5-medium': { row: 2, effort: 1, label: 'Claude Opus 5.5 (Medium)' },
    'claude-opus-5-5-high': { row: 2, effort: 2, label: 'Claude Opus 5.5 (High)' },
    'claude-sonnet-5-5-low': { row: 3, effort: 0, label: 'Claude Sonnet 5.5 (Low)' },
    'claude-sonnet-5-5-medium': { row: 3, effort: 1, label: 'Claude Sonnet 5.5 (Medium)' },
    'claude-sonnet-5-5-high': { row: 3, effort: 2, label: 'Claude Sonnet 5.5 (High)' },
    'gpt-oss-120b-medium': { row: 4, effort: null, label: 'GPT-OSS 120B (Medium)' },
}

const MODEL_ROWS = [
    'Gemini 4 Argon',
    'Gemini 3.8 Flash',
    'Claude Opus 5.5',
    'Claude Sonnet 5.5',
    'GPT-OSS 120B (Medium)',
] as const

export function buildAgyModelPickerTarget(modelId: string | null): AgyModelPickerTarget {
    if (modelId === null) throw new Error('Live AGY model reset is not supported')
    const target = TARGETS[modelId]
    if (!target) throw new Error(`Unsupported live AGY model: ${modelId}`)
    return target
}

export function findAgyCurrentModelRow(pickerOutput: string): number | null {
    const marker = pickerOutput.lastIndexOf('(current)')
    if (marker === -1) return null
    let bestRow: number | null = null
    let bestIndex = -1
    MODEL_ROWS.forEach((label, row) => {
        const index = pickerOutput.lastIndexOf(label, marker)
        if (index > bestIndex) {
            bestIndex = index
            bestRow = row
        }
    })
    return bestIndex === -1 ? null : bestRow
}

export function buildAgyModelNavigationKeys(target: AgyModelPickerTarget, currentRow: number): string {
    if (!Number.isInteger(currentRow) || currentRow < 0 || currentRow >= MODEL_ROWS.length) {
        throw new Error(`Invalid current AGY model row: ${currentRow}`)
    }
    const delta = target.row - currentRow
    const vertical = delta < 0 ? '\x1b[A'.repeat(-delta) : '\x1b[B'.repeat(delta)
    if (target.effort === null) return vertical
    const resetEffort = '\x1b[D'.repeat(3)
    const setEffort = '\x1b[C'.repeat(target.effort)
    return `${vertical}${resetEffort}${setEffort}`
}
