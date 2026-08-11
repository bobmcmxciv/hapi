# Swap one Windows machine's hapi CLI binary.
#
# ASCII-only on purpose: Windows PowerShell 5.1 reads a BOM-less UTF-8 file as ANSI,
# which mangles non-ASCII bytes into a ParserError. Do not add comments in Chinese here.
#
# Self-configuring: the swap target is taken from the RUNNING runner process, not from
# PATH -- some machines have a stray hapi.exe in the home dir that shadows the real one.
#
# Swapping necessarily restarts the runner and every session process on the machine
# (version handoff). That is inherent to the upgrade, not a side effect to avoid.
param(
  [Parameter(Mandatory=$true)][string]$Staged,
  [Parameter(Mandatory=$true)][string]$ExpectSha
)
$ErrorActionPreference = 'Stop'
function Say($m) { Write-Output $m }

if (-not (Test-Path $Staged)) { Say "FATAL: staged file missing: $Staged"; exit 1 }
$stagedSha = (Get-FileHash $Staged -Algorithm SHA256).Hash.ToLower()
if ($stagedSha -ne $ExpectSha.ToLower()) { Say "FATAL: staged sha mismatch $stagedSha != $ExpectSha"; exit 1 }
Say "staged sha OK: $stagedSha"

$procs = @(Get-CimInstance Win32_Process -Filter "Name='hapi.exe'")
$runner = $procs | Where-Object { $_.CommandLine -like '*runner*' } | Select-Object -First 1
if ($runner) { $Target = $runner.ExecutablePath }
else { $Target = ($procs | Select-Object -First 1).ExecutablePath }
if (-not $Target) { Say "FATAL: no running hapi.exe; cannot locate swap target"; exit 1 }
Say "target  = $Target"
Say "old sha = $((Get-FileHash $Target -Algorithm SHA256).Hash.ToLower())"
Say "procs to be restarted = $($procs.Count)"

# Stop the task BEFORE killing processes, else the watchdog respawns immediately.
$tasks = @(Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -like '*hapi*' -and $_.State -eq 'Running' })
foreach ($t in $tasks) { Say "stopping task: $($t.TaskName)"; Stop-ScheduledTask -TaskName $t.TaskName -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2
taskkill /F /IM hapi.exe 2>&1 | Out-Null
Start-Sleep -Seconds 3

# Rename, do not overwrite: a running exe is locked against writes but can be renamed.
$ts = Get-Date -Format 'yyyyMMddTHHmmss'
$backup = "$Target.pre-fork7-$ts"
Move-Item -LiteralPath $Target -Destination $backup -Force
Move-Item -LiteralPath $Staged -Destination $Target -Force
Say "new sha = $((Get-FileHash $Target -Algorithm SHA256).Hash.ToLower())"
Say "rollback = $backup"

foreach ($t in $tasks) { Say "starting task: $($t.TaskName)"; Start-ScheduledTask -TaskName $t.TaskName -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 6
$after = @(Get-CimInstance Win32_Process -Filter "Name='hapi.exe'")
Say "procs after swap = $($after.Count)"
Say "DONE"
