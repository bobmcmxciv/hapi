import type { SubscriptionSnapshot, SubscriptionWindow } from '../domain'

/**
 * fork-features/subscription/collector：各 provider 的采集适配器。
 *
 * 每个适配器分两段:
 *   - `convert*` 纯函数——把厂商响应折算成通用 SubscriptionWindow[]/balance。可单测,
 *     用真实抓到的响应体当 fixture。
 *   - `collect*` 带网络——负责取凭据、发请求、把异常折成 error 快照。**永不 throw**,
 *     采集失败也返回一条带 error 的快照,好让前端显示「N 分钟前采集失败」而不是整卡消失。
 *
 * 端点与请求形状全部在 vircs 上真跑验证过(2026-08-14):
 *   anthropic  GET  api.anthropic.com/api/oauth/usage      Bearer + anthropic-beta
 *   deepseek   GET  api.deepseek.com/user/balance          Bearer
 *   kimi       GET  api.kimi.com/coding/v1/usages          Bearer
 *   glm        GET  open.bigmodel.cn/api/monitor/usage/quota/limit   Authorization(无 Bearer)
 */

const DEFAULT_TIMEOUT_MS = 15_000

export type CollectContext = {
    machine: string
    now: () => number
    fetchImpl: typeof fetch
    timeoutMs?: number
}

function errorSnapshot(ctx: CollectContext, provider: string, accountKey: string, message: string): SubscriptionSnapshot {
    return {
        machine: ctx.machine,
        provider,
        account_key: accountKey,
        plan_name: null,
        windows: [],
        balance: null,
        error: message,
        reported_at: ctx.now()
    }
}

async function fetchJson(ctx: CollectContext, url: string, headers: Record<string, string>): Promise<
    { ok: true; body: unknown } | { ok: false; message: string }
> {
    const controller = new AbortController()
    const cancel = setTimeout(() => controller.abort(), ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    try {
        const res = await ctx.fetchImpl(url, { method: 'GET', headers, signal: controller.signal })
        if (!res.ok) {
            // 401/403 单独措辞——最常见的失败是 key 过期,直接说清好过 "HTTP 401"。
            const hint = res.status === 401 || res.status === 403 ? '(凭据无效或过期)' : ''
            return { ok: false, message: `HTTP ${res.status}${hint}` }
        }
        return { ok: true, body: await res.json() }
    } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) }
    } finally {
        clearTimeout(cancel)
    }
}

/** ISO 8601 → epoch ms。解析失败返回 null(不 throw)。 */
function isoToEpochMs(value: unknown): number | null {
    if (typeof value !== 'string' || !value) return null
    const ms = Date.parse(value)
    return Number.isFinite(ms) ? ms : null
}

/** 兼容数字与数字字符串(kimi 把 limit/used 都发成字符串)。 */
function toNumber(value: unknown): number | null {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null
    if (typeof value === 'string' && value.trim()) {
        const n = Number(value)
        return Number.isFinite(n) ? n : null
    }
    return null
}

function severityFor(percent: number): 'normal' | 'warning' | 'critical' {
    return percent >= 95 ? 'critical' : percent >= 70 ? 'warning' : 'normal'
}

// ── Anthropic(Claude 订阅) ──────────────────────────────────────────────
//
// GET https://api.anthropic.com/api/oauth/usage
//   Authorization: Bearer <claudeAiOauth.accessToken>
//   anthropic-beta: oauth-2025-04-20
//
// 响应里 `limits[]` 是最全的一份——它同时覆盖 5 小时窗口(kind='session')、
// 周窗口(kind='weekly_all')、**以及按模型分档的 fable 周窗口**
// (kind='weekly_scoped', scope.model.display_name='Fable'),而且自带
// percent / severity / resets_at / is_active。顶层的 five_hour / seven_day
// 是同一批数据的降维版(没有 fable),所以这里只读 limits[]。

export type AnthropicLimit = {
    kind?: string
    group?: string
    percent?: number
    severity?: string
    resets_at?: string | null
    is_active?: boolean
    scope?: { model?: { id?: string | null; display_name?: string | null } | null; surface?: unknown } | null
}

