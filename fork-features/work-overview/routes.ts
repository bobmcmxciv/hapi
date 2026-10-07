import type { Context, Hono } from 'hono'
import { z } from 'zod'
import type { WebAppEnv } from '../../hub/src/web/middleware/auth'
import { getWorkStore, WorkMapError, type WorkStore } from './workStore'
import { getDigestService } from '../session-digest/digestService'
import { BRIEFING_SYSTEM_PROMPT, buildBriefingPrompt, knownIds, parseBriefing, type Briefing, type BriefingContext } from './briefing'

/**
 * `/api/work/*`：工作总览的归属数据。目前 **admin-only**——由 executionMount 注入的
 * resolveAccount 解析网关账号，role 不是 admin 一律 403（不是 404：前端据此不显示入口，
 * 而不是当成服务没起）。数据仍按账号隔离存储。
 */
export type ResolveWorkAccount = (c: Context<WebAppEnv>) => Promise<
    | { ok: true; accountId: number; isAdmin: boolean }
    | { ok: false; response: Response }
>

const lineSchema = z.object({
    id: z.string(),
    parentId: z.string().nullable(),
    name: z.string(),
    goal: z.string().default(''),
    sort: z.number().default(0)
})
const folderSchema = z.object({
    projectKey: z.string().min(1),
    mode: z.enum(['line', 'mixed', 'ignored']),
    lineId: z.string().nullable().default(null),
    project: z.string().nullable().default(null)
})
const sessionSchema = z.object({
    sessionId: z.string().min(1),
    lineId: z.string().nullable()
})
const mapSchema = z.object({
    lines: z.array(lineSchema).max(500),
    folders: z.array(folderSchema).max(5000),
    sessions: z.array(sessionSchema).max(50_000)
})
const folderPatchSchema = z.object({
    projectKey: z.string().min(1),
    /** null = 放回待整理。 */
    mode: z.enum(['line', 'mixed', 'ignored']).nullable(),
    lineId: z.string().nullable().optional(),
    project: z.string().nullable().optional()
})
const dismissSchema = z.object({
    sessionId: z.string().min(1),
    dismissed: z.boolean()
})
const idTitle = z.object({ sessionId: z.string().min(1), title: z.string().max(200).default('') })
const briefingContextSchema = z.object({
    lines: z.array(z.object({
        id: z.string(), name: z.string().max(120), parentId: z.string().nullable(), goal: z.string().max(400).optional(),
        status: z.string().max(20).optional(), lastActivity: z.number().optional(), nextSteps: z.array(z.string().max(300)).max(10).optional()
    })).max(300),
    pending: z.array(idTitle.extend({ lineId: z.string().nullable().optional(), machine: z.string().max(60).optional(), updatedAt: z.number().optional(), detail: z.string().max(400).optional() })).max(200),
    active: z.array(idTitle.extend({ lineId: z.string().nullable().optional(), machine: z.string().max(60).optional(), thinking: z.boolean().optional(), status: z.string().max(300).optional() })).max(200),
    recent: z.array(idTitle.extend({ lineId: z.string().nullable().optional(), updatedAt: z.number().optional(), status: z.string().max(300).optional(), completed: z.boolean().optional() })).max(300),
    dismissed: z.array(idTitle).max(500)
})

/** 每个账号同时只跑一份梳理；结果落库，前端轮询 running 直到结束。 */
const briefingRunning = new Set<number>()

async function runBriefing(store: WorkStore, accountId: number, context: BriefingContext): Promise<void> {
    const digest = getDigestService()
    const now = Date.now()
    let result: Briefing
    try {
        if (!digest) throw new Error('Digest service not started')
        const { text, model } = await digest.complete(BRIEFING_SYSTEM_PROMPT, buildBriefingPrompt({ ...context, now }), 3000)
        const parsed = parseBriefing(text, knownIds(context))
        if (!parsed) throw new Error(`unparseable briefing: ${text.slice(0, 120)}`)
        result = { ...parsed, generatedAt: now, model, error: null }
    } catch (error) {
        const previous = store.getBriefing(accountId)
        const old = previous ? JSON.parse(previous.json) as Briefing : null
        result = { summary: old?.summary ?? '', groups: old?.groups ?? [], generatedAt: now, model: old?.model ?? null, error: error instanceof Error ? error.message : String(error) }
    }
    store.saveBriefing(accountId, JSON.stringify(result), now)
}

const sessionPatchSchema = z.object({
    sessionId: z.string().min(1),
    /** 'line' 归到 lineId；'ignored' 明确忽略；'follow' 删掉会话行，跟随目录 / 回到待整理。 */
    state: z.enum(['line', 'ignored', 'follow']),
    lineId: z.string().optional()
})

