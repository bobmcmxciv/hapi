import { z } from 'zod'
import {
 TerminalErrorPayloadSchema,
 TerminalExitPayloadSchema,
 TerminalOutputPayloadSchema,
 TerminalReadyPayloadSchema
} from '@hapi/protocol'
import type { StoredSession } from '../../../store'
import type { TerminalRegistry } from '../../terminalRegistry'
import type { CliSocketWithData, SocketServer, SocketWithData } from '../../socketTypes'
import type { AccessErrorReason, AccessResult } from './types'
import { appendAgentTerminalOutput, clearAgentTerminalBuffer } from '../../agentTerminalBuffer'
import { appendUserTerminalOutput } from '../../userTerminalBuffer'

type ResolveSessionAccess = (sessionId: string) => AccessResult<StoredSession>

type EmitAccessError = (scope: 'session' | 'machine', id: string, reason: AccessErrorReason) => void

type SocketNamespace = ReturnType<SocketServer['of']>

const terminalReadySchema = TerminalReadyPayloadSchema
const terminalOutputSchema = TerminalOutputPayloadSchema
const terminalExitSchema = TerminalExitPayloadSchema
const terminalErrorSchema = TerminalErrorPayloadSchema

export type TerminalHandlersDeps = {
 terminalRegistry: TerminalRegistry
 terminalNamespace: SocketNamespace
 resolveSessionAccess: ResolveSessionAccess
 emitAccessError: EmitAccessError
 /**
  * Live ACL for the web viewer an event would be delivered to. Checked on
  * every output chunk: returning false revokes that viewer's terminal so a
  * narrowed machine grant stops output mid-stream. Absent => deliver to
  * whoever the registry/room says owns it (legacy behavior).
  */
 authorizeTerminalViewer?: (socket: SocketWithData, sessionId: string) => boolean
 /** Live ACL by ownerKey for detached terminals whose socket disconnected. */
 authorizeTerminalOwnerKey?: (ownerKey: string | undefined, sessionId: string) => boolean
}

