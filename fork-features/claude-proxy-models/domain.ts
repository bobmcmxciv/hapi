/**
 * fork-features/claude-proxy-models：Claude 会话经 Anthropic 兼容代理（本 fork 的
 * operator 跑 cx2cc → codex-bridge → ChatGPT Codex）时，**可选模型目录**的归一化形状。
 *
 * 背景（2026-09-06）：New Session 的 Claude 模型列表是 `shared/src/models.ts` 里写死的
 * `CLAUDE_PROXY_MODEL_LABELS`；上游多出 `gpt-6-astra` 后，创建窗口永远看不到它，
 * 而写死的 `gpt-5.4[1m]` 已在上游下架却仍被推荐。目录改为由 hub 从代理的
 * `/v1/models` 动态拉取，前端只认这套结构，不解代理私有字段。
 *
 * 数据来源是 cx2cc 的 `/v1/models`（镜像 codex-bridge 的实时目录并标注别名/默认），
 * hub 侧通过 `HAPI_CLAUDE_PROXY_MODELS_URL` 指向它——ECS 上是 vircs 反向隧道落在
 * 本机回环的 `http://127.0.0.1:18901/v1/models`。
 */

export type ClaudeProxyModelSource = 'catalog' | 'config' | 'alias' | 'unknown'

export type ClaudeProxyModelSummary = {
    /** 传给 Claude Code `--model` 的字面 id（裸 slug，不带 `[1m]`）。 */
    id: string
    /** 代理给的展示名（如 "GPT-6-Astra"）；没有就 null，前端回落到 id。 */
    displayName: string | null
    /** 服务端契约窗口（tokens）；null = 代理没给（config-only 条目）。 */
    contextWindow: number | null
    /** 该 slug 允许的最大窗口；null 同上。 */
    maxContextWindow: number | null
    /** 代理声明该模型支持的推理档位；null = 未声明。 */
    reasoningEfforts: string[] | null
    /**
     * 代理把这个 id **改写成**哪个 slug 执行（cx2cc 的 CX2CC_MODEL_ALIASES）。
     * 非 null 时前端必须把它展示出来——选 sol 实际跑 astra 不能是隐形的。
     */
    servedAs: string | null
    /** 代理的钉死默认模型（客户端不指定或指定 claude-* 名字时实际跑的那个）。 */
    isDefault: boolean
    /** 条目来源：上游实时目录 / 代理配置补入 / 仅别名 / 无法判断。 */
    source: ClaudeProxyModelSource
}

export type ClaudeProxyUpstreamMeta = {
    /** 代理向上游询问目录时用的 Codex 客户端版本（目录按版本门控）。 */
    clientVersion: string | null
    /** 代理侧目录是否是失败后留存的旧快照。 */
    catalogStale: boolean | null
    /** 代理对未知显式模型的策略：reject（明确报错）| default（静默换默认）。 */
    unknownModelPolicy: string | null
}

export type ClaudeProxyModelsResponse = {
    success: boolean
    /** false = hub 没配 HAPI_CLAUDE_PROXY_MODELS_URL，前端应回落到静态清单。 */
    configured: boolean
    models: ClaudeProxyModelSummary[]
    defaultModel: string | null
    /** 本次返回的快照抓取时间（epoch ms）；null = 从未成功抓到。 */
    fetchedAt: number | null
    /** true = 最近一次抓取失败，正在提供上一份快照（或代理自己声明 stale）。 */
    stale: boolean
    /** 最近一次抓取失败的原因；成功时 null。 */
    error: string | null
    /** 目录来源的主机标识（不含凭据），给 UI 提示"来自哪里"。 */
    source: string | null
    upstream: ClaudeProxyUpstreamMeta | null
}

export function emptyClaudeProxyModelsResponse(configured: boolean): ClaudeProxyModelsResponse {
    return {
        success: true,
        configured,
        models: [],
        defaultModel: null,
        fetchedAt: null,
        stale: false,
        error: null,
        source: null,
        upstream: null
    }
}
