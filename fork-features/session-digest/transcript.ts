/**
 * 把会话消息压成给模型看的纯文本转录，并定义提示词与输出解析。
 *
 * 只取人能读的部分：用户输入、助手的文字回复（Claude 的 text 块、Codex 的
 * message）。工具调用/结果、思考、用量帧一律跳过——它们占了消息体积的绝大部分，
 * 对"做了什么、现在怎样、还剩什么"几乎没有增量信息。
 */

export type TranscriptMessage = { seq: number; content: unknown }

export type TranscriptLine = { seq: number; role: 'user' | 'assistant'; text: string }

const MAX_LINE_CHARS = 1500

function asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
}

function textFromBlocks(content: unknown): string {
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
        return content
            .map((block) => {
                const record = asRecord(block)
                return record?.type === 'text' && typeof record.text === 'string' ? record.text : ''
            })
            .filter(Boolean)
            .join('\n')
    }
    const record = asRecord(content)
    if (record?.type === 'text' && typeof record.text === 'string') return record.text
    return ''
}

/** 网关注入的记忆块、系统提醒等尖括号包裹的段落不是用户本人的话，去掉。 */
function stripInjectedBlocks(text: string): string {
    return text
        .replace(/<([a-z_][a-z0-9_-]*)(\s[^>]*)?>[\s\S]*?<\/\1>/gi, ' ')
        .replace(/\s+\n/g, '\n')
        .trim()
}

function clip(text: string, max: number): string {
    const normalized = text.replace(/\n{3,}/g, '\n\n').trim()
    return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized
}

export function extractTranscriptLine(message: TranscriptMessage): TranscriptLine | null {
    const envelope = asRecord(message.content)
    if (!envelope) return null
    const role = envelope.role
    const inner = envelope.content

    if (role === 'user') {
        const text = stripInjectedBlocks(textFromBlocks(inner))
        return text ? { seq: message.seq, role: 'user', text: clip(text, MAX_LINE_CHARS) } : null
    }

    if (role !== 'agent') return null
    const record = asRecord(inner)
    if (!record) return null
    const data = asRecord(record.data)
    if (!data) return null

    if (record.type === 'output' && data.type === 'assistant') {
        const text = textFromBlocks(asRecord(data.message)?.content).trim()
        return text ? { seq: message.seq, role: 'assistant', text: clip(text, MAX_LINE_CHARS) } : null
    }
    if (record.type === 'codex' && data.type === 'message' && typeof data.message === 'string') {
        const text = data.message.trim()
        return text ? { seq: message.seq, role: 'assistant', text: clip(text, MAX_LINE_CHARS) } : null
    }
    return null
}

/**
 * 按字数预算挑行：开头保留少量（任务的原始意图常在第一条消息里），其余预算
 * 全部给结尾（现状与待办只看最近）。中间被省略时插一行说明。
 */
export function renderTranscript(lines: TranscriptLine[], budgetChars: number): string {
    const render = (line: TranscriptLine) => `${line.role === 'user' ? '用户' : '助手'}：${line.text}`
    const rendered = lines.map(render)
    const total = rendered.reduce((sum, text) => sum + text.length + 1, 0)
    if (total <= budgetChars) return rendered.join('\n')

    const headBudget = Math.floor(budgetChars * 0.2)
    const head: string[] = []
    let used = 0
    let headEnd = 0
    for (; headEnd < rendered.length; headEnd += 1) {
        const text = rendered[headEnd]!
        if (used + text.length + 1 > headBudget) break
        head.push(text)
        used += text.length + 1
    }
    const tail: string[] = []
    let tailUsed = 0
    for (let index = rendered.length - 1; index >= headEnd; index -= 1) {
        const text = rendered[index]!
        if (tailUsed + text.length + 1 > budgetChars - used) break
        tail.unshift(text)
        tailUsed += text.length + 1
    }
    const omitted = rendered.length - head.length - tail.length
    return [...head, `……（中间省略 ${omitted} 条消息）……`, ...tail].join('\n')
}

