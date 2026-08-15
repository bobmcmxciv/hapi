import type { SubscriptionStore } from './subscriptionStore'
import type { SubscriptionSnapshot, SubscriptionWindow } from './domain'

/**
 * cx2cc 轮询器:hub 侧定时器,每隔 `intervalMs` 拉一次 cx2cc-api/usage,
 * 把响应翻译成通用 SubscriptionSnapshot 写入 store。
 *
 * cx2cc 端点是**hub 自己所在 ECS 上的另一个反代**(bob.18852271093.top/cx2cc-api/usage),
 * hub 直连即可,不用走 vircs collector——这是所有 provider 里唯一"hub 直取"的一路。
 *
 * 关闭:调用返回的 `stop()`,后续采集立即停止,最后一次写入的快照保留在 DB 里
 * (前端会看到 staleness > interval,自然显灰,符合"数据过期"语义)。
 *
 * 请求鉴权、URL 都由 opts 传入——本模块不硬编码密钥。生产由 startHub 从
 * 环境变量(HAPI_CX2CC_USAGE_URL / HAPI_CX2CC_API_KEY)注入;本地开发/测试直接构造。
 */

export type Cx2ccPollerOptions = {
    /** 完整 URL,一般是 `https://bob.18852271093.top/cx2cc-api/usage`。 */
    url: string
    /** cx2cc 认证头 `x-api-key` 的值。 */
    apiKey: string
    /** 轮询间隔(ms)。生产建议 5min(300_000)。 */
    intervalMs: number
    /** 单次 fetch 的超时(ms)。默认 15s。 */
    timeoutMs?: number
    /** 存储实例。 */
    subscriptionStore: SubscriptionStore
    /** 该快照标记为哪台"机器"。默认 'ecs-hub'——UI 上分组用。 */
    machine?: string
    /** 允许在测试里注入 clock / fetch。 */
    now?: () => number
    fetchImpl?: typeof fetch
    /** 出错时的日志钩子(默认 console.warn)。 */
    log?: (msg: string) => void
}

/**
 * cx2cc 上游响应形状,只声明我们要用的字段。
 * `rate_limit.{primary,secondary}_window.{used_percent, reset_at, limit_window_seconds}` +
 * 顶层 `email`、`plan_type`——跟 cc-switch 里的 extractor snippet 完全对齐。
 */
export type Cx2ccRawUsage = {
    email?: string | null
    plan_type?: string | null
    rate_limit?: {
        allowed?: boolean
        limit_reached?: boolean
        primary_window?: Cx2ccRawWindow | null
        secondary_window?: Cx2ccRawWindow | null
    } | null
    error?: { message?: string } | null
}

type Cx2ccRawWindow = {
    used_percent?: number
    reset_at?: number
    limit_window_seconds?: number
}

/** 把 cx2cc 的一个 window 折算成通用 SubscriptionWindow。 */
export function cx2ccWindowToSnapshot(
    raw: Cx2ccRawWindow | null | undefined,
    key: 'primary' | 'secondary',
    isPrimary: boolean
): SubscriptionWindow | null {
    if (!raw || typeof raw.used_percent !== 'number' || typeof raw.limit_window_seconds !== 'number') return null
    const hours = raw.limit_window_seconds / 3600
    const label = hours >= 24
        ? `${Math.round(hours / 24)}d 窗口`
        : `${Math.round(hours)}h 窗口`
    const severity: 'normal' | 'warning' | 'critical' =
        raw.used_percent >= 95 ? 'critical' : raw.used_percent >= 70 ? 'warning' : 'normal'
    return {
        key,
        label,
        used_percent: raw.used_percent,
        reset_at: typeof raw.reset_at === 'number' ? raw.reset_at * 1000 : null,
        severity,
        is_active: isPrimary
    }
}

