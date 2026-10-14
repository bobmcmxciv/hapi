import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import type { ServerWebSocket } from 'bun'
import { createQwenProxyWebSocketHandler, type WebSocketLike } from './qwenProxyHandler'

const WS_OPEN = 1

class FakeUpstream implements WebSocketLike {
    readyState = WS_OPEN
    sent: Array<string | ArrayBuffer | Uint8Array> = []
    closed = false
    onmessage: ((event: { data: string | ArrayBuffer | Uint8Array }) => void) | null = null
    onerror: ((event: unknown) => void) | null = null
    onclose: ((event: { code: number; reason: string }) => void) | null = null

    constructor(public url: string, public opts?: unknown) {}

    send(data: string | ArrayBuffer | Uint8Array) {
        this.sent.push(data)
    }

    close(code = 1000, reason = '') {
        this.closed = true
        this.readyState = 3
        this.onclose?.({ code, reason })
    }

    deliver(payload: object | string) {
        const text = typeof payload === 'string' ? payload : JSON.stringify(payload)
        this.onmessage?.({ data: text })
    }
}

class FakeClient {
    readyState = WS_OPEN
    sent: string[] = []
    closeCode: number | null = null
    closeReason: string | null = null
    data: object

    constructor(data: object) {
        this.data = data
    }

    send(payload: string | ArrayBuffer | Uint8Array) {
        this.sent.push(typeof payload === 'string' ? payload : new TextDecoder().decode(payload as Uint8Array))
    }

    close(code?: number, reason?: string) {
        this.closeCode = code ?? null
        this.closeReason = reason ?? null
        this.readyState = 3
    }
}

let lastUpstream: FakeUpstream | null = null
const origQwenRealtimeWsUrl = process.env.QWEN_REALTIME_WS_URL
const FakeWebSocket = function FakeWebSocket(url: string, opts?: unknown) {
    const u = new FakeUpstream(url, opts)
    lastUpstream = u
    return u
} as unknown as new (url: string, opts?: unknown) => WebSocketLike

beforeEach(() => {
    lastUpstream = null
})

afterEach(() => {
    lastUpstream = null
    if (origQwenRealtimeWsUrl === undefined) delete process.env.QWEN_REALTIME_WS_URL
    else process.env.QWEN_REALTIME_WS_URL = origQwenRealtimeWsUrl
})

function newClient() {
    return new FakeClient({ apiKey: 'k', model: 'qwen3.5-omni-flash-realtime', language: 'en', voiceName: 'Cherry' }) as unknown as ServerWebSocket<unknown> & FakeClient
}

describe('createQwenProxyWebSocketHandler ack-gate', () => {
    test('preserves the international DashScope realtime endpoint by default', () => {
        delete process.env.QWEN_REALTIME_WS_URL
        const handler = createQwenProxyWebSocketHandler(FakeWebSocket)
        const client = newClient()

        handler.open(client)

        expect(lastUpstream?.url).toBe('wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime?model=qwen3.5-omni-flash-realtime')
    })

    test('allows overriding the DashScope realtime endpoint with QWEN_REALTIME_WS_URL', () => {
        process.env.QWEN_REALTIME_WS_URL = 'wss://example.test/realtime'
        const handler = createQwenProxyWebSocketHandler(FakeWebSocket)
        const client = newClient()

        handler.open(client)

        expect(lastUpstream?.url).toBe('wss://example.test/realtime?model=qwen3.5-omni-flash-realtime')
    })

    test('preserves existing query parameters in QWEN_REALTIME_WS_URL', () => {
        process.env.QWEN_REALTIME_WS_URL = 'wss://example.test/realtime?workspace=abc&model=old'
        const handler = createQwenProxyWebSocketHandler(FakeWebSocket)
        const client = newClient()

        handler.open(client)

        expect(lastUpstream?.url).toBe(
            'wss://example.test/realtime?workspace=abc&model=qwen3.5-omni-flash-realtime'
        )
    })

    test('queues client frames until upstream acks hub-owned session.update with session.updated', () => {
        const handler = createQwenProxyWebSocketHandler(FakeWebSocket)
        const client = newClient()

        handler.open(client)
        const upstream = lastUpstream!
        expect(upstream.sent).toHaveLength(0)

        upstream.deliver({ type: 'session.created' })
        expect(upstream.sent).toHaveLength(1)
        const hubSetup = JSON.parse(upstream.sent[0] as string) as { type: string; session: { instructions: string } }
        expect(hubSetup.type).toBe('session.update')
        expect(typeof hubSetup.session.instructions).toBe('string')
        expect(hubSetup).not.toHaveProperty('session.tool_choice')

        handler.message(client, JSON.stringify({ type: 'response.create' }))
        handler.message(client, JSON.stringify({ type: 'conversation.item.create', item: { type: 'message' } }))
        handler.message(client, JSON.stringify({ type: 'session.update', session: { instructions: 'updated' } }))

        expect(upstream.sent).toHaveLength(1)

        upstream.deliver({ type: 'session.updated', session: { instructions: hubSetup.session.instructions } })

        expect(upstream.sent.length).toBeGreaterThanOrEqual(4)
        const flushedTypes = upstream.sent.slice(1).map(raw => {
            try { return (JSON.parse(raw as string) as { type?: string }).type }
            catch { return undefined }
        })
        expect(flushedTypes).toEqual(['response.create', 'conversation.item.create', 'session.update'])
    })

    test('forwards client frames immediately after the gate has flipped', () => {
        const handler = createQwenProxyWebSocketHandler(FakeWebSocket)
        const client = newClient()

        handler.open(client)
        const upstream = lastUpstream!

        upstream.deliver({ type: 'session.created' })
        upstream.deliver({ type: 'session.updated', session: {} })
        const sentBefore = upstream.sent.length

        handler.message(client, JSON.stringify({ type: 'input_audio_buffer.append', audio: 'abc' }))
        expect(upstream.sent).toHaveLength(sentBefore + 1)
    })

    test('rejects client frames that fail the safe-frame allowlist with 1008', () => {
        const handler = createQwenProxyWebSocketHandler(FakeWebSocket)
        const client = newClient()

        handler.open(client)
        const upstream = lastUpstream!
        upstream.deliver({ type: 'session.created' })
        upstream.deliver({ type: 'session.updated', session: {} })

        handler.message(client, JSON.stringify({
            type: 'session.update',
            session: { tools: [{ type: 'function', name: 'evil' }] }
        }))

        expect(client.closeCode).toBe(1008)
        expect(client.closeReason).toContain('instructions')
    })

    test('clears queued frames on close so no stale data leaks if a new client reuses memory', () => {
        const handler = createQwenProxyWebSocketHandler(FakeWebSocket)
        const client = newClient()

        handler.open(client)
        const upstream = lastUpstream!
        upstream.deliver({ type: 'session.created' })
        handler.message(client, JSON.stringify({ type: 'response.create' }))

        handler.close(client, 1000, 'bye')
        expect(upstream.closed).toBe(true)
    })
})

