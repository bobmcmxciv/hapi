import { describe, expect, it } from 'vitest'
import type { Socket } from 'socket.io-client'
import { RpcHandlerManager } from './RpcHandlerManager'

function transport(trace: string[]): Socket {
    return {
        emit(_event: string, payload: { method: string }) { trace.push(payload.method) }
    } as unknown as Socket
}

describe('RPC source registration barrier', () => {
    it('withholds source readiness until its real shutdown handler exists and publishes it before dependent RPCs', async () => {
        const trace: string[] = []
        let shutdowns = 0
        const manager = new RpcHandlerManager({ scopePrefix: 'session', logger: () => undefined })
        manager.registerHandler('readFile', () => ({ content: 'controlled' }))
        manager.onSocketConnect(transport(trace), { firstMethod: 'killSession', onRegistered: () => trace.push('ready') })
        expect(trace).toEqual([])
        manager.registerHandler('killSession', () => { shutdowns += 1; return { stopped: true } })
        expect(trace).toEqual(['session:killSession', 'session:readFile', 'ready'])
        expect(await manager.handleRequest({ method: 'session:killSession', params: '{}' })).toBe(JSON.stringify({ stopped: true }))
        expect(shutdowns).toBe(1)
    })

    it('does not revive an abandoned socket bootstrap when the handler becomes available after reconnect', () => {
        const oldTrace: string[] = []
        const nextTrace: string[] = []
        const manager = new RpcHandlerManager({ scopePrefix: 'session', logger: () => undefined })
        manager.registerHandler('readFile', () => ({ content: 'controlled' }))
        manager.onSocketConnect(transport(oldTrace), { firstMethod: 'killSession', onRegistered: () => oldTrace.push('ready') })
        manager.onSocketDisconnect()
        manager.registerHandler('killSession', () => ({ stopped: true }))
        expect(oldTrace).toEqual([])
        manager.onSocketConnect(transport(nextTrace), { firstMethod: 'killSession', onRegistered: () => nextTrace.push('ready') })
        expect(nextTrace).toEqual(['session:killSession', 'session:readFile', 'ready'])
        expect(oldTrace).toEqual([])
    })
})
