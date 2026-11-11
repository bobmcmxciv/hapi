import type { ChildProcess } from 'node:child_process';
import spawn from 'cross-spawn';

export const isWindows = (): boolean => process.platform === 'win32';

export function isProcessAlive(pid: number): boolean {
 if (!Number.isFinite(pid) || pid <= 0) {
  return false;
 }

 try {
  process.kill(pid, 0);
  return true;
 } catch {
  return false;
 }
}
/**
 * Async equivalent of `spawn.sync(..., { stdio: 'pipe' })`: collects stdout
 * without ever blocking the event loop. Resolves (never rejects) with the
 * same fields the sync probes consumed; `{ error }` covers launch failures.
 */
function runProcessProbe(
 command: string,
 args: string[],
 options: { env?: NodeJS.ProcessEnv; windowsHide?: boolean } = {}
): Promise<{ status: number | null; stdout: string; error?: Error }> {
 const { promise, resolve } = Promise.withResolvers<{ status: number | null; stdout: string; error?: Error }>();
 let child: ChildProcess;
 try {
  // These noninteractive probes never consume input. An open, unwritten
  // stdin pipe can leave PowerShell waiting for input/EOF after its command.
  child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: options.windowsHide ?? false, env: options.env });
 } catch (error) {
  resolve({ status: null, stdout: '', error: error instanceof Error ? error : new Error(String(error)) });
  return promise;
 }
 let stdout = '';
 let settled = false;
 const finish = (result: { status: number | null; error?: Error }) => {
  if (settled) return;
  settled = true;
  resolve({ status: result.status, stdout, error: result.error });
 };
 child.stdout?.on('data', (chunk: Buffer | string) => { stdout += chunk.toString(); });
 // Drain stderr so a chatty probe can never deadlock on a full OS pipe.
 child.stderr?.resume();
 child.on('error', (error) => finish({ status: null, error }));
 child.on('close', (code) => finish({ status: code }));
 return promise;
}

type MarkerWaiter = (marker: string | null) => void;
const pendingWindowsMarkerProbes = new Map<number, MarkerWaiter[]>();
let windowsMarkerBatchScheduled = false;

async function flushWindowsMarkerProbes(): Promise<void> {
 windowsMarkerBatchScheduled = false;
 const batch = new Map(pendingWindowsMarkerProbes);
 pendingWindowsMarkerProbes.clear();
 const alivePids: number[] = [];
 for (const [pid, waiters] of batch) {
  if (Number.isSafeInteger(pid) && pid > 0 && isProcessAlive(pid)) alivePids.push(pid);
  else for (const resolve of waiters) resolve(null);
 }
 if (alivePids.length === 0) return;
 const markers = new Map<number, string>();
 const powershell = await runProcessProbe('powershell', [
  '-NoProfile', '-NonInteractive', '-Command',
  `foreach ($id in @(${alivePids.join(',')})) { $start = try { (Get-Process -Id $id -ErrorAction Stop).StartTime } catch { $null }; if ($null -eq $start) { $start = try { (Get-CimInstance Win32_Process -Filter "ProcessId = $id").CreationDate } catch { $null } }; if ($null -ne $start) { Write-Output ("{0}|HAPI_MARKER|{1}" -f $id, ($start | Out-String).Trim()) } }`
 ], { windowsHide: true });
 if (!powershell.error && powershell.status === 0) {
  for (const rawLine of powershell.stdout.split(/\r?\n/)) {
   const sep = rawLine.indexOf('|HAPI_MARKER|');
   if (sep <= 0) continue;
   const parsedPid = Number(rawLine.slice(0, sep).trim());
   const marker = rawLine.slice(sep + '|HAPI_MARKER|'.length).trim();
   if (Number.isSafeInteger(parsedPid) && marker) markers.set(parsedPid, marker);
  }
 }
 for (const pid of alivePids) {
  if (!markers.has(pid) && isProcessAlive(pid)) {
   const fallback = await runProcessProbe('wmic', [
    'process', 'where', `ProcessId=${pid}`, 'get', 'CreationDate', '/value'
   ], { windowsHide: true });
   const match = !fallback.error && fallback.status === 0 ? fallback.stdout.match(/CreationDate=([^\r\n]+)/) : null;
   const value = match?.[1]?.trim();
   if (value) markers.set(pid, value);
  }
  const resolved = markers.get(pid) ?? null;
  for (const resolve of batch.get(pid) ?? []) resolve(resolved);
 }
}

