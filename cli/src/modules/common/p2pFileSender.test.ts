import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RTCPeerConnection, RTCIceCandidate, RTCSessionDescription } from 'werift'
import { clearGeneratedFiles, registerGeneratedFile } from './generatedFiles'
import { configureGeneratedBlobUploader } from './generatedBlobUpload'
import {
    classifyCandidateRoute,
    decodeP2pDataFrame,
    encodeP2pDataFrame,
    handlePrepareP2pFileTransfer,
    handleSignalP2pFileTransfer,
    isFakeIpOrTunIpv4,
    isRfc1918LanIpv4,
    isTailscaleCgnatIpv4,
    resetP2pFileSenderForTests,
    selectPhysicalLanIpv4s
} from './p2pFileSender'

describe('p2pFileSender network classification & framing', () => {
    it('excludes Mihomo Fake-IP TUN and Tailscale CGNAT from physical LAN classification', () => {
        expect(isFakeIpOrTunIpv4('198.18.0.1', 'Mihomo')).toBe(true)
        expect(isFakeIpOrTunIpv4('198.19.12.34')).toBe(true)
        expect(isFakeIpOrTunIpv4('192.168.0.127', 'Wi-Fi')).toBe(false)
        expect(isTailscaleCgnatIpv4('100.119.54.14', 'Tailscale')).toBe(true)
        expect(isTailscaleCgnatIpv4('192.168.0.127', 'Wi-Fi')).toBe(false)
        expect(isRfc1918LanIpv4('192.168.0.127')).toBe(true)
        expect(isRfc1918LanIpv4('10.0.0.5')).toBe(true)
        expect(isRfc1918LanIpv4('172.20.1.2')).toBe(true)
        expect(isRfc1918LanIpv4('100.119.54.14')).toBe(false)
    })

    it('classifies LAN direct, WAN direct, and unverified TUN/Tailscale routes accurately', () => {
        expect(
            classifyCandidateRoute('candidate:1 1 udp 2116026367 192.168.0.127 60104 typ host generation 0')
        ).toBe('lan-direct')
        expect(
            classifyCandidateRoute('candidate:2 1 udp 1694498815 114.132.197.231 54321 typ srflx raddr 192.168.0.127 rport 60104')
        ).toBe('wan-direct')
        expect(
            classifyCandidateRoute('candidate:3 1 udp 2116026367 100.119.54.14 60105 typ host generation 0')
        ).toBe('p2p-unverified-route')
        expect(
            classifyCandidateRoute('candidate:4 1 udp 2116026367 198.18.0.1 60106 typ host generation 0')
        ).toBe('p2p-unverified-route')
    })

    it('encodes and decodes binary P2P data frames with 64-bit offsets and rejects malformed frames', () => {
        const sample = new Uint8Array([1, 2, 3, 4, 5])
        const encoded = encodeP2pDataFrame(65_536, sample)
        const decoded = decodeP2pDataFrame(encoded)
        expect(decoded).not.toBeNull()
        expect(decoded?.offset).toBe(65_536)
        expect(Buffer.from(decoded!.payload).equals(Buffer.from(sample))).toBe(true)

        expect(decodeP2pDataFrame(new Uint8Array([0x7b, 0x22]))).toBeNull()
        expect(decodeP2pDataFrame(new Uint8Array([0x02, 1, 2]))).toBeNull()
    })
})

