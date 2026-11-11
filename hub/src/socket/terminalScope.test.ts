import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SignJWT } from 'jose'
import { createConfiguration } from '../configuration'
import { Store } from '../store'
import { SyncEngine } from '../sync/syncEngine'
import { SSEManager } from '../sse/sseManager'
import { VisibilityTracker } from '../visibility/visibilityTracker'
import { createSocketServer } from './server'
import type { SocketServer } from './socketTypes'
import type { RpcRegistry } from './rpcRegistry'
import type { Server as Engine } from '@socket.io/bun-engine'
import { MultiUserGatewayStore } from '../../../fork-features/multi-user/gatewayStore'
import { resolveTerminalNamespace } from '../../../fork-features/multi-user/socketAdapter'
import { resolveGatewayCliIdentity, resolveGatewayCliNamespace } from '../../../fork-features/multi-user/cliAdapter'
import { createSessionMachineResolver, createSessionPathResolver } from '../../../fork-features/multi-user/machineInheritance'
import { createApiToken } from '../../../fork-features/multi-user/token'

const jwtSecret = new Uint8Array(32).fill(7)
let configDirectory: string
beforeAll(async () => {
 configDirectory = mkdtempSync(join(tmpdir(), 'hapi-terminal-scope-'))
 const originalHome = process.env.HAPI_HOME
 const originalToken = process.env.CLI_API_TOKEN
 process.env.HAPI_HOME = configDirectory
 process.env.CLI_API_TOKEN = 'terminal-scope-fixture-master'
 try { await createConfiguration() }
 finally {
  if (originalHome === undefined) delete process.env.HAPI_HOME
  else process.env.HAPI_HOME = originalHome
  if (originalToken === undefined) delete process.env.CLI_API_TOKEN
  else process.env.CLI_API_TOKEN = originalToken
 }
})
afterAll(() => {
 try { if (configDirectory) rmSync(configDirectory, { recursive: true, force: true }) } catch { /* Windows temp cleanup */ }
})

async function signTerminalToken(accountId: number, apiTokenId?: number): Promise<string> {
 return new SignJWT({ uid: 1, ns: 'shared', gaid: accountId, ...(apiTokenId ? { tid: apiTokenId } : {}) })
  .setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('4h').sign(jwtSecret)
}

/** Real Engine.IO/Socket.IO websocket framing for one socket.io namespace. */
class ConnectedSocket {
 readonly socket: WebSocket
 private readonly frames: string[] = []
 private readonly waiters: Array<{ prefix: string; resolve: (frame: string) => void; reject: (error: Error) => void }> = []
 private ack = 0
 constructor(url: string, private readonly nsp: string, auth: Record<string, string>) {
  this.socket = new WebSocket(`${url.replace('http:', 'ws:')}/socket.io/?EIO=4&transport=websocket`)
  this.socket.addEventListener('message', event => {
   const frame = String(event.data)
   if (frame === '2') { this.socket.send('3'); return }
   if (frame.startsWith('0')) { this.socket.send(`40${this.nsp},${JSON.stringify(auth)}`); return }
   if (frame.startsWith(`44${this.nsp},`)) {
    // refused() waiters ask for this refusal and should see the frame;
    // everything else fails on it.
    const refusalIdx = this.waiters.findIndex(w => frame.startsWith(w.prefix))
    if (refusalIdx >= 0) {
     this.waiters.splice(refusalIdx, 1)[0].resolve(frame)
     return
    }
    this.frames.push(frame)
    for (const waiter of this.waiters.splice(0)) waiter.reject(new Error(`namespace refused connection: ${frame}`))
    return
   }
   const index = this.waiters.findIndex(waiter => frame.startsWith(waiter.prefix))
   if (index < 0) this.frames.push(frame)
   else this.waiters.splice(index, 1)[0].resolve(frame)
  })
  this.socket.addEventListener('error', () => {
   for (const waiter of this.waiters.splice(0)) waiter.reject(new Error('websocket transport failed'))
  })
 }
 wait(prefix: string): Promise<string> {
  const index = this.frames.findIndex(frame => frame.startsWith(prefix))
  if (index >= 0) return Promise.resolve(this.frames.splice(index, 1)[0])
  const { promise, resolve, reject } = Promise.withResolvers<string>()
  this.waiters.push({ prefix, resolve, reject })
  return promise
 }
 send(event: string, data: unknown): void {
  this.socket.send(`42${this.nsp},${JSON.stringify([event, data])}`)
 }
 async event<T = unknown>(name: string): Promise<T> {
  const frame = await this.wait(`42${this.nsp},["${name}"`)
  const json = frame.slice(`42${this.nsp},`.length)
  return (JSON.parse(json) as [string, T])[1]
 }
 async refused(): Promise<Record<string, unknown>> {
  const frame = await this.wait(`44${this.nsp},`)
  return JSON.parse(frame.slice(`44${this.nsp},`.length))
 }
 /** No event named `name` may arrive within the drain window. A negative
  * assertion has no deterministic signal to await, so a short real window is
  * required to prove nothing arrives. */
 async quiet(name: string, ms = 300): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<'timeout'>()
  setTimeout(() => resolve('timeout'), ms)
  const result = await Promise.race([
   this.event(name).then(() => 'event' as const),
   promise
  ])
  expect(result).toBe('timeout')
 }
 async barrier(): Promise<void> {
  const id = ++this.ack
  const response = this.wait(`43${this.nsp},${id}`)
  this.socket.send(`42${this.nsp},${id}["ping"]`)
  await response
 }
}

