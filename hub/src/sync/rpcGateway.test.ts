import { describe, expect, it } from 'bun:test'
import type { Server } from 'socket.io'
import type { RpcRegistry } from '../socket/rpcRegistry'
import { RpcGateway, RpcTargetMissingError } from './rpcGateway'
import { OMP_USAGE_RPC_TIMEOUT_MS } from '@hapi/protocol/ompUsage'

function createGateway(options?: { reply: unknown }) {
    const timeouts: number[] = []
    const calls: Array<{ method: string; params: string }> = []
    const socket = {
        timeout(timeoutMs: number) {
            timeouts.push(timeoutMs)
            return {
                async emitWithAck(_event: string, payload: { method: string; params: string }) {
                    calls.push(payload)
                    if (options) return options.reply
                    if (payload.method.endsWith(':cursor-chat-store-status')) {
                        return JSON.stringify({ onDisk: false, store: null })
                    }
                    return JSON.stringify({
                        success: true,
                        method: payload.method,
                        params: JSON.parse(payload.params) as unknown
                    })
                }
            }
        }
    }

    const io = {
        of() {
            return {
                sockets: {
                    get() {
                        return socket
                    }
                }
            }
        }
    } as unknown as Server

    const rpcRegistry = {
        getSocketIdForMethod() {
            return 'socket-1'
        }
    } as unknown as RpcRegistry

    return {
        gateway: new RpcGateway(io, rpcRegistry),
        timeouts,
        calls
    }
}

describe('RpcGateway RPC timeouts', () => {
    it('refuses a cleanup acknowledgement from a superseded socket', async () => {
        let owner = 'old-socket'
        const socket = { timeout: () => ({ emitWithAck: async () => { owner = 'replacement-socket'; return { success: true } } }) }
        // Typed transport seams model replacement while the real gateway awaits its acknowledgement.
        const io = { of: () => ({ sockets: { get: () => socket } }) } as unknown as Server
        const registry = { getSocketIdForMethod: () => owner } as unknown as RpcRegistry
        const gateway = new RpcGateway(io, registry)
        await expect(gateway.killSession('session-1')).rejects.toThrow('RPC source changed before acknowledgement')
    })

    it('uses the default RPC timeout for regular machine RPCs', async () => {
        const { gateway, timeouts } = createGateway()

        await gateway.listMachineDirectory('machine-1', 'C:\\workspace')

        expect(timeouts).toEqual([30_000])
    })

    it('uses an extended RPC timeout when listing Codex models', async () => {
        const { gateway, timeouts } = createGateway()

        await gateway.listCodexModelsForMachine('machine-1')

        expect(timeouts).toEqual([120_000])
    })

    it('uses the session RPC for explicit Codex fallback discovery', async () => {
        const { gateway, calls, timeouts } = createGateway()

        await gateway.listCodexModelsForSession('session-1')

        expect(calls.map((call) => call.method)).toEqual(['session-1:listCodexModels'])
        expect(timeouts).toEqual([120_000])
    })

    it('uses an extended RPC timeout when listing Cursor models for a machine', async () => {
        const { gateway, timeouts } = createGateway()

        await gateway.listCursorModelsForMachine('machine-1')

        expect(timeouts).toEqual([120_000])
    })

    it('uses an extended RPC timeout when listing Copilot models', async () => {
        const { gateway, timeouts } = createGateway()

        await gateway.listCopilotModelsForCwd('machine-1', '/workspace')
        await gateway.listCopilotModelsForSession('session-1')

        expect(timeouts).toEqual([120_000, 120_000])
    })

    it('forwards the recorded session owner home to the Cursor store probe', async () => {
        const { gateway, calls } = createGateway()

        await gateway.getCursorChatStoreStatus(
            'machine-1',
            '/workspace/project',
            'cursor-session',
            '/home/recorded-owner'
        )

        expect(calls).toEqual([{
            method: 'machine-1:cursor-chat-store-status',
            params: JSON.stringify({
                workspacePath: '/workspace/project',
                cursorSessionId: 'cursor-session',
                homeDir: '/home/recorded-owner'
            })
        }])
    })
    it('requires an explicit successful kill acknowledgement', async () => {
        for (const reply of [undefined, null, {}, { success: false, error: 'Native cleanup failed' }]) {
            const { gateway } = createGateway({ reply })
            await expect(gateway.killSession('session-1')).rejects.toThrow()
        }
        await expect(createGateway().gateway.killSession('session-1')).resolves.toBeUndefined()
    })

    it('preserves native cleanup errors returned by the wrapper', async () => {
        const { gateway } = createGateway({ reply: { success: false, message: 'Native dispose unverified' } })
        await expect(gateway.killSession('session-1')).rejects.toThrow('Native dispose unverified')
    })
})

