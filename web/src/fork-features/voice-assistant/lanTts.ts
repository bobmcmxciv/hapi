import type { VoiceTtsLanAccess, VoiceTtsStatus } from './types'

/**
 * LAN-first voice synthesis. Inside the home LAN the browser talks to the voice
 * engine directly; anywhere else the engine is unreachable and synthesis keeps
 * going through the hub relay (ECS). Reachability is probed, never assumed.
 */
const PROBE_TIMEOUT_MS = 1_500
const PROBE_TTL_MS = 60_000
const TICKET_MARGIN_MS = 60_000

export class VoiceTtsLanRouter {
    #access: VoiceTtsLanAccess | null = null
    #reachable: { url: string; ok: boolean; at: number } | null = null
    #probe: Promise<boolean> | null = null

    constructor(
        private readonly loadStatus: () => Promise<VoiceTtsStatus>,
        private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
        private readonly now: () => number = Date.now
    ) {}

    /** Called with every status response; also warms the probe so the first sentence does not pay for it. */
    remember(status: VoiceTtsStatus): void {
        this.#access = status.lan ?? null
        if (this.#access) void this.#isReachable(this.#access.url)
    }

    /** Direct engine response, or null when the caller should use the hub relay. */
    async open(body: string, signal?: AbortSignal): Promise<Response | null> {
        const access = await this.#currentAccess()
        if (!access || !(await this.#isReachable(access.url))) return null
        try {
            const response = await this.fetchImpl(`${access.url}/tts`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'x-voice-ticket': access.ticket },
                body,
                signal,
            })
            if (response.ok && response.body) return response
            // Rejected ticket or engine error: let the hub path decide; refresh the ticket next time.
            if (response.status === 401) this.#access = null
            return null
        } catch (error) {
            if (signal?.aborted) throw error
            this.#reachable = { url: access.url, ok: false, at: this.now() }
            return null
        }
    }

    async #currentAccess(): Promise<VoiceTtsLanAccess | null> {
        if (this.#access && this.#access.expiresAt - TICKET_MARGIN_MS > this.now()) return this.#access
        try {
            const status = await this.loadStatus()
            this.#access = status.lan ?? null
        } catch {
            this.#access = null
        }
        return this.#access
    }

    #isReachable(url: string): Promise<boolean> {
        const known = this.#reachable
        if (known && known.url === url && this.now() - known.at < PROBE_TTL_MS) return Promise.resolve(known.ok)
        this.#probe ??= this.fetchImpl(`${url}/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
            .then(response => response.ok, () => false)
            .then(ok => {
                this.#reachable = { url, ok, at: this.now() }
                return ok
            })
            .finally(() => { this.#probe = null })
        return this.#probe
    }
}
