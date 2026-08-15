# 订阅采集器常驻包装。由计划任务 HapiSubscriptionCollector 调起。
#
# 凭据不写进计划任务的命令行（那是所有人可读的），而是从 ACL 锁死的
# ~/.hapi/subscription-collector.env 读进环境变量再交给采集器。
#
# 采集器自己带 5 分钟轮询循环，所以这个脚本是**长驻**的：计划任务配成
# 开机启动 + 失败重启即可，不要配成每 5 分钟拉起一次（会叠出多个进程）。

$ErrorActionPreference = 'Stop'

$envFile = Join-Path $env:USERPROFILE '.hapi\subscription-collector.env'
if (-not (Test-Path $envFile)) {
    Write-Error "缺少凭据文件: $envFile"
    exit 2
}

# KEY=VALUE 逐行读。值里可能含 '='（token 尾部），所以只在第一个 '=' 处切。
foreach ($line in Get-Content $envFile) {
    $trimmed = $line.Trim()
    if ($trimmed -eq '' -or $trimmed.StartsWith('#')) { continue }
    $idx = $trimmed.IndexOf('=')
    if ($idx -lt 1) { continue }
    $name = $trimmed.Substring(0, $idx).Trim()
    $value = $trimmed.Substring($idx + 1).Trim()
    Set-Item -Path "Env:$name" -Value $value
}

$repo = Split-Path -Parent $PSScriptRoot
$script = Join-Path $repo 'scripts\subscription-collector.ts'
if (-not (Test-Path $script)) {
    Write-Error "找不到采集器脚本: $script"
    exit 2
}

$bun = (Get-Command bun -ErrorAction SilentlyContinue).Source
if (-not $bun) { $bun = Join-Path $env:APPDATA 'npm\bun.cmd' }
if (-not (Test-Path $bun)) {
    Write-Error 'bun 不在 PATH 里，且 %APPDATA%\npm\bun.cmd 也不存在'
    exit 2
}

Write-Output "[run-subscription-collector] $(Get-Date -Format o) 启动，仓库=$repo"
& $bun run $script
exit $LASTEXITCODE
