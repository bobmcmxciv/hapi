import type { ApiClient } from '@/api/client'

/**
 * Speaks streamed reply text with the hub's voice service (曼波).
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

export class ManboSpeaker {
    private readonly api: ApiClient
    private readonly context: AudioContext
    private readonly onFallback?: (reason: string) => void
    private pending = ''
    private readonly queue: string[] = []
    private working = false
    private abort: AbortController | null = null
    private sources = new Set<AudioBufferSourceNode>()
    private nextStartTime = 0
    private generation = 0
    private fallback = false

    constructor(api: ApiClient, context: AudioContext, onFallback?: (reason: string) => void) {
        this.api = api
        this.context = context
        this.onFallback = onFallback
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
        const response = await this.api.openVoiceTtsStream(sentence, this.abort.signal)
        const sampleRate = Number(response.headers.get('x-sample-rate')) || 32000
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
        const source = this.context.createBufferSource()
        source.buffer = buffer
        source.connect(this.context.destination)
        const startAt = Math.max(this.context.currentTime + 0.02, this.nextStartTime)
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
