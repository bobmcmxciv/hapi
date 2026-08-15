/**
 * fork-features/subscription：跨订阅/API 余额的**归一化快照**类型。
 *
 * 采集侧(vircs collector)针对每家 provider 各写一个适配器,把厂商私有字段(五花八门)
 * 折算成下面这一套通用结构再推给 hub。hub 与前端**只认这套通用结构**,不解 provider
 * 私有字段——这样加一家 provider 不用改 hub/UI,只加一个适配器。
 *
 * `raw` 字段是可选的原始 payload,只在采集失败时留取证用,前端不展示。
 */

export type SubscriptionWindow = {
    /** 唯一 key,用于稳定标识窗口(如 'five_hour' / 'seven_day' / 'fable_weekly' / 'primary' / 'secondary')。
     *  同一 provider 内跨采集要保持稳定,前端拿它做 React key。 */
    key: string
    /** 展示用的中文短标签,例如 "5小时窗口" "周窗口" "Fable 周窗口" "5min 窗口"。
     *  由采集侧决定,hub 直接透传。 */
    label: string
    /** 已用比例 0-100(整数或一位小数),超过 100 的一律截到 100 用于进度条。 */
    used_percent: number
    /** 重置时间 epoch ms;null 表示无重置窗口(纯余额型或该 provider 没给)。 */
    reset_at: number | null
    /** 严重程度:normal / warning(过半)/ critical(接近或已满)。采集侧按自己规则打。 */
    severity: 'normal' | 'warning' | 'critical'
    /** 是否是**当前活跃**的限制窗口(cx2cc 的 primary/secondary、Anthropic 的 is_active)。
     *  前端遇到多个窗口时,主进度条挑 is_active 的那个;若都不 active,挑 used_percent 最大的。 */
    is_active: boolean
}

/** 纯余额型 provider(DeepSeek 等 API 计费)的账户余额。窗口型订阅这一项为 null。 */
export type SubscriptionBalance = {
    /** 数字余额(如 57.86)。currency 与 amount 必须一起解读。 */
    amount: number
    /** ISO 4217 或 provider 私有货币码('CNY'/'USD')。前端渲染 "¥57.86" 之类。 */
    currency: string
    /** 赠送额度(可为 null,表示 provider 没区分)。 */
    granted: number | null
    /** 充值额度(可为 null)。 */
    topped_up: number | null
}

/**
 * 一次采集的完整快照。表主键是 (machine, provider, account_key)——同一账号在同台机器
 * 上一次采集就 upsert 一行,历史不留(用不上,前端只关心「现在剩多少」)。
 */
export type SubscriptionSnapshot = {
    /** 采集机 hostname 或对应别名。cx2cc 由 hub 直接拉,填 'ecs-hub'。 */
    machine: string
    /** provider 标识:'anthropic' | 'deepseek' | 'kimi' | 'glm' | 'cx2cc' (以及未来新增)。 */
    provider: string
    /** 同一 provider 下账号的稳定 id。首选邮箱(anthropic/cx2cc 都有),否则 API key 后 8 位。
     *  用于**同机同 provider 多账号**并存的场景。 */
    account_key: string
    /** 计划名,例如 "Claude Max"、"ChatGPT pro · pang…"、"DeepSeek 按量"。展示用。 */
    plan_name: string | null
    /** 时间窗数组(可空,例如 DeepSeek 只有余额没有窗口)。 */
    windows: SubscriptionWindow[]
    /** 余额(可空,例如 Anthropic 订阅只有窗口没余额)。 */
    balance: SubscriptionBalance | null
    /** 采集失败时的**错误摘要**(网络失败/401/解析失败)。有 error 时 windows/balance 通常为空;
     *  但仍写一行,好让前端能显示「N 分钟前采集失败」而不是让整卡片消失。 */
    error: string | null
    /** 快照捕获时间(epoch ms,采集侧写)。用于「N 分钟前」和 staleness 判断。 */
    reported_at: number
}

/** POST /api/subscription/report 的请求体。 */
export type SubscriptionReportRequest = {
    snapshots: SubscriptionSnapshot[]
}

/** GET /api/subscription/summary 的响应。 */
export type SubscriptionSummaryResponse = {
    snapshots: SubscriptionSnapshot[]
    /** 服务端本次响应生成的时间(epoch ms),前端算 `now - reported_at` 得到 staleness。 */
    generatedAt: number
}
