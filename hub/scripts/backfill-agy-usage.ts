#!/usr/bin/env bun
/**
 * Export and backfill historical Antigravity (agy / Gemini) usage metadata
 * from ~/.gemini/antigravity-cli/conversations/*.db into HAPI's SQLite store.
 *
 * Usage:
 *   bun run hub/scripts/backfill-agy-usage.ts --export=agy-usage.jsonl
 *   bun run hub/scripts/backfill-agy-usage.ts --apply=agy-usage.jsonl [--db=/path/to/hapi.db] [--dry-run]
 */

import { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
    resolveAgyTurnMetadataFromRows,
    type AgyConversationRow,
} from '../../cli/src/agy/utils/agyConversationModel'
import type { AgyTokenUsage } from '../../cli/src/agy/utils/agyTranscriptTypes'
import { decodeMessageContent, encodeMessageContent } from '../src/store/contentCodec'
import { bumpMessageEpoch } from '../src/store/messages'

export type ExportedAgyUsageRecord = {
    brainUuid: string
    stepIndex: number
    messageId: string
    model: string
    timestamp: string
    usage: AgyTokenUsage
}

const UUID_FILE_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.db$/i

function readTranscriptStepTimestamps(agyRootDir: string, brainUuid: string): Map<number, string> {
    const out = new Map<number, string>()
    const candidates = [
        join(agyRootDir, 'brain', brainUuid, '.system_generated', 'logs', 'transcript_full.jsonl'),
        join(agyRootDir, 'brain', brainUuid, '.system_generated', 'logs', 'transcript.jsonl'),
    ]
    for (const filePath of candidates) {
        if (!existsSync(filePath)) continue
        try {
            const text = readFileSync(filePath, 'utf-8')
            for (const line of text.split(/\r?\n/)) {
                if (!line.trim()) continue
                try {
                    const parsed = JSON.parse(line) as {
                        step_index?: unknown
                        type?: unknown
                        created_at?: unknown
                    }
                    if (
                        typeof parsed.step_index === 'number' &&
                        Number.isInteger(parsed.step_index) &&
                        typeof parsed.created_at === 'string' &&
                        parsed.created_at
                    ) {
                        out.set(parsed.step_index, parsed.created_at)
                    }
                } catch {
                    // ignore malformed line
                }
            }
            if (out.size > 0) break
        } catch {
            // ignore unreadable file
        }
    }
    return out
}

export function exportAgyUsageFromConversations(
    agyRootDir = join(homedir(), '.gemini', 'antigravity-cli')
): ExportedAgyUsageRecord[] {
    const convDir = join(agyRootDir, 'conversations')
    if (!existsSync(convDir)) {
        throw new Error(`Conversations directory not found: ${convDir}`)
    }
    const records: ExportedAgyUsageRecord[] = []
    const files = readdirSync(convDir).sort()

    for (const file of files) {
        const match = UUID_FILE_RE.exec(file)
        if (!match) continue
        const brainUuid = match[1].toLowerCase()
        const dbPath = join(convDir, file)
        let fallbackIso = new Date().toISOString()
        try {
            fallbackIso = statSync(dbPath).mtime.toISOString()
        } catch {
            // ignore stat error
        }

        const stepTimestamps = readTranscriptStepTimestamps(agyRootDir, brainUuid)
        let rows: AgyConversationRow[] = []
        let stepIndexes: number[] = []
        let db: Database | null = null
        try {
            db = new Database(dbPath, { readonly: true })
            const rawRows = db
                .query(
                    `SELECT 'step' AS kind, idx, metadata AS data FROM steps WHERE step_type = 15
                     UNION ALL
                     SELECT 'generation' AS kind, idx, data FROM gen_metadata
                     ORDER BY kind, idx`
                )
                .all() as Array<{ kind: 'step' | 'generation'; idx: number; data: Uint8Array | Buffer | null }>

            rows = rawRows
                .filter((row) => row.data !== null && row.data !== undefined)
                .map((row) => ({
                    kind: row.kind,
                    idx: Number(row.idx),
                    data: Buffer.from(row.data!),
                }))
            stepIndexes = rows
                .filter((row) => row.kind === 'step')
                .map((row) => row.idx)
                .sort((a, b) => a - b)
        } catch {
            continue
        } finally {
            try {
                db?.close()
            } catch {
                // ignore close error
            }
        }

        if (stepIndexes.length === 0) continue
        const resolved = resolveAgyTurnMetadataFromRows(stepIndexes, rows)
        const seenUsageIds = new Set<string>()

        for (const stepIndex of stepIndexes) {
            const turn = resolved.get(stepIndex)
            if (!turn?.usage) continue
            const total =
                turn.usage.input_tokens +
                turn.usage.output_tokens +
                turn.usage.cache_creation_input_tokens +
                turn.usage.cache_read_input_tokens
            if (total <= 0) continue
            const suffix = turn.usageId ?? String(stepIndex)
            if (seenUsageIds.has(suffix)) continue
            seenUsageIds.add(suffix)

            records.push({
                brainUuid,
                stepIndex,
                messageId: `agy:${brainUuid}:${suffix}`,
                model: turn.model ?? 'unknown',
                timestamp: stepTimestamps.get(stepIndex) ?? fallbackIso,
                usage: turn.usage,
            })
        }
    }

    return records
}

