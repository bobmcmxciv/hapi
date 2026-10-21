import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const spawnMock = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ spawn: spawnMock }))

import { _parseAgyModelsOutputForTests, _resetAgyModelsCacheForTests, listAgyModels } from './agyModels'

function fakeChild() {
    return Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: vi.fn(),
    })
}

beforeEach(() => {
    vi.useRealTimers()
    spawnMock.mockReset()
    _resetAgyModelsCacheForTests()
})

describe('parseAgyModelsOutput', () => {
    it('parses agy 1.1.5 id and display-name columns without duplicating the id', () => {
        expect(_parseAgyModelsOutputForTests([
            'gemini-3.6-flash-high     Gemini 3.6 Flash (High)',
            'claude-sonnet-4-6         Claude Sonnet 4.6 (Thinking)'
        ].join('\r\n'))).toEqual([
            { modelId: 'gemini-3.6-flash-high', name: 'Gemini 3.6 Flash (High)' },
            { modelId: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (Thinking)' }
        ])
    })

    it('parses agy 1.4.x tab-separated live model rows', () => {
        expect(_parseAgyModelsOutputForTests([
            'gemini-4-argon-medium\tGemini 4 Argon (Medium)',
            'claude-opus-5-5-high\tClaude Opus 5.5 (High)',
        ].join('\n'))).toEqual([
            { modelId: 'gemini-4-argon-medium', name: 'Gemini 4 Argon (Medium)' },
            { modelId: 'claude-opus-5-5-high', name: 'Claude Opus 5.5 (High)' },
        ])
    })

    it('keeps legacy display-name-only output compatible', () => {
        expect(_parseAgyModelsOutputForTests('Gemini 3.5 Flash (High)\n')).toEqual([
            { modelId: 'gemini-3.5-flash-high', name: 'Gemini 3.5 Flash (High)' }
        ])
    })

    it('accepts raw model ids from non-tty output and keeps their display labels', () => {
        // Piped `agy models` emits bare wire ids, which is the path the probe
        // actually takes; without the label backfill the picker would regress to
        // showing raw ids for every model.
        expect(_parseAgyModelsOutputForTests('gemini-4-argon-high\ngemini-4-argon-low\n')).toEqual([
            { modelId: 'gemini-4-argon-high', name: 'Gemini 4 Argon (High)' },
            { modelId: 'gemini-4-argon-low', name: 'Gemini 4 Argon (Low)' }
        ])
    })

    it('leaves an unknown wire id unlabeled rather than inventing a name', () => {
        expect(_parseAgyModelsOutputForTests('gemini-9.9-experimental\n')).toEqual([
            { modelId: 'gemini-9.9-experimental' }
        ])
    })
})


describe('listAgyModels live probe', () => {
    it('launches the same agy executable resolved from PATH without a shell wrapper', async () => {
        const child = fakeChild()
        spawnMock.mockReturnValue(child)
        const resultPromise = listAgyModels()

        expect(spawnMock).toHaveBeenCalledWith('agy', ['models'], expect.objectContaining({
            stdio: ['ignore', 'pipe', 'pipe'],
            env: expect.objectContaining({ GEMINI_FORCE_FILE_STORAGE: 'true' }),
            windowsHide: process.platform === 'win32',
        }))
        const options = spawnMock.mock.calls[0][2]
        expect(options.env.PATH).toBe(process.env.PATH)
        expect(Object.keys(options.env).some((key) => key.startsWith('SSH_'))).toBe(false)

        child.stdout.emit('data', Buffer.from('gemini-4-argon-low\n'))
        child.emit('exit', 0)
        await expect(resultPromise).resolves.toMatchObject({
            success: true,
            availableModels: [{ modelId: 'gemini-4-argon-low' }]
        })
    })

    it('kills a timed-out PATH probe once and settles once despite a late exit', async () => {
        vi.useFakeTimers()
        const child = fakeChild()
        spawnMock.mockReturnValue(child)
        const resultPromise = listAgyModels()

        await vi.advanceTimersByTimeAsync(15_000)
        const result = await resultPromise
        expect(child.kill).toHaveBeenCalledTimes(1)
        expect(result).toMatchObject({ success: false, error: 'Timed out fetching Antigravity models' })
        child.emit('exit', 0)
        expect(child.kill).toHaveBeenCalledTimes(1)
    })

    it('settles once when spawn error races with exit', async () => {
        const child = fakeChild()
        spawnMock.mockReturnValue(child)
        const resultPromise = listAgyModels()
        child.emit('error', new Error('missing'))
        child.emit('exit', 1)
        const result = await resultPromise
        expect(result).toMatchObject({ success: false, error: 'Antigravity CLI unavailable' })
    })
})