/**
 * Stable marker for one OS PID generation; null means the platform probe
 * failed. Async: powershell/wmic/ps runs as a child process instead of a
 * spawn.sync, so ~1s Windows probes no longer starve the event loop. On
 * Windows, concurrent lookups within the same tick coalesce into one
 * PowerShell batch so a 20-session spawn burst does not launch 20 PowerShell
 * runtimes simultaneously. The marker text is byte-identical to the legacy
 * sync probe so previously persisted generation markers still match.
 */
export async function getProcessStartMarkerAsync(pid: number): Promise<string | null> {
 if (!isProcessAlive(pid)) return null;
 if (isWindows()) {
  const { promise, resolve } = Promise.withResolvers<string | null>();
  const waiters = pendingWindowsMarkerProbes.get(pid);
  if (waiters) waiters.push(resolve);
  else pendingWindowsMarkerProbes.set(pid, [resolve]);
  if (!windowsMarkerBatchScheduled) {
   windowsMarkerBatchScheduled = true;
   setImmediate(() => { void flushWindowsMarkerProbes(); });
  }
  return promise;
 }
 const result = await runProcessProbe('ps', ['-p', String(pid), '-o', 'lstart='], {
  env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' }
 });
 if (result.error || result.status !== 0) return null;
 return result.stdout.trim() || null;
}

// ponytail: ps -p is cheap and avoids PID-reuse false positives after OS upgrades/reboots
function isRunnerCommand(commandLine: string): boolean {
 return /(?:^|\s)runner(?:\s|$)/.test(commandLine) && /(?:^|\s)start-sync(?:\s|$)/.test(commandLine);
}

/** Async runner-identity probe; same truth table as the former sync version. */
export async function isHapiRunnerProcessAsync(pid: number): Promise<boolean> {
 if (!isProcessAlive(pid)) {
  return false;
 }
 if (isWindows()) {
  const result = await runProcessProbe('wmic', ['process', 'where', `ProcessId=${pid}`, 'get', 'CommandLine']);
  if (result.error) {
   return true;
  }
  if (result.status !== 0) {
   return isProcessAlive(pid);
  }
  return isRunnerCommand(result.stdout);
 }
 const result = await runProcessProbe('ps', ['-p', String(pid), '-o', 'command=']);
 if (result.error || result.status !== 0) {
  return isProcessAlive(pid);
 }
 return isRunnerCommand(result.stdout);
}

type KillRequest = { pid: number; force: boolean; resolve: (killed: boolean) => void };
const pendingWindowsKillRequests: KillRequest[] = [];
let windowsKillBatchScheduled = false;

