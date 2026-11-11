import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode, RefObject } from 'react'
import { createVirtualRowHeights, selectVirtualIndices } from '@/fork-features/beta-timeline/betaVirtualizer'
import { captureSidebarAnchor, restoreSidebarAnchor, sidebarWindow } from './sidebarWindow'

export type SidebarRow = { id: string; focusable?: boolean }

function MeasuredSidebarRow(props: {
 id: string
 top: number
 onHeight: (id: string, height: number) => void
 children: ReactNode
}) {
 const ref = useRef<HTMLDivElement>(null)
 useLayoutEffect(() => {
  const element = ref.current
  if (!element) return
  const measure = () => props.onHeight(props.id, element.getBoundingClientRect().height)
  measure()
  const observer = new ResizeObserver(measure)
  observer.observe(element)
  return () => observer.disconnect()
 }, [props.id, props.onHeight])
 return <div ref={ref} data-sidebar-row={props.id} style={{ position: 'absolute', top: props.top, left: 0, right: 0, paddingBottom: 4 }}>{props.children}</div>
}

/** A single flat window includes group controls as well as sessions. Collapsed
 * groups never instantiate hidden action/tooltip trees. Focus and open dialogs
 * are disjoint pins, not a range spanning thousands of intervening rows. */
export function BetaSidebarWindow<Row extends SidebarRow>(props: {
 rows: readonly Row[]
 scrollRef: RefObject<HTMLDivElement | null>
 resetKey: string
 pinnedIds: readonly string[]
 renderRow: (row: Row) => ReactNode
}) {
 const heights = useMemo(() => createVirtualRowHeights(64), [])
 const previousIds = useRef<readonly string[]>([])
 const previousReset = useRef(props.resetKey)
 const windowRef = useRef<HTMLDivElement>(null)
 const pendingFocus = useRef<string | null>(null)
 const [revision, setRevision] = useState(0)
 const [focusedId, setFocusedId] = useState<string | null>(null)
 // Data-only updates retain both IDs and the measured index without allocating
 // a serialized key or an ID array for every heartbeat.
 const stableIds = useRef<readonly string[]>([])
 if (stableIds.current.length !== props.rows.length || props.rows.some((row, index) => row.id !== stableIds.current[index])) {
  stableIds.current = props.rows.map(row => row.id)
 }
 const ids = stableIds.current
 const [viewport, setViewport] = useState({ top: 0, height: 640 })
 const updateViewport = useCallback(() => {
  const element = props.scrollRef.current
  if (!element) return
  const next = { top: element.scrollTop, height: element.clientHeight || 640 }
  setViewport(current => current.top === next.top && current.height === next.height ? current : next)
 }, [props.scrollRef])

 useLayoutEffect(() => {
  const element = props.scrollRef.current
  // Ancestor host refs may not be attached during this child's first layout
  // effect. The height index still needs initialization on that first commit.
  const anchor = captureSidebarAnchor(previousIds.current, heights, element?.scrollTop ?? 0)
  heights.setRowIds(ids)
  previousIds.current = ids
  if (previousReset.current !== props.resetKey) {
   if (element) element.scrollTop = 0
   previousReset.current = props.resetKey
  } else if (element) {
   const restored = restoreSidebarAnchor(anchor, ids, heights)
   if (restored !== null) element.scrollTop = restored
  }
  updateViewport()
  setRevision(value => value + 1)
 }, [ids, props.resetKey, heights, updateViewport])

 // Passive setup runs after ancestor refs attach; structural anchor correction
 // above stays in layout so insertions do not paint at the wrong offset.
 useEffect(() => {
  const element = props.scrollRef.current
  if (!element) return
  updateViewport()
  element.addEventListener('scroll', updateViewport, { passive: true })
  const observer = new ResizeObserver(updateViewport)
  observer.observe(element)
  return () => {
   element.removeEventListener('scroll', updateViewport)
   observer.disconnect()
  }
 }, [props.scrollRef, updateViewport])

 const onHeight = useCallback((id: string, height: number) => {
  const element = props.scrollRef.current
  const anchor = captureSidebarAnchor(previousIds.current, heights, element?.scrollTop ?? 0)
  if (!heights.setHeight(id, height)) return
  if (element) {
   const restored = restoreSidebarAnchor(anchor, previousIds.current, heights)
   if (restored !== null) element.scrollTop = restored
  }
  updateViewport()
  setRevision(value => value + 1)
 }, [heights, props.scrollRef, updateViewport])
 void revision
 const pins = [...props.pinnedIds, ...(focusedId ? [focusedId] : [])].map(id => ids.indexOf(id))
 const indices = selectVirtualIndices(sidebarWindow(heights, ids.length, viewport.top, viewport.height), ids.length, pins, 80)

 useLayoutEffect(() => {
  if (!pendingFocus.current) return
  const row = Array.from(windowRef.current?.querySelectorAll<HTMLElement>('[data-sidebar-row]') ?? []).find(element => element.dataset.sidebarRow === pendingFocus.current)
  const button = row?.querySelector<HTMLButtonElement>('button')
  if (button) {
   pendingFocus.current = null
   button.focus({ preventScroll: true })
  }
 })

 return <div
  ref={windowRef}
  data-beta-sidebar="true"
  style={{ position: 'relative', height: heights.totalHeight(), overflowAnchor: 'none' }}
  onKeyDown={event => {
   if (!(event.target instanceof HTMLButtonElement)) return
   if (event.target.closest('[role="menu"], [role="dialog"]')) return
   if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'PageDown', 'PageUp'].includes(event.key)) return
   const current = event.target.closest<HTMLElement>('[data-sidebar-row]')?.dataset.sidebarRow
   if (!current) return
   event.preventDefault()
   const step = Math.max(1, Math.floor(viewport.height / 64))
   const index = ids.indexOf(current)
   const requested = event.key === 'Home' ? 0 : event.key === 'End' ? ids.length - 1 : index + (event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : event.key === 'PageDown' ? step : -step)
   let next = Math.max(0, Math.min(ids.length - 1, requested))
   const direction = event.key === 'Home' || event.key === 'ArrowDown' || event.key === 'PageDown' ? 1 : -1
   while (props.rows[next]?.focusable === false && next >= 0 && next < ids.length) next += direction
   if (next < 0 || next >= ids.length) return
   pendingFocus.current = ids[next]
   const element = props.scrollRef.current
   if (element) element.scrollTop = heights.offsetOf(next)
   updateViewport()
   setRevision(value => value + 1)
  }}
  onFocusCapture={event => setFocusedId(event.target.closest<HTMLElement>('[data-sidebar-row]')?.dataset.sidebarRow ?? null)}
  onBlurCapture={event => {
   const next = event.relatedTarget
   if (!(next instanceof Node) || !event.currentTarget.contains(next)) setFocusedId(null)
  }}
 >
  {indices.map(index => <MeasuredSidebarRow key={ids[index]} id={ids[index]} top={heights.offsetOf(index)} onHeight={onHeight}>
   {props.renderRow(props.rows[index])}
  </MeasuredSidebarRow>)}
 </div>
}
