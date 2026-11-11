/**
 * Select the HAPI transcript prefix to hydrate into a forked child session.
 * Historical fork excludes the boundary message and everything after it.
 * Current fork copies the full source transcript.
 * Pending scheduled/queued rows (`invokedAt == null`) are never copied — they
 * are not part of the native history being forked and would otherwise fire on
 * both the source and the child.
 *
 * Messages are ordered by invocation/display time (then seq) before slicing so
 * a late-seq agent reply that appeared before a queued user turn is retained.
 */
export function selectForkTranscriptPrefix<T extends {
 localId: string | null
 invokedAt: number | null
 createdAt: number
 seq: number
 position?: { at: number; order: number; eventOrder: number }
}>(
 messages: T[],
 messageLocalId?: string
): T[] {
 const ordered = messages.slice().sort((a, b) => {
  return (a.position?.at ?? a.invokedAt ?? a.createdAt) - (b.position?.at ?? b.invokedAt ?? b.createdAt)
   || (a.position?.order ?? 0) - (b.position?.order ?? 0)
   || (a.position?.eventOrder ?? 0) - (b.position?.eventOrder ?? 0) || a.seq - b.seq
 })
 let scoped: T[]
 if (!messageLocalId) {
  scoped = ordered
 } else {
  const cutoff = ordered.findIndex((message) => message.localId === messageLocalId)
  if (cutoff < 0) {
   throw new Error('Fork boundary message not found')
  }
  scoped = ordered.slice(0, cutoff)
 }
 return scoped.filter((message) => message.invokedAt != null)
}
