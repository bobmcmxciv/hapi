import type { Socket } from 'socket.io'
import type { OmpSourceStore } from '../store/ompSources'

export class RpcRegistry {
 private readonly methodToSocketId: Map<string, string> = new Map()
 private readonly socketIdToMethods: Map<string, Set<string>> = new Map()
 private connectionOrder = 0
 private readonly sessionSources = new Map<string, {
  sourceId: string | null; socketId: string; attemptId: string | null; order: number; retired: Set<string>;
  /** Verified cleanup cut the source off: it can never publish or be reclaimed. */
  closed: boolean
 }>()
 /** Quarantine `killSession` registrations are disposal routes, never
  *  publication ownership. Every nonce that ever registered cleanup is
  *  kept (even after its socket disconnects) so verified cleanup can
  *  durably retire the whole dead generation at cutover. */
 private readonly cleanupSources = new Map<string, Map<string, { socketId: string; order: number }>>()
 private sourceStore?: OmpSourceStore

 bindSourceStore(store: OmpSourceStore): void {
  if (this.sourceStore && this.sourceStore !== store) throw new Error('RPC source store cannot change while running')
  this.sourceStore = store
 }

 canUseLegacySessionSource(sessionId: string): boolean {
  const source = this.sessionSources.get(sessionId)
  return !this.sourceStore?.get(sessionId) && !source?.sourceId && !source?.closed
 }

 nextSourceConnectionOrder(): number {
  return ++this.connectionOrder
 }

 /** Publication ownership requires a claimed source. A cleanup-only
  *  `killSession` registration routes disposal RPCs but claims nothing. */
 isClaimedSessionSource(sessionId: string, socketId: string): boolean {
  const source = this.sessionSources.get(sessionId)
  return source !== undefined && !source.closed && source.socketId === socketId
   && this.methodToSocketId.get(`${sessionId}:killSession`) === socketId
 }

 /**
  * Quarantine gate: the wrapper may self-dispose while publication stays
  * fenced. Records the disposal route and its nonce for cutover retirement;
  * never claims a source and never replaces a claimed owner.
  */
 registerCleanupSource(socket: Socket, sessionId: string, sourceId: string, order: number): void {
  let entries = this.cleanupSources.get(sessionId)
  if (!entries) {
   entries = new Map()
   this.cleanupSources.set(sessionId, entries)
  }
  entries.set(sourceId, { socketId: socket.id, order })
  this.register(socket, `${sessionId}:killSession`)
 }

 /**
  * Verified cleanup cutover. Retires every dead-generation nonce durably
  * (claimed source and all cleanup registrations) so a Hub restart cannot
  * revive it, strips the dead sockets' session RPC routes and closes the
  * in-memory source so its socket can never publish into the new
  * generation. Must run BEFORE quarantine metadata is cleared.
  */
 retireSessionSources(sessionId: string): void {
  const current = this.sessionSources.get(sessionId)
  const cleanup = this.cleanupSources.get(sessionId)
  const durable = this.sourceStore?.get(sessionId)
  this.sourceStore?.closeLegacyCompatibility(sessionId)
  const retired = current?.retired ?? new Set<string>()
  const socketsToStrip = new Set<string>()
  let order = current?.order ?? 0
  if (current?.socketId) socketsToStrip.add(current.socketId)
  if (current?.sourceId) {
   retired.add(current.sourceId)
   this.sourceStore?.retire(sessionId, current.sourceId)
  }
  // A restarted Hub may verify cleanup before the former owner reconnects.
  // Its durable nonce is still dead-generation evidence, even with no socket.
  if (durable?.sourceId && durable.sourceId !== current?.sourceId) {
   retired.add(durable.sourceId)
   this.sourceStore?.retire(sessionId, durable.sourceId)
  }
  for (const [sourceId, entry] of cleanup ?? []) {
   if (sourceId !== current?.sourceId) {
    retired.add(sourceId)
    this.sourceStore?.retire(sessionId, sourceId)
   }
   socketsToStrip.add(entry.socketId)
   if (entry.order > order) order = entry.order
  }
  for (const socketId of socketsToStrip) this.clearSessionMethods(sessionId, socketId)
  this.sessionSources.set(sessionId, {
   sourceId: current?.sourceId ?? durable?.sourceId ?? null,
   socketId: '',
   attemptId: current?.attemptId ?? durable?.attemptId ?? null,
   order,
   retired,
   closed: true
  })
  this.cleanupSources.delete(sessionId)
 }

