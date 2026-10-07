import type { DigestJobState } from './digestApi'

/**
 * 点「重新总结」那一刻的基准：最近一次处理的时间。
 * 点击时先用手里的数据占位（confirmed=false），请求成功后换成服务端入队时刻的值（confirmed=true）——
 * 慢网络下对话框数据可能还没加载到，拿占位值比较会把「数据刚到」误判成「已经处理完」。
 */
export type RefreshBaseline = { attempt: number | null; startedAt: number; confirmed: boolean }

export type RefreshPhase = 'idle' | 'queued' | 'running' | 'done' | 'timeout'

export const REFRESH_TIMEOUT_MS = 180_000

/**
 * 点了「重新总结」之后界面该显示什么。
 * 服务端报排队/运行中就跟着它；服务端还没报到（请求刚发出、下一次轮询还没回来）但处理时间没变，也算进行中；
 * 服务端确认入队之后处理时间变了（成功或失败都会变）才是完成；等太久就放弃，不让按钮一直转。
 */
export function refreshPhase(baseline: RefreshBaseline | null, attempt: number | null, serverState: DigestJobState, now: number): RefreshPhase {
    if (serverState === 'queued') return 'queued'
    if (serverState === 'running') return 'running'
    if (!baseline) return 'idle'
    if (now - baseline.startedAt > REFRESH_TIMEOUT_MS) return 'timeout'
    if (!baseline.confirmed) return 'running'
    if (attempt !== baseline.attempt) return 'done'
    return 'running'
}