type Fixture = {
 store: Store
 gateway: MultiUserGatewayStore
 sync: SyncEngine
 url: string
 server: ReturnType<typeof Bun.serve>
 sockets: { io: SocketServer; engine: Engine; rpcRegistry: RpcRegistry }
 close: () => Promise<void>
}

async function startFixture(): Promise<Fixture> {
 const store = new Store(':memory:')
 const gateway = new MultiUserGatewayStore(':memory:')
 let sync: SyncEngine | null = null
 const sockets = createSocketServer({
  store,
  jwtSecret,
  corsOrigins: ['*'],
  getSession: id => sync?.getSession(id) ?? store.sessions.getSession(id),
  gatewayStore: gateway,
  resolveCliIdentity: value => resolveGatewayCliIdentity(gateway, value),
  resolveCliNamespace: value => resolveGatewayCliNamespace(gateway, value),
  resolveSessionMachineId: createSessionMachineResolver(() => sync),
  resolveSessionPath: createSessionPathResolver(() => sync),
  resolveTerminalNamespace: (accountId, sessionId, capability) => resolveTerminalNamespace({
   store: gateway,
   accountId,
   sessionId,
   capability,
   resolveSessionMachineId: createSessionMachineResolver(() => sync),
   resolveSessionPath: createSessionPathResolver(() => sync),
   getCoreSession: id => sync?.getSession(id) ?? store.sessions.getSession(id),
   getCoreMachine: id => store.machines.getMachine(id)
  }),
  onWebappEvent: event => sync?.handleRealtimeEvent(event)
 })
 sync = new SyncEngine(store, sockets.io, sockets.rpcRegistry, new SSEManager(30_000, new VisibilityTracker()))
 const transport = sockets.engine.handler()
 const server = Bun.serve({
  hostname: '127.0.0.1', port: 0, websocket: transport.websocket,
  fetch(request, server) { return transport.fetch(request, server) }
 })
 return {
  store, gateway, sync, sockets, server,
  url: `http://127.0.0.1:${server.port}`,
  close: async () => {
   sync?.stop()
   sockets.io.close()
   sockets.engine.close()
   await server.stop(true)
   store.close()
   gateway.close()
  }
 }
}

/** One bound machine (owner 'owner'), a session on it, and a CLI socket owning it. */
async function seedSessionOnMachine(fx: Fixture, owner: { id: number }, options: { path: string; cliAccount: { id: number } }) {
 const { gateway, sync } = fx
 gateway.bindResource({ resourceType: 'machine', resourceId: 'machine-1', ownerAccountId: owner.id, coreNamespace: 'shared' })
 sync.getOrCreateMachine('machine-1', { host: 'fixture', platform: 'linux', happyCliVersion: 'fixture' }, null, 'shared')
 const session = sync.getOrCreateSession('terminal-scope-test', { path: options.path, host: 'fixture', machineId: 'machine-1' }, null, 'shared')
 gateway.bindResource({ resourceType: 'session', resourceId: session.id, ownerAccountId: owner.id, coreNamespace: 'shared' })
 // A freshly-created row is inactive until a runner heartbeat marks it live;
 // terminal access requires session.active.
 sync.handleSessionAlive({ sid: session.id, time: Date.now() })
 const generated = createApiToken()
 gateway.createToken(options.cliAccount.id, 'cli', generated.hash, 'shared')
 const cli = new ConnectedSocket(fx.url, '/cli', { token: generated.plaintext, sessionId: session.id })
 await cli.wait(`40/cli`)
 await cli.barrier()
 return { session, cli, cliPlaintext: generated.plaintext }
}

async function connectTerminal(fx: Fixture, token: string): Promise<ConnectedSocket> {
 const terminal = new ConnectedSocket(fx.url, '/terminal', { token })
 await terminal.wait(`40/terminal`)
 return terminal
}

