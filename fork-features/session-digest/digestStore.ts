import { Database } from 'bun:sqlite'
import type { SessionArtifacts } from './transcript'

/**
 * 会话 / 项目 AI 摘要的独立存储（`<dataDir>/session-digests.sqlite`）。
 *
 * 与主库物理分离：摘要是可再生的派生数据，丢了重跑即可，不该牵动 hub 的
 * SCHEMA_VERSION；换芯回滚时旧二进制根本不知道这个文件，零影响。
 */

export type SessionDigest = {
    sessionId: string
    title: string
    done: string[]
    status: string
    todo: string[]
    suggestComplete: boolean
    completed: boolean
    completedAt: number | null
    /** 摘要覆盖到的最大消息 seq；有更新的消息才需要重跑。 */
    sourceSeq: number
    /** 摘要生成时会话的 updatedAt；调度器先拿它做便宜的预筛。 */
    sourceUpdatedAt: number
    model: string | null
    generatedAt: number | null
    /** 由本模块写进会话 metadata.name 的标题；当前 name 仍等于它才允许再改，
     *  用户手动改过名就不再碰。 */
    autoName: string | null
    error: string | null
    errorCount: number
    lastAttemptAt: number | null
    /** 会话里写/改过的文件与 git 提交（项目概况的产物依据）；未扫描过为 null。 */
    artifacts: SessionArtifacts | null
}

export type ProjectDigest = {
    projectKey: string
    machineId: string | null
    path: string
    overview: string
    stage: string
    stageReason: string
    capabilities: string[]
    artifacts: string[]
    status: string
    todo: string[]
    judgement: string
    model: string | null
    generatedAt: number | null
    /** 生成时项目内最新一条会话摘要的时间，用于判定是否过期。 */
    sourceStamp: number
    error: string | null
    errorCount: number
    lastAttemptAt: number | null
}

export type DigestSettings = {
    enabled: boolean
    model: string
    autoRename: boolean
    maxPerHour: number
}

type SessionRow = {
    session_id: string
    title: string
    done_json: string
    status: string
    todo_json: string
    suggest_complete: number
    completed: number
    completed_at: number | null
    source_seq: number
    source_updated_at: number
    model: string | null
    generated_at: number | null
    auto_name: string | null
    error: string | null
    error_count: number
    last_attempt_at: number | null
    artifacts_json: string | null
}

type ProjectRow = {
    project_key: string
    machine_id: string | null
    path: string
    overview: string
    stage: string
    stage_reason: string
    capabilities_json: string
    artifacts_json: string
    judgement: string
    status: string
    todo_json: string
    model: string | null
    generated_at: number | null
    source_stamp: number
    error: string | null
    error_count: number
    last_attempt_at: number | null
}

function parseList(raw: string): string[] {
    try {
        const value = JSON.parse(raw) as unknown
        return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
    } catch {
        return []
    }
}

function parseArtifacts(raw: string | null): SessionArtifacts | null {
    if (!raw) return null
    try {
        const value = JSON.parse(raw) as { files?: unknown; commits?: unknown }
        const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
        return { files: list(value.files), commits: list(value.commits) }
    } catch {
        return null
    }
}

function toSessionDigest(row: SessionRow): SessionDigest {
    return {
        sessionId: row.session_id,
        title: row.title,
        done: parseList(row.done_json),
        status: row.status,
        todo: parseList(row.todo_json),
        suggestComplete: row.suggest_complete === 1,
        completed: row.completed === 1,
        completedAt: row.completed_at,
        sourceSeq: row.source_seq,
        sourceUpdatedAt: row.source_updated_at,
        model: row.model,
        generatedAt: row.generated_at,
        autoName: row.auto_name,
        error: row.error,
        errorCount: row.error_count,
        lastAttemptAt: row.last_attempt_at,
        artifacts: parseArtifacts(row.artifacts_json)
    }
}