export const SESSION_SYSTEM_PROMPT = [
    '你是软件工程会话的记录员。阅读一段人与编码智能体的对话转录，用简体中文输出严格的 JSON，不要输出任何其他文字。',
    'JSON 结构：{"title": string, "done": string[], "status": string, "todo": string[], "suggestComplete": boolean}',
    '- title：不超过 20 个字，概括这个会话在做的事，像任务名，不要加引号或句号。',
    '- done：已经完成的具体事项，最多 6 条，每条不超过 40 字，按时间先后。',
    '- status：当前现状，一两句话，不超过 80 字。',
    '- todo：还没办完、下一步要做的事，最多 5 条，每条不超过 40 字；确实没有就给空数组。',
    '- suggestComplete：用户的诉求已经全部办完、没有遗留事项时为 true，否则 false。',
    '只依据转录内容，不要编造。'
].join('\n')

export const PROJECT_SYSTEM_PROMPT = [
    '你是软件项目的记录员。下面是同一个项目目录下各个会话的摘要，请综合成项目概况，用简体中文输出严格的 JSON，不要输出任何其他文字。',
    'JSON 结构：{"capabilities": string[], "status": string, "todo": string[]}',
    '- capabilities：这个项目目前能做哪些事（功能/能力，而不是工作流水），最多 6 条，每条不超过 40 字。',
    '- status：项目当前整体现状，不超过 80 字。',
    '- todo：项目层面还没办完的事，最多 5 条，每条不超过 40 字；没有就给空数组。',
    '篇幅要短，但要准确体现项目能做什么。只依据给出的摘要，不要编造。'
].join('\n')

export function buildSessionPrompt(params: {
    path: string | null
    transcript: string
    previous: { title: string; done: string[]; status: string; todo: string[] } | null
    /** 手动重新总结：转录是开头 + 最近的整段对话，旧摘要只作参考。 */
    rewrite?: boolean
}): string {
    const parts: string[] = []
    if (params.path) parts.push(`工作目录：${params.path}`)
    if (params.previous && params.rewrite) {
        parts.push('此前的摘要（仅供参考，可能已过时；请以下面的对话为准重新总结，仍然成立的已完成事项保留）：')
        parts.push(JSON.stringify(params.previous))
        parts.push('对话转录（开头与最近部分）：')
    } else if (params.previous) {
        parts.push('此前的摘要（在此基础上更新，已完成事项保留）：')
        parts.push(JSON.stringify(params.previous))
        parts.push('之后新增的对话：')
    } else {
        parts.push('对话转录：')
    }
    parts.push(params.transcript)
    return parts.join('\n')
}

export function buildProjectPrompt(params: {
    path: string
    sessions: Array<{ title: string; done: string[]; status: string; todo: string[]; completed: boolean; updatedAt: number }>
}, budgetChars: number): string {
    const lines: string[] = [`项目目录：${params.path}`, '会话摘要（新的在前）：']
    let used = 0
    for (const session of [...params.sessions].sort((a, b) => b.updatedAt - a.updatedAt)) {
        const entry = JSON.stringify({
            title: session.title,
            done: session.done,
            status: session.status,
            todo: session.completed ? [] : session.todo,
            completed: session.completed
        })
        if (used + entry.length > budgetChars) break
        lines.push(entry)
        used += entry.length
    }
    return lines.join('\n')
}

function extractJsonObject(text: string): Record<string, unknown> | null {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start < 0 || end <= start) return null
    try {
        return asRecord(JSON.parse(text.slice(start, end + 1)))
    } catch {
        return null
    }
}

function stringList(value: unknown, max: number): string[] {
    if (!Array.isArray(value)) return []
    return value
        .filter((item): item is string => typeof item === 'string')
        .map(item => item.trim())
        .filter(Boolean)
        .slice(0, max)
}

export type ParsedSessionDigest = { title: string; done: string[]; status: string; todo: string[]; suggestComplete: boolean }
export type ParsedProjectDigest = { capabilities: string[]; status: string; todo: string[] }

