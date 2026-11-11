import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '@/types/api'
import type { ProjectDigest } from '@/fork-features/session-digest/digestApi'
import { buildSidebarProjects, isMiscellaneousDirectory, normalizeProjectDirectory, sortSidebarProjects } from './projectAggregation'

function session(id: string, machineId: string | undefined, path: string, updatedAt = 1): SessionSummary {
    return {
        id, active: false, thinking: false, activeAt: 0, updatedAt,
        metadata: { name: id, machineId, path, flavor: 'omp', agentSessionId: 'same-native-id' },
        metadataVersion: 0, agentStateVersion: 0, todosUpdatedAt: 0, todoProgress: null,
        pendingRequestsCount: 0, pendingRequestKinds: [], pendingRequests: [], backgroundTaskCount: 0,
        futureScheduledMessageCount: 0, nextScheduledAt: null, model: null, effort: null,
    }
}

describe('project aggregation over authorized filtered sessions', () => {
    it('aggregates same-owner actual directory names across hosts and worktrees without losing IDs or origins', () => {
        const worktree = session('branch', 'windows', 'C:\\worktrees\\feature')
        worktree.metadata!.worktree = { basePath: 'C:\\code\\hapi', worktreePath: 'C:\\worktrees\\feature', branch: 'feature', name: 'feature' }
        const sessions = [session('win', 'windows', 'C:\\code\\hapi'), worktree, session('linux', 'linux', '/srv/code/hapi'), session('other', 'linux', '/srv/code/maa-agent')]
        const model = buildSidebarProjects(sessions, { windows: 'alice', linux: 'alice' })
        expect(model.directories).toHaveLength(3)
        expect(model.projects).toHaveLength(2)
        const hapi = model.projects.find(project => project.displayName === 'hapi')!
        expect(hapi.sessions.map(row => row.id).sort()).toEqual(['branch', 'linux', 'win'])
        expect(hapi.origins.map(origin => [origin.machineId, origin.directory])).toEqual([['windows', 'C:\\code\\hapi'], ['linux', '/srv/code/hapi']])
        expect(hapi.origins[0]!.key).toBe('windows::C:\\code\\hapi')
        expect(hapi.sessions[0]).toBe(worktree)
    })

    it('separates known owners, unknown owners on different machines, missing machines, and different projects', () => {
        const sessions = [session('alice', 'a', '/a/hapi'), session('bob', 'b', '/b/hapi'), session('unknown-c', 'c', '/c/hapi'), session('unknown-d', 'd', '/d/hapi'), session('no-machine-a', undefined, '/a/hapi'), session('no-machine-b', undefined, '/b/hapi'), session('fgo', 'a', '/code/fgo-agent'), session('maa', 'a', '/code/maa-agent')]
        expect(buildSidebarProjects(sessions, { a: 'alice', b: 'bob' }).projects).toHaveLength(8)
    })

    it('normalizes Windows separators and dot segments, but not distinct project aliases', () => {
        expect(normalizeProjectDirectory(' C:\\Code\\HAPI\\.\\ ')).toBe('c:/code/hapi')
        expect(normalizeProjectDirectory('/srv/code/old/../hapi/')).toBe('/srv/code/hapi')
        const model = buildSidebarProjects([session('one', 'a', 'C:\\Code\\HAPI\\'), session('two', 'b', '/code/hapi'), session('three', 'a', 'C:\\Code\\hapi-beta')], { a: 'alice', b: 'alice' })
        expect(model.projects.map(project => project.sessions.length).sort()).toEqual([1, 2])
    })

    it('collects temporary paths and exact home roots only, without swallowing named home projects', () => {
        for (const path of ['C:\\Users\\alice', '/Users/alice', '/home/alice', '/root', '~', '/', 'C:\\', 'C:\\Users\\alice\\AppData\\Local\\Temp\\canary', '/var/tmp/probe', '/srv/live-probe-123']) expect(isMiscellaneousDirectory(path)).toBe(true)
        for (const path of ['/Users/alice/hapi', '/home/alice/fgo-agent', '/root/maa-agent', '~/named-project', 'C:\\Users\\alice\\project', '/srv/template']) expect(isMiscellaneousDirectory(path)).toBe(false)
        const model = buildSidebarProjects([session('home', 'a', '/home/alice'), session('temp', 'a', '/tmp/probe'), session('project', 'a', '/home/alice/hapi')], { a: 'alice' })
        expect(model.projects.filter(project => project.miscellaneous).flatMap(project => project.sessions).map(row => row.id).sort()).toEqual(['home', 'temp'])
        expect(model.projects.filter(project => !project.miscellaneous).flatMap(project => project.sessions).map(row => row.id)).toEqual(['project'])
    })

    it('uses runner-recorded custom home roots without collecting their normal project children', () => {
        const model = buildSidebarProjects([session('home', 'a', 'D:\\profiles\\alice'), session('project', 'a', 'D:\\profiles\\alice\\hapi')], { a: 'alice' }, new Map(), { a: 'D:\\profiles\\alice\\' })
        expect(model.projects.filter(project => project.miscellaneous).flatMap(project => project.sessions).map(row => row.id)).toEqual(['home'])
        expect(model.projects.filter(project => !project.miscellaneous).flatMap(project => project.sessions).map(row => row.id)).toEqual(['project'])
    })

    it('orders favorites before active projects and then recency, taking phase only from real digests', () => {
        const active = { ...session('active', 'a', '/code/active', 20), active: true }
        const sessions = [session('favorite', 'a', '/code/favorite', 1), active, session('recent', 'a', '/code/recent', 30)]
        const digest: ProjectDigest = { projectKey: 'a::/code/active', machineId: 'a', path: '/code/active', overview: 'Real summary', stage: 'Review', stageReason: '', capabilities: [], artifacts: [], status: '', todo: [], judgement: '', model: 'model', generatedAt: 10, error: null }
        const projects = buildSidebarProjects(sessions, { a: 'alice' }, new Map([[digest.projectKey, digest]])).projects
        const favorite = projects.find(project => project.displayName === 'favorite')!
        expect(sortSidebarProjects(projects, { [favorite.favoriteKey]: true }).map(project => project.displayName)).toEqual(['favorite', 'active', 'recent'])
        expect(projects.find(project => project.displayName === 'active')!.digest).toBe(digest)
        expect(favorite.digest).toBeUndefined()
        expect(projects.find(project => project.displayName === 'active')!.activeCount).toBe(1)
    })
})
