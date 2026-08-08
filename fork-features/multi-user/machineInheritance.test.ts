import { describe, expect, it } from 'bun:test'
import type { SyncEngine } from '../../hub/src/sync/syncEngine'
import { MultiUserGatewayStore } from './gatewayStore'
import { createSessionMachineResolver, sessionAccessLevel } from './machineInheritance'

function setup() {
    const store = new MultiUserGatewayStore(':memory:')
    const admin = store.createAccount('admin', 'admin', 'default', null)
    const owner = store.createAccount('owner', 'user', 'default', null)
    const grantee = store.createAccount('mnmn66', 'user', 'default', null)
    const stranger = store.createAccount('stranger', 'user', 'default', null)
    store.bindResource({ resourceType: 'machine', resourceId: 'fa608', ownerAccountId: owner.id, coreNamespace: 'default' })
    store.bindResource({ resourceType: 'machine', resourceId: 'other-machine', ownerAccountId: owner.id, coreNamespace: 'default' })
    // admin 在 fa608 上新建的会话：owner 是创建者，没有任何指向 mnmn66 的 grant。
    store.bindResource({ resourceType: 'session', resourceId: 's-on-fa608', ownerAccountId: owner.id, coreNamespace: 'default' })
    store.bindResource({ resourceType: 'session', resourceId: 's-elsewhere', ownerAccountId: owner.id, coreNamespace: 'default' })
    store.grant('machine', 'fa608', grantee.id, 'viewer')
    const machineOf: Record<string, string> = { 's-on-fa608': 'fa608', 's-elsewhere': 'other-machine' }
    const resolve = (sessionId: string) => machineOf[sessionId] ?? null
    return { store, admin, owner, grantee, stranger, resolve }
}

describe('sessionAccessLevel：会话继承所在机器的授权', () => {
    it('被授权机器上的会话对被授权人可读 —— 不需要再给会话单独授权', () => {
        const { store, grantee, resolve } = setup()
        expect(sessionAccessLevel(store, grantee.id, 's-on-fa608', resolve)).toBe('viewer')
        store.close()
    })

    it('没有 resolver 时行为与继承前一致（只看会话自身的 owner/grant）', () => {
        const { store, grantee } = setup()
        expect(sessionAccessLevel(store, grantee.id, 's-on-fa608')).toBe('none')
        store.close()
    })

    it('别的机器上的会话不会被顺带放开', () => {
        const { store, grantee, resolve } = setup()
        expect(sessionAccessLevel(store, grantee.id, 's-elsewhere', resolve)).toBe('none')
        store.close()
    })

    it('完全没被授权的账号仍然是 none', () => {
        const { store, stranger, resolve } = setup()
        expect(sessionAccessLevel(store, stranger.id, 's-on-fa608', resolve)).toBe('none')
        store.close()
    })

    it('取 max：会话上的 operator 不会被机器上的 viewer 降级', () => {
        const { store, grantee, resolve } = setup()
        store.grant('session', 's-on-fa608', grantee.id, 'operator')
        expect(sessionAccessLevel(store, grantee.id, 's-on-fa608', resolve)).toBe('operator')
        store.close()
    })

    it('取 max：机器上的 operator 也能抬高会话上的 viewer', () => {
        const { store, grantee, resolve } = setup()
        store.grant('session', 's-on-fa608', grantee.id, 'viewer')
        store.grant('machine', 'fa608', grantee.id, 'operator')
        expect(sessionAccessLevel(store, grantee.id, 's-on-fa608', resolve)).toBe('operator')
        store.close()
    })

    it('机器主人对机器上的会话是 owner', () => {
        const { store, owner, resolve } = setup()
        expect(sessionAccessLevel(store, owner.id, 's-on-fa608', resolve)).toBe('owner')
        store.close()
    })

    it('admin 恒为 owner', () => {
        const { store, admin, resolve } = setup()
        expect(sessionAccessLevel(store, admin.id, 's-elsewhere', resolve)).toBe('owner')
        store.close()
    })

    it('被禁用的账号即使有机器授权也是 none', () => {
        const { store, grantee, resolve } = setup()
        store.updateAccount(grantee.id, { disabled: true })
        expect(sessionAccessLevel(store, grantee.id, 's-on-fa608', resolve)).toBe('none')
        store.close()
    })
})

describe('createSessionMachineResolver：从属关系现查 core 侧 metadata', () => {
    it('取 session.metadata.machineId', () => {
        const engine = {
            getSession: (id: string) => id === 'known' ? { metadata: { machineId: 'fa608' } } : undefined
        } as unknown as SyncEngine
        const resolve = createSessionMachineResolver(() => engine)
        expect(resolve('known')).toBe('fa608')
        expect(resolve('missing')).toBeNull()
    })

    it('引擎未就绪 / 会话没有 machineId 时返回 null，不抛', () => {
        expect(createSessionMachineResolver(() => null)('any')).toBeNull()
        const engine = { getSession: () => ({ metadata: { host: 'FA608_INDEX' } }) } as unknown as SyncEngine
        expect(createSessionMachineResolver(() => engine)('any')).toBeNull()
    })
})
