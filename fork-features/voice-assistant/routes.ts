import type { Context, Hono } from 'hono'
import { z } from 'zod'
import type { WebAppEnv } from '../../hub/src/web/middleware/auth'
import type { VoiceSessionView } from './material'
import { VoiceAssistantUnavailableError, getVoiceAssistant } from './service'
import { getVoiceTtsStatus, proxyVoiceTts } from './tts'

/** 由 executionMount 注入：按网关账号解析出可见会话集，无权时直接给出响应。 */
export type ResolveVoiceViewer = (c: Context<WebAppEnv>) => Promise<
    | { ok: true; sessions: VoiceSessionView[] }
    | { ok: false; response: Response }
>

const historySchema = z.array(z.object({
    q: z.string().max(1000),
    a: z.string().max(2000)
})).max(8).optional()

const askSchema = z.object({
    sessionId: z.string().min(1),
    question: z.string().trim().min(1).max(500),
    history: historySchema
})

const prepareSchema = z.object({
    currentSessionId: z.string().min(1),
    utterance: z.string().trim().min(1).max(2000),
    targetHint: z.string().trim().max(200).optional(),
    history: historySchema
})

const ttsSchema = z.object({ text: z.string().trim().min(1).max(600) })

function failure(c: Context<WebAppEnv>, error: unknown): Response {
    if (error instanceof VoiceAssistantUnavailableError) return c.json({ error: error.message }, 503)
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[VoiceAssistant] request failed: ${message}`)
    return c.json({ error: message }, 502)
}

export function mountVoiceAssistantRoutes(app: Hono<WebAppEnv>, resolveViewer: ResolveVoiceViewer): void {
    app.get('/api/voice/assistant/status', async (c) => {
        const viewer = await resolveViewer(c)
        if (!viewer.ok) return viewer.response
        const assistant = getVoiceAssistant()
        return c.json({ configured: assistant?.configured() ?? false, providers: assistant?.providerLabels() ?? [] })
    })

    // 曼波朗读：状态（网页据此决定百炼出声还是只出文字）与流式合成。
    app.get('/api/voice/tts/status', async (c) => {
        const viewer = await resolveViewer(c)
        if (!viewer.ok) return viewer.response
        return c.json(await getVoiceTtsStatus())
    })

    app.post('/api/voice/tts', async (c) => {
        const viewer = await resolveViewer(c)
        if (!viewer.ok) return viewer.response
        const parsed = ttsSchema.safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) return c.json({ error: 'Invalid body' }, 400)
        return await proxyVoiceTts(parsed.data.text, c.req.raw.signal)
    })

    app.post('/api/voice/session-qa', async (c) => {
        const assistant = getVoiceAssistant()
        if (!assistant) return c.json({ error: 'Voice assistant not started' }, 503)
        const viewer = await resolveViewer(c)
        if (!viewer.ok) return viewer.response
        const parsed = askSchema.safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) return c.json({ error: 'Invalid body', issues: parsed.error.flatten() }, 400)
        if (!viewer.sessions.some((session) => session.id === parsed.data.sessionId)) {
            return c.json({ error: 'Session not found' }, 404)
        }
        try {
            return c.json(await assistant.ask({ ...parsed.data, candidates: viewer.sessions }))
        } catch (error) {
            return failure(c, error)
        }
    })

    app.post('/api/voice/instruction/prepare', async (c) => {
        const assistant = getVoiceAssistant()
        if (!assistant) return c.json({ error: 'Voice assistant not started' }, 503)
        const viewer = await resolveViewer(c)
        if (!viewer.ok) return viewer.response
        const parsed = prepareSchema.safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) return c.json({ error: 'Invalid body', issues: parsed.error.flatten() }, 400)
        if (!viewer.sessions.some((session) => session.id === parsed.data.currentSessionId)) {
            return c.json({ error: 'Session not found' }, 404)
        }
        try {
            return c.json(await assistant.prepareInstruction({ ...parsed.data, candidates: viewer.sessions }))
        } catch (error) {
            return failure(c, error)
        }
    })
}
