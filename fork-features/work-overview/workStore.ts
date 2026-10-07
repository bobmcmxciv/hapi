import { Database } from 'bun:sqlite'
import { join } from 'node:path'

/**
 * 工作总览的归属数据：主线/支线，以及「目录 → 支线」「会话 → 支线」两层映射。
 *
 * 独立存储（`<dataDir>/work-overview.sqlite`），不动主库 SCHEMA_VERSION；换芯回滚时
 * 旧二进制不认识这个文件，零影响。每一行都带 account_id：现在只开放给 admin，
 * 但数据按账号隔离，以后放开给别的账号不需要迁移。
 *
 * 归属规则（前端 deriveWork 按同一规则计算）：
 * - 目录 mode=line：目录下会话都归 line_id（会话级覆盖优先）。
 * - 目录 mode=mixed：家目录这类混合目录，逐个会话归属，没有会话行的算「待整理」。
 * - 目录 mode=ignored：明确不纳入任何主线（临时目录、探针）。
 * - 没有目录行：待整理。
 * - 会话行 line_id=null：明确忽略（一次性提问、空会话）。
 */

export type WorkLine = {
    id: string
    /** null = 主线；否则是所属主线的 id（只有两层）。 */
    parentId: string | null
    name: string
    goal: string
    sort: number
    updatedAt: number
}

export type WorkFolderMode = 'line' | 'mixed' | 'ignored'

export type WorkFolder = {
    projectKey: string
    mode: WorkFolderMode
    /** mode=line 时为支线 id，其余为 null。 */
    lineId: string | null
    /** 项目名：跨机器的同一项目共用一个名字。 */
    project: string | null
    updatedAt: number
}

export type WorkSessionAssignment = {
    sessionId: string
    /** null = 明确忽略。 */
    lineId: string | null
    updatedAt: number
}

export type WorkMap = {
    lines: WorkLine[]
    folders: WorkFolder[]
    sessions: WorkSessionAssignment[]
    /** 用户在「需要你处理」里忽略掉的会话（不再提醒，梳理待办时也不再列）。 */
    dismissed: string[]
}

export type DismissedRecord = {
    sessionId: string
    dismissedAt: number
    /** 忽略时是我们把会话摘要标成了已完结（恢复时据此撤回）。 */
    markedCompleted: boolean
}

export type StoredBriefing = {
    json: string
    generatedAt: number
}

export class WorkMapError extends Error {}

const MAX_NAME = 60
const MAX_GOAL = 200

export class WorkStore {
    private readonly db: Database

