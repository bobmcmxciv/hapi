# vircs self-swap. Must run DETACHED (Start-Process), because it kills the very
# hapi.exe tree that launched it -- including the HAPI session driving the upgrade.
#
# ASCII-only: Windows PowerShell 5.1 reads a BOM-less UTF-8 file as ANSI.
#
# Differs from swap-cli-windows.ps1 in one way that matters: vircs's tasks sit in
# State='Ready' even while the runner is up (the task launches and detaches), so
# filtering tasks by State -eq 'Running' finds nothing here. Stop/Start them by
# name instead.
param(
  [string]$Staged   = 'C:\Users\Administrator\AppData\Local\Temp\hapi-fork7.exe',
  [string]$ExpectSha = 'bc00d703e39622f734eb9f196becd50e5af57e7842ef45c038bc4bd637c515ee',
  [int]$DelaySeconds = 30,
  [string]$Log      = 'C:\Users\Administrator\hapi-fork7-swap.log'
)
function Say($m) { $line = (Get-Date -Format 'HH:mm:ss') + '  ' + $m; Add-Content -Path $Log -Value $line }

Set-Content -Path $Log -Value ("=== vircs CLI swap to fork7 ===")
Say "waiting $DelaySeconds s so the driving session can flush its last message"
Start-Sleep -Seconds $DelaySeconds

if (-not (Test-Path $Staged)) { Say "FATAL: staged missing $Staged"; exit 1 }
$sha = (Get-FileHash $Staged -Algorithm SHA256).Hash.ToLower()
if ($sha -ne $ExpectSha.ToLower()) { Say "FATAL: staged sha mismatch $sha"; exit 1 }
Say "staged sha OK $sha"

$procs = @(Get-CimInstance Win32_Process -Filter "Name='hapi.exe'")
$runner = $procs | Where-Object { $_.CommandLine -like '*runner*' } | Select-Object -First 1
if ($runner) { $Target = $runner.ExecutablePath } else { $Target = ($procs | Select-Object -First 1).ExecutablePath }
if (-not $Target) { $Target = 'C:\Users\Administrator\AppData\Roaming\npm\node_modules\@twsxtd\hapi\node_modules\@twsxtd\hapi-win32-x64\bin\hapi.exe' }
Say "target = $Target"
Say "old sha = $((Get-FileHash $Target -Algorithm SHA256).Hash.ToLower())"
Say "killing $($procs.Count) hapi.exe processes"

$taskNames = @('HAPI Runner Autostart','HapiRunnerVircs')
foreach ($n in $taskNames) { Stop-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2
taskkill /F /IM hapi.exe 2>&1 | Out-Null
Start-Sleep -Seconds 4

$ts = Get-Date -Format 'yyyyMMddTHHmmss'
$backup = "$Target.pre-fork7-$ts"
try {
  Move-Item -LiteralPath $Target -Destination $backup -Force -ErrorAction Stop
  Move-Item -LiteralPath $Staged -Destination $Target -Force -ErrorAction Stop
} catch {
  Say ("FATAL during swap: " + $_.Exception.Message)
  if ((Test-Path $backup) -and -not (Test-Path $Target)) { Move-Item -LiteralPath $backup -Destination $Target -Force; Say "rolled back" }
  Start-ScheduledTask -TaskName 'HAPI Runner Autostart' -ErrorAction SilentlyContinue
  exit 1
}
Say "new sha = $((Get-FileHash $Target -Algorithm SHA256).Hash.ToLower())"
Say "rollback = $backup"

Start-ScheduledTask -TaskName 'HAPI Runner Autostart' -ErrorAction SilentlyContinue
Start-Sleep -Seconds 12
$after = @(Get-CimInstance Win32_Process -Filter "Name='hapi.exe'")
Say "hapi.exe after swap = $($after.Count)"
if ($after.Count -eq 0) {
  Say "runner did not come back yet; the 5-minute watchdog trigger will retry"
}
Say "DONE"
