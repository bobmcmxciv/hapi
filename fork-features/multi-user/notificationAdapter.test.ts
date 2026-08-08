import { afterEach, describe, expect, it } from 'vitest'
import type { NotificationChannel } from '../../hub/src/notifications/notificationTypes'
import { PushNotificationChannel } from '../../hub/src/push/pushNotificationChannel'
import type { PushService } from '../../hub/src/push/pushService'
import { SSEManager } from '../../hub/src/sse/sseManager'
import { Store } from '../../hub/src/store'
import type { Session } from '../../hub/src/sync/syncEngine'
import { VisibilityTracker } from '../../hub/src/visibility/visibilityTracker'
import { MultiUserGatewayStore } from './gatewayStore'
import { createSseEventFilterFactory } from './sseVisibility'
import {
    createPushNotificationRouting,
    createTelegramNotificationNamespaceResolver,
    MultiUserNotificationAdapter
} from './notificationAdapter'

const stores: MultiUserGatewayStore[] = []
const coreStores: Store[] = []
afterEach(() => {
    for (const store of stores.splice(0)) store.close()
    for (const store of coreStores.splice(0)) store.close()
})

const session = { id: 's1', namespace: 'runtime', active: true } as Session

describe('MultiUserNotificationAdapter', () => {
    it('sends readable notifications to viewers but permission actions only to operators', async () => {
        const store = new MultiUserGatewayStore(':memory:')
        stores.push(store)
        const owner = store.createAccount('owner', 'user', 'owner-ns')
        const viewer = store.createAccount('viewer', 'user', 'viewer-ns')
        const operator = store.createAccount('operator', 'user', 'operator-ns')
        const admin = store.createAccount('admin', 'admin', 'admin-ns')
        store.bindResource({ resourceType: 'session', resourceId: 's1', ownerAccountId: owner.id, coreNamespace: 'runtime' })
        store.grant('session', 's1', viewer.id, 'viewer')
        store.grant('session', 's1', operator.id, 'operator')
        const ready: string[] = []
        const permission: string[] = []
        const downstream: NotificationChannel = {
            sendReady: async value => { ready.push(value.namespace) },
            sendPermissionRequest: async value => { permission.push(value.namespace) },
            sendTaskNotification: async () => {}
        }
        const adapter = new MultiUserNotificationAdapter(store, downstream)

        await adapter.sendReady(session)
        await adapter.sendPermissionRequest(session)

        expect(ready.sort()).toEqual(['admin-ns', 'operator-ns', 'owner-ns', 'viewer-ns'])
        expect(permission.sort()).toEqual(['admin-ns', 'operator-ns', 'owner-ns'])
    })

    it('机器上的授权同样进受众：被授权机器的人收得到该机器新会话的提醒', async () => {
        const store = new MultiUserGatewayStore(':memory:')
        stores.push(store)
        const owner = store.createAccount('owner', 'user', 'owner-ns')
        const machineViewer = store.createAccount('machine-viewer', 'user', 'machine-viewer-ns')
        const machineOperator = store.createAccount('machine-operator', 'user', 'machine-operator-ns')
        store.bindResource({ resourceType: 'session', resourceId: 's1', ownerAccountId: owner.id, coreNamespace: 'runtime' })
        store.bindResource({ resourceType: 'machine', resourceId: 'fa608', ownerAccountId: owner.id, coreNamespace: 'runtime' })
        store.grant('machine', 'fa608', machineViewer.id, 'viewer')
        store.grant('machine', 'fa608', machineOperator.id, 'operator')
        const ready: string[] = []
        const permission: string[] = []
        const downstream: NotificationChannel = {
            sendReady: async value => { ready.push(value.namespace) },
            sendPermissionRequest: async value => { permission.push(value.namespace) },
            sendTaskNotification: async () => {}
        }
        const adapter = new MultiUserNotificationAdapter(store, downstream)
        const onMachine = { ...session, metadata: { path: '/tmp', host: 'FA608_INDEX', machineId: 'fa608' } } as Session

        await adapter.sendReady(onMachine)
        await adapter.sendPermissionRequest(onMachine)

        expect(ready.sort()).toEqual(['machine-operator-ns', 'machine-viewer-ns', 'owner-ns'])
        // viewer 只读，权限请求不该发给他
        expect(permission.sort()).toEqual(['machine-operator-ns', 'owner-ns'])
    })

    it('会话不在被授权的机器上时受众不变', async () => {
        const store = new MultiUserGatewayStore(':memory:')
        stores.push(store)
        const owner = store.createAccount('owner', 'user', 'owner-ns')
        const machineViewer = store.createAccount('machine-viewer', 'user', 'machine-viewer-ns')
        store.bindResource({ resourceType: 'session', resourceId: 's1', ownerAccountId: owner.id, coreNamespace: 'runtime' })
        store.bindResource({ resourceType: 'machine', resourceId: 'fa608', ownerAccountId: owner.id, coreNamespace: 'runtime' })
        store.grant('machine', 'fa608', machineViewer.id, 'viewer')
        const ready: string[] = []
        const downstream: NotificationChannel = {
            sendReady: async value => { ready.push(value.namespace) },
            sendPermissionRequest: async () => {},
            sendTaskNotification: async () => {}
        }
        const adapter = new MultiUserNotificationAdapter(store, downstream)

        await adapter.sendReady({ ...session, metadata: { path: '/tmp', host: 'vircs', machineId: 'vircs' } } as Session)

        expect(ready.sort()).toEqual(['owner-ns'])
    })

    it('整条提醒链路：admin 会话完成时，同 namespace 的 mnmn66 收不到弹窗', async () => {
        // 复现 2026-08-08 的跨用户提醒回归。走的是生产真实装配：
        // MultiUserNotificationAdapter → PushNotificationChannel → SSEManager.sendToast，
        // 四个账号共享 core namespace `default`（历史账号都是这个）。
        const store = new MultiUserGatewayStore(':memory:')
        stores.push(store)
        const admin = store.createAccount('admin', 'admin', 'default')
        const owner = store.createAccount('bob', 'user', 'default')
        const grantee = store.createAccount('peter', 'user', 'default')
        const stranger = store.createAccount('mnmn66', 'user', 'default')
        store.bindResource({ resourceType: 'session', resourceId: 's1', ownerAccountId: owner.id, coreNamespace: 'default' })
        store.grant('session', 's1', grantee.id, 'viewer')

        const visibilityTracker = new VisibilityTracker()
        const sseManager = new SSEManager(0, visibilityTracker)
        const filterFor = createSseEventFilterFactory(store)
        const toasted: string[] = []
        for (const [name, accountId] of [['admin', admin.id], ['bob', owner.id], ['peter', grantee.id], ['mnmn66', stranger.id]] as const) {
            sseManager.subscribe({
                id: `conn-${name}`,
                namespace: 'default',
                all: true,
                visibility: 'visible',
                canDeliver: filterFor(accountId) ?? undefined,
                send: () => { toasted.push(name) },
                sendHeartbeat: () => {}
            })
        }

        const pushed: string[][] = []
        const pushService = {
            sendToNamespace: async (_ns: string, _payload: unknown, endpoints?: ReadonlySet<string>) => {
                pushed.push(Array.from(endpoints ?? []))
            }
        } as unknown as PushService
        const coreStore = new Store(':memory:')
        coreStores.push(coreStore)
        const routing = createPushNotificationRouting(store, coreStore)
        const channel = new PushNotificationChannel(
            pushService, sseManager, visibilityTracker, 'https://hub.test', routing.endpointsForAudience
        )
        const adapter = new MultiUserNotificationAdapter(store, channel, routing.namespacesForAccount)

        await adapter.sendTaskNotification(
            { id: 's1', namespace: 'default', active: true, metadata: { path: '/tmp/repo' } } as Session,
            { summary: 'refactor done' }
        )

        expect(toasted.sort()).toEqual(['admin', 'bob', 'peter'])
        // 有连接收到弹窗就不再退回 web push
        expect(pushed).toEqual([])
    })

    it('routes migrated Telegram and Push destinations through their account bindings', () => {
        const gatewayStore = new MultiUserGatewayStore(':memory:')
        const coreStore = new Store(':memory:')
        stores.push(gatewayStore)
        coreStores.push(coreStore)
        const owner = gatewayStore.createAccount('owner', 'user', 'account-owner')
        const viewer = gatewayStore.createAccount('viewer', 'user', 'account-viewer')
        gatewayStore.bindResource({
            resourceType: 'session',
            resourceId: session.id,
            ownerAccountId: owner.id,
            coreNamespace: session.namespace
        })
        gatewayStore.grant('session', session.id, viewer.id, 'viewer')

        coreStore.users.addUser('telegram', '42', 'telegram-tenant')
        gatewayStore.bindExternalIdentity({
            platform: 'telegram',
            platformUserId: '42',
            accountId: viewer.id
        })
        expect(createTelegramNotificationNamespaceResolver(gatewayStore, coreStore)(viewer.id))
            .toEqual(['telegram-tenant'])

        coreStore.push.addPushSubscription('push-tenant', {
            endpoint: 'https://push.test/viewer',
            p256dh: 'p256dh',
            auth: 'auth'
        })
        coreStore.push.addPushSubscription('push-tenant', {
            endpoint: 'https://push.test/legacy-unbound',
            p256dh: 'p256dh',
            auth: 'auth'
        })
        gatewayStore.bindPushSubscriptionAccount({
            namespace: 'push-tenant',
            endpoint: 'https://push.test/viewer',
            accountId: viewer.id
        })
        const routing = createPushNotificationRouting(gatewayStore, coreStore)
        expect(routing.namespacesForAccount(viewer.id)).toEqual(['push-tenant'])
        expect(Array.from(routing.endpointsForAudience(
            { ...session, namespace: 'push-tenant' },
            'operate'
        ) ?? []).sort()).toEqual(['https://push.test/legacy-unbound'])
        expect(Array.from(routing.endpointsForAudience(
            { ...session, namespace: 'push-tenant' },
            'read'
        ) ?? []).sort()).toEqual([
            'https://push.test/legacy-unbound',
            'https://push.test/viewer'
        ])
    })
})
