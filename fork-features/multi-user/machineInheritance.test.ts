import { describe, expect, it } from 'bun:test'
import type { SyncEngine } from '../../hub/src/sync/syncEngine'
import { MultiUserGatewayStore } from './gatewayStore'
import {
    createSessionMachineResolver,
    createSessionPathResolver,
    machineInheritedLevel,
    pathWithinScope,
    sessionAccessLevel
} from './machineInheritance'

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

describe('pathWithinScope：目录前缀判定', () => {
    const PREFIX = 'C:\\Users\\Administrator\\peter'

    it('前缀为空 = 未限定，恒真（保持加此列之前的行为）', () => {
        expect(pathWithinScope('C:\\anything', null)).toBe(true)
        expect(pathWithinScope('C:\\anything', undefined)).toBe(true)
        expect(pathWithinScope('C:\\anything', '   ')).toBe(true)
    })

    it('候选路径取不到 → 假（fail-closed，证明不了在范围内就算越界）', () => {
        expect(pathWithinScope(null, PREFIX)).toBe(false)
        expect(pathWithinScope(undefined, PREFIX)).toBe(false)
        expect(pathWithinScope('', PREFIX)).toBe(false)
    })

    it('目录自身与子目录为真', () => {
        expect(pathWithinScope(PREFIX, PREFIX)).toBe(true)
        expect(pathWithinScope('C:\\Users\\Administrator\\peter\\mac', PREFIX)).toBe(true)
        expect(pathWithinScope('C:\\Users\\Administrator\\peter\\mac\\_edit\\app', PREFIX)).toBe(true)
    })

    it('边界按整段比较：…\\peter 不匹配 …\\peterX 或 …\\peter-old', () => {
        expect(pathWithinScope('C:\\Users\\Administrator\\peterX', PREFIX)).toBe(false)
        expect(pathWithinScope('C:\\Users\\Administrator\\peter-old\\mac', PREFIX)).toBe(false)
    })

    it('父目录与旁系目录为假', () => {
        expect(pathWithinScope('C:\\Users\\Administrator', PREFIX)).toBe(false)
        expect(pathWithinScope('C:\\Users\\Administrator\\hapi', PREFIX)).toBe(false)
    })

    it('Windows 路径不区分大小写，分隔符可混用、可重复、可带尾巴', () => {
        expect(pathWithinScope('c:\\users\\administrator\\PETER\\Mac', PREFIX)).toBe(true)
        expect(pathWithinScope('C:/Users/Administrator/peter/mac', PREFIX)).toBe(true)
        expect(pathWithinScope('C:\\Users\\\\Administrator\\peter\\mac\\', PREFIX)).toBe(true)
        expect(pathWithinScope('C:\\Users\\Administrator\\peter\\mac', 'C:\\Users\\Administrator\\peter\\')).toBe(true)
    })

    it('POSIX 路径区分大小写', () => {
        expect(pathWithinScope('/Users/wu/proj', '/Users/wu')).toBe(true)
        expect(pathWithinScope('/users/WU/proj', '/Users/wu')).toBe(false)
        expect(pathWithinScope('/Users/wu2', '/Users/wu')).toBe(false)
    })

    it('含 .. 段一律拒 —— 不碰文件系统就解析不了它', () => {
        expect(pathWithinScope('C:\\Users\\Administrator\\peter\\..\\hapi', PREFIX)).toBe(false)
        expect(pathWithinScope('C:\\Users\\Administrator\\peter\\mac\\..', PREFIX)).toBe(false)
    })
})

