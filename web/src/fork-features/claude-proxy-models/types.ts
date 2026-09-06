/**
 * fork(claude-proxy-models)：`GET /api/claude-proxy-models` 的响应形状。
 * 与 hub 侧 `fork-features/claude-proxy-models/domain.ts` 逐字段对齐（web 包不引根目录
 * fork-features，故此处保留一份类型副本；改动时两边同步）。
 */

export type ClaudeProxyModelSource = 'catalog' | 'config' | 'alias' | 'unknown'

export type ClaudeProxyModelSummary = {
    id: string
    displayName: string | null
    contextWindow: number | null
    maxContextWindow: number | null
    reasoningEfforts: string[] | null
    /** 代理会把这个 id 改写成哪个 slug 执行；非 null 时必须展示出来。 */
    servedAs: string | null
    isDefault: boolean
    source: ClaudeProxyModelSource
}

export type ClaudeProxyUpstreamMeta = {
    clientVersion: string | null
    catalogStale: boolean | null
    unknownModelPolicy: string | null
}

export type ClaudeProxyModelsResponse = {
    success: boolean
    configured: boolean
    models: ClaudeProxyModelSummary[]
    defaultModel: string | null
    fetchedAt: number | null
    stale: boolean
    error: string | null
    source: string | null
    upstream: ClaudeProxyUpstreamMeta | null
}