export function registerTerminalHandlers(socket: CliSocketWithData, deps: TerminalHandlersDeps): void {
 const { terminalRegistry, terminalNamespace, resolveSessionAccess, emitAccessError, authorizeTerminalViewer, authorizeTerminalOwnerKey } = deps

 const resolveOwnedEntry = (payload: { sessionId: string; terminalId: string }) => {
  const entry = terminalRegistry.get(payload.terminalId)
  if (!entry || entry.cliSocketId !== socket.id || payload.sessionId !== entry.sessionId) return null
  const sessionAccess = resolveSessionAccess(payload.sessionId)
  if (!sessionAccess.ok) {
   emitAccessError('session', payload.sessionId, sessionAccess.reason)
   return null
  }
  return entry
 }

 const resolveOwnedTerminal = (payload: { sessionId: string; terminalId: string }) => {
  const entry = resolveOwnedEntry(payload)
  if (!entry) return null
  const terminalSocket = terminalNamespace.sockets.get(entry.socketId)
  return terminalSocket ? { entry, terminalSocket } : null
 }

 /**
  * Live grant re-check on the web viewer this terminal feeds. Revoked
  * access tears the terminal down — the registry entry goes (closing the
  * PTY's scrollback buffer), the viewer hears terminal:error, and the CLI
  * gets terminal:close so its ephemeral shell exits. Returns the viewer
  * socket only while it may still receive events.
  */
 const resolveAuthorizedEntry = (payload: { sessionId: string; terminalId: string }) => {
  const entry = resolveOwnedEntry(payload)
  if (!entry) return null
  const terminalSocket = terminalNamespace.sockets.get(entry.socketId)
  const authorized = terminalSocket
   ? (!authorizeTerminalViewer || authorizeTerminalViewer(terminalSocket, payload.sessionId))
   : (!authorizeTerminalOwnerKey || authorizeTerminalOwnerKey(entry.ownerKey, payload.sessionId))
  if (!authorized) {
   terminalRegistry.remove(payload.terminalId)
   terminalSocket?.emit('terminal:error', {
    sessionId: payload.sessionId,
    terminalId: payload.terminalId,
    message: 'Terminal access revoked.'
   })
   socket.emit('terminal:close', {
    sessionId: payload.sessionId,
    terminalId: payload.terminalId
   })
   return null
  }
  return { entry, terminalSocket }
 }

 const forwardTerminalEvent = (event: string, payload: { sessionId: string; terminalId: string } & Record<string, unknown>) => {
  const owned = resolveAuthorizedEntry(payload)
  if (!owned) return false
  owned.terminalSocket?.emit(event, payload)
  return true
 }

 const ownsAgentSession = (sessionId: string): boolean => socket.rooms.has(`session:${sessionId}`)


 socket.on('terminal:ready', (data: unknown) => {
  const parsed = terminalReadySchema.safeParse(data)
  if (!parsed.success) {
   return
  }
  if (forwardTerminalEvent('terminal:ready', parsed.data)) {
   terminalRegistry.markActivity(parsed.data.terminalId)
  }
 })

 socket.on('terminal:output', (data: unknown) => {
  const parsed = terminalOutputSchema.safeParse(data)
  if (!parsed.success) {
   return
  }
  const owned = resolveAuthorizedEntry(parsed.data)
  if (!owned) return
  terminalRegistry.markActivity(parsed.data.terminalId)
  // Keep buffering while the web socket is detached so its replacement
  // can replay everything the still-running PTY emitted in the gap.
  appendUserTerminalOutput(parsed.data.sessionId, parsed.data.terminalId, parsed.data.data)
  owned.terminalSocket?.emit('terminal:output', parsed.data)
 })

 socket.on('agent-terminal:output', (data: unknown) => {
  const parsed = terminalOutputSchema.safeParse(data)
  if (!parsed.success) {
   return
  }
  if (!ownsAgentSession(parsed.data.sessionId)) return
  const sessionAccess = resolveSessionAccess(parsed.data.sessionId)
  if (!sessionAccess.ok) {
   emitAccessError('session', parsed.data.sessionId, sessionAccess.reason)
   return
  }
  // Keep a scrollback buffer so a web client that subscribes later can be
  // replayed the current screen (avoids the black-screen-until-keystroke).
  appendAgentTerminalOutput(parsed.data.sessionId, parsed.data.data)
  // Fan out per authorized viewer instead of a blind room broadcast: a
  // narrowed grant must stop output mid-stream. Denied viewers are evicted
  // from the room so the streaming-teardown count stays honest; when none
  // remain the CLI is told to idle and stops streaming this PTY.
  const room = `agent-session:${parsed.data.sessionId}`
  const members = terminalNamespace.adapter.rooms.get(room)
  let delivered = 0
  if (members) {
   for (const socketId of [...members]) {
    const viewer = terminalNamespace.sockets.get(socketId)
    if (!viewer) continue
    if (authorizeTerminalViewer && !authorizeTerminalViewer(viewer, parsed.data.sessionId)) {
     viewer.leave(room)
     viewer.emit('agent-terminal:error', {
      sessionId: parsed.data.sessionId,
      message: 'Terminal access revoked.'
     })
     continue
    }
    viewer.emit('agent-terminal:output', parsed.data)
    delivered++
   }
  }
  if (members && members.size === 0 && delivered === 0) {
   socket.emit('agent-terminal:idle', { sessionId: parsed.data.sessionId })
  }
 })

 socket.on('agent-terminal:reset', (data: unknown) => {
  const parsed = z.object({ sessionId: z.string().min(1) }).safeParse(data)
  if (!parsed.success) {
   return
  }
  if (!ownsAgentSession(parsed.data.sessionId)) return
  const sessionAccess = resolveSessionAccess(parsed.data.sessionId)
  if (!sessionAccess.ok) {
   emitAccessError('session', parsed.data.sessionId, sessionAccess.reason)
   return
  }
  // A fresh agent PTY spawned — drop the previous session's scrollback so a
  // re-subscribing viewer doesn't replay stale (and alt-screen-corrupted)
  // output from before the restart.
  clearAgentTerminalBuffer(parsed.data.sessionId)
 })

 socket.on('terminal:exit', (data: unknown) => {
  const parsed = terminalExitSchema.safeParse(data)
  if (!parsed.success) {
   return
  }
  const entry = terminalRegistry.get(parsed.data.terminalId)
  if (!entry || entry.sessionId !== parsed.data.sessionId || entry.cliSocketId !== socket.id) {
   return
  }
  // remove() fires the registry's onRemove → clears this terminal's
  // scrollback buffer (without touching the session's other terminals).
  terminalRegistry.remove(parsed.data.terminalId)
  const terminalSocket = terminalNamespace.sockets.get(entry.socketId)
  if (!terminalSocket) {
   return
  }
  terminalSocket.emit('terminal:exit', parsed.data)
 })

 socket.on('terminal:error', (data: unknown) => {
  const parsed = terminalErrorSchema.safeParse(data)
  if (!parsed.success) {
   return
  }

  const entry = terminalRegistry.get(parsed.data.terminalId)
  if (!entry || entry.sessionId !== parsed.data.sessionId || entry.cliSocketId !== socket.id) {
   return
  }

  const sessionAccess = resolveSessionAccess(parsed.data.sessionId)
  if (!sessionAccess.ok) {
   terminalRegistry.remove(parsed.data.terminalId)
   emitAccessError('session', parsed.data.sessionId, sessionAccess.reason)
   return
  }

  const terminalSocket = terminalNamespace.sockets.get(entry.socketId)
  terminalRegistry.remove(parsed.data.terminalId)
  terminalSocket?.emit('terminal:error', parsed.data)
 })
}

export function cleanupTerminalHandlers(socket: CliSocketWithData, deps: { terminalRegistry: TerminalRegistry; terminalNamespace: SocketNamespace }): void {
 const removed = deps.terminalRegistry.removeByCliSocket(socket.id)
 for (const entry of removed) {
  const terminalSocket = deps.terminalNamespace.sockets.get(entry.socketId)
  terminalSocket?.emit('terminal:error', {
   terminalId: entry.terminalId,
   message: 'CLI disconnected.'
  })
 }
}
