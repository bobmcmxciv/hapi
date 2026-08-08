import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { query } from './query';

// End-to-end cover for the stderr wiring in query(). Deliberately does NOT
// mock node:child_process (unlike query.test.ts), so this exercises the real
// spawn -> stderr listener -> close handler -> error message path.
//
// The stand-in for Claude Code is `process.execPath` (node itself): it is a
// genuine executable that spawn(shell:false) accepts on every platform, and
// when handed query()'s own argv it rejects the first flag, writes the reason
// to stderr, and exits non-zero -- exactly the shape of the production failures
// this fix targets ("Claude Code process exited with code 1" with the cause
// discarded). Verified directly:
//
//   $ node --output-format stream-json --verbose --print hello
//   C:\Program Files\nodejs\node.exe: bad option: --output-format
//   EXIT=9
async function drain(iterator: AsyncIterable<unknown>): Promise<Error | undefined> {
    try {
        for await (const _message of iterator) {
            // Nothing is expected on stdout; the child dies on argv parsing.
        }
        return undefined;
    } catch (error) {
        return error as Error;
    }
}

describe('query() stderr capture (real subprocess)', () => {
    it('surfaces the child stderr in the exit error instead of a bare exit code', async () => {
        const iterator = query({
            prompt: 'hello',
            options: {
                pathToClaudeCodeExecutable: process.execPath,
                cwd: tmpdir()
            }
        });

        const error = await drain(iterator);

        expect(error).toBeInstanceOf(Error);
        // Pre-fix this message was exactly "Claude Code process exited with
        // code 9" -- diagnostically useless, and it is what the hub stored and
        // showed the user as "Process exited unexpectedly: ...".
        expect(error!.message).toContain('Claude Code process exited with code');
        expect(error!.message).toContain('bad option');
        expect(error!.message).toContain('--output-format');
    }, 30_000);

    // Coverage note, deliberately not a test here: the ">64KB stderr must not
    // block the child" property cannot be expressed through query(), because
    // query() always puts `--output-format` first in argv, so a node stand-in
    // dies on argv parsing before any `-e` script could produce bulk output.
    // That property is covered by (a) this file proving the listener is
    // attached on the real spawn path -- draining and capturing are the same
    // listener -- and (b) appendStderrTail's bounding tests in
    // query.stderr.test.ts.
});
