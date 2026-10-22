import type { ApiClient } from '@/api/client'
import { readVoiceTtsCharacter } from './readerPreference'

/**
 * Speaks streamed reply text with the hub's VoxCPM voice service (曼波 + 明日方舟 11 位干员).
 *
 * Text arrives as deltas; complete sentences are synthesized one after another while earlier ones
 * play, so speech starts after the first sentence instead of the whole reply. Audio is raw s16le
 * PCM, scheduled back to back on the shared playback AudioContext. If the service fails, the rest
 * of the reply is spoken by the browser's own speech synthesis so the user still hears the answer.
 */

const SENTENCE_END = /[。！？!?；;\n]/
/** Long clauses without a full stop still get cut at a comma so the first audio is not delayed. */
const SOFT_BREAK = /[，,：:]/
/** Pending text this long without a full stop gets cut at its first comma... */
const SOFT_BREAK_MIN_CHARS = 24
/** ...as long as that leaves a fragment of at least this many characters. */
const SOFT_BREAK_MIN_PREFIX = 8
/**
 * Initial Web Audio lookahead cushion (280ms, ~3.5 x 80ms VoxCPM chunks) when starting a fresh
 * sentence or recovering from a network stall. Absorbs 250-300ms TCP tunnel arrival jitter so
 * playback never underruns mid-sentence.
 */
const INITIAL_JITTER_BUFFER_SEC = 0.28
/**
 * Short raised-cosine ramp (3ms) applied at the start of a fresh run or after an underrun so
 * resuming from silence never produces a hard step impulse ("popping / crackling mic").
 */
const DISCONTINUITY_FADE_SEC = 0.003

export class ManboSpeaker {
    private readonly api: ApiClient
    private readonly context: AudioContext
    private readonly onFallback?: (reason: string) => void
    private readonly voice?: string | null
    private pending = ''
    private readonly queue: string[] = []
    private working = false
    private abort: AbortController | null = null
    private sources = new Set<AudioBufferSourceNode>()
    private nextStartTime = 0
    private generation = 0
    private fallback = false
    /**
     * Rate to assume when the response does not expose `x-sample-rate` (cross-origin pages see
     * custom headers only if the hub lists them in Access-Control-Expose-Headers). Comes from the
     * status endpoint's JSON body, which is always readable.
     */
    private readonly defaultSampleRate: number

    constructor(
        api: ApiClient,
        context: AudioContext,
        onFallback?: (reason: string) => void,
        defaultSampleRate?: number | null,
        voice?: string | null
    ) {
        this.api = api
        this.context = context
        this.onFallback = onFallback
        this.defaultSampleRate = defaultSampleRate && defaultSampleRate > 0 ? defaultSampleRate : 32000
        this.voice = voice
    }

    /** Add reply text; whole sentences are queued for speaking. */
    push(delta: string): void {
        this.pending += delta
        for (;;) {
            const hard = this.pending.search(SENTENCE_END)
            let cut = hard >= 0 ? hard + 1 : -1
            if (cut < 0 && this.pending.length >= SOFT_BREAK_MIN_CHARS) {
                const soft = this.pending.slice(SOFT_BREAK_MIN_PREFIX).search(SOFT_BREAK)
                if (soft >= 0) cut = SOFT_BREAK_MIN_PREFIX + soft + 1
            }
            if (cut < 0) break
            this.enqueue(this.pending.slice(0, cut))
            this.pending = this.pending.slice(cut)
        }
    }

    /** The reply is complete: speak whatever is left. */
    flush(): void {
        const rest = this.pending
        this.pending = ''
        this.enqueue(rest)
    }

    /** Barge-in or session end: stop speaking and drop everything queued. */
    stop(): void {
        this.generation += 1
        // The old drain loop sees the new generation and exits on its own; the next reply starts a fresh one.
        this.working = false
        this.pending = ''
        this.queue.length = 0
        this.abort?.abort()
        this.abort = null
        for (const source of this.sources) {
            try { source.stop() } catch { /* already stopped */ }
        }
        this.sources.clear()
        this.nextStartTime = 0
        if (typeof window !== 'undefined' && window.speechSynthesis) window.speechSynthesis.cancel()
    }

