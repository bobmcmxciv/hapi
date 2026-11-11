/**
 * Real runner HTTP/process lifecycle against globalSetup's private Hub.
 * The disposable CLI installation dispatches sessions to inert, live wrappers:
 * no provider CLI, user credentials, production runner, or repository version
 * file participates. Native disposal/receipt contracts have their own suites.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import type { Metadata } from '@/api/types';
import { configuration } from '@/configuration';
import { clearRunnerState, readRunnerState } from '@/persistence';
import { listRunnerSessions, notifyRunnerSessionStarted, spawnRunnerSession, stopRunnerSession } from '@/runner/controlClient';
import { isHapiRunnerProcessAsync, isProcessAlive, isWindows } from '@/utils/process';

const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const originalHome = process.env.HAPI_HOME;
const hubUrl = new URL(process.env.HAPI_API_URL || 'http://invalid');
if (!originalHome || !process.env.CLI_API_TOKEN || hubUrl.hostname !== '127.0.0.1' || !hubUrl.port) {
 throw new Error('Runner integration requires the private Hub environment from globalSetup/setup.ts');
}
const fixtureRoot = mkdtempSync(join(tmpdir(), 'hapi-runner-integration-'));
const installation = join(fixtureRoot, 'cli');
const runnerHome = join(fixtureRoot, 'home');
const workspace = join(fixtureRoot, 'workspace');
const records = join(fixtureRoot, 'processes');
for (const directory of [runnerHome, workspace, records]) mkdirSync(directory, { recursive: true });

// Repoint the shared configuration singleton at this private home instead of
// mutating process.env: persistence and the control client read these fields
// lazily on every call, and vitest gives each test file its own module
// registry so sibling suites keep their own globalSetup home untouched.
Object.assign(configuration, {
 happyHomeDir: runnerHome,
 logsDir: join(runnerHome, 'logs'),
 settingsFile: join(runnerHome, 'settings.json'),
 privateKeyFile: join(runnerHome, 'access.key'),
 runnerStateFile: join(runnerHome, 'runner.state.json'),
 runnerLockFile: join(runnerHome, 'runner.state.json.lock'),
});
mkdirSync(configuration.logsDir, { recursive: true });
const bunExec = process.env.HAPI_BUN_EXEC;
if (!bunExec || !existsSync(bunExec)) throw new Error('globalSetup did not supply a Bun executable');

// Deliberately whitelist instead of spreading process.env: a workstation may
// carry production CLI/OMP homes, credentials, handoff opt-outs, or launch hooks.
const childEnv: NodeJS.ProcessEnv = {
 PATH: process.env.PATH,
 SystemRoot: process.env.SystemRoot,
 WINDIR: process.env.WINDIR,
 TEMP: process.env.TEMP,
 TMP: process.env.TMP,
 TMPDIR: process.env.TMPDIR,
 HOME: runnerHome,
 USERPROFILE: runnerHome,
 APPDATA: runnerHome,
 LOCALAPPDATA: runnerHome,
 HAPI_HOME: runnerHome,
 HAPI_API_URL: hubUrl.href.replace(/\/$/, ''),
 CLI_API_TOKEN: process.env.CLI_API_TOKEN,
 HAPI_RUNNER_HEARTBEAT_INTERVAL: '30000',
 HAPI_DISABLE_VERSION_HANDOFF: '0',
 HAPI_RUNNER_HTTP_TIMEOUT: '5000',
 HAPI_INVOKED_CWD: workspace,
 RUNNER_INTEGRATION_ROOT: fixtureRoot,
 DEBUG: '1',
};

// fixtureGuard.ts must be the FIRST import in the copied entrypoint: ESM
// evaluates import graphs in order, so this module refuses non-isolated
// environments before run.ts (and configuration's mkdir side effects) load.
// index.ts is the ONLY entrypoint in the copied installation; it fails
// closed rather than allowing an unexpected command to reach a provider.
const fixtureGuard = String.raw`
import { join, resolve } from 'node:path';
const root = process.env.RUNNER_INTEGRATION_ROOT;
if (!root || resolve(process.env.HAPI_HOME || '') !== join(root, 'home')
    || new URL(process.env.HAPI_API_URL || '').hostname !== '127.0.0.1') {
  throw new Error('Refusing non-isolated runner fixture');
}
export const fixtureRoot: string = root;
`;
const entrypoint = String.raw`
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixtureRoot as root } from './fixtureGuard';
import { getCliArgs } from './utils/cliArgs';
import { startRunner } from './runner/run';
const args = getCliArgs();
const runner = args[0] === 'runner' && args[1] === 'start-sync';
const startedBy = args[args.indexOf('--started-by') + 1];
if (!runner && !(args[0] === 'claude' && ['runner', 'terminal'].includes(startedBy))) {
  throw new Error('Unsupported fixture invocation: ' + JSON.stringify(args));
}
writeFileSync(join(root, 'processes', process.pid + '.json'), JSON.stringify({
  pid: process.pid, role: runner ? 'runner' : 'session'
}));
if (runner) {
  // Capability discovery/prewarm isolation lives at the copied run.ts call
  // sites (see beforeAll): the real startRunner runs, but its injected probe
  // fails and the prewarm call is gated by the whitelisted fixture env. No
  // installed provider executable or real auth state is ever touched.
  await startRunner({ workspaceRoots: [join(root, 'workspace')] });
} else {
  // This subprocess is intentionally live until the real OS termination path
  // stops it; fake timers cannot keep an independent process alive.
  const keepAlive = setInterval(() => {}, 1000);
  const state = JSON.parse(readFileSync(join(root, 'home', 'runner.state.json'), 'utf8'));
  const idIndex = args.indexOf('--session-id');
  const sessionId = idIndex < 0 ? randomUUID() : args[idIndex + 1];
  const response = await fetch('http://127.0.0.1:' + state.httpPort + '/session-started', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, metadata: {
      path: join(root, 'workspace'), host: 'isolated-fixture', homeDir: join(root, 'home'),
      happyHomeDir: join(root, 'home'), happyLibDir: join(root, 'cli'), happyToolsDir: join(root, 'tools'),
      hostPid: process.pid, startedBy, machineId: 'isolated-runner-fixture', flavor: 'claude'
    } }), signal: AbortSignal.timeout(15000)
  });
  if (!response.ok || (await response.json()).status !== 'ok') {
    clearInterval(keepAlive);
    throw new Error('Session webhook failed: HTTP ' + response.status);
  }
  console.log('FIXTURE_SESSION_READY ' + sessionId);
}
`;

type OwnedProcess = { pid: number; role: 'runner' | 'session' };
const directChildren = new Set<ChildProcess>();
let runnerChild: ChildProcess;
let runnerPid: number;
let output = '';
let testFailed = false;

function ownedProcesses(): OwnedProcess[] {
 return readdirSync(records).filter(name => name.endsWith('.json')).map(name =>
  JSON.parse(readFileSync(join(records, name), 'utf8')) as OwnedProcess
 );
}

async function waitFor(condition: () => boolean | Promise<boolean>, timeout = 15_000): Promise<void> {
 const deadline = Date.now() + timeout;
 while (Date.now() < deadline) {
  if (await condition()) return;
  // Real subprocess startup/exit and the runner's heartbeat use another clock;
  // fake timers cannot drive them. Poll an observable condition, never sleep
  // for an assumed startup duration.
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, 50);
  await promise;
 }
 throw new Error(`Runner condition timed out. Isolated evidence: ${fixtureRoot}\n${output.slice(-8000)}`);
}

function launch(args: string[]): ChildProcess {
 const child = spawn(bunExec!, ['--smol', '--no-env-file', '--cwd', installation, join(installation, 'src/index.ts'), ...args], {
  cwd: workspace, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
 });
 directChildren.add(child);
 child.stdout?.on('data', data => { output += data.toString(); });
 child.stderr?.on('data', data => { output += data.toString(); });
 child.on('error', error => { output += `\nSpawn error: ${error.message}`; });
 return child;
}

async function runnerPost(route: string, body = {}): Promise<unknown> {
 const state = await readRunnerState();
 const owned = ownedProcesses().some(record => record.pid === state?.pid && record.role === 'runner');
 if (!state || !owned || !isProcessAlive(state.pid)) {
  throw new Error('Refusing HTTP request to an unowned runner generation');
 }
 const response = await fetch(`http://127.0.0.1:${state.httpPort}${route}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  signal: AbortSignal.timeout(5000),
 });
 if (!response.ok) throw new Error(`Runner ${route}: HTTP ${response.status}: ${await response.text()}`);
 return response.json();
}

async function terminateOwned(record: OwnedProcess): Promise<void> {
 if (!isProcessAlive(record.pid)) return;
 const child = [...directChildren].find(candidate => candidate.pid === record.pid);
 if (child) {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await waitFor(() => !isProcessAlive(record.pid));
  return;
 }
 if (!await isHapiRunnerProcessAsync(record.pid)) {
  if (!isProcessAlive(record.pid)) return;
  throw new Error(`Refusing cleanup of reused/unproven PID ${record.pid}`);
 }
 // Each fixture is a single inert process. Do not tree-kill an arbitrary PID.
 process.kill(record.pid, 'SIGKILL');
 await waitFor(() => !isProcessAlive(record.pid));
}

async function startTerminal(sessionId: string): Promise<ChildProcess> {
 const child = launch(['claude', '--started-by', 'terminal', '--session-id', sessionId]);
 await waitFor(async () => (await listRunnerSessions()).some(session => session.pid === child.pid));
 return child;
}

describe('Runner Integration Tests', { timeout: 60_000 }, () => {
 beforeAll(() => {
  // Real implementation, private installation. Updating its package version
  // exercises the actual mtime detector and replacement spawn without ever
  // writing to the user's checkout. Dependency links are read-only fixtures.
  cpSync(join(cliRoot, 'src'), join(installation, 'src'), {
   recursive: true, filter: source => !source.endsWith('.test.ts'),
  });
  cpSync(join(cliRoot, '../fork-features'), join(fixtureRoot, 'fork-features'), { recursive: true });
  cpSync(join(cliRoot, '../tsconfig.base.json'), join(fixtureRoot, 'tsconfig.base.json'));
  for (const file of ['package.json', 'tsconfig.json', 'bunfig.toml']) {
   cpSync(join(cliRoot, file), join(installation, file));
  }
  symlinkSync(join(cliRoot, 'node_modules'), join(installation, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  symlinkSync(join(cliRoot, '../node_modules'), join(fixtureRoot, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  symlinkSync(join(cliRoot, '../shared'), join(fixtureRoot, 'shared'), process.platform === 'win32' ? 'junction' : 'dir');
  writeFileSync(join(installation, 'src/index.ts'), entrypoint);
  writeFileSync(join(installation, 'src/fixtureGuard.ts'), fixtureGuard);
  // Isolate the provider probe at its own call site in the COPIED run.ts:
  // the real detectOmpMachineAvailability still runs, but with an injected
  // probe that fails instead of shelling out to an installed `omp`, and the
  // model prewarm call is gated on the whitelisted fixture env. The runner's
  // HTTP/process/handoff lifecycle code itself is untouched; the source tree
  // under cliRoot is never modified.
  const runPath = join(installation, 'src/runner/run.ts');
  const runSource = readFileSync(runPath, 'utf8');
  const patchedRun = runSource
   .replace(
    'await detectOmpMachineAvailability()',
    'await detectOmpMachineAvailability(() => Promise.reject('
    + "new Error('isolated runner lifecycle fixture')))"
   )
   .replace(
    'scheduleCursorModelsPrewarm()',
    'if (!process.env.RUNNER_INTEGRATION_ROOT) scheduleCursorModelsPrewarm()'
   );
  if (patchedRun === runSource) {
   throw new Error('Copied run.ts probe call sites not found; fixture isolation not applied');
  }
  writeFileSync(runPath, patchedRun);
  // Defense against accidental pre-imports using a different singleton home.
  expect(configuration.happyHomeDir).toBe(runnerHome);
 });

 beforeEach(async () => {
  output = '';
  expect(ownedProcesses().filter(record => isProcessAlive(record.pid))).toEqual([]);
  await clearRunnerState();
  runnerChild = launch(['runner', 'start-sync']);
  if (!runnerChild.pid) throw new Error('No runner PID returned');
  runnerPid = runnerChild.pid;
  // A state file is written BEFORE registration and shutdown setup. Wait for
  // the final startup log as well, not stale state or a fixed sleep.
  await waitFor(async () => {
   if (runnerChild.exitCode !== null) throw new Error(`Runner exited during startup\n${output}`);
   const state = await readRunnerState();
   return state?.pid === runnerPid && Boolean(state.runnerLogPath)
    && readFileSync(state.runnerLogPath!, 'utf8').includes('Runner started successfully, waiting for shutdown request');
  }, 8000);
  expect(await runnerPost('/list')).toEqual({ children: [] });
 });

 afterEach(async context => {
  testFailed ||= context.task.result?.state === 'fail';
  try {
   const state = await readRunnerState();
   if (state && isProcessAlive(state.pid)) {
    // Sessions deliberately outlive runner stop. Dispose them first, even
    // when a failed assertion interrupted the test's ordinary cleanup.
    const sessions = await listRunnerSessions();
    await Promise.all(sessions.map(session => stopRunnerSession(session.happySessionId)));
    await runnerPost('/stop');
    await waitFor(() => !isProcessAlive(state.pid));
   }
  } catch (error) {
   testFailed = true;
   throw error;
  } finally {
   // Also cover early startup failures and handoff descendants. Only saved,
   // generation-verified fixture PIDs or our own ChildProcess handles qualify.
   for (const child of directChildren) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
   }
   try {
    await Promise.all(ownedProcesses().map(terminateOwned));
   } catch (error) {
    testFailed = true;
    throw error;
   }
   directChildren.clear();
   await clearRunnerState();
   writeFileSync(join(fixtureRoot, 'last-test-output.log'), output);
   expect(ownedProcesses().filter(record => isProcessAlive(record.pid))).toEqual([]);
  }
 }, 60_000);

 afterAll(() => {
  // Failed runs retain private Hub/runner evidence for diagnosis. Never remove
  // the read-only dependency link recursively through its target.
  if (!testFailed && !ownedProcesses().some(record => isProcessAlive(record.pid))) {
   rmSync(fixtureRoot, { recursive: true, force: true });
  } else {
   console.log(`[TEST] Retained isolated runner evidence: ${fixtureRoot}`);
  }
 });

 it('should list sessions (initially empty)', async () => {
  expect(await listRunnerSessions()).toEqual([]);
 });

 it('should not promote a runner webhook without owned child generation', async () => {
  const metadata: Metadata = {
   path: workspace, host: 'unowned-fixture', homeDir: runnerHome, happyHomeDir: runnerHome,
   happyLibDir: installation, happyToolsDir: join(fixtureRoot, 'tools'), hostPid: process.pid,
   startedBy: 'runner', machineId: 'isolated-runner-fixture',
  };
  expect(await notifyRunnerSessionStarted('unowned-row', metadata)).toEqual({ status: 'ok' });
  expect(await listRunnerSessions()).toEqual([]);
  expect(await stopRunnerSession('unowned-row')).toBe('still_alive');
  expect(isProcessAlive(process.pid)).toBe(true);
 });

 it('should track session-started webhook from a live terminal session', async () => {
  const child = await startTerminal('terminal-webhook');
  const sessions = await listRunnerSessions();
  expect(sessions).toEqual([{
   startedBy: 'hapi directly - likely by user from terminal', happySessionId: 'terminal-webhook', pid: child.pid,
  }]);
  const ownerships = JSON.parse(readFileSync(`${configuration.runnerStateFile}.resume-processes.json`, 'utf8'));
  expect(ownerships).toEqual([expect.objectContaining({
   pid: child.pid, confirmedSessionId: 'terminal-webhook', processStartMarker: expect.any(String),
  })]);
  expect(await stopRunnerSession('terminal-webhook')).toBe('stopped');
  expect(await stopRunnerSession('terminal-webhook')).toBe('already_gone');
 });

 it('should spawn & stop a session via HTTP', async () => {
  const response = await spawnRunnerSession(workspace, 'spawned-test-456');
  expect(response).toMatchObject({ success: true, sessionId: expect.any(String) });
  const sessions = await listRunnerSessions();
  expect(sessions).toHaveLength(1);
  expect(sessions[0]).toMatchObject({ happySessionId: response.sessionId, startedBy: 'runner' });
  expect(isProcessAlive(sessions[0].pid)).toBe(true);
  expect(await stopRunnerSession(response.sessionId)).toBe('stopped');
  expect(await stopRunnerSession(response.sessionId)).toBe('already_gone');
  expect(await stopRunnerSession('unknown-session-id')).toBe('still_alive');
 });

 it('stress test: spawn / stop', { timeout: 60_000 }, async () => {
  const sessionCount = 20;
  const spawning = Promise.all(Array.from({ length: sessionCount }, () => spawnRunnerSession(workspace)));
  // Exercise the ordinary control route while all 20 births are in flight.
  // This retains the route's existing timeout; no stress count is reduced.
  const [results, responsive] = await Promise.all([spawning, runnerPost('/list')]);
  expect(responsive).toHaveProperty('children');
  // Never let failed HTTP requests masquerade as partial successful tracking.
  results.forEach(result => expect(result).toMatchObject({ success: true, sessionId: expect.any(String) }));
  const sessionIds = results.map(result => result.sessionId);
  expect(new Set(sessionIds).size).toBe(sessionCount);
  const sessions = await listRunnerSessions();
  expect(sessions).toHaveLength(sessionCount);
  expect(new Set(sessions.map(session => session.happySessionId))).toEqual(new Set(sessionIds));
  expect(sessions.every(session => isProcessAlive(session.pid))).toBe(true);
  const stopped = await Promise.all(sessionIds.map(id => stopRunnerSession(id)));
  expect(stopped.every(status => status === 'stopped' || status === 'already_gone')).toBe(true);
  expect(await listRunnerSessions()).toEqual([]);
  expect(sessions.every(session => !isProcessAlive(session.pid))).toBe(true);
 });

 it('should handle runner stop request gracefully', async () => {
  await runnerPost('/stop');
  await waitFor(() => runnerChild.exitCode !== null && !isProcessAlive(runnerPid) && !existsSync(configuration.runnerStateFile));
  expect(runnerChild.exitCode).toBe(0);
 });

 it('should track both runner-spawned and terminal sessions', async () => {
  const terminal = await startTerminal('terminal-session-aaa');
  const response = await spawnRunnerSession(workspace, 'runner-session-bbb');
  expect(response).toMatchObject({ success: true, sessionId: expect.any(String) });
  const sessions = await listRunnerSessions();
  expect(sessions).toHaveLength(2);
  expect(sessions.find(session => session.pid === terminal.pid)).toMatchObject({
   startedBy: 'hapi directly - likely by user from terminal', happySessionId: 'terminal-session-aaa',
  });
  expect(sessions.find(session => session.happySessionId === response.sessionId)).toMatchObject({ startedBy: 'runner' });
  expect(await stopRunnerSession('terminal-session-aaa')).toBe('stopped');
  expect(await stopRunnerSession(response.sessionId)).toBe('stopped');
  expect(await listRunnerSessions()).toEqual([]);
 });

 it('should update session metadata when webhook is called', async () => {
  const response = await spawnRunnerSession(workspace);
  expect(response).toMatchObject({ success: true, sessionId: expect.any(String) });
  const [session] = await listRunnerSessions();
  const metadata: Metadata = {
   path: workspace, host: 'updated-fixture', homeDir: runnerHome, happyHomeDir: runnerHome,
   happyLibDir: installation, happyToolsDir: join(fixtureRoot, 'tools'), hostPid: session.pid,
   startedBy: 'runner', machineId: 'isolated-runner-fixture',
  };
  expect(await notifyRunnerSessionStarted('updated-session-id', metadata)).toEqual({ status: 'ok' });
  expect(await listRunnerSessions()).toEqual([{ ...session, happySessionId: 'updated-session-id' }]);
  const state = await readRunnerState();
  expect(readFileSync(state!.runnerLogPath!, 'utf8')).toContain('updated-fixture');
  expect(await stopRunnerSession('updated-session-id')).toBe('stopped');
 });

 it('should not allow starting a second runner', async () => {
  const second = launch(['runner', 'start-sync']);
  await waitFor(() => second.exitCode !== null);
  expect(second.exitCode).toBe(0);
  expect(output).toContain('already running');
  expect((await readRunnerState())?.pid).toBe(runnerPid);
  expect(isProcessAlive(runnerPid)).toBe(true);
 });

 it('should handle concurrent session operations', async () => {
  const results = await Promise.all(Array.from({ length: 3 }, () => spawnRunnerSession(workspace)));
  results.forEach(result => expect(result).toMatchObject({ success: true, sessionId: expect.any(String) }));
  const sessions = await listRunnerSessions();
  expect(sessions).toHaveLength(3);
  expect(new Set(sessions.map(session => session.happySessionId))).toEqual(new Set(results.map(result => result.sessionId)));
  expect(await Promise.all(results.map(result => stopRunnerSession(result.sessionId)))).toEqual(['stopped', 'stopped', 'stopped']);
  expect(await listRunnerSessions()).toEqual([]);
 });

 it('should die with logs when SIGKILL is sent', async () => {
  const state = await readRunnerState();
  expect(state?.runnerLogPath).toBeDefined();
  runnerChild.kill('SIGKILL');
  await waitFor(() => (runnerChild.exitCode !== null || runnerChild.signalCode !== null) && !isProcessAlive(runnerPid));
  expect(existsSync(state!.runnerLogPath!)).toBe(true);
  expect(readFileSync(state!.runnerLogPath!, 'utf8')).not.toContain('Cleanup completed, exiting process');
 });

 it('should die with cleanup logs when a graceful shutdown is requested', async () => {
  const state = await readRunnerState();
  if (isWindows()) await runnerPost('/stop');
  else runnerChild.kill('SIGTERM');
  // The OS may reap the process before Node fires 'exit'; assert on the real
  // exit code only once the runtime actually reported it.
  await waitFor(() => runnerChild.exitCode !== null && !isProcessAlive(runnerPid) && !existsSync(configuration.runnerStateFile));
  const log = readFileSync(state!.runnerLogPath!, 'utf8');
  if (!isWindows()) expect(log).toContain('SIGTERM');
  expect(log).toContain('Cleanup completed, exiting process with code 0');
  expect(runnerChild.exitCode).toBe(0);
 });

 it('should replace an outdated runner using the updated isolated installation', { timeout: 60_000 }, async () => {
  const initialState = await readRunnerState();
  const packagePath = join(installation, 'package.json');
  const original = JSON.parse(readFileSync(packagePath, 'utf8'));
  const version = '0.0.0-runner-integration-update';
  writeFileSync(packagePath, JSON.stringify({ ...original, version }));
  // Guarantee a different mtime even on coarse-resolution filesystems.
  const updatedTime = new Date(statSync(packagePath).mtimeMs + 2000);
  utimesSync(packagePath, updatedTime, updatedTime);
  const installedMtime = statSync(packagePath).mtimeMs;
  expect(installedMtime).not.toBe(initialState!.startedWithCliMtimeMs);
  await waitFor(async () => {
   const state = await readRunnerState();
   return state?.pid !== initialState!.pid && state?.startedWithCliVersion === version
    && state.startedWithCliMtimeMs === installedMtime && isProcessAlive(state.pid);
  }, 45_000);
  await waitFor(() => runnerChild.exitCode !== null && !isProcessAlive(runnerPid));
  const replacement = await readRunnerState();
  expect(replacement!.startedWithArgv).toEqual(initialState!.startedWithArgv);
  expect(replacement!.startedWithMachineId).toBe(initialState!.startedWithMachineId);
  expect(replacement!.startedWithApiUrl).toBe(initialState!.startedWithApiUrl);
  expect(await runnerPost('/list')).toEqual({ children: [] });
  expect(JSON.parse(readFileSync(join(cliRoot, 'package.json'), 'utf8')).version).toBe(original.version);
 });
});