export type AnthropicUsageResponse = {
    limits?: AnthropicLimit[]
    five_hour?: { utilization?: number; resets_at?: string | null } | null
    seven_day?: { utilization?: number; resets_at?: string | null } | null
}

export type AnthropicProfileResponse = {
    account?: { email?: string | null; has_claude_max?: boolean; has_claude_pro?: boolean } | null
    organization?: { rate_limit_tier?: string | null } | null
}

/** limits[] 里一条 → 通用窗口。返回 null 表示这条不认识/字段缺失。 */
export function convertAnthropicLimit(limit: AnthropicLimit): SubscriptionWindow | null {
    const percent = toNumber(limit.percent)
    if (percent === null) return null
    const kind = typeof limit.kind === 'string' ? limit.kind : 'unknown'
    const modelName = limit.scope?.model?.display_name ?? null

    // key 必须跨采集稳定(前端拿它做 React key + 排序)。weekly_scoped 会有多条
    // (每个模型档一条),所以把模型名拼进 key。
    const key = modelName ? `${kind}:${modelName.toLowerCase()}` : kind
    const label = kind === 'session' ? '5 小时窗口'
        : kind === 'weekly_all' ? '周窗口'
        : kind === 'weekly_scoped' && modelName ? `${modelName} 周窗口`
        : kind === 'weekly_scoped' ? '周窗口(限定)'
        : kind

    // severity 优先用 API 自己给的(它知道自家阈值),缺失才按百分比兜底。
    const severity: 'normal' | 'warning' | 'critical' =
        limit.severity === 'critical' ? 'critical'
        : limit.severity === 'warning' ? 'warning'
        : limit.severity === 'normal' ? 'normal'
        : severityFor(percent)

    return {
        key,
        label,
        used_percent: percent,
        reset_at: isoToEpochMs(limit.resets_at),
        severity,
        is_active: Boolean(limit.is_active)
    }
}

export function convertAnthropicUsage(
    usage: AnthropicUsageResponse,
    profile: AnthropicProfileResponse | null,
    ctx: { machine: string; reportedAt: number }
): SubscriptionSnapshot {
    const windows = (usage.limits ?? [])
        .map(convertAnthropicLimit)
        .filter((w): w is SubscriptionWindow => w !== null)

    const email = profile?.account?.email ?? null
    const planName = profile?.account?.has_claude_max ? 'Claude Max'
        : profile?.account?.has_claude_pro ? 'Claude Pro'
        : 'Claude'

    return {
        machine: ctx.machine,
        provider: 'anthropic',
        account_key: email ?? 'default',
        plan_name: planName,
        windows,
        balance: null,
        error: null,
        reported_at: ctx.reportedAt
    }
}

export async function collectAnthropic(ctx: CollectContext, accessToken: string): Promise<SubscriptionSnapshot> {
    const headers = { Authorization: `Bearer ${accessToken}`, 'anthropic-beta': 'oauth-2025-04-20', Accept: 'application/json' }
    const usage = await fetchJson(ctx, 'https://api.anthropic.com/api/oauth/usage', headers)
    if (!usage.ok) return errorSnapshot(ctx, 'anthropic', 'default', usage.message)

    // profile 只用来拿 email + 套餐名。它失败不该让整条采集失败——窗口数据才是主体,
    // 拿不到 email 就退回 account_key='default'。
    const profile = await fetchJson(ctx, 'https://api.anthropic.com/api/oauth/profile', headers)
    return convertAnthropicUsage(
        usage.body as AnthropicUsageResponse,
        profile.ok ? profile.body as AnthropicProfileResponse : null,
        { machine: ctx.machine, reportedAt: ctx.now() }
    )
}

// ── DeepSeek(API 余额,无窗口) ────────────────────────────────────────────
//
// GET https://api.deepseek.com/user/balance   Authorization: Bearer <key>
// → {"is_available":true,"balance_infos":[{"currency":"CNY","total_balance":"57.86",
//    "granted_balance":"0.00","topped_up_balance":"57.86"}]}

export type DeepSeekBalanceResponse = {
    is_available?: boolean
    balance_infos?: Array<{
        currency?: string
        total_balance?: string | number
        granted_balance?: string | number
        topped_up_balance?: string | number
    }>
}

