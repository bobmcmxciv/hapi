/**
 * 语音问答的材料：把一个会话的现状压成一段给小模型看的中文文本。
 *
 * 来源按可信度排：会话实时状态（是否在跑、待审批、代理自己的待办清单）> 摘要库里的
 * 现状/已完成/待办 > 摘要之后新出现的对话原文 > 最近的工具调用。全部只读，不写会话。
 */

import {
    extractTranscriptLine,
    renderTranscript,
    type TranscriptLine,
    type TranscriptMessage
} from '../session-digest/transcript'

export type VoiceSessionView = {
    id: string
    active?: boolean
    thinking?: boolean
    activeTurnStartedAt?: number | null
    updatedAt?: number
    model?: string | null
    backgroundTaskCount?: number
    metadata: {
        name?: string
        path?: string
        host?: string
        flavor?: string | null
        summary?: { text?: string } | null
    } | null
    agentState?: {
        requests?: Record<string, { tool?: string; arguments?: unknown; createdAt?: number | null }> | null
    } | null
    todos?: Array<{ content: string; status: string; activeForm?: string }>
}

export type VoiceDigestView = {
    title: string
    status: string
    done: string[]
    todo: string[]
    generatedAt: number | null
    sourceSeq: number
}

export type VoiceProjectView = {
    overview: string
    stage: string
    status: string
    todo: string[]
}

const TRANSCRIPT_BUDGET_WITH_DIGEST = 9_000
const TRANSCRIPT_BUDGET_NO_DIGEST = 14_000
const TOOL_ACTIVITY_LIMIT = 8

function asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
}

function short(text: string, max: number): string {
    const oneLine = text.replace(/\s+/g, ' ').trim()
    return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine
}

/** 最近的工具调用，一行一个："Bash：跑单元测试"。只认 Claude 的 tool_use 块。 */
export function recentToolActivity(messages: TranscriptMessage[], limit = TOOL_ACTIVITY_LIMIT): string[] {
    const lines: string[] = []
    for (let index = messages.length - 1; index >= 0 && lines.length < limit; index -= 1) {
        const envelope = asRecord(messages[index]!.content)
        if (envelope?.role !== 'agent') continue
        const record = asRecord(envelope.content)
        const data = asRecord(record?.data)
        if (record?.type !== 'output' || data?.type !== 'assistant') continue
        const blocks = asRecord(data.message)?.content
        if (!Array.isArray(blocks)) continue
        for (let blockIndex = blocks.length - 1; blockIndex >= 0 && lines.length < limit; blockIndex -= 1) {
            const tool = asRecord(blocks[blockIndex])
            if (tool?.type !== 'tool_use' || typeof tool.name !== 'string') continue
            const input = asRecord(tool.input) ?? {}
            const detail = [input.description, input.file_path, input.command, input.pattern, input.prompt]
                .find((value): value is string => typeof value === 'string' && value.trim().length > 0)
            lines.push(detail ? `${tool.name}：${short(detail, 90)}` : tool.name)
        }
    }
    return lines.reverse()
}

function minutesAgo(now: number, at: number | null | undefined): string {
    if (!at) return '时间未知'
    const minutes = Math.max(0, Math.round((now - at) / 60_000))
    if (minutes < 1) return '刚刚'
    if (minutes < 60) return `${minutes} 分钟前`
    const hours = Math.round(minutes / 60)
    return hours < 48 ? `${hours} 小时前` : `${Math.round(hours / 24)} 天前`
}

function stateLine(session: VoiceSessionView, now: number): string {
    if (session.active === false) return '会话已停止（没有在运行的代理进程）。'
    if (session.thinking) {
        const since = session.activeTurnStartedAt ? `，这一轮已经跑了 ${minutesAgo(now, session.activeTurnStartedAt).replace('前', '')}` : ''
        return `代理正在工作${since}。`
    }
    return '代理当前空闲，在等用户的下一条消息。'
}

function pendingRequests(session: VoiceSessionView): string[] {
    const requests = session.agentState?.requests ?? {}
    return Object.values(requests).map((request) => {
        const args = asRecord(request.arguments)
        const detail = args
            ? [args.description, args.command, args.file_path, args.question]
                .find((value): value is string => typeof value === 'string' && value.trim().length > 0)
            : undefined
        return detail ? `${request.tool ?? '未知工具'}：${short(detail, 120)}` : (request.tool ?? '未知工具')
    })
}

