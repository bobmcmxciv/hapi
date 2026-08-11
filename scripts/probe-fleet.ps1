$p = @(Get-CimInstance Win32_Process -Filter "Name='hapi.exe'")
Write-Output ("procs=" + $p.Count)
$r = $p | Where-Object { $_.CommandLine -like '*runner*' } | Select-Object -First 1
if ($r) {
  Write-Output ("runner_exe=" + $r.ExecutablePath)
  Write-Output ("runner_sha=" + (Get-FileHash $r.ExecutablePath -Algorithm SHA256).Hash.ToLower())
  Write-Output ("has_chunk_rpc=" + [bool](Select-String -Path $r.ExecutablePath -Pattern 'readGeneratedBlobChunk' -SimpleMatch -Quiet -Encoding Byte -ErrorAction SilentlyContinue))
} else {
  Write-Output "runner_exe=<none running>"
}
$p | Select-Object -ExpandProperty ExecutablePath -Unique | ForEach-Object { Write-Output ("path: " + $_) }
Write-Output "--- scheduled tasks ---"
Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -like '*hapi*' } | ForEach-Object { Write-Output ("task: " + $_.TaskName + " state=" + $_.State) }
