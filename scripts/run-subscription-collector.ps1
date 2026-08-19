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

# 直接找真 exe，不用 `Get-Command bun`——那个在本机解析到 bun.ps1 垫片，
# 在计划任务的 -NonInteractive 宿主里多一层 shim 只是多一个出错面。
$bunCandidates = @(
    (Join-Path $env:APPDATA 'npm\node_modules\bun\bin\bun.exe'),
    (Join-Path $env:LOCALAPPDATA 'bun\bin\bun.exe')
)
$bun = $bunCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $bun) {
    # 兜底：PATH 里能找到什么算什么（可能是 .ps1/.cmd 垫片，但总比不跑强）。
    $bun = (Get-Command bun -ErrorAction SilentlyContinue).Source
}
if (-not $bun -or -not (Test-Path $bun)) {
    Write-Error "找不到 bun。已试过: $($bunCandidates -join ', ') 以及 PATH"
    exit 2
}

# 日志落盘。2026-08-19 采集器挂死 13 小时，事后一行日志都没有——计划任务的
# stdout 无人接管，直接进了空。滚动保留最近两份，避免无限长。
$logDir = Join-Path $env:USERPROFILE '.hapi\logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Force $logDir | Out-Null }
$logFile = Join-Path $logDir 'subscription-collector.log'
if ((Test-Path $logFile) -and ((Get-Item $logFile).Length -gt 5MB)) {
    Move-Item -LiteralPath $logFile -Destination "$logFile.1" -Force
}

"[run-subscription-collector] $(Get-Date -Format o) 启动，仓库=$repo" | Tee-Object -FilePath $logFile -Append

# 2>&1 合并 stderr，否则采集器的报错只会消失。stdout 有真实去处后，
# 写日志也不再可能因为句柄关闭而抛。
& $bun run $script 2>&1 | Tee-Object -FilePath $logFile -Append
$code = $LASTEXITCODE
"[run-subscription-collector] $(Get-Date -Format o) 退出，code=$code" | Tee-Object -FilePath $logFile -Append
exit $code
