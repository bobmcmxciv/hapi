import type { Context, Hono } from 'hono'
import { z } from 'zod'
import type { WebAppEnv } from '../../hub/src/web/middleware/auth'
import { getWorkStore, WorkMapError, type WorkStore } from './workStore'

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
