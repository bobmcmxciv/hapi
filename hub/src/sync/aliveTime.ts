export function clampAliveTime(t: number, now: number = Date.now()): number | null {
    if (!Number.isFinite(t)) return null
    if (t > now) return now
    if (t < now - 1000 * 60 * 10) return null
    return t
}