export function mountWorkRoutes(app: Hono<WebAppEnv>, resolveAccount: ResolveWorkAccount): void {
    const guard = async (c: Context<WebAppEnv>): Promise<{ ok: true; store: WorkStore; accountId: number } | { ok: false; response: Response }> => {
        const store = getWorkStore()
        if (!store) return { ok: false, response: c.json({ error: 'Work overview not started' }, 503) }
        const viewer = await resolveAccount(c)
        if (!viewer.ok) return viewer
        if (!viewer.isAdmin) return { ok: false, response: c.json({ error: 'Admin only' }, 403) }
        return { ok: true, store, accountId: viewer.accountId }
    }
    const fail = (c: Context<WebAppEnv>, error: unknown) => {
        if (error instanceof WorkMapError) return c.json({ error: error.message }, 400)
        throw error
    }

    app.get('/api/work/map', async (c) => {
        const access = await guard(c)
        if (!access.ok) return access.response
        return c.json(access.store.getMap(access.accountId))
    })

    app.put('/api/work/map', async (c) => {
        const access = await guard(c)
        if (!access.ok) return access.response
        const parsed = mapSchema.safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) return c.json({ error: 'Invalid map', issues: parsed.error.issues.slice(0, 5) }, 400)
        try {
            return c.json(access.store.replaceMap(access.accountId, parsed.data))
        } catch (error) {
            return fail(c, error)
        }
    })

    app.put('/api/work/lines', async (c) => {
        const access = await guard(c)
        if (!access.ok) return access.response
        const parsed = lineSchema.safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) return c.json({ error: 'Invalid line' }, 400)
        try {
            return c.json({ line: access.store.upsertLine(access.accountId, parsed.data) })
        } catch (error) {
            return fail(c, error)
        }
    })

    app.delete('/api/work/lines/:id', async (c) => {
        const access = await guard(c)
        if (!access.ok) return access.response
        try {
            access.store.deleteLine(access.accountId, c.req.param('id'))
            return c.json({ ok: true })
        } catch (error) {
            return fail(c, error)
        }
    })

    app.put('/api/work/folders', async (c) => {
        const access = await guard(c)
        if (!access.ok) return access.response
        const parsed = folderPatchSchema.safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) return c.json({ error: 'Invalid folder' }, 400)
        try {
            return c.json({ folder: access.store.setFolder(access.accountId, parsed.data) })
        } catch (error) {
            return fail(c, error)
        }
    })

    // 「需要你处理」里忽略一个会话：不再提醒；同时把它的会话摘要标成已完结，让后续的项目概况 / 梳理待办
    // 也得出「不需要再关注」的结论。取消忽略时，若当初是我们标的完结就撤回。
    app.put('/api/work/dismissed', async (c) => {
        const access = await guard(c)
        if (!access.ok) return access.response
        const parsed = dismissSchema.safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) return c.json({ error: 'Invalid dismissal' }, 400)
        const { sessionId, dismissed } = parsed.data
        const digest = getDigestService()
        if (dismissed) {
            const wasCompleted = digest?.store.getSession(sessionId)?.completed ?? false
            if (digest && !wasCompleted) digest.setCompleted(sessionId, true)
            access.store.setDismissed(access.accountId, sessionId, true, Boolean(digest) && !wasCompleted)
        } else {
            const previous = access.store.setDismissed(access.accountId, sessionId, false)
            if (digest && previous?.markedCompleted) digest.setCompleted(sessionId, false)
        }
        return c.json({ dismissed: access.store.getMap(access.accountId).dismissed })
    })

    app.get('/api/work/briefing', async (c) => {
        const access = await guard(c)
        if (!access.ok) return access.response
        const stored = access.store.getBriefing(access.accountId)
        return c.json({ briefing: stored ? JSON.parse(stored.json) as Briefing : null, running: briefingRunning.has(access.accountId) })
    })

    app.post('/api/work/briefing/refresh', async (c) => {
        const access = await guard(c)
        if (!access.ok) return access.response
        const parsed = briefingContextSchema.safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) return c.json({ error: 'Invalid briefing context', issues: parsed.error.issues.slice(0, 3) }, 400)
        if (!briefingRunning.has(access.accountId)) {
            briefingRunning.add(access.accountId)
            const { store, accountId } = access
            void runBriefing(store, accountId, parsed.data).finally(() => briefingRunning.delete(accountId))
        }
        return c.json({ running: true })
    })

    app.put('/api/work/sessions', async (c) => {
        const access = await guard(c)
        if (!access.ok) return access.response
        const parsed = sessionPatchSchema.safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) return c.json({ error: 'Invalid session assignment' }, 400)
        const { sessionId, state, lineId } = parsed.data
        if (state === 'line' && !lineId) return c.json({ error: 'lineId required' }, 400)
        try {
            const assignment = state === 'follow' ? undefined : { lineId: state === 'line' ? lineId! : null }
            return c.json({ session: access.store.setSession(access.accountId, sessionId, assignment) })
        } catch (error) {
            return fail(c, error)
        }
    })
}
