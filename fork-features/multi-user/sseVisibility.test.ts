import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SSEManager } from '../../hub/src/sse/sseManager'
import { VisibilityTracker } from '../../hub/src/visibility/visibilityTracker'
import type { SyncEvent } from '../../hub/src/sync/syncEngine'
import { MultiUserGatewayStore } from './gatewayStore'
import { createSseEventFilterFactory, createSseRequestFilterFactory } from './sseVisibility'

function setupStore(): { store: MultiUserGatewayStore; adminId: number; ownerId: number; strangerId: number; granteeId: number } {
    const store = new MultiUserGatewayStore(':memory:')
    const adminId = store.createAccount('root', 'admin', 'default', 'x').id
    const ownerId = store.createAccount('bob', 'user', 'default', 'x').id
    const strangerId = store.createAccount('mnmn66', 'user', 'default', 'x').id
    const granteeId = store.createAccount('peter', 'user', 'default', 'x').id
    store.bindResource({ resourceType: 'session', resourceId: 'session-owned', ownerAccountId: ownerId, coreNamespace: 'default' })
    store.grant('session', 'session-owned', granteeId, 'viewer')
    store.bindResource({ resourceType: 'machine', resourceId: 'machine-owned', ownerAccountId: ownerId, coreNamespace: 'default' })
    return { store, adminId, ownerId, strangerId, granteeId }
}

function sessionEvent(sessionId: string): SyncEvent {
    return { type: 'session-updated', namespace: 'default', sessionId, data: {} } as unknown as SyncEvent
}

describe('createSseEventFilterFactory：SSE 事件的账号可见性', () => {
    it('admin 不过滤（返回 null）', () => {
        const { store, adminId } = setupStore()
        expect(createSseEventFilterFactory(store)(adminId)).toBeNull()
    })

    it('owner 与 grantee 可收到绑定会话的事件，无关账号收不到', () => {
        const { store, ownerId, strangerId, granteeId } = setupStore()
        const factory = createSseEventFilterFactory(store)
        const event = sessionEvent('session-owned')
        expect(factory(ownerId)!(event)).toBe(true)
        expect(factory(granteeId)!(event)).toBe(true)
        expect(factory(strangerId)!(event)).toBe(false)
    })

    it('未绑定的会话事件放行（bind-on-view 前的短暂窗口）', () => {
        const { store, strangerId } = setupStore()
        const factory = createSseEventFilterFactory(store)
        expect(factory(strangerId)!(sessionEvent('session-unbound'))).toBe(true)
    })

    it('machine 事件按 machine 归属过滤', () => {
        const { store, ownerId, strangerId } = setupStore()
        const factory = createSseEventFilterFactory(store)
        const event = { type: 'machine-updated', namespace: 'default', machineId: 'machine-owned', data: {} } as unknown as SyncEvent
        expect(factory(ownerId)!(event)).toBe(true)
        expect(factory(strangerId)!(event)).toBe(false)
    })

    it('不携带资源 id 的事件放行', () => {
        const { store, strangerId } = setupStore()
        const factory = createSseEventFilterFactory(store)
        const event = { type: 'connection-changed', data: { status: 'connected' } } as unknown as SyncEvent
        expect(factory(strangerId)!(event)).toBe(true)
    })

    it('经 SSEManager 投递：完成事件只到达 owner/grantee/admin 的连接', () => {
        const { store, adminId, ownerId, strangerId, granteeId } = setupStore()
        const factory = createSseEventFilterFactory(store)
        const manager = new SSEManager(60_000, new VisibilityTracker())
        const received = new Map<string, SyncEvent[]>()
        for (const [name, accountId] of [['admin', adminId], ['bob', ownerId], ['mnmn66', strangerId], ['peter', granteeId]] as const) {
            received.set(name, [])
            manager.subscribe({
                id: `conn-${name}`,
                namespace: 'default',
                all: true,
                canDeliver: factory(accountId) ?? undefined,
                send: (event) => { received.get(name)!.push(event) },
                sendHeartbeat: () => undefined
            })
        }

        manager.broadcast(sessionEvent('session-owned'))

        expect(received.get('admin')).toHaveLength(1)
        expect(received.get('bob')).toHaveLength(1)
        expect(received.get('peter')).toHaveLength(1)
        expect(received.get('mnmn66')).toHaveLength(0)
    })
})

describe('createSseRequestFilterFactory：身份取 gaid 而非 uid', () => {
    it('用被授权账号的 gaid 解析时，能收到该会话事件', async () => {
        const { store, granteeId } = setupStore()
        const filter = createSseRequestFilterFactory(store, async () => granteeId)
        const predicate = await filter(new Request('https://hub/api/events?all=true'))
        expect(predicate!(sessionEvent('session-owned'))).toBe(true)
    })

    it('无关账号的 gaid 仍被拦截', async () => {
        const { store, strangerId } = setupStore()
        const filter = createSseRequestFilterFactory(store, async () => strangerId)
        const predicate = await filter(new Request('https://hub/api/events?all=true'))
        expect(predicate!(sessionEvent('session-owned'))).toBe(false)
    })

    it('解析不出账号时 fail-closed：带资源 id 的事件一律不投递', async () => {
        const { store } = setupStore()
        const filter = createSseRequestFilterFactory(store, async () => null)
        const predicate = await filter(new Request('https://hub/api/events?all=true'))
        expect(predicate!(sessionEvent('session-owned'))).toBe(false)
        expect(predicate!({ type: 'connection-changed', data: {} } as never)).toBe(true)
    })
})

describe('executionMount 的 /api/events 才是真实路由（回归钉）', () => {
    it('fork 自己的 SSE 路由必须给 all:true 订阅装上谓词', () => {
        // 2026-08-02 生产事故：修复挂在 hub/src/web/routes/events.ts 上，
        // 但 fork 在 executionMount 里注册了自己的 /api/events 且先生效，
        // 于是过滤形同虚设——ns=default 的账号仍收到全命名空间事件。
        const source = readFileSync(join(import.meta.dir, 'executionMount.ts'), 'utf8')
        const route = source.slice(source.indexOf("app.get('/api/events'"))
        expect(route).toContain('createSseEventFilterFactory')
        expect(route.slice(0, route.indexOf('subscribe({ namespace: account.defaultNamespace, all: true })')))
            .toContain('canDeliver')
    })
})

describe('owner 自己的资源：谓词必须放行（否则 all 订阅拦下、bindings 又不订阅）', () => {
    it('owner 能收到自己拥有的会话事件', () => {
        const { store, ownerId } = setupStore()
        const predicate = createSseEventFilterFactory(store)(ownerId)!
        // executionMount 的 bindings 用 ownerAccountId !== account.id 过滤，
        // 自有资源只靠 `all: true` 那条订阅送达——谓词一旦误拦就彻底收不到。
        expect(predicate(sessionEvent('session-owned'))).toBe(true)
    })

    it('grantee 同时被 all 订阅与精确订阅覆盖，两条都应放行', () => {
        const { store, granteeId } = setupStore()
        const predicate = createSseEventFilterFactory(store)(granteeId)!
        expect(predicate(sessionEvent('session-owned'))).toBe(true)
    })
})
