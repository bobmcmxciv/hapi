import { describe, expect, it } from 'bun:test'
import { startEventLoopLagMonitor } from './eventLoopLag'

function blockFor(ms: number): void {
    const end = performance.now() + ms
    while (performance.now() < end) {
        // busy-wait to hold the event loop like a synchronous SQLite query would
    }
}

describe('startEventLoopLagMonitor', () => {
    it('reports a stall of the event loop and warns about it', async () => {
        const warnings: string[] = []
        const monitor = startEventLoopLagMonitor({ intervalMs: 20, warnAboveMs: 150, warn: (message) => warnings.push(message) })
        try {
            await new Promise((resolve) => setTimeout(resolve, 60))
            expect(monitor.snapshot().maxLagMs).toBeLessThan(150)

            blockFor(300)
            await new Promise((resolve) => setTimeout(resolve, 60))

            const snapshot = monitor.snapshot()
            expect(snapshot.maxLagMs).toBeGreaterThanOrEqual(200)
            expect(warnings.some((message) => message.includes('event loop blocked'))).toBe(true)
        } finally {
            monitor.stop()
        }
    })
})