describe('terminal socket authorization (real socket.io)', () => {
 it('denies terminal:create on a session outside the account\'s directory-scoped machine grant — even same namespace', async () => {
  const fx = await startFixture()
  let terminal: ConnectedSocket | undefined
  try {
   const owner = fx.gateway.createAccount('owner', 'user', 'shared')
   const scoped = fx.gateway.createAccount('peter', 'user', 'shared')
   const { session, cli } = await seedSessionOnMachine(fx, owner, {
    path: 'C:\\vircs-projects\\oh-my-pi', // outside both roots
    cliAccount: owner
   })
   fx.gateway.grant('machine', 'machine-1', scoped.id, 'operator', ['C:\\Users\\Tadokoro', 'C:\\Peter'])
   expect(session.namespace).toBe('shared')

   terminal = await connectTerminal(fx, await signTerminalToken(scoped.id))
   terminal.send('terminal:create', { sessionId: session.id, terminalId: 'term-1', cols: 80, rows: 24 })

   const err = await terminal.event<{ terminalId: string; message: string }>('terminal:error')
   expect(err.terminalId).toBe('term-1')
   await cli.quiet('terminal:open')
   cli.socket.close()
  } finally {
   terminal?.socket.close()
   await fx.close()
  }
 }, 15_000)

 it('allows terminal:create through machine-inherited operator on an in-scope session', async () => {
  const fx = await startFixture()
  let terminal: ConnectedSocket | undefined
  try {
   const owner = fx.gateway.createAccount('owner', 'user', 'shared')
   const scoped = fx.gateway.createAccount('peter', 'user', 'shared')
   const { session, cli } = await seedSessionOnMachine(fx, owner, {
    path: 'C:\\Peter\\work',
    cliAccount: owner
   })
   fx.gateway.grant('machine', 'machine-1', scoped.id, 'operator', ['C:\\Users\\Tadokoro', 'C:\\Peter'])

   terminal = await connectTerminal(fx, await signTerminalToken(scoped.id))
   terminal.send('terminal:create', { sessionId: session.id, terminalId: 'term-1', cols: 80, rows: 24 })

   const open = await cli.event<{ sessionId: string; terminalId: string; cols: number; rows: number }>('terminal:open')
   expect(open).toEqual({ sessionId: session.id, terminalId: 'term-1', cols: 80, rows: 24 })
   cli.socket.close()
  } finally {
   terminal?.socket.close()
   await fx.close()
  }
 }, 15_000)

 it('narrows a live grant and blocks output, input, buffer replay and reconnect mid-session', async () => {
  const fx = await startFixture()
  let terminal: ConnectedSocket | undefined
  try {
   const owner = fx.gateway.createAccount('owner', 'user', 'shared')
   const scoped = fx.gateway.createAccount('peter', 'user', 'shared')
   const { session, cli } = await seedSessionOnMachine(fx, owner, {
    path: 'C:\\Peter\\work',
    cliAccount: owner
   })
   fx.gateway.grant('machine', 'machine-1', scoped.id, 'operator')

   terminal = await connectTerminal(fx, await signTerminalToken(scoped.id))
   terminal.send('terminal:create', { sessionId: session.id, terminalId: 'term-1', cols: 80, rows: 24 })
   await cli.event('terminal:open')

   // Live output reaches the viewer while access stands.
   cli.send('terminal:output', { sessionId: session.id, terminalId: 'term-1', data: 'before-narrow' })
   const first = await terminal.event<{ data: string }>('terminal:output')
   expect(first.data).toBe('before-narrow')

   // The machine grant narrows to a scope that excludes the session path.
   fx.gateway.grant('machine', 'machine-1', scoped.id, 'operator', ['C:\\Elsewhere'])

   cli.send('terminal:output', { sessionId: session.id, terminalId: 'term-1', data: 'after-narrow' })
   const revoke = await terminal.event<{ sessionId: string; terminalId: string; message: string }>('terminal:error')
   expect(revoke).toEqual({ sessionId: session.id, terminalId: 'term-1', message: 'Terminal access revoked.' })
   await terminal.quiet('terminal:output')

   // The CLI is asked to close its ephemeral shell; no process outside
   // terminal lifecycle is touched.
   const close = await cli.event<{ sessionId: string; terminalId: string }>('terminal:close')
   expect(close).toEqual({ sessionId: session.id, terminalId: 'term-1' })

   // Input on the dead terminal is dropped; a reconnect create is denied and
   // replays nothing.
   terminal.send('terminal:write', { terminalId: 'term-1', data: 'id\n' })
   await cli.quiet('terminal:write')
   terminal.send('terminal:create', { sessionId: session.id, terminalId: 'term-1', cols: 80, rows: 24 })
   const err = await terminal.event<{ terminalId: string; message: string }>('terminal:error')
   expect(err.terminalId).toBe('term-1')
   await cli.quiet('terminal:open')
   cli.socket.close()
  } finally {
   terminal?.socket.close()
   await fx.close()
  }
 }, 15_000)

 it('stops agent-terminal output to a revoked viewer and keeps delivering to an authorized one', async () => {
  const fx = await startFixture()
  let authorized: ConnectedSocket | undefined
  let revoked: ConnectedSocket | undefined
  try {
   const owner = fx.gateway.createAccount('owner', 'user', 'shared')
   const keep = fx.gateway.createAccount('keep', 'user', 'shared')
   const lose = fx.gateway.createAccount('lose', 'user', 'shared')
   const { session, cli } = await seedSessionOnMachine(fx, owner, {
    path: 'C:\\Peter\\work',
    cliAccount: owner
   })
   fx.gateway.grant('machine', 'machine-1', keep.id, 'operator')
   fx.gateway.grant('machine', 'machine-1', lose.id, 'operator')

   authorized = await connectTerminal(fx, await signTerminalToken(keep.id))
   revoked = await connectTerminal(fx, await signTerminalToken(lose.id))
   authorized.send('agent-terminal:subscribe', { sessionId: session.id })
   revoked.send('agent-terminal:subscribe', { sessionId: session.id })
   await cli.event('agent-terminal:refresh')
   await cli.event('agent-terminal:refresh')
   await cli.barrier()
   await authorized.barrier()
   await revoked.barrier()

   cli.send('agent-terminal:output', { sessionId: session.id, terminalId: 'agent', data: 'shared-chunk' })
   await authorized.event('agent-terminal:output')
   await revoked.event('agent-terminal:output')

   fx.gateway.grant('machine', 'machine-1', lose.id, 'operator', ['C:\\Elsewhere'])

   cli.send('agent-terminal:output', { sessionId: session.id, terminalId: 'agent', data: 'post-narrow' })
   await authorized.event('agent-terminal:output')
   const revoke = await revoked.event<{ sessionId: string; message: string }>('agent-terminal:error')
   expect(revoke).toEqual({ sessionId: session.id, message: 'Terminal access revoked.' })
   await revoked.quiet('agent-terminal:output')
   cli.socket.close()
  } finally {
   authorized?.socket.close()
   revoked?.socket.close()
   await fx.close()
  }
 }, 15_000)

 it('blocks a read-only (viewer) account from driving the agent PTY but allows subscribing', async () => {
  const fx = await startFixture()
  let terminal: ConnectedSocket | undefined
  try {
   const owner = fx.gateway.createAccount('owner', 'user', 'shared')
   const viewer = fx.gateway.createAccount('viewer', 'user', 'shared')
   const { session, cli } = await seedSessionOnMachine(fx, owner, {
    path: 'C:\\Peter\\work',
    cliAccount: owner
   })
   fx.gateway.grant('machine', 'machine-1', viewer.id, 'viewer')

   terminal = await connectTerminal(fx, await signTerminalToken(viewer.id))
   terminal.send('agent-terminal:subscribe', { sessionId: session.id })
   await cli.event('agent-terminal:refresh')

   terminal.send('agent-terminal:input', { sessionId: session.id, data: 'q' })
   terminal.send('terminal:create', { sessionId: session.id, terminalId: 'term-1', cols: 80, rows: 24 })
   const err = await terminal.event<{ terminalId: string }>('terminal:error')
   expect(err.terminalId).toBe('term-1')
   await cli.quiet('agent-terminal:input')
   await cli.quiet('terminal:open')
   cli.socket.close()
  } finally {
   terminal?.socket.close()
   await fx.close()
  }
 }, 15_000)

 it('rejects a /terminal handshake whose API token row was revoked, and a disabled account', async () => {
  const fx = await startFixture()
  try {
   const owner = fx.gateway.createAccount('owner', 'user', 'shared')
   const generated = createApiToken()
   const apiToken = fx.gateway.createToken(owner.id, 'web-token', generated.hash, 'shared')
   const liveToken = await signTerminalToken(owner.id, apiToken.id)

   const live = await connectTerminal(fx, liveToken)
   live.socket.close()

   fx.gateway.revokeToken(apiToken.id, owner.id)
   const dead = new ConnectedSocket(fx.url, '/terminal', { token: liveToken })
   const refusal = await dead.refused()
   expect(refusal.message).toBeDefined()
   dead.socket.close()

   const second = await signTerminalToken(owner.id)
   fx.gateway.updateAccount(owner.id, { disabled: true })
   const disabled = new ConnectedSocket(fx.url, '/terminal', { token: second })
   const refusal2 = await disabled.refused()
   expect(refusal2.message).toBeDefined()
   disabled.socket.close()
  } finally {
   await fx.close()
  }
 }, 15_000)
})
