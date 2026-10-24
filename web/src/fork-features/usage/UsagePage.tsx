import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useAppContext } from '@/lib/app-context'
import { useTranslation } from '@/lib/use-translation'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { CalendarIcon, SessionDateRangePicker } from '@/components/SessionList'
import {
    MachineChip,
    MachineOwnerHeading,
    groupMachinesByOwner,
    machineChipContentClass,
    machineChipGridClass,
    machineChipIdleClass,
    machineChipSelectedClass,
    machineChipShellClass
} from '@/components/machinePresentation'
import { cn } from '@/lib/utils'
import { useMachines } from '@/hooks/queries/useMachines'
import { resolveMachineIcon } from '@/fork-features/machine-icons/MachineDeviceIcon'
import type { MachineIconId } from '@hapi/protocol'
import SubscriptionPanel from './SubscriptionPanel'
import { UsageTrendChart, type UsageBucketUnit } from './UsageTrendChart'

/** 用量页不按会话活跃日高亮，固定空集避免每次渲染新建 Set。 */
const EMPTY_ACTIVITY_DATES: ReadonlySet<string> = new Set<string>()

// fork-features/usage：Token 用量统计页。数据来自 hub 侧
// /api/usage/summary（fork-features/multi-user/executionMount.ts 挂载，
// 可见性与会话列表同构），页面自带取数逻辑，不侵入 ApiClient。

export type UsageModelSummary = {
    model: string
    requestCount: number
    inputTokens: number
    outputTokens: number
    cacheCreationInputTokens: number
    cacheReadInputTokens: number
}

export type UsageModelGroup = UsageModelSummary & {
    /** 归并到该主模型下的不同子变体（按各自 token 总量降序）。
     *  仅当 variants.length > 1 时渲染展开按钮与子列表；单不重复模型（variants.length === 1）直接平铺显示。 */
    variants: UsageModelSummary[]
}

/** 一台机器的用量小结（与 hub fork-features/usage/usageAggregate.ts 同构）。 */
export type UsageHostSummary = {
    host: string
    sessionCount: number
    totalTokens: number
    requestCount: number
    owner: string | null
    platform: string | null
}

export type UsageSummaryResponse = {
    models: UsageModelSummary[]
    totals: Omit<UsageModelSummary, 'model'>
    hosts: UsageHostSummary[]
    filter: { since: string | null; until: string | null; host: string | null }
    generatedAt: number
}

const PRESET_RANGES = ['all', '24h', '7d', '30d'] as const
type PresetRange = (typeof PRESET_RANGES)[number]
type RangeKey = PresetRange | 'custom'

/** 预设范围换算成 ISO 起点；'all' 不传 since。 */
function presetToSince(range: PresetRange): string | null {
    if (range === 'all') return null
    const hours = range === '24h' ? 24 : range === '7d' ? 24 * 7 : 24 * 30
    return new Date(Date.now() - hours * 3600_000).toISOString()
}