/** 纯函数版本的响应→快照转换,便于单测。 */
export function cx2ccResponseToSnapshot(
    response: Cx2ccRawUsage,
    opts: { machine: string; reportedAt: number }
): SubscriptionSnapshot {
    const primary = response.rate_limit?.primary_window ?? null
    const secondary = response.rate_limit?.secondary_window ?? null
    // 主窗口选 used_percent 更高的那个(与 cc-switch extractor 同规则),
    // 便于顶部进度条一眼看出瓶颈在哪。
    const primaryIsMain = !!primary && (!secondary || (primary.used_percent ?? 0) >= (secondary.used_percent ?? 0))
    const windows: SubscriptionWindow[] = []
    const w1 = cx2ccWindowToSnapshot(primary, 'primary', primaryIsMain)
    const w2 = cx2ccWindowToSnapshot(secondary, 'secondary', !primaryIsMain && !!secondary)
    if (w1) windows.push(w1)
    if (w2) windows.push(w2)

    const email = typeof response.email === 'string' ? response.email : null
    const who = email ? ` · ${email.split('@')[0]?.slice(0, 8) ?? ''}` : ''
    const planName = `ChatGPT ${response.plan_type ?? '?'}${who}`

    return {
        machine: opts.machine,
        provider: 'cx2cc',
        // account_key 首选邮箱;没邮箱就退回到 plan_type,再没有就固定 'default'。
        // 保持稳定的目的:同一账号多次采集要 upsert 到同一行。
        account_key: email ?? response.plan_type ?? 'default',
        plan_name: planName,
        windows,
        balance: null,
        error: null,
        reported_at: opts.reportedAt
    }
}

/**
 * 记一条错误快照。error 非空、windows 为空——前端仍能看到"该 provider 采集失败"。
 * 保留旧的 account_key 上下文很难(错误时可能连响应都没),这里退回 'default'——
 * 采集成功后正确 key 会覆盖回来。
 */
function errorSnapshot(opts: { machine: string; reportedAt: number; message: string }): SubscriptionSnapshot {
    return {
        machine: opts.machine,
        provider: 'cx2cc',
        account_key: 'default',
        plan_name: null,
        windows: [],
        balance: null,
        error: opts.message,
        reported_at: opts.reportedAt
    }
}

export type Cx2ccPollerHandle = {
    /** 立即触发一次采集(测试或运维用)。 */
    pollOnce: () => Promise<void>
    /** 停止周期采集。已在进行中的一次 poll 会跑完再退出。 */
    stop: () => void
}

export function startCx2ccPoller(opts: Cx2ccPollerOptions): Cx2ccPollerHandle {
    const machine = opts.machine ?? 'ecs-hub'
    const now = opts.now ?? (() => Date.now())
    const doFetch = opts.fetchImpl ?? fetch
    const timeoutMs = opts.timeoutMs ?? 15_000
    const log = opts.log ?? ((msg: string) => console.warn(`[cx2cc-poller] ${msg}`))

    let stopped = false
    let timer: ReturnType<typeof setTimeout> | null = null

    async function pollOnce(): Promise<void> {
        const controller = new AbortController()
        const cancel = setTimeout(() => controller.abort(), timeoutMs)
        const reportedAt = now()
        try {
            const res = await doFetch(opts.url, {
                method: 'GET',
                headers: { 'x-api-key': opts.apiKey, 'User-Agent': 'hapi-hub-cx2cc-poller/1.0' },
                signal: controller.signal
            })
            if (!res.ok) {
                opts.subscriptionStore.upsertSnapshots([errorSnapshot({
                    machine, reportedAt, message: `HTTP ${res.status}`
                })])
                log(`HTTP ${res.status}`)
                return
            }
            const body = await res.json() as Cx2ccRawUsage
            opts.subscriptionStore.upsertSnapshots([cx2ccResponseToSnapshot(body, { machine, reportedAt })])
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            opts.subscriptionStore.upsertSnapshots([errorSnapshot({ machine, reportedAt, message })])
            log(message)
        } finally {
            clearTimeout(cancel)
        }
    }

    function scheduleNext(): void {
        if (stopped) return
        timer = setTimeout(async () => {
            await pollOnce()
            scheduleNext()
        }, opts.intervalMs)
    }

    // 立刻跑一次,不等首个 interval——启动窗口内前端就能看到当前快照。
    pollOnce().finally(() => scheduleNext())

    return {
        pollOnce,
        stop: () => {
            stopped = true
            if (timer) { clearTimeout(timer); timer = null }
        }
    }
}