export function parseSessionDigest(text: string): ParsedSessionDigest | null {
    const record = extractJsonObject(text)
    if (!record) return null
    const title = typeof record.title === 'string' ? record.title.trim().replace(/^["“「]|["”」。]$/g, '').slice(0, 40) : ''
    const status = typeof record.status === 'string' ? record.status.trim() : ''
    if (!title && !status) return null
    return {
        title,
        done: stringList(record.done, 8),
        status,
        todo: stringList(record.todo, 6),
        suggestComplete: record.suggestComplete === true
    }
}

export function parseProjectDigest(text: string): ParsedProjectDigest | null {
    const record = extractJsonObject(text)
    if (!record) return null
    const capabilities = stringList(record.capabilities, 8)
    const status = typeof record.status === 'string' ? record.status.trim() : ''
    if (capabilities.length === 0 && !status) return null
    return { capabilities, status, todo: stringList(record.todo, 6) }
}

/** 会话产物：写/改过的文件、git 提交说明、send_file 发出的文件。从工具调用里抽，
 *  不依赖任何机器在线。 */
export type SessionArtifacts = { files: string[]; commits: string[] }

const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'mcp__hapi__send_file'])

function commitMessageOf(command: string): string | null {
    if (!/\bgit\b[^\n]*\bcommit\b/.test(command)) return null
    const heredoc = command.match(/<<\s*'?(\w+)'?\s*\n([\s\S]*?)\n\1/)
    if (heredoc) return heredoc[2]!.split('\n')[0]!.trim() || null
    const quoted = command.match(/-m\s+(?:"([^"]+)"|'([^']+)')/)
    if (quoted) return (quoted[1] ?? quoted[2] ?? '').split('\n')[0]!.trim() || null
    return null
}

export function extractArtifacts(messages: TranscriptMessage[]): SessionArtifacts {
    const files: string[] = []
    const commits: string[] = []
    for (const message of messages) {
        const envelope = asRecord(message.content)
        if (envelope?.role !== 'agent') continue
        const record = asRecord(envelope.content)
        const data = asRecord(record?.data)
        if (record?.type !== 'output' || data?.type !== 'assistant') continue
        const blocks = asRecord(data.message)?.content
        if (!Array.isArray(blocks)) continue
        for (const block of blocks) {
            const tool = asRecord(block)
            if (tool?.type !== 'tool_use' || typeof tool.name !== 'string') continue
            const input = asRecord(tool.input)
            if (!input) continue
            if (FILE_TOOLS.has(tool.name)) {
                const path = input.file_path ?? input.notebook_path ?? input.path
                if (typeof path === 'string' && path.trim()) files.push(path.trim())
            } else if ((tool.name === 'Bash' || tool.name === 'PowerShell') && typeof input.command === 'string') {
                const commit = commitMessageOf(input.command)
                if (commit) commits.push(commit.slice(0, 160))
            }
        }
    }
    return { files, commits }
}

/** 合并新旧产物：文件按出现次数排序去重，提交保留最近的。 */
export function mergeArtifacts(previous: SessionArtifacts | null, next: SessionArtifacts, limits = { files: 40, commits: 20 }): SessionArtifacts {
    const counts = new Map<string, number>()
    for (const file of [...(previous?.files ?? []), ...next.files]) counts.set(file, (counts.get(file) ?? 0) + 1)
    const files = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([file]) => file).slice(0, limits.files)
    const commits = [...new Set([...(previous?.commits ?? []), ...next.commits])].slice(-limits.commits)
    return { files, commits }
}

