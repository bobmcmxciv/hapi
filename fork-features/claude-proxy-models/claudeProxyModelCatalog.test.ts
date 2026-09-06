import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import type { WebAppEnv } from '../../hub/src/web/middleware/auth'
import {
    createClaudeProxyModelCatalog,
    createClaudeProxyModelCatalogFromEnv,
    normalizeClaudeProxyModels
} from './claudeProxyModelCatalog'
import { createClaudeProxyModelsRoutes } from './routes'

// cx2cc 2026-09-06 起的 /v1/models 形状（镜像 codex-bridge 目录 + 别名/默认注解）。
const CX2CC_PAYLOAD = {
    object: 'list',
    client_version: '0.153.4',
    catalog_fetched_at: 1.0,
    catalog_stale: false,
    catalog_error: null,
    default_model: 'gpt-6-astra',
    aliases: { 'gpt-5.6-sol': 'gpt-6-astra', 'gpt-5.4': 'gpt-6-astra' },
    unknown_model_policy: 'reject',
    data: [
        { id: 'gpt-5.6-sol', object: 'model', display_name: 'GPT-5.6-Sol', context_window: 272000, max_context_window: 272000, reasoning_efforts: ['low', 'high'], is_default: false, served_as: 'gpt-6-astra', source: 'catalog' },
        { id: 'gpt-6-astra', object: 'model', display_name: 'GPT-6-Astra', context_window: 272000, max_context_window: 872000, reasoning_efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], is_default: true, source: 'catalog' },
        { id: 'gpt-5.4', object: 'model', owned_by: 'cx2cc', served_as: 'gpt-6-astra', is_default: false, source: 'alias' },
        { id: 'config-only', object: 'model', is_default: false, source: 'config' },
        { bogus: true },
        { id: 'gpt-6-astra' } // duplicate id must not double-list
    ]
}

describe('normalizeClaudeProxyModels', () => {
    it('归一化 cx2cc 注解形状：默认模型排首、别名与来源保留、坏条目与重复丢弃', () => {
        const { models, defaultModel, upstream } = normalizeClaudeProxyModels(CX2CC_PAYLOAD)
        expect(models.map((m) => m.id)).toEqual(['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.4', 'config-only'])
        expect(defaultModel).toBe('gpt-6-astra')
        const astra = models[0]!
        expect(astra).toEqual({
            id: 'gpt-6-astra',
            displayName: 'GPT-6-Astra',
            contextWindow: 272000,
            maxContextWindow: 872000,
            reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
            servedAs: null,
            isDefault: true,
            source: 'catalog'
        })
        const sol = models[1]!
        expect(sol.servedAs).toBe('gpt-6-astra')
        expect(sol.contextWindow).toBe(272000)
        const alias = models[2]!
        expect(alias).toMatchObject({ id: 'gpt-5.4', servedAs: 'gpt-6-astra', source: 'alias', contextWindow: null })
        expect(models[3]).toMatchObject({ id: 'config-only', source: 'config', reasoningEfforts: null })
        expect(upstream).toEqual({ clientVersion: '0.153.4', catalogStale: false, unknownModelPolicy: 'reject' })
    })

    it('也接受裸 OpenAI 列表（没有注解字段）', () => {
        const { models, defaultModel, upstream } = normalizeClaudeProxyModels({
            object: 'list',
            data: [{ id: 'gpt-a' }, { id: 'gpt-b', context_window: 1000 }]
        })
        expect(models.map((m) => m.id)).toEqual(['gpt-a', 'gpt-b'])
        expect(models[0]!.source).toBe('unknown')
        expect(models[1]!.source).toBe('catalog')
        expect(models.every((m) => !m.isDefault)).toBe(true)
        expect(defaultModel).toBeNull()
        expect(upstream).toEqual({ clientVersion: null, catalogStale: null, unknownModelPolicy: null })
    })

    it('顶层 aliases 也能给条目补 servedAs（条目自己没带 served_as 时）', () => {
        const { models } = normalizeClaudeProxyModels({
            default_model: 'x',
            aliases: { old: 'x' },
            data: [{ id: 'x' }, { id: 'old' }]
        })
        expect(models.find((m) => m.id === 'old')!.servedAs).toBe('x')
        expect(models.find((m) => m.id === 'x')!.servedAs).toBeNull()
    })

    it('垃圾输入得到空目录而不是抛错', () => {
        expect(normalizeClaudeProxyModels(null).models).toEqual([])
        expect(normalizeClaudeProxyModels('nope').models).toEqual([])
        expect(normalizeClaudeProxyModels({ data: 'nope' }).models).toEqual([])
    })
})