export function convertDeepSeekBalance(
    body: DeepSeekBalanceResponse,
    ctx: { machine: string; reportedAt: number; accountKey: string }
): SubscriptionSnapshot {
    // 多币种时取第一条(实测只有 CNY 一条)。取不到就写成 error 快照,
    // 免得前端拿到一个既没窗口也没余额的空卡片不知道发生了什么。
    const info = body.balance_infos?.[0]
    const amount = toNumber(info?.total_balance)
    if (!info || amount === null) {
        return {
            machine: ctx.machine, provider: 'deepseek', account_key: ctx.accountKey,
            plan_name: null, windows: [], balance: null,
            error: '响应里没有 balance_infos', reported_at: ctx.reportedAt
        }
    }
    return {
        machine: ctx.machine,
        provider: 'deepseek',
        account_key: ctx.accountKey,
        // plan_name 留空:前端本来就渲染 provider 名("DeepSeek"),再写一个「按量」
        // 只是重复,而且那串是采集器硬编码的中文,英文界面下会混排。
        // is_available=false 是真正需要抬到眼前的异常态,走 error 通道(前端会红底显示)。
        plan_name: null,
        windows: [],
        balance: {
            amount,
            currency: info.currency ?? 'CNY',
            granted: toNumber(info.granted_balance),
            topped_up: toNumber(info.topped_up_balance)
        },
        error: body.is_available === false ? 'account unavailable (is_available=false)' : null,
        reported_at: ctx.reportedAt
    }
}

export async function collectDeepSeek(ctx: CollectContext, apiKey: string): Promise<SubscriptionSnapshot> {
    const accountKey = apiKeySuffix(apiKey)
    const res = await fetchJson(ctx, 'https://api.deepseek.com/user/balance', {
        Authorization: `Bearer ${apiKey}`, Accept: 'application/json'
    })
    if (!res.ok) return errorSnapshot(ctx, 'deepseek', accountKey, res.message)
    return convertDeepSeekBalance(res.body as DeepSeekBalanceResponse, {
        machine: ctx.machine, reportedAt: ctx.now(), accountKey
    })
}

// ── Kimi(Moonshot coding plan) ──────────────────────────────────────────
//
// GET https://api.kimi.com/coding/v1/usages   Authorization: Bearer <key>
// → {"user":{"userId":"...","membership":{"level":"LEVEL_INTERMEDIATE"}},
//    "usage":{"limit":"100","used":"45","remaining":"55","resetTime":"2026-08-19T..."},
//    "limits":[{"window":{"duration":300,"timeUnit":"TIME_UNIT_MINUTE"},
//               "detail":{"limit":"100","remaining":"100","resetTime":"..."}}],
//    "subType":"TYPE_PURCHASE"}
//
// 注意路径是 **usages(复数)**——单数 /usage 返回 404。

export type KimiUsageResponse = {
    user?: { userId?: string; membership?: { level?: string } | null } | null
    usage?: { limit?: string | number; used?: string | number; remaining?: string | number; resetTime?: string } | null
    limits?: Array<{
        window?: { duration?: number; timeUnit?: string } | null
        detail?: { limit?: string | number; remaining?: string | number; resetTime?: string } | null
    }>
    subType?: string
}

/** kimi 的 window.duration + timeUnit → 分钟数。识别不了返回 null。 */
export function kimiWindowMinutes(duration: number | null, timeUnit: string | null): number | null {
    if (duration === null || !Number.isFinite(duration)) return null
    if (timeUnit === 'TIME_UNIT_MINUTE') return duration
    if (timeUnit === 'TIME_UNIT_HOUR') return duration * 60
    if (timeUnit === 'TIME_UNIT_DAY') return duration * 60 * 24
    return null
}

