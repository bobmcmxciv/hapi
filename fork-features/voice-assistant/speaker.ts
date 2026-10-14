/**
 * 声纹：CAM++（campplus_cn_common-192，与录音助手的声纹库同一模型）由 TXFA608 上的语音服务计算
 * （`POST /speaker/embed`，与曼波同一 token、同一条隧道），hub 只存向量、算余弦相似度。
 *
 * 每个网关账号一份声纹：每次录入存一条质心向量（该次录音各窗口的平均），存在
 * `<dataDir>/voice-voiceprints.json`。管理员账号还没在 hapi 里录过时，先用
 * `<dataDir>/voice-owner-voiceprints.json`（从录音助手导出的“本人”声纹）。
 *
 * 门的开关与阈值在 `<dataDir>/voice-speaker-gate.json`（`{"mode":"enforce","threshold":0.45}`），
 * 每次建立语音连接时现读，改了不用重启 hub；文件不存在时用环境变量
 * `HAPI_VOICE_SPEAKER_GATE`（off|observe|enforce，默认 observe）与 `HAPI_VOICE_SPEAKER_THRESHOLD`。
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type Voiceprint = { vectors: number[][]; source: string; updatedAt: string }

export type SpeakerGateMode = 'off' | 'observe' | 'enforce'
export type SpeakerGateConfig = { mode: SpeakerGateMode; threshold: number }
export type SpeakerGateRecord = { at: number; seconds: number; score: number | null; decision: 'accept' | 'reject'; reason: string; enforced: boolean }

type StoreFile = { version: 1; accounts: Record<string, Voiceprint> }

const EMBED_TIMEOUT_MS = 2_000
export const MAX_VECTORS = 10
export const DEFAULT_SPEAKER_THRESHOLD = 0.4
const RECENT_DECISIONS = 30

function speakerConfig(): { url: string; token: string } | null {
    const url = process.env.HAPI_VOICE_TTS_URL?.trim().replace(/\/+$/, '')
    const token = process.env.HAPI_VOICE_TTS_TOKEN?.trim()
    return url && token ? { url, token } : null
}

export function speakerServiceConfigured(): boolean {
    return speakerConfig() !== null
}

/** 一段 16 kHz s16le 单声道 PCM 的声纹；服务不可用时返回 null（调用方按“无法判断”处理）。 */
export async function embedSpeaker(pcm: Uint8Array, fetchImpl: typeof fetch = fetch): Promise<number[] | null> {
    const config = speakerConfig()
    if (!config) return null
    try {
        const response = await fetchImpl(`${config.url}/speaker/embed`, {
            method: 'POST',
            headers: { 'content-type': 'application/octet-stream', 'X-Voice-Token': config.token },
            body: pcm,
            signal: AbortSignal.timeout(EMBED_TIMEOUT_MS)
        })
        if (!response.ok) return null
        const body = await response.json() as { embedding?: unknown }
        return Array.isArray(body.embedding) && body.embedding.length > 0 && body.embedding.every((x) => typeof x === 'number')
            ? body.embedding as number[]
            : null
    } catch {
        return null
    }
}

export function cosine(a: number[], b: number[]): number {
    let dot = 0, na = 0, nb = 0
    for (let i = 0; i < a.length && i < b.length; i += 1) {
        dot += a[i]! * b[i]!
        na += a[i]! * a[i]!
        nb += b[i]! * b[i]!
    }
    return na > 0 && nb > 0 ? dot / Math.sqrt(na * nb) : 0
}

/** 与本人声纹的相似度：取与各条录入向量的最高值。 */
export function speakerScore(embedding: number[], voiceprint: Voiceprint): number {
    return voiceprint.vectors.reduce((best, vector) => Math.max(best, cosine(embedding, vector)), -1)
}

export class VoiceprintStore {
    private readonly path: string
    private readonly ownerPath: string
    private readonly gatePath: string
    private cache: StoreFile | null = null
    private readonly recent = new Map<number, SpeakerGateRecord[]>()

