import { Hono } from 'hono'
import { ForceSendQueuedRequestSchema, MessagesQuerySchema, QueuedStateRequestSchema, SendMessageRequestSchema, messageQueryPosition } from '@hapi/protocol'
import type { SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { reauthorizeSession, requireSessionFromParam, requireSyncEngine } from './guards'
import { MessageTurnQueryError } from '../../sync/messageService'

export function createMessagesRoutes(getSyncEngine: () => SyncEngine | null): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.post('/sessions/:id/messages/force-send', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) return engine
        const session = requireSessionFromParam(c, engine)
        if (session instanceof Response) return session
        const parsed = ForceSendQueuedRequestSchema.safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) return c.json({ error: 'Invalid body', details: parsed.error.flatten() }, 400)
        const access = await reauthorizeSession(c, engine, session.sessionId)
        if (access instanceof Response) return access
        const result = await engine.forceSendQueuedMessages(session.sessionId, {
            ...parsed.data,
            ...(parsed.data.localIds ? { localIds: [...new Set(parsed.data.localIds)] } : {})
        })
        const stillAllowed = await reauthorizeSession(c, engine, session.sessionId)
        return stillAllowed instanceof Response ? stillAllowed : c.json(result)
    })

    app.get('/sessions/:id/messages', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }
        const sessionId = sessionResult.sessionId

        const parsed = MessagesQuerySchema.safeParse(c.req.query())
        if (!parsed.success) {
            return c.json({ error: 'Invalid query', issues: parsed.error.flatten() }, 400)
        }

        const limit = parsed.data.limit ?? 50
        const before = messageQueryPosition(parsed.data, 'before')
        const after = messageQueryPosition(parsed.data, 'after')
        const until = messageQueryPosition(parsed.data, 'until')
        try {
            if (parsed.data.turns !== undefined || parsed.data.turnId !== undefined) {
                await engine.prepareMessageTurnIndex(sessionId)
                // Preparation yields; ownership/revocation may change while it runs.
                const currentAccess = await reauthorizeSession(c, engine, sessionId)
                if (currentAccess instanceof Response) return currentAccess
            }
            return c.json(engine.getMessagesPage(sessionId, {
                limit,
                ...(parsed.data.orderVersion !== undefined ? { orderVersion: parsed.data.orderVersion } : {}),
                ...(parsed.data.turns !== undefined ? { turns: parsed.data.turns } : {}),
                ...(parsed.data.turnId !== undefined ? { turnId: parsed.data.turnId } : {}),
                before,
                after,
                until,
                epoch: parsed.data.epoch ?? null
            }))
        } catch (error) {
            if (error instanceof MessageTurnQueryError) {
                return c.json({
                    error: error.message,
                    code: error.status === 404 ? 'message_turn_not_found' : 'message_turn_cursor_invalid'
                }, error.status)
            }
            throw error
        }
    })

    app.delete('/sessions/:id/messages/:messageId', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }
        const sessionId = sessionResult.sessionId
        const messageId = c.req.param('messageId')

        const result = await engine.cancelQueuedMessage(sessionId, messageId)
        return c.json(result)
    })

    app.post('/sessions/:id/messages/queued-state', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }
        const sessionId = sessionResult.sessionId

        const body = await c.req.json().catch(() => null)
        const parsed = QueuedStateRequestSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body', issues: parsed.error.flatten() }, 400)
        }

        const localIds = [...new Set(parsed.data.localIds)]
        if (localIds.length === 0) {
            return c.json({ queuedLocalIds: [], invokedLocalMessages: [] })
        }
        return c.json(engine.getQueuedState(sessionId, localIds))
    })

    app.post('/sessions/:id/messages', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine, { requireActive: true })
        if (sessionResult instanceof Response) {
            return sessionResult
        }
        const sessionId = sessionResult.sessionId

        const body = await c.req.json().catch(() => null)
        const parsed = SendMessageRequestSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body', issues: parsed.error.flatten() }, 400)
        }

        // Require text or attachments
        if (!parsed.data.text && (!parsed.data.attachments || parsed.data.attachments.length === 0)) {
            return c.json({ error: 'Message requires text or attachments' }, 400)
        }

        const deliveryMetadata = c.get('deliveryMetadata') ?? {}
        await engine.sendMessage(sessionId, {
            text: parsed.data.text,
            localId: parsed.data.localId,
            attachments: parsed.data.attachments,
            ompInputMode: parsed.data.ompInputMode,
            sentFrom: 'webapp',
            scheduledAt: parsed.data.scheduledAt,
            deliveryMetadata,
            deliveryMode: parsed.data.deliveryMode
        })
        return c.json({ ok: true })
    })

    return app
}
