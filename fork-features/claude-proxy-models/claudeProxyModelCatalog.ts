import type {
    ClaudeProxyModelSource,
    ClaudeProxyModelSummary,
    ClaudeProxyModelsResponse,
    ClaudeProxyUpstreamMeta
} from './domain'
import { emptyClaudeProxyModelsResponse } from './domain'

/**
 * hub 侧的代理模型目录：从 `HAPI_CLAUDE_PROXY_MODELS_URL` 拉 OpenAI 形状的
 * `/v1/models`，归一化成 ClaudeProxyModelsResponse，带 TTL 缓存、失败保留上一份快照、
 * 并发请求合流。**不在 runner 上查**：本 fork 全机群共用一个 cx2cc，且 hub 所在 ECS
 * 经反向隧道能直达它；这样不需要机群 CLI 换芯（换芯会杀会话）。
 *
 * 目录只读、无凭据（cx2cc 的 /v1/models 不鉴权），所以本模块不持有任何 secret。
 */

export type ClaudeProxyModelCatalogOptions = {
    /** 完整 URL，例如 `http://127.0.0.1:18901/v1/models`。 */
    url: string
    /** 快照有效期（ms），默认 60s。 */
    ttlMs?: number
    /** 单次 fetch 超时（ms），默认 8s。 */
    timeoutMs?: number
    /** 抓取失败后的重试退避（ms），默认 15s；期间继续供应旧快照。 */
    retryBackoffMs?: number
    fetchImpl?: typeof fetch
    now?: () => number
    log?: (message: string) => void
}

export type ClaudeProxyModelCatalog = {
    /** 取当前目录；`force=true` 跳过 TTL（UI 的"刷新"）。永远不抛：失败落在 `error`/`stale`。 */
    get(force?: boolean): Promise<ClaudeProxyModelsResponse>
    readonly url: string
}

type RawEntry = Record<string, unknown>

function asString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function asPositiveNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

function asStringList(value: unknown): string[] | null {
    if (!Array.isArray(value)) return null
    const list = value.map((v) => asString(v)).filter((v): v is string => v !== null)
    return list.length > 0 ? list : null
}

function asSource(value: unknown): ClaudeProxyModelSource {
    return value === 'catalog' || value === 'config' || value === 'alias' ? value : 'unknown'
}

function normalizeEntry(raw: unknown, defaultModel: string | null, aliases: Record<string, string>): ClaudeProxyModelSummary | null {
    if (!raw || typeof raw !== 'object') return null
    const entry = raw as RawEntry
    const id = asString(entry.id)
    if (!id) return null
    const servedAs = asString(entry.served_as) ?? aliases[id] ?? null
    return {
        id,
        displayName: asString(entry.display_name),
        contextWindow: asPositiveNumber(entry.context_window),
        maxContextWindow: asPositiveNumber(entry.max_context_window),
        reasoningEfforts: asStringList(entry.reasoning_efforts),
        servedAs: servedAs && servedAs !== id ? servedAs : null,
        isDefault: entry.is_default === true || (entry.is_default === undefined && id === defaultModel),
        source: asSource(entry.source ?? (entry.context_window != null ? 'catalog' : undefined))
    }
}

/**
 * 纯函数：把代理的 `/v1/models` JSON 归一化。接受两种形状——cx2cc 带注解的
 * （`default_model` / `aliases` / `served_as` / `unknown_model_policy`）和裸 OpenAI 列表
 * （只有 `data[].id`）。
 */