/** kimi 的 window.duration + timeUnit → 中文标签。前端翻不出 key 时用它兜底。 */
export function kimiWindowLabel(duration: number | null, timeUnit: string | null): string {
    if (duration === null) return '窗口'
    if (timeUnit === 'TIME_UNIT_MINUTE') {
        // 300 分钟 = 5 小时,写成小时更好读。
        return duration % 60 === 0 ? `${duration / 60} 小时窗口` : `${duration} 分钟窗口`
    }
    if (timeUnit === 'TIME_UNIT_HOUR') return `${duration} 小时窗口`
    if (timeUnit === 'TIME_UNIT_DAY') return `${duration} 天窗口`
    return `${duration} 窗口`
}

export function convertKimiUsage(
    body: KimiUsageResponse,
    ctx: { machine: string; reportedAt: number; accountKey: string }
): SubscriptionSnapshot {
    const windows: SubscriptionWindow[] = []

    // 顶层 usage = 套餐总额度窗口(kimi 给的是剩余额度,不是百分比,自己折算)。
    const totalLimit = toNumber(body.usage?.limit)
    const totalUsed = toNumber(body.usage?.used)
    if (totalLimit !== null && totalLimit > 0 && totalUsed !== null) {
        const percent = Math.round((totalUsed / totalLimit) * 1000) / 10
        windows.push({
            key: 'plan_total',
            label: '套餐额度',
            used_percent: percent,
            reset_at: isoToEpochMs(body.usage?.resetTime),
            severity: severityFor(percent),
            // 总额度窗口默认当活跃项——它是最能代表"还能用多久"的那条。
            is_active: true
        })
    }

    // limits[] = 细分窗口(实测是一条 300 分钟 = 5 小时的)。
    for (const [index, item] of (body.limits ?? []).entries()) {
        const limit = toNumber(item.detail?.limit)
        const remaining = toNumber(item.detail?.remaining)
        if (limit === null || limit <= 0 || remaining === null) continue
        const percent = Math.round(((limit - remaining) / limit) * 1000) / 10
        const duration = toNumber(item.window?.duration)
        // key 里编码窗口时长(分钟),让前端能按自己的语言渲染标签而不是吃采集器的中文串。
        // 拿不到时长才退回索引——那种情况前端会直接用 label 兜底。
        const minutes = kimiWindowMinutes(duration, item.window?.timeUnit ?? null)
        windows.push({
            key: minutes === null ? `window_${index}` : `duration_${minutes}`,
            label: kimiWindowLabel(duration, item.window?.timeUnit ?? null),
            used_percent: percent,
            reset_at: isoToEpochMs(item.detail?.resetTime),
            severity: severityFor(percent),
            is_active: false
        })
    }

    const level = body.user?.membership?.level ?? null
    // LEVEL_INTERMEDIATE 之类的机器串对用户没意义,剥掉前缀留可读部分。
    const levelLabel = level ? level.replace(/^LEVEL_/, '').toLowerCase() : null
    return {
        machine: ctx.machine,
        provider: 'kimi',
        account_key: body.user?.userId ?? ctx.accountKey,
        plan_name: levelLabel ? `Kimi Coding · ${levelLabel}` : 'Kimi Coding',
        windows,
        balance: null,
        error: null,
        reported_at: ctx.reportedAt
    }
}

export async function collectKimi(ctx: CollectContext, apiKey: string): Promise<SubscriptionSnapshot> {
    const accountKey = apiKeySuffix(apiKey)
    const res = await fetchJson(ctx, 'https://api.kimi.com/coding/v1/usages', {
        Authorization: `Bearer ${apiKey}`, Accept: 'application/json'
    })
    if (!res.ok) return errorSnapshot(ctx, 'kimi', accountKey, res.message)
    return convertKimiUsage(res.body as KimiUsageResponse, {
        machine: ctx.machine, reportedAt: ctx.now(), accountKey
    })
}

// ── 智谱 GLM(coding plan 配额) ──────────────────────────────────────────
//
// GET https://open.bigmodel.cn/api/monitor/usage/quota/limit
//   Authorization: <api_key>       ← **不加 Bearer 前缀**,这是智谱的特例
// → {"code":200,"data":{"limits":[
//      {"type":"TIME_LIMIT","unit":5,...,"percentage":1,"nextResetTime":...},
//      {"type":"TOKENS_LIMIT","unit":3,"number":5,"percentage":4,"nextResetTime":...},
//      {"type":"TOKENS_LIMIT","unit":6,"number":1,"percentage":1,"nextResetTime":...}
//    ],"level":"max"},"success":true}
//
// unit 语义(照 cc-switch 的 classify_zhipu_window):3 = 5 小时窗口,6 = 每周窗口。
// **不能按 nextResetTime 排序代替**——周期末尾周窗口会比 5 小时窗口更早重置,
// 时间排序必然把两桶标反(cc-switch issue #3036)。

