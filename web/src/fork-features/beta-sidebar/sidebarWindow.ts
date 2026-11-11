import type { VirtualRowHeights } from '@/fork-features/beta-timeline/betaVirtualizer'

export type SidebarAnchor = { id: string; offset: number }

export function captureSidebarAnchor(ids: readonly string[], heights: VirtualRowHeights, scrollTop: number): SidebarAnchor | null {
 const index = Math.min(heights.indexAtY(scrollTop), ids.length - 1)
 return index < 0 ? null : { id: ids[index], offset: scrollTop - heights.offsetOf(index) }
}

export function restoreSidebarAnchor(anchor: SidebarAnchor | null, ids: readonly string[], heights: VirtualRowHeights): number | null {
 if (!anchor) return null
 const index = ids.indexOf(anchor.id)
 return index < 0 ? null : Math.max(0, heights.offsetOf(index) + anchor.offset)
}

export function sidebarWindow(heights: VirtualRowHeights, count: number, top: number, viewport: number) {
 return {
  start: Math.max(0, heights.indexAtY(top) - 5),
  end: Math.min(count, heights.indexAtY(top + viewport) + 6),
 }
}

/** Query snapshots may clone unchanged objects. Compare values without serializing
 * every row or treating liveness-only heartbeats as a presentation change. */
export function sameSidebarValue(left: unknown, right: unknown): boolean {
 if (Object.is(left, right)) return true
 if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
 // API clients, callbacks and other opaque dependencies require identity.
 const prototype = Object.getPrototypeOf(left)
 if (prototype !== Object.getPrototypeOf(right) || (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null)) return false
 const a = Object.entries(left).filter(([key]) => key !== 'activeAt')
 const b = Object.entries(right).filter(([key]) => key !== 'activeAt')
 if (a.length !== b.length) return false
 return a.every(([key, value]) => Object.prototype.hasOwnProperty.call(right, key)
  && sameSidebarValue(value, Reflect.get(right, key)))
}
