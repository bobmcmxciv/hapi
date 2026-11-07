import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { GeneratedBlobKind } from '@hapi/protocol/apiTypes'
import { isSafeBlobId } from './blobStore'

export const DEFAULT_BLOB_DOWNLOAD_TICKET_TTL_MS = 10 * 60 * 1000

const FALLBACK_PROCESS_SECRET = randomBytes(32)

export type BlobDownloadTicketClaims = {
    purpose: 'blob-download'
    sid: string
    kind: GeneratedBlobKind
    bid: string
    ns: string
    uid: number
    gaid?: number
    exp: number
}

function toSecretBytes(secret?: Uint8Array | string): Uint8Array {
    if (secret instanceof Uint8Array && secret.byteLength > 0) {
        return secret
    }
    if (typeof secret === 'string' && secret.length > 0) {
        return Buffer.from(secret, 'utf8')
    }
    return FALLBACK_PROCESS_SECRET
}

export function issueBlobDownloadTicket(
    input: {
        sessionId: string
        kind: GeneratedBlobKind
        blobId: string
        namespace: string
        userId: number
        gatewayAccountId?: number
        ttlMs?: number
        now?: number
    },
    secret?: Uint8Array | string
): { ticket: string; expiresAt: number } {
    const now = input.now ?? Date.now()
    const ttlMs = input.ttlMs ?? DEFAULT_BLOB_DOWNLOAD_TICKET_TTL_MS
    const expiresAt = now + Math.max(1_000, ttlMs)
    const claims: BlobDownloadTicketClaims = {
        purpose: 'blob-download',
        sid: input.sessionId,
        kind: input.kind,
        bid: input.blobId,
        ns: input.namespace,
        uid: input.userId,
        ...(typeof input.gatewayAccountId === 'number' ? { gaid: input.gatewayAccountId } : {}),
        exp: expiresAt
    }
    const payloadB64Url = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url')
    const signatureB64Url = createHmac('sha256', toSecretBytes(secret)).update(payloadB64Url).digest().toString('base64url')
    return {
        ticket: `${payloadB64Url}.${signatureB64Url}`,
        expiresAt
    }
}

export function verifyBlobDownloadTicket(
    ticket: string,
    expected: {
        sessionId: string
        kind: GeneratedBlobKind
        blobId: string
        now?: number
    },
    secret?: Uint8Array | string
): { ok: true; claims: BlobDownloadTicketClaims } | { ok: false; reason: 'invalid' | 'expired' | 'scope-mismatch' } {
    if (!ticket || typeof ticket !== 'string') {
        return { ok: false, reason: 'invalid' }
    }
    const dot = ticket.indexOf('.')
    if (dot <= 0 || dot !== ticket.lastIndexOf('.') || dot === ticket.length - 1) {
        return { ok: false, reason: 'invalid' }
    }
    const payloadB64Url = ticket.slice(0, dot)
    const sigB64Url = ticket.slice(dot + 1)

    let providedSig: Buffer
    try {
        providedSig = Buffer.from(sigB64Url, 'base64url')
    } catch {
        return { ok: false, reason: 'invalid' }
    }
    const expectedSig = createHmac('sha256', toSecretBytes(secret)).update(payloadB64Url).digest()
    if (providedSig.byteLength !== expectedSig.byteLength || !timingSafeEqual(providedSig, expectedSig)) {
        return { ok: false, reason: 'invalid' }
    }

    let parsed: unknown
    try {
        parsed = JSON.parse(Buffer.from(payloadB64Url, 'base64url').toString('utf8'))
    } catch {
        return { ok: false, reason: 'invalid' }
    }
    if (!parsed || typeof parsed !== 'object') {
        return { ok: false, reason: 'invalid' }
    }
    const record = parsed as Record<string, unknown>
    if (
        record.purpose !== 'blob-download'
        || typeof record.sid !== 'string'
        || (record.kind !== 'file' && record.kind !== 'image')
        || typeof record.bid !== 'string'
        || typeof record.ns !== 'string'
        || typeof record.uid !== 'number'
        || typeof record.exp !== 'number'
    ) {
        return { ok: false, reason: 'invalid' }
    }

    if (
        record.sid !== expected.sessionId
        || record.kind !== expected.kind
        || record.bid !== expected.blobId
    ) {
        return { ok: false, reason: 'scope-mismatch' }
    }

    const now = expected.now ?? Date.now()
    if (now > record.exp) {
        return { ok: false, reason: 'expired' }
    }

    return {
        ok: true,
        claims: {
            purpose: 'blob-download',
            sid: record.sid,
            kind: record.kind,
            bid: record.bid,
            ns: record.ns,
            uid: record.uid,
            ...(typeof record.gaid === 'number' ? { gaid: record.gaid } : {}),
            exp: record.exp
        }
    }
}

export function parseBlobDownloadRoutePath(
    path: string
): { sessionId: string; kind: GeneratedBlobKind; blobId: string } | null {
    const match = /^\/api\/sessions\/([^/]+)\/generated-(files|images)\/([^/]+)$/.exec(path)
    if (!match?.[1] || !match[2] || !match[3]) {
        return null
    }
    try {
        const sessionId = decodeURIComponent(match[1])
        const kind: GeneratedBlobKind = match[2] === 'files' ? 'file' : 'image'
        const blobId = decodeURIComponent(match[3])
        if (!sessionId || !isSafeBlobId(blobId)) {
            return null
        }
        return { sessionId, kind, blobId }
    } catch {
        return null
    }
}