describe('createQwenProxyWebSocketHandler tool mode (fork voice-assistant)', () => {
    function setupToolsFor(toolMode?: string): string[] {
        const handler = createQwenProxyWebSocketHandler(FakeWebSocket)
        const client = new FakeClient({ apiKey: 'k', model: 'qwen3.5-omni-flash-realtime', language: 'zh', voiceName: 'Cherry', toolMode }) as unknown as ServerWebSocket<unknown> & FakeClient
        handler.open(client)
        lastUpstream!.deliver({ type: 'session.created' })
        const setup = JSON.parse(lastUpstream!.sent[0] as string) as { type: string; session: { tools: Array<{ name: string }> } }
        expect(setup.type).toBe('session.update')
        return setup.session.tools.map((tool) => tool.name)
    }

    test('a read-only connection gets only the lookup tool upstream', () => {
        expect(setupToolsFor('readonly')).toEqual(['askSessionStatus'])
    })

    test('an assistant connection gets draft/confirm instead of direct send', () => {
        const tools = setupToolsFor('assistant')
        expect(tools).toContain('prepareInstruction')
        expect(tools).toContain('confirmInstruction')
        expect(tools).not.toContain('messageCodingAgent')
    })

    test('a connection without a mode keeps the old tools', () => {
        expect(setupToolsFor(undefined)).toEqual(['messageCodingAgent', 'processPermissionRequest'])
    })
})

describe('createQwenProxyWebSocketHandler speaker gate (fork voice-assistant)', () => {
    type TurnDetection = { type: string; create_response?: boolean; interrupt_response?: boolean } | null
    function openWith(listen: string | undefined, gate: { frames: string[]; upstreamTypes: string[] } | null) {
        const opened: Array<{ accountId: number | null; isAdmin: boolean }> = []
        const handler = createQwenProxyWebSocketHandler(FakeWebSocket, (params) => {
            opened.push({ accountId: params.accountId, isAdmin: params.isAdmin })
            if (!gate) return null
            return {
                clientFrame: (raw: string) => { gate.frames.push(raw) },
                upstream: (raw: string) => {
                    const type = (JSON.parse(raw) as { type?: string }).type ?? ''
                    gate.upstreamTypes.push(type)
                    return type === 'input_audio_buffer.speech_started'
                },
                close: () => {}
            }
        })
        const client = new FakeClient({ apiKey: 'k', model: 'qwen3.5-omni-flash-realtime', language: 'zh', listen, accountId: 7, isAdmin: true }) as unknown as ServerWebSocket<unknown> & FakeClient
        handler.open(client)
        const upstream = lastUpstream!
        upstream.deliver({ type: 'session.created' })
        const setup = JSON.parse(upstream.sent[0] as string) as { session: { turn_detection: TurnDetection } }
        return { handler, client, upstream, opened, turnDetection: setup.session.turn_detection }
    }

    test('verified listening without a voiceprint answers like the ordinary hands-free mode', () => {
        const { opened, turnDetection } = openWith('verified', null)
        expect(opened).toEqual([{ accountId: 7, isAdmin: true }])
        expect(turnDetection?.type).toBe('semantic_vad')
        expect(turnDetection?.create_response).toBeUndefined()
    })

    test('verified listening hands turn-taking to the gate', () => {
        const gate = { frames: [] as string[], upstreamTypes: [] as string[] }
        const { handler, client, upstream, turnDetection } = openWith('verified', gate)
        expect(turnDetection).toMatchObject({ type: 'semantic_vad', create_response: false, interrupt_response: false })

        const early = JSON.stringify({ type: 'input_audio_buffer.append', audio: 'AAAA' })
        handler.message(client, early)
        upstream.deliver({ type: 'session.updated', session: {} })
        const later = JSON.stringify({ type: 'input_audio_buffer.append', audio: 'BBBB' })
        handler.message(client, later)
        expect(gate.frames).toEqual([early, later])

        const sentBefore = client.sent.length
        upstream.deliver({ type: 'input_audio_buffer.speech_started', item_id: 'u1', audio_start_ms: 0 })
        expect(client.sent).toHaveLength(sentBefore)
        upstream.deliver({ type: 'response.text.delta', delta: '好' })
        expect(client.sent).toHaveLength(sentBefore + 1)
        expect(gate.upstreamTypes).toContain('input_audio_buffer.speech_started')
    })

    test('other listening modes never open the gate', () => {
        const { opened } = openWith('auto', { frames: [], upstreamTypes: [] })
        expect(opened).toEqual([])
    })
})
