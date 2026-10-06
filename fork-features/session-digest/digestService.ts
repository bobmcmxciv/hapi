import { join } from 'node:path'
import {
    DigestStore,
    emptyProjectDigest,
    emptySessionDigest,
    type DigestSettings,
    type ProjectDigest,
    type SessionDigest
} from './digestStore'
import { createLlmCall, listLlmModels, type LlmCall, type LlmConfig } from './llmClient'
import {
    PROJECT_SYSTEM_PROMPT,
    SESSION_SYSTEM_PROMPT,
    buildProjectPrompt,
    buildSessionPrompt,
    extractTranscriptLine,
    parseProjectDigest,
    parseSessionDigest,
    renderTranscript,
    type TranscriptLine,
    type TranscriptMessage
} from './transcript'

/** 调度器眼里的会话：只用到这几个字段，便于测试注入。 */
export type DigestSessionView = {
    id: string
    updatedAt: number
    thinking: boolean
    metadata: {
        name?: string
        path?: string
        machineId?: string
        worktree?: { basePath?: string } | null
    } | null
}

export type DigestDeps = {
    store: DigestStore
    getSessions: () => DigestSessionView[]
    getSession: (sessionId: string) => DigestSessionView | undefined
    /** 最新的 N 条消息（升序）。 */
    getRecentMessages: (sessionId: string, limit: number) => TranscriptMessage[]
    getFirstMessages: (sessionId: string, limit: number) => TranscriptMessage[]
    renameSession: (sessionId: string, name: string) => Promise<void>
    llm: LlmCall | null
    defaults: DigestSettings
    now?: () => number
}

export const UNKNOWN_MACHINE_ID = '__unknown__'
/** 最后一条活动后至少静默这么久才总结，避免对正在跑的会话反复花 token。 */
export const IDLE_MS = 3 * 60_000
/** 项目摘要在会话摘要变化后至少隔这么久才重算，把一阵连续更新合并成一次。 */
export const PROJECT_DEBOUNCE_MS = 15 * 60_000
const ERROR_BACKOFF_MS = 30 * 60_000
const RECENT_MESSAGES = 600
const FIRST_MESSAGES = 40
const SESSION_BUDGET_CHARS = 40_000
const PROJECT_BUDGET_CHARS = 24_000

export function projectKeyOf(session: DigestSessionView): { key: string; machineId: string | null; path: string } {
    const path = session.metadata?.worktree?.basePath ?? session.metadata?.path ?? 'Other'
    const machineId = session.metadata?.machineId ?? null
    return { key: `${machineId ?? UNKNOWN_MACHINE_ID}::${path}`, machineId, path }
}

function inBackoff(entry: { error: string | null; errorCount: number; lastAttemptAt: number | null }, now: number): boolean {
    if (!entry.error || entry.lastAttemptAt === null) return false
    return now - entry.lastAttemptAt < ERROR_BACKOFF_MS * Math.min(Math.max(entry.errorCount, 1), 8)
}

export type DigestStatus = {
    configured: boolean
    settings: DigestSettings
    running: string | null
    runsLastHour: number
    pendingSessions: number
    digestedSessions: number
    projects: number
    lastRunAt: number | null
    lastError: string | null
}

export class DigestService {
    private readonly deps: DigestDeps
    private readonly now: () => number
    private timer: ReturnType<typeof setInterval> | null = null
    private running: string | null = null
    private lastRunAt: number | null = null
    private lastError: string | null = null
    private readonly forcedSessions = new Set<string>()
    private readonly forcedProjects = new Set<string>()

    constructor(deps: DigestDeps) {
        this.deps = deps
        this.now = deps.now ?? Date.now
    }

    get store(): DigestStore {
        return this.deps.store
    }

    settings(): DigestSettings {
        return this.deps.store.getSettings(this.deps.defaults)
    }

    updateSettings(patch: Partial<DigestSettings>): DigestSettings {
        const next = { ...this.settings(), ...patch }
        next.maxPerHour = Math.min(600, Math.max(1, Math.floor(next.maxPerHour)))
        this.deps.store.saveSettings(next)
        this.kick()
        return next
    }

