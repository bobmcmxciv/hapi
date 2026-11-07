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

/** Stable marker for one OS PID generation; null means the platform probe failed. */
export function getProcessStartMarker(pid: number): string | null {
  if (!isProcessAlive(pid)) return null;
  if (isWindows()) {
    const powershell = spawn.sync('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CreationDate`
    ], { stdio: 'pipe', windowsHide: true });
    if (!powershell.error && powershell.status === 0) {
      const marker = powershell.stdout?.toString().trim();
      if (marker) return marker;
    }
    const result = spawn.sync('wmic', [
      'process', 'where', `ProcessId=${pid}`, 'get', 'CreationDate', '/value'
    ], { stdio: 'pipe', windowsHide: true });
    if (result.error || result.status !== 0) return null;
    const match = (result.stdout?.toString() ?? '').match(/CreationDate=([^\r\n]+)/);
    return match?.[1]?.trim() || null;
  }
  const result = spawn.sync('ps', ['-p', String(pid), '-o', 'lstart='], {
    stdio: 'pipe',
    env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' }
  });
  if (result.error || result.status !== 0) return null;
  return result.stdout?.toString().trim() || null;
}

// ponytail: ps -p is cheap and avoids PID-reuse false positives after OS upgrades/reboots
function isRunnerCommand(commandLine: string): boolean {
  return /(?:^|\s)runner(?:\s|$)/.test(commandLine) && /(?:^|\s)start-sync(?:\s|$)/.test(commandLine);
}

export function isHapiRunnerProcess(pid: number): boolean {
  if (!isProcessAlive(pid)) {
    return false;
  }
  if (isWindows()) {
    const result = spawn.sync('wmic', ['process', 'where', `ProcessId=${pid}`, 'get', 'CommandLine'], { stdio: 'pipe' });
    if (result.error) {
      return true;
    }
    if (result.status !== 0) {
      return isProcessAlive(pid);
    }
    return isRunnerCommand(result.stdout?.toString() ?? '');
  }
  const result = spawn.sync('ps', ['-p', String(pid), '-o', 'command='], { stdio: 'pipe' });
  if (result.error || result.status !== 0) {
    return isProcessAlive(pid);
  }
  return isRunnerCommand(result.stdout?.toString() ?? '');
}

async function killProcessWindows(pid: number, force: boolean): Promise<boolean> {
  // Keep OS handles for the observed generations: a disappearing root or a
  // recycled PID is not evidence that its original descendants have exited.
  const script = `
$ErrorActionPreference = 'Stop'
$owned = [Collections.Generic.List[Diagnostics.Process]]::new()
try {
    $root = [Diagnostics.Process]::GetProcessById(${pid})
    $null = $root.Handle
    $rootStart = $root.StartTime.ToUniversalTime().Ticks
    $owned.Add($root)
    $parents = [Collections.Generic.HashSet[int]]::new()
    $null = $parents.Add(${pid})
    $parentStarts = [Collections.Generic.Dictionary[int,long]]::new()
    $parentStarts.Add(${pid}, $rootStart)
    $all = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId)
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
    try { & taskkill.exe ${force ? '/F ' : ''}/T /PID ${pid} *> $null } catch { }
    $deadline = [DateTime]::UtcNow.AddMilliseconds(${force ? 2000 : 1000})
    do {
        $alive = @($owned | Where-Object { -not $_.HasExited })
        if ($alive.Count -eq 0) { break }
        Start-Sleep -Milliseconds 25
    } while ([DateTime]::UtcNow -lt $deadline)
    if ($alive.Count -gt 0) {
        for ($i = $owned.Count - 1; $i -ge 0; $i--) {
            if (-not $owned[$i].HasExited) {
                try { $owned[$i].Kill() } catch { }
            }
        }
        $deadline = [DateTime]::UtcNow.AddSeconds(2)
        do {
            $alive = @($owned | Where-Object { -not $_.HasExited })
            if ($alive.Count -eq 0) { break }
            Start-Sleep -Milliseconds 25
        } while ([DateTime]::UtcNow -lt $deadline)
    }
    if ($alive.Count -eq 0) { Write-Output 'HAPI_TREE_EXITED' }
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
} finally {
    foreach ($entry in $owned) { $entry.Dispose() }
}`;
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  let output = '';
  let settled = false;
  const finish = (success: boolean) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve(success);
  };
  const timer = setTimeout(() => {
    child.kill('SIGKILL');
    finish(false);
  }, 15_000);
  child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr?.resume();
  child.once('error', () => finish(false));
  child.once('close', (code) => finish(code === 0 && output.trim() === 'HAPI_TREE_EXITED'));
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