export const PROJECT_SYSTEM_PROMPT_V2 = [
    '你是软件项目的评估员。下面给出一个项目目录的材料：目录结构、说明文件节选（如有）、各会话的摘要与时间线、会话里改动过的文件与 git 提交。请综合判断这个项目的总体情况和所处阶段，用简体中文输出严格的 JSON，不要输出任何其他文字。',
    'JSON 结构：{"overview": string, "stage": string, "stageReason": string, "capabilities": string[], "artifacts": string[], "status": string, "todo": string[], "judgement": string}',
    '- overview：项目是什么、为谁解决什么问题，不超过 120 字。',
    '- stage：从「构思」「原型」「开发中」「试运行」「已上线」「维护中」「停滞」「已完成」中选一个。',
    '- stageReason：判断阶段的依据（引用材料里的事实），不超过 80 字。',
    '- capabilities：项目目前已经能做的事（功能/能力，不是工作流水），最多 6 条，每条不超过 40 字。',
    '- artifacts：主要产物（代码模块、服务、文档、数据、部署物等），最多 6 条，每条不超过 40 字。',
    '- status：当前现状，不超过 80 字。',
    '- todo：还没办完的事，最多 5 条，每条不超过 40 字；没有就给空数组。',
    '- judgement：基于以上对项目下一步的判断或建议，不超过 80 字。',
    '只依据给出的材料，不要编造；材料不足时如实说明。'
].join('\n')

export type ParsedProjectDigestV2 = ParsedProjectDigest & {
    overview: string
    stage: string
    stageReason: string
    artifacts: string[]
    judgement: string
}

export function parseProjectDigestV2(text: string): ParsedProjectDigestV2 | null {
    const record = extractJsonObject(text)
    if (!record) return null
    const str = (value: unknown) => (typeof value === 'string' ? value.trim() : '')
    const result: ParsedProjectDigestV2 = {
        overview: str(record.overview),
        stage: str(record.stage).slice(0, 12),
        stageReason: str(record.stageReason),
        capabilities: stringList(record.capabilities, 8),
        artifacts: stringList(record.artifacts, 8),
        status: str(record.status),
        todo: stringList(record.todo, 6),
        judgement: str(record.judgement)
    }
    if (!result.overview && result.capabilities.length === 0 && !result.status) return null
    return result
}

export function buildProjectPromptV2(params: {
    path: string
    listing: string[] | null
    readme: { name: string; text: string } | null
    sessions: Array<{ title: string; createdAt: number; updatedAt: number; completed: boolean; done: string[]; status: string; todo: string[]; summarized: boolean }>
    files: Array<{ path: string; count: number }>
    commits: string[]
}, budgetChars: number): string {
    const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)
    const parts: string[] = [`项目目录：${params.path}`]
    const sessions = [...params.sessions].sort((a, b) => b.updatedAt - a.updatedAt)
    if (sessions.length > 0) {
        const first = Math.min(...sessions.map(s => s.createdAt))
        const last = Math.max(...sessions.map(s => s.updatedAt))
        parts.push(`时间线：共 ${sessions.length} 个会话（已完结 ${sessions.filter(s => s.completed).length} 个），最早 ${day(first)}，最近活动 ${day(last)}`)
    }
    parts.push(params.listing ? `目录结构（顶层）：${params.listing.join('，')}` : '目录结构：不可读（机器离线或未开放浏览）')
    if (params.readme) parts.push(`${params.readme.name} 节选：\n${params.readme.text}`)
    if (params.files.length > 0) parts.push(`会话里改动最多的文件：${params.files.map(f => `${f.path}(${f.count})`).join('，')}`)
    if (params.commits.length > 0) parts.push(`git 提交说明（最近）：\n${params.commits.map(c => `- ${c}`).join('\n')}`)
    parts.push('会话（新的在前）：')
    let used = parts.reduce((sum, part) => sum + part.length, 0)
    for (const session of sessions) {
        const entry = session.summarized
            ? JSON.stringify({ title: session.title, date: day(session.updatedAt), done: session.done, status: session.status, todo: session.completed ? [] : session.todo, completed: session.completed })
            : JSON.stringify({ title: session.title, date: day(session.updatedAt) })
        if (used + entry.length > budgetChars) break
        parts.push(entry)
        used += entry.length
    }
    return parts.join('\n')
}
