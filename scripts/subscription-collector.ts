#!/usr/bin/env bun
/**
 * 订阅/余额采集器入口。跑在 **vircs**——Claude 订阅配额只能从装了 Claude Code
 * 的机器上取(读它的 OAuth 凭据),而 ECS 到 api.anthropic.com 是 403 区域封锁,
 * 所以采集必须在这边发起,结果推给 ECS 上的 hub 展示。
 *
 * 用法:
 *   bun run scripts/subscription-collector.ts            # 常驻,按 interval 轮询
 *   bun run scripts/subscription-collector.ts --once     # 跑一轮就退出(排障/计划任务用)
 *   bun run scripts/subscription-collector.ts --dry-run  # 只采集并打印,不推 hub
 *
 * 必需环境变量:
 *   HAPI_SUB_HUB_URL     hub 基址,如 https://bob.18852271093.top
 *   HAPI_SUB_HUB_TOKEN   hub 的 cliApiToken(换 gateway JWT 用)
 *
 * 可选:
 *   HAPI_SUB_MACHINE     本机标识,默认 os.hostname()
 *   HAPI_SUB_INTERVAL_MS 轮询间隔,默认 300000(5 分钟),下限 30000
 *   HAPI_SUB_ANTHROPIC_TOKEN  显式指定 Claude OAuth token;不给则读 ~/.claude/.credentials.json
 *   HAPI_SUB_DEEPSEEK_KEY / HAPI_SUB_KIMI_KEY / HAPI_SUB_GLM_KEY
 *
 * 凭据只在内存里,不落盘不进日志——下面打印的都是 provider 名与百分比,不含 key。
 */

import { collectAll, configFromEnv, startCollector } from '../fork-features/subscription/collector/collector'

const args = new Set(process.argv.slice(2))
const once = args.has('--once')
const dryRun = args.has('--dry-run')

const parsed = configFromEnv()
if (!parsed.ok) {
    console.error(`[subscription-collector] 缺少必需环境变量: ${parsed.missing.join(', ')}`)
    console.error('  HAPI_SUB_HUB_URL   例: https://bob.18852271093.top')
    console.error('  HAPI_SUB_HUB_TOKEN 例: hub 的 cliApiToken')
    process.exit(2)
}
const config = parsed.config

const providerCount = Object.values(config.credentials).filter(Boolean).length
console.log(`[subscription-collector] machine=${config.machine} hub=${config.hubUrl} `
    + `interval=${(config.intervalMs ?? 0) / 1000}s 显式凭据=${providerCount} 家(anthropic 另从 CLI 凭据读)`)

/** 把一条快照渲染成一行人读的摘要。故意不打印任何凭据字段。 */
function describe(snapshot: Awaited<ReturnType<typeof collectAll>>[number]): string {
    if (snapshot.error) return `  ✗ ${snapshot.provider.padEnd(10)} 采集失败: ${snapshot.error}`
    const parts: string[] = []
    for (const w of snapshot.windows) {
        const reset = w.reset_at ? new Date(w.reset_at).toLocaleString() : '无重置'
        parts.push(`${w.label} ${w.used_percent}% (${reset} 重置)`)
    }
    if (snapshot.balance) {
        parts.push(`余额 ${snapshot.balance.amount} ${snapshot.balance.currency}`)
    }
    return `  ✓ ${snapshot.provider.padEnd(10)} ${snapshot.plan_name ?? '-'} | ${parts.join(' | ') || '无窗口数据'}`
}

if (dryRun) {
    const snapshots = await collectAll(config)
    console.log(`[subscription-collector] --dry-run 采到 ${snapshots.length} 条(不推送):`)
    for (const snapshot of snapshots) console.log(describe(snapshot))
    process.exit(snapshots.some(s => s.error) ? 1 : 0)
}

if (once) {
    // --once 也要拿到明细,便于计划任务日志里直接看出哪家挂了。
    const snapshots = await collectAll(config)
    for (const snapshot of snapshots) console.log(describe(snapshot))
    const handle = startCollector({ ...config, eager: false })
    try {
        const result = await handle.runOnce()
        console.log(`[subscription-collector] 推送 ${result.pushed ? '成功' : '跳过'}(${result.collected} 条)`)
        handle.stop()
        process.exit(result.pushed || result.collected === 0 ? 0 : 1)
    } catch (err) {
        console.error(`[subscription-collector] 推送失败: ${err instanceof Error ? err.message : String(err)}`)
        handle.stop()
        process.exit(1)
    }
}

const handle = startCollector(config)
const shutdown = (signal: string) => {
    console.log(`[subscription-collector] 收到 ${signal},停止轮询`)
    handle.stop()
    process.exit(0)
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