    constructor(path: string) {
        this.db = new Database(path, { create: true })
        this.db.exec('PRAGMA journal_mode = WAL')
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS work_lines (
                account_id INTEGER NOT NULL,
                id TEXT NOT NULL,
                parent_id TEXT,
                name TEXT NOT NULL,
                goal TEXT NOT NULL DEFAULT '',
                sort INTEGER NOT NULL DEFAULT 0,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (account_id, id)
            );
            CREATE TABLE IF NOT EXISTS work_folders (
                account_id INTEGER NOT NULL,
                project_key TEXT NOT NULL,
                mode TEXT NOT NULL CHECK (mode IN ('line', 'mixed', 'ignored')),
                line_id TEXT,
                project TEXT,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (account_id, project_key)
            );
            CREATE TABLE IF NOT EXISTS work_sessions (
                account_id INTEGER NOT NULL,
                session_id TEXT NOT NULL,
                line_id TEXT,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (account_id, session_id)
            );
            CREATE TABLE IF NOT EXISTS work_dismissed (
                account_id INTEGER NOT NULL,
                session_id TEXT NOT NULL,
                dismissed_at INTEGER NOT NULL,
                marked_completed INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (account_id, session_id)
            );
            CREATE TABLE IF NOT EXISTS work_briefing (
                account_id INTEGER PRIMARY KEY,
                json TEXT NOT NULL,
                generated_at INTEGER NOT NULL
            );
        `)
    }

    close(): void {
        this.db.close()
    }

    getMap(accountId: number): WorkMap {
        const lines = (this.db.query(`
            SELECT id, parent_id AS parentId, name, goal, sort, updated_at AS updatedAt
            FROM work_lines WHERE account_id = ? ORDER BY sort, id
        `).all(accountId) as WorkLine[])
        const folders = (this.db.query(`
            SELECT project_key AS projectKey, mode, line_id AS lineId, project, updated_at AS updatedAt
            FROM work_folders WHERE account_id = ? ORDER BY project_key
        `).all(accountId) as WorkFolder[])
        const sessions = (this.db.query(`
            SELECT session_id AS sessionId, line_id AS lineId, updated_at AS updatedAt
            FROM work_sessions WHERE account_id = ? ORDER BY session_id
        `).all(accountId) as WorkSessionAssignment[])
        const dismissed = this.listDismissed(accountId).map(record => record.sessionId)
        return { lines, folders, sessions, dismissed }
    }

    listDismissed(accountId: number): DismissedRecord[] {
        return (this.db.query(`
            SELECT session_id AS sessionId, dismissed_at AS dismissedAt, marked_completed AS markedCompleted
            FROM work_dismissed WHERE account_id = ? ORDER BY dismissed_at DESC
        `).all(accountId) as Array<{ sessionId: string; dismissedAt: number; markedCompleted: number }>)
            .map(row => ({ sessionId: row.sessionId, dismissedAt: row.dismissedAt, markedCompleted: row.markedCompleted === 1 }))
    }

    /** 忽略 / 取消忽略一个会话。返回取消前的记录（取消时调用方据此决定是否撤回完结标记）。 */
    setDismissed(accountId: number, sessionId: string, dismissed: boolean, markedCompleted = false, now: number = Date.now()): DismissedRecord | null {
        const previous = this.listDismissed(accountId).find(record => record.sessionId === sessionId) ?? null
        if (dismissed) {
            this.db.query(`
                INSERT INTO work_dismissed (account_id, session_id, dismissed_at, marked_completed) VALUES (?, ?, ?, ?)
                ON CONFLICT(account_id, session_id) DO UPDATE SET dismissed_at = excluded.dismissed_at
            `).run(accountId, sessionId, now, markedCompleted ? 1 : 0)
        } else {
            this.db.query('DELETE FROM work_dismissed WHERE account_id = ? AND session_id = ?').run(accountId, sessionId)
        }
        return previous
    }

    getBriefing(accountId: number): StoredBriefing | null {
        const row = this.db.query('SELECT json, generated_at AS generatedAt FROM work_briefing WHERE account_id = ?').get(accountId) as StoredBriefing | null
        return row ?? null
    }

    saveBriefing(accountId: number, json: string, generatedAt: number): void {
        this.db.query(`
            INSERT INTO work_briefing (account_id, json, generated_at) VALUES (?, ?, ?)
            ON CONFLICT(account_id) DO UPDATE SET json = excluded.json, generated_at = excluded.generated_at
        `).run(accountId, json, generatedAt)
    }

    /** 整份替换（初次导入 / 备份恢复）。任何一条不合法就整体拒绝，不落半份。 */
    replaceMap(accountId: number, map: {
        lines: Array<Omit<WorkLine, 'updatedAt'>>
        folders: Array<Omit<WorkFolder, 'updatedAt'>>
        sessions: Array<Omit<WorkSessionAssignment, 'updatedAt'>>
    }, now: number = Date.now()): WorkMap {
        const lines = new Map<string, Omit<WorkLine, 'updatedAt'>>()
        for (const line of map.lines) {
            if (lines.has(line.id)) throw new WorkMapError(`Duplicate line id: ${line.id}`)
            lines.set(line.id, normalizeLine(line))
        }
        for (const line of lines.values()) {
            if (line.parentId === null) continue
            const parent = lines.get(line.parentId)
            if (!parent || parent.parentId !== null) throw new WorkMapError(`Line ${line.id} must sit under a mainline`)
        }
        const isSubline = (id: string | null) => id !== null && lines.get(id)?.parentId != null
        const folderKeys = new Set<string>()
        for (const folder of map.folders) {
            if (folderKeys.has(folder.projectKey)) throw new WorkMapError(`Duplicate folder: ${folder.projectKey}`)
            folderKeys.add(folder.projectKey)
            checkFolder(folder, isSubline)
        }
        const sessionIds = new Set<string>()
        for (const session of map.sessions) {
            if (sessionIds.has(session.sessionId)) throw new WorkMapError(`Duplicate session: ${session.sessionId}`)
            sessionIds.add(session.sessionId)
            if (session.lineId !== null && !isSubline(session.lineId)) throw new WorkMapError(`Session ${session.sessionId} must point to a subline`)
        }

        this.db.transaction(() => {
            this.db.query('DELETE FROM work_lines WHERE account_id = ?').run(accountId)
            this.db.query('DELETE FROM work_folders WHERE account_id = ?').run(accountId)
            this.db.query('DELETE FROM work_sessions WHERE account_id = ?').run(accountId)
            const insertLine = this.db.query('INSERT INTO work_lines (account_id, id, parent_id, name, goal, sort, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
            for (const line of lines.values()) insertLine.run(accountId, line.id, line.parentId, line.name, line.goal, line.sort, now)
            const insertFolder = this.db.query('INSERT INTO work_folders (account_id, project_key, mode, line_id, project, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
            for (const folder of map.folders) insertFolder.run(accountId, folder.projectKey, folder.mode, folder.mode === 'line' ? folder.lineId : null, cleanProject(folder.project), now)
            const insertSession = this.db.query('INSERT INTO work_sessions (account_id, session_id, line_id, updated_at) VALUES (?, ?, ?, ?)')
            for (const session of map.sessions) insertSession.run(accountId, session.sessionId, session.lineId, now)
        })()
        return this.getMap(accountId)
    }

    /** 新建或修改一条主线/支线。改父级只允许在主线之间移动支线。 */
    upsertLine(accountId: number, line: Omit<WorkLine, 'updatedAt'>, now: number = Date.now()): WorkLine {
        const normalized = normalizeLine(line)
        const existing = this.getLine(accountId, normalized.id)
        if (normalized.parentId !== null) {
            const parent = this.getLine(accountId, normalized.parentId)
            if (!parent || parent.parentId !== null) throw new WorkMapError('Parent must be a mainline')
        }
        if (existing && existing.parentId === null && normalized.parentId !== null && this.hasChildren(accountId, existing.id)) {
            throw new WorkMapError('A mainline with sublines cannot become a subline')
        }
        if (existing && existing.parentId !== null && normalized.parentId === null) {
            const referenced = this.db.query('SELECT 1 FROM work_folders WHERE account_id = ? AND line_id = ? UNION SELECT 1 FROM work_sessions WHERE account_id = ? AND line_id = ? LIMIT 1')
                .get(accountId, existing.id, accountId, existing.id)
            if (referenced) throw new WorkMapError('A subline with folders or sessions cannot become a mainline')
        }
        this.db.query(`
            INSERT INTO work_lines (account_id, id, parent_id, name, goal, sort, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (account_id, id) DO UPDATE SET parent_id = excluded.parent_id, name = excluded.name,
                goal = excluded.goal, sort = excluded.sort, updated_at = excluded.updated_at
        `).run(accountId, normalized.id, normalized.parentId, normalized.name, normalized.goal, normalized.sort, now)
        return this.getLine(accountId, normalized.id)!
    }

    /** 删一条线：有子支线时拒绝；指向它的目录和会话回到「待整理」。 */
    deleteLine(accountId: number, id: string): void {
        if (!this.getLine(accountId, id)) throw new WorkMapError('Line not found')
        if (this.hasChildren(accountId, id)) throw new WorkMapError('Delete its sublines first')
        this.db.transaction(() => {
            this.db.query('DELETE FROM work_folders WHERE account_id = ? AND line_id = ?').run(accountId, id)
            this.db.query('DELETE FROM work_sessions WHERE account_id = ? AND line_id = ?').run(accountId, id)
            this.db.query('DELETE FROM work_lines WHERE account_id = ? AND id = ?').run(accountId, id)
        })()
    }

    /** mode=null 表示把目录放回「待整理」（删行）。 */
    setFolder(accountId: number, folder: { projectKey: string; mode: WorkFolderMode | null; lineId?: string | null; project?: string | null }, now: number = Date.now()): WorkFolder | null {
        if (!folder.projectKey || folder.projectKey.length > 1024) throw new WorkMapError('Invalid projectKey')
        if (folder.mode === null) {
            this.db.query('DELETE FROM work_folders WHERE account_id = ? AND project_key = ?').run(accountId, folder.projectKey)
            return null
        }
        const record = { projectKey: folder.projectKey, mode: folder.mode, lineId: folder.lineId ?? null, project: folder.project ?? null }
        checkFolder(record, id => id !== null && this.getLine(accountId, id)?.parentId != null)
        this.db.query(`
            INSERT INTO work_folders (account_id, project_key, mode, line_id, project, updated_at) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT (account_id, project_key) DO UPDATE SET mode = excluded.mode, line_id = excluded.line_id,
                project = excluded.project, updated_at = excluded.updated_at
        `).run(accountId, record.projectKey, record.mode, record.mode === 'line' ? record.lineId : null, cleanProject(record.project), now)
        return this.getMap(accountId).folders.find(item => item.projectKey === record.projectKey) ?? null
    }

    /** assignment=undefined 表示删掉会话行（回到跟随目录 / 待整理）；lineId=null 表示明确忽略。 */
    setSession(accountId: number, sessionId: string, assignment: { lineId: string | null } | undefined, now: number = Date.now()): WorkSessionAssignment | null {
        if (!sessionId || sessionId.length > 200) throw new WorkMapError('Invalid sessionId')
        if (assignment === undefined) {
            this.db.query('DELETE FROM work_sessions WHERE account_id = ? AND session_id = ?').run(accountId, sessionId)
            return null
        }
        if (assignment.lineId !== null && this.getLine(accountId, assignment.lineId)?.parentId == null) {
            throw new WorkMapError('Session must point to a subline')
        }
        this.db.query(`
            INSERT INTO work_sessions (account_id, session_id, line_id, updated_at) VALUES (?, ?, ?, ?)
            ON CONFLICT (account_id, session_id) DO UPDATE SET line_id = excluded.line_id, updated_at = excluded.updated_at
        `).run(accountId, sessionId, assignment.lineId, now)
        return { sessionId, lineId: assignment.lineId, updatedAt: now }
    }

    private getLine(accountId: number, id: string): WorkLine | null {
        return (this.db.query(`
            SELECT id, parent_id AS parentId, name, goal, sort, updated_at AS updatedAt
            FROM work_lines WHERE account_id = ? AND id = ?
        `).get(accountId, id) as WorkLine | null) ?? null
    }

    private hasChildren(accountId: number, id: string): boolean {
        return Boolean(this.db.query('SELECT 1 FROM work_lines WHERE account_id = ? AND parent_id = ? LIMIT 1').get(accountId, id))
    }
}

function normalizeLine(line: Omit<WorkLine, 'updatedAt'>): Omit<WorkLine, 'updatedAt'> {
    const id = line.id.trim()
    const name = line.name.trim()
    if (!/^[\w.-]{1,64}$/.test(id)) throw new WorkMapError(`Invalid line id: ${line.id}`)
    if (!name || name.length > MAX_NAME) throw new WorkMapError(`Line name must be 1-${MAX_NAME} characters`)
    const goal = line.goal.trim()
    if (goal.length > MAX_GOAL) throw new WorkMapError(`Line goal must be at most ${MAX_GOAL} characters`)
    if (line.parentId === id) throw new WorkMapError('A line cannot be its own parent')
    return { id, parentId: line.parentId, name, goal, sort: Number.isFinite(line.sort) ? Math.trunc(line.sort) : 0 }
}

function checkFolder(folder: { projectKey: string; mode: WorkFolderMode; lineId: string | null }, isSubline: (id: string | null) => boolean): void {
    if (folder.mode === 'line' && !isSubline(folder.lineId)) throw new WorkMapError(`Folder ${folder.projectKey} must point to a subline`)
    if (folder.mode !== 'line' && folder.lineId !== null) throw new WorkMapError(`Folder ${folder.projectKey} in mode ${folder.mode} cannot have a line`)
}

function cleanProject(project: string | null | undefined): string | null {
    const value = project?.trim()
    return value ? value.slice(0, MAX_NAME) : null
}

let instance: WorkStore | null = null

export function getWorkStore(): WorkStore | null {
    return instance
}

/** hub 启动时调用一次。 */
export function startWorkStore(dataDir: string): WorkStore {
    instance = new WorkStore(join(dataDir, 'work-overview.sqlite'))
    return instance
}

/** hub 停止时调用。 */
export function stopWorkStore(): void {
    instance?.close()
    instance = null
}
