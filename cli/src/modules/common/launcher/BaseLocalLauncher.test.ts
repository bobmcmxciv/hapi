import { describe, expect, it, vi } from 'vitest'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import { BaseLocalLauncher } from './BaseLocalLauncher'

function harness() {
    const items: string[] = []
    let onMessage: ((...args: unknown[]) => void) | null = null
    const handlers = new Map<string, () => Promise<void> | void>()
    const reset = vi.fn(() => { items.length = 0 })
    let launched: () => void = () => {}
    const launchedOnce = new Promise<void>((resolve) => { launched = resolve })
    const launcher = new BaseLocalLauncher({
        label: 'local',
        failureLabel: 'Local process failed',
        queue: {
            size: () => items.length,
            setOnMessage: (callback) => { onMessage = callback },
            // A queue that still offers reset(): the launcher must not call it.
            ...({ reset } as object)
        } as never,
        rpcHandlerManager: { registerHandler: (method, handler) => { handlers.set(method, handler) } },
        startedBy: 'terminal',
        startingMode: 'local',
        // Stands in for the local Claude TUI: runs until aborted.
        launch: (signal) => new Promise<void>((resolve) => {
            launched()
            signal.addEventListener('abort', () => resolve(), { once: true })
        }),
        sendFailureMessage: () => {},
        recordLocalLaunchFailure: () => {}
    })
    return {
        launcher,
        items,
        reset,
        launchedOnce,
        deliver: (text: string) => { items.push(text); onMessage?.() },
        rpc: (method: string) => handlers.get(method)?.()
    }
}

describe('BaseLocalLauncher', () => {
    it('keeps a message that arrived just before Stop, so the remote loop still runs it', async () => {
        const h = harness()
        const run = h.launcher.run()
        await h.launchedOnce

        // The web message triggers the local -> remote switch; Stop follows while the switch is in progress.
        h.deliver('执行推荐方案')
        await h.rpc(RPC_METHODS.Abort)

        await expect(run).resolves.toBe('switch')
        expect(h.items).toEqual(['执行推荐方案'])
        expect(h.reset).not.toHaveBeenCalled()
    })

    it('still switches to remote on Stop with nothing queued', async () => {
        const h = harness()
        const run = h.launcher.run()
        await h.launchedOnce

        await h.rpc(RPC_METHODS.Abort)

        await expect(run).resolves.toBe('switch')
        expect(h.items).toEqual([])
    })
})
