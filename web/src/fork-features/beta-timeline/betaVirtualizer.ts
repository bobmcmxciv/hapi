/** Incremental measured-height index. Content resize costs O(log n), never a
 * whole-history prefix rebuild. Structure changes alone rebuild the tree. */
export type VirtualRowHeights = {
 totalHeight(): number
 offsetOf(index: number): number
 /** First row whose bottom edge is below y; count when past the tail. */
 indexAtY(y: number): number
 setHeight(id: string, height: number): boolean
 setRowIds(ids: readonly string[]): void
}

export function createVirtualRowHeights(defaultEstimate: number): VirtualRowHeights {
 const measured = new Map<string, number>()
 const positions = new Map<string, number>()
 let tree = new Float64Array(1)
 let count = 0
 const prefix = (length: number) => {
  let sum = 0
  for (let i = length; i > 0; i -= i & -i) sum += tree[i]
  return sum
 }
 return {
  totalHeight: () => prefix(count),
  offsetOf: (index) => prefix(Math.max(0, Math.min(index, count))),
  indexAtY(y) {
   if (y < 0) return 0
   // Fenwick lower bound: largest prefix not greater than y.
   let position = 0
   let sum = 0
   let bit = 1
   while (bit * 2 <= count) bit *= 2
   for (; bit > 0; bit >>>= 1) {
    const next = position + bit
    if (next <= count && sum + tree[next] <= y) {
     position = next
     sum += tree[next]
    }
   }
   return position
  },
  setHeight(id, height) {
   if (!Number.isFinite(height) || height <= 0) return false
   const rounded = Math.round(height * 10) / 10
   const before = measured.get(id) ?? defaultEstimate
   if (Math.abs(before - rounded) < 1) return false
   measured.set(id, rounded)
   const position = positions.get(id)
   if (position !== undefined) {
    const delta = rounded - before
    for (let i = position + 1; i <= count; i += i & -i) tree[i] += delta
   }
   return true
  },
  setRowIds(ids) {
   count = ids.length
   positions.clear()
   tree = new Float64Array(count + 1)
   for (let i = 1; i <= count; i += 1) {
    const id = ids[i - 1]
    positions.set(id, i - 1)
    tree[i] += measured.get(id) ?? defaultEstimate
    const parent = i + (i & -i)
    if (parent <= count) tree[parent] += tree[i]
   }
   // Keep the measurement cache proportional to this mounted session.
   if (measured.size > count * 2) {
    for (const id of measured.keys()) if (!positions.has(id)) measured.delete(id)
   }
  }
 }
}

export type VirtualRange = { start: number; end: number }

/** Select disjoint rows for the window and interaction pins. Unlike extending
 * min/max, a remote focus/selection pin cannot mount the intervening history. */
export function selectVirtualIndices(range: VirtualRange, count: number, pins: readonly number[], maximum = 100): number[] {
 const indices = new Set<number>()
 const start = Math.max(0, Math.min(range.start, count))
 const end = Math.min(count, range.end, start + maximum)
 for (let i = start; i < end; i += 1) indices.add(i)
 for (const index of pins) if (index >= 0 && index < count) indices.add(index)
 return Array.from(indices).sort((a, b) => a - b)
}
