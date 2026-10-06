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
    PROJECT_SYSTEM_PROMPT_V2,
    SESSION_SYSTEM_PROMPT,
    buildProjectPromptV2,
    buildSessionPrompt,
    extractArtifacts,
    extractTranscriptLine,
    mergeArtifacts,
    parseProjectDigestV2,
    parseSessionDigest,
    renderTranscript,
    type SessionArtifacts,
    type TranscriptLine,
    type TranscriptMessage
} from './transcript'

/** 调度器眼里的会话：只用到这几个字段，便于测试注入。 */
export type DigestSessionView = {
    id: string
    createdAt?: number
    updatedAt: number
    active?: boolean
    thinking: boolean
    metadata: {
        name?: string
        path?: string
        machineId?: string
        summary?: { text?: string } | null
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
    /** 机器在线且开放了工作区浏览时列出目录顶层；不可用返回 null。 */
    listDirectory?: (machineId: string, path: string) => Promise<string[] | null>
    /** 借项目里一个活跃会话读文件（README 等）；不可用返回 null。 */
    readFile?: (sessionId: string, path: string) => Promise<string | null>
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
const PROJECT_BUDGET_CHARS = 30_000
const ARTIFACT_SCAN_MESSAGES = 400
const README_CANDIDATES = ['README.md', 'readme.md', 'README.txt', 'CLAUDE.md', 'AGENTS.md', 'package.json']
const README_MAX_CHARS = 3000

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
        return await Promise.race([promise, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), ms) })])
    } catch {
        return null
    } finally {
        if (timer) clearTimeout(timer)
    }
}

const yieldToLoop = () => new Promise<void>(resolve => setTimeout(resolve, 0))

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
    queuedProjects: number
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

    /** 「全部项目重新梳理」：按最近活动排序排进强制队列，逐个跑（不受每小时上限）。 */
    requestAllProjects(projectKeys: string[]): number {
        for (const key of projectKeys) this.forcedProjects.add(key)
        this.kick()
        return projectKeys.length
    }

    queuedProjects(): number {
        return this.forcedProjects.size
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
            lastError: this.lastError,
            queuedProjects: this.forcedProjects.size
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

    private collectMessages(sessionId: string, afterSeq: number): TranscriptMessage[] {
        const bySeq = new Map<number, TranscriptMessage>()
        if (afterSeq === 0) {
            for (const message of this.deps.getFirstMessages(sessionId, FIRST_MESSAGES)) bySeq.set(message.seq, message)
        }
        for (const message of this.deps.getRecentMessages(sessionId, RECENT_MESSAGES)) {
            if (message.seq > afterSeq) bySeq.set(message.seq, message)
        }
        return [...bySeq.values()].sort((a, b) => a.seq - b.seq)
    }

    private toLines(messages: TranscriptMessage[]): TranscriptLine[] {
        return messages.map(extractTranscriptLine).filter((line): line is TranscriptLine => line !== null)
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
        const messages = this.collectMessages(session.id, afterSeq)
        const lines = this.toLines(messages)
        const artifacts = mergeArtifacts(existing.artifacts, extractArtifacts(messages))
        if (lines.length === 0) {
            this.deps.store.saveSession({ ...existing, artifacts, sourceSeq: Math.max(existing.sourceSeq, newest), sourceUpdatedAt: session.updatedAt })
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
                artifacts,
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

    /** 没被总结过的会话也要有产物依据：扫最近若干条消息抽一次，存起来复用。 */
    private async artifactsFor(sessionId: string, digest: SessionDigest | undefined): Promise<SessionArtifacts> {
        if (digest?.artifacts) return digest.artifacts
        await yieldToLoop()
        const artifacts = mergeArtifacts(null, extractArtifacts(this.deps.getRecentMessages(sessionId, ARTIFACT_SCAN_MESSAGES)))
        this.deps.store.saveSession({ ...(digest ?? emptySessionDigest(sessionId)), artifacts })
        return artifacts
    }

    private async readProjectReadme(members: DigestSessionView[], path: string): Promise<{ name: string; text: string } | null> {
        const live = members.find(session => session.active)
        if (!live || !this.deps.readFile) return null
        const sep = path.includes('\\') ? '\\' : '/'
        for (const name of README_CANDIDATES) {
            const text = await withTimeout(this.deps.readFile(live.id, `${path.replace(/[\\/]+$/, '')}${sep}${name}`), 10_000)
            if (text && text.trim()) return { name, text: text.slice(0, README_MAX_CHARS) }
        }
        return null
    }

    async runProject(projectKey: string, settings: DigestSettings): Promise<boolean> {
        const now = this.now()
        const digests = new Map(this.deps.store.listSessions().map(d => [d.sessionId, d]))
        const members = this.deps.getSessions().filter(session => projectKeyOf(session).key === projectKey)
        const first = members[0]
        if (!first) return false
        const { machineId, path } = projectKeyOf(first)
        const existing = this.deps.store.getProject(projectKey) ?? emptyProjectDigest(projectKey, machineId, path)

        const fileCounts = new Map<string, number>()
        const commits: Array<{ at: number; text: string }> = []
        const sessions: Parameters<typeof buildProjectPromptV2>[0]['sessions'] = []
        for (const session of members) {
            const digest = digests.get(session.id)
            const artifacts = await this.artifactsFor(session.id, digest)
            artifacts.files.forEach((file, index) => fileCounts.set(file, (fileCounts.get(file) ?? 0) + Math.max(1, artifacts.files.length - index)))
            for (const text of artifacts.commits) commits.push({ at: session.updatedAt, text })
            const fallbackTitle = session.metadata?.name || session.metadata?.summary?.text || ''
            sessions.push({
                title: digest?.title || fallbackTitle,
                createdAt: session.createdAt ?? session.updatedAt,
                updatedAt: session.updatedAt,
                completed: digest?.completed ?? false,
                done: digest?.done ?? [],
                status: digest?.status ?? '',
                todo: digest?.todo ?? [],
                summarized: Boolean(digest?.generatedAt)
            })
        }
        const relative = (file: string) => {
            const base = path.replace(/[\\/]+$/, '')
            return file.toLowerCase().startsWith(base.toLowerCase()) ? file.slice(base.length).replace(/^[\\/]+/, '') || file : file
        }
        const files = [...fileCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([file, count]) => ({ path: relative(file), count }))
        const recentCommits = [...new Set(commits.sort((a, b) => b.at - a.at).map(c => c.text))].slice(0, 20)
        const listing = machineId && this.deps.listDirectory
            ? await withTimeout(this.deps.listDirectory(machineId, path), 10_000)
            : null
        const readme = await this.readProjectReadme(members, path)
        const stamp = Math.max(0, ...[...digests.values()].filter(d => members.some(m => m.id === d.sessionId)).map(d => d.generatedAt ?? 0))

        const prompt = buildProjectPromptV2({ path, listing, readme, sessions, files, commits: recentCommits }, PROJECT_BUDGET_CHARS)
        try {
            const text = await this.deps.llm!({ model: settings.model, system: PROJECT_SYSTEM_PROMPT_V2, prompt, maxTokens: 2000 })
            const parsed = parseProjectDigestV2(text)
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
    listDirectory?: (machineId: string, path: string) => Promise<string[] | null>
    readFile?: (sessionId: string, path: string) => Promise<string | null>
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
        listDirectory: params.listDirectory,
        readFile: params.readFile,
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
