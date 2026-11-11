// Deep component imports only: importing package root pulls ./features (@lobehub/ui, antd).
import AlibabaCloudColor from '@lobehub/icons/es/AlibabaCloud/components/Color'
import AntigravityColor from '@lobehub/icons/es/Antigravity/components/Color'
import AzureAIColor from '@lobehub/icons/es/AzureAI/components/Color'
import BailianColor from '@lobehub/icons/es/Bailian/components/Color'
import BedrockColor from '@lobehub/icons/es/Bedrock/components/Color'
import ClaudeColor from '@lobehub/icons/es/Claude/components/Color'
import ClineMono from '@lobehub/icons/es/Cline/components/Mono'
import CodexInner from '@lobehub/icons/es/Codex/components/Inner'
import CommandAColor from '@lobehub/icons/es/CommandA/components/Color'
import CursorMono from '@lobehub/icons/es/Cursor/components/Mono'
import DeepSeekColor from '@lobehub/icons/es/DeepSeek/components/Color'
import DevinColor from '@lobehub/icons/es/Devin/components/Color'
import DoubaoColor from '@lobehub/icons/es/Doubao/components/Color'
import FireworksColor from '@lobehub/icons/es/Fireworks/components/Color'
import GeminiCLIColor from '@lobehub/icons/es/GeminiCLI/components/Color'
import GeminiColor from '@lobehub/icons/es/Gemini/components/Color'
import GithubCopilotMono from '@lobehub/icons/es/GithubCopilot/components/Mono'
import GoogleColor from '@lobehub/icons/es/Google/components/Color'
import GrokMono from '@lobehub/icons/es/Grok/components/Mono'
import GroqMono from '@lobehub/icons/es/Groq/components/Mono'
import HunyuanColor from '@lobehub/icons/es/Hunyuan/components/Color'
import KimiMono from '@lobehub/icons/es/Kimi/components/Mono'
import MinimaxColor from '@lobehub/icons/es/Minimax/components/Color'
import MistralColor from '@lobehub/icons/es/Mistral/components/Color'
import OllamaMono from '@lobehub/icons/es/Ollama/components/Mono'
import OpenAIMono from '@lobehub/icons/es/OpenAI/components/Mono'
import OpenCodeMono from '@lobehub/icons/es/OpenCode/components/Mono'
import OpenRouterMono from '@lobehub/icons/es/OpenRouter/components/Mono'
import PerplexityColor from '@lobehub/icons/es/Perplexity/components/Color'
import QwenColor from '@lobehub/icons/es/Qwen/components/Color'
import SiliconCloudColor from '@lobehub/icons/es/SiliconCloud/components/Color'
import StepfunMono from '@lobehub/icons/es/Stepfun/components/Mono'
import TogetherColor from '@lobehub/icons/es/Together/components/Color'
import VertexAIColor from '@lobehub/icons/es/VertexAI/components/Color'
import ZhipuColor from '@lobehub/icons/es/Zhipu/components/Color'
import type { IconType } from '@lobehub/icons/es/types'
import { cn } from '@/lib/utils'

export type ResolvedProviderBrand = {
    brand: string
    Icon: IconType
    iconClassName?: string
}

