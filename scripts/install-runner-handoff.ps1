# Install a new hapi.exe under the RUNNING runner without killing anything.
#
# ASCII-only: Windows PowerShell 5.1 reads BOM-less UTF-8 as ANSI.
#
# A running exe cannot be overwritten but can be renamed. After the rename the
# runner heartbeat (HAPI_RUNNER_HEARTBEAT_INTERVAL, default 60s) sees the
# installed binary change and hands off to a replacement runner itself; live
# session processes keep running their already-loaded (renamed) image.
# Unlike swap-cli-windows.ps1 this never taskkills sessions.
param(
  [Parameter(Mandatory=$true)][string]$Staged,
  [Parameter(Mandatory=$true)][string]$ExpectSha,
  [Parameter(Mandatory=$true)][string]$Tag,
  [int]$HandoffTimeoutSeconds = 180
)
$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Staged)) { Write-Output "FATAL: staged file missing: $Staged"; exit 1 }
$stagedSha = (Get-FileHash -LiteralPath $Staged -Algorithm SHA256).Hash.ToLower()
if ($stagedSha -ne $ExpectSha.ToLower()) { Write-Output "FATAL: staged sha mismatch $stagedSha"; exit 1 }

# Sessions carry `--started-by runner`, so match the runner subcommand itself.
function Get-Runners { Get-CimInstance Win32_Process -Filter "Name='hapi.exe'" | Where-Object { $_.CommandLine -match '\shapi(\.exe)?"?\s+runner\s+start' -or $_.CommandLine -match '\srunner\s+start(-sync)?(\s|$)' } }
$runner = Get-Runners | Select-Object -First 1
if (-not $runner) { Write-Output "FATAL: no running runner"; exit 1 }
$target = $runner.ExecutablePath
$oldPid = $runner.ProcessId
$children = @(Get-CimInstance Win32_Process -Filter "Name='hapi.exe'" | Where-Object { $_.ProcessId -ne $oldPid } | Select-Object -ExpandProperty ProcessId)
Write-Output "target   = $target"
Write-Output "old pid  = $oldPid"
Write-Output "old sha  = $((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLower())"
Write-Output "sessions = $($children.Count)"

$ts = Get-Date -Format 'yyyyMMddTHHmmss'
$backup = "$target.pre-$Tag-$ts"
$incoming = "$target.incoming-$Tag"
Copy-Item -LiteralPath $Staged -Destination $incoming -Force
Move-Item -LiteralPath $target -Destination $backup
Move-Item -LiteralPath $incoming -Destination $target
Write-Output "new sha  = $((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLower())"
Write-Output "rollback = $backup"

$deadline = (Get-Date).AddSeconds($HandoffTimeoutSeconds)
$newRunner = $null
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 5
  $newRunner = Get-Runners | Where-Object { $_.ProcessId -ne $oldPid } | Select-Object -First 1
  $oldAlive = Get-CimInstance Win32_Process -Filter "ProcessId=$oldPid"
  if ($newRunner -and -not $oldAlive) { break }
}
if (-not $newRunner) { Write-Output "WARN: no replacement runner within ${HandoffTimeoutSeconds}s (old pid alive: $([bool](Get-CimInstance Win32_Process -Filter "ProcessId=$oldPid")))"; exit 2 }
$survived = @($children | Where-Object { Get-CimInstance Win32_Process -Filter "ProcessId=$_" })
Write-Output "new pid  = $($newRunner.ProcessId)"
Write-Output "sessions survived = $($survived.Count)/$($children.Count)"
Write-Output "DONE"