export function applyAgyUsageBackfill(
    dbPath: string,
    records: readonly ExportedAgyUsageRecord[],
    options: { dryRun?: boolean; defaultHost?: string } = {}
): {
    insertedMessages: number
    skippedExisting: number
    createdHistorySessionId: string | null
    updatedOpencodeSessions: number
} {
    const dryRun = options.dryRun === true
    const defaultHost = options.defaultHost ?? 'WIN-GVHSJ7B378A'
    const db = new Database(dbPath)

    try {
        const brainToSession = new Map<string, string>()
        const existingUsageMessageIds = new Set<string>()

        const sessionRows = db
            .query(`SELECT id, namespace, metadata, model FROM sessions`)
            .all() as Array<{ id: string; namespace: string; metadata: string | null; model: string | null }>

        let defaultMachineId: string | undefined
        for (const row of sessionRows) {
            if (!row.metadata) continue
            try {
                const meta = JSON.parse(row.metadata) as Record<string, unknown>
                if (typeof meta.agySessionId === 'string' && meta.agySessionId.trim()) {
                    brainToSession.set(meta.agySessionId.trim().toLowerCase(), row.id)
                }
                if (
                    !defaultMachineId &&
                    meta.host === defaultHost &&
                    typeof meta.machineId === 'string' &&
                    meta.machineId.trim()
                ) {
                    defaultMachineId = meta.machineId.trim()
                }
            } catch {
                // ignore malformed metadata
            }
        }

        const agySessionIds = sessionRows
            .filter((row) => {
                if (!row.metadata) return false
                try {
                    return (JSON.parse(row.metadata) as Record<string, unknown>).flavor === 'agy'
                } catch {
                    return false
                }
            })
            .map((row) => row.id)

        const msgStmt = db.query(`SELECT content FROM messages WHERE session_id = ?`)
        for (const sessionId of agySessionIds) {
            const msgRows = msgStmt.all(sessionId) as Array<{ content: string | Uint8Array }>
            for (const msgRow of msgRows) {
                try {
                    const decoded = decodeMessageContent(msgRow.content as never) as Record<string, unknown>
                    const outer = decoded?.content as Record<string, unknown> | undefined
                    const data = outer?.data as Record<string, unknown> | undefined
                    if (outer?.type !== 'output' || data?.type !== 'agy_message') continue
                    const messageId = typeof data.messageId === 'string' ? data.messageId : ''
                    if (!messageId) continue
                    const parts = messageId.split(':')
                    if (parts.length >= 3 && parts[0] === 'agy') {
                        const uuid = parts[1].toLowerCase()
                        if (!brainToSession.has(uuid)) {
                            brainToSession.set(uuid, sessionId)
                        }
                    }
                    if (data.usage && typeof data.usage === 'object') {
                        existingUsageMessageIds.add(messageId)
                    }
                } catch {
                    // ignore undecodable message
                }
            }
        }

        let historySessionId =
            sessionRows.find((row) => row.id === 'antigravity-history-vircs')?.id ?? null
        let createdHistorySessionId: string | null = null

        const missingRecords = records.filter((rec) => !existingUsageMessageIds.has(rec.messageId))
        const needsHistorySession = missingRecords.some((rec) => !brainToSession.has(rec.brainUuid))

        if (needsHistorySession && !historySessionId) {
            historySessionId = 'antigravity-history-vircs'
            createdHistorySessionId = historySessionId
            if (!dryRun) {
                const now = Date.now()
                const metadata = JSON.stringify({
                    path: 'C:\\Users\\Administrator',
                    host: defaultHost,
                    os: 'win32',
                    ...(defaultMachineId ? { machineId: defaultMachineId } : {}),
                    flavor: 'agy',
                    name: 'Antigravity Historical & Subagent Usage',
                    summary: { text: 'Backfilled Antigravity CLI conversations and subagents', updatedAt: now },
                })
                db.query(
                    `INSERT INTO sessions (id, namespace, tag, created_at, updated_at, metadata, metadata_version, agent_state, agent_state_version, todos, todos_updated_at, active, active_at, model)
                     VALUES (?, 'default', 'antigravity-history-vircs', ?, ?, ?, 1, NULL, 1, NULL, NULL, 0, ?, 'gemini-4-argon')`
                ).run(historySessionId, now, now, metadata, now)
            }
        } else if (historySessionId && defaultMachineId && !dryRun) {
            const existingRow = sessionRows.find((r) => r.id === historySessionId)
            if (existingRow?.metadata) {
                try {
                    const meta = JSON.parse(existingRow.metadata) as Record<string, unknown>
                    if (!meta.machineId) {
                        meta.machineId = defaultMachineId
                        meta.os = meta.os ?? 'win32'
                        db.query(`UPDATE sessions SET metadata = ? WHERE id = ?`).run(
                            JSON.stringify(meta),
                            historySessionId
                        )
                    }
                } catch {
                    // ignore
                }
            }
        }

        let insertedMessages = 0
        const skippedExisting = records.length - missingRecords.length

        if (!dryRun && missingRecords.length > 0) {
            const maxSeqStmt = db.query(`SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM messages WHERE session_id = ?`)
            const nextSeqBySession = new Map<string, number>()
            const touchedSessions = new Set<string>()

            const insertMsgStmt = db.query(
                `INSERT INTO messages (id, session_id, content, created_at, seq, local_id)
                 VALUES (?, ?, ?, ?, ?, ?)`
            )

            const tx = db.transaction(() => {
                for (const rec of missingRecords) {
                    const targetSessionId = brainToSession.get(rec.brainUuid) ?? historySessionId!
                    let seq = nextSeqBySession.get(targetSessionId)
                    if (seq === undefined) {
                        const row = maxSeqStmt.get(targetSessionId) as { maxSeq: number } | null
                        seq = row?.maxSeq ?? 0
                    }
                    seq += 1
                    nextSeqBySession.set(targetSessionId, seq)
                    touchedSessions.add(targetSessionId)

                    const parsedTs = Date.parse(rec.timestamp)
                    const createdAt = Number.isFinite(parsedTs) ? parsedTs : Date.now()
                    const envelope = {
                        role: 'agent',
                        content: {
                            type: 'output',
                            data: {
                                type: 'agy_message',
                                content: '',
                                messageId: rec.messageId,
                                model: rec.model,
                                timestamp: new Date(createdAt).toISOString(),
                                usage: rec.usage,
                            },
                        },
                    }
                    insertMsgStmt.run(
                        randomUUID(),
                        targetSessionId,
                        encodeMessageContent(envelope),
                        createdAt,
                        seq,
                        `backfill:${rec.messageId}`
                    )
                    insertedMessages += 1
                }

                for (const sessionId of touchedSessions) {
                    try {
                        bumpMessageEpoch(db, sessionId)
                    } catch {
                        // ignore if epoch table is absent
                    }
                }
            })
            tx()
        } else if (dryRun) {
            insertedMessages = missingRecords.length
        }

        // Backfill legacy opencode sessions created under 0.25.3 with NULL session.model
        const legacyOpencodeModels: Array<[string, string]> = [
            ['fd91f722-2da2-455b-968b-2ceb342aec66', 'deepseek-chat'],
            ['f9a8f09f-ab74-4e39-8eff-1c74a6d80a14', 'gpt-5.6-sol'],
        ]
        let updatedOpencodeSessions = 0
        for (const [sessionId, modelName] of legacyOpencodeModels) {
            const row = db
                .query(`SELECT id, model FROM sessions WHERE id = ?`)
                .get(sessionId) as { id: string; model: string | null } | null
            if (row && (!row.model || !row.model.trim())) {
                updatedOpencodeSessions += 1
                if (!dryRun) {
                    db.query(`UPDATE sessions SET model = ? WHERE id = ?`).run(modelName, sessionId)
                    try {
                        bumpMessageEpoch(db, sessionId)
                    } catch {
                        // ignore
                    }
                }
            }
        }

        return {
            insertedMessages,
            skippedExisting,
            createdHistorySessionId,
            updatedOpencodeSessions,
        }
    } finally {
        db.close()
    }
}