    start(intervalMs = 30_000): void {
        if (this.timer) return
        this.timer = setInterval(() => { void this.tick() }, intervalMs)
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer)
        this.timer = null
    }

    /** 手动"重新总结"：跳过空闲/限速判定，下一拍优先处理。 */
    requestSession(sessionId: string): void {
        this.forcedSessions.add(sessionId)
        this.kick()
    }

    requestProject(projectKey: string): void {
        this.forcedProjects.add(projectKey)
        this.kick()
    }

    setCompleted(sessionId: string, completed: boolean): SessionDigest {
        const digest = this.deps.store.getSession(sessionId) ?? emptySessionDigest(sessionId)
        const next = { ...digest, completed, completedAt: completed ? this.now() : null }
        this.deps.store.saveSession(next)
        return next
    }

    private kick(): void {
        setTimeout(() => { void this.tick() }, 0)
    }

    status(): DigestStatus {
        const digests = new Map(this.deps.store.listSessions().map(d => [d.sessionId, d]))
        let pending = 0
        for (const session of this.deps.getSessions()) {
            const digest = digests.get(session.id)
            if (!digest || digest.sourceUpdatedAt < session.updatedAt) pending += 1
        }
        return {
            configured: this.deps.llm !== null,
            settings: this.settings(),
            running: this.running,
            runsLastHour: this.deps.store.countRunsSince(this.now() - 3600_000),
            pendingSessions: pending,
            digestedSessions: [...digests.values()].filter(d => d.generatedAt !== null).length,
            projects: this.deps.store.listProjects().length,
            lastRunAt: this.lastRunAt,
            lastError: this.lastError
        }
    }

    /** 跑一步：至多处理一个会话或一个项目。返回处理了什么，便于测试。 */
    async tick(): Promise<string | null> {
        if (this.running || !this.deps.llm) return null
        const settings = this.settings()
        const forced = this.takeForced()
        if (!forced) {
            if (!settings.enabled) return null
            if (this.deps.store.countRunsSince(this.now() - 3600_000) >= settings.maxPerHour) return null
        }
        const job = forced ?? this.pickSessionJob() ?? this.pickProjectJob()
        if (!job) return null

        this.running = job.label
        try {
            const didCallModel = job.kind === 'session'
                ? await this.runSession(job.session, settings)
                : await this.runProject(job.key, settings)
            if (didCallModel) {
                this.deps.store.recordRun(this.now())
                this.lastRunAt = this.now()
            }
            return job.label
        } finally {
            this.running = null
        }
    }

    private takeForced(): Job | null {
        for (const sessionId of this.forcedSessions) {
            this.forcedSessions.delete(sessionId)
            const session = this.deps.getSession(sessionId)
            if (session) return { kind: 'session', session, label: `session:${sessionId}` }
        }
        for (const key of this.forcedProjects) {
            this.forcedProjects.delete(key)
            return { kind: 'project', key, label: `project:${key}` }
        }
        return null
    }

    private pickSessionJob(): Job | null {
        const now = this.now()
        const digests = new Map(this.deps.store.listSessions().map(d => [d.sessionId, d]))
        const sessions = [...this.deps.getSessions()].sort((a, b) => b.updatedAt - a.updatedAt)
        let probes = 0
        for (const session of sessions) {
            if (session.thinking || now - session.updatedAt < IDLE_MS) continue
            const digest = digests.get(session.id)
            if (digest && digest.sourceUpdatedAt >= session.updatedAt) continue
            if (digest && inBackoff(digest, now)) continue
            // 只在真要动手前才查 max(seq)：updatedAt 变了但没有新消息（改名、
            // 元数据刷新）就只推进水位，不花 token。
            if (probes >= 50) break
            probes += 1
            const newest = this.deps.getRecentMessages(session.id, 1)[0]?.seq ?? 0
            if (newest === 0 || (digest && newest <= digest.sourceSeq)) {
                this.deps.store.saveSession({
                    ...(digest ?? emptySessionDigest(session.id)),
                    sourceUpdatedAt: session.updatedAt,
                    sourceSeq: Math.max(digest?.sourceSeq ?? 0, newest)
                })
                continue
            }
            return { kind: 'session', session, label: `session:${session.id}` }
        }
        return null
    }

    private pickProjectJob(): Job | null {
        const now = this.now()
        const digests = new Map(this.deps.store.listSessions().map(d => [d.sessionId, d]))
        const stampByProject = new Map<string, number>()
        for (const session of this.deps.getSessions()) {
            const generatedAt = digests.get(session.id)?.generatedAt
            if (!generatedAt) continue
            const { key } = projectKeyOf(session)
            stampByProject.set(key, Math.max(stampByProject.get(key) ?? 0, generatedAt))
        }
        const candidates = [...stampByProject.entries()].sort((a, b) => b[1] - a[1])
        for (const [key, stamp] of candidates) {
            const project = this.deps.store.getProject(key)
            if (project && project.sourceStamp >= stamp) continue
            if (project?.generatedAt && now - project.generatedAt < PROJECT_DEBOUNCE_MS) continue
            if (project && inBackoff(project, now)) continue
            return { kind: 'project', key, label: `project:${key}` }
        }
        return null
    }

    private collectLines(sessionId: string, afterSeq: number): TranscriptLine[] {
        const bySeq = new Map<number, TranscriptMessage>()
        if (afterSeq === 0) {
            for (const message of this.deps.getFirstMessages(sessionId, FIRST_MESSAGES)) bySeq.set(message.seq, message)
        }
        for (const message of this.deps.getRecentMessages(sessionId, RECENT_MESSAGES)) {
            if (message.seq > afterSeq) bySeq.set(message.seq, message)
        }
        return [...bySeq.values()]
            .sort((a, b) => a.seq - b.seq)
            .map(extractTranscriptLine)
            .filter((line): line is TranscriptLine => line !== null)
    }

    /** 返回是否真的调用了模型（计入限速）。 */
    async runSession(session: DigestSessionView, settings: DigestSettings): Promise<boolean> {
        const now = this.now()
        const existing = this.deps.store.getSession(session.id) ?? emptySessionDigest(session.id)
        const newest = this.deps.getRecentMessages(session.id, 1)[0]?.seq ?? 0
        const previous = existing.generatedAt
            ? { title: existing.title, done: existing.done, status: existing.status, todo: existing.todo }
            : null
        const afterSeq = previous ? existing.sourceSeq : 0
        const lines = this.collectLines(session.id, afterSeq)
        if (lines.length === 0) {
            this.deps.store.saveSession({ ...existing, sourceSeq: Math.max(existing.sourceSeq, newest), sourceUpdatedAt: session.updatedAt })
            return false
        }

        const prompt = buildSessionPrompt({
            path: session.metadata?.path ?? null,
            transcript: renderTranscript(lines, SESSION_BUDGET_CHARS),
            previous
        })
        try {
            const text = await this.deps.llm!({ model: settings.model, system: SESSION_SYSTEM_PROMPT, prompt, maxTokens: 1500 })
            const parsed = parseSessionDigest(text)
            if (!parsed) throw new Error(`unparseable digest: ${text.slice(0, 120)}`)
            const next: SessionDigest = {
                ...existing,
                ...parsed,
                title: parsed.title || existing.title,
                sourceSeq: Math.max(newest, lines[lines.length - 1]!.seq),
                sourceUpdatedAt: session.updatedAt,
                model: settings.model,
                generatedAt: now,
                error: null,
                errorCount: 0,
                lastAttemptAt: now
            }
            if (settings.autoRename && next.title) {
                // 用户手动起过名（name 存在且不是我们上次写的）就不碰。
                const current = session.metadata?.name?.trim() || null
                if (current === null || current === existing.autoName) {
                    if (current !== next.title) {
                        await this.deps.renameSession(session.id, next.title)
                    }
                    next.autoName = next.title
                }
            }
            this.deps.store.saveSession(next)
            this.lastError = null
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            this.deps.store.saveSession({ ...existing, error: message, errorCount: existing.errorCount + 1, lastAttemptAt: now })
            this.lastError = `session ${session.id.slice(0, 8)}: ${message}`
        }
        return true
    }

    async runProject(projectKey: string, settings: DigestSettings): Promise<boolean> {
        const now = this.now()
        const digests = new Map(this.deps.store.listSessions().map(d => [d.sessionId, d]))
        const members = this.deps.getSessions().filter(session => projectKeyOf(session).key === projectKey)
        const first = members[0]
        if (!first) return false
        const { machineId, path } = projectKeyOf(first)
        const existing = this.deps.store.getProject(projectKey) ?? emptyProjectDigest(projectKey, machineId, path)
        const summaries = members
            .map(session => ({ session, digest: digests.get(session.id) }))
            .filter((entry): entry is { session: DigestSessionView; digest: SessionDigest } => Boolean(entry.digest?.generatedAt))
        if (summaries.length === 0) return false
        const stamp = Math.max(...summaries.map(entry => entry.digest.generatedAt ?? 0))

        const prompt = buildProjectPrompt({
            path,
            sessions: summaries.map(({ session, digest }) => ({
                title: digest.title,
                done: digest.done,
                status: digest.status,
                todo: digest.todo,
                completed: digest.completed,
                updatedAt: session.updatedAt
            }))
        }, PROJECT_BUDGET_CHARS)
        try {
            const text = await this.deps.llm!({ model: settings.model, system: PROJECT_SYSTEM_PROMPT, prompt, maxTokens: 1200 })
            const parsed = parseProjectDigest(text)
            if (!parsed) throw new Error(`unparseable project digest: ${text.slice(0, 120)}`)
            const next: ProjectDigest = {
                ...existing,
                ...parsed,
                machineId,
                path,
                model: settings.model,
                generatedAt: now,
                sourceStamp: stamp,
                error: null,
                errorCount: 0,
                lastAttemptAt: now
            }
            this.deps.store.saveProject(next)
            this.lastError = null
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            this.deps.store.saveProject({ ...existing, error: message, errorCount: existing.errorCount + 1, lastAttemptAt: now })
            this.lastError = `project ${path}: ${message}`
        }
        return true
    }

    async listModels(): Promise<string[]> {
        return llmConfig ? await listLlmModels(llmConfig) : []
    }
}

