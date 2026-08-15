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
    /** 账号池 URL。默认把 `url` 末段的 `usage` 换成 `accounts`,一般不用显式给。 */
    accountsUrl?: string
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
    /** 是否在返回前立刻跑一轮,默认 true(生产要的就是启动即有数据)。
     *  测试关掉它以便精确计数请求次数。 */
    eager?: boolean
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

// ── 账号池(轮换用的多个 ChatGPT 账号) ──────────────────────────────────
//
// `/usage` 只报**当前生效**那个账号,备用账号的余量看不见。cx2cc 另外暴露了
// `/accounts`(转发自 codex-bridge 的 account pool),一次给出全部账号:
//   {accounts:[{id, email, plan, priority, active, available, limit_reached,
//               used_percent, window_reset_at(秒)}], active:"<id>"}
// 于是改成:用 /accounts 枚举账号(每个一张卡),再用 /usage 给生效账号补上
// primary/secondary 两个窗口的细节——后者只有生效账号才有。

export type Cx2ccAccount = {
    id?: string
    email?: string | null
    plan?: string | null
    priority?: number
    active?: boolean
    available?: boolean
    limit_reached?: boolean
    used_percent?: number
    window_reset_at?: number
}

export type Cx2ccAccountsResponse = {
    accounts?: Cx2ccAccount[]
    active?: string | null
}

/**
 * 一个账号 → 一条快照。
 *
 * `detailedWindows` 传非空时(只有当前生效账号有)用它当窗口明细;否则从
 * `used_percent` + `window_reset_at` 合成单条窗口——备用账号只有这一组数字。
 */
export function cx2ccAccountToSnapshot(
    account: Cx2ccAccount,
    opts: { machine: string; reportedAt: number; isActive: boolean; detailedWindows: SubscriptionWindow[] | null }
): SubscriptionSnapshot {
    const email = typeof account.email === 'string' && account.email ? account.email : null
    const plan = typeof account.plan === 'string' && account.plan ? account.plan : '?'

    let windows: SubscriptionWindow[]
    if (opts.detailedWindows && opts.detailedWindows.length > 0) {
        windows = opts.detailedWindows
    } else {
        const percent = typeof account.used_percent === 'number' ? account.used_percent : null
        windows = percent === null ? [] : [{
            key: 'account_window',
            label: '账号窗口',
            used_percent: percent,
            reset_at: typeof account.window_reset_at === 'number' ? account.window_reset_at * 1000 : null,
            severity: percent >= 95 ? 'critical' : percent >= 70 ? 'warning' : 'normal',
            // 备用账号也标 active —— 这里的 is_active 是「这张卡的主进度条用哪条窗口」,
            // 跟账号是不是当前轮换到的那个无关(后者写在 plan_name 里)。
            is_active: true
        }]
    }

    // 角色写进 plan_name,让「哪个在烧、哪个是备用」一眼可见。
    // limit_reached 优先——账号打满了比它是不是主用更要紧。
    const role = account.limit_reached ? '已限流'
        : opts.isActive ? '主用'
        : account.available === false ? '不可用'
        : '备用'

    return {
        machine: opts.machine,
        provider: 'cx2cc',
        // account_key 用邮箱(跨采集稳定);没有就退回池里的 id。
        account_key: email ?? account.id ?? 'default',
        plan_name: `ChatGPT ${plan} · ${role}`,
        windows,
        balance: null,
        error: null,
        reported_at: opts.reportedAt
    }
}

/** 把 /accounts + /usage 合成一组快照(每账号一条)。 */
export function cx2ccAccountsToSnapshots(
    accounts: Cx2ccAccountsResponse,
    usage: Cx2ccRawUsage | null,
    opts: { machine: string; reportedAt: number }
): SubscriptionSnapshot[] {
    const list = accounts.accounts ?? []
    if (list.length === 0) return []

    // 生效账号的详细窗口来自 /usage。判定优先用顶层 `active` 字段对 id,
    // 退而求其次看各条目自己的 active 标记。
    const activeId = typeof accounts.active === 'string' ? accounts.active : null
    const detailed = usage ? cx2ccResponseToSnapshot(usage, opts).windows : []

    return list.map(account => {
        const isActive = activeId !== null ? account.id === activeId : account.active === true
        return cx2ccAccountToSnapshot(account, {
            machine: opts.machine,
            reportedAt: opts.reportedAt,
            isActive,
            detailedWindows: isActive && detailed.length > 0 ? detailed : null
        })
    })
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

    /** `/usage` 的兄弟路径。opts.url 指向 `.../usage`，把末段换成 `accounts`。 */
    const accountsUrl = opts.accountsUrl ?? opts.url.replace(/\/usage(\?|$)/, '/accounts$1')

    async function getJson(url: string): Promise<{ ok: true; body: unknown } | { ok: false; message: string }> {
        const controller = new AbortController()
        const cancel = setTimeout(() => controller.abort(), timeoutMs)
        try {
            const res = await doFetch(url, {
                method: 'GET',
                headers: { 'x-api-key': opts.apiKey, 'User-Agent': 'hapi-hub-cx2cc-poller/1.0' },
                signal: controller.signal
            })
            if (!res.ok) return { ok: false, message: `HTTP ${res.status}` }
            return { ok: true, body: await res.json() }
        } catch (err) {
            return { ok: false, message: err instanceof Error ? err.message : String(err) }
        } finally {
            clearTimeout(cancel)
        }
    }

    async function pollOnce(): Promise<void> {
        const reportedAt = now()

        // /usage 是主信息源（生效账号的 primary/secondary 窗口明细），它失败就算这轮失败。
        const usage = await getJson(opts.url)
        if (!usage.ok) {
            opts.subscriptionStore.upsertSnapshots([errorSnapshot({ machine, reportedAt, message: usage.message })])
            log(usage.message)
            return
        }
        const usageBody = usage.body as Cx2ccRawUsage

        // /accounts 是增量信息（把备用账号也拉出来）。它不可用时**不算失败**——
        // 老版本 cx2cc 没有这个路径，回落到只报生效账号，与加这个功能之前等价。
        const accounts = await getJson(accountsUrl)
        if (accounts.ok) {
            const snapshots = cx2ccAccountsToSnapshots(
                accounts.body as Cx2ccAccountsResponse,
                usageBody,
                { machine, reportedAt }
            )
            if (snapshots.length > 0) {
                opts.subscriptionStore.upsertSnapshots(snapshots)
                return
            }
        } else {
            log(`/accounts 不可用（${accounts.message}），本轮只报当前生效账号`)
        }

        opts.subscriptionStore.upsertSnapshots([cx2ccResponseToSnapshot(usageBody, { machine, reportedAt })])
    }

    function scheduleNext(): void {
        if (stopped) return
        timer = setTimeout(async () => {
            await pollOnce()
            scheduleNext()
        }, opts.intervalMs)
    }

    // 立刻跑一次,不等首个 interval——启动窗口内前端就能看到当前快照。
    if (opts.eager !== false) {
        pollOnce().finally(() => scheduleNext())
    } else {
        scheduleNext()
    }

    return {
        pollOnce,
        stop: () => {
            stopped = true
            if (timer) { clearTimeout(timer); timer = null }
        }
    }
}
