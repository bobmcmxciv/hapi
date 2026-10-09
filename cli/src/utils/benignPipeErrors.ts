/**
 * Errors from writing to a child-process pipe that has already closed.
 *
 * They reach the process-level handlers as unhandled rejections when a probed
 * agent CLI is missing or exits early: vscode-jsonrpc rethrows the failed write
 * from inside an async Promise executor, so nobody can catch it. The child's own
 * `exit`/`error` events already fail the caller, so the process state is intact
 * and the error is safe to log and ignore. Shutting the runner down for it took
 * every machine offline when the Copilot model probe ran on hosts without
 * `copilot` installed.
 */
const BENIGN_PIPE_ERROR_CODES = new Set(['EPIPE', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END']);
const BENIGN_PIPE_ERROR_MESSAGES = [
    /Cannot call write after a stream was destroyed/i,
    /write after end/i,
    /^write EPIPE$/i
];

export function isBenignChildPipeError(reason: unknown): boolean {
    if (!(reason instanceof Error)) {
        return false;
    }
    const code = (reason as NodeJS.ErrnoException).code;
    if (typeof code === 'string' && BENIGN_PIPE_ERROR_CODES.has(code)) {
        return true;
    }
    return BENIGN_PIPE_ERROR_MESSAGES.some((pattern) => pattern.test(reason.message));
}