const EXACT_PROVIDER_BRANDS: Record<string, ResolvedProviderBrand> = {
    anthropic: { brand: 'anthropic', Icon: ClaudeColor },
    claude: { brand: 'anthropic', Icon: ClaudeColor },
    'claude-code': { brand: 'anthropic', Icon: ClaudeColor },
    'openai-codex': { brand: 'openai-codex', Icon: CodexInner },
    codex: { brand: 'openai-codex', Icon: CodexInner },
    openai: { brand: 'openai', Icon: OpenAIMono },
    chatgpt: { brand: 'openai', Icon: OpenAIMono },
    cx2cc: { brand: 'cx2cc', Icon: OpenAIMono, iconClassName: 'text-[#10a37f] dark:text-[#34d399]' },
    'google-antigravity': { brand: 'google-antigravity', Icon: AntigravityColor },
    antigravity: { brand: 'google-antigravity', Icon: AntigravityColor },
    agy: { brand: 'google-antigravity', Icon: AntigravityColor },
    'google-gemini-cli': { brand: 'google-gemini-cli', Icon: GeminiCLIColor },
    'gemini-cli': { brand: 'google-gemini-cli', Icon: GeminiCLIColor },
    gemini: { brand: 'gemini', Icon: GeminiColor },
    google: { brand: 'google', Icon: GoogleColor },
    vertex: { brand: 'vertexai', Icon: VertexAIColor },
    vertexai: { brand: 'vertexai', Icon: VertexAIColor },
    'google-vertex': { brand: 'vertexai', Icon: VertexAIColor },
    devin: { brand: 'devin', Icon: DevinColor },
    cognition: { brand: 'devin', Icon: DevinColor },
    xai: { brand: 'xai', Icon: GrokMono },
    'xai-oauth': { brand: 'xai', Icon: GrokMono },
    grok: { brand: 'xai', Icon: GrokMono },
    deepseek: { brand: 'deepseek', Icon: DeepSeekColor },
    kimi: { brand: 'kimi', Icon: KimiMono },
    'kimi-code': { brand: 'kimi', Icon: KimiMono },
    moonshot: { brand: 'kimi', Icon: KimiMono },
    minimax: { brand: 'minimax', Icon: MinimaxColor },
    'minimax-code': { brand: 'minimax', Icon: MinimaxColor },
    glm: { brand: 'zhipu', Icon: ZhipuColor },
    zai: { brand: 'zhipu', Icon: ZhipuColor },
    zhipu: { brand: 'zhipu', Icon: ZhipuColor },
    chatglm: { brand: 'zhipu', Icon: ZhipuColor },
    bigmodel: { brand: 'zhipu', Icon: ZhipuColor },
    'alibaba-token-plan': { brand: 'bailian', Icon: BailianColor },
    bailian: { brand: 'bailian', Icon: BailianColor },
    dashscope: { brand: 'bailian', Icon: BailianColor },
    alibaba: { brand: 'alibaba', Icon: AlibabaCloudColor },
    qwen: { brand: 'qwen', Icon: QwenColor },
    tongyi: { brand: 'qwen', Icon: QwenColor },
    'github-copilot': { brand: 'github-copilot', Icon: GithubCopilotMono },
    copilot: { brand: 'github-copilot', Icon: GithubCopilotMono },
    github: { brand: 'github-copilot', Icon: GithubCopilotMono },
    cursor: { brand: 'cursor', Icon: CursorMono },
    ollama: { brand: 'ollama', Icon: OllamaMono },
    'ollama-cloud': { brand: 'ollama', Icon: OllamaMono },
    opencode: { brand: 'opencode', Icon: OpenCodeMono },
    'opencode-go': { brand: 'opencode', Icon: OpenCodeMono },
    cline: { brand: 'cline', Icon: ClineMono },
    'cline-pass': { brand: 'cline', Icon: ClineMono },
    openrouter: { brand: 'openrouter', Icon: OpenRouterMono },
    mistral: { brand: 'mistral', Icon: MistralColor },
    perplexity: { brand: 'perplexity', Icon: PerplexityColor },
    cohere: { brand: 'cohere', Icon: CommandAColor },
    commandcode: { brand: 'cohere', Icon: CommandAColor },
    groq: { brand: 'groq', Icon: GroqMono },
    siliconcloud: { brand: 'siliconcloud', Icon: SiliconCloudColor },
    siliconflow: { brand: 'siliconcloud', Icon: SiliconCloudColor },
    together: { brand: 'together', Icon: TogetherColor },
    fireworks: { brand: 'fireworks', Icon: FireworksColor },
    doubao: { brand: 'doubao', Icon: DoubaoColor },
    volcengine: { brand: 'doubao', Icon: DoubaoColor },
    ark: { brand: 'doubao', Icon: DoubaoColor },
    hunyuan: { brand: 'hunyuan', Icon: HunyuanColor },
    tencent: { brand: 'hunyuan', Icon: HunyuanColor },
    stepfun: { brand: 'stepfun', Icon: StepfunMono },
    bedrock: { brand: 'bedrock', Icon: BedrockColor },
    'aws-bedrock': { brand: 'bedrock', Icon: BedrockColor },
    azure: { brand: 'azure', Icon: AzureAIColor },
    'azure-openai': { brand: 'azure', Icon: AzureAIColor }
}

