import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AxiosInstance } from 'axios'
import { loadSessionRelayConfig, parseSessionRelayConfig } from '../../../fork-features/session-relay/config'
import {
    SessionRelayController,
    type RelayContextUsage,
    type SessionRelayDeps,
    type SessionRelayLaunch
} from '../../../fork-features/session-relay/controller'
import { createSessionRelayHub } from '../../../fork-features/session-relay/hubClient'

const MINUTE = 60_000

function harness(overrides: Partial<SessionRelayDeps> = {}) {
    let clock = 1_000_000
    let usage: RelayContextUsage | null = { tokens: 20_000, contextWindow: 200_000 }
    let mtime: number | null = null
    let idle = false
    const sent: Array<{ sessionId: string; text: string; steer: boolean }> = []
    const spawned: SessionRelayLaunch[] = []
    const archived: string[] = []
    const notices: string[] = []
    const abortRun = vi.fn(async () => { idle = true })
    const hub = {
        sendMessage: vi.fn(async (sessionId: string, text: string, options?: { steer?: boolean }) => {
            sent.push({ sessionId, text, steer: options?.steer === true })
        }),
        spawnSession: vi.fn(async (launch: SessionRelayLaunch) => {
            spawned.push(launch)
            return 'successor-1'
        }),
        archiveSession: vi.fn(async (sessionId: string) => {
            archived.push(sessionId)
        })
    }
    const controller = new SessionRelayController({
        config: parseSessionRelayConfig({}),
        sessionId: 'session-old',
        directory: 'C:/Users/bobmc/maa-agent',
        hub,
        readContextUsage: async () => usage,
        launchSettings: () => ({ machineId: 'machine-4sq', model: 'cx2cc/gpt-6.1-sol', effort: 'high', permissionMode: 'yolo' }),
        handoffFileMtimeMs: async () => mtime,
        isIdle: () => idle,
        abortRun,
        notify: (message) => notices.push(message),
        log: () => {},
        now: () => clock,
        ...overrides
    })
    return {
        controller,
        hub,
        sent,
        spawned,
        archived,
        notices,
        abortRun,
        setUsage: (next: RelayContextUsage | null) => { usage = next },
        writeHandoff: () => { mtime = clock },
        setIdle: (next: boolean) => { idle = next },
        advance: (ms: number) => { clock += ms }
    }
}

