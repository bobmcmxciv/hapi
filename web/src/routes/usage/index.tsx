import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useAppContext } from '@/lib/app-context'
import { queryKeys } from '@/lib/query-keys'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import type { UsageModelSummary } from '@/types/api'

const RANGES = [
    { key: 'all', label: '全部' },
    { key: '24h', label: '近 24 小时' },
    { key: '7d', label: '近 7 天' },
    { key: '30d', label: '近 30 天' }
] as const

type RangeKey = (typeof RANGES)[number]['key']

/** 把预设范围换算成 ISO 起点；'all' 不传 since。 */
function rangeToSince(range: RangeKey): string | null {
    if (range === 'all') return null
    const hours = range === '24h' ? 24 : range === '7d' ? 24 * 7 : 24 * 30
    return new Date(Date.now() - hours * 3600_000).toISOString()
}

function formatTokens(n: number): string {
    if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
    return String(n)
}

function modelTotal(m: Pick<UsageModelSummary, 'inputTokens' | 'outputTokens' | 'cacheCreationInputTokens' | 'cacheReadInputTokens'>): number {
    return m.inputTokens + m.outputTokens + m.cacheCreationInputTokens + m.cacheReadInputTokens
}

// 固定色板,和现有 UI 不引入图表库对齐,只用 CSS 横向堆叠条。
const SEGMENT_COLORS = {
    input: '#60a5fa',
    output: '#f97316',
    cacheCreation: '#a78bfa',
    cacheRead: '#34d399'
} as const

function UsageBar(props: { model: UsageModelSummary; maxTotal: number }) {
    const { model, maxTotal } = props
    const total = modelTotal(model)
    const widthPct = maxTotal > 0 ? Math.max(1, (total / maxTotal) * 100) : 0
    const segments = [
        { key: 'input', value: model.inputTokens, color: SEGMENT_COLORS.input },
        { key: 'output', value: model.outputTokens, color: SEGMENT_COLORS.output },
        { key: 'cacheCreation', value: model.cacheCreationInputTokens, color: SEGMENT_COLORS.cacheCreation },
        { key: 'cacheRead', value: model.cacheReadInputTokens, color: SEGMENT_COLORS.cacheRead }
    ]

    return (
        <div className="space-y-1.5">
            <div className="flex items-baseline justify-between gap-3">
                <div className="font-medium">{model.model}</div>
                <div className="text-sm text-[var(--app-hint)]">
                    {formatTokens(total)} tokens · {model.requestCount} 次请求
                </div>
            </div>
            <div
                className="flex h-3 w-full overflow-hidden rounded-full bg-[var(--app-subtle-bg)]"
                style={{ width: '100%' }}
            >
                <div className="flex h-full rounded-full overflow-hidden" style={{ width: `${widthPct}%` }}>
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
        </div>
    )
}

