import { hostname } from 'node:os'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { SubscriptionSnapshot } from '../domain'
import { collectAntigravity, findAntigravityBinary, type runAntigravityUsage } from './antigravity'
import { collectDevin, readDevinToken } from './devin'
import {
    collectAnthropic,
    collectDeepSeek,
    collectGlm,
    collectKimi,
    type CollectContext
} from './adapters'

/**
 * 订阅采集器主体。跑在 **vircs**(用户确认:claude 只在 vircs 上请求),
 * 周期性地对各 provider 取一次配额/余额,归一化后推给 ECS 上的 hub。
 *
 * 认证链路:collector 用独立的 admin API token 打 `POST /api/auth`(**网关那条**,
 * 注册顺序上遮蔽了上游同路径路由),换回带 `gaid` + `role=admin` 的 JWT,
 * 再用它 `POST /api/subscription/report`。JWT 有效期 4h,这里每次 flush 前
 * 检查剩余寿命,过半就换新的——省去精确计时,也不会踩到边界过期。
 *
 * 设计约束:
 *   - **单条 provider 失败不影响其他**——每个适配器自己把异常折成 error 快照。
 *   - **推送失败不吞**——写日志并保留下一轮重试;不做本地队列(下一轮拿的是更新
 *     的数据,补发旧快照没意义)。
 *   - 凭据只在内存里,不落盘、不进日志。
 */

export type CollectorConfig = {
    /** hub 基址,如 `https://hapi.bobmcmxciv.xin`。 */
    hubUrl: string
    /** 独立、可撤销的 admin API token，用来换 gateway JWT。 */
    hubToken: string
    /** 本机标识,默认 os.hostname()。 */
    machine?: string
    /** 采集间隔 ms,默认 5 分钟。 */
    intervalMs?: number
    /** 读 Claude 凭据的 home 目录,默认 os.homedir()。测试用它指向空目录做隔离。 */
    homeDir?: string
    /** null disables auto-discovery; otherwise use this CLI path or find agy locally. */
    antigravityBinary?: string | null
    /** Stable display key when multiple Antigravity accounts are used on one machine. */
    antigravityAccountKey?: string
    /** Test injection point. */
    runAntigravityUsage?: typeof runAntigravityUsage
    /** 是否在 startCollector 返回前立刻跑一轮,默认 true(生产要的就是启动即有数据)。
     *  测试关掉它,好精确计数请求次数。 */
    eager?: boolean
    /** 看门狗窗口 ms：连续这么久没有一次成功推送就 process.exit(1) 让计划任务重启。
     *  默认 max(6 个采集周期, 10 分钟)。测试里调小以便验证。 */
    watchdogMs?: number
    /** 与 hub 通信（换 JWT、推快照）的超时，默认 30s。测试里调小以免拖慢整套。 */
    hubTimeoutMs?: number
    credentials: {
        /** Claude 订阅 OAuth accessToken。留空则自动从 ~/.claude/.credentials.json 读。 */
        anthropicAccessToken?: string | null
        deepseekApiKey?: string | null
        kimiApiKey?: string | null
        glmApiKey?: string | null
        /** Devin session token。留空则自动从 %APPDATA%/devin/credentials.toml 或 ~/.omp/agent/agent.db 读。 */
        devinApiKey?: string | null
    }
    /** 测试注入点。 */
    now?: () => number
    fetchImpl?: typeof fetch
    log?: (msg: string) => void
}

/**
 * 从 `~/.claude/.credentials.json` 读 Claude Code 的 OAuth accessToken。
 * 文件不存在/结构不对返回 null——上层据此跳过 anthropic 采集。
 *
 * 注意:这个 token 会过期(`expiresAt` 字段),但刷新逻辑归 Claude Code CLI 自己。
 * 采集器**每轮重新读文件**而不是缓存,这样 CLI 刷新后我们下一轮自动拿到新的;
 * 缓存住反而会在过期后一直 401。
 */
