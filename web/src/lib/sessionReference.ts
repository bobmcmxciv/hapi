import type { SessionSummary } from '@/types/api'
import {
    deduplicateSessionsByAgentId,
    isSidebarEmptySessionStub,
    normalizeSearch,
    sessionMatchesQuery,
} from '@/components/SessionList'
import { truncateGraphemes } from '@/lib/graphemes'
import { getSessionTitle } from '@/lib/sessionTitle'
import { getWorktreeSessionLabel } from '@/lib/sessionWorktreeLabel'
import { SESSION_REFERENCE_STEER_SUFFIX } from '@hapi/protocol/sessionCitation'

export function buildSessionReferencePath(sessionId: string): string {
    const base = import.meta.env.BASE_URL ?? '/'
    const normalizedBase = base.endsWith('/') ? base : `${base}/`
    return `${normalizedBase}sessions/${encodeURIComponent(sessionId)}`.replace(/\/{2,}/g, '/')
}

function sanitizeSessionReferenceTitle(sessionTitle: string): string {
    return truncateGraphemes(sessionTitle.replace(/\s+/g, ' ').trim(), 120)
}

/** Clipboard text for citing this session in another HAPI chat (not a public share link). */
export function buildSessionReferenceText(sessionTitle: string, sessionId: string): string {
    const path = buildSessionReferencePath(sessionId)
    const title = sanitizeSessionReferenceTitle(sessionTitle)
    const base = title
        ? `See session ${JSON.stringify(title)} (${path}) for context`
        : `See HAPI session ${path} for context`
    return `${base}.${SESSION_REFERENCE_STEER_SUFFIX}`
}

export type MatchSessionsForMentionOptions = {
    excludeId?: string
    limit?: number
    /** Canonical project directory (`worktree?.basePath ?? path`) of the current session. */
    currentDirectory?: string | null
    /** Machine ID (`metadata?.machineId`) of the current session. */
    currentMachineId?: string | null
    /** Same resolver share/sidebar pass into `sessionMatchesQuery`. */
    resolveMachineLabel?: (machineId: string | null) => string
}

export function normalizeSessionDirectory(dir: string | null | undefined): string | null {
    const trimmed = (dir ?? '').trim()
    if (!trimmed) return null
    const unified = trimmed.replace(/\\/g, '/').replace(/\/+$/, '') || '/'
    return /^[a-zA-Z]:(\/|$)/.test(unified) ? unified.toLowerCase() : unified
}

export function getSessionCanonicalDirectory(
    session: Pick<SessionSummary, 'metadata'> | null | undefined
): string | null {
    return normalizeSessionDirectory(
        session?.metadata?.worktree?.basePath ?? session?.metadata?.path ?? null
    )
}

function isSameSessionDirectory(
    session: SessionSummary,
    normalizedCurrentDir: string | null,
    currentMachineId: string | null
): boolean {
    if (!normalizedCurrentDir) return false
    const sessionMachineId = session.metadata?.machineId?.trim() || null
    if (currentMachineId && sessionMachineId && currentMachineId !== sessionMachineId) {
        return false
    }
    const candidates = [
        session.metadata?.worktree?.basePath,
        session.metadata?.path,
        session.metadata?.worktree?.worktreePath,
    ]
    return candidates.some((candidate) => normalizeSessionDirectory(candidate) === normalizedCurrentDir)
}

type SessionMentionLocality = {
    sameDirectory: boolean
    sameMachine: boolean
}

/**
 * Rank score for a session that already passed `sessionMatchesQuery`.
 * Prefer current-directory active sessions first, then current-directory inactive sessions,
 * then official-title / id hits over summary-or-path-only matches; then active + recency.
 */
function scoreMatchedSession(
    session: SessionSummary,
    query: string,
    locality: SessionMentionLocality
): number {
    const title = getSessionTitle(session).toLowerCase()
    const id = session.id.toLowerCase()
    const idPrefix = id.slice(0, 8)
    const summaryText = (session.metadata?.summary?.text ?? '').toLowerCase()
    const worktreeLabel = (getWorktreeSessionLabel(session) ?? '').toLowerCase()

    // Matched via summary/worktree vs path/machine-only — keep below id/title tiers.
    let score = summaryText.includes(query) || worktreeLabel.includes(query) ? 175 : 125
    if (title === query) score = 500
    else if (title.startsWith(query)) score = 400
    else if (title.includes(query)) score = 300
    else if (idPrefix.startsWith(query) || id.startsWith(query)) score = 200
    else if (id.includes(query)) score = 100

    if (locality.sameDirectory && session.active) score += 1000
    else if (locality.sameDirectory) score += 500
    else if (locality.sameMachine && session.active) score += 25

    if (session.active) score += 50
    if (session.metadata?.lifecycleState === 'archived') score -= 25
    return score * 1e13 + session.updatedAt
}

/**
 * Rank sessions for composer `@` autocomplete.
 * Match filter is the same code path as share/sidebar search (`sessionMatchesQuery`).
 * Display/insert still use `getSessionTitle` (name before summary).
 * Empty query → current-directory active first, then current-directory recent, then other active
 * (excludes archived and empty inactive stubs).
 */
