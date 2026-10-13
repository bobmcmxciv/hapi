import type { VoiceDelivery } from './types'

/**
 * Reads a short spoken answer to the read-back ("确认发送吧", "对", "算了", "插队发") so a pending
 * draft is sent or dropped even when the realtime model routes the answer to the wrong tool.
 * Only answers made entirely of these words count; anything longer is a real request or question.
 */
export type ConfirmIntent = { decision: 'send' | 'cancel'; delivery?: VoiceDelivery }

const SEND = ['确认发送', '确认', '确定', '发送', '发出去', '发吧', '发', '好的', '好', '对的', '对', '是的', '是', '可以', '行', '没问题', '就这样', '去吧', '嗯', 'okay', 'ok', 'yes', 'yep', 'send']
const CANCEL = ['取消', '不要发', '不用发', '别发', '不发', '算了', '不要', '不用', '不行', 'cancel', 'no', 'nope']
const STEER = ['插队', '马上', '立刻', '立即', '现在就']
const QUEUE = ['排队', '等它做完', '等它这一轮做完', '不着急', '不急']
// Filler that carries no decision.
const FILLER = ['那就', '就', '吧', '啊', '呀', '哦', '呢', '嘛', '了', '的', '吗', '请', '帮我', '一下', '一下子']

const TOKENS = [...SEND, ...CANCEL, ...STEER, ...QUEUE, ...FILLER].sort((a, b) => b.length - a.length)
const MAX_CHARS = 14

export function classifyConfirmation(text: string): ConfirmIntent | null {
    let rest = text.toLowerCase().replace(/[\s，。！？、,.!?~…；;：:"'“”‘’（）()]/g, '')
    if (!rest || rest.length > MAX_CHARS) return null
    let send = false
    let cancel = false
    let delivery: VoiceDelivery | undefined
    while (rest) {
        const token = TOKENS.find((candidate) => rest.startsWith(candidate))
        if (!token) return null
        if (SEND.includes(token)) send = true
        else if (CANCEL.includes(token)) cancel = true
        else if (STEER.includes(token)) delivery = 'steer'
        else if (QUEUE.includes(token)) delivery = 'queue'
        rest = rest.slice(token.length)
    }
    if (send === cancel) return null
    return cancel ? { decision: 'cancel' } : { decision: 'send', delivery }
}