function fakeFetch(handler: (url: string) => Promise<Response> | Response): { fetchImpl: typeof fetch; calls: string[] } {
    const calls: string[] = []
    const fetchImpl = (async (input: string | URL | Request) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        calls.push(url)
        return await handler(url)
    }) as unknown as typeof fetch
    return { fetchImpl, calls }
}

describe('createClaudeProxyModelCatalog', () => {
    it('首次取拉一次，TTL 内复用快照，force 跳过 TTL', async () => {
        let t = 1_000_000
        const { fetchImpl, calls } = fakeFetch(() => Response.json(CX2CC_PAYLOAD))
        const catalog = createClaudeProxyModelCatalog({ url: 'http://127.0.0.1:18901/v1/models', fetchImpl, now: () => t, ttlMs: 60_000, log: () => {} })

        const first = await catalog.get()
        expect(first.success).toBe(true)
        expect(first.configured).toBe(true)
        expect(first.models.map((m) => m.id)[0]).toBe('gpt-6-astra')
        expect(first.fetchedAt).toBe(1_000_000)
        expect(first.stale).toBe(false)
        expect(first.error).toBeNull()
        expect(first.source).toBe('127.0.0.1:18901/v1/models')
        expect(first.upstream?.clientVersion).toBe('0.153.4')

        t += 30_000
        await catalog.get()
        expect(calls).toHaveLength(1)

        await catalog.get(true)
        expect(calls).toHaveLength(2)

        t += 61_000
        await catalog.get()
        expect(calls).toHaveLength(3)
    })

    it('抓取失败保留上一份快照，标 stale + error，退避期内不重复打上游', async () => {
        let t = 1_000_000
        let fail = false
        const { fetchImpl, calls } = fakeFetch(() => {
            if (fail) throw new Error('ECONNREFUSED')
            return Response.json(CX2CC_PAYLOAD)
        })
        const catalog = createClaudeProxyModelCatalog({ url: 'http://x/v1/models', fetchImpl, now: () => t, ttlMs: 1_000, retryBackoffMs: 15_000, log: () => {} })
        const good = await catalog.get()
        expect(good.models).toHaveLength(4)

        fail = true
        t += 2_000
        const stale = await catalog.get()
        expect(stale.models.map((m) => m.id)).toEqual(good.models.map((m) => m.id))
        expect(stale.stale).toBe(true)
        expect(stale.error).toBe('ECONNREFUSED')
        expect(stale.fetchedAt).toBe(good.fetchedAt)
        expect(calls).toHaveLength(2)

        t += 5_000
        await catalog.get()
        expect(calls).toHaveLength(2) // still inside the retry backoff

        fail = false
        t += 15_000
        const recovered = await catalog.get()
        expect(recovered.stale).toBe(false)
        expect(recovered.error).toBeNull()
        expect(calls).toHaveLength(3)
    })

    it('从未成功过时，失败返回空目录 + error，而不是抛错', async () => {
        const { fetchImpl } = fakeFetch(() => new Response('nope', { status: 503 }))
        const catalog = createClaudeProxyModelCatalog({ url: 'http://x/v1/models', fetchImpl, log: () => {} })
        const result = await catalog.get()
        expect(result.success).toBe(true)
        expect(result.configured).toBe(true)
        expect(result.models).toEqual([])
        expect(result.stale).toBe(true)
        expect(result.error).toBe('HTTP 503')
        expect(result.fetchedAt).toBeNull()
    })

    it('空目录视为失败（保留上一份），并发调用合流成一次抓取', async () => {
        let resolveFetch: ((r: Response) => void) | null = null
        const { fetchImpl, calls } = fakeFetch(() => new Promise<Response>((resolve) => { resolveFetch = resolve }))
        const catalog = createClaudeProxyModelCatalog({ url: 'http://x/v1/models', fetchImpl, log: () => {} })
        const a = catalog.get()
        const b = catalog.get()
        expect(calls).toHaveLength(1)
        resolveFetch!(Response.json({ data: [] }))
        const [ra, rb] = await Promise.all([a, b])
        expect(ra).toBe(rb)
        expect(ra.error).toBe('catalog returned no models')
        expect(ra.models).toEqual([])
    })

    it('代理自己声明目录 stale 时透传为 stale', async () => {
        const { fetchImpl } = fakeFetch(() => Response.json({ ...CX2CC_PAYLOAD, catalog_stale: true }))
        const catalog = createClaudeProxyModelCatalog({ url: 'http://x/v1/models', fetchImpl, log: () => {} })
        const result = await catalog.get()
        expect(result.stale).toBe(true)
        expect(result.error).toBeNull()
        expect(result.upstream?.catalogStale).toBe(true)
    })
})