export function buildSessionMaterial(params: {
    session: VoiceSessionView
    digest: VoiceDigestView | null
    project: VoiceProjectView | null
    messages: TranscriptMessage[]
    now: number
}): string {
    const { session, digest, project, messages, now } = params
    const meta = session.metadata
    const parts: string[] = []

    const name = meta?.name?.trim() || digest?.title || meta?.summary?.text?.trim() || '未命名会话'
    const header = [`会话：${name}`]
    if (meta?.path) header.push(`目录：${meta.path}`)
    if (meta?.host) header.push(`机器：${meta.host}`)
    if (meta?.flavor) header.push(`代理：${meta.flavor}${session.model ? `（${session.model}）` : ''}`)
    header.push(`最后活动：${minutesAgo(now, session.updatedAt)}`)
    parts.push(header.join('\n'))

    const state = [stateLine(session, now)]
    const pending = pendingRequests(session)
    if (pending.length > 0) state.push(`正在等用户批准：${pending.join('；')}`)
    if (session.backgroundTaskCount) state.push(`后台任务 ${session.backgroundTaskCount} 个。`)
    parts.push(`# 实时状态\n${state.join('\n')}`)

    const todos = session.todos ?? []
    if (todos.length > 0) {
        const label: Record<string, string> = { completed: '已完成', in_progress: '进行中', pending: '未开始' }
        parts.push(`# 代理自己的待办清单\n${todos.map((todo) => `- [${label[todo.status] ?? todo.status}] ${short(todo.content, 120)}`).join('\n')}`)
    }

    if (digest) {
        const lines = [`（摘要生成于 ${minutesAgo(now, digest.generatedAt)}，之后的变化看下面的新消息）`, `现状：${digest.status || '无'}`]
        if (digest.done.length > 0) lines.push(`已完成：${digest.done.join('；')}`)
        if (digest.todo.length > 0) lines.push(`待办：${digest.todo.join('；')}`)
        parts.push(`# 会话摘要\n${lines.join('\n')}`)
    }

    if (project && (project.status || project.overview)) {
        const lines = [project.overview && `概况：${project.overview}`, project.stage && `阶段：${project.stage}`, project.status && `现状：${project.status}`]
            .filter(Boolean)
        if (project.todo.length > 0) lines.push(`待办：${project.todo.slice(0, 6).join('；')}`)
        parts.push(`# 所属项目\n${lines.join('\n')}`)
    }

    const sinceSeq = digest?.sourceSeq ?? 0
    const lines: TranscriptLine[] = messages
        .filter((message) => message.seq > sinceSeq)
        .map(extractTranscriptLine)
        .filter((line): line is TranscriptLine => line !== null)
    if (lines.length > 0) {
        const budget = digest ? TRANSCRIPT_BUDGET_WITH_DIGEST : TRANSCRIPT_BUDGET_NO_DIGEST
        parts.push(`# ${digest ? '摘要之后的新对话' : '最近的对话'}\n${renderTranscript(lines, budget)}`)
    } else if (digest) {
        parts.push('# 摘要之后的新对话\n（没有新对话）')
    }

    const tools = recentToolActivity(messages)
    if (tools.length > 0) parts.push(`# 最近的工具调用（旧→新）\n${tools.join('\n')}`)

    return parts.join('\n\n')
}

/** 选目标会话时给模型看的一行：短 id、名字、现状。 */
export function describeSessionForTargeting(session: VoiceSessionView, digest: VoiceDigestView | null): string {
    const name = session.metadata?.name?.trim() || digest?.title || session.metadata?.summary?.text?.trim() || '未命名'
    const folder = session.metadata?.path?.split(/[\\/]/).filter(Boolean).pop()
    const status = digest?.status ? `｜现状：${short(digest.status, 80)}` : ''
    const todo = digest?.todo.length ? `｜待办：${short(digest.todo.join('；'), 80)}` : ''
    return `[${session.id.slice(0, 8)}] ${name}${folder ? `（${folder}）` : ''}${status}${todo}`
}
