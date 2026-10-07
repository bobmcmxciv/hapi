import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '@/types/api'
import { dailyActivity, deriveWork, sessionsInLine, statusOf } from './deriveWork'
import type { WorkMap } from './workApi'

const NOW = new Date(2026, 9, 7, 12, 0, 0).getTime()
const DAY = 86_400_000

function session(id: string, machineId: string, path: string, daysAgo: number, extra: Partial<SessionSummary> = {}): SessionSummary {
    return {
        id,
        active: false,
        thinking: false,
        activeAt: NOW - daysAgo * DAY,
        updatedAt: NOW - daysAgo * DAY,
        metadata: { path, machineId, name: id },
        metadataVersion: 1,
        agentStateVersion: 1,
        todosUpdatedAt: 0,
        todoProgress: null,
        pendingRequestsCount: 0,
        pendingRequestKinds: [],
        pendingRequests: [],
        backgroundTaskCount: 0,
        futureScheduledMessageCount: 0,
        nextScheduledAt: null,
        model: null,
        effort: null,
        ...extra
    }
}

const machines = [
    { id: 'vircs', label: 'VIRCS', ownerUsername: 'admin' },
    { id: 'mac', label: 'Mac173Index', ownerUsername: 'admin' },
    { id: 'peter-mac', label: 'Peter的Mac', ownerUsername: 'peter' }
]

const map: WorkMap = {
    lines: [
        { id: 'm1', parentId: null, name: 'HAPI 与 AI 编程基础设施', goal: '', sort: 0, updatedAt: 0 },
        { id: 'm1.s1', parentId: 'm1', name: 'HAPI 远程会话平台', goal: '', sort: 0, updatedAt: 0 },
        { id: 'm1.s2', parentId: 'm1', name: '模型网关 cx2cc', goal: '', sort: 1, updatedAt: 0 },
        { id: 'm2', parentId: null, name: '小说与剧本创作', goal: '', sort: 1, updatedAt: 0 },
        { id: 'm2.s1', parentId: 'm2', name: '长篇连载', goal: '', sort: 0, updatedAt: 0 }
    ],
    folders: [
        { projectKey: 'vircs::C:\\hapi', mode: 'line', lineId: 'm1.s1', project: 'HAPI', updatedAt: 0 },
        { projectKey: 'mac::/Users/bob/hapi', mode: 'line', lineId: 'm1.s1', project: 'HAPI', updatedAt: 0 },
        { projectKey: 'vircs::C:\\cx2cc', mode: 'line', lineId: 'm1.s2', project: 'cx2cc', updatedAt: 0 },
        { projectKey: 'mac::/Users/bob/novel', mode: 'line', lineId: 'm2.s1', project: '百年老宅', updatedAt: 0 },
        { projectKey: 'vircs::C:\\Users\\Administrator', mode: 'mixed', lineId: null, project: null, updatedAt: 0 },
        { projectKey: 'vircs::C:\\temp', mode: 'ignored', lineId: null, project: null, updatedAt: 0 }
    ],
    sessions: [
        { sessionId: 'home-cx', lineId: 'm1.s2', updatedAt: 0 },
        { sessionId: 'home-noise', lineId: null, updatedAt: 0 },
        { sessionId: 'hapi-moved', lineId: 'm1.s2', updatedAt: 0 }
    ]
}

const sessions = [
    session('hapi-1', 'vircs', 'C:\\hapi', 0, { active: true, thinking: true }),
    session('hapi-2', 'vircs', 'C:\\hapi', 3, { pendingRequestsCount: 1 }),
    session('hapi-moved', 'vircs', 'C:\\hapi', 2),
    session('hapi-mac', 'mac', '/Users/bob/hapi', 40),
    session('cx-1', 'vircs', 'C:\\cx2cc', 12),
    session('novel-1', 'mac', '/Users/bob/novel', 38),
    session('home-cx', 'vircs', 'C:\\Users\\Administrator', 1),
    session('home-noise', 'vircs', 'C:\\Users\\Administrator', 1),
    session('home-loose', 'vircs', 'C:\\Users\\Administrator', 5),
    session('tmp-1', 'vircs', 'C:\\temp', 0),
    session('new-folder', 'vircs', 'C:\\brand-new', 4),
    session('peter-1', 'peter-mac', '/Users/peter/erp', 0, { active: true })
]

const digests = {
    'vircs::C:\\hapi': { stage: '维护中', overview: 'HAPI 远程控制', todo: ['继续验证文件传输'], status: '' },
    'vircs::C:\\cx2cc': { stage: '已上线', overview: '代理', todo: ['换 key'], status: '' }
}

