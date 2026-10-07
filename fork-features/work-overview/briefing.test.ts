import { describe, expect, test } from 'bun:test'
import { buildBriefingPrompt, knownIds, parseBriefing, type BriefingContext } from './briefing'

const DAY = 86_400_000
const NOW = 100 * DAY

const context: BriefingContext = {
    now: NOW,
    lines: [
        { id: 'm1', name: 'HAPI', parentId: null, status: 'push', lastActivity: NOW - DAY },
        { id: 'm1.s1', name: '远程会话平台', parentId: 'm1', nextSteps: ['验证文件传输'], lastActivity: NOW }
    ],
    pending: [{ sessionId: 's-pending', title: '等批准的部署', lineId: 'm1.s1', machine: 'VIRCS', updatedAt: NOW, detail: 'Bash 命令待批准' }],
    active: [{ sessionId: 's-active', title: '正在跑的评测', thinking: true }],
    recent: [{ sessionId: 's-done', title: '已完结的会话', completed: true, updatedAt: NOW - 3 * DAY }],
    dismissed: [{ sessionId: 's-old', title: '两个月前的提问' }]
}

describe('briefing prompt and parsing', () => {
    test('prompt lists lines, pending, running, recent and dismissed sessions with their ids', () => {
        const prompt = buildBriefingPrompt(context)
        expect(prompt).toContain('m1.s1｜远程会话平台')
        expect(prompt).toContain('验证文件传输')
        expect(prompt).toContain('s-pending｜等批准的部署｜m1.s1｜VIRCS｜今天｜Bash 命令待批准')
        expect(prompt).toContain('s-active｜正在跑的评测')
        expect(prompt).toContain('3 天前')
        expect(prompt).toContain('不需要再关注')
        expect(prompt).toContain('s-old｜两个月前的提问')
    })

    test('parses JSON wrapped in prose and keeps only ids that were given (never dismissed ones)', () => {
        const text = '好的：\n{"summary":"先处理部署审批","groups":[{"title":"需要你拍板/回复","items":[' +
            '{"text":"批准部署命令","sessionId":"s-pending","lineId":"m1.s1","priority":"high"},' +
            '{"text":"回复旧提问","sessionId":"s-old"},' +
            '{"text":"编造的会话","sessionId":"nope","lineId":"zzz"},' +
            '{"text":""}]},{"title":"空组","items":[]}]}\n以上。'
        const parsed = parseBriefing(text, knownIds(context))
        expect(parsed?.summary).toBe('先处理部署审批')
        expect(parsed?.groups).toEqual([{ title: '需要你拍板/回复', items: [
            { text: '批准部署命令', sessionId: 's-pending', lineId: 'm1.s1', priority: 'high' },
            { text: '回复旧提问' },
            { text: '编造的会话' }
        ] }])
    })

    test('rejects output without any JSON or with nothing usable', () => {
        expect(parseBriefing('没有 JSON', knownIds(context))).toBeNull()
        expect(parseBriefing('{"groups":[]}', knownIds(context))).toBeNull()
        expect(parseBriefing('{broken', knownIds(context))).toBeNull()
    })
})
