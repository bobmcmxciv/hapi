import { isAskUserQuestionToolName, parseAskUserQuestionInput, type AskUserQuestionQuestion } from '@/components/ToolCard/askUserQuestion'

/** 处理卡片里展示的一条消息（只取文字，工具调用 / 结果不展示）。 */
export type CardLine = { seq: number; role: 'user' | 'assistant'; text: string; at: number | null }

/** 卡片里的一条待处理请求：审批（批准/拒绝）或提问（选项）。 */
export type CardRequest =
    | { id: string; kind: 'question'; tool: string; questions: AskUserQuestionQuestion[]; createdAt: number | null }
    | { id: string; kind: 'permission'; tool: string; summary: string; createdAt: number | null }

const INJECTED = /<(hapi_user_context|system-reminder|local-command-caveat|command-name|command-message|command-args)[^>]*>[\s\S]*?<\/\1>/g
const MAX_LINE = 1200

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function textFromBlocks(value: unknown): string {
    if (typeof value === 'string') return value
    const record = asRecord(value)
    if (record && record.type === 'text' && typeof record.text === 'string') return record.text
    if (!Array.isArray(value)) return ''
    return value.map(block => {
        const b = asRecord(block)
        return b && b.type === 'text' && typeof b.text === 'string' ? b.text : ''
    }).filter(Boolean).join('\n')
}

function clip(text: string): string {
    return text.length > MAX_LINE ? `${text.slice(0, MAX_LINE - 1)}…` : text
}

/** 与 hub session-digest/transcript.ts 的 extractTranscriptLine 同一口径。 */
export function cardLineOf(message: { seq: number; content: unknown; createdAt?: number | null }): CardLine | null {
    const envelope = asRecord(message.content)
    if (!envelope) return null
    const at = typeof message.createdAt === 'number' ? message.createdAt : null
    if (envelope.role === 'user') {
        const text = textFromBlocks(envelope.content).replace(INJECTED, '').trim()
        return text ? { seq: message.seq, role: 'user', text: clip(text), at } : null
    }
    if (envelope.role !== 'agent') return null
    const record = asRecord(envelope.content)
    const data = asRecord(record?.data)
    if (!record || !data) return null
    if (record.type === 'output' && data.type === 'assistant') {
        const text = textFromBlocks(asRecord(data.message)?.content).trim()
        return text ? { seq: message.seq, role: 'assistant', text: clip(text), at } : null
    }
    if (record.type === 'codex' && data.type === 'message' && typeof data.message === 'string') {
        const text = data.message.trim()
        return text ? { seq: message.seq, role: 'assistant', text: clip(text), at } : null
    }
    return null
}

/** 取最近的若干条文字消息（按 seq 升序返回）。 */
export function latestCardLines(messages: Array<{ seq: number; content: unknown; createdAt?: number | null }>, limit = 6): CardLine[] {
    const lines = messages.map(cardLineOf).filter((line): line is CardLine => line !== null)
    lines.sort((a, b) => a.seq - b.seq)
    return lines.slice(-limit)
}

/** 审批请求的一句话说明：命令、文件路径或参数摘要。 */
export function summarizeRequestArguments(tool: string, args: unknown): string {
    const record = asRecord(args)
    if (!record) return typeof args === 'string' ? args.slice(0, 300) : ''
    for (const key of ['command', 'cmd', 'file_path', 'path', 'url', 'pattern', 'description', 'plan', 'prompt']) {
        const value = record[key]
        if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 300)
        if (Array.isArray(value) && value.every(item => typeof item === 'string')) return value.join(' ').slice(0, 300)
    }
    const json = JSON.stringify(record)
    return json.length > 300 ? `${json.slice(0, 299)}…` : json
}

export function cardRequestsOf(requests: Record<string, { tool: string; arguments: unknown; createdAt?: number | null }> | null | undefined): CardRequest[] {
    const out: CardRequest[] = []
    for (const [id, request] of Object.entries(requests ?? {})) {
        const createdAt = request.createdAt ?? null
        if (isAskUserQuestionToolName(request.tool)) {
            out.push({ id, kind: 'question', tool: request.tool, questions: parseAskUserQuestionInput(request.arguments).questions, createdAt })
        } else {
            out.push({ id, kind: 'permission', tool: request.tool, summary: summarizeRequestArguments(request.tool, request.arguments), createdAt })
        }
    }
    return out.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
}

/** 问题答案的提交格式与会话页 AskUserQuestionFooter 一致：按题目序号为键，值是选中选项的 label。 */
export function questionAnswers(questions: AskUserQuestionQuestion[], selected: number[][], other: string[]): Record<string, string[]> | null {
    const answers: Record<string, string[]> = {}
    for (let i = 0; i < questions.length; i += 1) {
        const question = questions[i]!
        const picked = (selected[i] ?? []).map(index => question.options[index]?.label.trim()).filter((label): label is string => Boolean(label))
        const extra = (other[i] ?? '').trim()
        if (extra) picked.push(extra)
        if (picked.length === 0) return null
        answers[String(i)] = picked
    }
    return answers
}
