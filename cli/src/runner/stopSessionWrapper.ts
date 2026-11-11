import { setTimeout as delay } from 'node:timers/promises';
import { getProcessStartMarkerAsync, isProcessAlive } from '@/utils/process';
import { classifySessionProcessOwnership, type SessionProcessOwnership } from './cleanupReceipt';

/** Native disposal is separate: signal only the owned wrapper, never its broker tree. */
export async function stopSessionWrapper(
    ownership: SessionProcessOwnership,
    effects: {
        isAlive: (pid: number) => boolean;
        marker: (pid: number) => Promise<string | null>;
        signal: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => void;
        pause: () => Promise<void>;
    } = {
            isAlive: isProcessAlive,
            marker: getProcessStartMarkerAsync,
            signal: (pid, signal) => { process.kill(pid, signal); },
            pause: () => delay(50),
        }
): Promise<boolean> {
    const disposition = async () => {
        const alive = effects.isAlive(ownership.pid);
        return classifySessionProcessOwnership(ownership, alive, alive ? await effects.marker(ownership.pid) : null);
    };
    for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
        if ((await disposition()) !== 'running') return (await disposition()) === 'exited';
        try {
            effects.signal(ownership.pid, signal);
        } catch {
            return (await disposition()) === 'exited';
        }
        for (let attempt = 0; attempt < 100; attempt++) {
            if ((await disposition()) !== 'running') return (await disposition()) === 'exited';
            await effects.pause();
        }
    }
    return (await disposition()) === 'exited';
}
