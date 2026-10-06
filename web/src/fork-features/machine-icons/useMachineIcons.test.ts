import { describe, expect, it } from 'vitest'
import { mergeMachineIcons } from './useMachineIcons'

describe('mergeMachineIcons', () => {
    it('keeps the cached icon of a machine that is absent from the live list', () => {
        expect(mergeMachineIcons({ offline: 'macbook' }, [])).toEqual({ offline: 'macbook' })
    })

    it('live data wins, and a live machine without an icon drops its cached one', () => {
        const merged = mergeMachineIcons(
            { a: 'laptop', b: 'nas' },
            [
                { id: 'a', metadata: { icon: 'rack-server' } },
                { id: 'b', metadata: { host: 'b' } }
            ]
        )
        expect(merged).toEqual({ a: 'rack-server' })
    })

    it('ignores values outside the icon vocabulary from either source', () => {
        const merged = mergeMachineIcons(
            { stale: 'toaster' },
            [{ id: 'x', metadata: { icon: 'spaceship' } }]
        )
        expect(merged).toEqual({})
    })
})