export function readClaudeOAuthToken(home = homedir()): string | null {
    try {
        const raw = readFileSync(join(home, '.claude', '.credentials.json'), 'utf8')
        const parsed = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string } }
        const token = parsed.claudeAiOauth?.accessToken
        return typeof token === 'string' && token ? token : null
    } catch {
        return null
    }
}

/** 从环境变量装配一份配置。字段缺失时返回 null 并说明缺哪个。 */
export function configFromEnv(env: Record<string, string | undefined> = process.env):
    { ok: true; config: CollectorConfig } | { ok: false; missing: string[] } {
    const hubUrl = env.HAPI_SUB_HUB_URL?.trim()
    const hubToken = env.HAPI_SUB_HUB_TOKEN?.trim()
    const missing: string[] = []
    if (!hubUrl) missing.push('HAPI_SUB_HUB_URL')
    if (!hubToken) missing.push('HAPI_SUB_HUB_TOKEN')
    if (!hubUrl || !hubToken) return { ok: false, missing }

    const intervalRaw = env.HAPI_SUB_INTERVAL_MS?.trim()
    const parsedInterval = intervalRaw ? Number(intervalRaw) : NaN
    return {
        ok: true,
        config: {
            hubUrl,
            hubToken,
            machine: env.HAPI_SUB_MACHINE?.trim() || hostname(),
            intervalMs: Number.isFinite(parsedInterval) && parsedInterval >= 30_000 ? parsedInterval : 5 * 60 * 1000,
            antigravityBinary: env.HAPI_SUB_AGY_BIN?.trim() || undefined,
            antigravityAccountKey: env.HAPI_SUB_AGY_ACCOUNT?.trim() || 'default',
            credentials: {
                // 显式给了就用给的,否则从 CLI 凭据文件读(vircs 上就是这条路)。
                anthropicAccessToken: env.HAPI_SUB_ANTHROPIC_TOKEN?.trim() || null,
                deepseekApiKey: env.HAPI_SUB_DEEPSEEK_KEY?.trim() || null,
                kimiApiKey: env.HAPI_SUB_KIMI_KEY?.trim() || null,
                glmApiKey: env.HAPI_SUB_GLM_KEY?.trim() || null,
                devinApiKey: env.HAPI_SUB_DEVIN_TOKEN?.trim() || null
            }
        }
    }
}

/** 跑一轮全部 provider 的采集。缺凭据的直接不出现在结果里。 */
export async function collectAll(config: CollectorConfig): Promise<SubscriptionSnapshot[]> {
    const ctx: CollectContext = {
        machine: config.machine ?? hostname(),
        now: config.now ?? (() => Date.now()),
        fetchImpl: config.fetchImpl ?? fetch
    }
    const jobs: Array<Promise<SubscriptionSnapshot>> = []

    // anthropic 的 token 每轮重读——CLI 刷新后无需重启采集器。
    const anthropicToken = config.credentials.anthropicAccessToken ?? readClaudeOAuthToken(config.homeDir)
    if (anthropicToken) jobs.push(collectAnthropic(ctx, anthropicToken))
    if (config.credentials.deepseekApiKey) jobs.push(collectDeepSeek(ctx, config.credentials.deepseekApiKey))
    if (config.credentials.kimiApiKey) jobs.push(collectKimi(ctx, config.credentials.kimiApiKey))
    if (config.credentials.glmApiKey) jobs.push(collectGlm(ctx, config.credentials.glmApiKey))
    const agyBinary = config.antigravityBinary === null ? null
        : config.antigravityBinary ?? findAntigravityBinary(config.homeDir)
    if (agyBinary) jobs.push(collectAntigravity(ctx, agyBinary, config.antigravityAccountKey, config.runAntigravityUsage))
    const devinToken = config.credentials.devinApiKey ?? readDevinToken(config.homeDir)
    if (devinToken) jobs.push(collectDevin(ctx, devinToken))

    // 适配器自己已保证不 throw,这里再兜一层:某个适配器万一漏了,也不能带崩整轮。
    const settled = await Promise.allSettled(jobs)
    return settled
        .filter((r): r is PromiseFulfilledResult<SubscriptionSnapshot> => r.status === 'fulfilled')
        .map(r => r.value)
}

