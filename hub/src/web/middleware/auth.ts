import type { MiddlewareHandler } from 'hono'
import { z } from 'zod'
import { jwtVerify } from 'jose'
import { parseBlobDownloadRoutePath, verifyBlobDownloadTicket } from '../../blobs'
export type WebAppEnv = {
 Variables: {
  userId: number
  namespace: string
  deliveryMetadata?: Record<string, unknown>
  /** Revalidate the authenticated resource grant after an asynchronous read preparation. */
  reauthorizeResource?: () => Promise<Response | null>
  /**
   * fork(multi-user): canonical directory-subtree union; null/undefined = unrestricted.
   * Written by createExecutionMiddleware; [] always fails closed.
   */
  machinePathScope?: readonly string[] | null
 }
}

const jwtPayloadSchema = z.object({
 uid: z.number(),
 ns: z.string()
})

export function createAuthMiddleware(jwtSecret: Uint8Array): MiddlewareHandler<WebAppEnv> {
 return async (c, next) => {
  const path = c.req.path
  if (path === '/api/auth' || path === '/api/bind') {
   await next()
   return
  }

  const authorization = c.req.header('authorization')
  const tokenFromHeader = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : undefined
  const tokenFromQuery = (path === '/api/events' || /^\/api\/sessions\/[^/]+\/runtime\/events$/.test(path)) ? c.req.query().token : undefined
  const token = tokenFromHeader ?? tokenFromQuery

  if (!token && (c.req.method === 'GET' || c.req.method === 'HEAD')) {
   const ticket = c.req.query('ticket')
   const blobRoute = ticket ? parseBlobDownloadRoutePath(path) : null
   if (ticket && blobRoute) {
    const verifiedTicket = verifyBlobDownloadTicket(ticket, blobRoute, jwtSecret)
    if (!verifiedTicket.ok) {
     return c.json({
      error: verifiedTicket.reason === 'expired' ? 'Download ticket expired' : 'Invalid download ticket',
      reason: verifiedTicket.reason === 'expired' ? 'ticket-expired' : 'invalid-ticket'
     }, 401)
    }
    c.set('userId', verifiedTicket.claims.uid)
    c.set('namespace', verifiedTicket.claims.ns)
    if (typeof verifiedTicket.claims.gaid === 'number') {
     c.set('deliveryMetadata', { gatewayAccountId: verifiedTicket.claims.gaid })
    }
    await next()
    return
   }
  }

  if (!token) {
   return c.json({ error: 'Missing authorization token' }, 401)
  }

  try {
   const verified = await jwtVerify(token, jwtSecret, { algorithms: ['HS256'] })
   const parsed = jwtPayloadSchema.safeParse(verified.payload)
   if (!parsed.success) {
    return c.json({ error: 'Invalid token payload' }, 401)
   }

   c.set('userId', parsed.data.uid)
   c.set('namespace', parsed.data.ns)
   await next()
   return
  } catch {
   return c.json({ error: 'Invalid token' }, 401)
  }
 }
}
