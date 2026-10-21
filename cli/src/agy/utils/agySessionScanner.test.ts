/**
 * Tests for agy resume support in AgySessionScanner:
 *  1. getBrainUuid() reports the brain UUID once a hook (onNewSession) or a
 *     resume seed identifies it — the scanner never discovers a brain on its
 *     own (that was transcript content-matching, removed once the
 *     PreToolUse/PreInvocation hooks became the authoritative discovery
 *     path; see 2026-08-04_agy-preinvocation-discovery plan §7.5).
 *  2. initialize() seeds processed keys from an existing transcript so a
 *     resume does NOT re-emit prior turns (the "old messages re-show" bug).
 *  3. onNewSession() switches to a new brain UUID.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { createAgySessionScanner, emitAgyEntriesWithModels } from './agySessionScanner'
import type { AgyTranscriptEntry } from './agyTranscriptTypes'

vi.mock('node:os', async (importOriginal) => {
    const os = await importOriginal<typeof import('node:os')>()
    const fs = await import('node:fs')
    const path = await import('node:path')
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hapi-agy-scanner-'))
    return { ...os, homedir: () => home }
})

afterAll(() => {
    const home = homedir()
    if (!home.startsWith(join(tmpdir(), 'hapi-agy-scanner-'))) throw new Error('Unsafe test home')
    rmSync(home, { recursive: true, force: true })
})

// Build a minimal transcript line for a given step and type.
function makeTranscriptLine(step_index: number, type: AgyTranscriptEntry['type'], content: string): string {
    const entry: AgyTranscriptEntry = {
        step_index,
        source: 'MODEL',
        type,
        status: 'DONE',
        created_at: new Date(Math.ceil(Date.now() / 1000) * 1000).toISOString().replace('.000Z', 'Z'),
        content,
    }
    return JSON.stringify(entry)
}

// The scanner and fixtures share an isolated home; never touch real conversations.
// Capture the expected path structure: ~/.gemini/antigravity-cli/brain/<uuid>/.system_generated/logs/transcript_full.jsonl
const BRAIN_BASE = join(homedir(), '.gemini', 'antigravity-cli', 'brain')

describe('AGY planner model settling', () => {
    const BRAIN_UUID = '00000000-0000-4000-8000-000000000001'

    it('retries a temporarily missing generation and emits every entry once in original order', async () => {
        const entries = [
            JSON.parse(makeTranscriptLine(1, 'USER_INPUT', 'question')) as AgyTranscriptEntry,
            JSON.parse(makeTranscriptLine(2, 'PLANNER_RESPONSE', 'answer')) as AgyTranscriptEntry,
            JSON.parse(makeTranscriptLine(3, 'VIEW_FILE', 'tool')) as AgyTranscriptEntry,
        ]
        const emitted: AgyTranscriptEntry[] = []
        const usage = { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 100 }
        const resolveTurns = vi.fn()
            .mockResolvedValueOnce(new Map([[2, null]]))
            .mockResolvedValueOnce(new Map([[2, { model: 'Gemini 3.5 Flash (High)', usage }]]))
        const sleep = vi.fn(async () => {})

        await emitAgyEntriesWithModels(entries, emitted.push.bind(emitted), BRAIN_UUID, {
            resolveTurns,
            retryDelaysMs: [100, 200],
            sleep,
        })

        expect(resolveTurns).toHaveBeenCalledTimes(2)
        expect(emitted[1].usage).toEqual(usage)
        expect(sleep).toHaveBeenCalledTimes(1)
        expect(emitted.map((entry) => [entry.step_index, entry.model])).toEqual([
            [1, undefined],
            [2, 'Gemini 3.5 Flash (High)'],
            [3, undefined],
        ])
    })

    it('stops after bounded retries and emits unknown entries once in original order', async () => {
        const entries = [
            JSON.parse(makeTranscriptLine(4, 'PLANNER_RESPONSE', 'first')) as AgyTranscriptEntry,
            JSON.parse(makeTranscriptLine(5, 'PLANNER_RESPONSE', 'second')) as AgyTranscriptEntry,
        ]
        const emitted: AgyTranscriptEntry[] = []
        const resolveTurns = vi.fn(async (_uuid: string | null | undefined, indexes: readonly number[]) => new Map(indexes.map((idx) => [idx, null])))
        const sleep = vi.fn(async () => {})

        await emitAgyEntriesWithModels(entries, emitted.push.bind(emitted), BRAIN_UUID, {
            resolveTurns,
            retryDelaysMs: [100, 200, 300],
            sleep,
        })

        expect(resolveTurns).toHaveBeenCalledTimes(4)
        expect(sleep).toHaveBeenCalledTimes(3)
        expect(emitted.map((entry) => [entry.step_index, entry.model])).toEqual([
            [4, undefined],
            [5, undefined],
        ])
    })

    it('retries usage settling even when the model is already known', async () => {
        const usage = { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 100 }
        const entry = { ...JSON.parse(makeTranscriptLine(1, 'PLANNER_RESPONSE', 'answer')), model: 'model-a' } as AgyTranscriptEntry
        const resolveTurns = vi.fn()
            .mockResolvedValueOnce(new Map([[1, { model: 'model-a', usage: null }]]))
            .mockResolvedValueOnce(new Map([[1, { model: 'model-a', usage }]]))
        const emitted = vi.fn()
        await emitAgyEntriesWithModels([entry], emitted, BRAIN_UUID, { resolveTurns, sleep: async () => {} })
        expect(resolveTurns).toHaveBeenCalledTimes(2)
        expect(emitted).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ usage }))
    })
})

function makeTempBrain(uuid: string, content: string): { brainDir: string; logPath: string } {
    const brainDir = join(BRAIN_BASE, uuid)
    const logDir = join(brainDir, '.system_generated', 'logs')
    mkdirSync(logDir, { recursive: true })
    const logPath = join(logDir, 'transcript_full.jsonl')
    writeFileSync(logPath, content, 'utf-8')
    return { brainDir, logPath }
}

describe('AgySessionScanner — resume support', () => {
    // Must match /^[0-9a-f-]{36}$/ so the scanner's directory filter accepts it.
    const TEST_UUID = '00000000-0000-4000-8000-000000000001'

    afterEach(() => {
        // Clean up the temp brain dir.
        try { rmSync(join(BRAIN_BASE, TEST_UUID), { recursive: true, force: true }) } catch { /* best-effort */ }
    })

    it('getBrainUuid() returns null until a hook (onNewSession) identifies the brain — no scan, no attach, even with candidate brains on disk', async () => {
        // A brain that exists on disk before the hook ever fires must NOT be
        // attached to. The scanner has no discovery mechanism of its own
        // anymore (that was content-match, removed once the PreToolUse/
        // PreInvocation hooks became the authoritative discovery path); it
        // only ever watches a brain it was explicitly told about.
        makeTempBrain(TEST_UUID, makeTranscriptLine(0, 'USER_INPUT', 'unrelated-existing-brain') + '\n')
        const emitted: AgyTranscriptEntry[] = []
        const scanner = await createAgySessionScanner({ onEntry: (e) => emitted.push(e) })

        await new Promise((r) => setTimeout(r, 300))
        expect(scanner.getBrainUuid()).toBeNull()
        expect(emitted).toHaveLength(0)

        await scanner.cleanup()
    })

    it('initialize() with a known brain UUID seeds existing transcript so prior turns are not re-emitted', async () => {
        // Pre-existing transcript with 3 entries.
        const existingLines = [
            makeTranscriptLine(0, 'USER_INPUT', 'hello'),
            makeTranscriptLine(1, 'PLANNER_RESPONSE', 'world'),
            makeTranscriptLine(2, 'PLANNER_RESPONSE', 'done'),
        ].join('\n') + '\n'
        makeTempBrain(TEST_UUID, existingLines)

        const emitted: AgyTranscriptEntry[] = []
        // Create scanner with the known brain UUID (resume path).
        const scanner = await createAgySessionScanner({
            resumeBrainUuid: TEST_UUID,
            onEntry: (e) => emitted.push(e),
        })

        // No new content written → scanner should have seeded the 3 existing
        // entries as processed and emitted nothing.
        expect(emitted).toHaveLength(0)
        // Brain UUID must be reported immediately (no content-match needed).
        expect(scanner.getBrainUuid()).toBe(TEST_UUID)

        await scanner.cleanup()
    })

    it('new entry appended after resume is emitted (only the new one)', async () => {
        // Pre-existing transcript.
        const existingLines = [
            makeTranscriptLine(0, 'USER_INPUT', 'prior-msg'),
            makeTranscriptLine(1, 'PLANNER_RESPONSE', 'prior-response'),
        ].join('\n') + '\n'
        const { logPath } = makeTempBrain(TEST_UUID, existingLines)

        const emitted: AgyTranscriptEntry[] = []
        const scanner = await createAgySessionScanner({
            resumeBrainUuid: TEST_UUID,
            onEntry: (e) => emitted.push(e),
        })

        // Append a new entry (simulating agy writing a new turn).
        const newLine = makeTranscriptLine(2, 'PLANNER_RESPONSE', 'new-response') + '\n'
        writeFileSync(logPath, existingLines + newLine, 'utf-8')

        // Trigger a scan via file watch. Model metadata may settle shortly
        // after the transcript append, so wait on the observable emission.
        await vi.waitFor(() => expect(emitted).toHaveLength(1), { timeout: 1200 })
        expect(emitted[0].content).toBe('new-response')

        await scanner.cleanup()
    })

    it('onNewSession() switches the scanner to a new brain UUID', async () => {
        const emitted: AgyTranscriptEntry[] = []
        const scanner = await createAgySessionScanner({
            resumeBrainUuid: TEST_UUID,
            onEntry: (e) => emitted.push(e),
        })

        const NEW_UUID = 'ffffffff-0000-4000-8000-000000000002'
        scanner.onNewSession(NEW_UUID)
        expect(scanner.getBrainUuid()).toBe(NEW_UUID)

        await scanner.cleanup()
    })

    it('onNewSession() alone (no resumeBrainUuid) emits the existing backlog — the mechanism the launcher hook-wiring fix (agyPtyLauncher.test.ts) depends on', async () => {
        // Existing transcript with a PLANNER_RESPONSE, written BEFORE the scanner
        // is even created (simulates: agy already produced output by the time the
        // PreToolUse/PreInvocation hook discovers the brain UUID and notifies
        // the scanner).
        const existingLines = [
            makeTranscriptLine(0, 'USER_INPUT', 'hello'),
            makeTranscriptLine(1, 'PLANNER_RESPONSE', 'agent output the hook must surface'),
        ].join('\n') + '\n'
        makeTempBrain(TEST_UUID, existingLines)

        const emitted: AgyTranscriptEntry[] = []
        // Fresh scanner: no resumeBrainUuid seeded — onNewSession() (driven by
        // a hook) is the ONLY discovery signal there is.
        const scanner = await createAgySessionScanner({ onEntry: (e) => emitted.push(e) })

        // The scanner does nothing until told about a brain (shouldScan() is
        // false with foundBrainUuid unset).
        expect(emitted).toHaveLength(0)
        expect(scanner.getBrainUuid()).toBeNull()

        scanner.onNewSession(TEST_UUID)
        await vi.waitFor(() => expect(emitted).toHaveLength(2), { timeout: 1200 })

        expect(scanner.getBrainUuid()).toBe(TEST_UUID)
        // The full pre-existing backlog is emitted (cursor started at 0 for this
        // never-before-seen file), not just newly-appended entries.
        expect(emitted.map((e) => e.content)).toEqual(['hello', 'agent output the hook must surface'])

        await scanner.cleanup()
    })

})