describe('createClaudeProxyModelCatalogFromEnv', () => {
    it('未配置 URL 返回 null，配置了则建目录', () => {
        expect(createClaudeProxyModelCatalogFromEnv({} as NodeJS.ProcessEnv)).toBeNull()
        expect(createClaudeProxyModelCatalogFromEnv({ HAPI_CLAUDE_PROXY_MODELS_URL: '   ' } as NodeJS.ProcessEnv)).toBeNull()
        const catalog = createClaudeProxyModelCatalogFromEnv({ HAPI_CLAUDE_PROXY_MODELS_URL: 'http://127.0.0.1:18901/v1/models' } as NodeJS.ProcessEnv)
        expect(catalog?.url).toBe('http://127.0.0.1:18901/v1/models')
    })
})

describe('GET /api/claude-proxy-models', () => {
    function mount(getCatalog: Parameters<typeof createClaudeProxyModelsRoutes>[0]) {
        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => { c.set('namespace', 'default'); await next() })
        app.route('/api', createClaudeProxyModelsRoutes(getCatalog))
        return app
    }

    it('未配置时回答 configured:false 且 200（前端回落静态清单）', async () => {
        const response = await mount(() => null).request('/api/claude-proxy-models')
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            success: true,
            configured: false,
            models: [],
            defaultModel: null,
            fetchedAt: null,
            stale: false,
            error: null,
            source: null,
            upstream: null
        })
    })

    it('配置时返回目录；?refresh=1 触发强制抓取', async () => {
        const { fetchImpl, calls } = fakeFetch(() => Response.json(CX2CC_PAYLOAD))
        const catalog = createClaudeProxyModelCatalog({ url: 'http://x/v1/models', fetchImpl, log: () => {} })
        const app = mount(() => catalog)

        const body = await (await app.request('/api/claude-proxy-models')).json() as { configured: boolean; models: Array<{ id: string; servedAs: string | null }>; defaultModel: string }
        expect(body.configured).toBe(true)
        expect(body.defaultModel).toBe('gpt-6-astra')
        expect(body.models.find((m) => m.id === 'gpt-5.6-sol')?.servedAs).toBe('gpt-6-astra')
        await app.request('/api/claude-proxy-models')
        expect(calls).toHaveLength(1)
        await app.request('/api/claude-proxy-models?refresh=1')
        expect(calls).toHaveLength(2)
    })

    it('抓取失败仍是 200，body 里带 stale/error，不把 New Session 整块打红', async () => {
        const { fetchImpl } = fakeFetch(() => { throw new Error('down') })
        const catalog = createClaudeProxyModelCatalog({ url: 'http://x/v1/models', fetchImpl, log: () => {} })
        const response = await mount(() => catalog).request('/api/claude-proxy-models')
        expect(response.status).toBe(200)
        const body = await response.json() as { stale: boolean; error: string; models: unknown[] }
        expect(body.stale).toBe(true)
        expect(body.error).toBe('down')
        expect(body.models).toEqual([])
    })
})