    constructor(dataDir: string) {
        this.path = join(dataDir, 'voice-voiceprints.json')
        this.ownerPath = join(dataDir, 'voice-owner-voiceprints.json')
        this.gatePath = join(dataDir, 'voice-speaker-gate.json')
    }

    private load(): StoreFile {
        if (this.cache) return this.cache
        try {
            const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as StoreFile
            this.cache = parsed?.accounts ? parsed : { version: 1, accounts: {} }
        } catch {
            this.cache = { version: 1, accounts: {} }
        }
        return this.cache
    }

    private save(data: StoreFile): void {
        const tmp = `${this.path}.tmp`
        writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 })
        renameSync(tmp, this.path)
        this.cache = data
    }

    /** 录音助手导出的“本人”声纹（只给管理员账号兜底用）。 */
    private ownerVoiceprint(): Voiceprint | null {
        if (!existsSync(this.ownerPath)) return null
        try {
            const parsed = JSON.parse(readFileSync(this.ownerPath, 'utf8')) as { items?: Array<{ vectors?: number[][] }>; extractedAt?: string }
            const vectors = (parsed.items ?? []).flatMap((item) => item.vectors ?? []).map(unit)
            return vectors.length > 0 ? { vectors, source: 'recording-helper owner voiceprint', updatedAt: parsed.extractedAt ?? '' } : null
        } catch {
            return null
        }
    }

    get(accountId: number, isAdmin: boolean): Voiceprint | null {
        return this.load().accounts[String(accountId)] ?? (isAdmin ? this.ownerVoiceprint() : null)
    }

    /** 这个账号是否在 hapi 里自己录过（区别于管理员的录音助手兜底）。 */
    hasOwn(accountId: number): boolean {
        return Boolean(this.load().accounts[String(accountId)])
    }

    /** 追加一次录入的质心（只保留最近 MAX_VECTORS 次）。 */
    add(accountId: number, vectors: number[][], source: string): Voiceprint {
        const data = this.load()
        const current = data.accounts[String(accountId)]
        const next: Voiceprint = {
            vectors: [...(current?.vectors ?? []), ...vectors.map(unit)].slice(-MAX_VECTORS),
            source,
            updatedAt: new Date().toISOString()
        }
        this.save({ ...data, accounts: { ...data.accounts, [String(accountId)]: next } })
        return next
    }

    gateConfig(): SpeakerGateConfig {
        const envMode = process.env.HAPI_VOICE_SPEAKER_GATE?.trim()
        const envThreshold = Number(process.env.HAPI_VOICE_SPEAKER_THRESHOLD)
        let mode: SpeakerGateMode = envMode === 'off' || envMode === 'enforce' ? envMode : 'observe'
        let threshold = Number.isFinite(envThreshold) && envThreshold > 0 && envThreshold < 1 ? envThreshold : DEFAULT_SPEAKER_THRESHOLD
        try {
            const file = JSON.parse(readFileSync(this.gatePath, 'utf8')) as { mode?: unknown; threshold?: unknown }
            if (file.mode === 'off' || file.mode === 'observe' || file.mode === 'enforce') mode = file.mode
            if (typeof file.threshold === 'number' && file.threshold > 0 && file.threshold < 1) threshold = file.threshold
        } catch { /* no override file */ }
        return { mode, threshold }
    }

    recordDecision(accountId: number, record: SpeakerGateRecord): void {
        const list = this.recent.get(accountId) ?? []
        list.push(record)
        if (list.length > RECENT_DECISIONS) list.splice(0, list.length - RECENT_DECISIONS)
        this.recent.set(accountId, list)
    }

    recentDecisions(accountId: number): SpeakerGateRecord[] {
        return [...(this.recent.get(accountId) ?? [])]
    }

    clear(accountId: number): void {
        const data = this.load()
        const accounts = { ...data.accounts }
        delete accounts[String(accountId)]
        this.save({ ...data, accounts })
    }
}

export function unit(vector: number[]): number[] {
    const norm = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0))
    return norm > 0 ? vector.map((x) => x / norm) : vector
}

