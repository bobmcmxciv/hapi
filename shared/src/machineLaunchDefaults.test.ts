import { describe, expect, test } from 'bun:test'
import { resolveMachineLaunchDefaults } from './machineLaunchDefaults'

describe('resolveMachineLaunchDefaults', () => {
    test('accepts the cx2cc case operators actually configure', () => {
        expect(resolveMachineLaunchDefaults({
            model: 'gpt-5.6-sol[1m]',
            effort: 'xhigh'
        })).toEqual({ model: 'gpt-5.6-sol[1m]', effort: 'xhigh' })
    })

    test('returns undefined when nothing is configured', () => {
        expect(resolveMachineLaunchDefaults({})).toBeUndefined()
        expect(resolveMachineLaunchDefaults({ model: '', effort: '' })).toBeUndefined()
        expect(resolveMachineLaunchDefaults({ model: '   ' })).toBeUndefined()
    })

    test('keeps a valid half when the other half is junk', () => {
        // A typo in a hand-edited settings.json must not discard the good value
        // or stop the runner from registering.
        expect(resolveMachineLaunchDefaults({ model: 'gpt-5.6-sol[1m]', effort: 'ludicrous' }))
            .toEqual({ model: 'gpt-5.6-sol[1m]' })
        expect(resolveMachineLaunchDefaults({ effort: 'max' })).toEqual({ effort: 'max' })
    })

    test('normalizes effort case and surrounding whitespace', () => {
        expect(resolveMachineLaunchDefaults({ effort: '  XHigh ' })).toEqual({ effort: 'xhigh' })
        expect(resolveMachineLaunchDefaults({ model: '  gpt-5.6-sol  ' }))
            .toEqual({ model: 'gpt-5.6-sol' })
    })

    test('rejects non-string and oversized values instead of trusting the file', () => {
        expect(resolveMachineLaunchDefaults({ model: 42, effort: {} })).toBeUndefined()
        expect(resolveMachineLaunchDefaults({ model: null, effort: null })).toBeUndefined()
        expect(resolveMachineLaunchDefaults({ model: 'x'.repeat(200) })).toBeUndefined()
    })

    test('does not invent a [1m] suffix', () => {
        // The suffix is a launch-time declaration the operator opts into;
        // inferring it would meter sessions against a 1M window the proxy may
        // not actually grant.
        expect(resolveMachineLaunchDefaults({ model: 'gpt-5.6-sol' }))
            .toEqual({ model: 'gpt-5.6-sol' })
    })
})