export function matchSessionsForMention(
    sessions: readonly SessionSummary[],
    query: string,
    options: MatchSessionsForMentionOptions = {}
): SessionSummary[] {
    const limit = options.limit ?? 20
    const excludeId = options.excludeId
    const resolveMachineLabel = options.resolveMachineLabel ?? (() => '')
    const normalized = normalizeSearch(query)
    const normalizedCurrentDir = normalizeSessionDirectory(options.currentDirectory)
    const currentMachineId = options.currentMachineId?.trim() || null

    const deduplicated = deduplicateSessionsByAgentId([...sessions], excludeId)

    const scored: { session: SessionSummary; score: number }[] = []
    const fallbackInactiveOtherDir: { session: SessionSummary; score: number }[] = []

    for (const session of deduplicated) {
        if (excludeId && session.id === excludeId) continue

        const sessionMachineId = session.metadata?.machineId?.trim() || null
        const sameMachine = Boolean(currentMachineId && sessionMachineId && currentMachineId === sessionMachineId)
        const sameDirectory = isSameSessionDirectory(session, normalizedCurrentDir, currentMachineId)

        if (!normalized) {
            // Empty / whitespace query: shortlist only — current-directory active first, then
            // current-directory recent, then other active. Archived and empty inactive stubs omitted.
            if (session.metadata?.lifecycleState === 'archived') continue
            if (isSidebarEmptySessionStub(session)) continue

            if (normalizedCurrentDir) {
                if (sameDirectory && session.active) {
                    scored.push({ session, score: 4000 * 1e13 + session.updatedAt })
                } else if (sameDirectory) {
                    scored.push({ session, score: 3000 * 1e13 + session.updatedAt })
                } else if (session.active && sameMachine) {
                    scored.push({ session, score: 2000 * 1e13 + session.updatedAt })
                } else if (session.active) {
                    scored.push({ session, score: 1000 * 1e13 + session.updatedAt })
                } else {
                    fallbackInactiveOtherDir.push({ session, score: session.updatedAt })
                }
            } else {
                const score = (session.active ? 1000 : 0) * 1e13 + session.updatedAt
                scored.push({ session, score })
            }
            continue
        }

        const machineLabel = resolveMachineLabel(session.metadata?.machineId ?? null)
        if (!sessionMatchesQuery(session, normalized, machineLabel)) continue
        scored.push({
            session,
            score: scoreMatchedSession(session, normalized, { sameDirectory, sameMachine }),
        })
    }

    const candidates = !normalized && normalizedCurrentDir && scored.length === 0
        ? fallbackInactiveOtherDir
        : scored

    candidates.sort((a, b) => b.score - a.score)
    return candidates.slice(0, limit).map((entry) => entry.session)
}

/** Match in-app session paths produced by buildSessionReferencePath (optional BASE_URL). */
const SESSION_PATH_RE = /^(?:\.?\/)?(?:[\w.-]+\/)*sessions\/([^/?#]+)\/?$/

/**
 * Hub session ids are UUIDs (no dots). Reject dotted tails so source paths like
 * `web/src/routes/sessions/chat.tsx` stay available for file-path autolinking.
 */
function isPlausibleSessionId(id: string): boolean {
    return id.length > 0 && !id.includes('.')
}

/** Parse a session id from a relative `/sessions/<id>` (or BASE_URL-prefixed) href. */
export function parseSessionPathHref(href: string): string | null {
    const trimmed = href.trim()
    if (!trimmed || /^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null
    const match = SESSION_PATH_RE.exec(trimmed)
    if (!match) return null
    try {
        const id = decodeURIComponent(match[1] ?? '')
        return isPlausibleSessionId(id) ? id : null
    } catch {
        return null
    }
}

/** Live / fallback fields for composer mention chip hover tooltips. */
export type SessionMentionTooltipSource = {
    id: string
    title: string
    active: boolean
    lifecycleState?: string | null
    path?: string | null
    worktreePath?: string | null
    /** Preformatted relative time (sidebar "ago"), when available. */
    relativeTime?: string | null
    thinking?: boolean
    /** Sidebar attention label (permission / input / unread / …). */
    attentionLabel?: string | null
}

export type SessionMentionTooltipModel = {
    title: string
    lines: string[]
    ariaLabel: string
}

/**
 * Expand a truncated `@chip` into full title + meta for aria-label / fallback tip.
 * Visual hover uses SessionRowSummary when a live SessionSummary is available.
 */
export function formatSessionMentionTooltip(
    session: SessionMentionTooltipSource | null,
    fallbackTitle: string,
    id: string
): SessionMentionTooltipModel {
    const shortId = id.slice(0, 8)
    const rawTitle = (session?.title || fallbackTitle || shortId).replace(/\s+/g, ' ').trim()
    const title = rawTitle || shortId

    let status: string | null = null
    if (session) {
        if (session.lifecycleState === 'archived') status = 'Archived'
        else if (session.thinking) status = 'Thinking'
        else if (session.attentionLabel) status = session.attentionLabel
        else status = session.active ? 'Active' : 'Inactive'
    }

    const path = (session?.worktreePath || session?.path || '').trim() || null
    const lines: string[] = [
        status ? `Session · ${shortId} · ${status}` : `Session · ${shortId}`,
    ]
    const ago = session?.relativeTime?.trim()
    if (ago) lines.push(ago)
    if (path) lines.push(path)

    return {
        title,
        lines,
        ariaLabel: [title, ...lines].join('. '),
    }
}
