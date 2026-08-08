import { describe, expect, it } from 'vitest';
import { formatLogArg } from './logger';

// Regression guard for the fleet-wide diagnostic blackout: `logToFile` used to
// serialize every non-string argument with `JSON.stringify`, so
// `logger.debug('[remote]: launch error', err)` wrote a literal `{}` to the
// session log. Real runner logs across four machines carried
// `[remote]: launch error {}` / `response stream error {}` lines, which is why
// the recurring "Process exited unexpectedly" failures had no recorded cause.
describe('formatLogArg', () => {
    it('keeps an Error message and stack instead of collapsing it to {}', () => {
        const formatted = formatLogArg(new Error('Claude Code process exited with code 1'));

        expect(formatted).not.toBe('{}');
        expect(formatted).toContain('Claude Code process exited with code 1');
        // The stack is what makes the line actionable, not just the message.
        expect(formatted).toContain('Error:');
    });

    it('pins the exact pre-fix failure: JSON.stringify drops Error fields', () => {
        // Documents *why* the custom formatter exists -- if someone reverts to
        // JSON.stringify, this asserts the behavior they would be restoring.
        expect(JSON.stringify(new Error('boom'))).toBe('{}');
        expect(formatLogArg(new Error('boom'))).toContain('boom');
    });

    it('retains own enumerable properties such as node error codes', () => {
        const error = Object.assign(new Error('spawn claude ENOENT'), {
            code: 'ENOENT',
            syscall: 'spawn claude'
        });

        const formatted = formatLogArg(error);

        expect(formatted).toContain('spawn claude ENOENT');
        expect(formatted).toContain('ENOENT');
    });

    it('falls back to name and message when a thrown Error carries no stack', () => {
        const error = new Error('no stack here');
        error.stack = undefined;

        expect(formatLogArg(error)).toBe('Error: no stack here');
    });

    it('serializes nested Errors inside plain objects', () => {
        const formatted = formatLogArg({ stage: 'spawn', cause: new Error('inner failure') });

        expect(formatted).toContain('inner failure');
        expect(formatted).toContain('spawn');
    });

    it('does not throw on circular structures', () => {
        // JSON.stringify throws on these, and the old call site ran *outside*
        // logToFile's try/catch -- so a circular argument turned a debug log
        // into an exception in the caller.
        const circular: Record<string, unknown> = { name: 'session' };
        circular.self = circular;

        expect(() => formatLogArg(circular)).not.toThrow();
        expect(formatLogArg(circular)).toContain('[Circular]');
    });

    it('passes strings through untouched and renders undefined visibly', () => {
        expect(formatLogArg('plain text')).toBe('plain text');
        expect(formatLogArg(undefined)).toBe('undefined');
    });
});
