import { describe, expect, it } from 'vitest'
import { REFRESH_TIMEOUT_MS, refreshPhase } from './refreshProgress'

describe('refreshPhase', () => {
    const clicked = { attempt: 100, startedAt: 1_000 }

    it('follows the server while the job is queued or running', () => {
        expect(refreshPhase(clicked, 100, 'queued', 2_000)).toBe('queued')
        expect(refreshPhase(clicked, 100, 'running', 2_000)).toBe('running')
        expect(refreshPhase(null, 100, 'running', 2_000)).toBe('running')
    })

    it('stays busy between the click and the first poll that reports the job', () => {
        expect(refreshPhase(clicked, 100, null, 1_500)).toBe('running')
    })

    it('finishes when the stored attempt changes, including a first digest or a failure', () => {
        expect(refreshPhase(clicked, 200, null, 9_000)).toBe('done')
        expect(refreshPhase({ attempt: null, startedAt: 1_000 }, 200, null, 9_000)).toBe('done')
    })

    it('a newer attempt does not finish a refresh that is still queued behind it', () => {
        expect(refreshPhase(clicked, 200, 'queued', 9_000)).toBe('queued')
    })

    it('gives up after the timeout instead of spinning forever', () => {
        expect(refreshPhase(clicked, 100, null, 1_000 + REFRESH_TIMEOUT_MS + 1)).toBe('timeout')
        expect(refreshPhase(null, 100, null, 0)).toBe('idle')
    })
})
