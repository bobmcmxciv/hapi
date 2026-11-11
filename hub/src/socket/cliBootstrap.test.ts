import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { createConfiguration } from '../configuration'
import { Store } from '../store'
import { SyncEngine } from '../sync/syncEngine'
import { RuntimeTimelineRegistry } from '../sync/runtimeTimeline'
import { SSEManager } from '../sse/sseManager'
import { VisibilityTracker } from '../visibility/visibilityTracker'
import { createCliRoutes } from '../web/routes/cli'
import { createSocketServer } from './server'
import { MultiUserGatewayStore } from '../../../fork-features/multi-user/gatewayStore'
import { resolveGatewayCliIdentity, resolveGatewayCliNamespace } from '../../../fork-features/multi-user/cliAdapter'
import { createSessionMachineResolver, createSessionPathResolver } from '../../../fork-features/multi-user/machineInheritance'
import { createApiToken } from '../../../fork-features/multi-user/token'

let configDirectory: string
beforeAll(async () => {
 configDirectory = mkdtempSync(join(tmpdir(), 'hapi-cli-bootstrap-'))
 const originalHome = process.env.HAPI_HOME
 const originalToken = process.env.CLI_API_TOKEN
 process.env.HAPI_HOME = configDirectory
 process.env.CLI_API_TOKEN = 'bootstrap-fixture-master'
 try { await createConfiguration() }
 finally {
  if (originalHome === undefined) delete process.env.HAPI_HOME
  else process.env.HAPI_HOME = originalHome
  if (originalToken === undefined) delete process.env.CLI_API_TOKEN
  else process.env.CLI_API_TOKEN = originalToken
 }
})
afterAll(() => { if (configDirectory) rmSync(configDirectory, { recursive: true, force: true }) })

