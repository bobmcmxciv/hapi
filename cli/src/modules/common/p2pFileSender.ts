import { createHash, timingSafeEqual } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { RTCPeerConnection, RTCIceCandidate, RTCSessionDescription } from 'werift'
import type {
    GeneratedBlobKind,
    P2pIceCandidateInit,
    P2pRouteCategory,
    P2pTransferManifest,
    PrepareP2pFileTransferRpcRequest,
    PrepareP2pFileTransferRpcResponse,
    SignalP2pFileTransferRpcRequest,
    SignalP2pFileTransferRpcResponse
} from '@hapi/protocol/apiTypes'
import {
    P2P_DATACHANNEL_DEFAULT_CHUNK_BYTES,
    P2P_DATACHANNEL_MAX_CHUNK_BYTES,
    P2P_DATACHANNEL_WINDOW_BYTES,
    P2P_MAX_CONCURRENT_TRANSFERS_PER_SESSION
} from '@hapi/protocol/socketLimits'
import { loadGeneratedFile, readGeneratedFileChunk } from './generatedFiles'
import { getGeneratedImage } from './generatedImages'
import { logger } from '@/ui/logger'

export const P2P_DATA_FRAME_MAGIC = 0x02
export const P2P_DATA_FRAME_HEADER_BYTES = 9

type ResolvedSnapshotSource = {
    kind: GeneratedBlobKind
    id: string
    fileName: string
    mimeType: string
    size: number
    sha256: string
    readSlice: (offset: number, length: number) => Promise<Uint8Array>
}

type ActiveP2pTransfer = {
    transferId: string
    authToken: string
    source: ResolvedSnapshotSource
    manifest: P2pTransferManifest
    pc: RTCPeerConnection
    dc: ReturnType<RTCPeerConnection['createDataChannel']>
    localCandidates: P2pIceCandidateInit[]
    candidateTypes: Set<string>
    remoteDescriptionSet: boolean
    pendingRemoteCandidates: P2pIceCandidateInit[]
    streamingStarted: boolean
    cancelled: boolean
    completed: boolean
    ackedBytes: number
    ackWaiter: (() => void) | null
    expiresAt: number
    expiryTimer: ReturnType<typeof setTimeout>
}

const activeTransfers = new Map<string, ActiveP2pTransfer>()

export function isFakeIpOrTunIpv4(ip: string, ifaceName: string = ''): boolean {
    if (/mihomo|clash|wintun|utun|tun|tap/i.test(ifaceName)) {
        return true
    }
    const parts = ip.split('.').map((part) => Number.parseInt(part, 10))
    if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) {
        return true
    }
    // 198.18.0.0/15 (RFC 2544 benchmark / Mihomo & Clash Fake-IP range)
    if (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19)) {
        return true
    }
    // 169.254.0.0/16 link-local
    if (parts[0] === 169 && parts[1] === 254) {
        return true
    }
    return false
}

export function isTailscaleCgnatIpv4(ip: string, ifaceName: string = ''): boolean {
    if (/tailscale/i.test(ifaceName)) {
        return true
    }
    const parts = ip.split('.').map((part) => Number.parseInt(part, 10))
    if (parts.length !== 4) return false
    // 100.64.0.0/10
    return parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127
}

export function isRfc1918LanIpv4(ip: string): boolean {
    const parts = ip.split('.').map((part) => Number.parseInt(part, 10))
    if (parts.length !== 4) return false
    if (parts[0] === 10) return true
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true
    if (parts[0] === 192 && parts[1] === 168) return true
    return false
}

export function selectPhysicalLanIpv4s(): { primaryBindIp?: string; additionalHostIps: string[] } {
    const nets = networkInterfaces()
    const lanIps: string[] = []
    const otherIps: string[] = []
    for (const [name, entries] of Object.entries(nets)) {
        if (!entries) continue
        for (const entry of entries) {
            if (entry.internal || entry.family !== 'IPv4') continue
            if (isFakeIpOrTunIpv4(entry.address, name)) continue
            if (isTailscaleCgnatIpv4(entry.address, name)) continue
            if (isRfc1918LanIpv4(entry.address)) {
                lanIps.push(entry.address)
            } else {
                otherIps.push(entry.address)
            }
        }
    }
    const primaryBindIp = lanIps[0] ?? otherIps[0]
    const additionalHostIps = Array.from(new Set([...lanIps, ...otherIps, '127.0.0.1']))
    return { primaryBindIp, additionalHostIps }
}

