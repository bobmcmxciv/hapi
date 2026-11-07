import type {
    CreateP2pFileTransferResponse,
    P2pIceCandidateInit,
    P2pRouteCategory,
    P2pSessionDescriptionInit,
    SignalP2pFileTransferRpcResponse
} from '@hapi/protocol/apiTypes'
import {
    MAX_GENERATED_BLOB_BYTES,
    P2P_DATACHANNEL_WINDOW_BYTES,
    P2P_NEGOTIATION_TIMEOUT_MS
} from '@hapi/protocol/socketLimits'

export const P2P_DATA_FRAME_MAGIC = 0x02
export const P2P_DATA_FRAME_HEADER_BYTES = 9

export type P2pDownloadState =
    | 'preparing'
    | 'negotiating'
    | 'transferring-direct'
    | 'verifying'
    | 'switching-to-hub'
    | 'transferring-hub'
    | 'completed'
    | 'cancelled'
    | 'failed'

export type P2pDownloadStatus = {
    state: P2pDownloadState
    receivedBytes: number
    totalBytes: number | null
    speedBytesPerSec: number
    routeCategory: P2pRouteCategory | null
    negotiateMs: number | null
    fallbackReason: string | null
    candidateTypes: string[]
    error: string | null
}

export type SaveFileWritableLike = {
    write(data: Uint8Array): Promise<void>
    close(): Promise<void>
    abort(): Promise<void>
}

export type SaveFileHandleLike = {
    createWritable(): Promise<SaveFileWritableLike>
}

export type AcquiredSaveTarget =
    | { kind: 'file-handle'; handle: SaveFileHandleLike }
    | { kind: 'browser-default' }
    | { kind: 'aborted' }

/**
 * Streaming SHA-256 implementation so File System Access API downloads can
 * verify the full-file digest without holding the entire file in JS memory.
 */
const SHA256_K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
])

export class IncrementalSha256 {
    private readonly state = new Uint32Array([
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
        0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
    ])
    private readonly buffer = new Uint8Array(64)
    private readonly words = new Uint32Array(64)
    private bufferLength = 0
    private totalBytes = 0

    update(chunk: Uint8Array): void {
        let offset = 0
        this.totalBytes += chunk.byteLength
        while (offset < chunk.byteLength) {
            const copyLen = Math.min(64 - this.bufferLength, chunk.byteLength - offset)
            this.buffer.set(chunk.subarray(offset, offset + copyLen), this.bufferLength)
            this.bufferLength += copyLen
            offset += copyLen
            if (this.bufferLength === 64) {
                this.processBlock(this.buffer)
                this.bufferLength = 0
            }
        }
    }

    digestHex(): string {
        const bitLenHi = Math.floor((this.totalBytes * 8) / 0x100000000)
        const bitLenLo = (this.totalBytes * 8) >>> 0

        this.buffer[this.bufferLength++] = 0x80
        if (this.bufferLength > 56) {
            this.buffer.fill(0, this.bufferLength, 64)
            this.processBlock(this.buffer)
            this.bufferLength = 0
        }
        this.buffer.fill(0, this.bufferLength, 56)
        const view = new DataView(this.buffer.buffer)
        view.setUint32(56, bitLenHi, false)
        view.setUint32(60, bitLenLo, false)
        this.processBlock(this.buffer)

        let hex = ''
        for (let i = 0; i < 8; i += 1) {
            hex += (this.state[i] >>> 0).toString(16).padStart(8, '0')
        }
        return hex
    }

