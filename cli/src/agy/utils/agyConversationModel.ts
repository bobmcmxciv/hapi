import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgyTokenUsage } from './agyTranscriptTypes'

const CONVERSATIONS_DIR = join(homedir(), '.gemini', 'antigravity-cli', 'conversations')
const CANONICAL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export type AgyConversationRow = {
    kind: 'step' | 'generation'
    idx: number
    data: unknown
}

type QueryConversationRows = (brainUuid: string) => Promise<AgyConversationRow[]>

export type AgyTurnMetadata = { model: string | null; usage: AgyTokenUsage | null; usageId: string }

function unknownTurns(stepIndexes: readonly number[]): Map<number, AgyTurnMetadata | null> {
    return new Map(stepIndexes.map((idx) => [idx, null]))
}

function asBytes(value: unknown): Uint8Array | null {
    if (typeof value === 'string') return Buffer.from(value)
    if (value instanceof Uint8Array) return value
    if (value instanceof ArrayBuffer) return new Uint8Array(value)
    return null
}

function readVarint(bytes: Uint8Array, start: number): { value: number; next: number } | null {
    let value = 0
    let multiplier = 1
    for (let offset = start; offset < bytes.length && offset < start + 10; offset++) {
        const byte = bytes[offset]
        value += (byte & 0x7f) * multiplier
        if (!Number.isSafeInteger(value)) return null
        if ((byte & 0x80) === 0) return { value, next: offset + 1 }
        multiplier *= 128
    }
    return null
}

/** null = absent proto3 field; undefined = malformed wire data. */
function readField(bytes: Uint8Array, wantedField: number): Uint8Array | number | null | undefined {
    let offset = 0
    let found: Uint8Array | number | null = null
    while (offset < bytes.length) {
        const tag = readVarint(bytes, offset)
        if (!tag || tag.value < 8) return undefined
        offset = tag.next
        const fieldNumber = Math.floor(tag.value / 8)
        const wireType = tag.value & 7

        if (wireType === 2) {
            const length = readVarint(bytes, offset)
            if (!length) return undefined
            const end = length.next + length.value
            if (!Number.isSafeInteger(end) || end > bytes.length) return undefined
            if (fieldNumber === wantedField) {
                if (found !== null) return undefined
                found = bytes.subarray(length.next, end)
            }
            offset = end
        } else if (wireType === 0) {
            const value = readVarint(bytes, offset)
            if (!value) return undefined
            if (fieldNumber === wantedField) {
                if (found !== null) return undefined
                found = value.value
            }
            offset = value.next
        } else if (wireType === 1) {
            if (offset + 8 > bytes.length || fieldNumber === wantedField) return undefined
            offset += 8
        } else if (wireType === 5) {
            if (offset + 4 > bytes.length || fieldNumber === wantedField) return undefined
            offset += 4
        } else {
            return undefined
        }
    }
    return found
}

function readLengthDelimitedField(bytes: Uint8Array, field: number): Uint8Array | null {
    const value = readField(bytes, field)
    return value instanceof Uint8Array ? value : null
}

function generationUsage(generation: Uint8Array): AgyTokenUsage | null {
    // Verified against agy 1.4.3's embedded protobuf descriptors:
    // ChatModelMetadata.usage = 4; ModelUsageStats input/output/write/read = 2/3/4/5.
    // output_tokens already includes thinking_output_tokens (9); never add it again.
    const bytes = readLengthDelimitedField(generation, 4)
    if (!bytes) return null
    const counts = [2, 3, 4, 5].map(field => readField(bytes, field))
    if (counts.some(value => value !== null && typeof value !== 'number')) return null
    const [input, output, write, read] = counts.map(value => typeof value === 'number' ? value : 0)
    if (input + output + write + read === 0) return null
    return {
        input_tokens: input,
        output_tokens: output,
        cache_creation_input_tokens: write,
        cache_read_input_tokens: read,
    }
}

function decodeText(bytes: Uint8Array | null): string | null {
    if (!bytes) return null
    try {
        const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
        return value.length > 0 ? value : null
    } catch {
        return null
    }
}

function invocationFromStep(data: unknown): string | null {
    const bytes = asBytes(data)
    return bytes ? decodeText(readLengthDelimitedField(bytes, 12)) : null
}

function generationStepIndexes(bytes: Uint8Array): number[] | null {
    // CortexStepGeneratorMetadata.step_indices = 2 (packed uint32). These are
    // authoritative even while a new planner step is ahead of its DB commit.
    const packed = readField(bytes, 2)
    if (packed === null) return null
    if (typeof packed === 'number') return packed <= 0xffffffff ? [packed] : []
    if (!(packed instanceof Uint8Array)) return []
    const indexes: number[] = []
    for (let offset = 0; offset < packed.length;) {
        const value = readVarint(packed, offset)
        if (!value || value.value > 0xffffffff) return []
        indexes.push(value.value)
        offset = value.next
    }
    return indexes
}

// ChatModelMetadata.model (field 3 varint enum) fallback when both
// response_model (field 19) and model_display_name (field 21) are absent.
const CHAT_MODEL_ENUM_FALLBACK: Readonly<Record<number, string>> = {
    1318: 'gemini-3.8-flash',
    1319: 'gemini-3.8-flash',
    1320: 'gemini-3.8-flash',
    1322: 'gemini-3.8-flash-tiered',
    1400: 'claude-opus-5-5-low',
    1401: 'claude-opus-5-5-medium',
    1402: 'claude-opus-5-5-high',
    1403: 'claude-sonnet-5-5-low',
    1404: 'claude-sonnet-5-5-medium',
    1405: 'claude-sonnet-5-5-high',
    1417: 'gemini-4-argon',
    1418: 'gemini-4-argon',
    1419: 'gemini-4-argon',
}