/** 'YYYY-MM-DD'（本地日）→ 当天 00:00 本地时间的 ISO 串。 */
export function localDayStartIso(day: string): string | null {
    const [year, month, dayOfMonth] = day.split('-').map(Number)
    if (!year || !month || !dayOfMonth) return null
    const date = new Date(year, month - 1, dayOfMonth)
    return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

/** 'YYYY-MM-DD'（本地日）→ 次日 00:00 本地时间的 ISO 串（until 为开区间上界）。 */
export function localDayEndExclusiveIso(day: string): string | null {
    const [year, month, dayOfMonth] = day.split('-').map(Number)
    if (!year || !month || !dayOfMonth) return null
    const date = new Date(year, month - 1, dayOfMonth + 1)
    return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

export function formatTokens(n: number): string {
    if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
    return String(n)
}

function modelTotal(m: Omit<UsageModelSummary, 'model'>): number {
    return m.inputTokens + m.outputTokens + m.cacheCreationInputTokens + m.cacheReadInputTokens
}

/** 缓存命中率 = 缓存读取 ÷ 总输入。分母**不含 output**：命中率讲的是「送进去的
 *  prompt 有多少是从缓存里拿的」，把生成出来的 token 塞进分母会无谓地压低它。
 *
 *  这三段是不重叠的——聚合端 `normalizeInclusiveInput` 已经把经 OpenAI 兼容中转的
 *  `input`（那边的 input 是含缓存读的整段 prompt）扣成了未命中量，所以这里直接相加
 *  就是真实的总输入。返回 null 表示这一行没有输入侧数据，不画百分比。 */
export function cacheHitRate(m: Omit<UsageModelSummary, 'model'>): number | null {
    const promptTokens = m.inputTokens + m.cacheCreationInputTokens + m.cacheReadInputTokens
    return promptTokens > 0 ? m.cacheReadInputTokens / promptTokens : null
}

export function formatHitRate(rate: number | null): string {
    return rate === null ? '—' : `${(rate * 100).toFixed(1)}%`
}

/**
 * 将同一模型的不同渠道前缀、推理档位后缀、日期快照与大小写/连字符变体归并为标准模型名。
 * 例如：
 * - `claude-opus-5-5` / `claude-opus-5-5-high` / `claude-opus-5-5-medium` / `opus5.5` / `opus5.5-high` → `claude-opus-5-5`
 * - `claude-opus-4.7` / `claude-opus-4-7` → `claude-opus-4-7`
 * - `anthropic/claude-4.6-opus-20260205` / `anthropic/claude-opus-4.6` / `claude-opus-4-6` → `claude-opus-4-6`
 * - `cx2cc/gpt-6.1-sol` / `cx2cc-ecs/gpt-6.1-sol` / `gpt-6.1-sol` → `gpt-6.1-sol`
 * - `Deepseek-v4-pro` / `deepseek-v4-pro` → `deepseek-v4-pro`
 * - `gemini-3.8-flash-tiered` / `gemini-3.8-flash` → `gemini-3.8-flash`
 */
export function canonicalizeModelName(rawModel: string): string {
    let normalized = rawModel.trim().toLowerCase()
    if (!normalized) return rawModel

    normalized = normalized.replace(/^[^/]+\//, '')
    normalized = normalized.replace(/-20\d{6}$/, '')

    while (/-(low|medium|high|xhigh|max|minimal|thinking|nothinking|tiered)$/.test(normalized)) {
        normalized = normalized.replace(/-(low|medium|high|xhigh|max|minimal|thinking|nothinking|tiered)$/, '')
    }

    const claudeFamilyFirst = normalized.match(/^(?:claude[-_]?)?(opus|sonnet|haiku|fable)[-_]?(\d+)(?:[.-](\d+))?$/)
    if (claudeFamilyFirst) {
        const [, family, major, minor] = claudeFamilyFirst
        return minor !== undefined ? `claude-${family}-${major}-${minor}` : `claude-${family}-${major}`
    }

    const claudeVersionFirst = normalized.match(/^claude[-_]?(\d+)(?:[.-](\d+))?[-_](opus|sonnet|haiku|fable)$/)
    if (claudeVersionFirst) {
        const [, major, minor, family] = claudeVersionFirst
        return minor !== undefined ? `claude-${family}-${major}-${minor}` : `claude-${family}-${major}`
    }

    return normalized
}

/**
 * 将同一模型的不同后缀/渠道变体（如 `claude-opus-5-5`、`claude-opus-5-5-high`、`opus5.5`）
 * 聚合为一条主模型记录，并在 `variants` 中保留去重后的原始变体明细（按总量降序）。
 * 大小写完全相同的同名项直接合并，不产生多余的假子项。
 */
export function groupUsageModels(models: UsageModelSummary[]): UsageModelGroup[] {
    const groups = new Map<string, {
        summary: UsageModelSummary
        variantsByLower: Map<string, UsageModelSummary>
    }>()

    for (const item of models) {
        const canonical = canonicalizeModelName(item.model)
        const variantKey = item.model.trim().toLowerCase()
        let entry = groups.get(canonical)
        if (!entry) {
            entry = {
                summary: {
                    model: canonical,
                    requestCount: 0,
                    inputTokens: 0,
                    outputTokens: 0,
                    cacheCreationInputTokens: 0,
                    cacheReadInputTokens: 0,
                },
                variantsByLower: new Map(),
            }
            groups.set(canonical, entry)
        }
        entry.summary.requestCount += item.requestCount
        entry.summary.inputTokens += item.inputTokens
        entry.summary.outputTokens += item.outputTokens
        entry.summary.cacheCreationInputTokens += item.cacheCreationInputTokens
        entry.summary.cacheReadInputTokens += item.cacheReadInputTokens

        const existingVariant = entry.variantsByLower.get(variantKey)
        if (!existingVariant) {
            entry.variantsByLower.set(variantKey, {
                model: item.model.trim(),
                requestCount: item.requestCount,
                inputTokens: item.inputTokens,
                outputTokens: item.outputTokens,
                cacheCreationInputTokens: item.cacheCreationInputTokens,
                cacheReadInputTokens: item.cacheReadInputTokens,
            })
        } else {
            // 若仅大小写不同（如 Deepseek-v4-pro 与 deepseek-v4-pro），优先保留全小写或先出现的规范名并累加数值
            if (item.model.trim() === variantKey) {
                existingVariant.model = variantKey
            }
            existingVariant.requestCount += item.requestCount
            existingVariant.inputTokens += item.inputTokens
            existingVariant.outputTokens += item.outputTokens
            existingVariant.cacheCreationInputTokens += item.cacheCreationInputTokens
            existingVariant.cacheReadInputTokens += item.cacheReadInputTokens
        }
    }

    return [...groups.values()]
        .map(({ summary, variantsByLower }) => ({
            ...summary,
            variants: [...variantsByLower.values()].sort(
                (a, b) => modelTotal(b) - modelTotal(a) || a.model.localeCompare(b.model)
            ),
        }))
        .sort((a, b) => modelTotal(b) - modelTotal(a) || a.model.localeCompare(b.model))
}

// 固定色板，和现有 UI 对齐不引入图表库，只用 CSS 横向堆叠条。
const SEGMENT_COLORS = {
    input: '#60a5fa',
    output: '#f97316',
    cacheCreation: '#a78bfa',
    cacheRead: '#34d399'
} as const

/**
 * 机器用量榜，兼作 host 筛选器。
 *
 * 此前这里是个裸 `<select>`：机器列表在用量页上不给任何量化信息，想知道
 * 「哪台机器烧了 token」只能逐台切筛选去比。现在它与会话侧栏的机器筛选条
 * 同一套表现（OS 图标、按归属人分节、右对齐统计），右侧数字是该机的 token
 * 总量，且按用量降序——列表本身就回答了那个问题。
 *
 * 统计值不随 host 筛选变化（服务端对全部可见会话算），所以选中一台之后
 * 其余机器仍可比较。
 */
function MachineUsageBoard(props: {
    hosts: UsageHostSummary[]
    /** fork(machine-icons)：host → 设备图标（榜单按 host 聚合，图标挂在机器上）。 */
    iconByHost?: ReadonlyMap<string, MachineIconId>
    value: string
    onChange: (host: string) => void
    allLabel: string
    unknownOwnerLabel: string
    ariaLabel: string
}) {
    const entries = useMemo(
        () => props.hosts.map((entry) => ({ ...entry, id: entry.host })),
        [props.hosts]
    )
    const { grouped, sections } = useMemo(() => groupMachinesByOwner(entries), [entries])
    const totalTokens = useMemo(
        () => props.hosts.reduce((sum, entry) => sum + entry.totalTokens, 0),
        [props.hosts]
    )

    const renderGrid = (items: typeof entries, leading?: ReactNode) => (
        <div className={machineChipGridClass}>
            {leading}
            {items.map((entry) => (
                <MachineChip
                    key={entry.host}
                    label={entry.host}
                    platform={entry.platform}
                    icon={props.iconByHost?.get(entry.host) ?? null}
                    stat={formatTokens(entry.totalTokens)}
                    selected={props.value === entry.host}
                    title={[
                        entry.host,
                        entry.owner,
                        `${entry.sessionCount} sessions`,
                        `${entry.requestCount.toLocaleString()} requests`
                    ].filter(Boolean).join(' · ')}
                    onSelect={() => props.onChange(props.value === entry.host ? '' : entry.host)}
                />
            ))}
        </div>
    )

    const allChip = (
        <button
            type="button"
            onClick={() => props.onChange('')}
            aria-pressed={props.value === ''}
            className={cn(
                machineChipShellClass,
                machineChipContentClass,
                props.value === '' ? machineChipSelectedClass : machineChipIdleClass
            )}
        >
            <span className="min-w-0 flex-1 truncate text-left">{props.allLabel}</span>
            <span className="shrink-0 tabular-nums opacity-70">{formatTokens(totalTokens)}</span>
        </button>
    )

    return (
        <div role="group" aria-label={props.ariaLabel} className="flex flex-col gap-1">
            {grouped ? (
                <>
                    {renderGrid([], allChip)}
                    {sections.map((section) => (
                        <div key={section.owner ?? '__unknown__'}>
                            <MachineOwnerHeading owner={section.owner} unknownLabel={props.unknownOwnerLabel} />
                            {renderGrid(section.machines)}
                        </div>
                    ))}
                </>
            ) : renderGrid(sections[0]?.machines ?? [], allChip)}
        </div>
    )
}

function VariantChevron(props: { expanded: boolean }) {
    return (
        <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            className={cn('h-3.5 w-3.5 shrink-0 text-[var(--app-hint)] transition-transform', props.expanded && 'rotate-90')}
        >
            <path d="M6 4l4 4-4 4" />
        </svg>
    )
}

function StackedBarTrack(props: { model: UsageModelSummary; maxTotal: number; compact?: boolean }) {
    const { model, maxTotal, compact } = props
    const total = modelTotal(model)
    const widthPct = maxTotal > 0 ? Math.max(1, (total / maxTotal) * 100) : 0
    const segments = [
        { key: 'input', value: model.inputTokens, color: SEGMENT_COLORS.input },
        { key: 'output', value: model.outputTokens, color: SEGMENT_COLORS.output },
        { key: 'cacheCreation', value: model.cacheCreationInputTokens, color: SEGMENT_COLORS.cacheCreation },
        { key: 'cacheRead', value: model.cacheReadInputTokens, color: SEGMENT_COLORS.cacheRead }
    ]
    return (
        <div className={cn('flex w-full overflow-hidden rounded-full bg-[var(--app-subtle-bg)]', compact ? 'h-2' : 'h-3')}>
            <div className="flex h-full overflow-hidden rounded-full" style={{ width: `${widthPct}%` }}>
                {segments.map((seg) => {
                    const segPct = total > 0 ? (seg.value / total) * 100 : 0
                    if (segPct <= 0) return null
                    return (
                        <div
                            key={seg.key}
                            style={{ width: `${segPct}%`, backgroundColor: seg.color }}
                            title={`${seg.key}: ${formatTokens(seg.value)}`}
                        />
                    )
                })}
            </div>
        </div>
    )
}

function UsageBar(props: {
    group: UsageModelGroup
    maxTotal: number
    expanded: boolean
    onToggleExpand: () => void
}) {
    const { t } = useTranslation()
    const { group, maxTotal, expanded, onToggleExpand } = props
    const total = modelTotal(group)
    const hasVariants = group.variants.length > 1

    return (
        <div className="space-y-1.5">
            <div className="flex items-baseline justify-between gap-3">
                {hasVariants ? (
                    <button
                        type="button"
                        onClick={onToggleExpand}
                        aria-expanded={expanded}
                        aria-label={expanded
                            ? t('usage.collapseVariants', { model: group.model })
                            : t('usage.expandVariants', { model: group.model, count: group.variants.length })}
                        className="inline-flex min-w-0 items-center gap-1.5 text-left font-medium hover:text-[var(--app-link)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] rounded"
                    >
                        <VariantChevron expanded={expanded} />
                        <span className="truncate">{group.model}</span>
                        <span className="shrink-0 rounded-full bg-[var(--app-subtle-bg)] px-1.5 py-0.5 text-[11px] font-normal text-[var(--app-hint)]">
                            {t('usage.modelVariants', { count: group.variants.length })}
                        </span>
                    </button>
                ) : (
                    <div className="font-medium">{group.model}</div>
                )}
                <div className="text-sm text-[var(--app-hint)]">
                    {formatTokens(total)} tokens · {group.requestCount.toLocaleString()}
                </div>
            </div>
            <StackedBarTrack model={group} maxTotal={maxTotal} />
            {hasVariants && expanded ? (
                <div className="mt-2 space-y-2 border-l-2 border-[var(--app-border)] pl-3">
                    {group.variants.map((variant) => {
                        const variantTotal = modelTotal(variant)
                        return (
                            <div key={variant.model} className="space-y-1">
                                <div className="flex items-baseline justify-between gap-3 text-xs">
                                    <div className="font-mono text-[var(--app-hint)]">{variant.model}</div>
                                    <div className="tabular-nums text-[var(--app-hint)]">
                                        {formatTokens(variantTotal)} tokens · {variant.requestCount.toLocaleString()}
                                    </div>
                                </div>
                                <StackedBarTrack model={variant} maxTotal={Math.max(1, total)} compact />
                            </div>
                        )
                    })}
                </div>
            ) : null}
        </div>
    )
}

function Legend() {
    const { t } = useTranslation()
    const items = [
        { label: t('usage.legend.input'), color: SEGMENT_COLORS.input },
        { label: t('usage.legend.output'), color: SEGMENT_COLORS.output },
        { label: t('usage.legend.cacheCreation'), color: SEGMENT_COLORS.cacheCreation },
        { label: t('usage.legend.cacheRead'), color: SEGMENT_COLORS.cacheRead }
    ]
    return (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--app-hint)]">
            {items.map((item) => (
                <div key={item.label} className="flex items-center gap-1.5">
                    <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: item.color }} />
                    {item.label}
                </div>
            ))}
        </div>
    )
}