async function flushWindowsKillRequests(): Promise<void> {
 windowsKillBatchScheduled = false;
 const batch = pendingWindowsKillRequests.splice(0);
 const requests = batch.filter(item => Number.isSafeInteger(item.pid) && item.pid > 0);
 for (const item of batch) {
  if (!Number.isSafeInteger(item.pid) || item.pid <= 0) item.resolve(false);
 }
 if (requests.length === 0) return;
 const uniquePids = Array.from(new Set(requests.map(item => item.pid)));
 const forceByPid = new Map<number, boolean>();
 for (const item of requests) forceByPid.set(item.pid, (forceByPid.get(item.pid) ?? false) || item.force);
 // Keep OS handles for the observed generations: a disappearing root or a
 // recycled PID is not evidence that its original descendants have exited.
 const script = `
$ErrorActionPreference = 'Stop'
$all = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId)
$roots = @(${uniquePids.map(pid => `@{ Pid = ${pid}; Force = $${forceByPid.get(pid) ? 'true' : 'false'} }`).join(', ')})
$trees = [Collections.Generic.Dictionary[int,object]]::new()
foreach ($item in $roots) {
    $rootPid = [int]$item.Pid
    $owned = [Collections.Generic.List[Diagnostics.Process]]::new()
    try {
        $root = [Diagnostics.Process]::GetProcessById($rootPid)
        $null = $root.Handle
        $rootStart = $root.StartTime.ToUniversalTime().Ticks
        $owned.Add($root)
        $parents = [Collections.Generic.HashSet[int]]::new()
        $null = $parents.Add($rootPid)
        $parentStarts = [Collections.Generic.Dictionary[int,long]]::new()
        $parentStarts.Add($rootPid, $rootStart)
        do {
            $added = $false
            foreach ($entry in $all) {
                $id = [int]$entry.ProcessId
                if ($parents.Contains([int]$entry.ParentProcessId) -and -not $parents.Contains($id)) {
                    try {
                        $child = [Diagnostics.Process]::GetProcessById($id)
                        $null = $child.Handle
                        $childStart = $child.StartTime.ToUniversalTime().Ticks
                        if ($childStart -ge $parentStarts[[int]$entry.ParentProcessId]) {
                            $owned.Add($child)
                            $null = $parents.Add($id)
                            $parentStarts.Add($id, $childStart)
                            $added = $true
                        } else { $child.Dispose() }
                    } catch [ArgumentException] { }
                }
            }
        } while ($added)
        $trees.Add($rootPid, @{ Owned = $owned; Force = [bool]$item.Force })
    } catch {
        foreach ($entry in $owned) { $entry.Dispose() }
    }
}
try {
    foreach ($kv in $trees.GetEnumerator()) {
        $pidVal = $kv.Key
        $forceFlag = $kv.Value.Force
        try {
            if ($forceFlag) { & taskkill.exe /F /T /PID $pidVal *> $null }
            else { & taskkill.exe /T /PID $pidVal *> $null }
        } catch { }
    }
    $deadline = [DateTime]::UtcNow.AddMilliseconds(1500)
    do {
        $anyAlive = $false
        foreach ($kv in $trees.GetEnumerator()) {
            if (@($kv.Value.Owned | Where-Object { -not $_.HasExited }).Count -gt 0) { $anyAlive = $true; break }
        }
        if (-not $anyAlive) { break }
        Start-Sleep -Milliseconds 25
    } while ([DateTime]::UtcNow -lt $deadline)
    foreach ($kv in $trees.GetEnumerator()) {
        $owned = $kv.Value.Owned
        $alive = @($owned | Where-Object { -not $_.HasExited })
        if ($alive.Count -gt 0) {
            for ($i = $owned.Count - 1; $i -ge 0; $i--) {
                if (-not $owned[$i].HasExited) {
                    try { $owned[$i].Kill() } catch { }
                }
            }
        }
    }
    $deadline = [DateTime]::UtcNow.AddSeconds(2)
    do {
        $anyAlive = $false
        foreach ($kv in $trees.GetEnumerator()) {
            if (@($kv.Value.Owned | Where-Object { -not $_.HasExited }).Count -gt 0) { $anyAlive = $true; break }
        }
        if (-not $anyAlive) { break }
        Start-Sleep -Milliseconds 25
    } while ([DateTime]::UtcNow -lt $deadline)
    foreach ($kv in $trees.GetEnumerator()) {
        $alive = @($kv.Value.Owned | Where-Object { -not $_.HasExited })
        if ($alive.Count -eq 0) { Write-Output ("HAPI_TREE_EXITED:{0}" -f $kv.Key) }
    }
} finally {
    foreach ($kv in $trees.GetEnumerator()) {
        foreach ($entry in $kv.Value.Owned) { $entry.Dispose() }
    }
}`;
 const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true
 });
 let output = '';
 let settled = false;
 const finish = () => {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  const exitedPids = new Set<number>();
  for (const line of output.split(/\r?\n/)) {
   const match = /^HAPI_TREE_EXITED:(\d+)$/.exec(line.trim());
   if (match) exitedPids.add(Number(match[1]));
  }
  for (const item of requests) item.resolve(exitedPids.has(item.pid));
 };
 const timer = setTimeout(() => {
  child.kill('SIGKILL');
  finish();
 }, 15_000);
 child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
 child.stderr?.resume();
 child.once('error', () => finish());
 child.once('close', () => finish());
}

