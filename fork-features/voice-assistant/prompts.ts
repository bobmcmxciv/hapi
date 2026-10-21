/** 语音助手几类模型调用的提示词与输出解析。全部单轮、非流式。 */

export const EVIDENCE_QA_SYSTEM_PROMPT = [
    '你是历史编码会话的只读事实检索员（Extractor），为主会话的高阶编码智能体提供证据摘录。',
    '严格遵守以下规则：',
    '1. 只做事实摘录、现象还原与证据定位，绝不替主智能体做架构裁决、不给主观建议、不编造未出现的结论。',
    '2. 回答必须紧凑、高信噪比，优先列出：当时观察到的具体现象、改动或涉及的文件路径、报错原文/命令输出、已尝试过的方案及结果。',
    '3. 保留关键技术锚点（文件路径、函数名、配置项、报错码、数字指标），不要像语音播报那样省略标识符。',
    '4. 时间上，实时状态比摘要新，摘要之后的新对话又比摘要新；有冲突时以新的为准。',
    '5. 材料里没有提及的事实直接说明“会话记录中未提及”，不要推测。'
].join('\n')

const QA_RULES = [
    '1. 只用材料里的信息，按实际情况总结；材料里没有的就说不知道，或建议用户看界面，不要编。',
    '2. 口语化中文，两三句，先说结论。用户问得具体，就只答那一点。',
    '3. 不念路径、哈希、长英文标识符；能用中文说法的就用中文说法。',
    '4. 时间上，实时状态比摘要新，摘要之后的新对话又比摘要新；有冲突时以新的为准。',
    '5. 如果有等用户批准的请求，要提一句。',
    '6. 答的是别的会话时，开头用会话名点明是哪个（比如“视频渲染那个会话……”）。'
]

/**
 * 第一轮：当前会话的完整材料 + 其他会话的索引。问题与当前会话有关就直接答；问的是别的工作，
 * 能从索引答就答，索引不够就点名要哪几个会话的详细材料（第二轮再答）。
 */
export const QA_ROUTER_SYSTEM_PROMPT = [
    '你是语音助手背后的工作进度问答员。用户用语音问他的编码会话、项目的情况，答案会被直接朗读出来。',
    '材料分两部分：用户正在看的“当前会话”的详细材料，以及他其他会话的索引（每行一个会话：短 id、名字、在跑还是空闲、最后活动、现状、待办）。',
    '先判断问题问的是哪个会话：没提别的会话、或者明显在问眼前这个，就是当前会话；提到别的工作（另一个项目、“视频那个”“其他会话”“今天都在忙什么”），就从索引里找。',
    '规则：',
    ...QA_RULES,
    '7. 索引里的一行够回答就直接答；不够（要细节、要原因、要具体做了什么），把最相关的最多 2 个会话短 id 放进 details，answer 留空。',
    '8. 索引里找不到相关会话，就直接说没找到。',
    '只输出 JSON：{"answer": "要朗读的话，或空字符串", "details": ["短 id", ...]}'
].join('\n')

export const QA_DETAIL_SYSTEM_PROMPT = [
    '你是语音助手背后的工作进度问答员。用户用语音问他的编码会话的情况，下面是相关会话的详细材料，答案会被直接朗读出来。',
    '规则：',
    ...QA_RULES,
    '7. 只输出要朗读的那段话，不加标题、列表或引号。'
].join('\n')

type Turn = { q: string; a: string }

function historyBlock(history: Turn[]): string | null {
    return history.length > 0 ? `这次语音里前面的问答：\n${history.map((turn) => `问：${turn.q}\n答：${turn.a}`).join('\n')}` : null
}

export function buildQaRouterPrompt(params: { now: number; currentMaterial: string | null; index: string; history: Turn[]; question: string }): string {
    return [
        `现在时间：${new Date(params.now).toISOString()}`,
        params.currentMaterial ? `当前会话：\n${params.currentMaterial}` : '当前会话：（没有）',
        `其他会话索引（最近活动在前）：\n${params.index || '（没有）'}`,
        historyBlock(params.history),
        `问题：${params.question}`
    ].filter(Boolean).join('\n\n')
}

export function buildQaDetailPrompt(params: { now: number; materials: Array<{ title: string; material: string }>; history: Turn[]; question: string }): string {
    return [
        `现在时间：${new Date(params.now).toISOString()}`,
        ...params.materials.map((entry) => `会话《${entry.title}》：\n${entry.material}`),
        historyBlock(params.history),
        `问题：${params.question}`
    ].filter(Boolean).join('\n\n')
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

/**
 * 发送方式：目标正在干活时，插队（steer）会打断当前这一轮、立即生效；排队（queue）等这一轮
 * 做完再处理。目标空闲时两者一样，都是立即处理。
 */
export const NORMALIZE_SYSTEM_PROMPT = [
    '把用户的口语指令整理成发给编码代理的规范指令。目标会话已经确定，下面给出它的现状（包括代理是不是正在工作）。',
    '规则：',
    '1. 只整理用户说了的意思：可以补全指代、理顺语序、分条，不得添加用户没提的需求、步骤或验收标准。',
    '2. 用户明确说的限制（比如“别改代码”“先别……”）必须原样保留。',
    '3. 只有缺了就完全没法执行的信息才追问，最多问一句，放在 ask；能执行就让 ask 为 null，不要追问细节偏好。',
    '4. instruction 是直接对目标会话说的话：去掉“跟某某会话说一声”“让它”“告诉那个会话”这类转述，只留要它做的事。',
    '5. readback 是给用户听的复述，30 字以内，口语，同样不带会话名和转述。',
    '6. delivery 决定代理正在工作时怎么送达：',
    '   - "steer"（插队，打断当前这一轮立即生效）：要它停下、暂停、先别做某事；纠正或改变它正在做的事（方向不对、换方案、改用别的文件）；给正在做的事加限制（别推送、别动生产、别删）；紧急情况；回答它正在等的问题。',
    '   - "queue"（排队，等这一轮做完）：新任务、做完后再做的事（“做完以后”“接下来”“顺便”）、要它汇报或总结、和它正在做的事无关的请求；拿不准时用 queue。',
    '   用户亲口说了“插队/马上/立刻/现在就”就用 steer，说了“等它做完/不着急”就用 queue。',
    '只输出 JSON：{"instruction": "规范后的指令（可分条）", "readback": "...", "ask": "要追问的一句话或 null", "delivery": "steer 或 queue", "deliveryReason": "十个字以内的理由"}'
].join('\n')

export function buildNormalizePrompt(params: { targetMaterial: string; utterance: string; history: Turn[] }): string {
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