describe('目录限定的机器授权（machineInheritedLevel / sessionAccessLevel）', () => {
    const SCOPE = 'C:\\Users\\Administrator\\peter'

    function scopedSetup() {
        const base = setup()
        const paths: Record<string, string> = {
            's-on-fa608': 'C:\\Users\\Administrator\\peter\\mac',
            's-elsewhere': 'C:\\Users\\Administrator\\hapi'
        }
        // 同一台机器上再放一条限定外的会话
        base.store.bindResource({
            resourceType: 'session', resourceId: 's-outside', ownerAccountId: base.owner.id, coreNamespace: 'default'
        })
        paths['s-outside'] = 'C:\\Users\\Administrator\\hapi'
        const machineOf: Record<string, string> = {
            's-on-fa608': 'fa608', 's-elsewhere': 'other-machine', 's-outside': 'fa608'
        }
        return {
            ...base,
            resolve: (id: string) => machineOf[id] ?? null,
            resolvePath: (id: string) => paths[id] ?? null
        }
    }

    it('限定内的会话照常继承', () => {
        const { store, grantee, resolve, resolvePath } = scopedSetup()
        store.grant('machine', 'fa608', grantee.id, 'operator', SCOPE)
        expect(sessionAccessLevel(store, grantee.id, 's-on-fa608', resolve, resolvePath)).toBe('operator')
        store.close()
    })

    it('同一台机器上限定外的会话不继承', () => {
        const { store, grantee, resolve, resolvePath } = scopedSetup()
        store.grant('machine', 'fa608', grantee.id, 'operator', SCOPE)
        expect(sessionAccessLevel(store, grantee.id, 's-outside', resolve, resolvePath)).toBe('none')
        store.close()
    })

    it('不传 path resolver 时限定授权不继承（fail-closed，不会误放行整机）', () => {
        const { store, grantee, resolve } = scopedSetup()
        store.grant('machine', 'fa608', grantee.id, 'operator', SCOPE)
        expect(sessionAccessLevel(store, grantee.id, 's-on-fa608', resolve)).toBe('none')
        store.close()
    })

    it('未限定的 grant 不受影响', () => {
        const { store, grantee, resolve, resolvePath } = scopedSetup()
        store.grant('machine', 'fa608', grantee.id, 'operator')
        expect(sessionAccessLevel(store, grantee.id, 's-outside', resolve, resolvePath)).toBe('operator')
        store.close()
    })

    it('会话自身的显式 grant 不被目录限定砍掉（当初有意共享的那几条要保住）', () => {
        const { store, grantee, resolve, resolvePath } = scopedSetup()
        store.grant('machine', 'fa608', grantee.id, 'operator', SCOPE)
        store.grant('session', 's-outside', grantee.id, 'viewer')
        expect(sessionAccessLevel(store, grantee.id, 's-outside', resolve, resolvePath)).toBe('viewer')
        store.close()
    })

    it('机器主人与 admin 不受目录限定约束', () => {
        const { store, owner, admin, resolve, resolvePath } = scopedSetup()
        store.grant('machine', 'fa608', owner.id, 'viewer', SCOPE)
        expect(sessionAccessLevel(store, owner.id, 's-outside', resolve, resolvePath)).toBe('owner')
        expect(sessionAccessLevel(store, admin.id, 's-outside', resolve, resolvePath)).toBe('owner')
        expect(machineInheritedLevel(store, 'fa608', admin.id, () => null)).toBe('owner')
        store.close()
    })

    it('改授权时 path_prefix 可原地更新与清除', () => {
        const { store, grantee, resolve, resolvePath } = scopedSetup()
        store.grant('machine', 'fa608', grantee.id, 'operator', SCOPE)
        expect(store.machineGrantScope('fa608', grantee.id)).toBe(SCOPE)
        store.grant('machine', 'fa608', grantee.id, 'operator')
        expect(store.machineGrantScope('fa608', grantee.id)).toBeNull()
        expect(sessionAccessLevel(store, grantee.id, 's-outside', resolve, resolvePath)).toBe('operator')
        store.close()
    })
})

describe('createSessionPathResolver：工作目录现查 core 侧 metadata', () => {
    it('取 session.metadata.path，取不到时返回 null 且不抛', () => {
        const engine = {
            getSession: (id: string) => id === 'known' ? { metadata: { path: '/Users/wu' } } : undefined
        } as unknown as SyncEngine
        expect(createSessionPathResolver(() => engine)('known')).toBe('/Users/wu')
        expect(createSessionPathResolver(() => engine)('missing')).toBeNull()
        expect(createSessionPathResolver(() => null)('any')).toBeNull()
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
