import { describe, expect, it } from 'vitest';
import { stopSessionWrapper } from './stopSessionWrapper';

const disposedWrapper = {
    requestedSessionId: 'hapi-row', pid: 123, processStartMarker: 'owned-generation',
    requiresCleanupReceipt: true, cleanupVerified: true,
};

describe('generation-fenced native wrapper termination', () => {
    it('signals only the disposed wrapper and leaves a shared broker alive', async () => {
        const alive = new Set([123, 999]);
        const signals: number[] = [];
        expect(await stopSessionWrapper(disposedWrapper, {
            isAlive: pid => alive.has(pid),
            marker: async () => 'owned-generation',
            signal: pid => { signals.push(pid); alive.delete(pid); },
            pause: async () => { },
        })).toBe(true);
        expect(signals).toEqual([123]);
        expect(alive.has(999)).toBe(true);
    });

    it.each([
        { alive: false, marker: null, cleanupVerified: false, result: false },
        { alive: true, marker: 'replacement-generation', cleanupVerified: false, result: false },
        { alive: true, marker: 'replacement-generation', cleanupVerified: true, result: true },
        { alive: true, marker: null, cleanupVerified: true, result: false },
    ])('never signals without proof of native disposal and current wrapper ownership: %j', async scenario => {
        const signals: number[] = [];
        expect(await stopSessionWrapper({ ...disposedWrapper, cleanupVerified: scenario.cleanupVerified }, {
            isAlive: () => scenario.alive,
            marker: async () => scenario.marker,
            signal: pid => { signals.push(pid); },
            pause: async () => { },
        })).toBe(scenario.result);
        expect(signals).toEqual([]);
    });

    it('does not escalate against a reused PID after the owned wrapper exits', async () => {
        let marker = 'owned-generation';
        const signals: string[] = [];
        expect(await stopSessionWrapper(disposedWrapper, {
            isAlive: () => true,
            marker: async () => marker,
            signal: (_pid, signal) => { signals.push(signal); },
            pause: async () => { marker = 'replacement-generation'; },
        })).toBe(true);
        expect(signals).toEqual(['SIGTERM']);
    });

    it('escalates only the same generation, and reports a surviving wrapper honestly', async () => {
        const signals: string[] = [];
        expect(await stopSessionWrapper(disposedWrapper, {
            isAlive: () => true,
            marker: async () => 'owned-generation',
            signal: (_pid, signal) => { signals.push(signal); },
            pause: async () => { },
        })).toBe(false);
        expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
    });
});