export function normalizeClaudeProxyModels(payload: unknown): {
    models: ClaudeProxyModelSummary[]
    defaultModel: string | null
    upstream: ClaudeProxyUpstreamMeta
} {
    const body = (payload && typeof payload === 'object' ? payload : {}) as RawEntry
    const data = Array.isArray(body.data) ? body.data : []
    const defaultModel = asString(body.default_model)
    const aliases: Record<string, string> = {}
    if (body.aliases && typeof body.aliases === 'object') {
        for (const [from, to] of Object.entries(body.aliases as Record<string, unknown>)) {
            const target = asString(to)
            if (from.trim() && target) aliases[from.trim()] = target
        }
    }
    const seen = new Set<string>()
    const models: ClaudeProxyModelSummary[] = []
    for (const raw of data) {
        const model = normalizeEntry(raw, defaultModel, aliases)
        if (!model || seen.has(model.id)) continue
        seen.add(model.id)
        models.push(model)
    }
    // 默认模型排最前，其余保持代理给的顺序（代理已按目录顺序排好）。
    models.sort((a, b) => Number(b.isDefault) - Number(a.isDefault))
    return {
        models,
        defaultModel: defaultModel ?? models.find((m) => m.isDefault)?.id ?? null,
        upstream: {
            clientVersion: asString(body.client_version),
            catalogStale: typeof body.catalog_stale === 'boolean' ? body.catalog_stale : null,
            unknownModelPolicy: asString(body.unknown_model_policy)
        }
    }
}

function describeSource(url: string): string {
    try {
        const parsed = new URL(url)
        return parsed.host + parsed.pathname
    } catch {
        return 'proxy'
    }
}

export function createClaudeProxyModelCatalog(opts: ClaudeProxyModelCatalogOptions): ClaudeProxyModelCatalog {
    const ttlMs = opts.ttlMs ?? 60_000
    const timeoutMs = opts.timeoutMs ?? 8_000
    const retryBackoffMs = opts.retryBackoffMs ?? 15_000
    const fetchImpl = opts.fetchImpl ?? fetch
    const now = opts.now ?? (() => Date.now())
    const log = opts.log ?? ((message: string) => console.warn(message))
    const source = describeSource(opts.url)

    let snapshot: ClaudeProxyModelsResponse = { ...emptyClaudeProxyModelsResponse(true), source }
    let nextTryAt = 0
    let inflight: Promise<ClaudeProxyModelsResponse> | null = null

    async function fetchOnce(): Promise<ClaudeProxyModelsResponse> {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), timeoutMs)
        try {
            const response = await fetchImpl(opts.url, {
                method: 'GET',
                headers: { accept: 'application/json' },
                signal: controller.signal
            })
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`)
            }
            const normalized = normalizeClaudeProxyModels(await response.json())
            if (normalized.models.length === 0) {
                throw new Error('catalog returned no models')
            }
            return {
                success: true,
                configured: true,
                models: normalized.models,
                defaultModel: normalized.defaultModel,
                fetchedAt: now(),
                stale: normalized.upstream.catalogStale === true,
                error: null,
                source,
                upstream: normalized.upstream
            }
        } finally {
            clearTimeout(timer)
        }
    }

    async function refresh(): Promise<ClaudeProxyModelsResponse> {
        try {
            snapshot = await fetchOnce()
            nextTryAt = 0
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            log(`[ClaudeProxyModels] catalog fetch failed (${source}): ${message}`)
            nextTryAt = now() + retryBackoffMs
            // 失败保留上一份快照（有就有，没有就空），标 stale + error 让 UI 能说清楚。
            snapshot = { ...snapshot, stale: true, error: message }
        }
        return snapshot
    }

    return {
        url: opts.url,
        async get(force = false) {
            const fresh = snapshot.fetchedAt !== null && !snapshot.error && now() - snapshot.fetchedAt < ttlMs
            if (fresh && !force) return snapshot
            if (!force && now() < nextTryAt) return snapshot
            if (!inflight) {
                inflight = refresh().finally(() => { inflight = null })
            }
            return await inflight
        }
    }
}

/**
 * 从环境变量建目录；未配置返回 null（路由据此回答 configured:false）。
 * 生产（ECS docker compose .env）：HAPI_CLAUDE_PROXY_MODELS_URL=http://127.0.0.1:18901/v1/models
 */
export function createClaudeProxyModelCatalogFromEnv(env: NodeJS.ProcessEnv = process.env): ClaudeProxyModelCatalog | null {
    const url = env.HAPI_CLAUDE_PROXY_MODELS_URL?.trim()
    if (!url) return null
    const ttlRaw = Number.parseInt(env.HAPI_CLAUDE_PROXY_MODELS_TTL_MS ?? '', 10)
    return createClaudeProxyModelCatalog({
        url,
        ttlMs: Number.isFinite(ttlRaw) && ttlRaw > 0 ? ttlRaw : undefined
    })
}
