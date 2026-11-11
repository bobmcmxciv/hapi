import { stat } from 'node:fs/promises';
import type { OmpNativeSession } from '@hapi/protocol/types';
export { parseOmpSessionMutation } from '@hapi/protocol/ompSessionMutation';
import type { OmpRpcClient } from './OmpRpcClient';
import type {
    OmpCommandByType,
    OmpResponseData,
    OmpSessionState
} from './types';

export type OmpSessionMutationType =
    | 'new_session'
    | 'switch_session'
    | 'branch'
    | 'handoff'
    | 'set_session_name';

export type OmpSessionMutationCommand = {
    [Command in OmpSessionMutationType]: OmpCommandByType<Command>
}[OmpSessionMutationType];

export type OmpSessionMutationOutcome =
    | {
        status: 'unchanged';
        response: OmpResponseData<OmpSessionMutationType>;
    }
    | {
        status: 'applied';
        response: OmpResponseData<OmpSessionMutationType>;
        state: OmpSessionState;
        snapshot: OmpNativeSession;
    };

type OmpSessionRpc = Pick<OmpRpcClient, 'request'>;

export function nativeSessionSnapshotFromState(state: OmpSessionState): OmpNativeSession {
    const file = state.sessionFile?.trim();
    if (!file) {
        throw new Error(`OMP session ${state.sessionId} did not expose a persisted session file`);
    }
    const name = state.sessionName?.trim();
    return {
        id: state.sessionId,
        file,
        ...(name ? { name } : {})
    };
}

/** Only an idle, empty native state plus ENOENT proves a lazy journal never existed. */
export async function nativeSessionSnapshotWithPersistence(
    state: OmpSessionState,
    previous?: OmpNativeSession | null
): Promise<OmpNativeSession> {
    const snapshot = nativeSessionSnapshotFromState(state);
    const wasPersisted = previous?.id === snapshot.id && previous.persistence === 'persisted';
    try {
        const info = await stat(snapshot.file);
        if (!info.isFile()) throw new Error(`OMP native journal is not a file: ${snapshot.file}`);
        return { ...snapshot, persistence: 'persisted' };
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        if (wasPersisted) return { ...snapshot, persistence: 'persisted' };
        const knownFresh = previous?.id !== snapshot.id || previous.persistence === 'never-persisted';
        if (knownFresh && state.messageCount === 0 && state.queuedMessageCount === 0
            && !state.isStreaming && !state.isCompacting) {
            return { ...snapshot, persistence: 'never-persisted' };
        }
        // Nonempty, still-active or unknown history must never authorize a fresh replacement.
        return snapshot;
    }
}

export async function reconcileOmpSessionState(
    client: OmpSessionRpc,
    applySnapshot: (snapshot: OmpNativeSession) => void,
    previousSnapshot?: OmpNativeSession | null
): Promise<{ state: OmpSessionState; snapshot: OmpNativeSession }> {
    const state = await client.request({ type: 'get_state' });
    const snapshot = await nativeSessionSnapshotWithPersistence(state, previousSnapshot);
    applySnapshot(snapshot);
    return { state, snapshot };
}

/** A successful switch means native loaded an existing journal; it is never a lazy-empty session. */
function mutationSnapshotPersistence(
    command: OmpSessionMutationCommand,
    snapshot: OmpNativeSession
): OmpNativeSession {
    return command.type === 'switch_session' && snapshot.persistence !== 'persisted'
        ? { ...snapshot, persistence: 'persisted' }
        : snapshot;
}

export async function runOmpSessionMutation(
    client: OmpSessionRpc,
    command: OmpSessionMutationCommand,
    applySnapshot: (snapshot: OmpNativeSession) => void,
    previousSnapshot?: OmpNativeSession | null
): Promise<OmpSessionMutationOutcome> {
    let response: OmpResponseData<OmpSessionMutationType>;
    let changed: boolean;
    switch (command.type) {
        case 'new_session':
        case 'switch_session':
        case 'branch':
            response = await client.request(command);
            changed = !response.cancelled;
            break;
        case 'handoff':
            response = await client.request(command);
            changed = response !== null;
            break;
        case 'set_session_name':
            response = await client.request(command);
            changed = true;
            break;
    }
    if (!changed) {
        return { status: 'unchanged', response };
    }
    let finalSnapshot: OmpNativeSession | null = null;
    const { state } = await reconcileOmpSessionState(
        client,
        (reconciled) => {
            finalSnapshot = mutationSnapshotPersistence(command, reconciled);
            applySnapshot(finalSnapshot);
        },
        previousSnapshot
    );
    return { status: 'applied', response, state, snapshot: finalSnapshot! };
}

export class OmpSessionStateReconciler {
    private tail: Promise<void> = Promise.resolve();

    constructor(
        private readonly client: OmpSessionRpc,
        private readonly applySnapshot: (snapshot: OmpNativeSession) => void,
        private readonly readSnapshot?: () => OmpNativeSession | null
    ) { }

    reconcile(): Promise<{ state: OmpSessionState; snapshot: OmpNativeSession }> {
        const task = this.tail.then(() => reconcileOmpSessionState(this.client, this.applySnapshot, this.readSnapshot?.()));
        this.tail = task.then(() => undefined, () => undefined);
        return task;
    }

    async drain(): Promise<void> {
        await this.tail;
    }
}
