import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OmpInputReceipt } from './rpc/types';
import { parseOmpInputReceipt } from './rpc/schemas';

export class OmpUncertainDeliveryError extends Error {
    constructor(readonly localId: string, options?: ErrorOptions) {
        super(`OMP input delivery is uncertain for message ${localId}; native acceptance was not confirmed. The pending message is retained and automatic replay is blocked.`, options);
        this.name = 'OmpUncertainDeliveryError';
    }
}
export class OmpInputReceiptsUnsupportedError extends OmpUncertainDeliveryError {
    constructor(localId: string) {
        super(localId);
        this.name = 'OmpInputReceiptsUnsupportedError';
        this.message = 'Native OMP does not advertise durable input receipts with native ordering (inputReceipts and nativeOrder); upgrade the native OMP executable before sending or recovering pending HAPI input. No input was replayed.';
    }
}

export class OmpInputTokenConflictError extends OmpUncertainDeliveryError {
    constructor(localId: string, options?: ErrorOptions) {
        super(localId, options);
        this.name = 'OmpInputTokenConflictError';
        this.message = `Native OMP rejected conflicting clientToken reuse for message ${localId}; the pending message is quarantined for reconciliation, not acknowledged or replayed.`;
    }
}

/** Admission suppresses redispatch; consumed acknowledgments require native delivery. */
export async function recoverOmpInputReceipts(
    store: OmpInputDeliveryStore,
    nativeSessionId: string,
    supportsReceipts: boolean,
    query: (tokens: string[]) => Promise<OmpInputReceipt[]>
): Promise<string[]> {
    store.assertCanStart();
    const pending = store.pendingTokenReceipts();
    if (pending.length > 0 && !supportsReceipts) throw new OmpInputReceiptsUnsupportedError(pending[0]!.localId);
    for (const receipt of pending) {
        if (receipt.nativeSessionId !== nativeSessionId) throw new OmpUncertainDeliveryError(receipt.localId);
    }
    if (pending.length > 0) {
        const native = await query(pending.map(receipt => receipt.clientToken));
        const byToken = new Map(native.map(receipt => [receipt.token, receipt]));
        for (const receipt of pending) {
            if (!byToken.has(receipt.clientToken)) throw new OmpUncertainDeliveryError(receipt.localId);
        }
        for (const receipt of pending) {
            const proof = byToken.get(receipt.clientToken)!;
            if (proof.sessionId !== nativeSessionId) throw new OmpUncertainDeliveryError(receipt.localId);
            if (proof.admitted) store.recordNativeReceipt(proof);
            else store.rejectBeforeAdmission(receipt.localId);
        }
    }
    return store.acceptedLocalIds();
}

type InputReceipt = {
    sessionId: string;
    localId: string;
    nativeSessionId: string;
    pid: number;
    attemptId?: string;
    /** Absent on legacy receipts: those deliveries remain unprovable. */
    clientToken?: string;
    conflict?: boolean;
    status: 'dispatched' | 'admitted' | 'accepted' | 'resolved';
    nativeReceipt?: OmpInputReceipt;
    /** An acknowledged wrapper-owned session command, never a native user-turn proof. */
    hostResolution?: 'handled';
};

type ResolvedInput = { localId: string; outcome: 'handled' | 'cancelled'; nativeOrder?: OmpInputReceipt['nativeOrder'] };

function resolvedReceipt(receipt: InputReceipt): ResolvedInput | undefined {
    if (receipt.status !== 'resolved') return undefined;
    if (receipt.hostResolution === 'handled') return { localId: receipt.localId, outcome: 'handled' };
    if (receipt.nativeReceipt?.outcome === undefined) return undefined;
    return {
        localId: receipt.localId, outcome: receipt.nativeReceipt.outcome === 'cancelled' ? 'cancelled' : 'handled',
        ...(receipt.nativeReceipt.nativeOrder ? { nativeOrder: receipt.nativeReceipt.nativeOrder } : {})
    };
}

function key(value: string): string {
    return createHash('sha256').update(value).digest('hex');
}

/** Sidecar ownership evidence only; never writes or guesses native journal entries. */
export class OmpInputDeliveryStore {
    readonly #directory: string;

    constructor(root: string, readonly sessionId: string) {
        if (!sessionId) throw new Error('OMP input receipt requires a HAPI session identity');
        this.#directory = join(`${root}.omp-input-receipts`, key(sessionId));
    }