export function classifyCandidateRoute(candidateSdp: string): P2pRouteCategory {
    const typMatch = /\btyp\s+([a-z]+)/i.exec(candidateSdp)
    const candType = typMatch?.[1]?.toLowerCase() ?? 'unknown'
    const parts = candidateSdp.trim().split(/\s+/)
    const ip = parts[4] ?? ''
    if (isFakeIpOrTunIpv4(ip) || isTailscaleCgnatIpv4(ip)) {
        return 'p2p-unverified-route'
    }
    if (candType === 'host' && (isRfc1918LanIpv4(ip) || ip === '127.0.0.1')) {
        return 'lan-direct'
    }
    if ((candType === 'srflx' || candType === 'prflx' || candType === 'host') && ip && !ip.includes(':')) {
        return 'wan-direct'
    }
    return 'p2p-unverified-route'
}

export function encodeP2pDataFrame(offset: number, payload: Uint8Array): Buffer {
    const frame = Buffer.allocUnsafe(P2P_DATA_FRAME_HEADER_BYTES + payload.byteLength)
    frame[0] = P2P_DATA_FRAME_MAGIC
    frame.writeBigUInt64BE(BigInt(offset), 1)
    frame.set(payload, P2P_DATA_FRAME_HEADER_BYTES)
    return frame
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

function safeTokenEquals(a: string, b: string): boolean {
    const bufA = Buffer.from(a, 'utf8')
    const bufB = Buffer.from(b, 'utf8')
    if (bufA.byteLength !== bufB.byteLength) return false
    return timingSafeEqual(bufA, bufB)
}

async function computeFileSha256(path: string): Promise<string> {
    const hash = createHash('sha256')
    const { promise, resolve, reject } = Promise.withResolvers<void>()
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve())
    stream.on('error', reject)
    await promise
    return hash.digest('hex')
}

async function resolveSnapshotSource(kind: GeneratedBlobKind, id: string): Promise<ResolvedSnapshotSource | null> {
    if (kind === 'image') {
        const image = getGeneratedImage(id)
        if (!image) return null
        const sha256 = createHash('sha256').update(image.content).digest('hex')
        return {
            kind,
            id,
            fileName: image.fileName,
            mimeType: image.mimeType,
            size: image.content.byteLength,
            sha256,
            readSlice: async (offset, length) => {
                const start = Math.max(0, Math.min(offset, image.content.byteLength))
                const end = Math.max(start, Math.min(start + length, image.content.byteLength))
                return new Uint8Array(image.content.subarray(start, end))
            }
        }
    }
    const file = await loadGeneratedFile(id)
    if (!file) return null
    const sha256 = await computeFileSha256(file.snapshotPath)
    return {
        kind,
        id,
        fileName: file.fileName,
        mimeType: file.mimeType,
        size: file.size,
        sha256,
        readSlice: async (offset, length) => {
            const chunk = await readGeneratedFileChunk(id, offset, length)
            if (!chunk) {
                throw new Error('Snapshot disappeared during P2P transfer')
            }
            return new Uint8Array(chunk.bytes)
        }
    }
}

async function cleanupTransfer(transferId: string): Promise<void> {
    const transfer = activeTransfers.get(transferId)
    if (!transfer) return
    activeTransfers.delete(transferId)
    transfer.cancelled = true
    clearTimeout(transfer.expiryTimer)
    transfer.ackWaiter?.()
    transfer.ackWaiter = null
    try {
        await transfer.pc.close()
    } catch {
        // best effort
    }
}

function scheduleExpiry(transfer: ActiveP2pTransfer, expiresAt: number): void {
    clearTimeout(transfer.expiryTimer)
    transfer.expiresAt = expiresAt
    const delayMs = Math.max(1_000, expiresAt - Date.now())
    transfer.expiryTimer = setTimeout(() => {
        void cleanupTransfer(transfer.transferId)
    }, delayMs)
}