function killProcessWindows(pid: number, force: boolean): Promise<boolean> {
 const { promise, resolve } = Promise.withResolvers<boolean>();
 pendingWindowsKillRequests.push({ pid, force, resolve });
 if (!windowsKillBatchScheduled) {
  windowsKillBatchScheduled = true;
  setImmediate(() => { void flushWindowsKillRequests(); });
 }
 return promise;
}

export async function killProcess(pid: number, force: boolean = false): Promise<boolean> {
 if (!Number.isFinite(pid) || pid <= 0) {
  return false;
 }

 if (isWindows()) {
  return killProcessWindows(pid, force);
 }

 try {
  process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
  await waitForProcessToDie(pid, force);
  return true;
 } catch {
  return false;
 }
}

/**
 * Recursively collects all descendant PIDs of a process (depth-first).
 * Returns PIDs in child-first order (leaves first, root last).
 */
function collectProcessTree(pid: number): number[] {
 const pids: number[] = [];

 try {
  const result = spawn.sync('pgrep', ['-P', pid.toString()], { encoding: 'utf8' });
  if (result.stdout) {
   const childPids = result.stdout.trim().split('\n').filter(Boolean).map(Number);
   for (const childPid of childPids) {
    pids.push(...collectProcessTree(childPid));
   }
  }
 } catch {
  // pgrep may not be available
 }

 pids.push(pid);
 return pids;
}

/**
 * Kills a process and all its descendants.
 * Signals are sent synchronously (children first) to work in exit handlers,
 * then waits asynchronously for processes to die.
 */
async function killProcessTree(pid: number, force: boolean): Promise<boolean> {
 // Collect all PIDs first (sync) - returns in child-first order
 const pids = collectProcessTree(pid);

 // Signal all processes synchronously (children first, then root)
 const signal = force ? 'SIGKILL' : 'SIGTERM';
 for (const p of pids) {
  try {
   process.kill(p, signal);
  } catch {
   // Process may have already exited
  }
 }

 // Wait for processes to die (async) - wait for root last
 for (const p of pids) {
  await waitForProcessToDie(p, force);
 }

 return pids.every((candidate) => !isProcessAlive(candidate));
}

/** Kill a PID and its observed descendants, awaiting OS-confirmed termination. */
export async function killProcessTreeByPid(pid: number, force: boolean = false): Promise<boolean> {
 if (!Number.isFinite(pid) || pid <= 0) return false;
 if (isWindows()) return killProcessWindows(pid, force);
 return killProcessTree(pid, force);
}

/**
 * Waits for a process to die, escalating to SIGKILL if SIGTERM doesn't work.
 */
async function waitForProcessToDie(pid: number, force: boolean): Promise<void> {
 const maxWait = 2000;
 const pollInterval = 20;
 let waited = 0;

 while (isProcessAlive(pid) && waited < maxWait) {
  await new Promise(r => setTimeout(r, pollInterval));
  waited += pollInterval;
 }

 // If SIGTERM didn't work and we haven't tried SIGKILL yet, escalate
 if (!force && isProcessAlive(pid)) {
  try {
   process.kill(pid, 'SIGKILL');
  } catch {
   return;
  }
  waited = 0;
  while (isProcessAlive(pid) && waited < 1000) {
   await new Promise(r => setTimeout(r, pollInterval));
   waited += pollInterval;
  }
 }
}

export async function killProcessByChildProcess(
 child: ChildProcess,
 force: boolean = false
): Promise<boolean> {
 const pid = child.pid;
 if (!pid) {
  return false;
 }

 if (isWindows()) {
  // Windows taskkill /T already kills the entire process tree
  return killProcess(pid, force);
 }

 // Kill entire process tree on Unix to prevent orphan processes
 return killProcessTreeByPid(pid, force);
}
