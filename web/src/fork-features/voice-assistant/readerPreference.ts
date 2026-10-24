import { useSyncExternalStore } from 'react'

/**
 * Who speaks the assistant's replies. `manbo` (default) uses the hub's own VoxCPM voice service
 * (supporting Manbo + 11 Arknights operators) when it is reachable and falls back to the realtime
 * model's built-in voice when it is not; `builtin` always uses the realtime model's voice.
 */
export type VoiceReader = 'manbo' | 'builtin'

export type VoxcpmVoiceOption = {
    id: string
    name: string
    enName: string
    subtitle: string
    group: string
}

export const DEFAULT_VOXCPM_VOICE_ID = 'manbo'

export const VOXCPM_VOICE_OPTIONS: readonly VoxcpmVoiceOption[] = [
    { id: 'manbo', name: '曼波', enName: 'Manbo', subtitle: '默认旁白声线', group: '默认旁白' },
    { id: 'nian', name: '年', enName: "Nian", subtitle: '明日方舟 · 重装（CV 杨鸥）', group: '明日方舟（55）' },
    { id: 'dusk', name: '夕', enName: "Dusk", subtitle: '明日方舟 · 术师（CV 空无的念）', group: '明日方舟（55）' },
    { id: 'almond', name: '杏仁', enName: "Almond", subtitle: '明日方舟 · 特种（CV 二娇）', group: '明日方舟（55）' },
    { id: 'skadi2', name: '浊心斯卡蒂', enName: "Skadi the Corrupting Heart", subtitle: '明日方舟 · 辅助（CV 张琦）', group: '明日方舟（55）' },
    { id: 'aglina', name: '安洁莉娜', enName: "Angelina", subtitle: '明日方舟 · 辅助（CV 何雨薇）', group: '明日方舟（55）' },
    { id: 'surtr', name: '史尔特尔', enName: "Surtr", subtitle: '明日方舟 · 近卫（CV 云鹤追）', group: '明日方舟（55）' },
    { id: 'helage', name: '赫拉格', enName: "Hellagur", subtitle: '明日方舟 · 近卫（CV 刘若班）', group: '明日方舟（55）' },
    { id: 'mizuki', name: '水月', enName: "Mizuki", subtitle: '明日方舟 · 特种（CV 绿绮）', group: '明日方舟（55）' },
    { id: 'kalts', name: '凯尔希', enName: "Kal'tsit", subtitle: '明日方舟 · 医疗（CV 刘雪）', group: '明日方舟（55）' },
    { id: 'amiya', name: '阿米娅', enName: "Amiya", subtitle: '明日方舟 · 术师（CV 陶典）', group: '明日方舟（55）' },
    { id: 'closur', name: '可露希尔', enName: "Closure", subtitle: '明日方舟 · 辅助（CV 侯小菲）', group: '明日方舟（55）' },
    { id: 'wisadel', name: '维什戴尔', enName: "Wiš'adel", subtitle: '明日方舟 · 狙击（CV 阮从青）', group: '明日方舟（55）' },
    { id: 'mlynar', name: '玛恩纳', enName: "Młynar", subtitle: '明日方舟 · 近卫（CV 王宇航）', group: '明日方舟（55）' },
    { id: 'silverash', name: '银灰', enName: "SilverAsh", subtitle: '明日方舟 · 近卫（CV 吴磊）', group: '明日方舟（55）' },
    { id: 'eyjafjalla', name: '艾雅法拉', enName: "Eyjafjalla", subtitle: '明日方舟 · 术师（CV 降温）', group: '明日方舟（55）' },
    { id: 'exusiai', name: '能天使', enName: "Exusiai", subtitle: '明日方舟 · 狙击（CV 蔡书瑾）', group: '明日方舟（55）' },
    { id: 'texas2', name: '缄默德克萨斯', enName: "Texas the Omertosa", subtitle: '明日方舟 · 特种（CV 杨梦露）', group: '明日方舟（55）' },
    { id: 'lappland', name: '拉普兰德', enName: "Lappland", subtitle: '明日方舟 · 近卫（CV 陈彦亦）', group: '明日方舟（55）' },
    { id: 'mudrock', name: '泥岩', enName: "Mudrock", subtitle: '明日方舟 · 重装（CV 忙音）', group: '明日方舟（55）' },
    { id: 'saria', name: '塞雷娅', enName: "Saria", subtitle: '明日方舟 · 重装（CV 陈彦亦）', group: '明日方舟（55）' },
    { id: 'ines', name: '伊内丝', enName: "Ines", subtitle: '明日方舟 · 先锋（CV 张若瑜）', group: '明日方舟（55）' },
    { id: 'logos', name: '逻各斯', enName: "Logos", subtitle: '明日方舟 · 术师（CV 梁达伟）', group: '明日方舟（55）' },
    { id: 'shu', name: '黍', enName: "Shu", subtitle: '明日方舟 · 重装（CV 徐晨）', group: '明日方舟（55）' },
    { id: 'ling', name: '令', enName: "Ling", subtitle: '明日方舟 · 辅助（CV 余珊）', group: '明日方舟（55）' },
    { id: 'chongyue', name: '重岳', enName: "Chongyue", subtitle: '明日方舟 · 近卫（CV 赵岭）', group: '明日方舟（55）' },
    { id: 'muelsyse', name: '缪尔赛思', enName: "Muelsyse", subtitle: '明日方舟 · 先锋（CV 王雅欣）', group: '明日方舟（55）' },
    { id: 'specter2', name: '归溟幽灵鲨', enName: "Specter the Unchained", subtitle: '明日方舟 · 特种（CV 张安琪）', group: '明日方舟（55）' },
    { id: 'gladiia', name: '歌蕾蒂娅', enName: "Gladiia", subtitle: '明日方舟 · 特种（CV 黄莺）', group: '明日方舟（55）' },
    { id: 'ulpianus', name: '乌尔比安', enName: "Ulpianus", subtitle: '明日方舟 · 近卫（CV 刘以嘉）', group: '明日方舟（55）' },
    { id: 'skadi', name: '斯卡蒂', enName: "Skadi", subtitle: '明日方舟 · 近卫（CV 张琦）', group: '明日方舟（55）' },
    { id: 'nearl2', name: '耀骑士临光', enName: "Nearl the Radiant Knight", subtitle: '明日方舟 · 近卫（CV 穆雪婷）', group: '明日方舟（55）' },
    { id: 'bagpipe', name: '风笛', enName: "Bagpipe", subtitle: '明日方舟 · 先锋（CV 沈玥）', group: '明日方舟（55）' },
    { id: 'chen', name: '陈', enName: "Ch'en", subtitle: '明日方舟 · 近卫（CV 虫虫）', group: '明日方舟（55）' },
    { id: 'chen2', name: '假日威龙陈', enName: "Ch'en the Holungday", subtitle: '明日方舟 · 狙击（CV 虫虫）', group: '明日方舟（55）' },
    { id: 'hoshiguma', name: '星熊', enName: "Hoshiguma", subtitle: '明日方舟 · 重装（CV 陈雨）', group: '明日方舟（55）' },
    { id: 'blaze', name: '煌', enName: "Blaze", subtitle: '明日方舟 · 近卫（CV 周童）', group: '明日方舟（55）' },
    { id: 'thorns', name: '棘刺', enName: "Thorns", subtitle: '明日方舟 · 近卫（CV 徐翔）', group: '明日方舟（55）' },
    { id: 'mountain', name: '山', enName: "Mountain", subtitle: '明日方舟 · 近卫（CV 王西瓜）', group: '明日方舟（55）' },
    { id: 'degenbrecher', name: '锏', enName: "Degenbrecher", subtitle: '明日方舟 · 近卫（CV 吴迪）', group: '明日方舟（55）' },
    { id: 'virtuosa', name: '塑心', enName: "Virtuosa", subtitle: '明日方舟 · 辅助（CV 曾彤）', group: '明日方舟（55）' },
    { id: 'viviana', name: '薇薇安娜', enName: "Viviana", subtitle: '明日方舟 · 近卫（CV 秦紫翼）', group: '明日方舟（55）' },
    { id: 'typhon', name: '提丰', enName: "Typhon", subtitle: '明日方舟 · 狙击（CV 皛四白）', group: '明日方舟（55）' },
    { id: 'pozyomka', name: '鸿雪', enName: "Pozyomka", subtitle: '明日方舟 · 狙击（CV 云鹤追）', group: '明日方舟（55）' },
    { id: 'goldenglow', name: '澄闪', enName: "Goldenglow", subtitle: '明日方舟 · 术师（CV 白灯）', group: '明日方舟（55）' },
    { id: 'irene', name: '艾丽妮', enName: "Irene", subtitle: '明日方舟 · 近卫（CV 刘雯）', group: '明日方舟（55）' },
    { id: 'lumen', name: '流明', enName: "Lumen", subtitle: '明日方舟 · 医疗（CV 孙晔）', group: '明日方舟（55）' },
    { id: 'mostima', name: '莫斯提马', enName: "Mostima", subtitle: '明日方舟 · 术师（CV 若舞）', group: '明日方舟（55）' },
    { id: 'fiammetta', name: '菲亚梅塔', enName: "Fiammetta", subtitle: '明日方舟 · 狙击（CV 许潇文）', group: '明日方舟（55）' },
    { id: 'suzuran', name: '铃兰', enName: "Suzuran", subtitle: '明日方舟 · 辅助（CV 皛四白）', group: '明日方舟（55）' },
    { id: 'nightingale', name: '夜莺', enName: "Nightingale", subtitle: '明日方舟 · 医疗（CV 时音）', group: '明日方舟（55）' },
    { id: 'shining', name: '闪灵', enName: "Shining", subtitle: '明日方舟 · 医疗（CV 琦雯）', group: '明日方舟（55）' },
    { id: 'warfarin', name: '华法琳', enName: "Warfarin", subtitle: '明日方舟 · 医疗（CV 格林）', group: '明日方舟（55）' },
    { id: 'ptilopsis', name: '白面鸮', enName: "Ptilopsis", subtitle: '明日方舟 · 医疗（CV 龟娘）', group: '明日方舟（55）' },
    { id: 'kroos2', name: '寒芒克洛丝', enName: "Kroos the Keen Glint", subtitle: '明日方舟 · 狙击（CV 苏婉）', group: '明日方舟（55）' },
    { id: 'myrtle', name: '桃金娘', enName: "Myrtle", subtitle: '明日方舟 · 先锋（CV 降温）', group: '明日方舟（55）' },
    { id: 'perlica', name: '佩丽卡', enName: "Perlica", subtitle: '明日方舟：终末地 · 术师（CV 陈婷婷）', group: '明日方舟：终末地（6）' },
    { id: 'chen_qy', name: '陈千语', enName: "Chen Qianyu", subtitle: '明日方舟：终末地 · 近卫（CV 官方配音）', group: '明日方舟：终末地（6）' },
    { id: 'yvonne', name: '伊冯', enName: "Yvonne", subtitle: '明日方舟：终末地 · 辅助（CV 官方配音）', group: '明日方舟：终末地（6）' },
    { id: 'laevatain', name: '莱万汀', enName: "Laevatain", subtitle: '明日方舟：终末地 · 近卫（CV 官方配音）', group: '明日方舟：终末地（6）' },
    { id: 'ember', name: '余烬', enName: "Ember", subtitle: '明日方舟：终末地 · 重装（CV 官方配音）', group: '明日方舟：终末地（6）' },
    { id: 'gilberta', name: '洁尔佩塔', enName: "Gilberta", subtitle: '明日方舟：终末地 · 辅助（CV 官方配音）', group: '明日方舟：终末地（6）' },
    { id: 'furina', name: '芙宁娜', enName: "Furina", subtitle: '原神 · 水（CV 钱琛）', group: '米哈游 · 原神（16）' },
    { id: 'nahida', name: '纳西妲', enName: "Nahida", subtitle: '原神 · 草（CV 花玲）', group: '米哈游 · 原神（16）' },
    { id: 'raiden', name: '雷电将军', enName: "Raiden Shogun", subtitle: '原神 · 雷（CV 菊花花）', group: '米哈游 · 原神（16）' },
    { id: 'zhongli', name: '钟离', enName: "Zhongli", subtitle: '原神 · 岩（CV 彭博）', group: '米哈游 · 原神（16）' },
    { id: 'neuvillette', name: '那维莱特', enName: "Neuvillette", subtitle: '原神 · 水（CV 桑毓泽）', group: '米哈游 · 原神（16）' },
    { id: 'hutao', name: '胡桃', enName: "Hu Tao", subtitle: '原神 · 火（CV 陶典）', group: '米哈游 · 原神（16）' },
    { id: 'mavuika', name: '玛薇卡', enName: "Mavuika", subtitle: '原神 · 火（CV 李晔）', group: '米哈游 · 原神（16）' },
    { id: 'citlali', name: '茜特菈莉', enName: "Citlali", subtitle: '原神 · 冰（CV 柳知萧）', group: '米哈游 · 原神（16）' },
    { id: 'arlecchino', name: '阿蕾奇诺', enName: "Arlecchino", subtitle: '原神 · 火（CV 黄莺）', group: '米哈游 · 原神（16）' },
    { id: 'ayaka', name: '神里绫华', enName: "Kamisato Ayaka", subtitle: '原神 · 冰（CV 小N）', group: '米哈游 · 原神（16）' },
    { id: 'kazuha', name: '枫原万叶', enName: "Kaedehara Kazuha", subtitle: '原神 · 风（CV 斑马）', group: '米哈游 · 原神（16）' },
    { id: 'wanderer', name: '流浪者', enName: "Wanderer", subtitle: '原神 · 风（CV 鹿喑）', group: '米哈游 · 原神（16）' },
    { id: 'yaemiko', name: '八重神子', enName: "Yae Miko", subtitle: '原神 · 雷（CV 杜冥鸦）', group: '米哈游 · 原神（16）' },
    { id: 'ganyu', name: '甘雨', enName: "Ganyu", subtitle: '原神 · 冰（CV 林簌）', group: '米哈游 · 原神（16）' },
    { id: 'venti', name: '温迪', enName: "Venti", subtitle: '原神 · 风（CV 喵酱）', group: '米哈游 · 原神（16）' },
    { id: 'navia', name: '娜维娅', enName: "Navia", subtitle: '原神 · 岩（CV 小敢）', group: '米哈游 · 原神（16）' },
    { id: 'firefly', name: '流萤', enName: "Firefly", subtitle: '崩坏：星穹铁道 · 火（CV 宋媛媛&淦子齐）', group: '米哈游 · 崩坏：星穹铁道（14）' },
    { id: 'kafka', name: '卡芙卡', enName: "Kafka", subtitle: '崩坏：星穹铁道 · 雷（CV 徐慧）', group: '米哈游 · 崩坏：星穹铁道（14）' },
    { id: 'acheron', name: '黄泉', enName: "Acheron", subtitle: '崩坏：星穹铁道 · 雷（CV 菊花花）', group: '米哈游 · 崩坏：星穹铁道（14）' },
    { id: 'robin', name: '知更鸟', enName: "Robin", subtitle: '崩坏：星穹铁道 · 物理（CV 钱琛 / 歌：Chevy）', group: '米哈游 · 崩坏：星穹铁道（14）' },
    { id: 'sunday', name: '星期日', enName: "Sunday", subtitle: '崩坏：星穹铁道 · 虚数（CV 徐翔）', group: '米哈游 · 崩坏：星穹铁道（14）' },
    { id: 'feixiao', name: '飞霄', enName: "Feixiao", subtitle: '崩坏：星穹铁道 · 风（CV 叶知秋）', group: '米哈游 · 崩坏：星穹铁道（14）' },
    { id: 'aventurine', name: '砂金', enName: "Aventurine", subtitle: '崩坏：星穹铁道 · 虚数（CV 杨超然）', group: '米哈游 · 崩坏：星穹铁道（14）' },
    { id: 'sparkle', name: '花火', enName: "Sparkle", subtitle: '崩坏：星穹铁道 · 量子（CV 赵爽）', group: '米哈游 · 崩坏：星穹铁道（14）' },
    { id: 'jingliu', name: '镜流', enName: "Jingliu", subtitle: '崩坏：星穹铁道 · 冰（CV 杜冥鸦）', group: '米哈游 · 崩坏：星穹铁道（14）' },
    { id: 'jingyuan', name: '景元', enName: "Jing Yuan", subtitle: '崩坏：星穹铁道 · 雷（CV 孙晔）', group: '米哈游 · 崩坏：星穹铁道（14）' },
    { id: 'the_herta', name: '大黑塔', enName: "The Herta", subtitle: '崩坏：星穹铁道 · 冰（CV 侯小菲）', group: '米哈游 · 崩坏：星穹铁道（14）' },
    { id: 'castorice', name: '遐蝶', enName: "Castorice", subtitle: '崩坏：星穹铁道 · 量子（CV 阮从青）', group: '米哈游 · 崩坏：星穹铁道（14）' },
    { id: 'march7th', name: '三月七', enName: "March 7th", subtitle: '崩坏：星穹铁道 · 冰（CV 诺亚）', group: '米哈游 · 崩坏：星穹铁道（14）' },
    { id: 'silverwolf', name: '银狼', enName: "Silver Wolf", subtitle: '崩坏：星穹铁道 · 量子（CV Hanser）', group: '米哈游 · 崩坏：星穹铁道（14）' },
    { id: 'sunchang', name: '上海地铁 · 孙畅', enName: "Shanghai Metro (Sun Chang)", subtitle: '上海轨道交通 · 经典报站（CV 孙畅）', group: '上海地铁报站（2）' },
    { id: 'jinlei', name: '上海地铁 · 金蕾', enName: "Shanghai Metro (Jin Lei)", subtitle: '上海轨道交通 · 经典报站（CV 金蕾）', group: '上海地铁报站（2）' },
]

