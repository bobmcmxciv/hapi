import type { ClaudeProxyModelSummary } from './types'

export type ClaudeProxyModelOption = { value: string; label: string }

/**
 * 选择器里代理模型的标签：**裸 id 直显**（选它就是为了看到实际跑的那个名字，美化反而
 * 掩盖真相），被代理改写的条目追加 `→ 实际执行的 slug`，默认模型追加 `· default`。
 * 例：`gpt-5.6-sol → gpt-6-astra`、`gpt-6-astra · default`。
 */
export function formatClaudeProxyModelLabel(model: ClaudeProxyModelSummary): string {
    let label = model.id
    if (model.servedAs) {
        label += ` → ${model.servedAs}`
    }
    if (model.isDefault) {
        label += ' · default'
    }
    return label
}

/** New Session / composer 用的 `{ value, label }` 列表；顺序沿用 hub（默认模型在首）。 */
export function buildClaudeProxyModelOptions(models: readonly ClaudeProxyModelSummary[]): ClaudeProxyModelOption[] {
    const seen = new Set<string>()
    const options: ClaudeProxyModelOption[] = []
    for (const model of models) {
        const id = model.id.trim()
        if (!id || seen.has(id)) continue
        seen.add(id)
        options.push({ value: id, label: formatClaudeProxyModelLabel(model) })
    }
    return options
}

/**
 * 代理声明的服务端契约窗口（id → tokens），给状态栏"上下文剩余"分母用。
 * 只收 `contextWindow`（当前契约），不用 `maxContextWindow`（那是弹性上限，不是默认计量）。
 */
export function claudeProxyContextWindows(models: readonly ClaudeProxyModelSummary[]): Record<string, number> {
    const windows: Record<string, number> = {}
    for (const model of models) {
        if (typeof model.contextWindow === 'number' && model.contextWindow > 0) {
            windows[model.id] = model.contextWindow
        }
    }
    return windows
}

/** 把 epoch ms 格式化成选择器下方"更新于 HH:MM"用的短时间。 */
export function formatClaudeProxyFetchedAt(fetchedAt: number | null, locale?: string): string | null {
    if (fetchedAt === null || !Number.isFinite(fetchedAt)) return null
    try {
        return new Date(fetchedAt).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
    } catch {
        return null
    }
}