function ModelTable(props: {
    groups: UsageModelGroup[]
    expandedModels: ReadonlySet<string>
    onToggleExpand: (model: string) => void
}) {
    const { t } = useTranslation()
    return (
        <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
                <thead>
                    <tr className="border-b border-[var(--app-border)] text-left text-[var(--app-hint)]">
                        <th className="py-1.5 pr-3 font-normal">{t('usage.table.model')}</th>
                        <th className="py-1.5 pr-3 text-right font-normal">{t('usage.table.requests')}</th>
                        <th className="py-1.5 pr-3 text-right font-normal">{t('usage.legend.input')}</th>
                        <th className="py-1.5 pr-3 text-right font-normal">{t('usage.legend.output')}</th>
                        <th className="py-1.5 pr-3 text-right font-normal">{t('usage.legend.cacheCreation')}</th>
                        <th className="py-1.5 pr-3 text-right font-normal">{t('usage.legend.cacheRead')}</th>
                        <th className="py-1.5 pr-3 text-right font-normal">{t('usage.table.hitRate')}</th>
                        <th className="py-1.5 text-right font-normal">{t('usage.table.total')}</th>
                    </tr>
                </thead>
                <tbody>
                    {props.groups.flatMap((group) => {
                        const hasVariants = group.variants.length > 1
                        const expanded = hasVariants && props.expandedModels.has(group.model)
                        const mainRow = (
                            <tr key={group.model} className="border-b border-[var(--app-divider)] last:border-0">
                                <td className="py-1.5 pr-3 font-medium">
                                    {hasVariants ? (
                                        <button
                                            type="button"
                                            onClick={() => props.onToggleExpand(group.model)}
                                            aria-expanded={expanded}
                                            aria-label={expanded
                                                ? t('usage.collapseVariants', { model: group.model })
                                                : t('usage.expandVariants', { model: group.model, count: group.variants.length })}
                                            className="inline-flex items-center gap-1.5 text-left font-medium hover:text-[var(--app-link)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] rounded"
                                        >
                                            <VariantChevron expanded={expanded} />
                                            <span>{group.model}</span>
                                            <span className="rounded-full bg-[var(--app-subtle-bg)] px-1.5 py-0.5 text-[11px] font-normal text-[var(--app-hint)]">
                                                {t('usage.modelVariants', { count: group.variants.length })}
                                            </span>
                                        </button>
                                    ) : (
                                        group.model
                                    )}
                                </td>
                                <td className="py-1.5 pr-3 text-right">{group.requestCount.toLocaleString()}</td>
                                <td className="py-1.5 pr-3 text-right">{formatTokens(group.inputTokens)}</td>
                                <td className="py-1.5 pr-3 text-right">{formatTokens(group.outputTokens)}</td>
                                <td className="py-1.5 pr-3 text-right">{formatTokens(group.cacheCreationInputTokens)}</td>
                                <td className="py-1.5 pr-3 text-right">{formatTokens(group.cacheReadInputTokens)}</td>
                                <td className="py-1.5 pr-3 text-right tabular-nums">{formatHitRate(cacheHitRate(group))}</td>
                                <td className="py-1.5 text-right font-medium">{formatTokens(modelTotal(group))}</td>
                            </tr>
                        )
                        if (!expanded) return [mainRow]
                        const variantRows = group.variants.map((variant) => (
                            <tr
                                key={`${group.model}::${variant.model}`}
                                data-testid={`model-variant-row-${group.model}`}
                                className="border-b border-[var(--app-divider)] bg-[var(--app-subtle-bg)]/40 text-xs text-[var(--app-hint)] last:border-0"
                            >
                                <td className="py-1 pr-3 pl-6 font-mono">{variant.model}</td>
                                <td className="py-1 pr-3 text-right tabular-nums">{variant.requestCount.toLocaleString()}</td>
                                <td className="py-1 pr-3 text-right tabular-nums">{formatTokens(variant.inputTokens)}</td>
                                <td className="py-1 pr-3 text-right tabular-nums">{formatTokens(variant.outputTokens)}</td>
                                <td className="py-1 pr-3 text-right tabular-nums">{formatTokens(variant.cacheCreationInputTokens)}</td>
                                <td className="py-1 pr-3 text-right tabular-nums">{formatTokens(variant.cacheReadInputTokens)}</td>
                                <td className="py-1 pr-3 text-right tabular-nums">{formatHitRate(cacheHitRate(variant))}</td>
                                <td className="py-1 text-right font-medium tabular-nums">{formatTokens(modelTotal(variant))}</td>
                            </tr>
                        ))
                        return [mainRow, ...variantRows]
                    })}
                </tbody>
            </table>
        </div>
    )
}

