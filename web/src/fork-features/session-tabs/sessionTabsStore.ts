import { useSyncExternalStore } from 'react'

/**
 * 会话标签：打开过的会话按打开顺序排成一排，顺序只由用户决定（打开、拖动、固定、关闭），
 * 不随会话活跃度上浮下沉。按「hub + 账号」分别存在 localStorage。
 *
 * 纯函数负责规则（便于单测），store 只负责持久化与订阅。
 */
export type SessionTab = {
    id: string
    pinned: boolean
    /** 最近一次被切到前台的时间，用于超出上限时淘汰最久没看的那个。 */
    activatedAt: number
}

export type SessionTabsState = { tabs: SessionTab[] }

export const MAX_SESSION_TABS = 12

const EMPTY: SessionTabsState = { tabs: [] }

function normalizeOrder(tabs: SessionTab[]): SessionTab[] {
    return [...tabs.filter(tab => tab.pinned), ...tabs.filter(tab => !tab.pinned)]
}

/** 打开（或切到）一个会话：已在标签里就只更新激活时间，不挪位置；新会话追加到末尾。 */
export function openTab(state: SessionTabsState, id: string, now: number): SessionTabsState {
    const existing = state.tabs.find(tab => tab.id === id)
    if (existing) {
        return { tabs: state.tabs.map(tab => (tab.id === id ? { ...tab, activatedAt: now } : tab)) }
    }
    let tabs = [...state.tabs, { id, pinned: false, activatedAt: now }]
    while (tabs.length > MAX_SESSION_TABS) {
        const victim = tabs
            .filter(tab => !tab.pinned && tab.id !== id)
            .sort((a, b) => a.activatedAt - b.activatedAt)[0]
        if (!victim) break
        tabs = tabs.filter(tab => tab.id !== victim.id)
    }
    return { tabs }
}

/** 关掉一个标签；返回关掉之后应该切到的标签（右边优先，没有就左边）。 */
export function closeTab(state: SessionTabsState, id: string): { state: SessionTabsState; neighbor: string | null } {
    const index = state.tabs.findIndex(tab => tab.id === id)
    if (index < 0) return { state, neighbor: null }
    const tabs = state.tabs.filter(tab => tab.id !== id)
    const neighbor = tabs[index]?.id ?? tabs[index - 1]?.id ?? null
    return { state: { tabs }, neighbor }
}

export function closeOtherTabs(state: SessionTabsState, keepId: string): SessionTabsState {
    return { tabs: state.tabs.filter(tab => tab.pinned || tab.id === keepId) }
}

export function closeTabsToRight(state: SessionTabsState, id: string): SessionTabsState {
    const index = state.tabs.findIndex(tab => tab.id === id)
    if (index < 0) return state
    return { tabs: state.tabs.filter((tab, i) => i <= index || tab.pinned) }
}

/** 固定的标签排在最前、不会被自动淘汰。 */
export function togglePinTab(state: SessionTabsState, id: string): SessionTabsState {
    return { tabs: normalizeOrder(state.tabs.map(tab => (tab.id === id ? { ...tab, pinned: !tab.pinned } : tab))) }
}

/** 拖动排序：把 fromId 放到 toId 的位置。固定区与非固定区之间不能互相拖。 */
export function moveTab(state: SessionTabsState, fromId: string, toId: string): SessionTabsState {
    if (fromId === toId) return state
    const from = state.tabs.findIndex(tab => tab.id === fromId)
    const to = state.tabs.findIndex(tab => tab.id === toId)
    if (from < 0 || to < 0 || state.tabs[from]!.pinned !== state.tabs[to]!.pinned) return state
    const tabs = [...state.tabs]
    const [moved] = tabs.splice(from, 1)
    tabs.splice(to, 0, moved!)
    return { tabs }
}

/** 会话已被删除（列表里查不到）的标签直接去掉。 */
export function pruneTabs(state: SessionTabsState, existing: ReadonlySet<string>): SessionTabsState {
    const tabs = state.tabs.filter(tab => existing.has(tab.id))
    return tabs.length === state.tabs.length ? state : { tabs }
}

function parse(raw: string | null): SessionTabsState {
    try {
        const value = raw ? JSON.parse(raw) as { tabs?: unknown } : null
        if (!value || !Array.isArray(value.tabs)) return EMPTY
        const tabs: SessionTab[] = []
        for (const item of value.tabs) {
            if (!item || typeof item !== 'object') continue
            const tab = item as Partial<SessionTab>
            if (typeof tab.id !== 'string' || !tab.id || tabs.some(existing => existing.id === tab.id)) continue
            tabs.push({ id: tab.id, pinned: tab.pinned === true, activatedAt: typeof tab.activatedAt === 'number' ? tab.activatedAt : 0 })
        }
        return { tabs: normalizeOrder(tabs).slice(0, MAX_SESSION_TABS * 2) }
    } catch {
        return EMPTY
    }
}

type Store = { state: SessionTabsState; listeners: Set<() => void>; key: string }
const stores = new Map<string, Store>()

function storeFor(scope: string): Store {
    let store = stores.get(scope)
    if (!store) {
        const key = `hapi-session-tabs:${scope}`
        let raw: string | null = null
        try {
            raw = typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null
        } catch {
            raw = null
        }
        store = { state: parse(raw), listeners: new Set(), key }
        stores.set(scope, store)
    }
    return store
}

export function updateSessionTabs(scope: string, update: (state: SessionTabsState) => SessionTabsState): void {
    const store = storeFor(scope)
    const next = update(store.state)
    if (next === store.state) return
    store.state = next
    try {
        localStorage.setItem(store.key, JSON.stringify(next))
    } catch {
        // 存不下只影响刷新后恢复
    }
    for (const listener of store.listeners) listener()
}

export function useSessionTabsState(scope: string): SessionTabsState {
    const store = storeFor(scope)
    return useSyncExternalStore(
        listener => {
            store.listeners.add(listener)
            return () => store.listeners.delete(listener)
        },
        () => store.state,
        () => store.state
    )
}

/** 仅供测试：清掉内存里的 store。 */
export function __resetSessionTabsForTests(): void {
    stores.clear()
}