type TokenCache = { token: string; issuedAt: number }

/**
 * 换 gateway JWT。走**网关的** `POST /api/auth`——它在 server.ts 里由
 * mountMultiUserGateway 先注册,遮蔽了上游同路径那条(上游那条只签 uid/ns,
 * 没有 gaid,拿去打 /api/subscription/* 会 401)。
 */
/** 与 hub 通信的超时。没有它，一个挂住的 TCP 连接会让 await 永不返回，
 *  轮询定时器再也不会重新武装——进程活着但循环已死（2026-08-19 线上就是这样
 *  停了 13 小时，进程还在、数据冻结在最后一次采集）。 */
const HUB_TIMEOUT_MS = 30_000

/** Keep the deadline armed until response consumption completes, not just until headers arrive. */
async function fetchWithTimeout<T>(
    fetchImpl: typeof fetch,
    url: string,
    init: RequestInit,
    consume: (response: Response) => Promise<T>,
    timeoutMs = HUB_TIMEOUT_MS
): Promise<T> {
    const controller = new AbortController()
    const cancel = setTimeout(() => controller.abort(), timeoutMs)
    try {
        const res = await fetchImpl(url, { ...init, signal: controller.signal })
        return await consume(res)
    } finally {
        clearTimeout(cancel)
    }
}

export async function authenticate(config: CollectorConfig, fetchImpl: typeof fetch): Promise<string> {
    return await fetchWithTimeout(fetchImpl, new URL('/api/auth', config.hubUrl).toString(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accessToken: config.hubToken })
    }, async (res) => {
        if (!res.ok) {
            await res.body?.cancel()
            throw new Error(`auth failed: HTTP ${res.status}`)
        }
        const body = await res.json() as { token?: string }
        if (!body.token) throw new Error('auth response has no token')
        return body.token
    }, config.hubTimeoutMs)
}

export async function pushSnapshots(
    config: CollectorConfig,
    token: string,
    snapshots: SubscriptionSnapshot[],
    fetchImpl: typeof fetch
): Promise<void> {
    await fetchWithTimeout(fetchImpl, new URL('/api/subscription/report', config.hubUrl).toString(), {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ snapshots })
    }, async (res) => {
        if (!res.ok) {
            const text = await res.text()
            throw new Error(`report failed: HTTP ${res.status} ${text.slice(0, 200)}`)
        }
        await res.arrayBuffer()
    }, config.hubTimeoutMs)
}

export type CollectorHandle = {
    /** 立即跑一轮采集 + 推送。抛错表示这一轮失败(周期循环会吞掉并等下一轮)。 */
    runOnce: () => Promise<{ collected: number; pushed: boolean }>
    stop: () => void
}