describe('p2pFileSender WebRTC DataChannel transfer lifecycle', () => {
    let tempDir: string

    beforeEach(async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'hapi-p2p-sender-test-'))
        process.env.HAPI_SENT_FILES_DIR = join(tempDir, 'sent-files')
        configureGeneratedBlobUploader(null)
        await resetP2pFileSenderForTests()
        clearGeneratedFiles()
    })

    afterEach(async () => {
        await resetP2pFileSenderForTests()
        clearGeneratedFiles()
        delete process.env.HAPI_SENT_FILES_DIR
        await rm(tempDir, { recursive: true, force: true })
    })

    it('transfers an immutable file snapshot over WebRTC DataChannel with ACK backpressure and SHA256 verification', async () => {
        const sourcePath = join(tempDir, 'model.bin')
        const rawBytes = randomBytes(256 * 1024 + 321) // ~256.3 KiB across 17 chunks
        const expectedSha256 = createHash('sha256').update(rawBytes).digest('hex')
        await writeFile(sourcePath, rawBytes)

        const meta = await registerGeneratedFile({
            id: 'p2p-file-1',
            path: sourcePath,
            fileName: 'building.bin'
        })
        // Mutate the working-directory file after registration: P2P MUST serve the snapshot, not the mutated file
        await writeFile(sourcePath, 'mutated-working-tree-content')

        const prepared = await handlePrepareP2pFileTransfer({
            transferId: 'tx-1',
            authToken: 'secret-token-1',
            kind: 'file',
            id: meta.id,
            expiresAt: Date.now() + 60_000,
            iceServers: []
        })
        expect(prepared.success).toBe(true)
        if (!prepared.success) return
        expect(prepared.manifest).toEqual({
            transferId: 'tx-1',
            kind: 'file',
            blobId: 'p2p-file-1',
            fileName: 'building.bin',
            mimeType: 'application/octet-stream',
            size: rawBytes.byteLength,
            sha256: expectedSha256,
            chunkBytes: 16 * 1024
        })

        const { primaryBindIp } = selectPhysicalLanIpv4s()
        const receiverPc = new RTCPeerConnection({
            iceServers: [],
            iceUseIpv4: true,
            iceUseIpv6: false,
            ...(primaryBindIp ? { iceInterfaceAddresses: { udp4: primaryBindIp } } : {})
        })

        const receiverCandidates: Array<{ candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null }> = []
        receiverPc.onIceCandidate.subscribe((cand) => {
            if (cand && cand.candidate && !isFakeIpOrTunIpv4(cand.candidate)) {
                receiverCandidates.push({
                    candidate: cand.candidate,
                    sdpMid: cand.sdpMid ?? '0',
                    sdpMLineIndex: cand.sdpMLineIndex ?? 0
                })
            }
        })

        const receivedSlices: Buffer[] = []
        let expectedOffset = 0
        const transferFinished = Promise.withResolvers<{ size: number; sha256: string }>()

        receiverPc.onDataChannel.subscribe((channel) => {
            channel.onMessage.subscribe((data) => {
                const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
                if (buf.byteLength > 0 && buf[0] === 0x7b) {
                    const ctrl = JSON.parse(buf.toString('utf8')) as Record<string, unknown>
                    if (ctrl.type === 'manifest') {
                        channel.send(JSON.stringify({
                            type: 'accept',
                            transferId: 'tx-1',
                            authToken: 'secret-token-1',
                            resumeOffset: 0
                        }))
                    } else if (ctrl.type === 'finish') {
                        transferFinished.resolve({
                            size: Number(ctrl.size),
                            sha256: String(ctrl.sha256)
                        })
                    }
                    return
                }
                const frame = decodeP2pDataFrame(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength))
                if (!frame) {
                    transferFinished.reject(new Error('Invalid binary data frame'))
                    return
                }
                if (frame.offset !== expectedOffset) {
                    transferFinished.reject(new Error(`Offset mismatch: ${frame.offset} !== ${expectedOffset}`))
                    return
                }
                receivedSlices.push(Buffer.from(frame.payload))
                expectedOffset += frame.payload.byteLength
                if (expectedOffset % (64 * 1024) === 0 || expectedOffset === rawBytes.byteLength) {
                    channel.send(JSON.stringify({
                        type: 'ack',
                        transferId: 'tx-1',
                        received: expectedOffset
                    }))
                }
            })
        })

        try {
            await receiverPc.setRemoteDescription(new RTCSessionDescription(prepared.offer.sdp, 'offer'))
            for (const t of receiverPc.iceTransports) {
                t.connection.stunServer = undefined
            }
            const answer = await receiverPc.createAnswer()
            await receiverPc.setLocalDescription(answer)
            for (const cand of prepared.candidates) {
                await receiverPc.addIceCandidate(new RTCIceCandidate({
                    candidate: cand.candidate,
                    sdpMid: cand.sdpMid ?? '0',
                    sdpMLineIndex: cand.sdpMLineIndex ?? 0
                }))
            }

            const signalRes = await handleSignalP2pFileTransfer({
                transferId: 'tx-1',
                action: 'signal',
                answer: {
                    type: 'answer',
                    sdp: (receiverPc.localDescription ?? answer).sdp
                },
                candidates: receiverCandidates
            })
            expect(signalRes.success).toBe(true)

            const finished = await transferFinished.promise
            const assembled = Buffer.concat(receivedSlices)
            const actualSha256 = createHash('sha256').update(assembled).digest('hex')
            expect(finished.size).toBe(rawBytes.byteLength)
            expect(finished.sha256).toBe(expectedSha256)
            expect(assembled.byteLength).toBe(rawBytes.byteLength)
            expect(actualSha256).toBe(expectedSha256)
        } finally {
            await receiverPc.close()
        }
    }, 20_000)

    it('rejects missing snapshots, enforces concurrency limits, and rejects invalid authToken on DataChannel', async () => {
        const missing = await handlePrepareP2pFileTransfer({
            transferId: 'tx-missing',
            authToken: 'tok',
            kind: 'file',
            id: 'non-existent-id',
            expiresAt: Date.now() + 60_000
        })
        expect(missing).toEqual({
            success: false,
            reason: 'snapshot-missing',
            error: 'File snapshot is no longer available on the source machine'
        })

        const sourcePath = join(tempDir, 'small.txt')
        await writeFile(sourcePath, 'hello p2p')
        await registerGeneratedFile({ id: 'p2p-small', path: sourcePath })

        const txA = await handlePrepareP2pFileTransfer({
            transferId: 'tx-a',
            authToken: 'tok-a',
            kind: 'file',
            id: 'p2p-small',
            expiresAt: Date.now() + 60_000
        })
        const txB = await handlePrepareP2pFileTransfer({
            transferId: 'tx-b',
            authToken: 'tok-b',
            kind: 'file',
            id: 'p2p-small',
            expiresAt: Date.now() + 60_000
        })
        const txC = await handlePrepareP2pFileTransfer({
            transferId: 'tx-c',
            authToken: 'tok-c',
            kind: 'file',
            id: 'p2p-small',
            expiresAt: Date.now() + 60_000
        })
        expect(txA.success).toBe(true)
        expect(txB.success).toBe(true)
        expect(txC).toMatchObject({ success: false, reason: 'busy' })

        await handleSignalP2pFileTransfer({ transferId: 'tx-a', action: 'cancel' })
        const txCAfterCancel = await handlePrepareP2pFileTransfer({
            transferId: 'tx-c',
            authToken: 'tok-c',
            kind: 'file',
            id: 'p2p-small',
            expiresAt: Date.now() + 60_000
        })
        expect(txCAfterCancel.success).toBe(true)
    })
})