type Job =
    | { kind: 'session'; session: DigestSessionView; label: string }
    | { kind: 'project'; key: string; label: string }

let instance: DigestService | null = null
let llmConfig: LlmConfig | null = null

export function getDigestService(): DigestService | null {
    return instance
}

/** hub 启动时调用。env 缺地址或密钥时服务仍创建（可看/标记完结），只是不调模型。 */
export function startDigestService(params: {
    dataDir: string
    getSessions: () => DigestSessionView[]
    getSession: (sessionId: string) => DigestSessionView | undefined
    getRecentMessages: (sessionId: string, limit: number) => TranscriptMessage[]
    getFirstMessages: (sessionId: string, limit: number) => TranscriptMessage[]
    renameSession: (sessionId: string, name: string) => Promise<void>
}): DigestService {
    const baseUrl = process.env.HAPI_DIGEST_API_URL?.trim()
    const apiKey = process.env.HAPI_DIGEST_API_KEY?.trim()
    llmConfig = baseUrl && apiKey ? { baseUrl, apiKey } : null
    instance = new DigestService({
        store: new DigestStore(join(params.dataDir, 'session-digests.sqlite')),
        getSessions: params.getSessions,
        getSession: params.getSession,
        getRecentMessages: params.getRecentMessages,
        getFirstMessages: params.getFirstMessages,
        renameSession: params.renameSession,
        llm: llmConfig ? createLlmCall(llmConfig) : null,
        defaults: {
            enabled: true,
            model: process.env.HAPI_DIGEST_MODEL?.trim() || 'gpt-6-luna',
            autoRename: true,
            maxPerHour: 60
        }
    })
    instance.start()
    return instance
}
