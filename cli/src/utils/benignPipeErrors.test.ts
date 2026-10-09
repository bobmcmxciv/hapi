import { describe, expect, test } from 'vitest';
import { isBenignChildPipeError } from './benignPipeErrors';

function withCode(message: string, code: string): Error {
    return Object.assign(new Error(message), { code });
}

describe('isBenignChildPipeError', () => {
    test('accepts the Bun error for a write to a destroyed child stdin', () => {
        expect(isBenignChildPipeError(new Error('Cannot call write after a stream was destroyed'))).toBe(true);
    });

    test('accepts the Node pipe error codes', () => {
        expect(isBenignChildPipeError(withCode('write EPIPE', 'EPIPE'))).toBe(true);
        expect(isBenignChildPipeError(withCode('Cannot call write after a stream was destroyed', 'ERR_STREAM_DESTROYED'))).toBe(true);
        expect(isBenignChildPipeError(withCode('write after end', 'ERR_STREAM_WRITE_AFTER_END'))).toBe(true);
    });

    test('rejects unrelated errors so real crashes still stop the runner', () => {
        expect(isBenignChildPipeError(new Error('Cannot read properties of undefined'))).toBe(false);
        expect(isBenignChildPipeError(withCode('connect ECONNREFUSED 127.0.0.1:443', 'ECONNREFUSED'))).toBe(false);
        expect(isBenignChildPipeError(withCode('spawn copilot ENOENT', 'ENOENT'))).toBe(false);
        expect(isBenignChildPipeError('Cannot call write after a stream was destroyed')).toBe(false);
        expect(isBenignChildPipeError(undefined)).toBe(false);
    });
});
