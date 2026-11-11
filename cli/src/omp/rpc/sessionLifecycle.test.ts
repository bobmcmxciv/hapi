import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { OmpCommand, OmpSessionState } from './types';
import type { OmpNativeSession } from '@hapi/protocol/types';
import {
    nativeSessionSnapshotFromState,
    nativeSessionSnapshotWithPersistence,
    parseOmpSessionMutation,
    runOmpSessionMutation,
    OmpSessionStateReconciler,
} from './sessionLifecycle';

function state(id: string = 'session-2'): OmpSessionState {
    return {
        isStreaming: false,
        isCompacting: false,
        steeringMode: 'all',
        followUpMode: 'all',
        interruptMode: 'immediate',
        sessionId: id,
        sessionFile: `/sessions/${id}.jsonl`,
        sessionName: 'Renamed session',
        autoCompactionEnabled: true,
        messageCount: 0,
        queuedMessageCount: 0,
        todoPhases: []
    };
}

const roots: string[] = [];
afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryState(): Promise<OmpSessionState> {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hapi-omp-persistence-'));
    roots.push(root);
    return { ...state(), sessionFile: path.join(root, 'session.jsonl') };
}

describe('OMP native session lifecycle', () => {
    it('parses only the native session slash commands', () => {
        expect(parseOmpSessionMutation(' /clear ')).toEqual({ type: 'new_session' });
        expect(parseOmpSessionMutation('/new')).toEqual({ type: 'new_session' });
        expect(parseOmpSessionMutation('/rename  Renamed session ')).toEqual({
            type: 'set_session_name',
            name: 'Renamed session'
        });
        expect(parseOmpSessionMutation('/handoff focus on verification')).toEqual({
            type: 'handoff',
            customInstructions: 'focus on verification'
        });
        expect(parseOmpSessionMutation('/handoff')).toEqual({ type: 'handoff' });
        expect(parseOmpSessionMutation('/resume 019f75fa')).toEqual({
            type: 'resume_session',
            sessionArg: '019f75fa'
        });
        expect(parseOmpSessionMutation('/resume')).toEqual({ type: 'resume_session_picker' });
        expect(parseOmpSessionMutation('/rename')).toEqual({
            type: 'invalid_session_command',
            message: 'Usage: /rename <title>'
        });
        expect(parseOmpSessionMutation('/clear\nnext prompt')).toBeNull();
    });

    it('constructs the authoritative metadata snapshot from get_state', () => {
        expect(nativeSessionSnapshotFromState(state())).toEqual({
            id: 'session-2',
            file: '/sessions/session-2.jsonl',
            name: 'Renamed session'
        });
    });

    it('rejects a state that does not expose sessionFile', () => {
        const missingFile = state();
        delete missingFile.sessionFile;
        expect(() => nativeSessionSnapshotFromState(missingFile)).toThrow(/persisted session file/);
    });

    it('distinguishes a fresh empty lazy journal from a missing real or legacy journal', async () => {
        const native = await temporaryState();
        await expect(nativeSessionSnapshotWithPersistence(native)).resolves.toMatchObject({ persistence: 'never-persisted' });
        const previous = nativeSessionSnapshotFromState(native);
        const legacy = await nativeSessionSnapshotWithPersistence(native, previous);
        expect(legacy.persistence).toBeUndefined();
        await expect(nativeSessionSnapshotWithPersistence(native, { ...previous, persistence: 'persisted' }))
            .resolves.toMatchObject({ persistence: 'persisted' });
        await expect(nativeSessionSnapshotWithPersistence({ ...native, messageCount: 1 }))
            .resolves.not.toHaveProperty('persistence');
        await expect(nativeSessionSnapshotWithPersistence({ ...native, queuedMessageCount: 1 }))
            .resolves.not.toHaveProperty('persistence');
        await expect(nativeSessionSnapshotWithPersistence({ ...native, isStreaming: true }))
            .resolves.not.toHaveProperty('persistence');
    });

    it('counts a header-only native journal as persisted and never downgrades same-ID history', async () => {
        const native = await temporaryState();
        await writeFile(native.sessionFile!, `${JSON.stringify({ type: 'session', id: native.sessionId, cwd: '/work' })}\n`);
        const persisted = await nativeSessionSnapshotWithPersistence(native);
        expect(persisted.persistence).toBe('persisted');
        await rm(native.sessionFile!);
        expect((await nativeSessionSnapshotWithPersistence(native, persisted)).persistence).toBe('persisted');
    });

    it('feeds the previously applied snapshot into delayed reconciles so a lazy-empty marker survives', async () => {
        const native = await temporaryState();
        const applied: OmpNativeSession[] = [];
        const client = {
            request: vi.fn(async (command: OmpCommand) => {
                if (command.type === 'get_state') return native;
                throw new Error(`Unexpected command ${command.type}`);
            })
        };
        const latest = { snapshot: null as OmpNativeSession | null };
        const reconciler = new OmpSessionStateReconciler(
            client as never,
            (snapshot) => { applied.push(snapshot); latest.snapshot = snapshot; },
            () => latest.snapshot
        );

        await reconciler.reconcile();
        expect(applied[0]?.persistence).toBe('never-persisted');
        await reconciler.reconcile();
        expect(applied[1]?.persistence).toBe('never-persisted');
        expect(client.request).toHaveBeenCalledTimes(2);
        await reconciler.drain();
    });

    it('retains persisted history when a reconcile observes the journal has gone missing', async () => {
        const native = await temporaryState();
        await writeFile(native.sessionFile!, `${JSON.stringify({ type: 'session', id: native.sessionId, cwd: '/work' })}\n`);
        const latest = { snapshot: null as OmpNativeSession | null };
        const client = { request: vi.fn(async () => native) };
        const reconciler = new OmpSessionStateReconciler(
            client as never,
            (snapshot) => { latest.snapshot = snapshot; },
            () => latest.snapshot
        );

        await reconciler.reconcile();
        expect(latest.snapshot?.persistence).toBe('persisted');
        await rm(native.sessionFile!);
        await reconciler.reconcile();
        expect(latest.snapshot?.persistence).toBe('persisted');
    });

    it('does not authorize an empty marker when input is queued or a turn is in flight', async () => {
        const native = await temporaryState();
        for (const active of [{ queuedMessageCount: 1 }, { isStreaming: true }, { isCompacting: true }]) {
            const client = { request: vi.fn(async () => ({ ...native, ...active })) };
            const { snapshot } = await (new OmpSessionStateReconciler(
                client as never,
                () => undefined
            )).reconcile();
            expect(snapshot.persistence).toBeUndefined();
        }
    });

    it('runs get_state immediately after set_session_name and applies one atomic snapshot', async () => {
        const calls: OmpCommand[] = [];
        const apply = vi.fn();
        const client = {
            request: vi.fn(async (command: OmpCommand) => {
                calls.push(command);
                return command.type === 'get_state' ? state() : undefined;
            })
        };

        const outcome = await runOmpSessionMutation(
            client as never,
            { type: 'set_session_name', name: 'Renamed session' },
            apply
        );

        expect(calls).toEqual([
            { type: 'set_session_name', name: 'Renamed session' },
            { type: 'get_state' }
        ]);
        expect(outcome.status).toBe('applied');
        expect(apply).toHaveBeenCalledOnce();
        expect(apply).toHaveBeenCalledWith(expect.objectContaining({
            id: 'session-2',
            file: '/sessions/session-2.jsonl',
            name: 'Renamed session'
        }));
    });

    it('runs get_state after a successful new_session mutation', async () => {
        const calls: string[] = [];
        const client = {
            request: vi.fn(async (command: OmpCommand) => {
                calls.push(command.type);
                if (command.type === 'new_session') return { cancelled: false };
                if (command.type === 'get_state') return state('fresh-session');
                throw new Error(`Unexpected command ${command.type}`);
            })
        };

        const outcome = await runOmpSessionMutation(
            client as never,
            { type: 'new_session' },
            () => undefined
        );

        expect(calls).toEqual(['new_session', 'get_state']);
        expect(outcome).toMatchObject({
            status: 'applied',
            snapshot: { id: 'fresh-session', file: '/sessions/fresh-session.jsonl' }
        });
    });

    it('does not reconcile a cancelled branch mutation', async () => {
        const calls: string[] = [];
        const client = {
            request: vi.fn(async (command: OmpCommand) => {
                calls.push(command.type);
                return { text: 'target', cancelled: true };
            })
        };

        const outcome = await runOmpSessionMutation(
            client as never,
            { type: 'branch', entryId: 'entry-1' },
            () => undefined
        );

        expect(outcome.status).toBe('unchanged');
        expect(calls).toEqual(['branch']);
    });

    it('runs get_state after successful switch_session and handoff mutations', async () => {
        const calls: OmpCommand[] = [];
        const client = {
            request: vi.fn(async (command: OmpCommand) => {
                calls.push(command);
                if (command.type === 'switch_session') return { cancelled: false };
                if (command.type === 'handoff') return { savedPath: '/handoff.md' };
                if (command.type === 'get_state') return state();
                throw new Error(`Unexpected command ${command.type}`);
            })
        };

        await runOmpSessionMutation(
            client as never,
            { type: 'switch_session', sessionPath: '/sessions/session-2.jsonl' },
            () => undefined
        );
        await runOmpSessionMutation(
            client as never,
            { type: 'handoff', customInstructions: 'continue verification' },
            () => undefined
        );

        expect(calls.map((command) => command.type)).toEqual([
            'switch_session',
            'get_state',
            'handoff',
            'get_state'
        ]);
    });

    it('marks a successful switch target persisted even when its journal is externally deleted', async () => {
        const native = await temporaryState();
        const applied: Array<{ persistence?: string }> = [];
        const client = {
            request: vi.fn(async (command: OmpCommand) => {
                if (command.type === 'switch_session') return { cancelled: false };
                if (command.type === 'get_state') return native;
                throw new Error(`Unexpected command ${command.type}`);
            })
        };

        const outcome = await runOmpSessionMutation(
            client as never,
            { type: 'switch_session', sessionPath: native.sessionFile! },
            (snapshot) => applied.push(snapshot)
        );

        expect(outcome.status).toBe('applied');
        expect(outcome.status === 'applied' ? outcome.snapshot.persistence : undefined).toBe('persisted');
        expect(applied[applied.length - 1]?.persistence).toBe('persisted');
    });

    it('forwards the previous snapshot so a rename cannot downgrade or fabricate history', async () => {
        const native = await temporaryState();
        const previous = { id: native.sessionId, file: native.sessionFile!, persistence: 'persisted' as const };
        const client = {
            request: vi.fn(async (command: OmpCommand) => {
                if (command.type === 'set_session_name') return undefined;
                if (command.type === 'get_state') return native;
                throw new Error(`Unexpected command ${command.type}`);
            })
        };

        const outcome = await runOmpSessionMutation(
            client as never,
            { type: 'set_session_name', name: 'Renamed' },
            () => undefined,
            previous
        );

        expect(outcome).toMatchObject({ status: 'applied', snapshot: { persistence: 'persisted' } });
    });
});
