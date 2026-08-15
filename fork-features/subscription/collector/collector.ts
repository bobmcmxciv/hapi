import { hostname } from 'node:os'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { SubscriptionSnapshot } from '../domain'
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
 * 认证链路:collector 用 hub 的 `cliApiToken` 打 `POST /api/auth`(**网关那条**,
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
    /** hub 基址,如 `https://bob.18852271093.top`。 */
    hubUrl: string
    /** hub 的 cliApiToken,用来换 gateway JWT。 */
    hubToken: string
    /** 本机标识,默认 os.hostname()。 */
    machine?: string
    /** 采集间隔 ms,默认 5 分钟。 */
    intervalMs?: number
    /** 读 Claude 凭据的 home 目录,默认 os.homedir()。测试用它指向空目录做隔离。 */
    homeDir?: string
    /** 是否在 startCollector 返回前立刻跑一轮,默认 true(生产要的就是启动即有数据)。
     *  测试关掉它,好精确计数请求次数。 */
    eager?: boolean
    /** 各 provider 凭据。缺省的那家直接跳过采集(不报错、不写空快照)。 */
    credentials: {
        /** Claude 订阅 OAuth accessToken。留空则自动从 ~/.claude/.credentials.json 读。 */
        anthropicAccessToken?: string | null
        deepseekApiKey?: string | null
        kimiApiKey?: string | null
        glmApiKey?: string | null
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
            credentials: {
                // 显式给了就用给的,否则从 CLI 凭据文件读(vircs 上就是这条路)。
                anthropicAccessToken: env.HAPI_SUB_ANTHROPIC_TOKEN?.trim() || null,
                deepseekApiKey: env.HAPI_SUB_DEEPSEEK_KEY?.trim() || null,
                kimiApiKey: env.HAPI_SUB_KIMI_KEY?.trim() || null,
                glmApiKey: env.HAPI_SUB_GLM_KEY?.trim() || null
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
export async function authenticate(config: CollectorConfig, fetchImpl: typeof fetch): Promise<string> {
    const res = await fetchImpl(new URL('/api/auth', config.hubUrl).toString(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accessToken: config.hubToken })
    })
    if (!res.ok) throw new Error(`auth failed: HTTP ${res.status}`)
    const body = await res.json() as { token?: string }
    if (!body.token) throw new Error('auth response has no token')
    return body.token
}

export async function pushSnapshots(
    config: CollectorConfig,
    token: string,
    snapshots: SubscriptionSnapshot[],
    fetchImpl: typeof fetch
): Promise<void> {
    const res = await fetchImpl(new URL('/api/subscription/report', config.hubUrl).toString(), {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ snapshots })
    })
    if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`report failed: HTTP ${res.status} ${text.slice(0, 200)}`)
    }
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
            log('没有配置任何 provider 凭据,本轮无采集')
            return { collected: 0, pushed: false }
        }
        const failed = snapshots.filter(s => s.error !== null)
        if (failed.length > 0) {
            log(`采集完成 ${snapshots.length} 条,其中 ${failed.length} 条失败: ` +
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
                if (result.pushed) log(`已推送 ${result.collected} 条快照`)
            } catch (err) {
                log(`本轮失败: ${err instanceof Error ? err.message : String(err)}`)
            }
            scheduleNext()
        }, intervalMs)
    }

    // 启动即跑一轮,不等首个 interval(测试里用 eager:false 关掉以便精确计数)。
    if (config.eager !== false) {
        runOnce()
            .then(r => { if (r.pushed) log(`已推送 ${r.collected} 条快照`) })
            .catch(err => log(`首轮失败: ${err instanceof Error ? err.message : String(err)}`))
            .finally(() => scheduleNext())
    } else {
        scheduleNext()
    }

    return {
        runOnce,
        stop: () => {
            stopped = true
            if (timer) { clearTimeout(timer); timer = null }
        }
    }
}
