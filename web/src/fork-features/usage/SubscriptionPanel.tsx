import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useAppContext } from '@/lib/app-context'
import { useTranslation } from '@/lib/use-translation'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'

// fork-features/subscription：订阅配额 / API 余额面板。数据来自 hub 的
// GET /api/subscription/summary（admin-only）。快照由 vircs 上的 collector 推送，
// cx2cc 那一路由 hub 自己轮询——本组件对来源无感，只渲染归一化后的快照。

export type SubscriptionWindow = {
    key: string
    label: string
    used_percent: number
    /** epoch ms；null = 该窗口没有重置时间（纯余额型）。 */
    reset_at: number | null
    severity: 'normal' | 'warning' | 'critical'
    is_active: boolean
}

export type SubscriptionBalance = {
    amount: number
    currency: string
    granted: number | null
    topped_up: number | null
}

export type SubscriptionSnapshot = {
    machine: string
    provider: string
    account_key: string
    plan_name: string | null
    windows: SubscriptionWindow[]
    balance: SubscriptionBalance | null
    error: string | null
    reported_at: number
}

export type SubscriptionSummaryResponse = {
    snapshots: SubscriptionSnapshot[]
    generatedAt: number
}

/** 超过这个时长没更新就判为 stale（灰化 + 提示）。collector 间隔 5 分钟，
 *  给 3 倍余量：偶尔一轮网络失败不该立刻把整排卡片打成灰的。 */
export const STALE_THRESHOLD_MS = 15 * 60 * 1000

/**
 * 重置时间按**浏览器本地时区**渲染——这是这个面板的关键需求：hub 在 UTC，
 * 采集机 vircs 在 UTC-7，而人在 UTC+8 看页面。三个时区各不相同，所以传输
 * 一律用 epoch ms，只在渲染这一步转成本地时间。
 *
 * 传 `locale`/`timeZone` 只为测试可复现；生产两个都不传，走浏览器默认。
 */
export function formatResetTime(
    epochMs: number | null,
    opts?: { locale?: string; timeZone?: string }
): string | null {
    if (epochMs === null || !Number.isFinite(epochMs)) return null
    try {
        return new Intl.DateTimeFormat(opts?.locale, {
            month: 'numeric',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
            ...(opts?.timeZone ? { timeZone: opts.timeZone } : {})
        }).format(new Date(epochMs))
    } catch {
        return null
    }
}

/** 「N 分钟前」——不引 dayjs，粒度到分钟够用。 */
export function formatRelativeAge(ageMs: number, t: (key: string, vars?: Record<string, string | number>) => string): string {
    if (ageMs < 60_000) return t('subscription.age.justNow')
    const minutes = Math.floor(ageMs / 60_000)
    if (minutes < 60) return t('subscription.age.minutes', { n: minutes })
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return t('subscription.age.hours', { n: hours })
    return t('subscription.age.days', { n: Math.floor(hours / 24) })
}

/**
 * 主窗口 = 面板上那条大进度条。优先取 `is_active` 的（provider 自己标的当前
 * 生效窗口），没有就取 used_percent 最大的那条——「最接近打满的那条」才是
 * 用户真正关心的瓶颈。
 */
export function pickPrimaryWindow(windows: SubscriptionWindow[]): SubscriptionWindow | null {
    if (windows.length === 0) return null
    const active = windows.find(w => w.is_active)
    if (active) return active
    return windows.reduce((max, w) => (w.used_percent > max.used_percent ? w : max), windows[0]!)
}

const SEVERITY_BAR_CLASS: Record<SubscriptionWindow['severity'], string> = {
    normal: 'bg-emerald-500',
    warning: 'bg-amber-500',
    critical: 'bg-rose-500'
}

const SEVERITY_TEXT_CLASS: Record<SubscriptionWindow['severity'], string> = {
    normal: 'text-emerald-600 dark:text-emerald-400',
    warning: 'text-amber-600 dark:text-amber-400',
    critical: 'text-rose-600 dark:text-rose-400'
}

/** provider id → 展示名。未知 provider 原样显示，不隐藏。 */
const PROVIDER_LABELS: Record<string, string> = {
    anthropic: 'Claude',
    cx2cc: 'cx2cc',
    deepseek: 'DeepSeek',
    kimi: 'Kimi',
    glm: 'GLM'
}

function providerLabel(provider: string): string {
    return PROVIDER_LABELS[provider] ?? provider
}

/**
 * 窗口标签按 **key** 翻译，而不是直接显示采集器写进快照的 `label`。
 *
 * 采集器跑在 vircs 上，`label` 是它硬编码的中文串；英文界面直接渲染它会中英混排。
 * 各适配器的 key 本来就是稳定的（`session` / `weekly_all` / `weekly_scoped:<model>` /
 * `five_hour` / `duration_<minutes>` …），所以这里按 key 出本地化文案，
 * 只在遇到没见过的 key 时才退回 `label` —— 新 provider 上线时至少还有中文可看，
 * 不会变成空白。
 */
