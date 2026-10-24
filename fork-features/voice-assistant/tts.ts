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
    { id: 'wisadel', name: '维什戴尔', subtitle: '明日方舟 · 狙击（CV 阮从青）' },
    { id: 'mlynar', name: '玛恩纳', subtitle: '明日方舟 · 近卫（CV 王宇航）' },
    { id: 'silverash', name: '银灰', subtitle: '明日方舟 · 近卫（CV 吴磊）' },
    { id: 'eyjafjalla', name: '艾雅法拉', subtitle: '明日方舟 · 术师（CV 降温）' },
    { id: 'exusiai', name: '能天使', subtitle: '明日方舟 · 狙击（CV 蔡书瑾）' },
    { id: 'texas2', name: '缄默德克萨斯', subtitle: '明日方舟 · 特种（CV 杨梦露）' },
    { id: 'lappland', name: '拉普兰德', subtitle: '明日方舟 · 近卫（CV 陈彦亦）' },
    { id: 'mudrock', name: '泥岩', subtitle: '明日方舟 · 重装（CV 忙音）' },
    { id: 'saria', name: '塞雷娅', subtitle: '明日方舟 · 重装（CV 陈彦亦）' },
    { id: 'ines', name: '伊内丝', subtitle: '明日方舟 · 先锋（CV 张若瑜）' },
    { id: 'logos', name: '逻各斯', subtitle: '明日方舟 · 术师（CV 梁达伟）' },
    { id: 'shu', name: '黍', subtitle: '明日方舟 · 重装（CV 徐晨）' },
    { id: 'ling', name: '令', subtitle: '明日方舟 · 辅助（CV 余珊）' },
    { id: 'chongyue', name: '重岳', subtitle: '明日方舟 · 近卫（CV 赵岭）' },
    { id: 'muelsyse', name: '缪尔赛思', subtitle: '明日方舟 · 先锋（CV 王雅欣）' },
    { id: 'specter2', name: '归溟幽灵鲨', subtitle: '明日方舟 · 特种（CV 张安琪）' },
    { id: 'gladiia', name: '歌蕾蒂娅', subtitle: '明日方舟 · 特种（CV 黄莺）' },
    { id: 'ulpianus', name: '乌尔比安', subtitle: '明日方舟 · 近卫（CV 刘以嘉）' },
    { id: 'skadi', name: '斯卡蒂', subtitle: '明日方舟 · 近卫（CV 张琦）' },
    { id: 'nearl2', name: '耀骑士临光', subtitle: '明日方舟 · 近卫（CV 穆雪婷）' },
    { id: 'bagpipe', name: '风笛', subtitle: '明日方舟 · 先锋（CV 沈玥）' },
    { id: 'chen', name: '陈', subtitle: '明日方舟 · 近卫（CV 虫虫）' },
    { id: 'chen2', name: '假日威龙陈', subtitle: '明日方舟 · 狙击（CV 虫虫）' },
    { id: 'hoshiguma', name: '星熊', subtitle: '明日方舟 · 重装（CV 陈雨）' },
    { id: 'blaze', name: '煌', subtitle: '明日方舟 · 近卫（CV 周童）' },
    { id: 'thorns', name: '棘刺', subtitle: '明日方舟 · 近卫（CV 徐翔）' },
    { id: 'mountain', name: '山', subtitle: '明日方舟 · 近卫（CV 王西瓜）' },
    { id: 'degenbrecher', name: '锏', subtitle: '明日方舟 · 近卫（CV 吴迪）' },
    { id: 'virtuosa', name: '塑心', subtitle: '明日方舟 · 辅助（CV 曾彤）' },
    { id: 'viviana', name: '薇薇安娜', subtitle: '明日方舟 · 近卫（CV 秦紫翼）' },
    { id: 'typhon', name: '提丰', subtitle: '明日方舟 · 狙击（CV 皛四白）' },
    { id: 'pozyomka', name: '鸿雪', subtitle: '明日方舟 · 狙击（CV 云鹤追）' },
    { id: 'goldenglow', name: '澄闪', subtitle: '明日方舟 · 术师（CV 白灯）' },
    { id: 'irene', name: '艾丽妮', subtitle: '明日方舟 · 近卫（CV 刘雯）' },
    { id: 'lumen', name: '流明', subtitle: '明日方舟 · 医疗（CV 孙晔）' },
    { id: 'mostima', name: '莫斯提马', subtitle: '明日方舟 · 术师（CV 若舞）' },
    { id: 'fiammetta', name: '菲亚梅塔', subtitle: '明日方舟 · 狙击（CV 许潇文）' },
    { id: 'suzuran', name: '铃兰', subtitle: '明日方舟 · 辅助（CV 皛四白）' },
    { id: 'nightingale', name: '夜莺', subtitle: '明日方舟 · 医疗（CV 时音）' },
    { id: 'shining', name: '闪灵', subtitle: '明日方舟 · 医疗（CV 琦雯）' },
    { id: 'warfarin', name: '华法琳', subtitle: '明日方舟 · 医疗（CV 格林）' },
    { id: 'ptilopsis', name: '白面鸮', subtitle: '明日方舟 · 医疗（CV 龟娘）' },
    { id: 'kroos2', name: '寒芒克洛丝', subtitle: '明日方舟 · 狙击（CV 苏婉）' },
    { id: 'myrtle', name: '桃金娘', subtitle: '明日方舟 · 先锋（CV 降温）' },
    { id: 'perlica', name: '佩丽卡', subtitle: '明日方舟：终末地 · 术师（CV 陈婷婷）' },
    { id: 'chen_qy', name: '陈千语', subtitle: '明日方舟：终末地 · 近卫（CV 官方配音）' },
    { id: 'yvonne', name: '伊冯', subtitle: '明日方舟：终末地 · 辅助（CV 官方配音）' },
    { id: 'laevatain', name: '莱万汀', subtitle: '明日方舟：终末地 · 近卫（CV 官方配音）' },
    { id: 'ember', name: '余烬', subtitle: '明日方舟：终末地 · 重装（CV 官方配音）' },
    { id: 'gilberta', name: '洁尔佩塔', subtitle: '明日方舟：终末地 · 辅助（CV 官方配音）' },
    { id: 'furina', name: '芙宁娜', subtitle: '原神 · 水（CV 钱琛）' },
    { id: 'nahida', name: '纳西妲', subtitle: '原神 · 草（CV 花玲）' },
    { id: 'raiden', name: '雷电将军', subtitle: '原神 · 雷（CV 菊花花）' },
    { id: 'zhongli', name: '钟离', subtitle: '原神 · 岩（CV 彭博）' },
    { id: 'neuvillette', name: '那维莱特', subtitle: '原神 · 水（CV 桑毓泽）' },
    { id: 'hutao', name: '胡桃', subtitle: '原神 · 火（CV 陶典）' },
    { id: 'mavuika', name: '玛薇卡', subtitle: '原神 · 火（CV 李晔）' },
    { id: 'citlali', name: '茜特菈莉', subtitle: '原神 · 冰（CV 柳知萧）' },
    { id: 'arlecchino', name: '阿蕾奇诺', subtitle: '原神 · 火（CV 黄莺）' },
    { id: 'ayaka', name: '神里绫华', subtitle: '原神 · 冰（CV 小N）' },
    { id: 'kazuha', name: '枫原万叶', subtitle: '原神 · 风（CV 斑马）' },
    { id: 'wanderer', name: '流浪者', subtitle: '原神 · 风（CV 鹿喑）' },
    { id: 'yaemiko', name: '八重神子', subtitle: '原神 · 雷（CV 杜冥鸦）' },
    { id: 'ganyu', name: '甘雨', subtitle: '原神 · 冰（CV 林簌）' },
    { id: 'venti', name: '温迪', subtitle: '原神 · 风（CV 喵酱）' },
    { id: 'navia', name: '娜维娅', subtitle: '原神 · 岩（CV 小敢）' },
    { id: 'firefly', name: '流萤', subtitle: '崩坏：星穹铁道 · 火（CV 宋媛媛&淦子齐）' },
    { id: 'kafka', name: '卡芙卡', subtitle: '崩坏：星穹铁道 · 雷（CV 徐慧）' },
    { id: 'acheron', name: '黄泉', subtitle: '崩坏：星穹铁道 · 雷（CV 菊花花）' },
    { id: 'robin', name: '知更鸟', subtitle: '崩坏：星穹铁道 · 物理（CV 钱琛 / 歌：Chevy）' },
    { id: 'sunday', name: '星期日', subtitle: '崩坏：星穹铁道 · 虚数（CV 徐翔）' },
    { id: 'feixiao', name: '飞霄', subtitle: '崩坏：星穹铁道 · 风（CV 叶知秋）' },
    { id: 'aventurine', name: '砂金', subtitle: '崩坏：星穹铁道 · 虚数（CV 杨超然）' },
    { id: 'sparkle', name: '花火', subtitle: '崩坏：星穹铁道 · 量子（CV 赵爽）' },
    { id: 'jingliu', name: '镜流', subtitle: '崩坏：星穹铁道 · 冰（CV 杜冥鸦）' },
    { id: 'jingyuan', name: '景元', subtitle: '崩坏：星穹铁道 · 雷（CV 孙晔）' },
    { id: 'the_herta', name: '大黑塔', subtitle: '崩坏：星穹铁道 · 冰（CV 侯小菲）' },
    { id: 'castorice', name: '遐蝶', subtitle: '崩坏：星穹铁道 · 量子（CV 阮从青）' },
    { id: 'march7th', name: '三月七', subtitle: '崩坏：星穹铁道 · 冰（CV 诺亚）' },
    { id: 'silverwolf', name: '银狼', subtitle: '崩坏：星穹铁道 · 量子（CV Hanser）' },
    { id: 'sunchang', name: '上海地铁 · 孙畅', subtitle: '上海轨道交通 · 经典报站（CV 孙畅）' },
    { id: 'jinlei', name: '上海地铁 · 金蕾', subtitle: '上海轨道交通 · 经典报站（CV 金蕾）' },
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