function toProjectDigest(row: ProjectRow): ProjectDigest {
    return {
        projectKey: row.project_key,
        machineId: row.machine_id,
        path: row.path,
        overview: row.overview ?? '',
        stage: row.stage ?? '',
        stageReason: row.stage_reason ?? '',
        capabilities: parseList(row.capabilities_json),
        artifacts: parseList(row.artifacts_json ?? '[]'),
        judgement: row.judgement ?? '',
        status: row.status,
        todo: parseList(row.todo_json),
        model: row.model,
        generatedAt: row.generated_at,
        sourceStamp: row.source_stamp,
        error: row.error,
        errorCount: row.error_count,
        lastAttemptAt: row.last_attempt_at
    }
}

export function emptySessionDigest(sessionId: string): SessionDigest {
    return {
        sessionId, title: '', done: [], status: '', todo: [], suggestComplete: false,
        completed: false, completedAt: null, sourceSeq: 0, sourceUpdatedAt: 0, model: null,
        generatedAt: null, autoName: null, error: null, errorCount: 0, lastAttemptAt: null, artifacts: null
    }
}

export function emptyProjectDigest(projectKey: string, machineId: string | null, path: string): ProjectDigest {
    return {
        projectKey, machineId, path, overview: '', stage: '', stageReason: '', capabilities: [], artifacts: [],
        judgement: '', status: '', todo: [], model: null,
        generatedAt: null, sourceStamp: 0, error: null, errorCount: 0, lastAttemptAt: null
    }
}

export class DigestStore {
    private readonly db: Database

    constructor(path: string) {
        this.db = new Database(path, { create: true })
        this.db.exec('PRAGMA journal_mode = WAL')
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS session_digests (
                session_id TEXT PRIMARY KEY,
                title TEXT NOT NULL DEFAULT '',
                done_json TEXT NOT NULL DEFAULT '[]',
                status TEXT NOT NULL DEFAULT '',
                todo_json TEXT NOT NULL DEFAULT '[]',
                suggest_complete INTEGER NOT NULL DEFAULT 0,
                completed INTEGER NOT NULL DEFAULT 0,
                completed_at INTEGER,
                source_seq INTEGER NOT NULL DEFAULT 0,
                source_updated_at INTEGER NOT NULL DEFAULT 0,
                model TEXT,
                generated_at INTEGER,
                auto_name TEXT,
                error TEXT,
                error_count INTEGER NOT NULL DEFAULT 0,
                last_attempt_at INTEGER
            );
            CREATE TABLE IF NOT EXISTS project_digests (
                project_key TEXT PRIMARY KEY,
                machine_id TEXT,
                path TEXT NOT NULL,
                capabilities_json TEXT NOT NULL DEFAULT '[]',
                status TEXT NOT NULL DEFAULT '',
                todo_json TEXT NOT NULL DEFAULT '[]',
                model TEXT,
                generated_at INTEGER,
                source_stamp INTEGER NOT NULL DEFAULT 0,
                error TEXT,
                error_count INTEGER NOT NULL DEFAULT 0,
                last_attempt_at INTEGER
            );
            CREATE TABLE IF NOT EXISTS digest_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS digest_runs (
                at INTEGER NOT NULL
            );
        `)
        // 加列走存在性检查（与 subscriptionStore 同模式），旧数据原样保留。
        const columns = (table: string) => new Set(
            (this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(row => row.name)
        )
        const sessionCols = columns('session_digests')
        if (!sessionCols.has('artifacts_json')) this.db.exec('ALTER TABLE session_digests ADD COLUMN artifacts_json TEXT')
        const projectCols = columns('project_digests')
        for (const [name, ddl] of [
            ['overview', "TEXT NOT NULL DEFAULT ''"],
            ['stage', "TEXT NOT NULL DEFAULT ''"],
            ['stage_reason', "TEXT NOT NULL DEFAULT ''"],
            ['artifacts_json', "TEXT NOT NULL DEFAULT '[]'"],
            ['judgement', "TEXT NOT NULL DEFAULT ''"]
        ] as const) {
            if (!projectCols.has(name)) this.db.exec(`ALTER TABLE project_digests ADD COLUMN ${name} ${ddl}`)
        }
    }

    getSession(sessionId: string): SessionDigest | null {
        const row = this.db.prepare('SELECT * FROM session_digests WHERE session_id = ?').get(sessionId) as SessionRow | undefined
        return row ? toSessionDigest(row) : null
    }

    listSessions(): SessionDigest[] {
        return (this.db.prepare('SELECT * FROM session_digests').all() as SessionRow[]).map(toSessionDigest)
    }

    saveSession(digest: SessionDigest): void {
        this.db.prepare(`
            INSERT OR REPLACE INTO session_digests (
                session_id, title, done_json, status, todo_json, suggest_complete, completed, completed_at,
                source_seq, source_updated_at, model, generated_at, auto_name, error, error_count, last_attempt_at,
                artifacts_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            digest.sessionId, digest.title, JSON.stringify(digest.done), digest.status, JSON.stringify(digest.todo),
            digest.suggestComplete ? 1 : 0, digest.completed ? 1 : 0, digest.completedAt,
            digest.sourceSeq, digest.sourceUpdatedAt, digest.model, digest.generatedAt, digest.autoName,
            digest.error, digest.errorCount, digest.lastAttemptAt,
            digest.artifacts ? JSON.stringify(digest.artifacts) : null
        )
    }

