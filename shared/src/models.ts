export const CLAUDE_MODEL_LABELS = {
    fable: 'Fable',
    'fable[1m]': 'Fable 1M',
    sonnet: 'Sonnet',
    'sonnet[1m]': 'Sonnet 1M',
    opus: 'Opus',
    'opus[1m]': 'Opus 1M',
    haiku: 'Haiku'
} as const

export type ClaudeModelPreset = keyof typeof CLAUDE_MODEL_LABELS
export const CLAUDE_MODEL_PRESETS = Object.keys(CLAUDE_MODEL_LABELS) as ClaudeModelPreset[]

export const CLAUDE_MODEL_ID_LABELS = {
    'claude-fable-5': 'Fable 5',
    'claude-opus-4-8': 'Opus 4.8',
    'claude-opus-4-7': 'Opus 4.7',
    'claude-opus-4-6': 'Opus 4.6',
    'claude-opus-4-5': 'Opus 4.5',
    'claude-sonnet-5': 'Sonnet 5',
    'claude-sonnet-4-6': 'Sonnet 4.6',
    'claude-haiku-4-5': 'Haiku 4.5'
} as const

export type ClaudeModelId = keyof typeof CLAUDE_MODEL_ID_LABELS
export const CLAUDE_MODEL_IDS = Object.keys(CLAUDE_MODEL_ID_LABELS) as ClaudeModelId[]

/**
 * Model ids served by an Anthropic-compatible proxy in front of Claude Code
 * (this fork's operator runs cx2cc, which fronts a GPT model on the Anthropic
 * `/v1/messages` wire). Claude Code passes an unrecognised `--model` straight
 * through and still honours the `[1m]` suffix, so these are legal launch values
 * — verified live against cx2cc: `--model gpt-5.6-sol[1m]` returns
 * `system/init.model = "gpt-5.6-sol[1m]"` and
 * `result.modelUsage["gpt-5.6-sol[1m]"].contextWindow = 1_000_000`.
 *
 * Labels are the raw ids on purpose: the point of picking one of these is to
 * see the model that actually runs, so prettifying would defeat it. Note the
 * proxy reports the bare alias (`gpt-5.6-sol`) on assistant frames while the
 * `[1m]` suffix only survives on system/init and result.modelUsage — both
 * spellings are listed so either can be selected and recognised.
 */
export const CLAUDE_PROXY_MODEL_LABELS = {
    'gpt-5.6-sol': 'gpt-5.6-sol',
    'gpt-5.6-sol[1m]': 'gpt-5.6-sol[1m]'
} as const

export type ClaudeProxyModelId = keyof typeof CLAUDE_PROXY_MODEL_LABELS
export const CLAUDE_PROXY_MODEL_IDS = Object.keys(CLAUDE_PROXY_MODEL_LABELS) as ClaudeProxyModelId[]

export const GEMINI_MODEL_LABELS = {
    'gemini-3.1-pro-preview': 'Gemini 3.1 Pro Preview',
    'gemini-3-flash-preview': 'Gemini 3 Flash Preview',
    'gemini-2.5-pro': 'Gemini 2.5 Pro',
    'gemini-2.5-flash': 'Gemini 2.5 Flash',
    'gemini-2.5-flash-lite': 'Gemini 2.5 Flash Lite',
} as const

export type GeminiModelPreset = keyof typeof GEMINI_MODEL_LABELS
export const GEMINI_MODEL_PRESETS = Object.keys(GEMINI_MODEL_LABELS) as GeminiModelPreset[]
export const DEFAULT_GEMINI_MODEL: GeminiModelPreset = 'gemini-2.5-pro'

export function isClaudeModelPreset(model: string | null | undefined): model is ClaudeModelPreset {
    return typeof model === 'string' && Object.hasOwn(CLAUDE_MODEL_LABELS, model)
}

export function getClaudeModelLabel(model: string): string | null {
    const trimmedModel = model.trim()
    if (!trimmedModel) {
        return null
    }

    return CLAUDE_MODEL_LABELS[trimmedModel as ClaudeModelPreset]
        ?? CLAUDE_MODEL_ID_LABELS[trimmedModel as ClaudeModelId]
        ?? CLAUDE_PROXY_MODEL_LABELS[trimmedModel as ClaudeProxyModelId]
        ?? null
}
