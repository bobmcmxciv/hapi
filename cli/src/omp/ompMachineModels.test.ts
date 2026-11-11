import { describe, expect, it, vi } from 'vitest'
import type { OmpRpcClient } from './rpc/OmpRpcClient'
import type { OmpModel, OmpSessionState } from './rpc/types'
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import { OmpMachineIntegration } from '../../../fork-features/omp-host-integration/machine'

const model: OmpModel = {
    provider: 'anthropic', id: 'claude-sonnet-5-5', name: 'Claude Sonnet', api: 'anthropic-messages',
    baseUrl: 'https://api.anthropic.com', reasoning: true, input: ['text', 'image'],
    contextWindow: 200000, maxTokens: 64000, thinking: { mode: 'adaptive', efforts: ['low', 'high'] }, raw: {}
}
const state: OmpSessionState = {
    model, isStreaming: false, isCompacting: false, steeringMode: 'all', followUpMode: 'all',
    interruptMode: 'immediate', sessionId: 'discovery-only', autoCompactionEnabled: true,
    messageCount: 0, queuedMessageCount: 0, todoPhases: []
}
function fixture(resolveModelCwd = vi.fn(async (cwd: string) => `${cwd}/resolved`)) {
    const request = vi.fn(async () => { throw new Error('Discovery must not be repeated') })
    const close = vi.fn(async () => { })
    const client = {
        discovery: { version: '18.17.0', models: [model], state, commands: [] }, request, close,
        sendControlFrame: vi.fn(), onEvent: vi.fn(() => () => { })
    } as unknown as Pick<OmpRpcClient, 'discovery' | 'request' | 'close' | 'sendControlFrame' | 'onEvent'>
    const connect = vi.fn(async () => client)
    const integration = new OmpMachineIntegration({ defaultCwd: '/runner', resolveModelCwd, connect })
    const manager = new RpcHandlerManager({ scopePrefix: 'machine', logger: () => { } })
    integration.register(manager)
    const list = async (cwd?: string) => JSON.parse(await manager.handleRequest({
        method: `machine:${RPC_METHODS.ListOmpModels}`, params: JSON.stringify({ cwd })
    }))
    return { integration, manager, connect, request, close, resolveModelCwd, list }
}

describe('native machine model discovery', () => {
    it('projects the connect snapshot without repeating native state/model requests', async () => {
        const f = fixture()
        const result = await f.list('/workspace')
        expect(f.resolveModelCwd).toHaveBeenCalledWith('/workspace')
        expect(f.connect).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/workspace/resolved', noSession: true }))
        expect(f.request).not.toHaveBeenCalled()
        expect(f.close).toHaveBeenCalledOnce()
        expect(result).toEqual({
            success: true,
            availableModels: [{
                provider: 'anthropic', modelId: 'claude-sonnet-5-5', name: 'Claude Sonnet', reasoning: true,
                contextWindow: 200000, maxTokens: 64000, thinkingLevels: ['low', 'high']
            }],
            currentModel: { provider: 'anthropic', modelId: 'claude-sonnet-5-5' }
        })
    })

    it('does not connect outside the authorized workspace or invent a default cwd', async () => {
        const f = fixture(vi.fn(async () => { throw new Error('outside authorized workspace') }))
        expect(await f.list()).toEqual({ success: false, error: 'cwd is required' })
        expect(await f.list('/outside')).toEqual({ success: false, error: 'outside authorized workspace' })
        expect(f.connect).not.toHaveBeenCalled()
    })
})