const PREFIX_RULES: ReadonlyArray< readonly [RegExp, ResolvedProviderBrand] > = [
    [/^cx2cc(?:[-_]|$)/, EXACT_PROVIDER_BRANDS.cx2cc!],
    [/^(?:anthropic|claude)(?:[-_]|$)/, EXACT_PROVIDER_BRANDS.anthropic!],
    [/^(?:openai-codex|codex)(?:[-_]|$)/, EXACT_PROVIDER_BRANDS['openai-codex']!],
    [/^(?:openai|chatgpt)(?:[-_]|$)/, EXACT_PROVIDER_BRANDS.openai!],
    [/^(?:google-antigravity|antigravity|agy)(?:[-_]|$)/, EXACT_PROVIDER_BRANDS['google-antigravity']!],
    [/^(?:google-gemini-cli|gemini-cli)(?:[-_]|$)/, EXACT_PROVIDER_BRANDS['google-gemini-cli']!],
    [/^gemini(?:[-_]|$)/, EXACT_PROVIDER_BRANDS.gemini!],
    [/^vertex(?:ai)?(?:[-_]|$)/, EXACT_PROVIDER_BRANDS.vertexai!],
    [/^google(?:[-_]|$)/, EXACT_PROVIDER_BRANDS.google!],
    [/^(?:devin|cognition)(?:[-_]|$)/, EXACT_PROVIDER_BRANDS.devin!],
    [/^(?:xai|grok)(?:[-_]|$)/, EXACT_PROVIDER_BRANDS.xai!],
    [/^deepseek(?:[-_]|$)/, EXACT_PROVIDER_BRANDS.deepseek!],
    [/^(?:kimi|moonshot)(?:[-_]|$)/, EXACT_PROVIDER_BRANDS.kimi!],
    [/^minimax(?:[-_]|$)/, EXACT_PROVIDER_BRANDS.minimax!],
    [/^(?:glm|zai|zhipu|chatglm|bigmodel)(?:[-_]|$)/, EXACT_PROVIDER_BRANDS.glm!],
    [/^(?:bailian|dashscope|alibaba-token)(?:[-_]|$)/, EXACT_PROVIDER_BRANDS.bailian!],
    [/^alibaba(?:[-_]|$)/, EXACT_PROVIDER_BRANDS.alibaba!],
    [/^(?:qwen|tongyi)(?:[-_]|$)/, EXACT_PROVIDER_BRANDS.qwen!],
    [/^(?:github-copilot|copilot|github)(?:[-_]|$)/, EXACT_PROVIDER_BRANDS['github-copilot']!],
    [/^cursor(?:[-_]|$)/, EXACT_PROVIDER_BRANDS.cursor!],
    [/^ollama(?:[-_]|$)/, EXACT_PROVIDER_BRANDS.ollama!],
    [/^opencode(?:[-_]|$)/, EXACT_PROVIDER_BRANDS.opencode!],
    [/^cline(?:[-_]|$)/, EXACT_PROVIDER_BRANDS.cline!],
    [/^openrouter(?:[-_]|$)/, EXACT_PROVIDER_BRANDS.openrouter!],
    [/^mistral(?:[-_]|$)/, EXACT_PROVIDER_BRANDS.mistral!],
    [/^perplexity(?:[-_]|$)/, EXACT_PROVIDER_BRANDS.perplexity!],
    [/^(?:cohere|command)(?:[-_]|$)/, EXACT_PROVIDER_BRANDS.cohere!],
    [/^groq(?:[-_]|$)/, EXACT_PROVIDER_BRANDS.groq!],
    [/^silicon(?:cloud|flow)(?:[-_]|$)/, EXACT_PROVIDER_BRANDS.siliconcloud!],
    [/^together(?:[-_]|$)/, EXACT_PROVIDER_BRANDS.together!],
    [/^fireworks(?:[-_]|$)/, EXACT_PROVIDER_BRANDS.fireworks!],
    [/^(?:doubao|volcengine|ark)(?:[-_]|$)/, EXACT_PROVIDER_BRANDS.doubao!],
    [/^(?:hunyuan|tencent)(?:[-_]|$)/, EXACT_PROVIDER_BRANDS.hunyuan!],
    [/^stepfun(?:[-_]|$)/, EXACT_PROVIDER_BRANDS.stepfun!],
    [/^(?:aws-)?bedrock(?:[-_]|$)/, EXACT_PROVIDER_BRANDS.bedrock!],
    [/^azure(?:[-_]|$)/, EXACT_PROVIDER_BRANDS.azure!]
]

