import { beforeEach, describe, expect, it } from 'vitest'
import {
    loadPreferredCcSwitchProvider,
    resolveSpawnCcSwitchProviderId,
    savePreferredCcSwitchProvider
} from './ccSwitchProviderPreference'

describe('cc-switch provider preference (fork claude-proxy-models)', () => {
    beforeEach(() => {
        localStorage.clear()
    })

    it('remembers the choice per machine and clears it with null', () => {
        expect(loadPreferredCcSwitchProvider('m1')).toBeNull()
        savePreferredCcSwitchProvider('m1', 'cx2cc')
        expect(loadPreferredCcSwitchProvider('m1')).toBe('cx2cc')
        expect(loadPreferredCcSwitchProvider('m2')).toBeNull()
        savePreferredCcSwitchProvider('m1', null)
        expect(loadPreferredCcSwitchProvider('m1')).toBeNull()
    })

    it('only sends a provider that exists on the machine and is not already current', () => {
        const base = { available: true, providerIds: ['glm', 'cx2cc'], currentProviderId: 'glm' }
        expect(resolveSpawnCcSwitchProviderId({ ...base, selected: null })).toBeUndefined()
        expect(resolveSpawnCcSwitchProviderId({ ...base, selected: 'glm' })).toBeUndefined()
        expect(resolveSpawnCcSwitchProviderId({ ...base, selected: 'cx2cc' })).toBe('cx2cc')
        // Remembered id no longer on this machine → follow machine default, never a stale id.
        expect(resolveSpawnCcSwitchProviderId({ ...base, selected: 'removed' })).toBeUndefined()
        // Machine without cc-switch → nothing, even with a remembered id.
        expect(resolveSpawnCcSwitchProviderId({ ...base, available: false, selected: 'cx2cc' })).toBeUndefined()
    })
})