const VALID_VOICE_IDS = new Set(VOXCPM_VOICE_OPTIONS.map((v) => v.id))

const STORAGE_KEY = 'hapi-voice-reader'
const CHANGE_EVENT = 'hapi-voice-reader-change'
const CHARACTER_STORAGE_KEY = 'hapi-voice-tts-character'
const CHARACTER_CHANGE_EVENT = 'hapi-voice-tts-character-change'

export function readVoiceReader(): VoiceReader {
    try {
        return localStorage.getItem(STORAGE_KEY) === 'builtin' ? 'builtin' : 'manbo'
    } catch {
        return 'manbo'
    }
}

export function writeVoiceReader(reader: VoiceReader): void {
    try {
        if (reader === 'builtin') localStorage.setItem(STORAGE_KEY, 'builtin')
        else localStorage.removeItem(STORAGE_KEY)
    } catch { /* storage unavailable */ }
    window.dispatchEvent(new Event(CHANGE_EVENT))
}

export function readVoiceTtsCharacter(): string {
    try {
        const raw = localStorage.getItem(CHARACTER_STORAGE_KEY)?.trim()
        return raw && VALID_VOICE_IDS.has(raw) ? raw : DEFAULT_VOXCPM_VOICE_ID
    } catch {
        return DEFAULT_VOXCPM_VOICE_ID
    }
}

