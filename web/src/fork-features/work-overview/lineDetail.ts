import type { SessionSummary } from '@/types/api'
import type { DigestIndexEntry } from '@/fork-features/session-digest/digestApi'
import { findLine, sessionsInLine, type WorkModel } from './deriveWork'

export type LineDetailSession = { session: SessionSummary; status: string; completed: boolean }

/** 会话列表按主线/支线过滤时，顶部可折叠的「这条线现在在做什么」。 */
export type LineDetail = {
    goal: string
    running: LineDetailSession[]
    recent: LineDetailSession[]
    nextSteps: Array<{ text: string; project: string }>
    projects: Array<{ name: string; subline: string | null; stage: string | null; overview: string; activeCount: number; lastActivity: number }>
}

const RUNNING_MAX = 6
const RECENT_MAX = 3
const NEXT_MAX = 6
const PROJECT_MAX = 6

export function lineDetailOf(model: WorkModel, sessions: SessionSummary[], lineId: string, digestIndex: Record<string, DigestIndexEntry>): LineDetail | null {
    const found = findLine(model, lineId)
    if (!found) return null
    const sublines = found.sub ? [found.sub] : found.main.sublines
    const ids = sessionsInLine(model, lineId)
    const withStatus = (session: SessionSummary): LineDetailSession => ({
        session,
        status: digestIndex[session.id]?.status ?? '',
        completed: Boolean(digestIndex[session.id]?.completed)
    })
    const inLine = sessions.filter(session => ids.has(session.id)).sort((a, b) => b.updatedAt - a.updatedAt)

    const nextSteps: LineDetail['nextSteps'] = []
    const seen = new Set<string>()
    const pushStep = (text: string, project: string) => {
        const key = text.trim()
        if (!key || seen.has(key) || nextSteps.length >= NEXT_MAX) return
        seen.add(key)
        nextSteps.push({ text: key, project })
    }
    if (!found.sub && found.main.nextStep) pushStep(found.main.nextStep.text, found.main.nextStep.project)

    const projects: LineDetail['projects'] = []
    for (const sub of sublines) {
        for (const project of sub.projects) {
            const folders = [...project.folders].sort((a, b) => b.lastActivity - a.lastActivity)
            for (const folder of folders) for (const todo of folder.digest?.todo ?? []) pushStep(todo, project.name)
            projects.push({
                name: project.name,
                subline: found.sub ? null : sub.name,
                stage: project.stage,
                overview: folders.find(folder => folder.digest?.overview)?.digest?.overview ?? '',
                activeCount: project.activeCount,
                lastActivity: project.lastActivity
            })
        }
    }
    projects.sort((a, b) => b.lastActivity - a.lastActivity)

    return {
        goal: (found.sub ?? found.main).goal.trim(),
        running: inLine.filter(session => session.active).slice(0, RUNNING_MAX).map(withStatus),
        recent: inLine.filter(session => !session.active).slice(0, RECENT_MAX).map(withStatus),
        nextSteps,
        projects: projects.slice(0, PROJECT_MAX)
    }
}
