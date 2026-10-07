import type { DigestJobState } from './digestApi'

/** 点「重新总结」那一刻记下的基准：当时最近一次处理的时间。 */
export type RefreshBaseline = { attempt: number | null; startedAt: number }

export type RefreshPhase = 'idle' | 'queued' | 'running' | 'done' | 'timeout'

export const REFRESH_TIMEOUT_MS = 180_000

/**
 * 点了「重新总结」之后界面该显示什么。
 * 服务端报排队/运行中就跟着它；服务端还没报到（请求刚发出、下一次轮询还没回来）但处理时间没变，也算进行中；
 * 处理时间变了（成功或失败都会变）就是完成；等太久就放弃，不让按钮一直转。
 */
export function refreshPhase(baseline: RefreshBaseline | null, attempt: number | null, serverState: DigestJobState, now: number): RefreshPhase {
    if (serverState === 'queued') return 'queued'
    if (serverState === 'running') return 'running'
    if (!baseline) return 'idle'
    if (attempt !== baseline.attempt) return 'done'
    if (now - baseline.startedAt > REFRESH_TIMEOUT_MS) return 'timeout'
    return 'running'
}