if (import.meta.main) {
    const args = process.argv.slice(2)
    const exportArg = args.find((a) => a.startsWith('--export='))
    const applyArg = args.find((a) => a.startsWith('--apply='))
    const dbArg = args.find((a) => a.startsWith('--db='))
    const dryRun = args.includes('--dry-run')

    if (exportArg) {
        const outPath = exportArg.slice('--export='.length)
        const records = exportAgyUsageFromConversations()
        writeFileSync(outPath, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8')
        const byModel = new Map<string, { requests: number; tokens: number }>()
        for (const r of records) {
            const prev = byModel.get(r.model) ?? { requests: 0, tokens: 0 }
            prev.requests += 1
            prev.tokens +=
                r.usage.input_tokens +
                r.usage.output_tokens +
                r.usage.cache_creation_input_tokens +
                r.usage.cache_read_input_tokens
            byModel.set(r.model, prev)
        }
        console.log(
            JSON.stringify(
                {
                    exportedRecords: records.length,
                    outPath,
                    models: Object.fromEntries(byModel.entries()),
                },
                null,
                2
            )
        )
    } else if (applyArg) {
        const inPath = applyArg.slice('--apply='.length)
        const dbPath = dbArg ? dbArg.slice('--db='.length) : process.env.DB_PATH || join(homedir(), '.hapi', 'hapi.db')
        const lines = readFileSync(inPath, 'utf-8')
            .split(/\r?\n/)
            .filter((line) => line.trim().length > 0)
        const records = lines.map((line) => JSON.parse(line) as ExportedAgyUsageRecord)
        const summary = applyAgyUsageBackfill(dbPath, records, { dryRun })
        console.log(JSON.stringify({ dbPath, dryRun, ...summary }, null, 2))
    } else {
        console.error('Usage: bun run hub/scripts/backfill-agy-usage.ts --export=<file> | --apply=<file> [--db=<path>] [--dry-run]')
        process.exit(1)
    }
}
