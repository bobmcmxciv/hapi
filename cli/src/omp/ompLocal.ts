import { logger } from '@/ui/logger';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { restoreTerminalState } from '@/ui/terminalState';
import { resolveOmpLaunchCommand } from './utils/config';
import type { OmpShutdownReceipt } from './session';
import type { OmpConfiguredThinkingLevel } from '@hapi/protocol/omp';

export async function ompLocal(opts: {
    path: string;
    sessionId: string | null;
    abort: AbortSignal;
    model?: string;
    effort?: OmpConfiguredThinkingLevel;
    onExit?: (receipt: OmpShutdownReceipt) => void;
}): Promise<void> {
    if (opts.abort.aborted) {
        opts.onExit?.({ kind: 'omp-local', status: 'not-started' });
        return;
    }
    const command = resolveOmpLaunchCommand();
    const controlDirectory = await mkdtemp(join(tmpdir(), 'hapi-omp-stop-'));
    const requestFile = join(controlDirectory, 'request.json');
    const nonce = randomUUID();
    const completion = Promise.withResolvers<void>();
    let stopTimeout: NodeJS.Timeout | undefined;
    let exited = false;
    process.stdin.pause();
    const child = spawn(command.command, [...command.args, ...buildOmpLocalArgs(opts)], {
        cwd: opts.path,
        env: { ...process.env, HAPI_OMP_STOP_FILE: requestFile, HAPI_OMP_STOP_NONCE: nonce },
        stdio: 'inherit',
        shell: false
    });
    const stop = () => {
        if (stopTimeout || exited) return;
        // Only this launch receives the nonce. No console-wide signals or tree kills.
        stopTimeout = setTimeout(() => completion.reject(new Error('Timed out awaiting native OMP local disposal')), 30_000);
        void writeFile(requestFile, JSON.stringify({ nonce, hapiSessionId: process.env.HAPI_SESSION_ID }), { mode: 0o600 })
            .catch(completion.reject);
    };
    opts.abort.addEventListener('abort', stop, { once: true });
    if (opts.abort.aborted) stop();
    child.once('error', completion.reject);
    child.once('close', (code, signal) => {
        exited = true;
        const disposed = code === 0 && signal === null;
        opts.onExit?.({ kind: 'omp-local', status: disposed ? 'disposed' : 'unverified', pid: child.pid, exitCode: code, signal });
        void rm(controlDirectory, { recursive: true, force: true }).catch((error) => logger.warn('[OmpLocal] Failed to remove stop control directory', error));
        if (disposed) completion.resolve();
        else completion.reject(new Error(`Native OMP local disposal failed (code=${code}, signal=${signal})`));
    });
    try {
        await completion.promise;
    } finally {
        clearTimeout(stopTimeout);
        opts.abort.removeEventListener('abort', stop);
        if (!exited) opts.onExit?.({ kind: 'omp-local', status: 'unverified', pid: child.pid });
        process.stdin.resume();
        restoreTerminalState();
        logger.debug('[OmpLocal] Native launch finished');
    }
}

export function buildOmpLocalArgs(opts: {
    sessionId: string | null;
    model?: string;
    effort?: OmpConfiguredThinkingLevel;
}): string[] {
    const args: string[] = [];

    if (opts.sessionId) {
        args.push('--resume', opts.sessionId);
    }
    if (opts.model) {
        args.push('--model', opts.model);
    }
    if (opts.effort) {
        args.push('--thinking', opts.effort);
    }
    args.push('--approval-mode', 'yolo');
    return args;
}
