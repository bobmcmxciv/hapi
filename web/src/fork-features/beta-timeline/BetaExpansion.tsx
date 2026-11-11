import { createContext, useContext, useRef, type ReactNode } from 'react'

const ExpansionContext = createContext<Map<string, boolean> | null>(null)
const ExpansionRowContext = createContext('')

export function BetaExpansionProvider({ children }: { children: ReactNode }) {
 const state = useRef(new Map<string, boolean>())
 return <ExpansionContext.Provider value={state.current}>{children}</ExpansionContext.Provider>
}

export function BetaExpansionRow({ id, children }: { id: string; children: ReactNode }) {
 return <ExpansionRowContext.Provider value={id}>{children}</ExpansionRowContext.Provider>
}

/** DOM disclosure state survives window eviction and live->canonical reuse. */
export function BetaDetails({ id, className, children }: { id: string; className?: string; children: ReactNode }) {
 const state = useContext(ExpansionContext)
 const rowId = useContext(ExpansionRowContext)
 const key = id.startsWith('task:') ? id : `${rowId}:${id}`
 return <details className={className} open={state?.get(key) ?? false} onToggle={(event) => state?.set(key, event.currentTarget.open)}>{children}</details>
}