    private processBlock(block: Uint8Array): void {
        const w = this.words
        const view = new DataView(block.buffer, block.byteOffset, 64)
        for (let i = 0; i < 16; i += 1) {
            w[i] = view.getUint32(i * 4, false)
        }
        for (let i = 16; i < 64; i += 1) {
            const v0 = w[i - 15]
            const s0 = ((v0 >>> 7) | (v0 << 25)) ^ ((v0 >>> 18) | (v0 << 14)) ^ (v0 >>> 3)
            const v1 = w[i - 2]
            const s1 = ((v1 >>> 17) | (v1 << 15)) ^ ((v1 >>> 19) | (v1 << 13)) ^ (v1 >>> 10)
            w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0
        }

        let [a, b, c, d, e, f, g, h] = this.state
        for (let i = 0; i < 64; i += 1) {
            const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))
            const ch = (e & f) ^ (~e & g)
            const temp1 = (h + s1 + ch + SHA256_K[i] + w[i]) >>> 0
            const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))
            const maj = (a & b) ^ (a & c) ^ (b & c)
            const temp2 = (s0 + maj) >>> 0

            h = g
            g = f
            f = e
            e = (d + temp1) >>> 0
            d = c
            c = b
            b = a
            a = (temp1 + temp2) >>> 0
        }

        this.state[0] = (this.state[0] + a) >>> 0
        this.state[1] = (this.state[1] + b) >>> 0
        this.state[2] = (this.state[2] + c) >>> 0
        this.state[3] = (this.state[3] + d) >>> 0
        this.state[4] = (this.state[4] + e) >>> 0
        this.state[5] = (this.state[5] + f) >>> 0
        this.state[6] = (this.state[6] + g) >>> 0
        this.state[7] = (this.state[7] + h) >>> 0
    }
}

export function decodeP2pDataFrame(raw: Uint8Array): { offset: number; payload: Uint8Array } | null {
    if (raw.byteLength < P2P_DATA_FRAME_HEADER_BYTES || raw[0] !== P2P_DATA_FRAME_MAGIC) {
        return null
    }
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
    const offsetBig = view.getBigUint64(1, false)
    const offset = Number(offsetBig)
    if (!Number.isSafeInteger(offset) || offset < 0) {
        return null
    }
    return {
        offset,
        payload: raw.subarray(P2P_DATA_FRAME_HEADER_BYTES)
    }
}

export function classifySelectedCandidatePair(
    localCandidateSdpOrType: string,
    remoteCandidateSdpOrAddress: string
): P2pRouteCategory {
    const combined = `${localCandidateSdpOrType} ${remoteCandidateSdpOrAddress}`
    if (/\b198\.1[89]\./.test(combined) || /\b100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(combined)) {
        return 'p2p-unverified-route'
    }
    if (/\b(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.|127\.0\.0\.1)\b/.test(combined)) {
        return 'lan-direct'
    }
    if (/\b(srflx|prflx)\b/i.test(combined)) {
        return 'wan-direct'
    }
    return 'p2p-unverified-route'
}

export function formatP2pRouteLabel(route: P2pRouteCategory | null): string {
    switch (route) {
        case 'lan-direct':
            return 'LAN direct (bypasses ECS)'
        case 'wan-direct':
            return 'WAN P2P direct (bypasses ECS)'
        case 'p2p-unverified-route':
            return 'P2P channel (underlying route unverified)'
        case 'hub-cache':
            return 'Hub cache'
        default:
            return ''
    }
}

export async function acquireSaveTargetInUserGesture(suggestedName: string): Promise<AcquiredSaveTarget> {
    if (typeof window === 'undefined' || !('showSaveFilePicker' in window)) {
        return { kind: 'browser-default' }
    }
    const candidate = window.showSaveFilePicker
    if (typeof candidate !== 'function') {
        return { kind: 'browser-default' }
    }
    try {
        const handle = await (candidate as (options?: { suggestedName?: string }) => Promise<SaveFileHandleLike>)({
            suggestedName
        })
        return { kind: 'file-handle', handle }
    } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
            return { kind: 'aborted' }
        }
        return { kind: 'browser-default' }
    }
}

