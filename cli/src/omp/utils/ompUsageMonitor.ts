import { mkdir, open, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { logger } from '@/ui/logger';
import { resolveOmpAgentCategoryDirectory } from './ompSessionScanner';

export type NativeOmpUsageEvent = {
    type: 'native-model-usage';
    source: 'omp';
    sourceSessionId: string;
    entryId: string;
    timestamp: string;
    model: string;
    agentId: string;
    purpose: string;
    usage: {
        input_tokens: number;
        output_tokens: number;
        cache_creation_input_tokens: number;
        cache_read_input_tokens: number;
    };
} | {
    type: 'native-usage-authority';
    source: 'omp';
};

export type OmpUsageMonitorOptions = {
    sessionId: string;
    onUsage: (event: NativeOmpUsageEvent) => void;
    getPrimarySessionFile?: () => string | null;
    pollIntervalMs?: number;
    agentDirectory?: string;
};

type RecordValue = Record<string, unknown>;
type Header = { id: string; parentSession?: string };
type FileCursor = {
    offset: number;
    identity: string;
    size: number;
    modified: string;
    prefix: Buffer;
    tail: Buffer;
    header?: Header;
    invalidHeader: boolean;
};

const READ_BYTES = 64 * 1024;
const ANCHOR_BYTES = 256;

function record(value: unknown): RecordValue | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as RecordValue
        : undefined;
}