    assertCanStart(): void {
        if (!existsSync(this.#directory)) return;
        for (const file of readdirSync(this.#directory)) {
            // Incomplete temporary writes precede dispatch and do not authorize it.
            if (!file.endsWith('.json')) continue;
            const receipt = this.#readFile(join(this.#directory, file));
            if (file !== `${key(receipt.localId)}.json`) throw new Error('OMP input receipt identity is invalid');
            if (receipt.conflict) throw new OmpInputTokenConflictError(receipt.localId);
            if (!receipt.clientToken && receipt.hostResolution === undefined) throw new OmpUncertainDeliveryError(receipt.localId);
        }
    }

    isAccepted(localId: string): boolean {
        const receipt = this.#read(localId);
        return !!receipt && this.#isDelivered(receipt);
    }

    isAdmitted(localId: string): boolean {
        const receipt = this.#read(localId);
        return !!receipt && receipt.status !== 'dispatched' && !receipt.conflict;
    }

    /** Terminal replays suppress redispatch, but are not pending native work. */
    isPendingNativeInput(localId: string): boolean {
        const receipt = this.#read(localId);
        return !!receipt?.clientToken && !receipt.conflict
            && receipt.status !== 'resolved' && !this.#isDelivered(receipt);
    }

    acceptedLocalIds(): string[] {
        if (!existsSync(this.#directory)) return [];
        const ids: string[] = [];
        for (const file of readdirSync(this.#directory)) {
            if (!file.endsWith('.json')) continue;
            const receipt = this.#readFile(join(this.#directory, file));
            if (file !== `${key(receipt.localId)}.json`) throw new Error('OMP input receipt identity is invalid');
            if (this.#isDelivered(receipt)) ids.push(receipt.localId);
        }
        return ids;
    }
    /** Only token-bearing attempts can be reconciled against native journal receipts. */
    pendingTokenReceipts(): Array<{ localId: string; nativeSessionId: string; clientToken: string }> {
        if (!existsSync(this.#directory)) return [];
        const pending: Array<{ localId: string; nativeSessionId: string; clientToken: string }> = [];
        for (const file of readdirSync(this.#directory)) {
            if (!file.endsWith('.json')) continue;
            const receipt = this.#readFile(join(this.#directory, file));
            if (file !== `${key(receipt.localId)}.json`) throw new Error('OMP input receipt identity is invalid');
            if (receipt.conflict) throw new OmpInputTokenConflictError(receipt.localId);
            if (receipt.status === 'resolved' || this.#isDelivered(receipt)) continue;
            if (!receipt.clientToken) throw new OmpUncertainDeliveryError(receipt.localId);
            pending.push({ localId: receipt.localId, nativeSessionId: receipt.nativeSessionId, clientToken: receipt.clientToken });
        }
        return pending;
    }
    hasNativeAttempt(localId: string): boolean {
        return this.#read(localId) !== null;
    }
    nativeReceipt(localId: string): OmpInputReceipt | undefined {
        return this.#read(localId)?.nativeReceipt;
    }
    /** Complete native evidence survives wrapper restart, including non-invocation outcomes. */
    nativeReceiptRecords(): Array<{ localId: string; receipt: OmpInputReceipt }> {
        if (!existsSync(this.#directory)) return [];
        const records: Array<{ localId: string; receipt: OmpInputReceipt }> = [];
        for (const file of readdirSync(this.#directory)) {
            if (!file.endsWith('.json')) continue;
            const stored = this.#readFile(join(this.#directory, file));
            if (file !== `${key(stored.localId)}.json`) throw new Error('OMP input receipt identity is invalid');
            if (stored.nativeReceipt) records.push({ localId: stored.localId, receipt: stored.nativeReceipt });
        }
        return records;
    }
    resolvedInput(localId: string): ResolvedInput | undefined {
        const receipt = this.#read(localId);
        return receipt ? resolvedReceipt(receipt) : undefined;
    }

    resolvedInputs(): ResolvedInput[] {
        if (!existsSync(this.#directory)) return [];
        const resolved: ResolvedInput[] = [];
        for (const file of readdirSync(this.#directory)) {
            if (!file.endsWith('.json')) continue;
            const stored = this.#readFile(join(this.#directory, file));
            if (file !== `${key(stored.localId)}.json`) throw new Error('OMP input receipt identity is invalid');
            const resolution = resolvedReceipt(stored);
            if (resolution) resolved.push(resolution);
        }
        return resolved;
    }

    #isDelivered(receipt: InputReceipt): boolean {
        return receipt.status === 'accepted' && !!receipt.clientToken
            && receipt.nativeReceipt?.delivered === true && !!receipt.nativeReceipt.entryId
            && !!receipt.nativeReceipt.deliveredAt && Number.isFinite(Date.parse(receipt.nativeReceipt.deliveredAt))
            && Number.isSafeInteger(receipt.nativeReceipt.deliveredOrder) && receipt.nativeReceipt.deliveredOrder! > 0
            && receipt.nativeReceipt.sessionId === receipt.nativeSessionId;
    }


    begin(localId: string, nativeSessionId: string, clientToken?: string): void {
        const previous = this.#read(localId);
        if (previous?.status === 'accepted') throw new Error('OMP input has already been accepted');
        if (previous) throw new OmpUncertainDeliveryError(localId);
        this.#write({
            sessionId: this.sessionId,
            localId,
            nativeSessionId,
            pid: process.pid,
            ...(clientToken ? { clientToken } : {}),
            ...(process.env.HAPI_OMP_RESUME_ATTEMPT_ID ? { attemptId: process.env.HAPI_OMP_RESUME_ATTEMPT_ID } : {}),
            status: 'dispatched'
        });
    }

    resolveHostInput(localId: string): void {
        const receipt = this.#read(localId);
        if (!receipt) throw new Error('OMP dispatched input receipt is missing');
        if (receipt.clientToken || receipt.status !== 'dispatched') throw new Error('Host command resolution requires its original non-token dispatch');
        this.#write({ ...receipt, status: 'resolved', hostResolution: 'handled' });
    }

    #hasMatchingNativeOrder(proof: OmpInputReceipt): boolean {
        const order = proof.nativeOrder;
        return !order || (order.sessionId === proof.sessionId && order.eventOrder === 0
            && (!proof.delivered || (order.entryId === proof.entryId && order.entryOrder === proof.deliveredOrder)));
    }

    recordNativeReceipt(proof: OmpInputReceipt): boolean | undefined {
        const receipt = this.#read(proof.token);
        if (!receipt) return undefined;
        if (receipt.conflict) throw new OmpInputTokenConflictError(receipt.localId);
        if (receipt.clientToken !== proof.token || receipt.nativeSessionId !== proof.sessionId || !proof.admitted || !this.#hasMatchingNativeOrder(proof)
            || (proof.delivered && (!proof.entryId || !proof.deliveredAt || !Number.isFinite(Date.parse(proof.deliveredAt))
                || !Number.isSafeInteger(proof.deliveredOrder) || proof.deliveredOrder! < 1))) {
            throw new OmpUncertainDeliveryError(receipt.localId);
        }
        if (this.isAccepted(receipt.localId)) return true;
        if (receipt.status === 'resolved') {
            if (proof.delivered || (proof.outcome !== undefined && proof.outcome !== receipt.nativeReceipt?.outcome)) {
                throw new OmpUncertainDeliveryError(receipt.localId);
            }
            return false;
        }
        this.#write({
            ...receipt,
            status: proof.delivered ? 'accepted' : proof.outcome !== undefined ? 'resolved' : 'admitted',
            nativeReceipt: proof
        });
        return proof.delivered;
    }

    quarantineConflict(localId: string): void {
        const receipt = this.#read(localId);
        if (!receipt) throw new Error('OMP dispatched input receipt is missing');
        this.#write({ ...receipt, conflict: true });
    }

    rejectBeforeAdmission(localId: string): void {
        const receipt = this.#read(localId);
        if (receipt && receipt.status !== 'dispatched') throw new OmpUncertainDeliveryError(localId);
        if (receipt?.status === 'dispatched') unlinkSync(this.#path(localId));
    }

    #path(localId: string): string {
        return join(this.#directory, `${key(localId)}.json`);
    }

    #read(localId: string): InputReceipt | null {
        try {
            const receipt = this.#readFile(this.#path(localId));
            if (receipt.localId !== localId) throw new Error('OMP input receipt local identity is invalid');
            return receipt;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
            throw error;
        }
    }

    #readFile(path: string): InputReceipt {
        const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
        if (!value || typeof value !== 'object'
            || !('sessionId' in value) || value.sessionId !== this.sessionId
            || !('localId' in value) || typeof value.localId !== 'string' || !value.localId
            || !('nativeSessionId' in value) || typeof value.nativeSessionId !== 'string' || !value.nativeSessionId
            || !('pid' in value) || typeof value.pid !== 'number' || !Number.isInteger(value.pid) || value.pid <= 0
            || !('status' in value) || !['dispatched', 'admitted', 'accepted', 'resolved'].includes(String(value.status))
            || ('attemptId' in value && typeof value.attemptId !== 'string')
            || ('conflict' in value && typeof value.conflict !== 'boolean')
            || ('clientToken' in value && (typeof value.clientToken !== 'string' || !value.clientToken))) {
            throw new Error('OMP input delivery receipt is invalid; automatic replay is blocked');
        }
        if ('hostResolution' in value && (value.hostResolution !== 'handled' || value.status !== 'resolved' || 'clientToken' in value || 'nativeReceipt' in value)) {
            throw new Error('OMP persisted host resolution is invalid');
        }
        if ('nativeReceipt' in value) {
            const proof = parseOmpInputReceipt(value.nativeReceipt);
            if (proof.token !== value.localId || proof.sessionId !== value.nativeSessionId || !proof.admitted || !this.#hasMatchingNativeOrder(proof) || (proof.delivered && !proof.entryId)) {
                throw new Error('OMP persisted native receipt identity is invalid');
            }
        }
        return value as InputReceipt;
    }

    #write(receipt: InputReceipt): void {
        mkdirSync(this.#directory, { recursive: true });
        const temporary = join(this.#directory, `${key(receipt.localId)}.${randomUUID()}.tmp`);
        const fd = openSync(temporary, 'wx', 0o600);
        try {
            writeFileSync(fd, JSON.stringify(receipt));
            fsyncSync(fd);
        } finally {
            closeSync(fd);
        }
        renameSync(temporary, this.#path(receipt.localId));
    }
}