/** Real Engine.IO/Socket.IO websocket framing, without a browser or claim route. */
class ConnectedCli {
 readonly socket: WebSocket
 private readonly frames: string[] = []
 private readonly waiters: Array<{ prefix: string; resolve: (frame: string) => void; reject: (error: Error) => void }> = []
 private ack = 0
 constructor(url: string, auth: Record<string, string>) {
  this.socket = new WebSocket(`${url.replace('http:', 'ws:')}/socket.io/?EIO=4&transport=websocket`)
  this.socket.addEventListener('message', event => {
   const frame = String(event.data)
   if (frame === '2') { this.socket.send('3'); return }
   if (frame.startsWith('0')) { this.socket.send(`40/cli,${JSON.stringify(auth)}`); return }
   if (frame.startsWith('44/cli,')) {
    for (const waiter of this.waiters.splice(0)) waiter.reject(new Error(`CLI namespace refused connection: ${frame}`))
    return
   }
   const index = this.waiters.findIndex(waiter => frame.startsWith(waiter.prefix))
   if (index < 0) this.frames.push(frame)
   else this.waiters.splice(index, 1)[0].resolve(frame)
  })
  this.socket.addEventListener('error', () => {
   for (const waiter of this.waiters.splice(0)) waiter.reject(new Error('CLI websocket transport failed'))
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
  this.socket.send(`42/cli,${JSON.stringify([event, data])}`)
 }
 async request(event: string, data: unknown): Promise<unknown> {
  const id = ++this.ack
  const prefix = `43/cli,${id}`
  const response = this.wait(prefix)
  this.socket.send(`42/cli,${id}${JSON.stringify([event, data])}`)
  return JSON.parse((await response).slice(prefix.length))[0]
 }
 async barrier(): Promise<void> {
  const id = ++this.ack
  const response = this.wait(`43/cli,${id}`)
  this.socket.send(`42/cli,${id}["ping"]`)
  await response
 }
}

const scenarios = ['owner', 'operator', 'stranger', 'viewer', 'out-of-scope', 'missing-machine', 'core-namespace-mismatch',
 'binding-namespace-mismatch', 'grant-revoked', 'token-revoked', 'wrong-generation', 'quarantined',
 'quarantined-no-attempt', 'quarantined-viewer', 'quarantined-retired',
 'legacy-active', 'legacy-generation', 'legacy-quarantined'] as const

describe('connected native CLI startup before gateway session binding', () => {
 it.each(['current', 'grant-revoked', 'token-revoked', 'wrong-generation', 'replaced-source'] as const)('holds recorded reconnect publications until source registration without widening authority (%s)', async scenario => {
  const store = new Store(':memory:')
  const gateway = new MultiUserGatewayStore(':memory:')
  const owner = gateway.createAccount('reconnect-owner', 'user', 'shared')
  const operator = gateway.createAccount('reconnect-operator', 'user', 'shared')
  const generated = createApiToken()
  const token = gateway.createToken(operator.id, 'reconnect', generated.hash, 'shared')
  const session = store.sessions.getOrCreateSession(`reconnect-${scenario}`, {
   flavor: 'omp', path: '/allowed/project', host: 'fixture', ompRuntimeAttemptId: 'generation',
   ompSession: { id: 'native-session', file: '/tmp/native-session.jsonl' }
  }, null, 'shared')
  gateway.bindResource({ resourceType: 'session', resourceId: session.id, ownerAccountId: owner.id, coreNamespace: 'shared' })
  gateway.grant('session', session.id, operator.id, 'operator')
  store.sessions.ompSources.claim(session.id, 'recorded-source', 'generation')
  store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'executed while Hub was offline' } }, 'delivered')
  store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'cancelled while offline' } }, 'cancelled')
  const sockets = createSocketServer({
   store, jwtSecret: new Uint8Array(32).fill(7), corsOrigins: ['*'], gatewayStore: gateway,
   resolveCliIdentity: value => resolveGatewayCliIdentity(gateway, value),
   resolveCliNamespace: value => resolveGatewayCliNamespace(gateway, value)
  })
  const transport = sockets.engine.handler()
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, websocket: transport.websocket, fetch: transport.fetch })
  const cli = new ConnectedCli(`http://127.0.0.1:${server.port}`, {
   token: generated.plaintext, sessionId: session.id, ompSourceId: 'recorded-source',
   ompResumeAttemptId: scenario === 'wrong-generation' ? 'stale' : 'generation'
  })
  try {
   await cli.wait('40/cli,')
   cli.send('message', { sid: session.id, message: { role: 'agent', content: { type: 'text', text: 'buffered final answer' } } })
   cli.send('messages-consumed', {
    sid: session.id, localIds: ['delivered'], nativeDelivery: {
     sessionId: 'native-session', entryId: 'user-entry', entryOrder: 2, deliveredAt: '2026-11-09T00:00:00Z'
    }
   })
   cli.send('messages-resolved', {
    sid: session.id, resolutions: [{
     localId: 'cancelled', outcome: 'cancelled',
     nativeOrder: { sessionId: 'native-session', entryId: 'cancel-entry', entryOrder: 3, eventOrder: 0 }
    }]
   })
   const metadataUpdate = scenario === 'current' ? cli.request('update-metadata', {
    sid: session.id, expectedVersion: session.metadataVersion,
    metadata: {
     flavor: 'omp', path: '/allowed/project', host: 'fixture', ompRuntimeAttemptId: 'generation',
     ompSession: { id: 'new-native-session', file: '/tmp/new-native-session.jsonl' }
    }
   }) : undefined
   await cli.barrier()
   expect(store.messages.getAllMessages(session.id)).toHaveLength(2)
   expect(store.messages.getLocalMessageStates(session.id, ['delivered', 'cancelled']).every(row => row.invokedAt === null && !row.resolution)).toBe(true)
   expect(store.sessions.getSession(session.id)?.metadata).toMatchObject({ ompSession: { id: 'native-session' } })
   if (scenario === 'grant-revoked') gateway.removeGrant('session', session.id, operator.id)
   if (scenario === 'token-revoked') gateway.revokeToken(token.id, operator.id)
   if (scenario === 'replaced-source') store.sessions.ompSources.claim(session.id, 'replacement', 'next-generation')
   cli.send('rpc-register', { method: `${session.id}:killSession` })
   await cli.barrier()
   const rows = store.messages.getAllMessages(session.id)
   const delivered = rows.find(row => row.localId === 'delivered')!
   const cancelled = rows.find(row => row.localId === 'cancelled')!
   if (scenario === 'current') {
    expect(await metadataUpdate).toMatchObject({ result: 'success' })
    expect(store.sessions.getSession(session.id)?.metadata).toMatchObject({ ompSession: { id: 'new-native-session' } })
    expect(rows.some(row => (row.content as { role?: string }).role === 'agent')).toBe(true)
    expect(delivered.invokedAt).toBe(Date.parse('2026-11-09T00:00:00Z'))
    expect(cancelled.invokedAt).toBeNull()
    expect(cancelled.resolution?.outcome).toBe('cancelled')
   } else {
    expect(rows).toHaveLength(2)
    expect(delivered.invokedAt).toBeNull()
    expect(cancelled.resolution).toBeUndefined()
   }
  } finally {
   cli.socket.close()
   sockets.io.close()
   sockets.engine.close()
   await server.stop(true)
   store.close()
   gateway.close()
  }
 }, 10_000)

 it.each([...scenarios])('registers/publishes only with authoritative machine inheritance (%s)', async scenario => {
  const store = new Store(':memory:')
  const gateway = new MultiUserGatewayStore(':memory:')
  const owner = gateway.createAccount('owner', 'user', 'shared')
  const operator = gateway.createAccount('operator', 'user', 'shared')
  const stranger = gateway.createAccount('stranger', 'user', 'shared')
  gateway.bindResource({
   resourceType: 'machine', resourceId: 'machine', ownerAccountId: owner.id,
   coreNamespace: scenario === 'binding-namespace-mismatch' ? 'foreign' : 'shared'
  })
  gateway.grant('machine', 'machine', operator.id, scenario === 'viewer' || scenario === 'quarantined-viewer' ? 'viewer' : 'operator', '/allowed')
  const account = scenario === 'owner' || scenario === 'wrong-generation' || scenario === 'missing-machine'
   || scenario === 'core-namespace-mismatch' || scenario === 'binding-namespace-mismatch' ? owner
   : scenario === 'stranger' ? stranger : operator
  const generated = createApiToken()
  const token = gateway.createToken(account.id, 'connected-cli', generated.hash, 'shared')
  let sync: SyncEngine | null = null
  const ready: string[] = []
  const alive: string[] = []
  const runtime = new RuntimeTimelineRegistry()
  const sockets = createSocketServer({
   store, jwtSecret: new Uint8Array(32).fill(7), corsOrigins: ['*'], gatewayStore: gateway, runtimeRegistry: runtime,
   resolveCliIdentity: value => resolveGatewayCliIdentity(gateway, value),
   resolveCliNamespace: value => resolveGatewayCliNamespace(gateway, value),
   resolveSessionMachineId: createSessionMachineResolver(() => sync),
   resolveSessionPath: createSessionPathResolver(() => sync),
   onSessionAlive: payload => { alive.push(payload.sid); sync?.handleSessionAlive(payload) },
   onSessionReady: payload => { ready.push(payload.sid); sync?.handleSessionReady(payload) },
   onWebappEvent: event => sync?.handleRealtimeEvent(event)
  })
  sync = new SyncEngine(store, sockets.io, sockets.rpcRegistry, new SSEManager(30_000, new VisibilityTracker()))
  const engine = sync
  if (scenario !== 'missing-machine') engine.getOrCreateMachine('machine', { host: 'fixture', platform: 'linux', happyCliVersion: 'fixture' }, null,
   scenario === 'core-namespace-mismatch' ? 'foreign' : 'shared')
  const app = new Hono()
  app.route('/cli', createCliRoutes(() => engine, value => resolveGatewayCliNamespace(gateway, value), { gatewayStore: gateway }))
  const transport = sockets.engine.handler()
  const server = Bun.serve({
   hostname: '127.0.0.1', port: 0, websocket: transport.websocket,
   fetch(request, server) {
    return new URL(request.url).pathname.startsWith('/socket.io/') ? transport.fetch(request, server) : app.fetch(request)
   }
  })
  const url = `http://127.0.0.1:${server.port}`
  let cli: ConnectedCli | undefined
  try {
   const response = await fetch(`${url}/cli/sessions`, {
    method: 'POST', headers: {
     authorization: `Bearer ${generated.plaintext}`, 'content-type': 'application/json'
    }, body: JSON.stringify({
     tag: `bootstrap-${scenario}`, metadata: {
      path: scenario === 'out-of-scope' ? '/allowed-other/project' : '/allowed/project', host: 'fixture',
      machineId: 'machine', flavor: 'omp',
      ...(scenario === 'legacy-active' ? {} : { ompRuntimeAttemptId: 'current' }),
      ...(scenario.startsWith('quarantined') || scenario === 'legacy-quarantined' ? { ompResumeAttempt: { attemptId: 'current', state: 'quarantined', machineId: 'machine', startedAt: 1 } } : {})
     }
    })
   })
   expect(response.status).toBe(200)
   const { session } = await response.json() as { session: { id: string } }
   expect(gateway.getResource('session', session.id)).toBeNull()
   if (scenario === 'quarantined-retired') {
    store.sessions.ompSources.claim(session.id, 'source-main', 'old')
    store.sessions.ompSources.claim(session.id, 'current-source', 'current')
   }
   cli = new ConnectedCli(url, {
    token: generated.plaintext, sessionId: session.id,
    ...(scenario.startsWith('legacy-') ? {} : {
     ompSourceId: 'source-main',
     ...(scenario === 'quarantined-no-attempt' ? {} : { ompResumeAttemptId: scenario === 'wrong-generation' ? 'old' : 'current' })
    })
   })
   await cli.wait('40/cli,')
   if (scenario === 'token-revoked') gateway.revokeToken(token.id, account.id)
   if (scenario === 'grant-revoked') gateway.removeGrant('machine', 'machine', account.id)
   const publish = async (text: string) => {
    if (scenario === 'legacy-active') cli!.send('rpc-register', { method: `${session.id}:abort` })
    cli!.send('rpc-register', { method: `${session.id}:killSession` })
    cli!.send('session-alive', { sid: session.id, time: Date.now(), thinking: false })
    cli!.send('session-ready', { sid: session.id, time: Date.now() })
    cli!.send('message', { sid: session.id, message: { role: 'agent', content: { type: 'text', text } } })
    cli!.send('session-runtime', {
     sid: session.id, publication: {
      kind: 'snapshot', snapshot: {
       version: 1, epoch: text, seq: 0, items: [], run: null, updatedAt: 1
      }
     }
    })
    await cli!.barrier()
   }
   await publish('first publication')
   const allowed = scenario === 'owner' || scenario === 'operator' || scenario === 'legacy-active'
   const cleanupOnly = scenario === 'quarantined' || scenario === 'quarantined-no-attempt'
   expect(Boolean(sockets.rpcRegistry.getSocketIdForMethod(`${session.id}:killSession`))).toBe(allowed || cleanupOnly)
   expect(ready).toEqual(allowed ? [session.id] : [])
   expect(alive).toEqual(allowed ? [session.id] : [])
   expect(store.messages.getAllMessages(session.id)).toHaveLength(allowed ? 1 : 0)
   expect(runtime.snapshot(session.id, 'shared')?.snapshot?.epoch).toBe(allowed ? 'first publication' : undefined)
   expect(gateway.getResource('session', session.id)).toBeNull()
   if (cleanupOnly) {
    const cleanupOwner = sockets.rpcRegistry.getSocketIdForMethod(`${session.id}:killSession`)
    const before = store.sessions.getSession(session.id)!
    cli.send('rpc-register', { method: `${session.id}:abort` })
    expect(await cli.request('update-metadata', {
     sid: session.id, expectedVersion: before.metadataVersion, metadata: { name: 'must remain fenced' }
    })).toEqual({ result: 'error', reason: 'access-denied' })
    expect(store.sessions.getSession(session.id)?.metadataVersion).toBe(before.metadataVersion)
    expect(store.sessions.ompSources.get(session.id)?.sourceId).toBeNull()
    expect(sockets.rpcRegistry.getSocketIdForMethod(`${session.id}:abort`)).toBeNull()
    const duplicate = new ConnectedCli(url, { token: generated.plaintext, sessionId: session.id, ompSourceId: 'competing-cleanup' })
    try {
     await duplicate.wait('40/cli,')
     duplicate.send('rpc-register', { method: `${session.id}:killSession` })
     await duplicate.barrier()
     expect(sockets.rpcRegistry.getSocketIdForMethod(`${session.id}:killSession`)).toBe(cleanupOwner)
    } finally { duplicate.socket.close() }
   }
   if (allowed) {
    if (scenario === 'legacy-active') {
     const legacy = new ConnectedCli(url, { token: generated.plaintext, sessionId: session.id })
     const upgraded = new ConnectedCli(url, { token: generated.plaintext, sessionId: session.id, ompSourceId: 'upgraded-process' })
     try {
      await legacy.wait('40/cli,')
      legacy.send('rpc-register', { method: `${session.id}:abort` })
      legacy.send('rpc-register', { method: `${session.id}:killSession` })
      await legacy.barrier()
      const legacyOwner = sockets.rpcRegistry.getSocketIdForMethod(`${session.id}:killSession`)
      expect(legacyOwner).not.toBeNull()
      expect(sockets.rpcRegistry.getSocketIdForMethod(`${session.id}:abort`)).toBe(legacyOwner)
      const before = store.sessions.getSession(session.id)!
      expect(await legacy.request('update-metadata', {
       sid: session.id, expectedVersion: before.metadataVersion,
       metadata: { name: 'legacy reconnect preserved' }
      })).toMatchObject({ result: 'success' })
      await upgraded.wait('40/cli,')
      upgraded.send('rpc-register', { method: `${session.id}:killSession` })
      await upgraded.barrier()
      expect(sockets.rpcRegistry.getSocketIdForMethod(`${session.id}:killSession`)).not.toBe(legacyOwner)
      expect(store.sessions.ompSources.get(session.id)?.sourceId).toBe('upgraded-process')
      const after = store.sessions.getSession(session.id)!
      expect(await legacy.request('update-metadata', {
       sid: session.id, expectedVersion: after.metadataVersion,
       metadata: { archivedAt: 999 }
      })).toEqual({ result: 'error', reason: 'access-denied' })
      legacy.send('rpc-register', { method: `${session.id}:killSession` })
      await legacy.barrier()
      expect(sockets.rpcRegistry.getSocketIdForMethod(`${session.id}:killSession`)).not.toBe(legacyOwner)
      expect(store.sessions.getSession(session.id)?.metadata).not.toHaveProperty('archivedAt')
     } finally { legacy.socket.close(); upgraded.socket.close() }
    }
    if (scenario === 'owner') {
     const originalOwner = sockets.rpcRegistry.getSocketIdForMethod(`${session.id}:killSession`)
     const before = store.sessions.getSession(session.id)!
     const duplicate = new ConnectedCli(url, {
      token: generated.plaintext, sessionId: session.id, ompSourceId: 'different-process-same-attempt', ompResumeAttemptId: 'current'
     })
     try {
      await duplicate.wait('40/cli,')
      duplicate.send('rpc-register', { method: `${session.id}:killSession` })
      duplicate.send('rpc-register', { method: `${session.id}:abort` })
      expect(await duplicate.request('update-metadata', { sid: session.id, expectedVersion: before.metadataVersion, metadata: { archivedAt: 999, flavor: null } }))
       .toEqual({ result: 'error', reason: 'access-denied' })
      expect(await duplicate.request('update-state', { sid: session.id, expectedVersion: before.agentStateVersion, agentState: { controlledByUser: true } }))
       .toEqual({ result: 'error', reason: 'access-denied' })
      duplicate.send('message', { sid: session.id, message: { role: 'agent', content: 'superseded publisher' } })
      duplicate.send('session-ready', { sid: session.id, time: Date.now() })
      duplicate.send('session-runtime', {
       sid: session.id, publication: {
        kind: 'snapshot', snapshot: {
         version: 1, epoch: 'duplicate', seq: 0, items: [], run: null, updatedAt: 1
        }
       }
      })
      await duplicate.barrier()
      expect(sockets.rpcRegistry.getSocketIdForMethod(`${session.id}:killSession`)).toBe(originalOwner)
      expect(sockets.rpcRegistry.getSocketIdForMethod(`${session.id}:abort`)).toBeNull()
      expect(store.sessions.getSession(session.id)?.metadataVersion).toBe(before.metadataVersion)
      expect(store.sessions.getSession(session.id)?.agentStateVersion).toBe(before.agentStateVersion)
      expect(store.messages.getAllMessages(session.id)).toHaveLength(1)
      expect(ready).toEqual([session.id])
      expect(runtime.snapshot(session.id, 'shared')?.snapshot?.epoch).toBe('first publication')
     } finally { duplicate.socket.close() }
    }
    if (scenario === 'owner') gateway.revokeToken(token.id, account.id)
    else gateway.removeGrant('machine', 'machine', account.id)
    await publish('must be denied after revocation')
    expect(ready).toEqual([session.id])
    expect(alive).toEqual([session.id])
    expect(store.messages.getAllMessages(session.id)).toHaveLength(1)
    expect(runtime.snapshot(session.id, 'shared')?.snapshot?.epoch).toBe('first publication')
   }
  } finally {
   cli?.socket.close()
   engine.stop()
   sockets.io.close()
   sockets.engine.close()
   await server.stop(true)
   store.close()
   gateway.close()
  }
 }, 10_000)

 it('cuts off a quarantined generation before its socket disconnects and durably retires its nonce', async () => {
  const store = new Store(':memory:')
  const gateway = new MultiUserGatewayStore(':memory:')
  const owner = gateway.createAccount('owner', 'user', 'shared')
  gateway.bindResource({ resourceType: 'machine', resourceId: 'machine', ownerAccountId: owner.id, coreNamespace: 'shared' })
  const generated = createApiToken()
  gateway.createToken(owner.id, 'connected-cli', generated.hash, 'shared')
  const ready: string[] = []
  const runtime = new RuntimeTimelineRegistry()
  const sockets = createSocketServer({
   store, jwtSecret: new Uint8Array(32).fill(7), corsOrigins: ['*'], gatewayStore: gateway, runtimeRegistry: runtime,
   resolveCliIdentity: value => resolveGatewayCliIdentity(gateway, value),
   resolveCliNamespace: value => resolveGatewayCliNamespace(gateway, value),
   resolveSessionMachineId: createSessionMachineResolver(() => sync),
   resolveSessionPath: createSessionPathResolver(() => sync),
   onSessionReady: payload => { ready.push(payload.sid); sync?.handleSessionReady(payload) },
   onWebappEvent: event => sync?.handleRealtimeEvent(event)
  })
  let sync: SyncEngine | null = null
  sync = new SyncEngine(store, sockets.io, sockets.rpcRegistry, new SSEManager(30_000, new VisibilityTracker()))
  const engine = sync
  engine.getOrCreateMachine('machine', { host: 'fixture', platform: 'linux', happyCliVersion: 'fixture' }, null, 'shared')
  const app = new Hono()
  app.route('/cli', createCliRoutes(() => engine, value => resolveGatewayCliNamespace(gateway, value), { gatewayStore: gateway }))
  const transport = sockets.engine.handler()
  const server = Bun.serve({
   hostname: '127.0.0.1', port: 0, websocket: transport.websocket,
   fetch(request, server) {
    return new URL(request.url).pathname.startsWith('/socket.io/') ? transport.fetch(request, server) : app.fetch(request)
   }
  })
  const url = `http://127.0.0.1:${server.port}`
  const answerRpc = async (cli: ConnectedCli, result: unknown): Promise<void> => {
   for (; ;) {
    const frame = await cli.wait('42/cli,')
    const framed = /^42\/cli,(\d*)(.*)$/.exec(frame)
    if (!framed) continue
    const payload = JSON.parse(framed[2]) as [string, string]
    if (payload[0] !== 'rpc-request') continue
    cli.socket.send(`43/cli,${framed[1]}${JSON.stringify([JSON.stringify(result)])}`)
    return
   }
  }
  const sessionSockets: ConnectedCli[] = []
  try {
   const response = await fetch(`${url}/cli/sessions`, {
    method: 'POST', headers: {
     authorization: `Bearer ${generated.plaintext}`, 'content-type': 'application/json'
    }, body: JSON.stringify({
     tag: 'quarantined-cutover', metadata: {
      path: '/allowed/project', host: 'fixture', machineId: 'machine', flavor: 'omp',
      ompRuntimeAttemptId: 'a1', ompSession: { id: 'native-1', file: '/tmp/native-1.jsonl' },
      ompResumeAttempt: { attemptId: 'a1', state: 'quarantined', machineId: 'machine', startedAt: 1 }
     }
    })
   })
   expect(response.status).toBe(200)
   const { session } = await response.json() as { session: { id: string } }
   const sid = session.id

   const connect = async (ompSourceId: string, ompResumeAttemptId?: string): Promise<ConnectedCli> => {
    const cli = new ConnectedCli(url, {
     token: generated.plaintext, sessionId: sid, ompSourceId,
     ...(ompResumeAttemptId === undefined ? {} : { ompResumeAttemptId })
    })
    await cli.wait('40/cli,')
    sessionSockets.push(cli)
    return cli
   }
   const tryCleanup = async (cli: ConnectedCli): Promise<void> => {
    cli.send('rpc-register', { method: `${sid}:killSession` })
    await cli.barrier()
   }

   // Gate: the durable owner bound to an older attempt may not self-dispose.
   store.sessions.ompSources.claim(sid, 'source-old', 'a0')
   await tryCleanup(await connect('source-old', 'a1'))
   expect(sockets.rpcRegistry.getSocketIdForMethod(`${sid}:killSession`)).toBeNull()

   // Gate: the failed-starter socket (missing attempt) may register cleanup.
   const starter = await connect('source-stray')
   await tryCleanup(starter)
   starter.send('rpc-unregister', { method: `${sid}:killSession` })
   await starter.barrier()
   expect(sockets.rpcRegistry.getSocketIdForMethod(`${sid}:killSession`)).toBeNull()
   starter.socket.close()

   // Gate: while the quarantined attempt has a durable owner, other nonces
   // and missing-attempt sockets may not take its disposal route.
   store.sessions.ompSources.claim(sid, 'source-main', 'a1')
   await tryCleanup(await connect('source-foreign', 'a1'))
   expect(sockets.rpcRegistry.getSocketIdForMethod(`${sid}:killSession`)).toBeNull()
   await tryCleanup(await connect('source-anon'))
   expect(sockets.rpcRegistry.getSocketIdForMethod(`${sid}:killSession`)).toBeNull()
   const stale = await connect('source-stale', 'a0')
   await tryCleanup(stale)
   expect(sockets.rpcRegistry.getSocketIdForMethod(`${sid}:killSession`)).toBeNull()

   // Gate: the durable owner of the quarantined attempt self-disposes.
   const wrapper = await connect('source-main', 'a1')
   await tryCleanup(wrapper)
   const cleanupSocket = sockets.rpcRegistry.getSocketIdForMethod(`${sid}:killSession`)
   expect(cleanupSocket).not.toBeNull()
   // Cleanup registration is never publication ownership.
   expect(sockets.rpcRegistry.isClaimedSessionSource(sid, cleanupSocket!)).toBe(false)
   const before = store.sessions.getSession(sid)!
   expect(await wrapper.request('update-metadata', {
    sid, expectedVersion: before.metadataVersion, metadata: { name: 'quarantine still fences publication' }
   })).toEqual({ result: 'error', reason: 'access-denied' })

   const machine = new ConnectedCli(url, { token: generated.plaintext, machineId: 'machine', clientType: 'machine-scoped' })
   try {
    await machine.wait('40/cli,')
    machine.send('rpc-register', { method: 'machine:stop-session' })
    await machine.barrier()

    // Verified cleanup retires and strips the dead generation BEFORE the
    // quarantine marker clears: no window for stale frames.
    const archive = engine.archiveSession(sid)
    await answerRpc(wrapper, { success: true })
    await answerRpc(machine, { status: 'stopped' })
    expect(await archive).toEqual({ type: 'success', alreadyArchived: false })
    const archived = store.sessions.getSession(sid)!
    const archivedMetadata = engine.getSession(sid)?.metadata
    expect(archivedMetadata).not.toHaveProperty('ompResumeAttempt')
    expect(archivedMetadata?.ompSession).toEqual({ id: 'native-1', file: '/tmp/native-1.jsonl' })
    expect(archivedMetadata?.lifecycleState).toBe('archived')
    expect(store.sessions.ompSources.isRetired(sid, 'source-main')).toBe(true)
    expect(store.sessions.ompSources.isRetired(sid, 'source-stray')).toBe(true)
    expect(sockets.rpcRegistry.getSocketIdForMethod(`${sid}:killSession`)).toBeNull()
    expect(sockets.rpcRegistry.isClaimedSessionSource(sid, cleanupSocket!)).toBe(false)

    // Stale publications and RPC registrations from the still-connected
    // dead generation are denied — no metadata can overwrite the archive.
    wrapper.send('rpc-register', { method: `${sid}:killSession` })
    wrapper.send('rpc-register', { method: `${sid}:abort` })
    wrapper.send('message', { sid, message: { role: 'agent', content: { type: 'text', text: 'late frame' } } })
    wrapper.send('session-ready', { sid, time: Date.now() })
    await wrapper.barrier()
    expect(await wrapper.request('update-metadata', {
     sid, expectedVersion: archived.metadataVersion, metadata: { name: 'late overwrite' }
    })).toEqual({ result: 'error', reason: 'access-denied' })
    expect(await wrapper.request('update-state', {
     sid, expectedVersion: archived.agentStateVersion, agentState: { controlledByUser: false }
    })).toEqual({ result: 'error', reason: 'access-denied' })
    expect(sockets.rpcRegistry.getSocketIdForMethod(`${sid}:killSession`)).toBeNull()
    expect(sockets.rpcRegistry.getSocketIdForMethod(`${sid}:abort`)).toBeNull()
    expect(store.messages.getAllMessages(sid)).toHaveLength(0)
    expect(ready).toEqual([])
    expect(store.sessions.getSession(sid)!.metadata).toEqual(archived.metadata)

    // The replacement generation bootstraps before claiming: metadata and
    // state initialize, then the claim registers and publication unlocks.
    const nextAttempt = { attemptId: 'a2', state: 'resuming', machineId: 'machine', startedAt: Date.now() }
    const current = engine.getSession(sid)!
    // updateSessionMetadata is full-replace plus carry-forward fields; the
    // archive marker is dropped by omission, never by a null value.
    const resumedMetadata = { ...current.metadata }
    delete resumedMetadata.archivedAt
    resumedMetadata.lifecycleState = 'running'
    expect(store.sessions.updateSessionMetadata(sid, { ...resumedMetadata, ompResumeAttempt: nextAttempt },
     current.metadataVersion, 'shared').result).toBe('success')
    const replacement = await connect('source-next', 'a2')
    const resuming = store.sessions.getSession(sid)!
    expect(await replacement.request('update-metadata', {
     sid, expectedVersion: resuming.metadataVersion,
     metadata: { name: 'reopened', lifecycleState: 'running', ompResumeAttempt: null }
    })).toMatchObject({ result: 'success' })
    replacement.send('rpc-register', { method: `${sid}:killSession` })
    replacement.send('rpc-register', { method: `${sid}:abort` })
    replacement.send('session-ready', { sid, time: Date.now() })
    replacement.send('message', { sid, message: { role: 'agent', content: { type: 'text', text: 'new generation' } } })
    replacement.send('session-runtime', {
     sid, publication: {
      kind: 'snapshot', snapshot: { version: 1, epoch: 'a2', seq: 0, items: [], run: null, updatedAt: 1 }
     }
    })
    await replacement.barrier()
    const replacementSocket = sockets.rpcRegistry.getSocketIdForMethod(`${sid}:killSession`)
    expect(replacementSocket).not.toBeNull()
    expect(sockets.rpcRegistry.isClaimedSessionSource(sid, replacementSocket!)).toBe(true)
    expect(store.sessions.ompSources.get(sid)).toEqual({ sourceId: 'source-next', attemptId: 'a2' })
    expect(store.messages.getAllMessages(sid)).toHaveLength(1)
    expect(ready).toEqual([sid])
    expect(runtime.snapshot(sid, 'shared')?.snapshot?.epoch).toBe('a2')
   } finally { machine.socket.close() }
  } finally {
   for (const cli of sessionSockets) cli.socket.close()
   engine.stop()
   sockets.io.close()
   sockets.engine.close()
   await server.stop(true)
   store.close()
   gateway.close()
  }
 }, 15_000)

 it.each(['quarantined', 'claimed'] as const)('refuses unverified cleanup and fences the verified disposed source (%s)', async sourceMode => {
  const store = new Store(':memory:')
  const gateway = new MultiUserGatewayStore(':memory:')
  const owner = gateway.createAccount('owner', 'user', 'shared')
  gateway.bindResource({ resourceType: 'machine', resourceId: 'machine', ownerAccountId: owner.id, coreNamespace: 'shared' })
  const generated = createApiToken()
  gateway.createToken(owner.id, 'connected-cli', generated.hash, 'shared')
  const runtime = new RuntimeTimelineRegistry()
  const ready: string[] = []
  const sockets = createSocketServer({
   store, jwtSecret: new Uint8Array(32).fill(7), corsOrigins: ['*'], gatewayStore: gateway, runtimeRegistry: runtime,
   resolveCliIdentity: value => resolveGatewayCliIdentity(gateway, value),
   resolveCliNamespace: value => resolveGatewayCliNamespace(gateway, value),
   resolveSessionMachineId: createSessionMachineResolver(() => engine),
   resolveSessionPath: createSessionPathResolver(() => engine),
   onSessionReady: payload => { ready.push(payload.sid) }
  })
  const engine = new SyncEngine(store, sockets.io, sockets.rpcRegistry, new SSEManager(30_000, new VisibilityTracker()))
  engine.getOrCreateMachine('machine', { host: 'fixture', platform: 'linux', happyCliVersion: 'fixture' }, null, 'shared')
  const app = new Hono()
  app.route('/cli', createCliRoutes(() => engine, value => resolveGatewayCliNamespace(gateway, value), { gatewayStore: gateway }))
  const transport = sockets.engine.handler()
  const server = Bun.serve({
   hostname: '127.0.0.1', port: 0, websocket: transport.websocket,
   fetch(request, server) {
    return new URL(request.url).pathname.startsWith('/socket.io/') ? transport.fetch(request, server) : app.fetch(request)
   }
  })
  const url = `http://127.0.0.1:${server.port}`
  const answerRpc = async (cli: ConnectedCli, result: unknown): Promise<void> => {
   for (; ;) {
    const frame = await cli.wait('42/cli,')
    const framed = /^42\/cli,(\d*)(.*)$/.exec(frame)
    if (!framed) continue
    const payload = JSON.parse(framed[2]) as [string, string]
    if (payload[0] !== 'rpc-request') continue
    cli.socket.send(`43/cli,${framed[1]}${JSON.stringify([JSON.stringify(result)])}`)
    return
   }
  }
  let wrapper: ConnectedCli | undefined
  let machine: ConnectedCli | undefined
  try {
   const response = await fetch(`${url}/cli/sessions`, {
    method: 'POST', headers: {
     authorization: `Bearer ${generated.plaintext}`, 'content-type': 'application/json'
    }, body: JSON.stringify({
     tag: 'quarantined-unverified', metadata: {
      path: '/allowed/project', host: 'fixture', machineId: 'machine', flavor: 'omp',
      ompRuntimeAttemptId: 'a1', ompSession: { id: 'native-1', file: '/tmp/native-1.jsonl' },
      ...(sourceMode === 'quarantined' ? {
       ompResumeAttempt: { attemptId: 'a1', state: 'quarantined', machineId: 'machine', startedAt: 1 }
      } : {})
     }
    })
   })
   expect(response.status).toBe(200)
   const { session } = await response.json() as { session: { id: string } }
   const sid = session.id

   wrapper = new ConnectedCli(url, { token: generated.plaintext, sessionId: sid, ompSourceId: 'source-main', ompResumeAttemptId: 'a1' })
   await wrapper.wait('40/cli,')
   wrapper.send('rpc-register', { method: `${sid}:killSession` })
   await wrapper.barrier()
   expect(sockets.rpcRegistry.getSocketIdForMethod(`${sid}:killSession`)).not.toBeNull()

   machine = new ConnectedCli(url, { token: generated.plaintext, machineId: 'machine', clientType: 'machine-scoped' })
   await machine.wait('40/cli,')
   machine.send('rpc-register', { method: 'machine:stop-session' })
   await machine.barrier()

   // A non-missing killSession failure may only be overridden by 'stopped'.
   // 'already_gone' is mere absence: the archive must fail closed, the
   // quarantined attempt must stay, and no nonce may be retired.
   const failed = engine.archiveSession(sid)
   await answerRpc(wrapper, { success: false, message: 'Native dispose unverified' })
   await answerRpc(machine, { status: 'already_gone' })
   const result = await failed
   expect(result).toMatchObject({ type: 'error', message: expect.stringContaining('Native dispose unverified') })
   const kept = store.sessions.getSession(sid)!
   const keptMetadata = engine.getSession(sid)?.metadata
   if (sourceMode === 'quarantined') {
    expect(keptMetadata?.ompResumeAttempt).toMatchObject({ attemptId: 'a1', state: 'quarantined' })
   } else {
    expect(keptMetadata?.ompResumeAttempt).toBeUndefined()
   }
   expect(keptMetadata?.ompSession).toEqual({ id: 'native-1', file: '/tmp/native-1.jsonl' })
   expect(keptMetadata?.lifecycleState).not.toBe('archived')
   expect(kept.metadata).not.toHaveProperty('archivedAt')
   expect(store.sessions.ompSources.isRetired(sid, 'source-main')).toBe(false)
   // The dead-route record lingers so the nonce can still be fenced only by
   // a future VERIFIED cleanup; the socket itself may retry its disposal.
   wrapper.send('rpc-register', { method: `${sid}:killSession` })
   await wrapper.barrier()
   expect(sockets.rpcRegistry.getSocketIdForMethod(`${sid}:killSession`)).not.toBeNull()

   // A positive stopped proof converges the same session on retry.
   const verified = engine.archiveSession(sid)
   await answerRpc(wrapper, { success: true })
   await answerRpc(machine, { status: 'stopped' })
   expect(await verified).toEqual({ type: 'success', alreadyArchived: false })
   expect(store.sessions.getSession(sid)!.metadata).not.toHaveProperty('ompResumeAttempt')
   expect(store.sessions.ompSources.isRetired(sid, 'source-main')).toBe(true)
   const archived = store.sessions.getSession(sid)!
   expect(await wrapper.request('update-metadata', {
    sid, expectedVersion: archived.metadataVersion, metadata: { lifecycleState: 'running', name: 'stale owner' }
   })).toEqual({ result: 'error', reason: 'access-denied' })
   expect(await wrapper.request('update-state', {
    sid, expectedVersion: archived.agentStateVersion, agentState: { controlledByUser: false }
   })).toEqual({ result: 'error', reason: 'access-denied' })
   wrapper.send('session-ready', { sid, time: Date.now() })
   wrapper.send('message', { sid, message: { role: 'agent', content: 'stale data' } })
   wrapper.send('rpc-register', { method: `${sid}:killSession` })
   await wrapper.barrier()
   expect(ready).toEqual([])
   expect(store.messages.getAllMessages(sid)).toHaveLength(0)
   expect(store.sessions.getSession(sid)!.metadata).toEqual(archived.metadata)
   expect(sockets.rpcRegistry.getSocketIdForMethod(`${sid}:killSession`)).toBeNull()
  } finally {
   wrapper?.socket.close()
   machine?.socket.close()
   engine.stop()
   sockets.io.close()
   sockets.engine.close()
   await server.stop(true)
   store.close()
   gateway.close()
  }
 }, 15_000)

 it('makes a newly registered machine usable before browser discovery without allowing same-namespace takeover', async () => {
  const store = new Store(':memory:')
  const gateway = new MultiUserGatewayStore(':memory:')
  const owner = gateway.createAccount('creator', 'user', 'shared')
  const stranger = gateway.createAccount('stranger', 'user', 'shared')
  const ownerKey = createApiToken()
  const strangerKey = createApiToken()
  gateway.createToken(owner.id, 'runner', ownerKey.hash, 'shared')
  gateway.createToken(stranger.id, 'stranger', strangerKey.hash, 'shared')
  const sockets = createSocketServer({
   store, jwtSecret: new Uint8Array(32).fill(9), corsOrigins: ['*'], gatewayStore: gateway,
   resolveCliIdentity: value => resolveGatewayCliIdentity(gateway, value),
   resolveCliNamespace: value => resolveGatewayCliNamespace(gateway, value)
  })
  const engine = new SyncEngine(store, sockets.io, sockets.rpcRegistry, new SSEManager(30_000, new VisibilityTracker()))
  const app = new Hono()
  app.route('/cli', createCliRoutes(() => engine, undefined, { gatewayStore: gateway }))
  const transport = sockets.engine.handler()
  const server = Bun.serve({
   hostname: '127.0.0.1', port: 0, websocket: transport.websocket,
   fetch(request, server) {
    return new URL(request.url).pathname.startsWith('/socket.io/') ? transport.fetch(request, server) : app.fetch(request)
   }
  })
  const url = `http://127.0.0.1:${server.port}`
  let cli: ConnectedCli | undefined
  try {
   const register = (key: string, host: string) => fetch(`${url}/cli/machines`, {
    method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'fresh-machine', metadata: { host, platform: 'linux', happyCliVersion: 'fixture' } })
   })
   expect((await register(ownerKey.plaintext, 'owned-host')).status).toBe(200)
   expect((await register(strangerKey.plaintext, 'stolen-host')).status).toBe(403)
   expect(engine.getMachine('fresh-machine')?.metadata?.host).toBe('owned-host')
   cli = new ConnectedCli(url, { token: ownerKey.plaintext, machineId: 'fresh-machine', clientType: 'machine-scoped' })
   await cli.wait('40/cli,')
   cli.send('rpc-register', { method: 'fresh-machine:list-directory' })
   await cli.barrier()
   expect(sockets.rpcRegistry.getSocketIdForMethod('fresh-machine:list-directory')).not.toBeNull()
   const response = engine.listMachineDirectory('fresh-machine', '/allowed')
   const request = await cli.wait('42/cli,')
   const framed = /^42\/cli,(\d+)(.*)$/.exec(request)
   if (!framed) throw new Error('Machine RPC request did not carry an acknowledgement id')
   const [event, payload] = JSON.parse(framed[2])
   expect(event).toBe('rpc-request')
   expect(JSON.parse(payload.params).path).toBe('/allowed')
   cli.socket.send(`43/cli,${framed[1]}${JSON.stringify([JSON.stringify({ success: true, entries: [] })])}`)
   expect((await response).success).toBe(true)
  } finally {
   cli?.socket.close()
   engine.stop()
   sockets.io.close()
   sockets.engine.close()
   await server.stop(true)
   store.close()
   gateway.close()
  }
 }, 10_000)
})
