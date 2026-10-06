import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useAppContext } from '@/lib/app-context'
import { useTranslation } from '@/lib/use-translation'
import { cn } from '@/lib/utils'

export type UsageBucketUnit = 'hour' | '6h' | 'day' | 'week'

type TimeseriesSeries = {
    model: string
    inputTokens: number[]
    outputTokens: number[]
    cacheCreationInputTokens: number[]
    cacheReadInputTokens: number[]
    requestCount: number[]
}

type TimeseriesResponse = { unit: UsageBucketUnit; buckets: string[]; series: TimeseriesSeries[] }

export type TrendMetric = 'total' | 'input' | 'output' | 'cacheRead' | 'cacheCreation'
const METRICS: TrendMetric[] = ['total', 'input', 'output', 'cacheRead', 'cacheCreation']

/** 分类色 8 槽，按固定顺序分配（dataviz 参考调色板，亮/暗两套已校验）；
 *  第 8 槽固定给「其他」。 */
const SLOT_COUNT = 8
export const MAX_NAMED_SERIES = SLOT_COUNT - 1

function metricValues(series: TimeseriesSeries, metric: TrendMetric): number[] {
    switch (metric) {
        case 'input': return series.inputTokens
        case 'output': return series.outputTokens
        case 'cacheRead': return series.cacheReadInputTokens
        case 'cacheCreation': return series.cacheCreationInputTokens
        default: return series.inputTokens.map((value, i) =>
            value + series.outputTokens[i]! + series.cacheCreationInputTokens[i]! + series.cacheReadInputTokens[i]!)
    }
}

/** 取当前指标下总量最大的 7 个模型，其余并成「其他」。颜色跟模型走：按总量
 *  （不随指标变）排定的位置分配，切指标不会给同一条线换色。 */
export function buildTrendLines(data: TimeseriesResponse, metric: TrendMetric, otherLabel: string): Array<{ key: string; label: string; slot: number; values: number[] }> {
    const named = data.series.slice(0, MAX_NAMED_SERIES)
    const rest = data.series.slice(MAX_NAMED_SERIES)
    const lines = named.map((series, index) => ({ key: series.model, label: series.model, slot: index + 1, values: metricValues(series, metric) }))
    if (rest.length > 0) {
        const values = data.buckets.map((_, i) => rest.reduce((sum, series) => sum + metricValues(series, metric)[i]!, 0))
        lines.push({ key: '__other__', label: otherLabel, slot: SLOT_COUNT, values })
    }
    return lines.filter(line => line.values.some(value => value > 0))
}

function formatTokens(n: number): string {
    if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
    if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`
    return String(Math.round(n))
}

function niceMax(value: number): number {
    if (value <= 0) return 1
    const exponent = Math.pow(10, Math.floor(Math.log10(value)))
    const fraction = value / exponent
    const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10
    return nice * exponent
}

function formatBucket(iso: string, unit: UsageBucketUnit, long: boolean): string {
    const date = new Date(iso)
    if (unit === 'hour' || unit === '6h') {
        const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
        return long || date.getHours() === 0
            ? `${date.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' })} ${time}`
            : time
    }
    return date.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' })
}

const CHART_STYLE = `
.usage-trend {
  --trend-1: #2a78d6; --trend-2: #eb6834; --trend-3: #1baf7a; --trend-4: #eda100;
  --trend-5: #e87ba4; --trend-6: #008300; --trend-7: #4a3aa7; --trend-8: #8a8986;
}
[data-theme="dark"] .usage-trend, [data-theme="oled"] .usage-trend {
  --trend-1: #3987e5; --trend-2: #d95926; --trend-3: #199e70; --trend-4: #c98500;
  --trend-5: #d55181; --trend-6: #008300; --trend-7: #9085e9; --trend-8: #8a8986;
}
`

const HEIGHT = 220
const PAD = { top: 12, right: 12, bottom: 26, left: 52 }