    getProject(projectKey: string): ProjectDigest | null {
        const row = this.db.prepare('SELECT * FROM project_digests WHERE project_key = ?').get(projectKey) as ProjectRow | undefined
        return row ? toProjectDigest(row) : null
    }

    listProjects(): ProjectDigest[] {
        return (this.db.prepare('SELECT * FROM project_digests').all() as ProjectRow[]).map(toProjectDigest)
    }

    saveProject(digest: ProjectDigest): void {
        this.db.prepare(`
            INSERT OR REPLACE INTO project_digests (
                project_key, machine_id, path, capabilities_json, status, todo_json, model, generated_at,
                source_stamp, error, error_count, last_attempt_at, overview, stage, stage_reason, artifacts_json, judgement
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            digest.projectKey, digest.machineId, digest.path, JSON.stringify(digest.capabilities), digest.status,
            JSON.stringify(digest.todo), digest.model, digest.generatedAt, digest.sourceStamp, digest.error,
            digest.errorCount, digest.lastAttemptAt, digest.overview, digest.stage, digest.stageReason,
            JSON.stringify(digest.artifacts), digest.judgement
        )
    }

    getSettings(defaults: DigestSettings): DigestSettings {
        const rows = this.db.prepare('SELECT key, value FROM digest_settings').all() as Array<{ key: string; value: string }>
        const map = new Map(rows.map(row => [row.key, row.value]))
        const maxPerHour = Number(map.get('maxPerHour'))
        return {
            enabled: map.has('enabled') ? map.get('enabled') === 'true' : defaults.enabled,
            model: map.get('model') || defaults.model,
            autoRename: map.has('autoRename') ? map.get('autoRename') === 'true' : defaults.autoRename,
            maxPerHour: Number.isFinite(maxPerHour) && maxPerHour > 0 ? Math.floor(maxPerHour) : defaults.maxPerHour
        }
    }

    saveSettings(settings: DigestSettings): void {
        const put = this.db.prepare('INSERT OR REPLACE INTO digest_settings(key, value) VALUES (?, ?)')
        put.run('enabled', String(settings.enabled))
        put.run('model', settings.model)
        put.run('autoRename', String(settings.autoRename))
        put.run('maxPerHour', String(settings.maxPerHour))
    }

    recordRun(at: number): void {
        this.db.prepare('INSERT INTO digest_runs(at) VALUES (?)').run(at)
        this.db.prepare('DELETE FROM digest_runs WHERE at < ?').run(at - 24 * 3600_000)
    }

    countRunsSince(since: number): number {
        const row = this.db.prepare('SELECT COUNT(*) AS n FROM digest_runs WHERE at >= ?').get(since) as { n: number }
        return row.n
    }

    close(): void {
        this.db.close()
    }
}