export default function UsagePage() {
    const { baseUrl, token, api } = useAppContext()
    const { machines } = useMachines(api, Boolean(api))
    const iconByHost = useMemo(() => {
        const byHost = new Map<string, MachineIconId>()
        for (const machine of machines) {
            const machineHost = machine.metadata?.host
            const icon = resolveMachineIcon(machine.metadata?.icon)
            if (machineHost && icon && !byHost.has(machineHost)) byHost.set(machineHost, icon)
        }
        return byHost
    }, [machines])
    const navigate = useNavigate()
    const { t } = useTranslation()
    const [range, setRange] = useState<RangeKey>('all')
    const [customStart, setCustomStart] = useState('')
    const [customEnd, setCustomEnd] = useState('')
    const [datePickerOpen, setDatePickerOpen] = useState(false)
    const [host, setHost] = useState('')
    const [expandedModels, setExpandedModels] = useState<Set<string>>(() => new Set())

    const toggleExpandModel = (model: string) => {
        setExpandedModels((current) => {
            const next = new Set(current)
            if (next.has(model)) next.delete(model)
            else next.add(model)
            return next
        })
    }

    const hasCustomRange = Boolean(customStart && customEnd)

    const { since, until } = useMemo(() => {
        if (range === 'custom') {
            return hasCustomRange
                ? { since: localDayStartIso(customStart), until: localDayEndExclusiveIso(customEnd) }
                : { since: null, until: null }
        }
        return { since: presetToSince(range), until: null }
    }, [range, hasCustomRange, customStart, customEnd])

    // 折线图的时间粒度随范围走，桶数控制在 hub 上限（60）以内；「全部」看最近 52 周。
    const trend = useMemo((): { since: string | null; until: string | null; unit: UsageBucketUnit } => {
        if (range === '24h') return { since, until, unit: 'hour' }
        if (range === '7d') return { since, until, unit: '6h' }
        if (range === '30d') return { since, until, unit: 'day' }
        if (range === 'custom' && since) {
            const spanMs = (until ? Date.parse(until) : Date.now()) - Date.parse(since)
            const unit: UsageBucketUnit = spanMs <= 2 * 86_400_000 ? 'hour'
                : spanMs <= 14 * 86_400_000 ? '6h'
                : spanMs <= 60 * 86_400_000 ? 'day'
                : 'week'
            return { since, until, unit }
        }
        return { since: new Date(Date.now() - 52 * 7 * 86_400_000).toISOString(), until: null, unit: 'week' }
    }, [range, since, until])

    const usageQuery = useQuery({
        queryKey: ['fork-usage-summary', range, range === 'custom' ? `${customStart}~${customEnd}` : '', host],
        queryFn: async (): Promise<UsageSummaryResponse> => {
            const search = new URLSearchParams()
            if (since) search.set('since', since)
            if (until) search.set('until', until)
            if (host) search.set('host', host)
            const qs = search.toString()
            const response = await fetch(`${baseUrl}/api/usage/summary${qs ? `?${qs}` : ''}`, {
                headers: { authorization: `Bearer ${token}` }
            })
            if (!response.ok) {
                const body = await response.json().catch(() => null) as { error?: string } | null
                throw new Error(body?.error ?? `HTTP ${response.status}`)
            }
            return await response.json() as UsageSummaryResponse
        },
        staleTime: 60_000,
        refetchInterval: 60_000
    })

    const rawModels = usageQuery.data?.models ?? []
    const modelGroups = useMemo(() => groupUsageModels(rawModels), [rawModels])
    const maxTotal = modelGroups.reduce((max, m) => Math.max(max, modelTotal(m)), 0)
    const totals = usageQuery.data?.totals
    const hosts = usageQuery.data?.hosts ?? []

    const rangeLabel = range === 'custom' && hasCustomRange
        ? `${customStart} – ${customEnd}`
        : t(`usage.range.${range === 'custom' ? 'all' : range}`)

    return (
        <div className="h-full min-h-0 overflow-y-auto bg-[var(--app-bg)] text-[var(--app-fg)]">
            <div className="sticky top-0 z-10 flex items-center justify-between border-b border-[var(--app-divider)] bg-[var(--app-bg)] px-4 py-3 pt-[calc(env(safe-area-inset-top)+0.75rem)]">
                <div>
                    <div className="text-base font-semibold">{t('usage.title')}</div>
                    <div className="text-xs text-[var(--app-hint)]">{t('usage.subtitle')}</div>
                </div>
                <Button variant="outline" size="sm" onClick={() => navigate({ to: '/sessions' })}>{t('usage.back')}</Button>
            </div>

            <div className="mx-auto max-w-5xl space-y-4 p-4">
                {/* 订阅/余额面板放在时间筛选**之上**：它是"此刻还剩多少"的快照，
                    不受下面那排时间范围按钮影响。放在筛选下面会让人误以为它也被筛。
                    非 admin 或无快照时组件自己返回 null，不占位。 */}
                <SubscriptionPanel />

                <div className="flex flex-wrap items-center gap-3">
                    <div className="flex flex-wrap gap-1.5">
                        {PRESET_RANGES.map((r) => (
                            <Button
                                key={r}
                                size="sm"
                                variant={range === r ? 'default' : 'outline'}
                                onClick={() => setRange(r)}
                            >{t(`usage.range.${r}`)}</Button>
                        ))}
                        <div className="relative">
                            <Button
                                size="sm"
                                variant={range === 'custom' ? 'default' : 'outline'}
                                onClick={() => setDatePickerOpen(open => !open)}
                                title={hasCustomRange ? `${customStart} – ${customEnd}` : t('usage.range.custom')}
                                aria-expanded={datePickerOpen}
                                className="gap-1.5"
                            >
                                <CalendarIcon className="h-4 w-4" />
                                {range === 'custom' && hasCustomRange ? `${customStart} – ${customEnd}` : t('usage.range.custom')}
                            </Button>
                            {datePickerOpen ? (
                                <>
                                    <button
                                        type="button"
                                        aria-label={t('sessions.timeFilter.close')}
                                        className="fixed inset-0 z-20 cursor-default"
                                        onClick={() => setDatePickerOpen(false)}
                                    />
                                    <SessionDateRangePicker
                                        start={customStart}
                                        end={customEnd}
                                        // 0.27 起日历新增两个必填 prop。用量页没有「会话活跃日」
                                        // 这一维数据（它统计的是 token 不是会话），给空集即不高亮任何日期。
                                        sessionActivityDates={EMPTY_ACTIVITY_DATES}
                                        align="right"
                                        onChange={(start, end) => {
                                            setCustomStart(start)
                                            setCustomEnd(end)
                                            if (start && end) setRange('custom')
                                            else if (!start && !end) setRange('all')
                                        }}
                                        onClear={() => {
                                            setCustomStart('')
                                            setCustomEnd('')
                                            setRange('all')
                                        }}
                                        onClose={() => setDatePickerOpen(false)}
                                    />
                                </>
                            ) : null}
                        </div>
                    </div>
                    {usageQuery.isFetching && <span className="text-xs text-[var(--app-hint)]">{t('usage.refreshing')}</span>}
                </div>

                {hosts.length > 0 && (
                    <MachineUsageBoard
                        hosts={hosts}
                        iconByHost={iconByHost}
                        value={host}
                        onChange={setHost}
                        allLabel={t('usage.host.all')}
                        unknownOwnerLabel={t('sessions.machineFilter.unknownOwner')}
                        ariaLabel={t('usage.host.label')}
                    />
                )}

                <Card>
                    <CardHeader>
                        <CardTitle>{t('usage.trend.title')}</CardTitle>
                        <CardDescription>{t(`usage.trend.unit.${trend.unit}`)}</CardDescription>
                    </CardHeader>
                    <CardContent>
                        <UsageTrendChart since={trend.since} until={trend.until} host={host} unit={trend.unit} trimLeadingEmpty={range === 'all'} />
                    </CardContent>
                </Card>

                {usageQuery.isLoading && (
                    <Card><CardContent className="py-6 text-center text-sm text-[var(--app-hint)]">{t('usage.loading')}</CardContent></Card>
                )}

                {usageQuery.isError && (
                    <Card>
                        <CardHeader>
                            <CardTitle>{t('usage.error.title')}</CardTitle>
                            <CardDescription>
                                {usageQuery.error instanceof Error ? usageQuery.error.message : t('usage.error.fallback')}
                            </CardDescription>
                        </CardHeader>
                    </Card>
                )}

                {usageQuery.isSuccess && modelGroups.length === 0 && (
                    <Card>
                        <CardHeader>
                            <CardTitle>{t('usage.empty.title')}</CardTitle>
                            <CardDescription>
                                {range === 'all' && !host ? t('usage.empty.hintAll') : t('usage.empty.hintFiltered')}
                            </CardDescription>
                        </CardHeader>
                    </Card>
                )}

                {usageQuery.isSuccess && modelGroups.length > 0 && totals && (
                    <>
                        <Card>
                            <CardHeader>
                                <CardTitle>{t('usage.overview')}</CardTitle>
                                <CardDescription>
                                    {t('usage.overviewSummary', {
                                        requests: totals.requestCount.toLocaleString(),
                                        tokens: formatTokens(modelTotal(totals))
                                    })}
                                    {' · '}{rangeLabel}
                                    {' · '}{host || t('usage.host.all')}
                                </CardDescription>
                            </CardHeader>
                            <CardContent className="space-y-4">
                                <div
                                    className="flex items-baseline gap-2 rounded-lg bg-[var(--app-subtle-bg)] px-3 py-2"
                                    title={t('usage.cacheHitRateHint')}
                                >
                                    <span className="text-xs text-[var(--app-hint)]">{t('usage.cacheHitRate')}</span>
                                    <span className="text-xl font-semibold tabular-nums">
                                        {formatHitRate(cacheHitRate(totals))}
                                    </span>
                                </div>
                                <Legend />
                                {modelGroups.map((group) => (
                                    <UsageBar
                                        key={group.model}
                                        group={group}
                                        maxTotal={maxTotal}
                                        expanded={expandedModels.has(group.model)}
                                        onToggleExpand={() => toggleExpandModel(group.model)}
                                    />
                                ))}
                            </CardContent>
                        </Card>

                        <Card>
                            <CardHeader>
                                <CardTitle>{t('usage.detail')}</CardTitle>
                            </CardHeader>
                            <CardContent>
                                <ModelTable
                                    groups={modelGroups}
                                    expandedModels={expandedModels}
                                    onToggleExpand={toggleExpandModel}
                                />
                            </CardContent>
                        </Card>
                    </>
                )}
            </div>
        </div>
    )
}
