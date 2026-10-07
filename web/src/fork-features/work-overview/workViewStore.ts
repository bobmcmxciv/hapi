import { useSyncExternalStore } from 'react'

/**
 * 工作总览的界面状态：选中的线（左侧会话列表跟着过滤）和手机上「工作 | 会话」切换。
 *
 * 用内存 store 而不是 localStorage 钩子：同一个标签页里左栏和右栏要同步，而 storage
 * 事件只在**别的**标签页触发。sessionStorage 只用来在刷新后恢复。
 */
export type WorkViewState = {
    lineId: string | null
    mobileView: 'work' | 'sessions'
}

const STORAGE_KEY = 'hapi-work-view'
const listeners = new Set<() => void>()

function load(): WorkViewState {
    try {
        const raw = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(STORAGE_KEY) : null
        const parsed = raw ? JSON.parse(raw) as Partial<WorkViewState> : {}
        return {
            lineId: typeof parsed.lineId === 'string' ? parsed.lineId : null,
            mobileView: parsed.mobileView === 'work' ? 'work' : 'sessions'
        }
    } catch {
        return { lineId: null, mobileView: 'sessions' }
    }
}

let state: WorkViewState = load()

export function setWorkView(patch: Partial<WorkViewState>): void {
    state = { ...state, ...patch }
    try {
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state))
    } catch {
        // 隐私模式等场景写不进去，只影响刷新后恢复
    }
    for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
}

export function useWorkView(): WorkViewState {
    return useSyncExternalStore(subscribe, () => state, () => state)
}
