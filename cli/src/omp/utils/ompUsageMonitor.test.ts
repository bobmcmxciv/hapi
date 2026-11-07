import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createOmpUsageMonitor, ensureOmpUsageExtension, type NativeOmpUsageEvent, type OmpUsageMonitorOptions } from './ompUsageMonitor';

const roots: string[] = [];
const cleanups: Array<() => Promise<void>> = [];
const timestamp = '2026-11-05T12:00:00.000Z';

async function rootDirectory() {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hapi-omp-usage-'));
    roots.push(root);
    return root;
}

function header(id: string, parentSession?: string) {
    return { type: 'session', id, parentSession, cwd: '/same-cwd', timestamp };
}

function assistant(id: string, model = 'devin', overrides: Record<string, unknown> = {}) {
    return {
        type: 'message', id, parentId: null, timestamp,
        message: {
            role: 'assistant', provider: 'test-provider', model,
            usage: { input: 10, output: 5, cacheWrite: 3, cacheRead: 7 },
            content: [{ type: 'text', text: 'private content must not leave the journal' }],
            stopReason: 'stop', ...overrides
        }
    };
}

async function journal(file: string, entries: unknown[]) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
}

function monitor(options: Omit<OmpUsageMonitorOptions, 'sessionId' | 'pollIntervalMs'>) {
    const value = createOmpUsageMonitor({ sessionId: 'hapi-owner', pollIntervalMs: 60_000, ...options });
    cleanups.push(value.cleanup);
    return value;
}

afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
    vi.unstubAllEnvs();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('OMP native model usage', () => {
    it('accounts the complete primary subtree before authority, using actual models and stable native ids', async () => {
        const root = await rootDirectory();
        const primary = path.join(root, 'primary.jsonl');
        const child = path.join(root, 'primary', 'child.jsonl');
        const nested = path.join(root, 'primary', 'child', 'nested.jsonl');
        await journal(primary, [header('native-main'), assistant('same-entry', 'requested', { upstreamModel: 'devin-actual' })]);
        await journal(child, [header('native-child', primary), assistant('same-entry', 'child-model')]);
        await journal(nested, [header('native-nested', 'native-child'), assistant('nested-entry', 'nested-model')]);
        await journal(path.join(root, 'primary', 'unrelated.jsonl'), [header('foreign', 'different-parent'), assistant('ignored')]);
        await journal(path.join(root, 'primary', 'artifact.jsonl'), [{ payload: 'not a native journal' }, assistant('ignored-artifact')]);
        await writeFile(path.join(root, 'primary', 'request.json'), JSON.stringify(assistant('ignored-json')));
        const events: NativeOmpUsageEvent[] = [];
        const value = monitor({ agentDirectory: root, getPrimarySessionFile: () => primary, onUsage: (event) => events.push(event) });
        await value.start();
        const usage = events.filter((event) => event.type === 'native-model-usage');
        expect(usage).toHaveLength(3);
        expect(usage).toEqual(expect.arrayContaining([
            expect.objectContaining({ sourceSessionId: 'native-main', entryId: 'same-entry', agentId: 'main', model: 'test-provider/devin-actual' }),
            expect.objectContaining({ sourceSessionId: 'native-child', entryId: 'same-entry', agentId: 'child', model: 'test-provider/child-model' }),
            expect.objectContaining({ sourceSessionId: 'native-nested', agentId: 'nested', model: 'test-provider/nested-model' })
        ]));
        expect(usage[0]?.usage).toEqual({ input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 3, cache_read_input_tokens: 7 });
        expect(events.at(-1)).toEqual({ type: 'native-usage-authority', source: 'omp' });
        expect(JSON.stringify(events)).not.toContain('private content');
        await value.flush();
        expect(events).toHaveLength(4);
    });

    it('includes auxiliary purposes and error/aborted attempts with tokens, never synthetic or usage-less entries', async () => {
        const root = await rootDirectory();
        const primary = path.join(root, 'primary.jsonl');
        await journal(primary, [
            header('native-main'),
            { type: 'model_usage', id: 'title', timestamp, purpose: 'session-title', provider: 'aux-provider', model: 'tiny', usage: { input: 11, output: 2 }, stopReason: 'error' },
            { type: 'model_usage', id: 'compact', timestamp, purpose: 'compaction', provider: 'aux-provider', model: 'smol', usage: { input: 12, output: 4 }, stopReason: 'aborted' },
            assistant('error', 'devin', { stopReason: 'error' }),
            assistant('aborted', 'devin', { stopReason: 'aborted' }),
            assistant('no-usage', 'devin', { usage: undefined }),
            assistant('zero-usage', 'devin', { usage: { input: 0, output: 0 } }),
            assistant('not-numbers', 'devin', { usage: { input: '100', output: -1 } }),
            assistant('synthetic', 'devin', { synthetic: true }),
            { type: 'model_change', id: 'not-a-call', timestamp, model: 'unused/devin' },
            { type: 'message', id: 'user', timestamp, message: { role: 'user', model: 'unused/devin', usage: { input: 999 } } }
        ]);
        const events: NativeOmpUsageEvent[] = [];
        const value = monitor({ agentDirectory: root, getPrimarySessionFile: () => primary, onUsage: (event) => events.push(event) });
        await value.start();
        expect(events.filter((event) => event.type === 'native-model-usage').map((event) => [event.entryId, event.purpose])).toEqual([
            ['title', 'session-title'], ['compact', 'compaction'], ['error', 'assistant'], ['aborted', 'assistant']
        ]);
    });

    it('replays the same native keys after restart and does not re-emit on resume or file replacement', async () => {
        const root = await rootDirectory();
        const primary = path.join(root, 'primary.jsonl');
        const entries = [header('native-main'), assistant('entry-a')];
        await journal(primary, entries);
        const first: NativeOmpUsageEvent[] = [];
        const value = monitor({ agentDirectory: root, getPrimarySessionFile: () => primary, onUsage: (event) => first.push(event) });
        await value.start();
        await value.flush();
        const replacement = path.join(root, 'replacement.jsonl');
        await journal(replacement, [...entries, assistant('entry-b')]);
        await rename(replacement, primary);
        await value.flush();
        expect(first.filter((event) => event.type === 'native-model-usage').map((event) => event.entryId)).toEqual(['entry-a', 'entry-b']);
        const replay: NativeOmpUsageEvent[] = [];
        const resumed = monitor({ agentDirectory: root, getPrimarySessionFile: () => primary, onUsage: (event) => replay.push(event) });
        await resumed.start();
        expect(replay.filter((event) => event.type === 'native-model-usage')).toEqual(first.filter((event) => event.type === 'native-model-usage'));
    });

    it('holds incomplete byte lines and initial authority, then reads appended and truncated journals safely', async () => {
        const root = await rootDirectory();
        const primary = path.join(root, 'primary.jsonl');
        const child = path.join(root, 'primary', 'child.jsonl');
        await journal(primary, [header('native-main'), assistant('entry-a')]);
        await journal(child, [header('native-child', primary)]);
        const partial = JSON.stringify(assistant('entry-child', 'child-model', { content: [{ type: 'text', text: '字'.repeat(25_000) }] }));
        const bytes = Buffer.from(partial);
        await appendFile(child, bytes.subarray(0, bytes.length - 5));
        const events: NativeOmpUsageEvent[] = [];
        const value = monitor({ agentDirectory: root, getPrimarySessionFile: () => primary, onUsage: (event) => events.push(event) });
        await value.start();
        await value.flush();
        expect(events).toHaveLength(1);
        await appendFile(child, Buffer.concat([bytes.subarray(bytes.length - 5), Buffer.from('\n')]));
        await value.flush();
        expect(events.map((event) => event.type)).toEqual(['native-model-usage', 'native-model-usage', 'native-usage-authority']);
        await journal(primary, [header('native-main')]);
        await value.flush();
        await appendFile(primary, JSON.stringify(assistant('entry-b')) + '\n');
        await value.flush();
        expect(events.filter((event) => event.type === 'native-model-usage').map((event) => event.entryId)).toEqual(['entry-a', 'entry-child', 'entry-b']);
    });

    it('ignores unbound external sessions regardless of cwd/time and accepts only exact bindings with matching native headers', async () => {
        const root = await rootDirectory();
        const external = path.join(root, 'sessions', 'external.jsonl');
        const child = path.join(root, 'sessions', 'external', 'child.jsonl');
        const unrelated = path.join(root, 'sessions', 'unrelated.jsonl');
        await journal(external, [header('native-external'), assistant('external-entry')]);
        await journal(child, [header('native-external-child', external), assistant('child-entry')]);
        await journal(unrelated, [header('native-unrelated'), assistant('unrelated-entry')]);
        const events: NativeOmpUsageEvent[] = [];
        const value = monitor({ agentDirectory: root, onUsage: (event) => events.push(event) });
        await value.start();
        expect(events).toEqual([]);
        const directory = path.join(root, 'hapi-usage-bindings');
        await mkdir(directory);
        const binding = path.join(directory, 'native-external.json');
        await writeFile(binding, JSON.stringify({ hapiSessionId: 'other-owner', sessionFile: external }));
        await value.flush();
        expect(events).toEqual([]);
        await writeFile(path.join(directory, 'wrong-native.json'), JSON.stringify({ hapiSessionId: 'hapi-owner', sessionFile: unrelated }));
        await value.flush();
        expect(events).toEqual([]);
        await writeFile(binding, JSON.stringify({ hapiSessionId: 'hapi-owner', sessionFile: external }));
        await value.flush();
        expect(events.filter((event) => event.type === 'native-model-usage').map((event) => event.entryId)).toEqual(['external-entry', 'child-entry']);
        expect(events.some((event) => event.type === 'native-usage-authority')).toBe(false);
        await value.flush();
        expect(events).toHaveLength(2);
        await writeFile(path.join(directory, 'native-unrelated.json'), JSON.stringify({ hapiSessionId: 'hapi-owner', sessionFile: unrelated }));
        await value.flush();
        expect(events.filter((event) => event.type === 'native-model-usage').map((event) => event.entryId)).toEqual(['external-entry', 'child-entry', 'unrelated-entry']);
    });

    it('does not emit authority until the primary getter supplies a persisted header', async () => {
        const root = await rootDirectory();
        const primary = path.join(root, 'primary.jsonl');
        let current: string | null = null;
        const events: NativeOmpUsageEvent[] = [];
        const value = monitor({ agentDirectory: root, getPrimarySessionFile: () => current, onUsage: (event) => events.push(event) });
        await value.start();
        expect(events).toEqual([]);
        current = primary;
        await value.flush();
        expect(events).toEqual([]);
        await journal(primary, [header('native-main'), assistant('entry-a')]);
        await value.flush();
        expect(events.map((event) => event.type)).toEqual(['native-model-usage', 'native-usage-authority']);
    });
});

describe('OMP usage binding extension installation', () => {
    it('installs idempotently without touching user extensions or colliding files', async () => {
        const root = await rootDirectory();
        vi.stubEnv('PI_CODING_AGENT_DIR', root);
        vi.stubEnv('OMP_PROFILE', '');
        vi.stubEnv('PI_PROFILE', '');
        await mkdir(path.join(root, 'extensions'));
        const other = path.join(root, 'extensions', 'user-extension.ts');
        await writeFile(other, 'user-owned');
        await ensureOmpUsageExtension();
        const file = path.join(root, 'extensions', 'hapi-usage.ts');
        const first = await stat(file, { bigint: true });
        await ensureOmpUsageExtension();
        expect((await stat(file, { bigint: true })).mtimeNs).toBe(first.mtimeNs);
        expect(await readFile(other, 'utf8')).toBe('user-owned');
        await writeFile(file, 'user-owned colliding name');
        await expect(ensureOmpUsageExtension()).rejects.toThrow('Refusing to overwrite');
        expect(await readFile(file, 'utf8')).toBe('user-owned colliding name');
    });
});
