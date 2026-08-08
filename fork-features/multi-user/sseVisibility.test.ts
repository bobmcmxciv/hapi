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
        const subscribeAt = route.indexOf('manager.subscribe({')
        expect(subscribeAt).toBeGreaterThan(0)
        // 谓词在订阅之前构造好，并且真的传进了每一条订阅。
        expect(route.slice(0, subscribeAt)).toContain('canDeliver')
        expect(route.slice(subscribeAt, subscribeAt + 600)).toContain('canDeliver,')
    })
})

describe('机器授权向下继承：该机器上新建的会话事件必须投递', () => {
    /** fa608 授权给 mnmn66；s-new 是 admin 刚在 fa608 上建的会话，owner 不是 mnmn66 也没有会话级 grant。 */
    function setupMachineGrant() {
        const store = new MultiUserGatewayStore(':memory:')
        const ownerId = store.createAccount('admin-user', 'user', 'default', 'x').id
        const granteeId = store.createAccount('mnmn66', 'user', 'default', 'x').id
        store.bindResource({ resourceType: 'machine', resourceId: 'fa608', ownerAccountId: ownerId, coreNamespace: 'default' })
        store.bindResource({ resourceType: 'machine', resourceId: 'vircs', ownerAccountId: ownerId, coreNamespace: 'default' })
        store.bindResource({ resourceType: 'session', resourceId: 's-new', ownerAccountId: ownerId, coreNamespace: 'default' })
        store.bindResource({ resourceType: 'session', resourceId: 's-other-machine', ownerAccountId: ownerId, coreNamespace: 'default' })
        store.grant('machine', 'fa608', granteeId, 'viewer')
        const machineOf: Record<string, string> = { 's-new': 'fa608', 's-other-machine': 'vircs', 's-unbound': 'fa608' }
        return { store, granteeId, resolve: (id: string) => machineOf[id] ?? null }
    }

    it('被授权机器上的新会话事件放行', () => {
        const { store, granteeId, resolve } = setupMachineGrant()
        const predicate = createSseEventFilterFactory(store, resolve)(granteeId)!
        expect(predicate(sessionEvent('s-new'))).toBe(true)
        store.close()
    })

    it('未授权机器上的会话事件仍然拦下', () => {
        const { store, granteeId, resolve } = setupMachineGrant()
        const predicate = createSseEventFilterFactory(store, resolve)(granteeId)!
        expect(predicate(sessionEvent('s-other-machine'))).toBe(false)
        store.close()
    })

    it('尚未绑定但已在被授权机器上的会话也放行（创建瞬间的窗口）', () => {
        const { store, granteeId, resolve } = setupMachineGrant()
        const predicate = createSseEventFilterFactory(store, resolve)(granteeId)!
        expect(predicate(sessionEvent('s-unbound'))).toBe(true)
        store.close()
    })

    it('未绑定会话的放行窗口只限本账号 namespace —— 别人 namespace 里的一律不给', () => {
        const { store, granteeId, resolve } = setupMachineGrant()
        const predicate = createSseEventFilterFactory(store, resolve)(granteeId)!
        const foreign = { type: 'session-updated', namespace: 'someone-else', sessionId: 'nobody-bound-me', data: {} } as unknown as SyncEvent
        expect(predicate(foreign)).toBe(false)
        // 同一条会话若落在自己的 namespace 里，窗口仍然保留
        expect(predicate(sessionEvent('nobody-bound-me'))).toBe(true)
        store.close()
    })
})

describe('toast（提醒弹窗）同样要过谓词', () => {
    function toast(sessionId: string, namespace?: string): SyncEvent {
        return {
            type: 'toast',
            ...(namespace ? { namespace } : {}),
            data: {
                title: 'Task completed',
                body: 'Claude · session-owned · done',
                sessionId,
                url: `/sessions/${sessionId}`
            }
        } as unknown as SyncEvent
    }

    it('别人会话的提醒拦下，owner/grantee 的放行', () => {
        // toast 的 sessionId 藏在 data 里；只看顶层字段的谓词对它恒真，
        // 于是「完成提醒」照旧串给同 namespace 的所有账号。
        const { store, ownerId, strangerId, granteeId } = setupStore()
        const factory = createSseEventFilterFactory(store)
        expect(factory(ownerId)!(toast('session-owned'))).toBe(true)
        expect(factory(granteeId)!(toast('session-owned'))).toBe(true)
        expect(factory(strangerId)!(toast('session-owned'))).toBe(false)
    })

    it('被授权机器上的会话，提醒随继承一起放行', () => {
        const store = new MultiUserGatewayStore(':memory:')
        const ownerId = store.createAccount('admin-user', 'user', 'default', 'x').id
        const granteeId = store.createAccount('mnmn66', 'user', 'default', 'x').id
        store.bindResource({ resourceType: 'machine', resourceId: 'fa608', ownerAccountId: ownerId, coreNamespace: 'default' })
        store.bindResource({ resourceType: 'machine', resourceId: 'vircs', ownerAccountId: ownerId, coreNamespace: 'default' })
        store.bindResource({ resourceType: 'session', resourceId: 's-fa608', ownerAccountId: ownerId, coreNamespace: 'default' })
        store.bindResource({ resourceType: 'session', resourceId: 's-vircs', ownerAccountId: ownerId, coreNamespace: 'default' })
        store.grant('machine', 'fa608', granteeId, 'viewer')
        const resolve = (id: string) => (id === 's-fa608' ? 'fa608' : 'vircs')
        const predicate = createSseEventFilterFactory(store, resolve)(granteeId)!
        expect(predicate(toast('s-fa608'))).toBe(true)
        expect(predicate(toast('s-vircs'))).toBe(false)
        store.close()
    })

    it('未绑定会话的短暂窗口对 toast 一样生效（sendToast 会补上 namespace）', () => {
        const { store, strangerId } = setupStore()
        const predicate = createSseEventFilterFactory(store)(strangerId)!
        expect(predicate(toast('session-unbound', 'default'))).toBe(true)
        expect(predicate(toast('session-unbound', 'someone-else'))).toBe(false)
    })

    it('经 SSEManager.sendToast 投递：提醒只到达 owner/grantee/admin 的连接', async () => {
        // 2026-08-08 回归：谓词只挂在 broadcast 上，sendToast 只看 namespace + visible，
        // 于是 mnmn66 照旧收到别人会话的完成提醒（点进去 403）。
        const { store, adminId, ownerId, strangerId, granteeId } = setupStore()
        const factory = createSseEventFilterFactory(store)
        const manager = new SSEManager(0, new VisibilityTracker())
        const received: string[] = []
        for (const [name, accountId] of [['admin', adminId], ['bob', ownerId], ['mnmn66', strangerId], ['peter', granteeId]] as const) {
            manager.subscribe({
                id: `conn-${name}`,
                namespace: 'default',
                all: true,
                visibility: 'visible',
                canDeliver: factory(accountId) ?? undefined,
                send: () => { received.push(name) },
                sendHeartbeat: () => undefined
            })
        }

        const delivered = await manager.sendToast('default', toast('session-owned') as Extract<SyncEvent, { type: 'toast' }>)

        expect(delivered).toBe(3)
        expect(received.sort()).toEqual(['admin', 'bob', 'peter'])
    })

    it('身份解析不出来时，toast 也 fail-closed', async () => {
        const { store } = setupStore()
        const filter = createSseRequestFilterFactory(store, async () => null)
        const predicate = await filter(new Request('https://hub/api/events?all=true'))
        expect(predicate!(toast('session-owned'))).toBe(false)
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