function Legend() {
    const items = [
        { label: '输入 (input)', color: SEGMENT_COLORS.input },
        { label: '输出 (output)', color: SEGMENT_COLORS.output },
        { label: '缓存写入 (cache creation)', color: SEGMENT_COLORS.cacheCreation },
        { label: '缓存读取 (cache read)', color: SEGMENT_COLORS.cacheRead }
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

function ModelTable(props: { models: UsageModelSummary[] }) {
    return (
        <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
                <thead>
                    <tr className="border-b border-[var(--app-border)] text-left text-[var(--app-hint)]">
                        <th className="py-1.5 pr-3 font-normal">模型</th>
                        <th className="py-1.5 pr-3 font-normal text-right">请求数</th>
                        <th className="py-1.5 pr-3 font-normal text-right">输入</th>
                        <th className="py-1.5 pr-3 font-normal text-right">输出</th>
                        <th className="py-1.5 pr-3 font-normal text-right">缓存写入</th>
                        <th className="py-1.5 pr-3 font-normal text-right">缓存读取</th>
                        <th className="py-1.5 font-normal text-right">合计</th>
                    </tr>
                </thead>
                <tbody>
                    {props.models.map((m) => (
                        <tr key={m.model} className="border-b border-[var(--app-divider)] last:border-0">
                            <td className="py-1.5 pr-3 font-medium">{m.model}</td>
                            <td className="py-1.5 pr-3 text-right">{m.requestCount.toLocaleString()}</td>
                            <td className="py-1.5 pr-3 text-right">{formatTokens(m.inputTokens)}</td>
                            <td className="py-1.5 pr-3 text-right">{formatTokens(m.outputTokens)}</td>
                            <td className="py-1.5 pr-3 text-right">{formatTokens(m.cacheCreationInputTokens)}</td>
                            <td className="py-1.5 pr-3 text-right">{formatTokens(m.cacheReadInputTokens)}</td>
                            <td className="py-1.5 text-right font-medium">{formatTokens(modelTotal(m))}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    )
}

export default function UsagePage() {
    const { api } = useAppContext()
    const navigate = useNavigate()
    const [range, setRange] = useState<RangeKey>('all')
    const [host, setHost] = useState<string>('')

    const usageQuery = useQuery({
        queryKey: queryKeys.usageSummary(range, host || 'all'),
        queryFn: () => api.getUsageSummary({ since: rangeToSince(range), host: host || null }),
        staleTime: 60_000,
        refetchInterval: 60_000
    })

    const models = usageQuery.data?.models ?? []
    const maxTotal = models.reduce((max, m) => Math.max(max, modelTotal(m)), 0)
    const totals = usageQuery.data?.totals
    const hosts = usageQuery.data?.hosts ?? []

    return (
        <div className="h-full min-h-0 overflow-y-auto bg-[var(--app-bg)] text-[var(--app-fg)]">
            <div className="sticky top-0 z-10 flex items-center justify-between border-b border-[var(--app-divider)] bg-[var(--app-bg)] px-4 py-3">
                <div>
                    <div className="text-base font-semibold">Token 用量统计</div>
                    <div className="text-xs text-[var(--app-hint)]">按模型汇总的输入/输出/缓存 token 用量</div>
                </div>
                <Button variant="outline" size="sm" onClick={() => navigate({ to: '/sessions' })}>返回</Button>
            </div>

            <div className="mx-auto max-w-5xl space-y-4 p-4">
                <div className="flex flex-wrap items-center gap-3">
                    <div className="flex flex-wrap gap-1.5">
                        {RANGES.map((r) => (
                            <Button
                                key={r.key}
                                size="sm"
                                variant={range === r.key ? 'default' : 'outline'}
                                onClick={() => setRange(r.key)}
                            >{r.label}</Button>
                        ))}
                    </div>
                    <select
                        className="rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-2.5 py-1.5 text-sm text-[var(--app-fg)] focus:outline-none focus:ring-2 focus:ring-[var(--app-button)]"
                        value={host}
                        onChange={(e) => setHost(e.target.value)}
                    >
                        <option value="">全部机器</option>
                        {hosts.map((h) => (
                            <option key={h} value={h}>{h}</option>
                        ))}
                    </select>
                    {usageQuery.isFetching && <span className="text-xs text-[var(--app-hint)]">刷新中…</span>}
                </div>
                {usageQuery.isLoading && (
                    <Card><CardContent className="py-6 text-center text-sm text-[var(--app-hint)]">加载中…</CardContent></Card>
                )}

                {usageQuery.isError && (
                    <Card>
                        <CardHeader>
                            <CardTitle>加载失败</CardTitle>
                            <CardDescription>
                                {usageQuery.error instanceof Error ? usageQuery.error.message : '无法获取用量数据'}
                            </CardDescription>
                        </CardHeader>
                    </Card>
                )}

                {usageQuery.isSuccess && models.length === 0 && (
                    <Card>
                        <CardHeader>
                            <CardTitle>暂无数据</CardTitle>
                            <CardDescription>
                                {range === 'all' && !host
                                    ? '还没有任何会话产生带 usage 信息的消息。'
                                    : '当前筛选条件下没有用量记录，试试放宽时间范围或切换机器。'}
                            </CardDescription>
                        </CardHeader>
                    </Card>
                )}

                {usageQuery.isSuccess && models.length > 0 && totals && (
                    <>
                        <Card>
                            <CardHeader>
                                <CardTitle>总览</CardTitle>
                                <CardDescription>
                                    共 {totals.requestCount.toLocaleString()} 次请求 · {formatTokens(modelTotal(totals))} tokens
                                    {' · '}{RANGES.find((r) => r.key === range)?.label}
                                    {host ? ` · ${host}` : ' · 全部机器'}
                                </CardDescription>
                            </CardHeader>
                            <CardContent className="space-y-4">
                                <Legend />
                                {models.map((m) => (
                                    <UsageBar key={m.model} model={m} maxTotal={maxTotal} />
                                ))}
                            </CardContent>
                        </Card>

                        <Card>
                            <CardHeader>
                                <CardTitle>明细</CardTitle>
                            </CardHeader>
                            <CardContent>
                                <ModelTable models={models} />
                            </CardContent>
                        </Card>
                    </>
                )}
            </div>
        </div>
    )
}
