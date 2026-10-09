/**
 * The hub runs on one JS thread; when a synchronous SQLite query or JSON pass
 * blocks it, every HTTP request, socket ack and SSE heartbeat stalls together.
 * The 2026-10-09 incident looked like a network outage from outside. This
 * sampler measures how late a fixed-interval timer fires so `/health` can show
 * the stall directly, and logs stalls as they happen.
 */
export type EventLoopLagSnapshot = {
    /** Lateness of the most recent sample, in ms. */
    lagMs: number
    /** Worst lateness in the last window, in ms. */
    maxLagMs: number
    windowMs: number
}

export type EventLoopLagMonitor = {
    snapshot: () => EventLoopLagSnapshot
    stop: () => void
}

export function startEventLoopLagMonitor(options: {
    intervalMs?: number
    windowMs?: number
    /** Log a warning when a single sample is at least this late. */
    warnAboveMs?: number
    now?: () => number
    warn?: (message: string) => void
} = {}): EventLoopLagMonitor {
    const intervalMs = options.intervalMs ?? 500
    const windowMs = options.windowMs ?? 60_000
    const warnAboveMs = options.warnAboveMs ?? 1_000
    const now = options.now ?? (() => performance.now())
    const warn = options.warn ?? ((message: string) => console.warn(message))
    const samples: Array<{ at: number; lag: number }> = []
    let lastLag = 0
    let expectedAt = now() + intervalMs

    const timer = setInterval(() => {
        const at = now()
        const lag = Math.max(0, at - expectedAt)
        expectedAt = at + intervalMs
        lastLag = lag
        samples.push({ at, lag })
        while (samples.length > 0 && at - samples[0]!.at > windowMs) {
            samples.shift()
        }
        if (lag >= warnAboveMs) {
            warn(`[Hub] event loop blocked for ${Math.round(lag)} ms`)
        }
    }, intervalMs)
    timer.unref?.()

    return {
        snapshot: () => ({
            lagMs: Math.round(lastLag),
            maxLagMs: Math.round(samples.reduce((max, sample) => Math.max(max, sample.lag), 0)),
            windowMs
        }),
        stop: () => clearInterval(timer)
    }
}
