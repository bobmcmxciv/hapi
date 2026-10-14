// Qwen Realtime WebSocket proxy factory — extracted from server.ts so the ack-gate
// behaviour (queue client frames until DashScope acknowledges the hub-owned session.update)
// can be unit-tested without spinning up Hono + Bun.serve.
//
// The factory accepts an optional WebSocket constructor injection so tests can substitute
// a deterministic fake for the upstream connection.

import type { ServerWebSocket } from 'bun'
import { buildQwenSessionUpdateMessage, isQwenSafeClientFrame, type VoiceListenMode, type VoiceToolMode } from '@hapi/protocol/voice'
import { openSpeakerGate, type OpenSpeakerGate, type SpeakerGateLike } from '../../../fork-features/voice-assistant/speakerGate'

type WebSocketCtor = new (url: string, opts?: unknown) => WebSocketLike

export interface WebSocketLike {
    readyState: number
    send(data: string | ArrayBuffer | Uint8Array): void
    close(code?: number, reason?: string): void
    onmessage: ((event: { data: string | ArrayBuffer | Uint8Array }) => void) | null
    onerror: ((event: unknown) => void) | null
    onclose: ((event: { code: number; reason: string }) => void) | null
}

export interface QwenProxyHandler {
    open(clientWs: ServerWebSocket<unknown>): void
    message(clientWs: ServerWebSocket<unknown>, message: string | ArrayBuffer | Uint8Array): void
    close(clientWs: ServerWebSocket<unknown>, code: number, reason: string): void
}

const QWEN_WS_BASE = 'wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime'
const WS_OPEN = 1

function toClientCloseCode(code: number): number {
    return code >= 1000 && code <= 4999 && code !== 1005 && code !== 1006 && code !== 1015
        ? code
        : 1011
}

