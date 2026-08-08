import { afterEach, describe, expect, it } from 'vitest'
import { MultiUserGatewayStore } from './gatewayStore'
import { ExecutionDispatcher } from './executionDispatcher'

const stores: MultiUserGatewayStore[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close() })

describe('ExecutionDispatcher', () => {
    it('routes owner and operator through the resource core namespace without changing core state', () => {
        const store = new MultiUserGatewayStore(':memory:')
        stores.push(store)
        const owner = store.createAccount('owner', 'user', 'account-owner')
        const operator = store.createAccount('operator', 'user', 'account-operator')
        store.bindResource({ resourceType: 'machine', resourceId: 'm1', ownerAccountId: owner.id, coreNamespace: 'runtime-a' })
        store.grant('machine', 'm1', operator.id, 'operator')
        const dispatcher = new ExecutionDispatcher(store)

        expect(dispatcher.authorize({ accountId: operator.id, capability: 'operate', resource: { type: 'machine', id: 'm1' } }))
            .toMatchObject({ kind: 'allow', context: { namespace: 'runtime-a' } })
    })

    it('keeps viewer read-only and stranger isolated', () => {
        const store = new MultiUserGatewayStore(':memory:')
        stores.push(store)
        const owner = store.createAccount('owner', 'user', 'owner-ns')
        const viewer = store.createAccount('viewer', 'user', 'viewer-ns')
        const stranger = store.createAccount('stranger', 'user', 'stranger-ns')
        store.bindResource({ resourceType: 'session', resourceId: 's1', ownerAccountId: owner.id, coreNamespace: 'runtime-a' })
        store.grant('session', 's1', viewer.id, 'viewer')
        const dispatcher = new ExecutionDispatcher(store)

        expect(dispatcher.authorize({ accountId: viewer.id, capability: 'read', resource: { type: 'session', id: 's1' } }).kind).toBe('allow')
        expect(dispatcher.authorize({ accountId: viewer.id, capability: 'operate', resource: { type: 'session', id: 's1' } })).toEqual({ kind: 'deny', reason: 'insufficient-access' })
        expect(dispatcher.authorize({ accountId: stranger.id, capability: 'read', resource: { type: 'session', id: 's1' } })).toEqual({ kind: 'deny', reason: 'insufficient-access' })
    })

    describe('会话继承所在机器的授权', () => {
        /** m1 授权给 grantee，s-on-m1 跑在 m1 上但 owner 是别人、且没有会话级 grant。 */
        function seedMachineGrant(role: 'viewer' | 'operator') {
            const store = new MultiUserGatewayStore(':memory:')
            stores.push(store)
            const owner = store.createAccount('owner', 'user', 'default')
            const grantee = store.createAccount('mnmn66', 'user', 'default')
            store.bindResource({ resourceType: 'machine', resourceId: 'm1', ownerAccountId: owner.id, coreNamespace: 'default' })
            store.bindResource({ resourceType: 'session', resourceId: 's-on-m1', ownerAccountId: owner.id, coreNamespace: 'default' })
            store.bindResource({ resourceType: 'session', resourceId: 's-on-m2', ownerAccountId: owner.id, coreNamespace: 'default' })
            store.grant('machine', 'm1', grantee.id, role)
            const machineOf: Record<string, string> = { 's-on-m1': 'm1', 's-on-m2': 'm2' }
            const dispatcher = new ExecutionDispatcher(store, (id) => machineOf[id] ?? null)
            return { dispatcher, grantee }
        }

        it('机器 viewer 能读机器上的新会话，但不能操作', () => {
            const { dispatcher, grantee } = seedMachineGrant('viewer')
            expect(dispatcher.authorize({ accountId: grantee.id, capability: 'read', resource: { type: 'session', id: 's-on-m1' } }).kind).toBe('allow')
            expect(dispatcher.authorize({ accountId: grantee.id, capability: 'operate', resource: { type: 'session', id: 's-on-m1' } }))
                .toEqual({ kind: 'deny', reason: 'insufficient-access' })
        })

        it('机器 operator 能操作机器上的新会话', () => {
            const { dispatcher, grantee } = seedMachineGrant('operator')
            expect(dispatcher.authorize({ accountId: grantee.id, capability: 'operate', resource: { type: 'session', id: 's-on-m1' } }).kind).toBe('allow')
        })

        it('继承不外溢：别的机器上的会话仍然拒绝', () => {
            const { dispatcher, grantee } = seedMachineGrant('operator')
            expect(dispatcher.authorize({ accountId: grantee.id, capability: 'read', resource: { type: 'session', id: 's-on-m2' } }))
                .toEqual({ kind: 'deny', reason: 'insufficient-access' })
        })

        it('继承不代表 administer：机器 operator 不能改会话授权', () => {
            const { dispatcher, grantee } = seedMachineGrant('operator')
            expect(dispatcher.authorize({ accountId: grantee.id, capability: 'administer', resource: { type: 'session', id: 's-on-m1' } }))
                .toEqual({ kind: 'deny', reason: 'insufficient-access' })
        })
    })
})
