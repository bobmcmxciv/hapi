/** 语音助手三类模型调用的提示词与输出解析。全部单轮、非流式。 */

export const QA_SYSTEM_PROMPT = [
    '你是语音助手背后的会话进度问答员。用户用语音问某个编码会话的情况，你根据材料回答，答案会被直接朗读出来。',
    '规则：',
    '1. 只用材料里的信息。材料里没有的，就说不知道，或建议用户看界面；不要编。',
    '2. 口语化中文，两三句，先说结论。用户问得具体，就只答那一点。',
    '3. 不念路径、哈希、长英文标识符；能用中文说法的就用中文说法。',
    '4. 时间上，实时状态比摘要新，摘要之后的新对话又比摘要新；有冲突时以新的为准。',
    '5. 如果有等用户批准的请求，要提一句。',
    '6. 只输出要朗读的那段话，不加标题、列表或引号。'
].join('\n')

export function buildQaPrompt(params: { now: number; material: string; history: Array<{ q: string; a: string }>; question: string }): string {
    const parts = [`现在时间：${new Date(params.now).toISOString()}`, `材料：\n${params.material}`]
    if (params.history.length > 0) {
        parts.push(`这次语音里前面的问答：\n${params.history.map((turn) => `问：${turn.q}\n答：${turn.a}`).join('\n')}`)
    }
    parts.push(`问题：${params.question}`)
    return parts.join('\n\n')
}

export const TARGET_SYSTEM_PROMPT = [
    '用户用口语指代了一个编码会话（比如“做视频的那个”）。从会话列表里找出他指的是哪个。',
    '只输出 JSON：{"matches": ["短 id", ...], "confident": true/false}',
    'matches 按可能性从高到低，最多 3 个；一个都对不上就给空数组。',
    '只有在唯一一个会话明显符合时 confident 才是 true。'
].join('\n')

export function buildTargetPrompt(params: { hint: string; listing: string; currentLine: string | null }): string {
    return [
        params.currentLine ? `用户正在看的会话：${params.currentLine}` : null,
        `可以发指令的会话（都在线）：\n${params.listing}`,
        `用户的说法：${params.hint}`
    ].filter(Boolean).join('\n\n')
}

export const NORMALIZE_SYSTEM_PROMPT = [
    '把用户的口语指令整理成发给编码代理的规范指令。目标会话已经确定，下面给出它的现状。',
    '规则：',
    '1. 只整理用户说了的意思：可以补全指代、理顺语序、分条，不得添加用户没提的需求、步骤或验收标准。',
    '2. 用户明确说的限制（比如“别改代码”“先别……”）必须原样保留。',
    '3. 只有缺了就完全没法执行的信息才追问，最多问一句，放在 ask；能执行就让 ask 为 null，不要追问细节偏好。',
    '4. instruction 是直接对目标会话说的话：去掉“跟某某会话说一声”“让它”“告诉那个会话”这类转述，只留要它做的事。',
    '5. readback 是给用户听的复述，30 字以内，口语，同样不带会话名和转述。',
    '只输出 JSON：{"instruction": "规范后的指令（可分条）", "readback": "...", "ask": "要追问的一句话或 null"}'
].join('\n')

export function buildNormalizePrompt(params: { targetMaterial: string; utterance: string; history: Array<{ q: string; a: string }> }): string {
    const parts = [`目标会话：\n${params.targetMaterial}`]
    if (params.history.length > 0) {
        parts.push(`这次语音里前面的对话：\n${params.history.map((turn) => `用户：${turn.q}\n助手：${turn.a}`).join('\n')}`)
    }
    parts.push(`用户原话：${params.utterance}`)
    return parts.join('\n\n')
}

/** 容忍 ```json 包裹和前后废话，取第一个完整的 JSON 对象。 */
export function parseJsonObject(text: string): Record<string, unknown> | null {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start < 0 || end <= start) return null
    try {
        const parsed = JSON.parse(text.slice(start, end + 1)) as unknown
        return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
    } catch {
        return null
    }
}