export function resolveProviderBrand(provider: string): ResolvedProviderBrand | null {
    const normalized = provider.trim().toLowerCase()
    if (!normalized) return null
    const exact = EXACT_PROVIDER_BRANDS[normalized]
    if (exact) return exact
    for (const [pattern, resolved] of PREFIX_RULES) {
        if (pattern.test(normalized)) return resolved
    }
    return null
}

export function providerMonogram(provider: string): string {
    const cleaned = provider.trim()
    if (!cleaned) return '?'
    const parts = cleaned.split(/[-_./\s]+/).filter(Boolean)
    if (parts.length >= 2) {
        return `${parts[0]![0] ?? ''}${parts[1]![0] ?? ''}`.toUpperCase()
    }
    return cleaned.slice(0, 2).toUpperCase()
}

/** Resolve an inline sub-model logo when a multi-model provider reports per-family pools (e.g. Antigravity's Claude vs Gemini windows). */
export function resolveQuotaSubModelBrand(parentProvider: string, label: string, modelId?: string): ResolvedProviderBrand | null {
    const parent = resolveProviderBrand(parentProvider)?.brand
    const probe = `${modelId ?? ''} ${label}`.toLowerCase()
    let candidate: ResolvedProviderBrand | null = null
    if (/\bclaude\b|\bopus\b|\bsonnet\b|\bhaiku\b|\bfable\b/.test(probe)) {
        candidate = EXACT_PROVIDER_BRANDS.anthropic!
    } else if (/\bgemini\b/.test(probe)) {
        candidate = EXACT_PROVIDER_BRANDS.gemini!
    } else if (/\bgpt\b|\bcodex\b|\bo[134]\b/.test(probe)) {
        candidate = EXACT_PROVIDER_BRANDS.openai!
    } else if (/\bgrok\b/.test(probe)) {
        candidate = EXACT_PROVIDER_BRANDS.xai!
    } else if (/\bdeepseek\b/.test(probe)) {
        candidate = EXACT_PROVIDER_BRANDS.deepseek!
    } else if (/\bqwen\b/.test(probe)) {
        candidate = EXACT_PROVIDER_BRANDS.qwen!
    }
    if (!candidate || candidate.brand === parent) return null
    return candidate
}

export function ProviderLogo(props: {
    provider: string
    size?: 'sm' | 'md'
    framed?: boolean
    className?: string
}) {
    const { provider, size = 'md', framed = true, className } = props
    const resolved = resolveProviderBrand(provider)
    const boxSize = size === 'sm' ? 'h-4 w-4 rounded' : 'h-6 w-6 rounded-md'
    const glyphSize = size === 'sm' ? 12 : 15

    if (resolved) {
        const { Icon } = resolved
        return (
            <span
                aria-hidden="true"
                data-testid="provider-logo"
                data-provider-logo={resolved.brand}
                className={cn(
                    'inline-flex shrink-0 items-center justify-center leading-none text-[var(--app-fg)]',
                    framed && boxSize,
                    framed && 'border border-[var(--app-divider)] bg-[var(--app-bg)] shadow-[0_1px_1px_rgba(0,0,0,0.03)]',
                    resolved.iconClassName,
                    className
                )}
            >
                <Icon size={glyphSize} />
            </span>
        )
    }

    return (
        <span
            aria-hidden="true"
            data-testid="provider-logo"
            data-provider-logo="fallback"
            className={cn(
                'inline-flex shrink-0 select-none items-center justify-center font-semibold tracking-tight text-[var(--app-hint)]',
                size === 'sm' ? 'h-4 w-4 rounded text-[8px]' : 'h-6 w-6 rounded-md text-[10px]',
                framed && 'border border-[var(--app-divider)] bg-[var(--app-subtle-bg)]',
                className
            )}
        >
            {providerMonogram(provider)}
        </span>
    )
}