 canInitializeSessionSource(sessionId: string, sourceId: string | null, order: number, attemptId: string | null = null): boolean {
  const killSocket = this.methodToSocketId.get(`${sessionId}:killSession`)
  const current = this.sessionSources.get(sessionId)
  if (killSocket) {
   // A live claimed owner blocks all bootstrap. A registered cleanup
   // route never blocks the replacement; anything else holding the
   // route without a claim or cleanup registration is fenced too.
   if (current && !current.closed && current.socketId === killSocket) return false
   const cleanup = this.cleanupSources.get(sessionId)
   let cleanupRoute = false
   for (const entry of cleanup?.values() ?? []) {
    if (entry.socketId === killSocket) cleanupRoute = true
   }
   if (!cleanupRoute) return false
  }
  if (sourceId === null) {
   return this.canUseLegacySessionSource(sessionId) && (!current || order >= current.order)
  }
  const durable = this.sourceStore?.get(sessionId)
  if (this.sourceStore?.isRetired(sessionId, sourceId)
   || (durable?.sourceId && durable.sourceId !== sourceId && durable.attemptId === attemptId)) return false
  if (current?.sourceId && current.sourceId !== sourceId && current.attemptId === attemptId) return false
  if (current?.closed && current.sourceId === sourceId) return false
  return !current || (!current.retired.has(sourceId)
   && (current.sourceId !== sourceId || order >= current.order))
 }

 /** Legacy identity is unknowable; only never-modern, never-generation-bound sessions may use it. */
 claimLegacySessionSource(socket: Socket, sessionId: string, order: number): boolean {
  if (!this.canUseLegacySessionSource(sessionId)) return false
  const previous = this.sessionSources.get(sessionId)
  if (previous && !previous.closed && order < previous.order) return false
  this.replaceSessionSource(socket, sessionId, null, null, order)
  return true
 }

 /** A durable binding requires a new server attempt before a different modern process can replace it. */
 claimSessionSource(socket: Socket, sessionId: string, sourceId: string, attemptId: string | null, order: number): boolean {
  const previous = this.sessionSources.get(sessionId)
  if (previous?.retired.has(sourceId)) return false
  if (previous?.closed && previous.sourceId === sourceId) return false
  if (previous?.sourceId === sourceId && order < previous.order) return false
  if (previous?.sourceId && previous.sourceId !== sourceId && previous.attemptId === attemptId) return false
  if (this.sourceStore && !this.sourceStore.claim(sessionId, sourceId, attemptId)) return false
  this.replaceSessionSource(socket, sessionId, sourceId, attemptId, order)
  return true
 }

 private replaceSessionSource(socket: Socket, sessionId: string, sourceId: string | null, attemptId: string | null, order: number): void {
  const previous = this.sessionSources.get(sessionId)
  const retired = previous?.retired ?? new Set<string>()
  if (previous?.sourceId && previous.sourceId !== sourceId) retired.add(previous.sourceId)
  if (previous && previous.socketId !== socket.id) {
   this.clearSessionMethods(sessionId, previous.socketId)
  }
  this.sessionSources.set(sessionId, { sourceId, socketId: socket.id, attemptId, order, retired, closed: false })
 }

 private removeMethod(socketId: string, method: string): void {
  if (this.methodToSocketId.get(method) === socketId) this.methodToSocketId.delete(method)
  const methods = this.socketIdToMethods.get(socketId)
  if (!methods) return
  methods.delete(method)
  if (methods.size === 0) this.socketIdToMethods.delete(socketId)
 }

 private clearSessionMethods(sessionId: string, socketId: string): void {
  const methods = this.socketIdToMethods.get(socketId)
  if (!methods) return
  for (const method of [...methods]) {
   if (method.startsWith(`${sessionId}:`)) this.removeMethod(socketId, method)
  }
 }

 register(socket: Socket, method: string): void {
  if (!method) {
   return
  }

  this.methodToSocketId.set(method, socket.id)

  const existing = this.socketIdToMethods.get(socket.id)
  if (existing) {
   existing.add(method)
  } else {
   this.socketIdToMethods.set(socket.id, new Set([method]))
  }
 }

 unregister(socket: Socket, method: string): void {
  this.removeMethod(socket.id, method)
 }

 unregisterAll(socket: Socket): void {
  const methods = this.socketIdToMethods.get(socket.id)
  if (!methods) {
   return
  }
  for (const method of methods) {
   this.removeMethod(socket.id, method)
  }
 }

 getSocketIdForMethod(method: string): string | null {
  return this.methodToSocketId.get(method) ?? null
 }
}
