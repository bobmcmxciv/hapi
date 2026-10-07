import { describe, expect, test } from 'bun:test'
import { WorkMapError, WorkStore } from './workStore'

const baseMap = {
    lines: [
        { id: 'm1', parentId: null, name: 'HAPI 与 AI 编程基础设施', goal: '远程控制会话', sort: 0 },
        { id: 'm1.s1', parentId: 'm1', name: 'HAPI 远程会话平台', goal: '', sort: 0 },
        { id: 'm1.s2', parentId: 'm1', name: '模型网关 cx2cc', goal: '', sort: 1 }
    ],
    folders: [
        { projectKey: 'vircs::C:\\Users\\Administrator\\hapi', mode: 'line' as const, lineId: 'm1.s1', project: 'HAPI' },
        { projectKey: 'vircs::C:\\Users\\Administrator', mode: 'mixed' as const, lineId: null, project: null },
        { projectKey: 'vircs::C:\\temp\\probe', mode: 'ignored' as const, lineId: null, project: null }
    ],
    sessions: [
        { sessionId: 's-home-1', lineId: 'm1.s2' },
        { sessionId: 's-home-2', lineId: null }
    ]
}

describe('WorkStore', () => {
    test('replaceMap round-trips and is isolated per account', () => {
        const store = new WorkStore(':memory:')
        store.replaceMap(1, baseMap, 1000)
        const map = store.getMap(1)
        expect(map.lines.map(line => line.id)).toEqual(['m1', 'm1.s1', 'm1.s2'])
        expect(map.folders.find(folder => folder.mode === 'line')).toMatchObject({ lineId: 'm1.s1', project: 'HAPI', updatedAt: 1000 })
        expect(map.sessions).toEqual([
            { sessionId: 's-home-1', lineId: 'm1.s2', updatedAt: 1000 },
            { sessionId: 's-home-2', lineId: null, updatedAt: 1000 }
        ])
        expect(store.getMap(2)).toEqual({ lines: [], folders: [], sessions: [], dismissed: [] })
        store.close()
    })

    test('replaceMap rejects broken references without writing anything', () => {
        const store = new WorkStore(':memory:')
        store.replaceMap(1, baseMap)
        const broken = { ...baseMap, folders: [{ projectKey: 'k', mode: 'line' as const, lineId: 'm1', project: null }] }
        expect(() => store.replaceMap(1, broken)).toThrow(WorkMapError)
        expect(() => store.replaceMap(1, { ...baseMap, sessions: [{ sessionId: 'x', lineId: 'nope' }] })).toThrow(WorkMapError)
        expect(() => store.replaceMap(1, {
            ...baseMap,
            lines: [...baseMap.lines, { id: 'deep', parentId: 'm1.s1', name: '三层', goal: '', sort: 0 }]
        })).toThrow(WorkMapError)
        expect(store.getMap(1).folders).toHaveLength(3)
        store.close()
    })

    test('setFolder moves a folder, ignores it, and puts it back to unassigned', () => {
        const store = new WorkStore(':memory:')
        store.replaceMap(1, baseMap)
        const key = 'vircs::C:\\Users\\Administrator\\hapi'
        expect(store.setFolder(1, { projectKey: key, mode: 'line', lineId: 'm1.s2', project: 'HAPI' })).toMatchObject({ lineId: 'm1.s2' })
        expect(() => store.setFolder(1, { projectKey: key, mode: 'line', lineId: 'm1' })).toThrow('subline')
        expect(store.setFolder(1, { projectKey: key, mode: 'ignored' })).toMatchObject({ mode: 'ignored', lineId: null })
        expect(store.setFolder(1, { projectKey: key, mode: null })).toBeNull()
        expect(store.getMap(1).folders.some(folder => folder.projectKey === key)).toBe(false)
        store.close()
    })

    test('setSession assigns, ignores and clears a session', () => {
        const store = new WorkStore(':memory:')
        store.replaceMap(1, baseMap)
        expect(store.setSession(1, 'new', { lineId: 'm1.s1' }, 5)).toEqual({ sessionId: 'new', lineId: 'm1.s1', updatedAt: 5 })
        expect(() => store.setSession(1, 'new', { lineId: 'm1' })).toThrow(WorkMapError)
        store.setSession(1, 'new', { lineId: null })
        expect(store.getMap(1).sessions.find(session => session.sessionId === 'new')?.lineId).toBeNull()
        store.setSession(1, 'new', undefined)
        expect(store.getMap(1).sessions.some(session => session.sessionId === 'new')).toBe(false)
        store.close()
    })

    test('lines: create, rename, guard against invalid moves, delete releases folders', () => {
        const store = new WorkStore(':memory:')
        store.replaceMap(1, baseMap)
        store.upsertLine(1, { id: 'm2', parentId: null, name: '小说与剧本创作', goal: '', sort: 1 })
        store.upsertLine(1, { id: 'm2.s1', parentId: 'm2', name: '长篇连载', goal: '', sort: 0 })
        expect(store.upsertLine(1, { id: 'm1.s2', parentId: 'm1', name: 'cx2cc 网关', goal: '', sort: 1 }).name).toBe('cx2cc 网关')
        expect(() => store.upsertLine(1, { id: 'm1', parentId: 'm2', name: 'x', goal: '', sort: 0 })).toThrow('cannot become a subline')
        expect(() => store.upsertLine(1, { id: 'm1.s1', parentId: null, name: 'x', goal: '', sort: 0 })).toThrow('cannot become a mainline')
        expect(() => store.upsertLine(1, { id: 'bad id', parentId: null, name: 'x', goal: '', sort: 0 })).toThrow('Invalid line id')
        expect(() => store.deleteLine(1, 'm1')).toThrow('sublines first')
        store.deleteLine(1, 'm1.s1')
        const map = store.getMap(1)
        expect(map.lines.some(line => line.id === 'm1.s1')).toBe(false)
        expect(map.folders.some(folder => folder.lineId === 'm1.s1')).toBe(false)
        store.close()
    })
    test('dismissed sessions are per account, listed newest first, and report what the dismissal changed', () => {
        const store = new WorkStore(':memory:')
        expect(store.setDismissed(1, 'a', true, true, 1000)).toBeNull()
        store.setDismissed(1, 'b', true, false, 2000)
        store.setDismissed(2, 'a', true, false, 3000)
        expect(store.getMap(1).dismissed).toEqual(['b', 'a'])
        expect(store.getMap(2).dismissed).toEqual(['a'])
        const previous = store.setDismissed(1, 'a', false)
        expect(previous).toEqual({ sessionId: 'a', dismissedAt: 1000, markedCompleted: true })
        expect(store.getMap(1).dismissed).toEqual(['b'])
        store.close()
    })

    test('keeps the latest briefing per account', () => {
        const store = new WorkStore(':memory:')
        expect(store.getBriefing(1)).toBeNull()
        store.saveBriefing(1, '{"summary":"一"}', 1000)
        store.saveBriefing(1, '{"summary":"二"}', 2000)
        expect(store.getBriefing(1)).toEqual({ json: '{"summary":"二"}', generatedAt: 2000 })
        expect(store.getBriefing(2)).toBeNull()
        store.close()
    })
})