export function translateWindowLabel(
    key: string,
    fallbackLabel: string,
    t: (key: string, vars?: Record<string, string | number>) => string
): string {
    // anthropic 的按模型分档窗口：key 形如 weekly_scoped:fable，模型名要拼进文案。
    if (key.startsWith('weekly_scoped:')) {
        const model = key.slice('weekly_scoped:'.length)
        // 首字母大写还原展示名（key 里是 lowercase 化过的）。
        const display = model.charAt(0).toUpperCase() + model.slice(1)
        return t('subscription.window.scopedWeekly', { model: display })
    }
    // kimi 的时长窗口：key 里编码了分钟数，按小时/分钟就近渲染。
    if (key.startsWith('duration_')) {
        const minutes = Number(key.slice('duration_'.length))
        if (Number.isFinite(minutes) && minutes > 0) {
            return minutes % 60 === 0
                ? t('subscription.window.hours', { n: minutes / 60 })
                : t('subscription.window.minutes', { n: minutes })
        }
    }
    switch (key) {
        case 'session':
        case 'five_hour':
            return t('subscription.window.fiveHour')
        case 'weekly_all':
        case 'weekly':
            return t('subscription.window.weekly')
        case 'tool_calls':
            return t('subscription.window.toolCalls')
        case 'plan_total':
            return t('subscription.window.planTotal')
        case 'primary':
            return t('subscription.window.primary')
        case 'secondary':
            return t('subscription.window.secondary')
        case 'account_window':
            // cx2cc 账号池里的**备用**账号只给一个 used_percent + reset，
            // 没有 primary/secondary 之分（那两个只有当前生效账号才有）。
            return t('subscription.window.accountWindow')
        default:
            return fallbackLabel
    }
}

function WindowRow(props: { window: SubscriptionWindow; isPrimary: boolean }) {
    const { window: w, isPrimary } = props
    const { t } = useTranslation()
    const reset = formatResetTime(w.reset_at)
    return (
        <div className="space-y-1">
            <div className="flex items-baseline justify-between gap-2 text-xs">
                <span className={cn('truncate', isPrimary ? 'font-medium' : 'text-[var(--app-hint)]')}>
                    {translateWindowLabel(w.key, w.label, t)}
                </span>
                <span className="flex shrink-0 items-baseline gap-1.5 tabular-nums">
                    <span className={cn('font-semibold', SEVERITY_TEXT_CLASS[w.severity])}>
                        {w.used_percent}%
                    </span>
                    {reset && <span className="text-[var(--app-hint)]">{reset}</span>}
                </span>
            </div>
            <div className={cn('w-full overflow-hidden rounded-full bg-[var(--app-subtle-bg)]', isPrimary ? 'h-2' : 'h-1')}>
                <div
                    className={cn('h-full rounded-full transition-all', SEVERITY_BAR_CLASS[w.severity])}
                    // 0% 也画一丝宽度，让人看出这条窗口存在（而不是以为渲染坏了）。
                    style={{ width: `${Math.max(w.used_percent, 1.5)}%` }}
                />
            </div>
        </div>
    )
}