async function streamSnapshotOverDataChannel(
    transfer: ActiveP2pTransfer,
    resumeOffset: number,
    maxMessageSize?: number
): Promise<void> {
    if (transfer.streamingStarted || transfer.cancelled) return
    transfer.streamingStarted = true
    const { dc, source, manifest } = transfer
    const effectiveChunkBytes = typeof maxMessageSize === 'number' && Number.isFinite(maxMessageSize) && maxMessageSize > 1024
        ? Math.max(1024, Math.min(manifest.chunkBytes, P2P_DATACHANNEL_MAX_CHUNK_BYTES, Math.floor(maxMessageSize) - 64))
        : manifest.chunkBytes

    let offset = Math.max(0, Math.min(Math.floor(resumeOffset), source.size))
    transfer.ackedBytes = offset

    try {
        while (offset < source.size && !transfer.cancelled) {
            while (
                !transfer.cancelled
                && (
                    offset - transfer.ackedBytes >= P2P_DATACHANNEL_WINDOW_BYTES
                    || dc.bufferedAmount >= P2P_DATACHANNEL_WINDOW_BYTES
                )
            ) {
                const { promise, resolve } = Promise.withResolvers<void>()
                transfer.ackWaiter = resolve
                const timer = setTimeout(resolve, 50)
                await promise
                clearTimeout(timer)
            }
            if (transfer.cancelled || dc.readyState !== 'open') {
                return
            }
            const length = Math.min(effectiveChunkBytes, source.size - offset)
            const slice = await source.readSlice(offset, length)
            if (slice.byteLength === 0) {
                throw new Error(`Snapshot read returned 0 bytes at offset ${offset}`)
            }
            const frame = encodeP2pDataFrame(offset, slice)
            dc.send(frame)
            offset += slice.byteLength
        }

        if (!transfer.cancelled && dc.readyState === 'open') {
            dc.send(JSON.stringify({
                type: 'finish',
                transferId: transfer.transferId,
                size: source.size,
                sha256: source.sha256
            }))
        }
    } catch (error) {
        logger.debug('[p2pFileSender] Stream failed:', transfer.transferId, error)
        if (!transfer.cancelled && dc.readyState === 'open') {
            try {
                dc.send(JSON.stringify({
                    type: 'cancel',
                    transferId: transfer.transferId,
                    reason: error instanceof Error ? error.message : 'Source read failed'
                }))
            } catch {
                // ignore
            }
        }
        await cleanupTransfer(transfer.transferId)
    }
}

