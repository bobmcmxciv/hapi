import type { Context, Hono } from 'hono'
import type { WebAppEnv } from '../../hub/src/web/middleware/auth'
import { getDigestService, projectKeyOf, type DigestSessionView } from './digestService'

/** 由 executionMount 注入：按网关账号解析出可见会话集，无权时直接给出响应。 */
export type ResolveDigestViewer = (c: Context<WebAppEnv>) => Promise<
    | { ok: true; sessions: DigestSessionView[]; isAdmin: boolean }
    | { ok: false; response: Response }
>

export function mountDigestRoutes(app: Hono<WebAppEnv>, resolveViewer: ResolveDigestViewer): void {
    const unavailable = (c: Context<WebAppEnv>) => c.json({ error: 'Digest service not started' }, 503)

    // 会话列表用的轻量索引：只带完结标记，不带正文（1000+ 会话时正文会有几百 KB）。
    app.get('/api/digests/sessions', async (c) => {
        const service = getDigestService()
        if (!service) return unavailable(c)
        const viewer = await resolveViewer(c)
        if (!viewer.ok) return viewer.response
        const visible = new Set(viewer.sessions.map(session => session.id))
        const index: Record<string, { completed: boolean; suggestComplete: boolean; hasDigest: boolean; status: string }> = {}
        for (const digest of service.store.listSessions()) {
            if (!visible.has(digest.sessionId)) continue
            if (!digest.generatedAt && !digest.completed) continue
            index[digest.sessionId] = {
                completed: digest.completed,
                suggestComplete: digest.suggestComplete,
                hasDigest: digest.generatedAt !== null,
                // 左侧列表每行一句现状；截短控制索引体积（1000+ 会话时整份仍在 ~150KB）。
                status: digest.status.slice(0, 80)
            }
        }
        return c.json({ digests: index })
    })

    app.get('/api/digests/sessions/:id', async (c) => {
        const service = getDigestService()
        if (!service) return unavailable(c)
        const viewer = await resolveViewer(c)
        if (!viewer.ok) return viewer.response
        const id = c.req.param('id')
        if (!viewer.sessions.some(session => session.id === id)) return c.json({ error: 'Session not found' }, 404)
        const digest = service.store.getSession(id)
        // state：手动「重新总结」排队中或正在跑；running 保留给旧前端（排队也算，界面才会持续轮询）。
        const state = service.sessionState(id)
        return c.json({
            digest: digest && (digest.generatedAt || digest.completed || digest.error) ? digest : null,
            running: state !== null,
            state
        })
    })

    app.post('/api/digests/sessions/:id/refresh', async (c) => {
        const service = getDigestService()
        if (!service) return unavailable(c)
        const viewer = await resolveViewer(c)
        if (!viewer.ok) return viewer.response
        const id = c.req.param('id')
        if (!viewer.sessions.some(session => session.id === id)) return c.json({ error: 'Session not found' }, 404)
        service.requestSession(id)
        return c.json({ ok: true })
    })

    app.post('/api/digests/sessions/:id/complete', async (c) => {
        const service = getDigestService()
        if (!service) return unavailable(c)
        const viewer = await resolveViewer(c)
        if (!viewer.ok) return viewer.response
        const id = c.req.param('id')
        if (!viewer.sessions.some(session => session.id === id)) return c.json({ error: 'Session not found' }, 404)
        const body = await c.req.json().catch(() => null) as { completed?: unknown } | null
        if (typeof body?.completed !== 'boolean') return c.json({ error: 'completed must be boolean' }, 400)
        return c.json({ digest: service.setCompleted(id, body.completed) })
    })

    app.get('/api/digests/projects', async (c) => {
        const service = getDigestService()
        if (!service) return unavailable(c)
        const viewer = await resolveViewer(c)
        if (!viewer.ok) return viewer.response
        const keys = new Set(viewer.sessions.map(session => projectKeyOf(session).key))
        const projects = service.store.listProjects().filter(project => keys.has(project.projectKey))
        const pending: Record<string, 'running' | 'queued'> = {}
        for (const key of keys) {
            const state = service.projectState(key)
            if (state) pending[key] = state
        }
        return c.json({ projects, pending })
    })

    app.post('/api/digests/projects/refresh', async (c) => {
        const service = getDigestService()
        if (!service) return unavailable(c)
        const viewer = await resolveViewer(c)
        if (!viewer.ok) return viewer.response
        const body = await c.req.json().catch(() => null) as { key?: unknown } | null
        const key = typeof body?.key === 'string' ? body.key : null
        if (!key || !viewer.sessions.some(session => projectKeyOf(session).key === key)) {
            return c.json({ error: 'Project not found' }, 404)
        }
        service.requestProject(key)
        return c.json({ ok: true })
    })

    // 「全部项目重新梳理」（admin）：把可见会话涉及的全部项目按最近活动排进强制队列。
    app.post('/api/digests/projects/refresh-all', async (c) => {
        const service = getDigestService()
        if (!service) return unavailable(c)
        const viewer = await resolveViewer(c)
        if (!viewer.ok) return viewer.response
        if (!viewer.isAdmin) return c.json({ error: 'Admin only' }, 403)
        const latest = new Map<string, number>()
        for (const session of viewer.sessions) {
            const { key } = projectKeyOf(session)
            latest.set(key, Math.max(latest.get(key) ?? 0, session.updatedAt))
        }
        const keys = [...latest.entries()].sort((a, b) => b[1] - a[1]).map(([key]) => key)
        return c.json({ queued: service.requestAllProjects(keys) })
    })

    app.get('/api/digests/settings', async (c) => {
        const service = getDigestService()
        if (!service) return unavailable(c)
        const viewer = await resolveViewer(c)
        if (!viewer.ok) return viewer.response
        if (!viewer.isAdmin) return c.json({ error: 'Admin only' }, 403)
        return c.json(service.status())
    })

    app.put('/api/digests/settings', async (c) => {
        const service = getDigestService()
        if (!service) return unavailable(c)
        const viewer = await resolveViewer(c)
        if (!viewer.ok) return viewer.response
        if (!viewer.isAdmin) return c.json({ error: 'Admin only' }, 403)
        const body = await c.req.json().catch(() => null) as Record<string, unknown> | null
        if (!body) return c.json({ error: 'Invalid body' }, 400)
        const patch: Parameters<typeof service.updateSettings>[0] = {}
        if (typeof body.enabled === 'boolean') patch.enabled = body.enabled
        if (typeof body.autoRename === 'boolean') patch.autoRename = body.autoRename
        if (typeof body.model === 'string' && body.model.trim()) patch.model = body.model.trim()
        if (typeof body.maxPerHour === 'number' && Number.isFinite(body.maxPerHour)) patch.maxPerHour = body.maxPerHour
        service.updateSettings(patch)
        return c.json(service.status())
    })

    app.get('/api/digests/models', async (c) => {
        const service = getDigestService()
        if (!service) return unavailable(c)
        const viewer = await resolveViewer(c)
        if (!viewer.ok) return viewer.response
        if (!viewer.isAdmin) return c.json({ error: 'Admin only' }, 403)
        try {
            return c.json({ models: await service.listModels() })
        } catch (error) {
            return c.json({ models: [], error: error instanceof Error ? error.message : String(error) })
        }
    })
}