export type P2pSignalingApi = {
    createP2pFileTransfer(sessionId: string, fileId: string, signal?: AbortSignal): Promise<CreateP2pFileTransferResponse>
    signalP2pFileTransfer(
        sessionId: string,
        fileId: string,
        transferId: string,
        body: {
            action?: 'signal' | 'cancel' | 'complete' | 'renew'
            answer?: P2pSessionDescriptionInit
            candidates?: P2pIceCandidateInit[]
            reason?: string
        },
        signal?: AbortSignal
    ): Promise<SignalP2pFileTransferRpcResponse>
}

export type RunP2pDownloadOptions = {
    api: P2pSignalingApi
    sessionId: string
    fileId: string
    fileName: string
    mimeType: string
    saveTarget: AcquiredSaveTarget
    signal: AbortSignal
    negotiationTimeoutMs?: number
    onStatus: (status: P2pDownloadStatus) => void
}

export type RunP2pDownloadResult =
    | { outcome: 'completed'; bytes: number; sha256: string; blob?: Blob; routeCategory: P2pRouteCategory; negotiateMs: number }
    | { outcome: 'fallback-to-hub'; reason: string; hubReady: boolean }
    | { outcome: 'cancelled' }

export async function runP2pDirectFileDownload(
    options: RunP2pDownloadOptions
): Promise<RunP2pDownloadResult> {
    const { api, sessionId, fileId, mimeType, saveTarget, signal, onStatus } = options
    const negotiationTimeoutMs = options.negotiationTimeoutMs ?? P2P_NEGOTIATION_TIMEOUT_MS

    if (typeof RTCPeerConnection === 'undefined') {
        return { outcome: 'fallback-to-hub', reason: 'WebRTC is not supported in this browser', hubReady: false }
    }

    let status: P2pDownloadStatus = {
        state: 'preparing',
        receivedBytes: 0,
        totalBytes: null,
        speedBytesPerSec: 0,
        routeCategory: null,
        negotiateMs: null,
        fallbackReason: null,
        candidateTypes: [],
        error: null
    }
    const emit = (patch: Partial<P2pDownloadStatus>) => {
        status = { ...status, ...patch }
        onStatus(status)
    }

    emit({ state: 'preparing' })
    let created: CreateP2pFileTransferResponse
    try {
        created = await api.createP2pFileTransfer(sessionId, fileId, signal)
    } catch (error) {
        if (signal.aborted) return { outcome: 'cancelled' }
        return {
            outcome: 'fallback-to-hub',
            reason: error instanceof Error ? error.message : 'Failed to initialize direct transfer',
            hubReady: false
        }
    }

    if (signal.aborted) {
        return { outcome: 'cancelled' }
    }
    if (!created.p2pAvailable) {
        return {
            outcome: 'fallback-to-hub',
            reason: created.error || `Direct transfer unavailable (${created.reason})`,
            hubReady: created.hubReady
        }
    }

    const { transferId, authToken, offer, candidates: remoteCandidates, manifest, iceServers, candidateTypes } = created
    if (saveTarget.kind === 'browser-default' && manifest.size > MAX_GENERATED_BLOB_BYTES) {
        void api.signalP2pFileTransfer(sessionId, fileId, transferId, {
            action: 'cancel',
            reason: 'Browser lacks streaming file picker for large file'
        }).catch(() => {})
        return {
            outcome: 'fallback-to-hub',
            reason: 'Browser does not support streaming disk save for large files',
            hubReady: created.hubReady
        }
    }

    emit({
        state: 'negotiating',
        totalBytes: manifest.size,
        candidateTypes
    })

    const negotiateStartedAt = performance.now()
    const pc = new RTCPeerConnection({
        iceServers: iceServers.length > 0 ? iceServers : []
    })
    let writable: SaveFileWritableLike | null = null
    const memoryChunks: Uint8Array[] = []
    const hasher = new IncrementalSha256()
    let expectedOffset = 0
    let lastAckedOffset = 0
    let firstChunkReceived = false
    let negotiateMs: number | null = null
    let selectedRoute: P2pRouteCategory = candidateTypes.includes('host') ? 'lan-direct' : 'p2p-unverified-route'
    let transferStartedAt = performance.now()

    const cleanupPeer = async (notifyCancelReason?: string) => {
        try {
            pc.close()
        } catch {
            // ignore
        }
        if (writable) {
            const w = writable
            writable = null
            await w.abort().catch(() => {})
        }
        if (notifyCancelReason) {
            void api.signalP2pFileTransfer(sessionId, fileId, transferId, {
                action: 'cancel',
                reason: notifyCancelReason
            }).catch(() => {})
        }
    }

    const { promise: outcomePromise, resolve: resolveOutcome } = Promise.withResolvers<RunP2pDownloadResult>()
    let settled = false
    const settle = (result: RunP2pDownloadResult) => {
        if (settled) return
        settled = true
        clearTimeout(negotiationTimer)
        resolveOutcome(result)
    }

    const negotiationTimer = setTimeout(() => {
        if (!firstChunkReceived && !settled) {
            void cleanupPeer('P2P negotiation timed out').finally(() => {
                settle({
                    outcome: 'fallback-to-hub',
                    reason: `Direct connection timed out after ${Math.round(negotiationTimeoutMs / 1000)}s`,
                    hubReady: created.hubReady
                })
            })
        }
    }, negotiationTimeoutMs)

    const onAbort = () => {
        void cleanupPeer('Cancelled by user').finally(() => {
            settle({ outcome: 'cancelled' })
        })
    }
    signal.addEventListener('abort', onAbort, { once: true })

    // Queue write operations strictly sequentially so ACK is only sent after bytes are persisted/buffered
    let writeChain = Promise.resolve()

    pc.ondatachannel = (event) => {
        const channel = event.channel
        channel.binaryType = 'arraybuffer'

        channel.onmessage = (msgEvent) => {
            if (settled || signal.aborted) return

            if (typeof msgEvent.data === 'string') {
                let ctrl: Record<string, unknown>
                try {
                    ctrl = JSON.parse(msgEvent.data) as Record<string, unknown>
                } catch {
                    return
                }
                if (ctrl.transferId !== transferId) return

                if (ctrl.type === 'manifest') {
                    if (ctrl.authToken !== authToken || ctrl.sha256 !== manifest.sha256 || ctrl.size !== manifest.size) {
                        void cleanupPeer('Manifest verification failed').finally(() => {
                            settle({
                                outcome: 'fallback-to-hub',
                                reason: 'Source manifest mismatch',
                                hubReady: created.hubReady
                            })
                        })
                        return
                    }
                    writeChain = writeChain.then(async () => {
                        if (saveTarget.kind === 'file-handle' && !writable) {
                            writable = await saveTarget.handle.createWritable()
                        }
                        if (manifest.size === 0) {
                            firstChunkReceived = true
                            clearTimeout(negotiationTimer)
                            negotiateMs = Math.round(performance.now() - negotiateStartedAt)
                            emit({
                                state: 'transferring-direct',
                                negotiateMs,
                                routeCategory: selectedRoute
                            })
                        }
                        const maxMsgSize = pc.sctp?.maxMessageSize
                        channel.send(JSON.stringify({
                            type: 'accept',
                            transferId,
                            authToken,
                            resumeOffset: 0,
                            ...(typeof maxMsgSize === 'number' && Number.isFinite(maxMsgSize) ? { maxMessageSize: maxMsgSize } : {})
                        }))
                    }).catch((err) => {
                        void cleanupPeer('Failed to open local save stream').finally(() => {
                            settle({
                                outcome: 'fallback-to-hub',
                                reason: err instanceof Error ? err.message : 'Failed to open save target',
                                hubReady: created.hubReady
                            })
                        })
                    })
                    return
                }

                if (ctrl.type === 'finish') {
                    writeChain = writeChain.then(async () => {
                        if (settled || signal.aborted) return
                        emit({ state: 'verifying' })
                        if (expectedOffset !== manifest.size) {
                            throw new Error(`Incomplete P2P transfer (${expectedOffset}/${manifest.size} bytes)`)
                        }
                        const actualSha256 = hasher.digestHex()
                        if (actualSha256 !== manifest.sha256) {
                            throw new Error('P2P file SHA-256 checksum mismatch')
                        }
                        if (writable) {
                            const w = writable
                            writable = null
                            await w.close()
                        }
                        void api.signalP2pFileTransfer(sessionId, fileId, transferId, {
                            action: 'complete'
                        }).catch(() => {})
                        try {
                            pc.close()
                        } catch {
                            // ignore
                        }
                        const blob = saveTarget.kind === 'browser-default'
                            ? new Blob(memoryChunks as BlobPart[], { type: mimeType })
                            : undefined
                        settle({
                            outcome: 'completed',
                            bytes: expectedOffset,
                            sha256: actualSha256,
                            ...(blob ? { blob } : {}),
                            routeCategory: selectedRoute,
                            negotiateMs: negotiateMs ?? Math.round(performance.now() - negotiateStartedAt)
                        })
                    }).catch((err) => {
                        void cleanupPeer('Verification failed').finally(() => {
                            settle({
                                outcome: 'fallback-to-hub',
                                reason: err instanceof Error ? err.message : 'P2P verification failed',
                                hubReady: created.hubReady
                            })
                        })
                    })
                    return
                }

                if (ctrl.type === 'cancel') {
                    void cleanupPeer().finally(() => {
                        settle({
                            outcome: 'fallback-to-hub',
                            reason: typeof ctrl.reason === 'string' ? ctrl.reason : 'Source cancelled direct transfer',
                            hubReady: created.hubReady
                        })
                    })
                }
                return
            }

            const rawBytes = msgEvent.data instanceof ArrayBuffer
                ? new Uint8Array(msgEvent.data)
                : msgEvent.data instanceof Uint8Array
                    ? msgEvent.data
                    : null
            if (!rawBytes) return

            // Allow JSON control frames that arrived as binary Buffer/ArrayBuffer from werift
            if (rawBytes.byteLength > 0 && rawBytes[0] === 0x7b) {
                const decodedText = new TextDecoder().decode(rawBytes)
                channel.onmessage?.(new MessageEvent('message', { data: decodedText }))
                return
            }

            const frame = decodeP2pDataFrame(rawBytes)
            if (!frame) {
                void cleanupPeer('Malformed binary frame').finally(() => {
                    settle({
                        outcome: 'fallback-to-hub',
                        reason: 'Malformed P2P data frame',
                        hubReady: created.hubReady
                    })
                })
                return
            }

            writeChain = writeChain.then(async () => {
                if (settled || signal.aborted) return
                if (!firstChunkReceived) {
                    firstChunkReceived = true
                    clearTimeout(negotiationTimer)
                    negotiateMs = Math.round(performance.now() - negotiateStartedAt)
                    transferStartedAt = performance.now()
                }
                if (frame.offset !== expectedOffset || expectedOffset + frame.payload.byteLength > manifest.size) {
                    throw new Error(`Out-of-order or out-of-bounds P2P chunk at offset ${frame.offset} (expected ${expectedOffset})`)
                }
                const copy = new Uint8Array(frame.payload.byteLength)
                copy.set(frame.payload)
                hasher.update(copy)
                if (writable) {
                    await writable.write(copy)
                } else {
                    memoryChunks.push(copy)
                }
                expectedOffset += copy.byteLength

                if (
                    expectedOffset - lastAckedOffset >= Math.floor(P2P_DATACHANNEL_WINDOW_BYTES / 2)
                    || expectedOffset === manifest.size
                ) {
                    lastAckedOffset = expectedOffset
                    if (channel.readyState === 'open') {
                        channel.send(JSON.stringify({
                            type: 'ack',
                            transferId,
                            received: expectedOffset
                        }))
                    }
                }

                const elapsedSec = Math.max(0.001, (performance.now() - transferStartedAt) / 1000)
                emit({
                    state: 'transferring-direct',
                    receivedBytes: expectedOffset,
                    totalBytes: manifest.size,
                    speedBytesPerSec: Math.round(expectedOffset / elapsedSec),
                    routeCategory: selectedRoute,
                    negotiateMs
                })
            }).catch((err) => {
                void cleanupPeer('Chunk write error').finally(() => {
                    settle({
                        outcome: 'fallback-to-hub',
                        reason: err instanceof Error ? err.message : 'Failed writing P2P chunk',
                        hubReady: created.hubReady
                    })
                })
            })
        }

        channel.onerror = () => {
            if (!settled) {
                void cleanupPeer('DataChannel error').finally(() => {
                    settle({
                        outcome: 'fallback-to-hub',
                        reason: 'WebRTC DataChannel interrupted',
                        hubReady: created.hubReady
                    })
                })
            }
        }
    }

    const gatheredLocalCandidates: P2pIceCandidateInit[] = []
    pc.onicecandidate = (event) => {
        if (event.candidate && event.candidate.candidate) {
            gatheredLocalCandidates.push({
                candidate: event.candidate.candidate,
                sdpMid: event.candidate.sdpMid,
                sdpMLineIndex: event.candidate.sdpMLineIndex
            })
        }
    }

    pc.oniceconnectionstatechange = () => {
        if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
            if (!settled) {
                void cleanupPeer(`ICE ${pc.iceConnectionState}`).finally(() => {
                    settle({
                        outcome: 'fallback-to-hub',
                        reason: `Direct ICE connection ${pc.iceConnectionState}`,
                        hubReady: created.hubReady
                    })
                })
            }
        }
    }

    try {
        await pc.setRemoteDescription(offer)
        for (const cand of remoteCandidates) {
            try {
                await pc.addIceCandidate(cand)
            } catch {
                // ignore unsupported candidate
            }
        }
        const answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)

        // Wait briefly (up to 150ms) for initial local host candidates to gather so we send answer + candidates in one round-trip
        if (pc.iceGatheringState !== 'complete') {
            const { promise: gatherPromise, resolve: resolveGather } = Promise.withResolvers<void>()
            const timer = setTimeout(resolveGather, 150)
            pc.addEventListener('icegatheringstatechange', () => {
                if (pc.iceGatheringState === 'complete') {
                    clearTimeout(timer)
                    resolveGather()
                }
            })
            await gatherPromise
        }

        const localDesc = pc.localDescription ?? answer
        const signalResult = await api.signalP2pFileTransfer(sessionId, fileId, transferId, {
            action: 'signal',
            answer: {
                type: 'answer',
                sdp: localDesc.sdp ?? ''
            },
            candidates: gatheredLocalCandidates
        }, signal)
        if (!signalResult.success) {
            await cleanupPeer()
            settle({
                outcome: 'fallback-to-hub',
                reason: signalResult.error ?? 'Hub rejected WebRTC answer',
                hubReady: created.hubReady
            })
        } else {
            selectedRoute = classifySelectedCandidatePair(
                gatheredLocalCandidates.map((c) => c.candidate).join(' '),
                remoteCandidates.map((c) => c.candidate).join(' ')
            )
            emit({ routeCategory: selectedRoute })
        }
    } catch (error) {
        await cleanupPeer('WebRTC negotiation exception')
        if (signal.aborted) {
            settle({ outcome: 'cancelled' })
        } else {
            settle({
                outcome: 'fallback-to-hub',
                reason: error instanceof Error ? error.message : 'WebRTC negotiation failed',
                hubReady: created.hubReady
            })
        }
    }

    try {
        return await outcomePromise
    } finally {
        signal.removeEventListener('abort', onAbort)
    }
}
