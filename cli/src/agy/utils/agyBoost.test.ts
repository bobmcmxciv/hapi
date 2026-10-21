import { describe, expect, it } from 'vitest'
import { MessageQueue2 } from '@/utils/MessageQueue2'
import { formatAgyUserMessage } from './agyBoost'

const attachment = {
    id: 'attachment-1',
    filename: 'failure.txt',
    mimeType: 'text/plain',
    size: 42,
    path: 'C:/logs/failure.txt'
}

describe('Antigravity Boost prompt delivery', () => {
    it('keeps /boost at the front when attachments are present', () => {
        expect(formatAgyUserMessage('  /boost investigate the failure', [attachment])).toEqual({
            message: '/boost investigate the failure @C:/logs/failure.txt',
            isolate: true
        })
    })

    it('does not reinterpret similarly named text or change ordinary attachment formatting', () => {
        expect(formatAgyUserMessage('/booster is unrelated', undefined)).toEqual({
            message: '/booster is unrelated', isolate: false
        })
        expect(formatAgyUserMessage('Investigate', [attachment])).toEqual({
            message: '@C:/logs/failure.txt\n\nInvestigate', isolate: false
        })
    })

    it('delivers a Boost task alone without dropping adjacent queued messages', async () => {
        const queue = new MessageQueue2<string>((mode) => mode)
        for (const [text, id] of [
            ['first prompt', 'first'],
            ['/boost research the bug', 'boost'],
            ['later prompt', 'later']
        ]) {
            const formatted = formatAgyUserMessage(text, undefined)
            if (formatted.isolate) queue.pushIsolated(formatted.message, 'request-review', id)
            else queue.push(formatted.message, 'request-review', id)
        }

        const first = await queue.waitForMessagesAndGetAsString()
        const boost = await queue.waitForMessagesAndGetAsString()
        const later = await queue.waitForMessagesAndGetAsString()
        expect([first?.message, boost?.message, later?.message]).toEqual([
            'first prompt', '/boost research the bug', 'later prompt'
        ])
        expect(boost?.isolate).toBe(true)
        expect(boost?.items[0]?.localId).toBe('boost')
    })
})