export async function handlePrepareP2pFileTransfer(
    request: PrepareP2pFileTransferRpcRequest
): Promise<PrepareP2pFileTransferRpcResponse> {
    // Reap any expired transfers first
    const now = Date.now()
    for (const [id, existing] of activeTransfers) {
        if (now >= existing.expiresAt || existing.cancelled || existing.completed) {
            await cleanupTransfer(id)
        }
    }

    if (!activeTransfers.has(request.transferId) && activeTransfers.size >= P2P_MAX_CONCURRENT_TRANSFERS_PER_SESSION) {
        return {
            success: false,
            reason: 'busy',
            error: 'Source machine reached maximum concurrent direct transfers'
        }
    }

    await cleanupTransfer(request.transferId)

    let source: ResolvedSnapshotSource | null
    try {
        source = await resolveSnapshotSource(request.kind, request.id)
    } catch (error) {
        return {
            success: false,
            reason: 'failed',
            error: error instanceof Error ? error.message : 'Failed to open snapshot'
        }
    }
    if (!source) {
        return {
            success: false,
            reason: 'snapshot-missing',
            error: 'File snapshot is no longer available on the source machine'
        }
    }

    try {
        const { primaryBindIp } = selectPhysicalLanIpv4s()
        const configuredStun = (request.iceServers ?? []).filter((server) => {
            const urls = Array.isArray(server.urls) ? server.urls : [server.urls]
            return urls.some((u) => typeof u === 'string' && u.startsWith('stun:'))
        })
        const pc = new RTCPeerConnection({
            iceServers: configuredStun,
            iceUseIpv4: true,
            iceUseIpv6: false,
            ...(primaryBindIp ? { iceInterfaceAddresses: { udp4: primaryBindIp } } : {})
        })

        const dc = pc.createDataChannel('hapi-file-v1', { ordered: true })
        const manifest: P2pTransferManifest = {
            transferId: request.transferId,
            kind: request.kind,
            blobId: request.id,
            fileName: source.fileName,
            mimeType: source.mimeType,
            size: source.size,
            sha256: source.sha256,
            chunkBytes: P2P_DATACHANNEL_DEFAULT_CHUNK_BYTES
        }

        const localCandidates: P2pIceCandidateInit[] = []
        const candidateTypes = new Set<string>()

        const transfer: ActiveP2pTransfer = {
            transferId: request.transferId,
            authToken: request.authToken,
            source,
            manifest,
            pc,
            dc,
            localCandidates,
            candidateTypes,
            remoteDescriptionSet: false,
            pendingRemoteCandidates: [],
            streamingStarted: false,
            cancelled: false,
            completed: false,
            ackedBytes: 0,
            ackWaiter: null,
            expiresAt: request.expiresAt,
            expiryTimer: setTimeout(() => {}, 0)
        }
        scheduleExpiry(transfer, request.expiresAt)
        activeTransfers.set(request.transferId, transfer)

        pc.onIceCandidate.subscribe((cand) => {
            if (!cand || !cand.candidate) return
            if (isFakeIpOrTunIpv4(cand.candidate)) return
            const typMatch = /\btyp\s+([a-z]+)/i.exec(cand.candidate)
            if (typMatch?.[1]) {
                candidateTypes.add(typMatch[1].toLowerCase())
            }
            localCandidates.push({
                candidate: cand.candidate,
                sdpMid: cand.sdpMid ?? '0',
                sdpMLineIndex: cand.sdpMLineIndex ?? 0
            })
        })

        dc.stateChanged.subscribe((state) => {
            if (state === 'open' && !transfer.cancelled) {
                try {
                    dc.send(JSON.stringify({
                        type: 'manifest',
                        authToken: transfer.authToken,
                        ...manifest
                    }))
                } catch (error) {
                    logger.debug('[p2pFileSender] Failed sending manifest:', error)
                }
            } else if (state === 'closed') {
                void cleanupTransfer(transfer.transferId)
            }
        })

        dc.onMessage.subscribe((raw) => {
            if (transfer.cancelled) return
            let text: string
            if (typeof raw === 'string') {
                text = raw
            } else if (Buffer.isBuffer(raw)) {
                if (raw.byteLength > 0 && raw[0] !== 0x7b) return
                text = raw.toString('utf8')
            } else {
                return
            }

            let msg: Record<string, unknown>
            try {
                msg = JSON.parse(text) as Record<string, unknown>
            } catch {
                return
            }
            if (msg.transferId !== transfer.transferId) return

            if (msg.type === 'accept') {
                if (typeof msg.authToken !== 'string' || !safeTokenEquals(msg.authToken, transfer.authToken)) {
                    try {
                        dc.send(JSON.stringify({
                            type: 'cancel',
                            transferId: transfer.transferId,
                            reason: 'Invalid transfer authorization token'
                        }))
                    } catch {
                        // ignore
                    }
                    void cleanupTransfer(transfer.transferId)
                    return
                }
                const resumeOffset = typeof msg.resumeOffset === 'number' && Number.isInteger(msg.resumeOffset) && msg.resumeOffset >= 0
                    ? msg.resumeOffset
                    : 0
                if (resumeOffset > source.size) {
                    try {
                        dc.send(JSON.stringify({
                            type: 'cancel',
                            transferId: transfer.transferId,
                            reason: 'Invalid resume offset'
                        }))
                    } catch {
                        // ignore
                    }
                    void cleanupTransfer(transfer.transferId)
                    return
                }
                const maxMessageSize = typeof msg.maxMessageSize === 'number' ? msg.maxMessageSize : undefined
                void streamSnapshotOverDataChannel(transfer, resumeOffset, maxMessageSize)
                return
            }

            if (msg.type === 'ack') {
                const received = typeof msg.received === 'number' ? msg.received : -1
                if (!Number.isInteger(received) || received < transfer.ackedBytes || received > source.size) {
                    return
                }
                transfer.ackedBytes = received
                const waiter = transfer.ackWaiter
                transfer.ackWaiter = null
                waiter?.()
                if (received === source.size) {
                    transfer.completed = true
                }
                return
            }

            if (msg.type === 'cancel') {
                void cleanupTransfer(transfer.transferId)
            }
        })

        const offer = await pc.createOffer()
        if (configuredStun.length === 0) {
            // Prevent werift from falling back to its hardcoded stun.l.google.com:19302
            // and blocking 5s when STUN is unconfigured or blocked by local TUN rules.
            for (const transport of pc.iceTransports) {
                transport.connection.stunServer = undefined
            }
        }
        await pc.setLocalDescription(offer)

        const localDesc = pc.localDescription ?? offer
        return {
            success: true,
            offer: {
                type: 'offer',
                sdp: localDesc.sdp
            },
            candidates: [...localCandidates],
            manifest,
            candidateTypes: Array.from(candidateTypes)
        }
    } catch (error) {
        await cleanupTransfer(request.transferId)
        return {
            success: false,
            reason: 'failed',
            error: error instanceof Error ? error.message : 'Failed to prepare WebRTC sender'
        }
    }
}