export function writeVoiceTtsCharacter(voiceId: string): void {
    const normalized = VALID_VOICE_IDS.has(voiceId) ? voiceId : DEFAULT_VOXCPM_VOICE_ID
    try {
        if (normalized === DEFAULT_VOXCPM_VOICE_ID) localStorage.removeItem(CHARACTER_STORAGE_KEY)
        else localStorage.setItem(CHARACTER_STORAGE_KEY, normalized)
    } catch { /* storage unavailable */ }
    window.dispatchEvent(new Event(CHARACTER_CHANGE_EVENT))
}

function subscribe(onChange: () => void): () => void {
    window.addEventListener(CHANGE_EVENT, onChange)
    window.addEventListener('storage', onChange)
    return () => {
        window.removeEventListener(CHANGE_EVENT, onChange)
        window.removeEventListener('storage', onChange)
    }
}

function subscribeCharacter(onChange: () => void): () => void {
    window.addEventListener(CHARACTER_CHANGE_EVENT, onChange)
    window.addEventListener('storage', onChange)
    return () => {
        window.removeEventListener(CHARACTER_CHANGE_EVENT, onChange)
        window.removeEventListener('storage', onChange)
    }
}

export function useVoiceReader(): [VoiceReader, (reader: VoiceReader) => void] {
    const reader = useSyncExternalStore(subscribe, readVoiceReader, () => 'manbo' as const)
    return [reader, writeVoiceReader]
}

export function useVoiceTtsCharacter(): [string, (voiceId: string) => void] {
    const voiceId = useSyncExternalStore(subscribeCharacter, readVoiceTtsCharacter, () => DEFAULT_VOXCPM_VOICE_ID)
    return [voiceId, writeVoiceTtsCharacter]
}