function SnapshotCard(props: { snapshot: SubscriptionSnapshot; now: number }) {
    const { snapshot, now } = props
    const { t } = useTranslation()
    const age = now - snapshot.reported_at
    const stale = age > STALE_THRESHOLD_MS
    const primary = pickPrimaryWindow(snapshot.windows)
    const others = snapshot.windows.filter(w => w !== primary)

    return (
        <div
            className={cn(
                'rounded-lg border border-[var(--app-divider)] p-3',
                // stale 不隐藏数据，只降透明度 + 打标——「旧数据」比「没有数据」信息量大。
                stale && 'opacity-60'
            )}
        >
            <div className="mb-2 flex items-baseline justify-between gap-2">
                <div className="min-w-0">
                    <div className="truncate text-sm font-medium">
                        {providerLabel(snapshot.provider)}
                        {snapshot.plan_name && (
                            <span className="ml-1.5 font-normal text-[var(--app-hint)]">{snapshot.plan_name}</span>
                        )}
                    </div>
                    <div className="truncate text-[11px] text-[var(--app-hint)]">
                        {snapshot.machine} · {snapshot.account_key}
                    </div>
                </div>
                <div className="shrink-0 text-[11px] text-[var(--app-hint)]">
                    {stale && <span className="mr-1 text-amber-600 dark:text-amber-400">⚠</span>}
                    {formatRelativeAge(age, t)}
                </div>
            </div>

            {snapshot.error ? (
                <div className="rounded bg-rose-500/10 px-2 py-1.5 text-xs text-rose-600 dark:text-rose-400">
                    {t('subscription.collectFailed')}: {snapshot.error}
                </div>
            ) : (
                <div className="space-y-2">
                    {snapshot.balance && (
                        <div className="flex items-baseline justify-between rounded bg-[var(--app-subtle-bg)] px-2 py-1.5">
                            <span className="text-xs text-[var(--app-hint)]">{t('subscription.balance')}</span>
                            <span className="text-base font-semibold tabular-nums">
                                {snapshot.balance.amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                <span className="ml-1 text-xs font-normal text-[var(--app-hint)]">{snapshot.balance.currency}</span>
                            </span>
                        </div>
                    )}
                    {primary && <WindowRow window={primary} isPrimary />}
                    {others.map(w => <WindowRow key={w.key} window={w} isPrimary={false} />)}
                    {snapshot.windows.length === 0 && !snapshot.balance && (
                        <div className="text-xs text-[var(--app-hint)]">{t('subscription.noWindows')}</div>
                    )}
                </div>
            )}
        </div>
    )
}

/**
 * 订阅面板。**非 admin 账号拿到 403**——这时整块不渲染（returns null），
 * 而不是显示一个「加载失败」的红卡片：对普通用户来说这个面板本就不该存在。
 */
export default function SubscriptionPanel() {
    const { baseUrl, token } = useAppContext()
    const { t } = useTranslation()

    const query = useQuery({
        queryKey: ['fork-subscription-summary'],
        queryFn: async (): Promise<SubscriptionSummaryResponse> => {
            const response = await fetch(`${baseUrl}/api/subscription/summary`, {
                headers: { authorization: `Bearer ${token}` }
            })
            if (!response.ok) {
                const body = await response.json().catch(() => null) as { error?: string } | null
                // 403 打成一个可识别的错误，下面据此整块不渲染。
                throw new Error(response.status === 403 ? 'FORBIDDEN' : (body?.error ?? `HTTP ${response.status}`))
            }
            return await response.json() as SubscriptionSummaryResponse
        },
        staleTime: 60_000,
        refetchInterval: 60_000,
        // 403 是权限结论，不是瞬时故障，重试没意义。
        retry: (count, error) => error instanceof Error && error.message === 'FORBIDDEN' ? false : count < 2
    })

    // 采集失败的不占卡片位。失效账号、过期 token、偶发 429 都会产生错误快照，
    // 让它们以红卡形式跟正常配额平起平坐会淹没真正要看的数字。
    //
    // 但**不能完全不吭声**：如果所有 provider 都挂了，面板会静默变空，看起来
    // 像「没配置」而不是「全炸了」。所以错误行从卡片里剔除，改在页脚记一行。
    const { healthy, failed } = useMemo(() => {
        const rows = query.data?.snapshots ?? []
        const healthy = rows.filter(s => s.error === null)
        const failed = rows.filter(s => s.error !== null)
        // 排序：先按机器，再把有窗口的排前面（纯余额型信息密度低，放后面）。
        // 同机同类再按 provider 名，保证每次渲染顺序稳定不跳动。
        healthy.sort((a, b) =>
            a.machine.localeCompare(b.machine)
            || Number(b.windows.length > 0) - Number(a.windows.length > 0)
            || a.provider.localeCompare(b.provider)
        )
        return { healthy, failed }
    }, [query.data])
    const snapshots = healthy

    if (query.isError && query.error instanceof Error && query.error.message === 'FORBIDDEN') return null
    // 首次加载中也不占位——用量页主体先出来，这块补上即可，避免顶部跳动。
    if (query.isLoading) return null
    // 全部失败时仍要渲染（下面的页脚会说明哪些挂了），否则「全炸」和「没配置」
    // 在界面上长得一模一样。只有真的一条快照都没有才整块隐藏。
    if (query.isSuccess && snapshots.length === 0 && failed.length === 0) return null

    const now = Date.now()

    return (
        <Card>
            <CardHeader className="pb-3">
                <CardTitle className="text-base">{t('subscription.title')}</CardTitle>
                <CardDescription>{t('subscription.subtitle')}</CardDescription>
            </CardHeader>
            <CardContent>
                {query.isError ? (
                    <div className="text-sm text-[var(--app-hint)]">
                        {t('subscription.loadFailed')}: {query.error instanceof Error ? query.error.message : ''}
                    </div>
                ) : (
                    <>
                        <div className="grid gap-2.5 sm:grid-cols-2">
                            {snapshots.map(s => (
                                <SnapshotCard key={`${s.machine}/${s.provider}/${s.account_key}`} snapshot={s} now={now} />
                            ))}
                        </div>
                        {failed.length > 0 && (
                            // 采集失败的不占卡片位，但也不能一声不吭——这里一行带过，
                            // title 里给出各自的错误原因，需要排查时鼠标一悬停就有。
                            <div
                                className="mt-2.5 text-xs text-[var(--app-hint)]"
                                title={failed.map(s => `${s.machine}/${s.provider}: ${s.error}`).join('\n')}
                            >
                                {t('subscription.hiddenFailures', {
                                    n: failed.length,
                                    providers: [...new Set(failed.map(s => s.provider))].join('、')
                                })}
                            </div>
                        )}
                    </>
                )}
            </CardContent>
        </Card>
    )
}
