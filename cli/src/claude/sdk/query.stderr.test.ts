import { describe, expect, it } from 'vitest';
import { appendStderrTail, formatClaudeExitMessage, STDERR_TAIL_LIMIT } from './query';

// Claude Code's stderr used to be read only when process.env.DEBUG was set.
// In production that meant two things at once:
//   1. every non-zero exit reached the user as a bare "Claude Code process
//      exited with code 1" with the cause discarded, and
//   2. the stderr pipe (always created by stdio: ['pipe','pipe','pipe']) was
//      never drained, so a child writing past the OS buffer would block.
describe('formatClaudeExitMessage', () => {
    it('attaches the stderr tail so the exit code is actionable', () => {
        const message = formatClaudeExitMessage(1, 'Invalid API key · Please run /login');

        expect(message).toBe(
            'Claude Code process exited with code 1: Invalid API key · Please run /login'
        );
    });

    it('falls back to the bare exit code when the child said nothing', () => {
        expect(formatClaudeExitMessage(1, '')).toBe('Claude Code process exited with code 1');
        expect(formatClaudeExitMessage(1, '   \n  ')).toBe('Claude Code process exited with code 1');
    });

    it('handles a null exit code (killed by signal)', () => {
        expect(formatClaudeExitMessage(null, '')).toBe('Claude Code process exited with code null');
    });
});

describe('appendStderrTail', () => {
    it('accumulates chunks in order', () => {
        let tail = '';
        tail = appendStderrTail(tail, 'first ');
        tail = appendStderrTail(tail, 'second');

        expect(tail).toBe('first second');
    });

    it('retains the most recent bytes when the tail exceeds the limit', () => {
        // The fatal message is the last thing a dying process writes, so the
        // tail must keep the end, not the beginning.
        const tail = appendStderrTail('x'.repeat(STDERR_TAIL_LIMIT), 'FATAL: the real cause');

        expect(tail.length).toBe(STDERR_TAIL_LIMIT);
        expect(tail.endsWith('FATAL: the real cause')).toBe(true);
    });

    it('bounds unbounded output so a chatty child cannot grow the buffer', () => {
        let tail = '';
        for (let i = 0; i < 50; i++) {
            tail = appendStderrTail(tail, 'y'.repeat(1000));
        }

        expect(tail.length).toBe(STDERR_TAIL_LIMIT);
    });
});
