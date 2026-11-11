import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { getProcessStartMarkerAsync } from './process';

describe('noninteractive process generation probe', () => {
 it('returns null for invalid PIDs without spawning a probe', async () => {
  expect(await getProcessStartMarkerAsync(-1)).toBeNull();
  expect(await getProcessStartMarkerAsync(Number.NaN)).toBeNull();
 });

 it('finishes a real OS probe and preserves the legacy marker bytes', { timeout: 15_000 }, async () => {
  // Real subprocess/PowerShell input and close behavior cannot be driven with
  // fake timers. The baseline closes stdin like the former spawn.sync probe.
  const windows = process.platform === 'win32';
  const child = windows
   ? spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    `(Get-CimInstance Win32_Process -Filter "ProcessId = ${process.pid}").CreationDate`],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
   : spawn('ps', ['-p', String(process.pid), '-o', 'lstart='], {
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
   });
  const baseline = Promise.withResolvers<string>();
  let stdout = '';
  child.stdout.on('data', data => { stdout += data.toString(); });
  child.stderr.resume();
  child.once('error', baseline.reject);
  child.once('close', code => {
   if (code !== 0) baseline.reject(new Error(`Legacy marker probe exited ${code}`));
   else baseline.resolve(stdout.trim());
  });
  try {
   const [legacy, first, second, missing] = await Promise.all([
    baseline.promise,
    getProcessStartMarkerAsync(process.pid),
    getProcessStartMarkerAsync(process.pid),
    getProcessStartMarkerAsync(999_999_999),
   ]);
   expect(legacy.length).toBeGreaterThan(0);
   expect(first).toBe(legacy);
   expect(second).toBe(legacy);
   expect(missing).toBeNull();
  } finally {
   if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
 });
});