describe('deriveWork', () => {
    const model = deriveWork({ map, sessions, machines, username: 'admin', digests, now: NOW })

    it('classifies sessions: session rows win, folders follow, mixed and new folders go to triage, peter is out of scope', () => {
        expect(model.sublineOfSession.get('hapi-1')).toBe('m1.s1')
        expect(model.sublineOfSession.get('hapi-moved')).toBe('m1.s2')
        expect(model.sublineOfSession.get('home-cx')).toBe('m1.s2')
        expect(model.sublineOfSession.has('home-noise')).toBe(false)
        expect(model.sublineOfSession.has('tmp-1')).toBe(false)
        expect(model.looseSessions.map(item => item.session.id)).toEqual(['home-loose'])
        expect(model.unassignedFolders.map(folder => folder.projectKey)).toEqual(['vircs::C:\\brand-new'])
        expect([...model.unassignedSessionIds].sort()).toEqual(['home-loose', 'new-folder'])
        expect(model.totals).toEqual({
            sessions: 11,
            mapped: 7,
            active: 1,
            needsApproval: 1,
            pushingMainlines: 1,
            stalledMainlines: 1,
            unassignedSessions: 2
        })
    })

    it('aggregates subline, project and mainline stats with cross-machine projects merged', () => {
        const hapiLine = model.mainlines.find(line => line.id === 'm1')!
        expect(hapiLine.sessionCount).toBe(6)
        expect(hapiLine.activeCount).toBe(1)
        expect(hapiLine.pendingCount).toBe(1)
        expect(hapiLine.status).toBe('push')
        const platform = hapiLine.sublines.find(sub => sub.id === 'm1.s1')!
        expect(platform.sessionCount).toBe(3)
        expect(platform.projects).toHaveLength(1)
        expect(platform.projects[0]).toMatchObject({ name: 'HAPI', sessionCount: 3, stage: '维护中', machines: ['VIRCS', 'Mac173Index'] })
        const gateway = hapiLine.sublines.find(sub => sub.id === 'm1.s2')!
        expect(gateway).toMatchObject({ sessionCount: 3, looseSessionCount: 2, status: 'push' })
        expect(hapiLine.nextStep).toEqual({ text: '继续验证文件传输', project: 'HAPI' })
    })

    it('orders mainlines push → slow → stall and marks stale lines', () => {
        expect(model.mainlines.map(line => [line.id, line.status])).toEqual([['m1', 'push'], ['m2', 'stall']])
        expect(statusOf(NOW - 8 * DAY, NOW)).toBe('slow')
        expect(statusOf(NOW - 31 * DAY, NOW)).toBe('stall')
        expect(statusOf(0, NOW)).toBe('stall')
    })

    it('filters sessions by mainline or subline', () => {
        expect([...sessionsInLine(model, 'm1')].sort()).toEqual(['cx-1', 'hapi-1', 'hapi-2', 'hapi-mac', 'hapi-moved', 'home-cx'])
        expect([...sessionsInLine(model, 'm1.s2')].sort()).toEqual(['cx-1', 'hapi-moved', 'home-cx'])
    })

    it('builds the daily timeline and counts only triage sessions as unmapped', () => {
        const timeline = dailyActivity(model, sessions, 14, NOW)
        expect(timeline.days).toHaveLength(14)
        const hapi = timeline.byMainline.get('m1')!
        expect(hapi[13]).toBe(1)
        expect(hapi[12]).toBe(1)
        expect(hapi.reduce((a, b) => a + b, 0)).toBe(5)
        expect(timeline.unmapped).toBe(2)
    })

    it('stays fast at production scale (1,500 sessions, 150 folders)', () => {
        const many: SessionSummary[] = []
        for (let i = 0; i < 1500; i += 1) many.push(session(`s${i}`, i % 2 ? 'vircs' : 'mac', `C:\\p${i % 150}`, i % 60))
        const bigMap: WorkMap = {
            ...map,
            folders: Array.from({ length: 150 }, (_, i) => ({
                projectKey: `${i % 2 ? 'vircs' : 'mac'}::C:\\p${i}`, mode: 'line' as const, lineId: i % 3 ? 'm1.s1' : 'm2.s1', project: `p${i}`, updatedAt: 0
            }))
        }
        const started = performance.now()
        const big = deriveWork({ map: bigMap, sessions: many, machines, username: 'admin', digests: {}, now: NOW })
        dailyActivity(big, many, 42, NOW)
        expect(performance.now() - started).toBeLessThan(100)
        expect(big.totals.sessions).toBe(1500)
    })
})
