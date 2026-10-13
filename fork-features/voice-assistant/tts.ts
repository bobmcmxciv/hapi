/**
 * 曼波朗读：hub 把文字转给常驻在 TXFA608 上的 GPT-SoVITS 服务（经 chisel 反向隧道暴露在
 * ECS 回环口），原样把流式 PCM 转回浏览器。服务的 token 只在 hub 环境变量里，不下发。
 *
 *   HAPI_VOICE_TTS_URL    例如 http://127.0.0.1:13019
 *   HAPI_VOICE_TTS_TOKEN  服务端 /opt/gptsovits/manbo_token 的内容
 *
 * 不可用（没配、笔记本关机、隧道断）时 status 报 available:false，网页回落到百炼自带音色。
 */

export type VoiceTtsStatus = { available: boolean; voice: string | null; sampleRate: number | null; reason?: string }

const STATUS_TTL_MS = 15_000
const HEALTH_TIMEOUT_MS = 2_500
const FIRST_BYTE_TIMEOUT_MS = 8_000
const MAX_TEXT_CHARS = 600

type TtsConfig = { url: string; token: string }

function ttsConfig(): TtsConfig | null {
    const url = process.env.HAPI_VOICE_TTS_URL?.trim().replace(/\/+$/, '')
    const token = process.env.HAPI_VOICE_TTS_TOKEN?.trim()
    return url && token ? { url, token } : null
}

let cached: { at: number; status: VoiceTtsStatus } | null = null

export async function getVoiceTtsStatus(fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<VoiceTtsStatus> {
    const config = ttsConfig()
    if (!config) return { available: false, voice: null, sampleRate: null, reason: 'not configured' }
    if (cached && now - cached.at < STATUS_TTL_MS) return cached.status
    let status: VoiceTtsStatus
    try {
        const response = await fetchImpl(`${config.url}/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) })
        const body = await response.json() as { ok?: boolean; voice?: string; sampleRate?: number }
        status = response.ok && body.ok
            ? { available: true, voice: body.voice ?? 'manbo', sampleRate: body.sampleRate ?? null }
            : { available: false, voice: null, sampleRate: null, reason: `health ${response.status}` }
    } catch (error) {
        status = { available: false, voice: null, sampleRate: null, reason: error instanceof Error ? error.message : String(error) }
    }
    cached = { at: now, status }
    return status
}

/**
 * 把一段文字交给语音服务，返回可直接回给浏览器的流式响应。超时只管到响应头为止（长句的
 * 音频流可以比它长）；浏览器断开时一并取消上游，GPU 不白跑。
 */
export async function proxyVoiceTts(text: string, clientSignal?: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<Response> {
    const config = ttsConfig()
    if (!config) return Response.json({ error: 'Voice TTS not configured' }, { status: 503 })
    const trimmed = text.trim().slice(0, MAX_TEXT_CHARS)
    if (!trimmed) return Response.json({ error: 'empty text' }, { status: 400 })
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('voice service did not answer in time')), FIRST_BYTE_TIMEOUT_MS)
    clientSignal?.addEventListener('abort', () => controller.abort(clientSignal.reason), { once: true })
    let upstream: Response
    try {
        upstream = await fetchImpl(`${config.url}/tts`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'X-Voice-Token': config.token },
            body: JSON.stringify({ text: trimmed }),
            signal: controller.signal
        })
    } catch (error) {
        cached = null
        return Response.json({ error: `voice service unreachable: ${error instanceof Error ? error.message : String(error)}` }, { status: 502 })
    } finally {
        clearTimeout(timer)
    }
    if (!upstream.ok || !upstream.body) {
        cached = null
        return Response.json({ error: `voice service HTTP ${upstream.status}` }, { status: 502 })
    }
    return new Response(upstream.body, {
        status: 200,
        headers: {
            'content-type': 'application/octet-stream',
            'cache-control': 'no-store',
            'x-sample-rate': upstream.headers.get('x-sample-rate') ?? '32000',
            'x-audio-format': upstream.headers.get('x-audio-format') ?? 's16le'
        }
    })
}