describe('SessionRelayController', () => {
    it('stays quiet below the thresholds', async () => {
        const h = harness()
        await h.controller.tick()
        h.setUsage({ tokens: 45_000, contextWindow: 200_000 })
        await h.controller.tick()
        expect(h.sent).toEqual([])
        expect(h.controller.currentPhase).toBe('watching')
    })

    it('steers the running agent to write the handover once the token threshold is crossed', async () => {
        const h = harness()
        await h.controller.tick()
        h.setUsage({ tokens: 52_000, contextWindow: 200_000 })
        await h.controller.tick()

        expect(h.sent).toHaveLength(1)
        expect(h.sent[0]).toMatchObject({ sessionId: 'session-old', steer: true })
        expect(h.sent[0]!.text).toContain('_build/HANDOVER.md')
        expect(h.sent[0]!.text).toContain('RELAY-READY')
        expect(h.controller.currentPhase).toBe('requested')
    })

    it('does not relay a session that started out large until its context has grown', async () => {
        const h = harness()
        h.setUsage({ tokens: 55_000, contextWindow: 200_000 })
        await h.controller.tick()
        expect(h.sent).toEqual([])
        h.setUsage({ tokens: 64_000, contextWindow: 200_000 })
        await h.controller.tick()
        expect(h.sent).toEqual([])
        h.setUsage({ tokens: 66_000, contextWindow: 200_000 })
        await h.controller.tick()
        expect(h.sent).toHaveLength(1)
    })

    it('requests a handover right after OMP compacted, below the thresholds', async () => {
        const h = harness()
        await h.controller.tick()
        h.controller.onCompactionCompleted()
        await vi.waitFor(() => expect(h.sent).toHaveLength(1))
        expect(h.sent[0]!.text).toContain('自动压缩')
    })

    it('relays once the handover is written and the run has ended', async () => {
        const h = harness()
        await h.controller.tick()
        h.setUsage({ tokens: 52_000, contextWindow: 200_000 })
        await h.controller.tick()

        h.advance(2 * MINUTE)
        h.writeHandoff()
        await h.controller.tick()
        expect(h.spawned).toEqual([])

        h.setIdle(true)
        await h.controller.tick()

        expect(h.abortRun).not.toHaveBeenCalled()
        expect(h.spawned).toEqual([{
            machineId: 'machine-4sq',
            model: 'cx2cc/gpt-6.1-sol',
            effort: 'high',
            permissionMode: 'yolo',
            directory: 'C:/Users/bobmc/maa-agent',
            agent: 'omp'
        }])
        expect(h.sent[1]).toMatchObject({ sessionId: 'successor-1', steer: false })
        expect(h.sent[1]!.text).toContain('session-old')
        expect(h.sent[1]!.text).not.toContain('没有在时限内更新交接文件')
        expect(h.archived).toEqual(['session-old'])
        expect(h.notices.at(-1)).toContain('successor-1')
        expect(h.controller.currentPhase).toBe('done')
    })

    it('relays a run that keeps going once the handover file has settled', async () => {
        const h = harness()
        await h.controller.tick()
        h.setUsage({ tokens: 52_000, contextWindow: 200_000 })
        await h.controller.tick()
        h.advance(MINUTE)
        h.writeHandoff()
        h.advance(3 * MINUTE)
        await h.controller.tick()

        expect(h.abortRun).toHaveBeenCalledTimes(1)
        expect(h.spawned).toHaveLength(1)
        expect(h.archived).toEqual(['session-old'])
    })

    it('relays after the maximum wait even without a fresh handover, and tells the successor', async () => {
        const h = harness()
        await h.controller.tick()
        h.setUsage({ tokens: 52_000, contextWindow: 200_000 })
        await h.controller.tick()
        h.advance(44 * MINUTE)
        await h.controller.tick()
        expect(h.spawned).toEqual([])

        h.advance(MINUTE)
        await h.controller.tick()
        expect(h.abortRun).toHaveBeenCalledTimes(1)
        expect(h.spawned).toHaveLength(1)
        expect(h.sent[1]!.text).toContain('没有在时限内更新交接文件')
    })

    it('never spawns a second successor when archiving fails', async () => {
        const h = harness()
        h.hub.archiveSession.mockRejectedValueOnce(new Error('/api/sessions/session-old/archive: HTTP 503'))
        await h.controller.tick()
        h.setUsage({ tokens: 52_000, contextWindow: 200_000 })
        await h.controller.tick()
        h.writeHandoff()
        h.setIdle(true)
        await h.controller.tick()

        expect(h.spawned).toHaveLength(1)
        expect(h.archived).toEqual([])
        expect(h.notices.at(-1)).toContain('归档失败')

        h.advance(MINUTE / 2)
        await h.controller.tick()
        expect(h.archived).toEqual([])

        h.advance(MINUTE)
        await h.controller.tick()
        expect(h.spawned).toHaveLength(1)
        expect(h.sent.filter((message) => message.sessionId === 'successor-1')).toHaveLength(1)
        expect(h.archived).toEqual(['session-old'])
    })

    it('keeps the session running and retries later when the spawn fails', async () => {
        const h = harness()
        h.hub.spawnSession.mockRejectedValueOnce(new Error('spawn failed: RPC handler not registered'))
        await h.controller.tick()
        h.setUsage({ tokens: 52_000, contextWindow: 200_000 })
        await h.controller.tick()
        h.writeHandoff()
        h.setIdle(true)
        await h.controller.tick()

        expect(h.spawned).toEqual([])
        expect(h.archived).toEqual([])
        expect(h.notices.at(-1)).toContain('本会话继续运行')

        h.advance(31 * MINUTE)
        await h.controller.tick()
        expect(h.spawned).toHaveLength(1)
        expect(h.archived).toEqual(['session-old'])
    })
})

describe('loadSessionRelayConfig', () => {
    const dirs: string[] = []
    afterEach(async () => {
        for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
    })

    async function project(content?: string): Promise<string> {
        const dir = await mkdtemp(join(tmpdir(), 'hapi-relay-'))
        dirs.push(dir)
        if (content !== undefined) {
            await mkdir(join(dir, '.hapi'))
            await writeFile(join(dir, '.hapi', 'session-relay.json'), content)
        }
        return dir
    }

    it('is off for projects without the file', async () => {
        expect(await loadSessionRelayConfig(await project())).toBeNull()
    })

    it('fills defaults, accepts a BOM, and honours enabled=false', async () => {
        const config = await loadSessionRelayConfig(await project('\uFEFF{"thresholdTokens": 40000}'))
        expect(config).toMatchObject({ thresholdTokens: 40_000, thresholdPercent: 60, handoffFile: '_build/HANDOVER.md' })
        expect(await loadSessionRelayConfig(await project('{"enabled": false}'))).toBeNull()
    })

    it('rejects an invalid file instead of guessing', async () => {
        await expect(loadSessionRelayConfig(await project('{"thresholdPercent": 150}'))).rejects.toThrow()
    })
})

