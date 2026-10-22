/**
 * 语音合成中继（VoxCPM 多声线）：hub 把文字与所选声线（曼波 + 明日方舟 11 位干员）转给常驻在
 * TXFA608 上的 VoxCPM 服务（经 chisel 反向隧道暴露在 ECS 回环口），原样把流式 PCM 转回浏览器。
 * 服务的 token 只在 hub 环境变量里，不下发。
 *
 *   HAPI_VOICE_TTS_URL    例如 http://127.0.0.1:13019
 *   HAPI_VOICE_TTS_TOKEN  服务端 /opt/gptsovits/manbo_token 的内容
 *
 * 不可用（没配、笔记本关机、隧道断）时 status 报 available:false，网页回落到百炼自带音色。
 */

export type VoiceTtsOption = {
    id: string
    name: string
    subtitle?: string
}

export const DEFAULT_VOICE_TTS_ID = 'manbo'

export const VOXCPM_VOICE_CATALOG: readonly VoiceTtsOption[] = [
    { id: 'manbo', name: '曼波', subtitle: '默认旁白声线' },
    { id: 'nian', name: '年', subtitle: '明日方舟 · 重装（CV 杨鸥）' },
    { id: 'dusk', name: '夕', subtitle: '明日方舟 · 术师（CV 空无的念）' },
    { id: 'almond', name: '杏仁', subtitle: '明日方舟 · 特种（CV 二娇）' },
    { id: 'skadi2', name: '浊心斯卡蒂', subtitle: '明日方舟 · 辅助（CV 张琦）' },
    { id: 'aglina', name: '安洁莉娜', subtitle: '明日方舟 · 辅助（CV 何雨薇）' },
    { id: 'surtr', name: '史尔特尔', subtitle: '明日方舟 · 近卫（CV 云鹤追）' },
    { id: 'helage', name: '赫拉格', subtitle: '明日方舟 · 近卫（CV 刘若班）' },
    { id: 'mizuki', name: '水月', subtitle: '明日方舟 · 特种（CV 绿绮）' },
    { id: 'kalts', name: '凯尔希', subtitle: '明日方舟 · 医疗（CV 刘雪）' },
    { id: 'amiya', name: '阿米娅', subtitle: '明日方舟 · 术师（CV 陶典）' },
    { id: 'closur', name: '可露希尔', subtitle: '明日方舟 · 辅助（CV 侯小菲）' },
]

export type VoiceTtsStatus = {
    available: boolean
    voice: string | null
    voices?: VoiceTtsOption[]
    engine?: string | null
    sampleRate: number | null
    reason?: string
}

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
        const body = await response.json() as {
            ok?: boolean
            voice?: string
            voices?: VoiceTtsOption[]
            engine?: string
            sampleRate?: number
        }
        status = response.ok && body.ok
            ? {
                available: true,
                voice: body.voice ?? DEFAULT_VOICE_TTS_ID,
                sampleRate: body.sampleRate ?? null,
                ...(Array.isArray(body.voices) ? { voices: body.voices } : {}),
                ...(body.engine ? { engine: body.engine } : {}),
            }
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
export async function proxyVoiceTts(
    text: string,
    clientSignal?: AbortSignal,
    fetchImpl: typeof fetch = fetch,
    voice?: string | null
): Promise<Response> {
    const config = ttsConfig()
    if (!config) return Response.json({ error: 'Voice TTS not configured' }, { status: 503 })
    const trimmed = text.trim().slice(0, MAX_TEXT_CHARS)
    if (!trimmed) return Response.json({ error: 'empty text' }, { status: 400 })
    const trimmedVoice = voice?.trim() || undefined
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('voice service did not answer in time')), FIRST_BYTE_TIMEOUT_MS)
    clientSignal?.addEventListener('abort', () => controller.abort(clientSignal.reason), { once: true })
    let upstream: Response
    try {
        upstream = await fetchImpl(`${config.url}/tts`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'X-Voice-Token': config.token },
            body: JSON.stringify(trimmedVoice ? { text: trimmed, voice: trimmedVoice } : { text: trimmed }),
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
            'x-audio-format': upstream.headers.get('x-audio-format') ?? 's16le',
            ...(upstream.headers.get('x-voice-id') ? { 'x-voice-id': upstream.headers.get('x-voice-id')! } : {}),
        }
    })
}