export function UsageTrendChart(props: { since: string | null; until: string | null; host: string; unit: UsageBucketUnit; trimLeadingEmpty?: boolean }) {
    const { t } = useTranslation()
    const { baseUrl, token } = useAppContext()
    const [metric, setMetric] = useState<TrendMetric>('total')
    const [hover, setHover] = useState<number | null>(null)
    const [showTable, setShowTable] = useState(false)
    const [hidden, setHidden] = useState<Set<string>>(() => new Set())
    const containerRef = useRef<HTMLDivElement>(null)
    const [width, setWidth] = useState(640)

    useEffect(() => {
        const element = containerRef.current
        if (!element || typeof ResizeObserver === 'undefined') return
        const observer = new ResizeObserver((entries) => {
            const next = Math.floor(entries[0]?.contentRect.width ?? 0)
            if (next > 0) setWidth(next)
        })
        observer.observe(element)
        return () => observer.disconnect()
    }, [])

    const tz = -new Date().getTimezoneOffset()
    const query = useQuery({
        queryKey: ['fork-usage-timeseries', props.since, props.until, props.host, props.unit, tz],
        queryFn: async (): Promise<TimeseriesResponse> => {
            const search = new URLSearchParams({ bucket: props.unit, tz: String(tz) })
            if (props.since) search.set('since', props.since)
            if (props.until) search.set('until', props.until)
            if (props.host) search.set('host', props.host)
            const response = await fetch(`${baseUrl}/api/usage/timeseries?${search}`, { headers: { authorization: `Bearer ${token}` } })
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            return await response.json() as TimeseriesResponse
        },
        refetchInterval: 120_000
    })

    // 「全部」范围按 52 周取数，但真正有用量的历史可能只有几周：去掉开头整段为零的桶，
    // 让横轴从第一笔用量（前一桶）开始。
    const data = useMemo(() => {
        const raw = query.data
        if (!raw || !props.trimLeadingEmpty) return raw
        const first = raw.buckets.findIndex((_, i) => raw.series.some(series => metricValues(series, 'total')[i]! > 0))
        const start = first <= 0 ? 0 : first - 1
        if (start === 0) return raw
        const cut = (values: number[]) => values.slice(start)
        return {
            ...raw,
            buckets: raw.buckets.slice(start),
            series: raw.series.map(series => ({
                ...series,
                inputTokens: cut(series.inputTokens),
                outputTokens: cut(series.outputTokens),
                cacheCreationInputTokens: cut(series.cacheCreationInputTokens),
                cacheReadInputTokens: cut(series.cacheReadInputTokens),
                requestCount: cut(series.requestCount)
            }))
        }
    }, [query.data, props.trimLeadingEmpty])
    const lines = useMemo(() => (data ? buildTrendLines(data, metric, t('usage.trend.other')) : []), [data, metric, t])
    const shown = lines.filter(line => !hidden.has(line.key))
    const buckets = data?.buckets ?? []
    const max = niceMax(Math.max(0, ...shown.flatMap(line => line.values)))
    const plotWidth = Math.max(10, width - PAD.left - PAD.right)
    const plotHeight = HEIGHT - PAD.top - PAD.bottom
    const x = (index: number) => PAD.left + (buckets.length <= 1 ? plotWidth / 2 : (index * plotWidth) / (buckets.length - 1))
    const y = (value: number) => PAD.top + plotHeight - (value / max) * plotHeight
    const ticks = [0, 0.25, 0.5, 0.75, 1].map(f => f * max)
    const labelEvery = Math.max(1, Math.ceil(buckets.length / Math.max(2, Math.floor(plotWidth / 70))))

    const onPointer = (event: React.PointerEvent<SVGRectElement>) => {
        if (buckets.length === 0) return
        const rect = event.currentTarget.getBoundingClientRect()
        const ratio = (event.clientX - rect.left) / rect.width
        setHover(Math.min(buckets.length - 1, Math.max(0, Math.round(ratio * (buckets.length - 1)))))
    }

    const hoverRows = hover === null ? [] : shown
        .map(line => ({ line, value: line.values[hover] ?? 0 }))
        .sort((a, b) => b.value - a.value)

    return (
        <div className="usage-trend flex flex-col gap-3" data-testid="usage-trend">
            <style>{CHART_STYLE}</style>
            <div className="flex flex-wrap items-center gap-1.5">
                {METRICS.map(item => (
                    <button
                        key={item}
                        type="button"
                        aria-pressed={metric === item}
                        onClick={() => setMetric(item)}
                        className={cn(
                            'rounded-full border px-2.5 py-0.5 text-xs transition-colors',
                            metric === item
                                ? 'border-[var(--app-link)] bg-[var(--app-subtle-bg)] text-[var(--app-link)]'
                                : 'border-[var(--app-border)] text-[var(--app-hint)] hover:text-[var(--app-fg)]'
                        )}
                    >
                        {t(`usage.trend.metric.${item}`)}
                    </button>
                ))}
                <div className="flex-1" />
                <button
                    type="button"
                    onClick={() => setShowTable(value => !value)}
                    className="text-xs text-[var(--app-link)] hover:underline"
                >
                    {showTable ? t('usage.trend.showChart') : t('usage.trend.showTable')}
                </button>
            </div>

            <div ref={containerRef} className="relative w-full">
                {query.isLoading ? (
                    <div className="flex items-center justify-center text-sm text-[var(--app-hint)]" style={{ height: HEIGHT }}>{t('usage.loading')}</div>
                ) : query.isError ? (
                    <div className="flex items-center justify-center text-sm text-red-600" style={{ height: HEIGHT }}>{String(query.error)}</div>
                ) : lines.length === 0 ? (
                    <div className="flex items-center justify-center text-sm text-[var(--app-hint)]" style={{ height: HEIGHT }}>{t('usage.trend.empty')}</div>
                ) : showTable ? (
                    <div className="max-h-80 overflow-auto">
                        <table className="w-full text-xs tabular-nums">
                            <thead className="sticky top-0 bg-[var(--app-bg)] text-[var(--app-hint)]">
                                <tr>
                                    <th className="px-2 py-1 text-left font-medium">{t('usage.trend.time')}</th>
                                    {lines.map(line => <th key={line.key} className="px-2 py-1 text-right font-medium">{line.label}</th>)}
                                </tr>
                            </thead>
                            <tbody>
                                {buckets.map((bucket, index) => (
                                    <tr key={bucket} className="border-t border-[var(--app-border)]">
                                        <td className="px-2 py-1 text-[var(--app-hint)]">{formatBucket(bucket, data!.unit, true)}</td>
                                        {lines.map(line => <td key={line.key} className="px-2 py-1 text-right text-[var(--app-fg)]">{formatTokens(line.values[index] ?? 0)}</td>)}
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                ) : (
                    <>
                        <svg width={width} height={HEIGHT} role="img" aria-label={t('usage.trend.title')} className="block">
                            {ticks.map((tick) => (
                                <g key={tick}>
                                    <line x1={PAD.left} x2={PAD.left + plotWidth} y1={y(tick)} y2={y(tick)} stroke="var(--app-border)" strokeWidth={1} />
                                    <text x={PAD.left - 6} y={y(tick)} dy="0.32em" textAnchor="end" fontSize={10} fill="var(--app-hint)">{formatTokens(tick)}</text>
                                </g>
                            ))}
                            {buckets.map((bucket, index) => (index % labelEvery === 0 ? (
                                <text key={bucket} x={x(index)} y={HEIGHT - 8} textAnchor="middle" fontSize={10} fill="var(--app-hint)">
                                    {formatBucket(bucket, data!.unit, false)}
                                </text>
                            ) : null))}
                            {hover !== null ? (
                                <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={PAD.top + plotHeight} stroke="var(--app-hint)" strokeWidth={1} strokeDasharray="3 3" />
                            ) : null}
                            {shown.map(line => (
                                <polyline
                                    key={line.key}
                                    data-series={line.key}
                                    fill="none"
                                    stroke={`var(--trend-${line.slot})`}
                                    strokeWidth={2}
                                    strokeLinejoin="round"
                                    strokeLinecap="round"
                                    points={line.values.map((value, index) => `${x(index)},${y(value)}`).join(' ')}
                                />
                            ))}
                            {hover !== null ? shown.map(line => (
                                <circle key={line.key} cx={x(hover)} cy={y(line.values[hover] ?? 0)} r={4} fill={`var(--trend-${line.slot})`} stroke="var(--app-bg)" strokeWidth={2} />
                            )) : null}
                            <rect
                                x={PAD.left}
                                y={PAD.top}
                                width={plotWidth}
                                height={plotHeight}
                                fill="transparent"
                                onPointerMove={onPointer}
                                onPointerDown={onPointer}
                                onPointerLeave={() => setHover(null)}
                            />
                        </svg>
                        {hover !== null ? (
                            <div
                                className="pointer-events-none absolute top-1 z-10 min-w-[11rem] rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-2.5 py-2 text-xs shadow-lg"
                                style={x(hover) > width / 2 ? { right: width - x(hover) + 10 } : { left: x(hover) + 10 }}
                            >
                                <div className="mb-1 font-medium text-[var(--app-fg)]">{formatBucket(buckets[hover]!, data!.unit, true)}</div>
                                {hoverRows.map(({ line, value }) => (
                                    <div key={line.key} className="flex items-center gap-2">
                                        <span className="h-0.5 w-3 shrink-0 rounded" style={{ background: `var(--trend-${line.slot})` }} />
                                        <span className="min-w-0 flex-1 truncate text-[var(--app-hint)]">{line.label}</span>
                                        <span className="tabular-nums text-[var(--app-fg)]">{formatTokens(value)}</span>
                                    </div>
                                ))}
                            </div>
                        ) : null}
                    </>
                )}
            </div>

            {lines.length > 0 ? (
                <div className="flex flex-wrap gap-x-3 gap-y-1" role="list" aria-label={t('usage.trend.legend')}>
                    {lines.map(line => {
                        const off = hidden.has(line.key)
                        return (
                            <button
                                key={line.key}
                                type="button"
                                role="listitem"
                                aria-pressed={!off}
                                onClick={() => setHidden(current => {
                                    const next = new Set(current)
                                    if (next.has(line.key)) next.delete(line.key)
                                    else next.add(line.key)
                                    return next
                                })}
                                className={cn('flex items-center gap-1.5 text-xs', off ? 'text-[var(--app-hint)] line-through opacity-60' : 'text-[var(--app-fg)]')}
                            >
                                <span className="h-0.5 w-4 rounded" style={{ background: `var(--trend-${line.slot})` }} />
                                {line.label}
                            </button>
                        )
                    })}
                </div>
            ) : null}
        </div>
    )
}