export type GlmQuotaResponse = {
    code?: number
    msg?: string
    success?: boolean
    data?: {
        level?: string
        limits?: Array<{
            type?: string
            unit?: number
            number?: number
            percentage?: number
            nextResetTime?: number
        }>
    } | null
}

export function glmWindowLabel(type: string, unit: number | null): { key: string; label: string } {
    if (type === 'TIME_LIMIT') return { key: 'tool_calls', label: '工具调用额度' }
    if (unit === 3) return { key: 'five_hour', label: '5 小时窗口' }
    if (unit === 6) return { key: 'weekly', label: '周窗口' }
    return { key: `unit_${unit ?? 'unknown'}`, label: '其他窗口' }
}

export function convertGlmQuota(
    body: GlmQuotaResponse,
    ctx: { machine: string; reportedAt: number; accountKey: string }
): SubscriptionSnapshot {
    // 智谱 HTTP 恒 200,业务错误在 body.code / body.success 里——不看这两个字段
    // 会把「接口不存在」当成一份空配额展示出去。
    if (body.success === false || (typeof body.code === 'number' && body.code !== 200)) {
        return {
            machine: ctx.machine, provider: 'glm', account_key: ctx.accountKey,
            plan_name: null, windows: [], balance: null,
            error: body.msg ?? `业务错误 code=${body.code}`, reported_at: ctx.reportedAt
        }
    }

    const windows: SubscriptionWindow[] = []
    for (const item of body.data?.limits ?? []) {
        const percent = toNumber(item.percentage)
        if (percent === null) continue
        const type = typeof item.type === 'string' ? item.type : ''
        // TIME_LIMIT 是工具调用配额(search-prime / web-reader / zread),
        // 跟 coding plan 的 token 额度不是一回事。cc-switch 直接丢掉它;这里保留但
        // 单独标签,免得"少显示了一项"这种静默截断。
        const { key, label } = glmWindowLabel(type, toNumber(item.unit))
        windows.push({
            key,
            label,
            used_percent: percent,
            reset_at: toNumber(item.nextResetTime),
            severity: severityFor(percent),
            // 5 小时窗口当活跃项;没有它就退回第一条。
            is_active: key === 'five_hour'
        })
    }
    if (windows.length > 0 && !windows.some(w => w.is_active)) {
        windows[0]!.is_active = true
    }

    const level = body.data?.level ?? null
    return {
        machine: ctx.machine,
        provider: 'glm',
        account_key: ctx.accountKey,
        plan_name: level ? `Zhipu GLM · ${level}` : 'Zhipu GLM',
        windows,
        balance: null,
        error: null,
        reported_at: ctx.reportedAt
    }
}

export async function collectGlm(ctx: CollectContext, apiKey: string): Promise<SubscriptionSnapshot> {
    const accountKey = apiKeySuffix(apiKey)
    const res = await fetchJson(ctx, 'https://open.bigmodel.cn/api/monitor/usage/quota/limit', {
        // 智谱不加 Bearer 前缀——加了会 401。
        Authorization: apiKey,
        'Content-Type': 'application/json',
        'Accept-Language': 'en-US,en'
    })
    if (!res.ok) return errorSnapshot(ctx, 'glm', accountKey, res.message)
    return convertGlmQuota(res.body as GlmQuotaResponse, {
        machine: ctx.machine, reportedAt: ctx.now(), accountKey
    })
}

/** API key 的稳定短标识:后 8 位。用作 account_key,既能区分多账号又不落全量密钥进 DB。 */
export function apiKeySuffix(apiKey: string): string {
    return apiKey.length <= 8 ? apiKey : `…${apiKey.slice(-8)}`
}
