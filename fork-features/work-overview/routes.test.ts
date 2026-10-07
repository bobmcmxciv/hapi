import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import type { SyncEngine } from '../../hub/src/sync/syncEngine'
import type { WebAppEnv } from '../../hub/src/web/middleware/auth'
import { MultiUserGatewayStore } from '../multi-user/gatewayStore'
import { mountExecutionRoutes } from '../multi-user/executionMount'
import { startWorkStore, stopWorkStore } from './workStore'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const jwtSecret = new TextEncoder().encode('test-secret-test-secret-test-secret')

/** 走真实的 mountExecutionRoutes：验证的是 hub 实际注册的那条账号解析 + admin 闸门。 */
describe('/api/work/* (admin only)', () => {
    let dataDir: string
    let gateway: MultiUserGatewayStore
    let app: Hono<WebAppEnv>
    let adminToken: string
    let userToken: string
    let disabledAdminToken: string

    const call = async (method: string, path: string, token: string | null, body?: unknown) => {
        const headers: Record<string, string> = { 'content-type': 'application/json' }
        if (token) headers.authorization = `Bearer ${token}`
        const response = await app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
        return { status: response.status, body: await response.json() as any }
    }

    beforeEach(async () => {
        dataDir = mkdtempSync(join(tmpdir(), 'work-overview-'))
        startWorkStore(dataDir)
        gateway = new MultiUserGatewayStore(':memory:')
        const admin = gateway.createAccount('admin', 'admin', 'default', null)
        const peter = gateway.createAccount('peter', 'user', 'default', null)
        const old = gateway.createAccount('old-admin', 'admin', 'default', null)
        gateway.updateAccount(old.id, { disabled: true })
        const sign = (id: number) => new SignJWT({ gaid: id }).setProtectedHeader({ alg: 'HS256' }).sign(jwtSecret)
        adminToken = await sign(admin.id)
        userToken = await sign(peter.id)
        disabledAdminToken = await sign(old.id)
        app = new Hono<WebAppEnv>()
        const engine = { getSessionsByNamespace: () => [], getSession: () => undefined } as unknown as SyncEngine
        mountExecutionRoutes(app, { store: gateway, jwtSecret, getSyncEngine: () => engine, getSseManager: () => null, getStore: () => null })
    })

    afterEach(() => {
        stopWorkStore()
        gateway.close()
        try {
            rmSync(dataDir, { recursive: true, force: true })
        } catch {
            // Windows 上 WAL 文件关闭后可能短暂占用，残留的临时目录无害
        }
    })

    test('non-admin gets 403 on every endpoint; missing or disabled identity gets 401', async () => {
        const requests: Array<[string, string, unknown?]> = [
            ['GET', '/api/work/map'],
            ['PUT', '/api/work/map', { lines: [], folders: [], sessions: [] }],
            ['PUT', '/api/work/lines', { id: 'm1', parentId: null, name: 'x' }],
            ['DELETE', '/api/work/lines/m1'],
            ['PUT', '/api/work/folders', { projectKey: 'k', mode: null }],
            ['PUT', '/api/work/sessions', { sessionId: 's', state: 'follow' }],
            ['PUT', '/api/work/dismissed', { sessionId: 's', dismissed: true }],
            ['GET', '/api/work/briefing'],
            ['POST', '/api/work/briefing/refresh', { lines: [], pending: [], active: [], recent: [], dismissed: [] }]
        ]
        for (const [method, path, body] of requests) {
            expect((await call(method, path, userToken, body)).status).toBe(403)
            expect((await call(method, path, null, body)).status).toBe(401)
            expect((await call(method, path, disabledAdminToken, body)).status).toBe(401)
        }
    })

    test('admin imports a map, edits it, and sees the result', async () => {
        const ok = await call('PUT', '/api/work/map', adminToken, {
            lines: [
                { id: 'm1', parentId: null, name: 'HAPI 与 AI 编程基础设施', goal: '', sort: 0 },
                { id: 'm1.s1', parentId: 'm1', name: 'HAPI 远程会话平台', goal: '', sort: 0 }
            ],
            folders: [{ projectKey: 'vircs::C:\\Users\\Administrator\\hapi', mode: 'line', lineId: 'm1.s1', project: 'HAPI' }],
            sessions: []
        })
        expect(ok.status).toBe(200)
        expect(ok.body.folders).toHaveLength(1)

        expect((await call('PUT', '/api/work/lines', adminToken, { id: 'm1.s2', parentId: 'm1', name: '模型网关 cx2cc' })).status).toBe(200)
        expect((await call('PUT', '/api/work/sessions', adminToken, { sessionId: 'home-1', state: 'line', lineId: 'm1.s2' })).status).toBe(200)
        expect((await call('PUT', '/api/work/folders', adminToken, { projectKey: 'tmp', mode: 'line', lineId: 'm1' })).status).toBe(400)

        const map = await call('GET', '/api/work/map', adminToken)
        expect(map.status).toBe(200)
        expect(map.body.lines.map((line: { id: string }) => line.id)).toEqual(['m1', 'm1.s1', 'm1.s2'])
        expect(map.body.sessions).toEqual([expect.objectContaining({ sessionId: 'home-1', lineId: 'm1.s2' })])
        expect(map.body.dismissed).toEqual([])
    })

    test('admin dismisses a session from "needs you" and restores it', async () => {
        const dismissed = await call('PUT', '/api/work/dismissed', adminToken, { sessionId: 'old-question', dismissed: true })
        expect(dismissed.status).toBe(200)
        expect(dismissed.body.dismissed).toEqual(['old-question'])
        expect((await call('GET', '/api/work/map', adminToken)).body.dismissed).toEqual(['old-question'])
        const restored = await call('PUT', '/api/work/dismissed', adminToken, { sessionId: 'old-question', dismissed: false })
        expect(restored.body.dismissed).toEqual([])
    })

    test('briefing starts empty and refresh is accepted (model is not configured in tests)', async () => {
        const empty = await call('GET', '/api/work/briefing', adminToken)
        expect(empty.status).toBe(200)
        expect(empty.body.briefing).toBeNull()
        const started = await call('POST', '/api/work/briefing/refresh', adminToken, { lines: [], pending: [], active: [], recent: [], dismissed: [] })
        expect(started.status).toBe(200)
        expect(started.body.running).toBe(true)
        for (let i = 0; i < 50; i += 1) {
            const state = await call('GET', '/api/work/briefing', adminToken)
            if (!state.body.running) {
                // 测试里没有摘要服务：记一次失败（带原因），不让按钮一直转。
                expect(state.body.briefing.error).toContain('Digest service')
                return
            }
            await new Promise(resolve => setTimeout(resolve, 20))
        }
        throw new Error('briefing did not finish')
    })

    test('invalid payloads are 400, not 500', async () => {
        expect((await call('PUT', '/api/work/map', adminToken, { lines: 'nope' })).status).toBe(400)
        expect((await call('PUT', '/api/work/sessions', adminToken, { sessionId: 's', state: 'line' })).status).toBe(400)
        expect((await call('DELETE', '/api/work/lines/missing', adminToken)).status).toBe(400)
        expect((await call('PUT', '/api/work/dismissed', adminToken, { sessionId: 's' })).status).toBe(400)
        expect((await call('POST', '/api/work/briefing/refresh', adminToken, { lines: 'x' })).status).toBe(400)
    })
})
