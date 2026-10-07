import { describe, expect, it } from 'vitest'
import { REFRESH_TIMEOUT_MS, refreshPhase } from './refreshProgress'

describe('refreshPhase', () => {
    const confirmed = { attempt: 100, startedAt: 1_000, confirmed: true }

    it('follows the server while the job is queued or running', () => {
        expect(refreshPhase(confirmed, 100, 'queued', 2_000)).toBe('queued')
        expect(refreshPhase(confirmed, 100, 'running', 2_000)).toBe('running')
        expect(refreshPhase(null, 100, 'running', 2_000)).toBe('running')
    })

    it('stays busy between the click and the first poll that reports the job', () => {
        expect(refreshPhase(confirmed, 100, null, 1_500)).toBe('running')
    })

    it('finishes when the stored attempt changes after the server confirmed the request, including a first digest or a failure', () => {
        expect(refreshPhase(confirmed, 200, null, 9_000)).toBe('done')
        expect(refreshPhase({ attempt: null, startedAt: 1_000, confirmed: true }, 200, null, 9_000)).toBe('done')
    })

    it('does not mistake slow-loading dialog data for a finished job before the server confirmed the request', () => {
        // 点击时数据还没到（占位 null），随后到达的旧数据带着已有的处理时间——这不是完成。
        expect(refreshPhase({ attempt: null, startedAt: 1_000, confirmed: false }, 100, null, 1_400)).toBe('running')
    })

    it('a newer attempt does not finish a refresh that is still queued behind it', () => {
        expect(refreshPhase(confirmed, 200, 'queued', 9_000)).toBe('queued')
    })

    it('gives up after the timeout instead of spinning forever', () => {
        expect(refreshPhase(confirmed, 100, null, 1_000 + REFRESH_TIMEOUT_MS + 1)).toBe('timeout')
        expect(refreshPhase({ ...confirmed, confirmed: false }, 100, null, 1_000 + REFRESH_TIMEOUT_MS + 1)).toBe('timeout')
        expect(refreshPhase(null, 100, null, 0)).toBe('idle')
    })
})