// tiann/hapi#916: rpcCall throws a typed `RpcTargetMissingError` when the
// target CLI is unreachable, so syncEngine.archiveSession can narrow on it
// and treat the kill as a benign no-op.
describe('RpcGateway no-target diagnostics (tiann/hapi#916)', () => {
    it('throws RpcTargetMissingError(handler-not-registered) when no socket is registered for the method', async () => {
        const io = {
            of() {
                return {
                    sockets: {
                        get() { return undefined }
                    }
                }
            }
        } as unknown as Server
        const rpcRegistry = {
            getSocketIdForMethod() { return undefined }
        } as unknown as RpcRegistry
        const gateway = new RpcGateway(io, rpcRegistry)

        const error = await gateway.killSession('session-1').catch((e: unknown) => e)
        expect(error).toBeInstanceOf(RpcTargetMissingError)
        expect((error as RpcTargetMissingError).code).toBe('handler-not-registered')
    })

    it('throws RpcTargetMissingError(socket-disconnected) when the socket id is registered but no socket exists', async () => {
        const io = {
            of() {
                return {
                    sockets: {
                        get() { return undefined }
                    }
                }
            }
        } as unknown as Server
        const rpcRegistry = {
            getSocketIdForMethod() { return 'socket-1' }
        } as unknown as RpcRegistry
        const gateway = new RpcGateway(io, rpcRegistry)

        const error = await gateway.killSession('session-1').catch((e: unknown) => e)
        expect(error).toBeInstanceOf(RpcTargetMissingError)
        expect((error as RpcTargetMissingError).code).toBe('socket-disconnected')
    })
})

describe('OMP native usage gateway', () => {
    it('uses the bounded machine budget and strips non-protocol payload fields', async () => {
        const { gateway, timeouts, calls } = createGateway({
            reply: JSON.stringify({
                success: true, source: 'omp-native', generatedAt: 123,
                reports: [], accountsWithoutUsage: [], disabledCredentialCount: 0,
                raw: { token: 'secret' }, metadata: { email: 'private@example.com' }
            })
        })
        const result = await gateway.getOmpUsageForMachine('machine-usage')
        expect(result.success).toBe(true)
        expect(timeouts).toEqual([OMP_USAGE_RPC_TIMEOUT_MS])
        expect(calls).toEqual([{ method: 'machine-usage:getOmpUsage', params: '{}' }])
        expect(JSON.stringify(result)).not.toContain('secret')
        expect(JSON.stringify(result)).not.toContain('private@example.com')
    })

    it('reports an old Runner without attempting another provider or external source', async () => {
        const registry = { getSocketIdForMethod: () => undefined } as unknown as RpcRegistry
        const result = await new RpcGateway({} as Server, registry).getOmpUsageForMachine('old-runner')
        expect(result).toMatchObject({ success: false, errorCode: 'unsupported' })
    })

    it('never forwards malformed replies or raw Runner failure text', async () => {
        const invalid = createGateway({ reply: JSON.stringify({ token: 'private-token' }) }).gateway
        expect(await invalid.getOmpUsageForMachine('machine-1')).toMatchObject({ success: false, errorCode: 'invalid_output' })
        const failed = createGateway({
            reply: JSON.stringify({
                success: false, source: 'omp-native', errorCode: 'command_failed', error: 'private-token'
            })
        }).gateway
        const response = await failed.getOmpUsageForMachine('machine-1')
        expect(response).toMatchObject({ success: false, errorCode: 'command_failed' })
        expect(JSON.stringify(response)).not.toContain('private-token')
    })

    it('returns a sanitized transport failure when the machine socket is gone', async () => {
        const io = { of: () => ({ sockets: { get: () => undefined } }) } as unknown as Server
        const registry = { getSocketIdForMethod: () => 'disconnected' } as unknown as RpcRegistry
        expect(await new RpcGateway(io, registry).getOmpUsageForMachine('machine-1'))
            .toMatchObject({ success: false, errorCode: 'unavailable' })
    })
})