function generationEnumModel(generation: Uint8Array): string | null {
    const modelEnum = readField(generation, 3)
    return typeof modelEnum === 'number' ? CHAT_MODEL_ENUM_FALLBACK[modelEnum] ?? null : null
}

function generationMetadata(data: unknown): {
    invocation: string; model: string | null; usage: AgyTokenUsage | null; stepIndexes: number[] | null
} | null {
    const bytes = asBytes(data)
    if (!bytes) return null
    const invocation = decodeText(readLengthDelimitedField(bytes, 4))
    if (!invocation) return null
    const generation = readLengthDelimitedField(bytes, 1)
    // ChatModelMetadata.response_model = 19; model_display_name = 21; model enum = 3.
    // Prefer the wire id for stable per-model grouping, with display-name and enum
    // fallbacks for older/partial conversations that did not persist response_model.
    const model = generation
        ? decodeText(readLengthDelimitedField(generation, 19))
            ?? decodeText(readLengthDelimitedField(generation, 21))
            ?? generationEnumModel(generation)
        : null
    return {
        invocation, model, usage: generation ? generationUsage(generation) : null,
        stepIndexes: generationStepIndexes(bytes),
    }
}

export function resolveAgyTurnMetadataFromRows(
    stepIndexes: readonly number[],
    rows: readonly AgyConversationRow[],
): Map<number, AgyTurnMetadata | null> {
    const result = unknownTurns(stepIndexes)
    const requested = new Set(stepIndexes)
    const stepsByInvocation = new Map<string, number[]>()
    const generationsByInvocation = new Map<string, Array<AgyTurnMetadata & { idx: number; stepIndexes: number[] | null }>>()
    const explicitSteps = new Set<number>()

    for (const row of rows) {
        if (!Number.isSafeInteger(row.idx)) continue
        if (row.kind === 'step') {
            const invocation = invocationFromStep(row.data)
            if (!invocation) continue
            const steps = stepsByInvocation.get(invocation) ?? []
            steps.push(row.idx)
            stepsByInvocation.set(invocation, steps)
        } else if (row.kind === 'generation') {
            const metadata = generationMetadata(row.data)
            if (!metadata) continue
            const generations = generationsByInvocation.get(metadata.invocation) ?? []
            const turn = { model: metadata.model, usage: metadata.usage, usageId: `generation:${row.idx}` }
            generations.push({ idx: row.idx, ...turn, stepIndexes: metadata.stepIndexes })
            generationsByInvocation.set(metadata.invocation, generations)
            for (const idx of new Set(metadata.stepIndexes ?? [])) {
                if (!requested.has(idx)) continue
                // Conflicting generations are ambiguous; do not attribute by guess.
                result.set(idx, explicitSteps.has(idx) ? null : turn)
                explicitSteps.add(idx)
            }
        }
    }

    for (const [invocation, steps] of stepsByInvocation) {
        const generations = generationsByInvocation.get(invocation)
        if (!generations || steps.length !== generations.length) continue
        // Old conversations without explicit links still use the verified ordinal
        // mapping. Never mix that fallback into an explicitly linked invocation.
        if (generations.some(generation => generation.stepIndexes !== null)) continue
        steps.sort((a, b) => a - b)
        generations.sort((a, b) => a.idx - b.idx)
        for (let ordinal = 0; ordinal < steps.length; ordinal++) {
            const stepIndex = steps[ordinal]
            if (requested.has(stepIndex) && !explicitSteps.has(stepIndex)) {
                const { model, usage, usageId } = generations[ordinal]
                result.set(stepIndex, { model, usage, usageId })
            }
        }
    }
    return result
}

async function queryConversationRows(brainUuid: string): Promise<AgyConversationRow[]> {
    const { Database } = await import('bun:sqlite')
    const db = new Database(join(CONVERSATIONS_DIR, `${brainUuid}.db`), { readonly: true })
    try {
        // One statement gives the scanner a single SQLite read snapshot for both
        // sides of the ordinal mapping and avoids one query per response.
        return db.query(`
            SELECT 'step' AS kind, idx, metadata AS data
            FROM steps
            WHERE step_type = 15
            UNION ALL
            SELECT 'generation' AS kind, idx, data
            FROM gen_metadata
        `).all() as AgyConversationRow[]
    } finally {
        db.close()
    }
}

/** Best-effort batch resolver. Database absence/locks/format drift never throw. */
export async function resolveAgyTurnMetadata(
    brainUuid: string | null | undefined,
    stepIndexes: readonly number[],
    queryRows: QueryConversationRows = queryConversationRows,
): Promise<Map<number, AgyTurnMetadata | null>> {
    const unknown = unknownTurns(stepIndexes)
    if (!brainUuid || !CANONICAL_UUID_RE.test(brainUuid) || stepIndexes.length === 0) return unknown
    try {
        return resolveAgyTurnMetadataFromRows(stepIndexes, await queryRows(brainUuid))
    } catch {
        return unknown
    }
}

export function resolveAgyTurnModelsFromRows(
    stepIndexes: readonly number[],
    rows: readonly AgyConversationRow[],
): Map<number, string | null> {
    return new Map([...resolveAgyTurnMetadataFromRows(stepIndexes, rows)]
        .map(([idx, metadata]) => [idx, metadata?.model ?? null]))
}

export async function resolveAgyTurnModels(
    brainUuid: string | null | undefined,
    stepIndexes: readonly number[],
    queryRows: QueryConversationRows = queryConversationRows,
): Promise<Map<number, string | null>> {
    return new Map([...await resolveAgyTurnMetadata(brainUuid, stepIndexes, queryRows)]
        .map(([idx, metadata]) => [idx, metadata?.model ?? null]))
}
