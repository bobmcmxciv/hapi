import { describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import type { SessionProcessOwnership } from './cleanupReceipt';
import type { TrackedSession } from './types';
import { captureSpawnProcessOwnership } from './spawnProcessOwnership';

// These tests drive the deferred OS-probe boundary, not an actual PID. No
// timers, module mocks, signals, provider processes, or cleanup shortcuts.
function birthFixture(native = false) {
 const childState = { pid: 123, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null };
 const child = childState as ChildProcess;
 const session: TrackedSession = {
  startedBy: 'runner', pid: 123, childProcess: child,
  requestedHappySessionId: 'original-row', requiresCleanupReceipt: native,
 };
 const tracked = new Map([[123, session]]);
 const ownerships = new Map<number, SessionProcessOwnership>();
 const deferred = Promise.withResolvers<string | null>();
 const persist = vi.fn(() => true);
 const pending = captureSpawnProcessOwnership({
  child, session, tracked, ownerships, attemptId: 'original-attempt',
  probe: () => deferred.promise, persist,
 });
 return { child, childState, session, tracked, ownerships, deferred, persist, pending };
}

describe('child-bound async birth ownership', () => {
 it('does not enrich another child or row after its probe awaits', async () => {
  const f = birthFixture(true);
  const replacement: SessionProcessOwnership = {
   pid: 123, requestedSessionId: 'replacement-row', processStartMarker: 'replacement-birth',
  };
  f.tracked.set(123, { startedBy: 'runner', pid: 123, requestedHappySessionId: 'replacement-row' });
  f.ownerships.set(123, replacement);
  f.deferred.resolve('replacement-birth');
  expect(await f.pending).toEqual({ marker: null });
  expect(f.ownerships.get(123)).toBe(replacement);
  expect(replacement.ompResumeAttemptId).toBeUndefined();
  expect(f.persist).not.toHaveBeenCalled();
 });

 it('does not enrich a foreign record even if the tracked slot is unchanged', async () => {
  const f = birthFixture(true);
  const foreign: SessionProcessOwnership = {
   pid: 123, requestedSessionId: 'other-row', processStartMarker: 'birth',
  };
  f.ownerships.set(123, foreign);
  f.deferred.resolve('birth');
  expect(await f.pending).toEqual({ marker: null });
  expect(f.ownerships.get(123)).toBe(foreign);
  expect(foreign.ompResumeAttemptId).toBeUndefined();
  expect(f.persist).not.toHaveBeenCalled();
 });

 it.each(['code', 'signal'] as const)('does not stamp a recycled PID after child %s exit', async mode => {
  const f = birthFixture();
  if (mode === 'code') f.childState.exitCode = 0;
  else f.childState.signalCode = 'SIGTERM';
  f.deferred.resolve('recycled-process-birth');
  expect(await f.pending).toEqual({ marker: null });
  expect(f.ownerships.size).toBe(0);
  expect(f.persist).not.toHaveBeenCalled();
 });

 it('quarantines an exited native attempt without stamping the replacement PID birth', async () => {
  const f = birthFixture(true);
  f.childState.exitCode = 0;
  f.deferred.resolve('recycled-process-birth');
  const proof = await f.pending;
  expect(proof.marker).toBeNull();
  expect(f.ownerships.get(123)).toEqual({
   pid: 123, requestedSessionId: 'original-row', processStartMarker: '',
   ompResumeAttemptId: 'original-attempt', requiresCleanupReceipt: true,
  });
  expect(f.persist).toHaveBeenCalledOnce();
 });

 it('requires the same actual child object, not only the same PID and row', async () => {
  const f = birthFixture();
  f.session.childProcess = { pid: 123, exitCode: null, signalCode: null } as ChildProcess;
  f.deferred.resolve('birth');
  expect(await f.pending).toEqual({ marker: null });
  expect(f.ownerships.size).toBe(0);
 });

 it('does not recreate records after a timeout removed the tracked child', async () => {
  const f = birthFixture(true);
  f.tracked.delete(123);
  f.deferred.resolve('birth');
  expect(await f.pending).toEqual({ marker: null });
  expect(f.ownerships.size).toBe(0);
  expect(f.persist).not.toHaveBeenCalled();
 });

 it('enriches only a live matching row and birth without overwriting confirmation', async () => {
  const f = birthFixture(true);
  const record: SessionProcessOwnership = {
   pid: 123, requestedSessionId: 'original-row', confirmedSessionId: 'original-row',
   processStartMarker: 'birth', requiresCleanupReceipt: true,
  };
  f.ownerships.set(123, record);
  f.deferred.resolve('birth');
  expect(await f.pending).toEqual({ marker: 'birth', ownership: record });
  expect(f.ownerships.get(123)).toBe(record);
  expect(record.ompResumeAttemptId).toBe('original-attempt');
  expect(record.confirmedSessionId).toBe('original-row');
  expect(f.persist).toHaveBeenCalledOnce();
 });

 it.each([
  { processStartMarker: 'different-birth', ompResumeAttemptId: undefined },
  { processStartMarker: 'birth', ompResumeAttemptId: 'newer-attempt' },
 ])('refuses another generation of the same row: %j', async identity => {
  const f = birthFixture(true);
  const record: SessionProcessOwnership = { pid: 123, requestedSessionId: 'original-row', ...identity };
  f.ownerships.set(123, record);
  f.deferred.resolve('birth');
  expect(await f.pending).toEqual({ marker: null });
  expect(f.ownerships.get(123)).toBe(record);
  expect(f.persist).not.toHaveBeenCalled();
 });
});
