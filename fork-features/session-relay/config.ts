import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'

/**
 * fork(session-relay): per-project opt-in, read from `<cwd>/.hapi/session-relay.json`.
 *
 * Long-running game automation (maa-agent, fgo-agent) keeps one agent run going
 * for days. When its context filled, OMP compacted in place and the session kept
 * going on a lossy summary, repeating finished steps. With this file present the
 * session instead writes a handover file, HAPI starts a fresh session in the same
 * directory with the same agent settings, hands it the file, and archives the old one.
 */
export const SESSION_RELAY_CONFIG_PATH = join('.hapi', 'session-relay.json')

const SessionRelayConfigSchema = z.object({
    enabled: z.boolean().default(true),
    /** Relay once the context holds this many tokens (OMP's own compaction was seen from 58k). */
    thresholdTokens: z.number().int().positive().default(50_000),
    /** ...or this share of the model context window, whichever comes first. */
    thresholdPercent: z.number().positive().max(100).default(60),
    /** The context must have grown by this much in this process before a relay can start. */
    minGrowthTokens: z.number().int().nonnegative().default(10_000),
    /** Relay after OMP finished an automatic compaction, even below the thresholds. */
    relayAfterCompaction: z.boolean().default(true),
    /** Project-relative handover file the outgoing session writes and the successor reads. */
    handoffFile: z.string().min(1).default('_build/HANDOVER.md'),
    /** Give up waiting for the outgoing run to end after this long and relay anyway. */
    maxWaitMinutes: z.number().positive().default(45),
    /** Once the handover file changed, relay this long after its last write even if the run goes on. */
    settleMinutes: z.number().nonnegative().default(3),
    /** Extra project-specific lines appended to the handover request. */
    handoffNotes: z.string().optional(),
    /** Extra project-specific lines appended to the successor's first message. */
    kickoffNotes: z.string().optional()
})

export type SessionRelayConfig = z.infer<typeof SessionRelayConfigSchema>

export function parseSessionRelayConfig(raw: unknown): SessionRelayConfig {
    return SessionRelayConfigSchema.parse(raw ?? {})
}

/** Returns null when the project has no relay file or it disables relaying; throws on an invalid file. */
export async function loadSessionRelayConfig(cwd: string): Promise<SessionRelayConfig | null> {
    let text: string
    try {
        text = await readFile(join(cwd, SESSION_RELAY_CONFIG_PATH), 'utf8')
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
    }
    const config = parseSessionRelayConfig(JSON.parse(text.replace(/^﻿/, '')))
    return config.enabled ? config : null
}