export async function handleSignalP2pFileTransfer(
    request: SignalP2pFileTransferRpcRequest
): Promise<SignalP2pFileTransferRpcResponse> {
    const transfer = activeTransfers.get(request.transferId)
    if (request.action === 'cancel' || request.action === 'complete') {
        await cleanupTransfer(request.transferId)
        return { success: true }
    }
    if (!transfer || transfer.cancelled || Date.now() >= transfer.expiresAt) {
        await cleanupTransfer(request.transferId)
        return { success: false, error: 'P2P transfer session not found or expired' }
    }
    if (request.action === 'renew') {
        if (typeof request.expiresAt === 'number' && request.expiresAt > Date.now()) {
            scheduleExpiry(transfer, request.expiresAt)
        }
        return { success: true }
    }

    try {
        if (request.answer) {
            if (request.answer.type !== 'answer' || typeof request.answer.sdp !== 'string' || request.answer.sdp.length > 65_536) {
                return { success: false, error: 'Invalid SDP answer' }
            }
            for (const transport of transfer.pc.iceTransports) {
                if ((transfer.pc.config.iceServers ?? []).length === 0) {
                    transport.connection.stunServer = undefined
                }
            }
            await transfer.pc.setRemoteDescription(new RTCSessionDescription(request.answer.sdp, 'answer'))
            transfer.remoteDescriptionSet = true
            for (const pending of transfer.pendingRemoteCandidates.splice(0)) {
                if (!isFakeIpOrTunIpv4(pending.candidate)) {
                    await transfer.pc.addIceCandidate(new RTCIceCandidate({
                        candidate: pending.candidate,
                        sdpMid: pending.sdpMid ?? '0',
                        sdpMLineIndex: pending.sdpMLineIndex ?? 0
                    }))
                }
            }
        }

        if (Array.isArray(request.candidates)) {
            if (request.candidates.length > 32) {
                return { success: false, error: 'Too many ICE candidates in signal frame' }
            }
            for (const cand of request.candidates) {
                if (!cand || typeof cand.candidate !== 'string' || cand.candidate.length > 1024) continue
                if (isFakeIpOrTunIpv4(cand.candidate)) continue
                if (!transfer.remoteDescriptionSet) {
                    transfer.pendingRemoteCandidates.push(cand)
                } else {
                    await transfer.pc.addIceCandidate(new RTCIceCandidate({
                        candidate: cand.candidate,
                        sdpMid: cand.sdpMid ?? '0',
                        sdpMLineIndex: cand.sdpMLineIndex ?? 0
                    }))
                }
            }
        }

        const firstRemote = request.candidates?.[0]?.candidate ?? ''
        const selectedRoute = firstRemote ? classifyCandidateRoute(firstRemote) : undefined
        return {
            success: true,
            candidates: [...transfer.localCandidates],
            ...(selectedRoute ? { selectedRoute } : {})
        }
    } catch (error) {
        logger.debug('[p2pFileSender] Signal handling failed:', request.transferId, error)
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to apply WebRTC signal'
        }
    }
}

export async function resetP2pFileSenderForTests(): Promise<void> {
    for (const id of [...activeTransfers.keys()]) {
        await cleanupTransfer(id)
    }
}
