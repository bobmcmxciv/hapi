import type { ChildProcess } from 'node:child_process';
import type { SessionProcessOwnership } from './cleanupReceipt';
import type { TrackedSession } from './types';

/** Complete birth probing only for the child object and row that requested it. */
export async function captureSpawnProcessOwnership(options: {
 child: ChildProcess;
 session: TrackedSession;
 tracked: Map<number, TrackedSession>;
 ownerships: Map<number, SessionProcessOwnership>;
 attemptId?: string;
 probe: (pid: number) => Promise<string | null>;
 persist: () => boolean;
}): Promise<{ marker: string | null; ownership?: SessionProcessOwnership }> {
 const { child, session, tracked, ownerships, attemptId, probe, persist } = options;
 const pid = session.pid;
 const marker = await probe(pid);
 // A PID is not a process handle. Do not adopt/enrich a different child's
 // record or stamp the birth time of a replacement PID after the await.
 if (tracked.get(pid) !== session || session.childProcess !== child || child.pid !== pid) {
  return { marker: null };
 }
 const alive = child.exitCode === null && child.signalCode === null;
 const current = ownerships.get(pid);
 if (current) {
  const requestedId = session.requestedHappySessionId ?? session.happySessionId;
  if (!requestedId || current.requestedSessionId !== requestedId
   || !alive || !marker || current.processStartMarker !== marker
   || (current.ompResumeAttemptId !== undefined && current.ompResumeAttemptId !== attemptId)) {
   return { marker: null };
  }
  if (!current.ompResumeAttemptId && attemptId) {
   current.ompResumeAttemptId = attemptId;
   persist();
  }
  return { marker, ownership: current };
 }
 const requestedId = session.requestedHappySessionId;
 if (!requestedId) return { marker: alive ? marker : null };
 // Even an exited/unprobeable OMP wrapper can leave native resources behind.
 // Quarantine its attempt without attributing any recycled PID's birth to it.
 if ((!alive || !marker) && !session.requiresCleanupReceipt) return { marker: null };
 const ownership: SessionProcessOwnership = {
  requestedSessionId: requestedId,
  pid,
  processStartMarker: alive ? marker ?? '' : '',
  ompResumeAttemptId: attemptId,
  requiresCleanupReceipt: session.requiresCleanupReceipt,
 };
 ownerships.set(pid, ownership);
 persist();
 return { marker: alive ? marker : null, ownership };
}
