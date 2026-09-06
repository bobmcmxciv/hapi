import { CLAUDE_MODEL_IDS, CLAUDE_MODEL_PRESETS, CLAUDE_PROXY_MODEL_IDS, getClaudeModelLabel } from '@hapi/protocol'

export type ClaudeComposerModelOption = {
    value: string | null
    label: string
}

const CLAUDE_BUILTIN_MODELS: readonly string[] = [
    ...CLAUDE_MODEL_PRESETS,
    ...CLAUDE_MODEL_IDS
]

const CLAUDE_SELECTABLE_MODELS: readonly string[] = [
    ...CLAUDE_BUILTIN_MODELS,
    // Listed (not "custom") so a session already running on a proxy id keeps
    // the picker selection instead of falling into the custom-id radio.
    ...CLAUDE_PROXY_MODEL_IDS
]

/**
 * fork(claude-proxy-models)：`proxyModels` 是 hub 动态拉到的代理目录。给了数组就以它为
 * 准——静态 `CLAUDE_PROXY_MODEL_IDS` 只是目录不可用时的回落，不再与动态项并列（否则
 * 上游已下架的 `gpt-5.4[1m]` 会一直挂在推荐里）。`undefined`/`null` = 目录不可用。
 */
export function isListedClaudeModel(
    model?: string | null,
    proxyModels?: readonly ClaudeComposerModelOption[] | null
): boolean {
    const normalizedModel = normalizeClaudeComposerModel(model)
    if (normalizedModel === null) {
        return false
    }
    if (proxyModels) {
        return CLAUDE_BUILTIN_MODELS.includes(normalizedModel)
            || proxyModels.some((option) => option.value === normalizedModel)
    }
    return CLAUDE_SELECTABLE_MODELS.includes(normalizedModel)
}

export function normalizeCustomClaudeModelId(value: string): string | null {
    const modelId = value.trim()
    return modelId || null
}

function normalizeClaudeComposerModel(model?: string | null): string | null {
    const trimmedModel = model?.trim()
    if (!trimmedModel || trimmedModel === 'auto' || trimmedModel === 'default') {
        return null
    }

    return trimmedModel
}

export function getClaudeComposerModelOptions(
    currentModel?: string | null,
    proxyModels?: readonly ClaudeComposerModelOption[] | null
): ClaudeComposerModelOption[] {
    const options: ClaudeComposerModelOption[] = [
        { value: null, label: 'Default' }
    ]

    if (proxyModels) {
        options.push(...CLAUDE_BUILTIN_MODELS.map((model) => ({
            value: model,
            label: getClaudeModelLabel(model) ?? model
        })))
        for (const option of proxyModels) {
            const value = normalizeClaudeComposerModel(option.value)
            if (!value || options.some((existing) => existing.value === value)) {
                continue
            }
            options.push({ value, label: option.label || value })
        }
        return options
    }

    options.push(...CLAUDE_SELECTABLE_MODELS.map((model) => ({
        value: model,
        label: getClaudeModelLabel(model) ?? model
    })))

    return options
}

export function getNextClaudeComposerModel(
    currentModel?: string | null,
    proxyModels?: readonly ClaudeComposerModelOption[] | null
): string | null {
    const normalizedCurrentModel = normalizeClaudeComposerModel(currentModel)
    const options = getClaudeComposerModelOptions(normalizedCurrentModel, proxyModels)
    const currentIndex = options.findIndex((option) => option.value === normalizedCurrentModel)

    if (currentIndex === -1) {
        return options[0]?.value ?? null
    }

    return options[(currentIndex + 1) % options.length]?.value ?? null
}
