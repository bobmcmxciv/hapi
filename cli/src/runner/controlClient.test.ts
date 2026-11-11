import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionCleanupReceiptStore } from './cleanupReceipt'

const { readRunnerStateMock, isProcessAliveMock, getProcessStartMarkerMock, testConfiguration } = vi.hoisted(() => ({
    readRunnerStateMock: vi.fn(),
    isProcessAliveMock: vi.fn(),
    getProcessStartMarkerMock: vi.fn(),
    testConfiguration: { runnerStateFile: '' },
}))

vi.mock('@/persistence', () => ({
    readRunnerState: readRunnerStateMock,
    readSettings: vi.fn(),
    clearRunnerState: vi.fn(),
}))

vi.mock('@/configuration', () => ({ configuration: testConfiguration }))
vi.mock('@/utils/process', () => ({
    isProcessAlive: isProcessAliveMock,
    getProcessStartMarkerAsync: getProcessStartMarkerMock,
    isHapiRunnerProcessAsync: vi.fn(async () => true),
    killProcess: vi.fn(),
}))

vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn() } }))

import { notifyRunnerSessionCleanupVerified, stopRunnerSession } from './controlClient'

describe('runner control client stop-session contract', () => {
    beforeEach(() => {
        readRunnerStateMock.mockResolvedValue({ pid: 42, httpPort: 3210 })
        isProcessAliveMock.mockReturnValue(true)
    })

    afterEach(() => {
        vi.unstubAllGlobals()
        vi.clearAllMocks()
    })

    it.each(['stopped', 'already_gone', 'still_alive'] as const)(
        'returns the runner %s status',
        async (status) => {
            vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            })))

            await expect(stopRunnerSession('session-1')).resolves.toBe(status)
        }
    )

    it('fails closed when the runner returns a malformed response', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        })))

        await expect(stopRunnerSession('session-1')).resolves.toBe('still_alive')
    })
})

describe('durable cleanup acknowledgement client', () => {
    let directory: string

    beforeEach(() => {
        directory = mkdtempSync(join(tmpdir(), 'hapi-offline-cleanup-'))
        testConfiguration.runnerStateFile = join(directory, 'runner.state.json')
        getProcessStartMarkerMock.mockReturnValue('wrapper-generation')
        vi.stubEnv('HAPI_OMP_RESUME_ATTEMPT_ID', '')
    })

    afterEach(() => {
        rmSync(directory, { recursive: true, force: true })
        vi.unstubAllGlobals()
        vi.clearAllMocks()
        vi.unstubAllEnvs()
    })

    const persistedProof = () => new SessionCleanupReceiptStore(testConfiguration.runnerStateFile).has({
        requestedSessionId: 'hapi-row', pid: process.pid, processStartMarker: 'wrapper-generation',
        requiresCleanupReceipt: true,
    })

    it('persists cleanup when the runner has no state or is offline', async () => {
        readRunnerStateMock.mockResolvedValue(undefined)
        const fetchMock = vi.fn()
        vi.stubGlobal('fetch', fetchMock)
        await expect(notifyRunnerSessionCleanupVerified('hapi-row')).resolves.toBeUndefined()
        expect(persistedProof()).toBe(true)
        expect(fetchMock).not.toHaveBeenCalled()
        readRunnerStateMock.mockResolvedValue({ pid: 42, httpPort: 3210 })
        isProcessAliveMock.mockReturnValue(false)
        await expect(notifyRunnerSessionCleanupVerified('hapi-row')).resolves.toBeUndefined()
        expect(persistedProof()).toBe(true)
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it('writes proof before delivery and retains it across failed acknowledgement', async () => {
        readRunnerStateMock.mockResolvedValue({ pid: 42, httpPort: 3210 })
        isProcessAliveMock.mockReturnValue(true)
        vi.stubGlobal('fetch', vi.fn(async () => {
            expect(persistedProof()).toBe(true)
            throw new Error('runner disconnected')
        }))
        await expect(notifyRunnerSessionCleanupVerified('hapi-row')).resolves.toBeUndefined()
        expect(persistedProof()).toBe(true)
    })

    it('preserves the unique resume attempt when the OS marker cannot be probed offline', async () => {
        vi.stubEnv('HAPI_OMP_RESUME_ATTEMPT_ID', 'attempt-1')
        getProcessStartMarkerMock.mockReturnValue(null)
        readRunnerStateMock.mockResolvedValue(undefined)
        await expect(notifyRunnerSessionCleanupVerified('hapi-row')).resolves.toBeUndefined()
        const store = new SessionCleanupReceiptStore(testConfiguration.runnerStateFile)
        expect(store.has({ requestedSessionId: 'hapi-row', pid: process.pid, processStartMarker: '', ompResumeAttemptId: 'attempt-1' })).toBe(true)
        expect(store.has({ requestedSessionId: 'hapi-row', pid: process.pid, processStartMarker: '', ompResumeAttemptId: 'attempt-2' })).toBe(false)
    })

    it('refuses to publish unbound cleanup when its process generation cannot be probed', async () => {
        getProcessStartMarkerMock.mockReturnValue(null)
        await expect(notifyRunnerSessionCleanupVerified('hapi-row')).rejects.toThrow('Cannot verify session process generation')
        expect(persistedProof()).toBe(false)
    })
})
