/**
 * 「梳理待办」：把用户当前所有主线、等你处理的会话、正在跑的会话交给摘要模型（Luna），
 * 让它梳理成一份「现在需要你做的事」。上下文由前端从已有的工作模型里组装（前端已经有完整的
 * 主线/支线/项目下一步/会话归属），hub 只负责拼提示词、调模型、解析、按账号存最新一份。
 */

export type BriefingItem = {
    text: string
    /** 指向具体会话（前端可直接打开或弹出处理卡片）。 */
    sessionId?: string
    /** 指向主线/支线（前端过滤会话列表）。 */
    lineId?: string
    priority?: 'high' | 'normal'
}

export type BriefingGroup = { title: string; items: BriefingItem[] }

export type Briefing = {
    summary: string
    groups: BriefingGroup[]
    generatedAt: number
    model: string | null
    error: string | null
}

export type BriefingContext = {
    now?: number
    lines: Array<{ id: string; name: string; parentId: string | null; goal?: string; status?: string; lastActivity?: number; nextSteps?: string[] }>
    pending: Array<{ sessionId: string; title: string; lineId?: string | null; machine?: string; updatedAt?: number; detail?: string }>
    active: Array<{ sessionId: string; title: string; lineId?: string | null; machine?: string; thinking?: boolean; status?: string }>
    recent: Array<{ sessionId: string; title: string; lineId?: string | null; updatedAt?: number; status?: string; completed?: boolean }>
    /** 用户明确说过「不需要再关注」的会话。 */
    dismissed: Array<{ sessionId: string; title: string }>
}

export const BRIEFING_SYSTEM_PROMPT = [
    '你是用户的工作秘书。根据给定的工作状态，梳理用户「现在需要做的事」。',
    '只依据给出的数据，不编造；被用户标记为「不需要再关注」的会话一律不要再列为待办。',
    '只输出一个 JSON 对象，不要任何其他文字。'
].join('\n')

const MAX_PROMPT_CHARS = 60_000

function day(ms: number | undefined, now: number): string {
    if (!ms) return '未知'
    const days = Math.floor((now - ms) / 86_400_000)
    return days <= 0 ? '今天' : days === 1 ? '昨天' : `${days} 天前`
}

export function buildBriefingPrompt(context: BriefingContext): string {
    const now = context.now ?? Date.now()
    const mains = context.lines.filter(line => !line.parentId)
    const out: string[] = []
    out.push('## 主线与支线（id｜名称｜状态｜最近活动｜目标｜下一步）')
    for (const main of mains) {
        out.push(`- ${main.id}｜${main.name}｜${main.status ?? ''}｜${day(main.lastActivity, now)}｜${main.goal ?? ''}`)
        for (const sub of context.lines.filter(line => line.parentId === main.id)) {
            const next = (sub.nextSteps ?? []).slice(0, 3).join('；')
            out.push(`  - ${sub.id}｜${sub.name}｜${sub.status ?? ''}｜${day(sub.lastActivity, now)}｜${sub.goal ?? ''}｜${next}`)
        }
    }
    out.push('', '## 等用户处理的会话（有审批/提问没回应；sessionId｜标题｜所属线｜机器｜最近活动｜详情）')
    for (const item of context.pending) out.push(`- ${item.sessionId}｜${item.title}｜${item.lineId ?? ''}｜${item.machine ?? ''}｜${day(item.updatedAt, now)}｜${item.detail ?? ''}`)
    out.push('', '## 正在运行的会话（sessionId｜标题｜所属线｜机器｜是否正在思考｜现状）')
    for (const item of context.active) out.push(`- ${item.sessionId}｜${item.title}｜${item.lineId ?? ''}｜${item.machine ?? ''}｜${item.thinking ? '思考中' : '空闲'}｜${item.status ?? ''}`)
    out.push('', '## 最近两周有动静的会话（sessionId｜标题｜所属线｜最近活动｜现状｜是否已完结）')
    for (const item of context.recent) out.push(`- ${item.sessionId}｜${item.title}｜${item.lineId ?? ''}｜${day(item.updatedAt, now)}｜${item.status ?? ''}｜${item.completed ? '已完结' : ''}`)
    out.push('', '## 用户已标记「不需要再关注」的会话（不要再把它们列为待办）')
    for (const item of context.dismissed) out.push(`- ${item.sessionId}｜${item.title}`)
    out.push('', [
        '请输出 JSON：{"summary":"一两句话的总体判断","groups":[{"title":"分组标题","items":[{"text":"具体要做的事，动词开头，一句话","sessionId":"可选，指向上面出现过的会话 id","lineId":"可选，指向上面出现过的主线/支线 id","priority":"high 或 normal"}]}]}',
        '分组建议（没有内容的组不要输出）：「需要你拍板/回复」「今天推进」「可以收尾或归档」「停滞提醒」。',
        '每组最多 6 条，优先级高的在前；sessionId / lineId 只能用上面给出的值，不确定就不填。'
    ].join('\n'))
    const text = out.join('\n')
    return text.length > MAX_PROMPT_CHARS ? text.slice(0, MAX_PROMPT_CHARS) : text
}

/** 从模型输出里取第一个 JSON 对象并做形状校验；不认识的字段丢掉。 */
export function parseBriefing(text: string, known: { sessionIds: Set<string>; lineIds: Set<string> }): Pick<Briefing, 'summary' | 'groups'> | null {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start < 0 || end <= start) return null
    let raw: unknown
    try {
        raw = JSON.parse(text.slice(start, end + 1))
    } catch {
        return null
    }
    if (!raw || typeof raw !== 'object') return null
    const object = raw as { summary?: unknown; groups?: unknown }
    const groups: BriefingGroup[] = []
    for (const group of Array.isArray(object.groups) ? object.groups : []) {
        if (!group || typeof group !== 'object') continue
        const g = group as { title?: unknown; items?: unknown }
        const title = typeof g.title === 'string' ? g.title.trim().slice(0, 40) : ''
        const items: BriefingItem[] = []
        for (const item of Array.isArray(g.items) ? g.items : []) {
            if (!item || typeof item !== 'object') continue
            const i = item as { text?: unknown; sessionId?: unknown; lineId?: unknown; priority?: unknown }
            const itemText = typeof i.text === 'string' ? i.text.trim().slice(0, 200) : ''
            if (!itemText) continue
            const next: BriefingItem = { text: itemText }
            if (typeof i.sessionId === 'string' && known.sessionIds.has(i.sessionId)) next.sessionId = i.sessionId
            if (typeof i.lineId === 'string' && known.lineIds.has(i.lineId)) next.lineId = i.lineId
            if (i.priority === 'high') next.priority = 'high'
            items.push(next)
            if (items.length >= 8) break
        }
        if (title && items.length > 0) groups.push({ title, items })
    }
    const summary = typeof object.summary === 'string' ? object.summary.trim().slice(0, 300) : ''
    if (!summary && groups.length === 0) return null
    return { summary, groups }
}

export function knownIds(context: BriefingContext): { sessionIds: Set<string>; lineIds: Set<string> } {
    const dismissed = new Set(context.dismissed.map(item => item.sessionId))
    const sessionIds = new Set<string>()
    for (const list of [context.pending, context.active, context.recent]) {
        for (const item of list) if (!dismissed.has(item.sessionId)) sessionIds.add(item.sessionId)
    }
    return { sessionIds, lineIds: new Set(context.lines.map(line => line.id)) }
}
