import { Hono } from 'hono'
import type { UsageModelSummary, UsageSummaryResponse } from '@hapi/protocol/apiTypes'
import type { SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import type { Store } from '../../store'
import { requireSyncEngine } from './guards'

// 中文注释：token 用量统计。数据本就随实时同步/导入写进了 messages.content,
// 这里只做"读取+聚合",不新增采集逻辑。
//
// 两个关键口径(见 store/messages.ts:aggregateUsageForSessions 的注释):
//   1. 按 message.id 去重——同一次 API 请求会写多行,每行都带同一份 usage,
//      不去重会让所有数字虚高约 2.15 倍。
//   2. 时间筛选用 content.data.timestamp(消息真实产生时间),不用 created_at
//      (导入的历史会话那是导入时间)。

/** ISO-8601 UTC,用于和库里 content.data.timestamp 做字典序比较。 */
function parseIsoParam(raw: string | undefined): string | null {
    if (!raw) return null
    const trimmed = raw.trim()
    if (!trimmed) return null
    const ms = Number(trimmed)
    const date = Number.isFinite(ms) && trimmed !== '' && /^\d+$/.test(trimmed)
        ? new Date(ms)
        : new Date(trimmed)
    if (Number.isNaN(date.getTime())) return null
    return date.toISOString()
}

function emptyTotals(): Omit<UsageModelSummary, 'model'> {
    return { requestCount: 0, inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }
}

export function createUsageRoutes(
    getSyncEngine: () => SyncEngine | null,
    getStore: () => Store | null
): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.get('/usage/summary', (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }
        const store = getStore()
        if (!store) {
            return c.json({ error: 'Store not available' }, 503)
        }

        const namespace = c.get('namespace')
        const role = c.get('role') ?? 'user'
        const accountId = c.get('accountId')

        // 与 sessions.ts 的 GET /sessions 相同的鉴权模式:先按 namespace 取全部会话,
        // 非 admin 再收窄到自己拥有/被授权的会话。
        let sessions = engine.getSessionsByNamespace(namespace)
        if (role !== 'admin') {
            const allowed = new Set(store.sessions.getSessionsForAccount(namespace, accountId).map((s) => s.id))
            sessions = sessions.filter((s) => allowed.has(s.id))
        }

        // 机器列表基于鉴权后的会话集合,不会泄漏用户无权访问的机器。
        const hosts = Array.from(
            new Set(
                sessions
                    .map((s) => s.metadata?.host)
                    .filter((h): h is string => typeof h === 'string' && h.length > 0)
            )
        ).sort()

        const hostParam = c.req.query('host')?.trim() || null
        const scoped = hostParam ? sessions.filter((s) => s.metadata?.host === hostParam) : sessions

        const sinceIso = parseIsoParam(c.req.query('since'))
        const untilIso = parseIsoParam(c.req.query('until'))

        const rows = store.messages.aggregateUsageForSessions(
            scoped.map((s) => s.id),
            { sinceIso, untilIso }
        )

        const models: UsageModelSummary[] = rows
            .map((row) => ({
                model: row.model,
                requestCount: row.requestCount,
                inputTokens: row.inputTokens,
                outputTokens: row.outputTokens,
                cacheCreationInputTokens: row.cacheCreationInputTokens,
                cacheReadInputTokens: row.cacheReadInputTokens
            }))
            .sort((a, b) => {
                const totalA = a.inputTokens + a.outputTokens + a.cacheCreationInputTokens + a.cacheReadInputTokens
                const totalB = b.inputTokens + b.outputTokens + b.cacheCreationInputTokens + b.cacheReadInputTokens
                return totalB - totalA
            })

        const totals = models.reduce((acc, m) => {
            acc.requestCount += m.requestCount
            acc.inputTokens += m.inputTokens
            acc.outputTokens += m.outputTokens
            acc.cacheCreationInputTokens += m.cacheCreationInputTokens
            acc.cacheReadInputTokens += m.cacheReadInputTokens
            return acc
        }, emptyTotals())

        const response: UsageSummaryResponse = {
            models,
            totals,
            hosts,
            filter: { since: sinceIso, until: untilIso, host: hostParam },
            generatedAt: Date.now()
        }
        return c.json(response)
    })

    return app
}
