import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';

export type SessionProcessOwnership = {
    requestedSessionId: string;
    confirmedSessionId?: string;
    pid: number;
    processStartMarker: string;
    requiresCleanupReceipt?: boolean;
    cleanupVerified?: boolean;
    ompResumeAttemptId?: string;
};

export type SessionCleanupReceipt = {
    sessionId: string;
    pid: number;
    processStartMarker: string;
    ompResumeAttemptId?: string;
};

export function matchesSessionCleanupReceipt(
    ownership: SessionProcessOwnership,
    receipt: SessionCleanupReceipt
): boolean {
    return receipt.pid === ownership.pid
        && receipt.ompResumeAttemptId === ownership.ompResumeAttemptId
        && (ownership.processStartMarker
            ? receipt.processStartMarker === ownership.processStartMarker
            : Boolean(ownership.ompResumeAttemptId))
        && (receipt.sessionId === ownership.requestedSessionId || receipt.sessionId === ownership.confirmedSessionId);
}

/** Late startup confirmation cannot revive a disposed or recycled wrapper. */
export function canConfirmSessionProcessStarted(
    ownership: SessionProcessOwnership,
    sessionId: string,
    currentMarker: string | null
): boolean {
    if (!ownership.processStartMarker || currentMarker !== ownership.processStartMarker || ownership.cleanupVerified) return false;
    return !ownership.requiresCleanupReceipt
        || sessionId === ownership.requestedSessionId
        || sessionId === ownership.confirmedSessionId;
}

/** A wrapper writes its own generation's proof before attempting runner delivery. */
export class SessionCleanupReceiptStore {
    #stateFile: string;

    constructor(stateFile: string) {
        this.#stateFile = stateFile;
    }

    #path(pid: number, marker: string, attemptId?: string): string {
        const identity = attemptId ? `attempt:${attemptId}` : `process:${marker}`;
        const generation = createHash('sha256').update(identity).digest('hex');
        return `${this.#stateFile}.cleanup-${pid}-${generation}.json`;
    }

    write(receipt: SessionCleanupReceipt): void {
        const path = this.#path(receipt.pid, receipt.processStartMarker, receipt.ompResumeAttemptId);
        const temporary = `${path}.${randomUUID()}.tmp`;
        try {
            writeFileSync(temporary, JSON.stringify(receipt), { mode: 0o600 });
            renameSync(temporary, path);
        } finally {
            try { unlinkSync(temporary); } catch { /* Renamed or never created. */ }
        }
    }

    has(ownership: SessionProcessOwnership): boolean {
        try {
            const value: unknown = JSON.parse(readFileSync(this.#path(ownership.pid, ownership.processStartMarker, ownership.ompResumeAttemptId), 'utf8'));
            if (!value || typeof value !== 'object') return false;
            if (!('sessionId' in value) || typeof value.sessionId !== 'string'
                || !('pid' in value) || typeof value.pid !== 'number'
                || !('processStartMarker' in value) || typeof value.processStartMarker !== 'string') return false;
            return matchesSessionCleanupReceipt(ownership, {
                sessionId: value.sessionId,
                pid: value.pid,
                processStartMarker: value.processStartMarker,
                ompResumeAttemptId: 'ompResumeAttemptId' in value && typeof value.ompResumeAttemptId === 'string' ? value.ompResumeAttemptId : undefined,
            });
        } catch {
            return false;
        }
    }

    recover(ownership: SessionProcessOwnership, persistOwnership: () => boolean): boolean {
        if (ownership.cleanupVerified) return true;
        if (!this.has(ownership)) return false;
        ownership.cleanupVerified = true;
        if (!persistOwnership()) {
            ownership.cleanupVerified = false;
            return false;
        }
        this.forget(ownership);
        return true;
    }

    /** Only discard after the runner has durably incorporated this proof. */
    forget(ownership: SessionProcessOwnership): void {
        try { unlinkSync(this.#path(ownership.pid, ownership.processStartMarker, ownership.ompResumeAttemptId)); } catch { /* Already consumed. */ }
    }
}

/** Wrapper death/PID reuse is never a substitute for required native disposal. */
export function classifySessionProcessOwnership(
    ownership: SessionProcessOwnership,
    processAlive: boolean,
    currentMarker: string | null
): 'running' | 'exited' | 'blocked' {
    if (ownership.requiresCleanupReceipt && !ownership.cleanupVerified) return 'blocked';
    if (!processAlive) return 'exited';
    if (currentMarker === null || !ownership.processStartMarker) return 'blocked';
    return currentMarker === ownership.processStartMarker ? 'running' : 'exited';
}