export function startCollector(config: CollectorConfig): CollectorHandle {
    const fetchImpl = config.fetchImpl ?? fetch
    const now = config.now ?? (() => Date.now())
    const log = config.log ?? ((msg: string) => console.log(`[subscription-collector] ${msg}`))
    const intervalMs = config.intervalMs ?? 5 * 60 * 1000
    // JWT 有效期 4h。过半(2h)就重新换,避免踩边界过期。
    const TOKEN_MAX_AGE_MS = 2 * 60 * 60 * 1000

    // 看门狗窗口：默认 6 个采集周期（5min × 6 = 30min）没成功过就退出重启。
    const watchdogMs = config.watchdogMs ?? Math.max(intervalMs * 6, 10 * 60 * 1000)
    let lastSuccessAt = now()

    /** log 包一层：写 stdout 可能抛（计划任务里 stdout 是关闭句柄 → EPIPE）。
     *  日志失败绝不能连累轮询循环，这里静默吞掉。 */
    function safeLog(msg: string): void {
        try { log(msg) } catch { /* 日志写不出去不是停止采集的理由 */ }
    }

    let cachedToken: TokenCache | null = null
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | null = null
    // 并发去重:启动即跑的那一轮与调用方显式 runOnce() 会同时到达 getToken,
    // 两边都看到空缓存就会各换一次 token。共享同一个在途 Promise 才是对的——
    // 否则每次并发都白打一次 /api/auth,而且 hub 的登录失败计数器也会被无谓地拉高。
    let inFlightAuth: Promise<string> | null = null

    async function getToken(): Promise<string> {
        if (cachedToken && now() - cachedToken.issuedAt < TOKEN_MAX_AGE_MS) return cachedToken.token
        if (inFlightAuth) return inFlightAuth
        inFlightAuth = authenticate(config, fetchImpl)
            .then(token => {
                cachedToken = { token, issuedAt: now() }
                return token
            })
            .finally(() => { inFlightAuth = null })
        return inFlightAuth
    }

    async function runOnce(): Promise<{ collected: number; pushed: boolean }> {
        const snapshots = await collectAll(config)
        if (snapshots.length === 0) {
            safeLog('没有配置任何 provider 凭据,本轮无采集')
            return { collected: 0, pushed: false }
        }
        const failed = snapshots.filter(s => s.error !== null)
        if (failed.length > 0) {
            safeLog(`采集完成 ${snapshots.length} 条,其中 ${failed.length} 条失败: ` +
                failed.map(s => `${s.provider}(${s.error})`).join(', '))
        }
        try {
            await pushSnapshots(config, await getToken(), snapshots, fetchImpl)
            return { collected: snapshots.length, pushed: true }
        } catch (err) {
            // token 过期是最常见的推送失败;丢掉缓存让下一轮重新换。
            cachedToken = null
            throw err
        }
    }

    function scheduleNext(): void {
        if (stopped) return
        timer = setTimeout(async () => {
            try {
                const result = await runOnce()
                if (result.pushed) {
                    lastSuccessAt = now()
                    safeLog(`已推送 ${result.collected} 条快照`)
                }
            } catch (err) {
                safeLog(`本轮失败: ${err instanceof Error ? err.message : String(err)}`)
            } finally {
                // **必须在 finally**。放在 catch 之后的话，只要 catch 里那句 log 抛了
                // （计划任务里 stdout 是关闭的句柄，写它会 EPIPE），就再也不会重新
                // 武装定时器：进程活着、循环已死、页面数据永远停在最后一次。
                scheduleNext()
            }
        }, intervalMs)
    }

    /**
     * 看门狗：连续多久没有一次成功推送就主动退出。
     *
     * 注意它**必须跑在自己的定时器上**，不能挂进轮询回调的 finally——那一轮 await 挂住
     * 时 finally 永不到达，看门狗跟着一起死，等于没有看门狗。独立 interval 保证
     * "某一轮永远不返回"这条路也会被它终结。
     */
    function checkWatchdog(): void {
        if (stopped) return
        const silentFor = now() - lastSuccessAt
        if (silentFor < watchdogMs) return
        safeLog(`看门狗触发：已连续 ${Math.round(silentFor / 60000)} 分钟没有成功推送，退出让计划任务重启`)
        stopped = true
        if (timer) { clearTimeout(timer); timer = null }
        if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null }
        // 非零退出，让计划任务的重启策略接手。
        if (typeof process !== 'undefined') process.exit(1)
    }

    // 独立看门狗定时器：检查周期封顶 1 分钟（再密的检查也没意义，窗口通常几十分钟），
    // 下限跟 watchdogMs——测试把窗口调到 ms 级时照样能及时触发。
    let watchdogTimer: ReturnType<typeof setTimeout> | null =
        setInterval(checkWatchdog, Math.min(watchdogMs, 60_000))

    // 启动即跑一轮,不等首个 interval(测试里用 eager:false 关掉以便精确计数)。
    if (config.eager !== false) {
        runOnce()
            .then(r => { if (r.pushed) { lastSuccessAt = now(); safeLog(`已推送 ${r.collected} 条快照`) } })
            .catch(err => safeLog(`首轮失败: ${err instanceof Error ? err.message : String(err)}`))
            .finally(() => scheduleNext())
    } else {
        scheduleNext()
    }

    return {
        runOnce,
        stop: () => {
            stopped = true
            if (timer) { clearTimeout(timer); timer = null }
            if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null }
        }
    }
}
