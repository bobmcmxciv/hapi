import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '@/types/api'
import { deriveWork } from './deriveWork'
import { lineDetailOf } from './lineDetail'
import type { WorkMap } from './workApi'

const NOW = new Date(2026, 9, 7, 12, 0, 0).getTime()
const DAY = 86_400_000

function session(id: string, path: string, daysAgo: number, extra: Partial<SessionSummary> = {}): SessionSummary {
    return {
        id,
        active: false,
        thinking: false,
        activeAt: NOW - daysAgo * DAY,
        updatedAt: NOW - daysAgo * DAY,
        metadata: { path, machineId: 'vircs', name: id },
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

const map: WorkMap = {
    lines: [
        { id: 'm1', parentId: null, name: '个人主页', goal: '把个人主页和各类测试页都放上 ECS', sort: 0, updatedAt: 0 },
        { id: 'm1.s1', parentId: 'm1', name: '主页与页面上线', goal: '', sort: 0, updatedAt: 0 },
        { id: 'm1.s2', parentId: 'm1', name: 'LLM 测试', goal: '跑通各家模型的对比', sort: 1, updatedAt: 0 }
    ],
    folders: [
        { projectKey: 'vircs::C:\\webmap', mode: 'line', lineId: 'm1.s1', project: '主页', updatedAt: 0 },
        { projectKey: 'vircs::C:\\llm', mode: 'line', lineId: 'm1.s2', project: 'LLM 评测', updatedAt: 0 }
    ],
    sessions: []
}

const sessions = [
    session('web-run', 'C:\\webmap', 0, { active: true }),
    session('web-old', 'C:\\webmap', 9),
    session('llm-run', 'C:\\llm', 1, { active: true, thinking: true }),
    session('llm-1', 'C:\\llm', 2),
    session('llm-2', 'C:\\llm', 3),
    session('llm-3', 'C:\\llm', 4),
    session('llm-4', 'C:\\llm', 5)
]

const digests = {
    'vircs::C:\\webmap': { stage: '已上线', overview: '个人主页', todo: ['补上 SSL 续期', '整理导航'], status: '' },
    'vircs::C:\\llm': { stage: '开发中', overview: '模型对比', todo: ['补 NPU 结果', '补上 SSL 续期'], status: '' }
}

const digestIndex = {
    'llm-run': { completed: false, suggestComplete: false, hasDigest: true, status: '正在跑第二轮对比' },
    'llm-1': { completed: true, suggestComplete: false, hasDigest: true, status: '首轮结果已出' }
}

describe('lineDetailOf', () => {
    const model = deriveWork({ map, sessions, machines: [{ id: 'vircs', label: 'VIRCS', ownerUsername: 'admin' }], username: 'admin', digests, now: NOW })

    it('scopes a subline to its own sessions, steps and projects', () => {
        const detail = lineDetailOf(model, sessions, 'm1.s2', digestIndex)!
        expect(detail.goal).toBe('跑通各家模型的对比')
        expect(detail.running.map(item => [item.session.id, item.status])).toEqual([['llm-run', '正在跑第二轮对比']])
        expect(detail.recent.map(item => [item.session.id, item.completed])).toEqual([['llm-1', true], ['llm-2', false], ['llm-3', false]])
        expect(detail.nextSteps).toEqual([{ text: '补 NPU 结果', project: 'LLM 评测' }, { text: '补上 SSL 续期', project: 'LLM 评测' }])
        expect(detail.projects.map(project => [project.name, project.subline, project.stage, project.activeCount])).toEqual([['LLM 评测', null, '开发中', 1]])
    })

    it('aggregates a mainline across sublines, newest first, with deduplicated next steps', () => {
        const detail = lineDetailOf(model, sessions, 'm1', digestIndex)!
        expect(detail.goal).toBe('把个人主页和各类测试页都放上 ECS')
        expect(detail.running.map(item => item.session.id)).toEqual(['web-run', 'llm-run'])
        expect(detail.projects.map(project => [project.name, project.subline])).toEqual([['主页', '主页与页面上线'], ['LLM 评测', 'LLM 测试']])
        const texts = detail.nextSteps.map(step => step.text)
        expect(new Set(texts).size).toBe(texts.length)
        expect(texts).toEqual(expect.arrayContaining(['补上 SSL 续期', '整理导航', '补 NPU 结果']))
        expect(lineDetailOf(model, sessions, 'nope', digestIndex)).toBeNull()
    })
})