describe('createSessionRelayHub', () => {
    it('authenticates with the CLI token, steers with ompInputMode, and re-authenticates on 401', async () => {
        const calls: Array<{ url: string; body: unknown; auth?: string }> = []
        let messageAttempts = 0
        const http = {
            post: vi.fn(async (url: string, body: unknown, config: { headers: Record<string, string> }) => {
                calls.push({ url, body, auth: config.headers.Authorization })
                if (url.endsWith('/api/auth')) return { status: 200, data: { token: `jwt-${calls.length}` } }
                if (url.includes('/messages')) {
                    messageAttempts += 1
                    return messageAttempts === 1 ? { status: 401, data: {} } : { status: 200, data: { ok: true } }
                }
                if (url.includes('/spawn')) return { status: 200, data: { type: 'success', sessionId: 'new-1' } }
                return { status: 200, data: { ok: true } }
            })
        } as unknown as AxiosInstance
        const hub = createSessionRelayHub({ apiUrl: 'https://hub.example/', accessToken: 'cli-token', http })

        await hub.sendMessage('old-1', 'write the handover', { steer: true })
        const newId = await hub.spawnSession({ machineId: 'm-1', directory: 'C:/p', agent: 'omp', model: 'cx2cc/gpt-6.1-sol' })
        await hub.archiveSession('old-1')

        expect(newId).toBe('new-1')
        expect(calls[0]).toMatchObject({ url: 'https://hub.example/api/auth', body: { accessToken: 'cli-token' } })
        const messageCalls = calls.filter((call) => call.url.endsWith('/api/sessions/old-1/messages'))
        expect(messageCalls).toHaveLength(2)
        expect(messageCalls[1]!.body).toMatchObject({ text: 'write the handover', ompInputMode: 'steer' })
        expect(messageCalls[1]!.auth).not.toBe(messageCalls[0]!.auth)
        expect(calls.find((call) => call.url.endsWith('/api/machines/m-1/spawn'))?.body).toEqual({
            directory: 'C:/p', agent: 'omp', sessionType: 'simple', model: 'cx2cc/gpt-6.1-sol'
        })
        expect(calls.at(-1)?.url).toBe('https://hub.example/api/sessions/old-1/archive')
    })

    it('waits for a just-spawned session to attach before sending it the kickoff', async () => {
        let clock = 0
        let posts = 0
        let polls = 0
        const http = {
            post: vi.fn(async (url: string) => {
                if (url.endsWith('/api/auth')) return { status: 200, data: { token: 'jwt' } }
                posts += 1
                return posts === 1
                    ? { status: 409, data: { error: 'Session is inactive', code: 'session_inactive' } }
                    : { status: 200, data: { ok: true } }
            }),
            get: vi.fn(async () => {
                polls += 1
                return { status: 200, data: { session: { active: polls >= 3 } } }
            })
        } as unknown as AxiosInstance
        const hub = createSessionRelayHub({
            apiUrl: 'https://hub.example',
            accessToken: 'cli-token',
            http,
            sleep: async (ms) => { clock += ms },
            now: () => clock
        })

        await hub.sendMessage('new-1', 'kickoff')

        expect(posts).toBe(2)
        expect(polls).toBe(3)
    })

    it('gives up when the spawned session never attaches', async () => {
        let clock = 0
        const http = {
            post: vi.fn(async (url: string) => (url.endsWith('/api/auth')
                ? { status: 200, data: { token: 'jwt' } }
                : { status: 409, data: { error: 'Session is inactive', code: 'session_inactive' } })),
            get: vi.fn(async () => ({ status: 200, data: { session: { active: false } } }))
        } as unknown as AxiosInstance
        const hub = createSessionRelayHub({
            apiUrl: 'https://hub.example',
            accessToken: 'cli-token',
            http,
            sleep: async (ms) => { clock += ms },
            now: () => clock
        })

        await expect(hub.sendMessage('new-1', 'kickoff')).rejects.toThrow('did not become active')
    })

    it('surfaces a spawn error from the hub', async () => {
        const http = {
            post: vi.fn(async (url: string) => (url.endsWith('/api/auth')
                ? { status: 200, data: { token: 'jwt' } }
                : { status: 200, data: { type: 'error', message: 'RPC handler not registered' } }))
        } as unknown as AxiosInstance
        const hub = createSessionRelayHub({ apiUrl: 'https://hub.example', accessToken: 'cli-token', http })
        await expect(hub.spawnSession({ machineId: 'm-1', directory: 'C:/p', agent: 'omp' })).rejects.toThrow('RPC handler not registered')
    })
})