const BYTES_PER_SECOND = 32_000
const FRAME_BYTES = 960 // 30 ms
export const ENROLL_MIN_VOICED_SECONDS = 4
const ENROLL_WINDOW_SECONDS = 3
const ENROLL_HOP_SECONDS = 2
const ENROLL_MAX_WINDOWS = 12
/** Mean similarity between the windows of one recording; far below this means noise or several voices took turns. */
export const ENROLL_MIN_CONSISTENCY = 0.3

/** 去掉静音：按 30 ms 帧算能量，只保留明显高于底噪的帧。 */
export function voicedPcm(pcm: Uint8Array): Uint8Array {
    const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength)
    const frames: Array<{ offset: number; rms: number }> = []
    for (let offset = 0; offset + FRAME_BYTES <= pcm.byteLength; offset += FRAME_BYTES) {
        let sum = 0
        for (let i = 0; i < FRAME_BYTES; i += 2) {
            const sample = view.getInt16(offset + i, true)
            sum += sample * sample
        }
        frames.push({ offset, rms: Math.sqrt(sum / (FRAME_BYTES / 2)) })
    }
    if (frames.length === 0) return new Uint8Array(0)
    const sorted = frames.map((frame) => frame.rms).sort((a, b) => a - b)
    const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0
    const floor = Math.max(200, p95 * 0.15)
    const kept = frames.filter((frame) => frame.rms >= floor)
    const out = new Uint8Array(kept.length * FRAME_BYTES)
    kept.forEach((frame, index) => out.set(pcm.subarray(frame.offset, frame.offset + FRAME_BYTES), index * FRAME_BYTES))
    return out
}

export type EnrollmentResult =
    | { ok: true; centroid: number[]; voicedSeconds: number; windows: number; consistency: number }
    | { ok: false; reason: 'too-little-speech' | 'service-unavailable' | 'inconsistent'; voicedSeconds: number; consistency?: number }

/** 一段录音 → 若干 3 秒窗口的声纹 → 质心；同时检查窗口之间是否像同一个人。 */
export async function buildEnrollment(pcm: Uint8Array, embed: (pcm: Uint8Array) => Promise<number[] | null> = embedSpeaker): Promise<EnrollmentResult> {
    const voiced = voicedPcm(pcm)
    const voicedSeconds = Math.round(voiced.byteLength / BYTES_PER_SECOND * 10) / 10
    if (voicedSeconds < ENROLL_MIN_VOICED_SECONDS) return { ok: false, reason: 'too-little-speech', voicedSeconds }
    const windowBytes = ENROLL_WINDOW_SECONDS * BYTES_PER_SECOND
    const hopBytes = ENROLL_HOP_SECONDS * BYTES_PER_SECOND
    const embeddings: number[][] = []
    for (let offset = 0; offset + windowBytes <= voiced.byteLength && embeddings.length < ENROLL_MAX_WINDOWS; offset += hopBytes) {
        const embedding = await embed(voiced.subarray(offset, offset + windowBytes))
        if (!embedding) return { ok: false, reason: 'service-unavailable', voicedSeconds }
        embeddings.push(unit(embedding))
    }
    const centroid = unit(embeddings[0]!.map((_, i) => embeddings.reduce((sum, vector) => sum + vector[i]!, 0)))
    let pairSum = 0
    let pairs = 0
    for (let a = 0; a < embeddings.length; a += 1) {
        for (let b = a + 1; b < embeddings.length; b += 1) {
            pairSum += cosine(embeddings[a]!, embeddings[b]!)
            pairs += 1
        }
    }
    const consistency = pairs > 0 ? Math.round(pairSum / pairs * 1000) / 1000 : 1
    if (consistency < ENROLL_MIN_CONSISTENCY) return { ok: false, reason: 'inconsistent', voicedSeconds, consistency }
    return { ok: true, centroid, voicedSeconds, windows: embeddings.length, consistency }
}

let store: VoiceprintStore | null = null

export function initVoiceprintStore(dataDir: string): VoiceprintStore {
    store = new VoiceprintStore(dataDir)
    return store
}

export function getVoiceprintStore(): VoiceprintStore | null {
    return store
}