    isSpeaking(): boolean {
        return this.working || this.queue.length > 0 || this.sources.size > 0
            || (typeof window !== 'undefined' && !!window.speechSynthesis?.speaking)
    }

    private enqueue(text: string): void {
        const clean = text.trim()
        if (!/[\p{L}\p{N}]/u.test(clean)) return
        this.queue.push(clean)
        if (!this.working) void this.drain()
    }

    private async drain(): Promise<void> {
        this.working = true
        const generation = this.generation
        try {
            while (this.queue.length > 0 && generation === this.generation) {
                const sentence = this.queue.shift()!
                if (this.fallback) {
                    this.speakWithBrowser(sentence)
                    continue
                }
                try {
                    await this.synthesize(sentence, generation)
                } catch (error) {
                    if (generation !== this.generation) return
                    this.fallback = true
                    this.onFallback?.(error instanceof Error ? error.message : String(error))
                    this.speakWithBrowser(sentence)
                }
            }
        } finally {
            if (generation === this.generation) this.working = false
        }
    }

    private async synthesize(sentence: string, generation: number): Promise<void> {
        this.abort = new AbortController()
        const selectedVoice = this.voice ?? readVoiceTtsCharacter()
        const response = await this.api.openVoiceTtsStream(sentence, this.abort.signal, selectedVoice)
        const sampleRate = Number(response.headers.get('x-sample-rate')) || this.defaultSampleRate
        const reader = response.body!.getReader()
        let carry: Uint8Array | null = null
        for (;;) {
            const { done, value } = await reader.read()
            if (done || generation !== this.generation) break
            let bytes = value
            if (carry) {
                const joined = new Uint8Array(carry.length + bytes.length)
                joined.set(carry)
                joined.set(bytes, carry.length)
                bytes = joined
                carry = null
            }
            const usable = bytes.length - (bytes.length % 2)
            if (usable < bytes.length) carry = bytes.slice(usable)
            if (usable > 0) this.play(bytes.subarray(0, usable), sampleRate)
        }
    }

    private play(pcm: Uint8Array, sampleRate: number): void {
        const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength)
        const frames = pcm.byteLength / 2
        const buffer = this.context.createBuffer(1, frames, sampleRate)
        const channel = buffer.getChannelData(0)
        for (let i = 0; i < frames; i += 1) channel[i] = view.getInt16(i * 2, true) / 32768
        const isDiscontinuous = this.nextStartTime <= this.context.currentTime
        if (isDiscontinuous && frames >= 16) {
            const fadeFrames = Math.min(Math.floor(sampleRate * DISCONTINUITY_FADE_SEC), Math.floor(frames / 4))
            for (let i = 0; i < fadeFrames; i += 1) {
                channel[i] = channel[i]! * 0.5 * (1 - Math.cos((Math.PI * i) / fadeFrames))
            }
        }
        const source = this.context.createBufferSource()
        source.buffer = buffer
        source.connect(this.context.destination)
        const startAt = isDiscontinuous
            ? this.context.currentTime + INITIAL_JITTER_BUFFER_SEC
            : Math.max(this.context.currentTime + 0.005, this.nextStartTime)
        source.start(startAt)
        this.nextStartTime = startAt + buffer.duration
        this.sources.add(source)
        source.onended = () => { this.sources.delete(source) }
    }

    private speakWithBrowser(sentence: string): void {
        if (typeof window === 'undefined' || !window.speechSynthesis) return
        const utterance = new SpeechSynthesisUtterance(sentence)
        utterance.lang = /[一-鿿]/.test(sentence) ? 'zh-CN' : 'en-US'
        window.speechSynthesis.speak(utterance)
    }
}
