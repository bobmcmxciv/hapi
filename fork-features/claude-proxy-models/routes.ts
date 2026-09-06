import { Hono } from 'hono'
import type { WebAppEnv } from '../../hub/src/web/middleware/auth'
import type { ClaudeProxyModelCatalog } from './claudeProxyModelCatalog'
import { emptyClaudeProxyModelsResponse } from './domain'

/**
 * `GET /api/claude-proxy-models[?refresh=1]`：Claude 会话可用的代理模型目录。
 *
 * 挂在 auth middleware 之后，任何登录账号可读——目录本身不是秘密（cx2cc 的
 * /v1/models 对机群客户端本来就是匿名可读的），也不含凭据。
 * 未配置 `HAPI_CLAUDE_PROXY_MODELS_URL` 时回答 `configured:false`，前端回落静态清单。
 * 抓取失败**不返回 5xx**：返回上一份快照 + `stale:true` + `error`，避免 New Session
 * 因为代理短暂不可达而整块报错。
 */
export function createClaudeProxyModelsRoutes(
    getCatalog: () => ClaudeProxyModelCatalog | null
): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.get('/claude-proxy-models', async (c) => {
        const catalog = getCatalog()
        if (!catalog) {
            return c.json(emptyClaudeProxyModelsResponse(false))
        }
        const refreshRaw = (c.req.query('refresh') ?? '').trim().toLowerCase()
        const force = refreshRaw === '1' || refreshRaw === 'true' || refreshRaw === 'yes'
        return c.json(await catalog.get(force))
    })

    return app
}