export function createQwenProxyWebSocketHandler(
    WebSocketImpl: WebSocketCtor = WebSocket as unknown as WebSocketCtor,
    openGate: OpenSpeakerGate = openSpeakerGate
): QwenProxyHandler {
    const MAX_PENDING_BYTES = 1024 * 1024 // 1 MiB — rejects setup-gate floods
    const upstreamMap = new WeakMap<ServerWebSocket<unknown>, WebSocketLike>()
    // Holds the hub-owned session.update payload until session.created arrives from DashScope.
    // Sending session.update before session.created violates the Qwen Realtime protocol ordering.
    const pendingSetupMap = new WeakMap<ServerWebSocket<unknown>, string>()
    // Tracks whether DashScope has acknowledged the hub-owned session.update with a session.updated
    // frame. Until the ack arrives, client frames are queued, never forwarded - otherwise an
    // authenticated client could push response.create / conversation.item.create / instruction-only
    // session.update before HAPI's tools/voice/instructions are locked into the upstream session.
    const setupAckedMap = new WeakMap<ServerWebSocket<unknown>, boolean>()
    const pendingClientFrames = new WeakMap<ServerWebSocket<unknown>, Array<string | ArrayBuffer | Uint8Array>>()
    const pendingClientBytes = new WeakMap<ServerWebSocket<unknown>, number>()
    // fork(voice-assistant)：turn=verified 时按声纹放行每一轮（见 fork-features/voice-assistant/speakerGate.ts）。
    const gateMap = new WeakMap<ServerWebSocket<unknown>, SpeakerGateLike>()
    const dropGate = (clientWs: ServerWebSocket<unknown>) => {
        gateMap.get(clientWs)?.close()
        gateMap.delete(clientWs)
    }

    return {
        open(clientWs) {
            const data = clientWs.data as { apiKey: string; model: string; language?: string; voiceName?: string; systemInstruction?: string; toolMode?: VoiceToolMode; output?: 'audio' | 'text'; listen?: VoiceListenMode; accountId?: number | null; isAdmin?: boolean }
            const upstreamBase = process.env.QWEN_REALTIME_WS_URL || QWEN_WS_BASE
            const upstreamUrl = new URL(upstreamBase)
            upstreamUrl.searchParams.set('model', data.model)

            const upstream = new WebSocketImpl(upstreamUrl.toString(), {
                headers: { 'Authorization': `Bearer ${data.apiKey}` }
            })

            upstreamMap.set(clientWs, upstream)
            let listen = data.listen
            if (listen === 'verified') {
                const gate = openGate({
                    accountId: data.accountId ?? null,
                    isAdmin: data.isAdmin === true,
                    sendUpstream: (event) => { try { if (upstream.readyState === WS_OPEN) upstream.send(JSON.stringify(event)) } catch { /* upstream gone */ } },
                    sendClient: (raw) => { try { if (clientWs.readyState === 1) clientWs.send(raw) } catch { /* client gone */ } }
                })
                // Nobody to verify against: answer like the ordinary hands-free mode instead of never answering.
                if (gate) gateMap.set(clientWs, gate)
                else listen = 'auto'
            }
            pendingSetupMap.set(clientWs, JSON.stringify(buildQwenSessionUpdateMessage(data.language, data.voiceName, data.systemInstruction, data.toolMode, data.output, listen)))
            setupAckedMap.set(clientWs, false)
            pendingClientBytes.set(clientWs, 0)

            upstream.onmessage = (event) => {
                const raw = event.data
                const text = typeof raw === 'string'
                    ? raw
                    : new TextDecoder().decode(raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayBuffer))

                const pendingSetup = pendingSetupMap.get(clientWs)
                if (pendingSetup) {
                    try {
                        const parsed = JSON.parse(text) as { type?: string }
                        if (parsed.type === 'session.created') {
                            pendingSetupMap.delete(clientWs)
                            try { if (clientWs.readyState === 1) clientWs.send(text) } catch { /* client gone */ }
                            upstream.send(pendingSetup)
                            return
                        }
                    } catch { /* not JSON */ }
                }

                // Once the upstream acks the hub-owned setup with session.updated, flip the gate
                // and flush any client frames the proxy held while tools/voice/instructions were
                // still being installed.
                if (setupAckedMap.get(clientWs) === false) {
                    try {
                        const parsed = JSON.parse(text) as { type?: string }
                        if (parsed.type === 'session.updated') {
                            setupAckedMap.set(clientWs, true)
                            const queued = pendingClientFrames.get(clientWs) ?? []
                            pendingClientFrames.delete(clientWs)
                            for (const frame of queued) {
                                try { upstream.send(frame) } catch { /* upstream gone */ }
                            }
                        }
                    } catch { /* not JSON */ }
                }

                if (gateMap.get(clientWs)?.upstream(text)) return

                try {
                    if (clientWs.readyState === 1) {
                        clientWs.send(typeof raw === 'string' ? raw : new Uint8Array(raw as ArrayBuffer))
                    }
                } catch { /* client gone */ }
            }
            upstream.onerror = (event) => {
                dropGate(clientWs)
                pendingSetupMap.delete(clientWs)
                setupAckedMap.delete(clientWs)
                pendingClientFrames.delete(clientWs)
                pendingClientBytes.delete(clientWs)
                upstreamMap.delete(clientWs)
                console.error('[Voice][QwenProxy] Upstream WebSocket error', {
                    upstreamBase,
                    model: data.model,
                    error: event instanceof Error ? event.message : String(event)
                })
                try { clientWs.close(1011, 'Upstream error') } catch { /* */ }
            }
            upstream.onclose = (event) => {
                dropGate(clientWs)
                pendingSetupMap.delete(clientWs)
                setupAckedMap.delete(clientWs)
                pendingClientFrames.delete(clientWs)
                pendingClientBytes.delete(clientWs)
                if (event.code !== 1000) {
                    console.warn('[Voice][QwenProxy] Upstream WebSocket closed', {
                        upstreamBase,
                        model: data.model,
                        code: event.code,
                        reason: event.reason
                    })
                }
                try { clientWs.close(toClientCloseCode(event.code), event.reason || 'Upstream closed') } catch { /* */ }
                upstreamMap.delete(clientWs)
            }
        },
        message(clientWs, message) {
            if (!isQwenSafeClientFrame(message)) {
                try { clientWs.close(1008, 'Client session.update may only modify instructions') } catch { /* */ }
                return
            }
            const upstream = upstreamMap.get(clientWs)
            if (upstream?.readyState !== WS_OPEN) return

            // Hold client frames until DashScope has acknowledged the hub-owned session.update.
            // Without this gate, the client could race response.create / conversation.item.create /
            // instruction-only session.update past the lockdown of tools/voice/instructions and run
            // the upstream session under the provider default config or partially-applied state.
            if (setupAckedMap.get(clientWs) !== true) {
                const frameSize = typeof message === 'string' ? message.length : (message as ArrayBuffer | Uint8Array).byteLength
                const total = (pendingClientBytes.get(clientWs) ?? 0) + frameSize
                if (total > MAX_PENDING_BYTES) {
                    try { clientWs.close(1009, 'Setup-gate frame budget exceeded') } catch { /* */ }
                    return
                }
                pendingClientBytes.set(clientWs, total)
                if (typeof message === 'string') gateMap.get(clientWs)?.clientFrame(message)
                const queue = pendingClientFrames.get(clientWs) ?? []
                queue.push(message)
                pendingClientFrames.set(clientWs, queue)
                return
            }
            if (typeof message === 'string') gateMap.get(clientWs)?.clientFrame(message)
            upstream.send(message)
        },
        close(clientWs, code, reason) {
            dropGate(clientWs)
            pendingSetupMap.delete(clientWs)
            setupAckedMap.delete(clientWs)
            pendingClientFrames.delete(clientWs)
            pendingClientBytes.delete(clientWs)
            const upstream = upstreamMap.get(clientWs)
            if (upstream) {
                try { upstream.close(toClientCloseCode(code), (reason || 'Client closed').slice(0, 123)) } catch { /* */ }
                upstreamMap.delete(clientWs)
            }
        }
    }
}