function fileKey(file: string): string {
    const absolute = path.resolve(file);
    return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

function token(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function usageEvent(entry: RecordValue, header: Header, agentId: string): NativeOmpUsageEvent | undefined {
    const message = record(entry.message);
    const call = entry.type === 'model_usage' ? entry : entry.type === 'message' && message?.role === 'assistant' ? message : undefined;
    const usage = record(call?.usage);
    if (!call || !usage || entry.synthetic === true || call.synthetic === true
        || typeof call.provider !== 'string' || !call.provider || typeof call.model !== 'string' || !call.model
        || typeof entry.id !== 'string' || !entry.id || typeof entry.timestamp !== 'string') {
        return undefined;
    }
    const timestamp = Date.parse(entry.timestamp);
    if (!Number.isFinite(timestamp)) return undefined;
    const normalized = {
        input_tokens: token(usage.input),
        output_tokens: token(usage.output),
        cache_creation_input_tokens: token(usage.cacheWrite),
        cache_read_input_tokens: token(usage.cacheRead)
    };
    if (!Object.values(normalized).some((value) => value > 0)) return undefined;
    const purpose = entry.type === 'model_usage' ? entry.purpose : 'assistant';
    if (typeof purpose !== 'string' || !purpose) return undefined;
    return {
        type: 'native-model-usage', source: 'omp', sourceSessionId: header.id,
        entryId: entry.id, timestamp: new Date(timestamp).toISOString(),
        model: `${call.provider}/${typeof call.upstreamModel === 'string' && call.upstreamModel.trim() ? call.upstreamModel : call.model}`,
        agentId, purpose, usage: normalized
    };
}

function related(header: Header, parent?: { file: string; header: Header }): boolean {
    if (!parent || !header.parentSession) return true;
    return header.parentSession === parent.header.id || fileKey(header.parentSession) === fileKey(parent.file);
}

/** Reads only explicitly owned journals: the primary subtree and exact HAPI binding sidecars. */
export function createOmpUsageMonitor(options: OmpUsageMonitorOptions): {
    start(): Promise<void>;
    flush(): Promise<void>;
    cleanup(): Promise<void>;
} {
    const agentDirectory = options.agentDirectory ?? resolveOmpAgentCategoryDirectory('data');
    const cursors = new Map<string, FileCursor>();
    const emitted = new Set<string>();
    let authoritySent = false;
    let timer: NodeJS.Timeout | undefined;
    let closed = false;
    let pending: Promise<void> = Promise.resolve();

    async function readJournal(file: string, agentId: string, parent?: { file: string; header: Header }, nativeId?: string): Promise<{ header?: Header; complete: boolean }> {
        let handle;
        try {
            handle = await open(file, 'r');
            const info = await handle.stat({ bigint: true });
            if (!info.isFile()) return { complete: false };
            const size = Number(info.size);
            const identity = `${info.dev}:${info.ino}:${info.birthtimeNs}`;
            const modified = String(info.mtimeNs);
            const key = fileKey(file);
            let cursor = cursors.get(key);
            const readAt = async (position: number, length: number): Promise<Buffer> => {
                const buffer = Buffer.allocUnsafe(length);
                const { bytesRead } = await handle!.read(buffer, 0, length, position);
                return buffer.subarray(0, bytesRead);
            };
            if (cursor) {
                const prefix = await readAt(0, cursor.prefix.length);
                const tail = await readAt(Math.max(0, cursor.offset - cursor.tail.length), cursor.tail.length);
                if (cursor.identity !== identity || size < cursor.size || !prefix.equals(cursor.prefix) || !tail.equals(cursor.tail)
                    || (size === cursor.size && modified !== cursor.modified)) {
                    cursor = undefined;
                }
            }
            if (!cursor) {
                cursor = { offset: 0, identity, size: 0, modified: '', prefix: Buffer.alloc(0), tail: Buffer.alloc(0), invalidHeader: false };
                cursors.set(key, cursor);
            }
            if (cursor.header && (!related(cursor.header, parent) || (nativeId && cursor.header.id !== nativeId))) {
                return { complete: true };
            }
            let position = cursor.offset;
            let partial: Buffer = Buffer.alloc(0);
            while (position < size) {
                const chunk = await readAt(position, Math.min(READ_BYTES, size - position));
                if (chunk.length === 0) break;
                position += chunk.length;
                const buffer = partial.length ? Buffer.concat([partial, chunk]) : chunk;
                let start = 0;
                for (let end = buffer.indexOf(10); end !== -1; end = buffer.indexOf(10, start)) {
                    const line = buffer.subarray(start, end).toString('utf8').trim();
                    let entry: RecordValue | undefined;
                    try { entry = record(JSON.parse(line)); } catch { /* Not a complete native entry. */ }
                    if (!cursor.header && !cursor.invalidHeader && line) {
                        if (entry?.type === 'title') {
                            // OMP can prepend a mutable title slot before the session header.
                        } else if (entry?.type === 'session' && typeof entry.id === 'string' && entry.id
                            && typeof entry.cwd === 'string') {
                            cursor.header = { id: entry.id, parentSession: typeof entry.parentSession === 'string' ? entry.parentSession : undefined };
                            if (!related(cursor.header, parent) || (nativeId && cursor.header.id !== nativeId)) {
                                return { complete: true };
                            }
                        } else {
                            cursor.invalidHeader = true;
                        }
                    } else if (entry && cursor.header && related(cursor.header, parent) && (!nativeId || cursor.header.id === nativeId)) {
                        const event = usageEvent(entry, cursor.header, agentId);
                        if (event?.type === 'native-model-usage') {
                            const id = JSON.stringify([event.sourceSessionId, event.entryId]);
                            if (!emitted.has(id)) {
                                options.onUsage(event);
                                emitted.add(id);
                            }
                        }
                    }
                    cursor.offset += end + 1 - start;
                    start = end + 1;
                }
                partial = buffer.subarray(start);
            }
            cursor.size = size;
            cursor.modified = modified;
            cursor.prefix = await readAt(0, Math.min(ANCHOR_BYTES, cursor.offset));
            cursor.tail = await readAt(Math.max(0, cursor.offset - ANCHOR_BYTES), Math.min(ANCHOR_BYTES, cursor.offset));
            if (cursor.invalidHeader || (cursor.header && (!related(cursor.header, parent) || (nativeId && cursor.header.id !== nativeId)))) {
                return { complete: true };
            }
            return { header: cursor.header, complete: !!cursor.header && cursor.offset === size };
        } catch (error) {
            logger.debug('[OMP usage] Unable to read native journal', error);
            return { complete: false };
        } finally {
            await handle?.close().catch(() => undefined);
        }
    }

    async function visit(file: string, primary: boolean, visited: Set<string>, parent?: { file: string; header: Header }, nativeId?: string): Promise<boolean> {
        const key = fileKey(file);
        if (visited.has(key)) return true;
        const result = await readJournal(file, primary ? 'main' : path.basename(file, '.jsonl'), parent, nativeId);
        if (!result.header) return result.complete;
        visited.add(key);
        let complete = result.complete;
        const directory = file.slice(0, -'.jsonl'.length);
        let children;
        try {
            children = await readdir(directory, { withFileTypes: true });
        } catch (error) {
            return (error as NodeJS.ErrnoException).code === 'ENOENT' ? complete : false;
        }
        for (const child of children) {
            if (child.isFile() && child.name.endsWith('.jsonl')) {
                if (!await visit(path.join(directory, child.name), false, visited, { file, header: result.header })) complete = false;
            }
        }
        return complete;
    }

    async function refresh(): Promise<void> {
        const primary = options.getPrimarySessionFile?.();
        const visited = new Set<string>();
        if (primary?.endsWith('.jsonl')) {
            const complete = await visit(primary, true, visited);
            if (complete && !authoritySent && cursors.get(fileKey(primary))?.header) {
                // No legacy OMP accounting is disabled until all initial descendants have queued their usage.
                options.onUsage({ type: 'native-usage-authority', source: 'omp' });
                authoritySent = true;
            }
        }
        const directory = path.join(agentDirectory, 'hapi-usage-bindings');
        let bindings;
        try { bindings = await readdir(directory, { withFileTypes: true }); } catch { return; }
        for (const binding of bindings) {
            if (!binding.isFile() || !binding.name.endsWith('.json')) continue;
            try {
                const value = record(JSON.parse(await readFile(path.join(directory, binding.name), 'utf8')));
                if (value?.hapiSessionId !== options.sessionId || typeof value.sessionFile !== 'string'
                    || !path.isAbsolute(value.sessionFile) || !value.sessionFile.endsWith('.jsonl')) continue;
                await visit(value.sessionFile, fileKey(value.sessionFile) === (primary ? fileKey(primary) : ''), visited,
                    undefined, binding.name.slice(0, -'.json'.length));
            } catch { /* An atomic binding replacement may overlap a poll. Retry on the next poll. */ }
        }
    }

    function flush(): Promise<void> {
        if (closed) return pending;
        const next = pending.then(refresh);
        pending = next.catch(() => undefined);
        return next;
    }

    return {
        async start() {
            if (closed || timer) return;
            await flush();
            if (closed || timer) return;
            timer = setInterval(() => { void flush().catch((error) => logger.debug('[OMP usage] Refresh failed', error)); }, options.pollIntervalMs ?? 1000);
            timer.unref?.();
        },
        flush,
        async cleanup() {
            if (closed) return pending;
            clearInterval(timer);
            timer = undefined;
            const final = flush();
            closed = true;
            await final;
        }
    };
}

const EXTENSION_MARKER = '// Managed by HAPI: native OMP usage binding (no transcript or credentials).';

/** Installs only HAPI's reserved extension; other global extensions are left untouched. */
export async function ensureOmpUsageExtension(): Promise<void> {
    const agentDirectory = resolveOmpAgentCategoryDirectory('data');
    // Native extension discovery uses the config agent directory, not the XDG journal directory.
    const configAgentDirectory = resolveOmpAgentCategoryDirectory('data', {
        env: { ...process.env, XDG_DATA_HOME: undefined }
    });
    const extensionDirectory = path.join(configAgentDirectory, 'extensions');
    const extensionFile = path.join(extensionDirectory, 'hapi-usage.ts');
    const bindingDirectory = path.join(agentDirectory, 'hapi-usage-bindings');
    const source = `${EXTENSION_MARKER}
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ExtensionContext, ExtensionFactory } from '@oh-my-pi/pi-coding-agent';

const bindingDirectory = ${JSON.stringify(bindingDirectory)};
const extension: ExtensionFactory = (pi) => {
    let stopTimer: NodeJS.Timeout | undefined;
    let stopping = false;
    let checkingStop = false;
    const installStopControl = (ctx: ExtensionContext) => {
        clearInterval(stopTimer);
        const requestFile = process.env.HAPI_OMP_STOP_FILE;
        const nonce = process.env.HAPI_OMP_STOP_NONCE;
        const hapiSessionId = process.env.HAPI_SESSION_ID;
        if (!requestFile || !nonce || !hapiSessionId || !path.isAbsolute(requestFile)) return;
        stopTimer = setInterval(() => {
            if (stopping || checkingStop) return;
            checkingStop = true;
            void (async () => {
                try {
                    const request = JSON.parse(await readFile(requestFile, 'utf8'));
                    if (request.nonce !== nonce || request.hapiSessionId !== hapiSessionId) return;
                    stopping = true;
                    await ctx.abort();
                    ctx.shutdown();
                    clearInterval(stopTimer);
                } catch {
                    stopping = false;
                    // Absence is normal; malformed/foreign requests never stop a session.
                } finally {
                    checkingStop = false;
                }
            })();
        }, 100);
        stopTimer.unref?.();
    };
    const bind = async (_event: unknown, ctx: ExtensionContext) => {
        installStopControl(ctx);
        const hapiSessionId = process.env.HAPI_SESSION_ID;
        const sessionFile = ctx.sessionManager.getSessionFile();
        const nativeId = ctx.sessionManager.getSessionId();
        if (!hapiSessionId || !sessionFile || !nativeId || !/^[a-zA-Z0-9_-]+$/.test(nativeId)) return;
        const target = path.join(bindingDirectory, nativeId + '.json');
        const temporary = target + '.' + process.pid + '.tmp';
        try {
            await mkdir(bindingDirectory, { recursive: true });
            await writeFile(temporary, JSON.stringify({ hapiSessionId, sessionFile: path.resolve(sessionFile) }), { mode: 0o600 });
            await rename(temporary, target);
        } catch {
            // Binding failure must not interrupt the user's native session.
        }
    };
    pi.on('session_start', bind);
    pi.on('session_switch', bind);
    pi.on('session_shutdown', () => { clearInterval(stopTimer); });
};
export default extension;
`;
    let existing: string | undefined;
    try { existing = await readFile(extensionFile, 'utf8'); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (existing === source) return;
    if (existing !== undefined && !existing.startsWith(EXTENSION_MARKER)) {
        throw new Error(`Refusing to overwrite a non-HAPI extension: ${extensionFile}`);
    }
    await mkdir(extensionDirectory, { recursive: true });
    await writeFile(extensionFile, source, { mode: 0o600 });
}
