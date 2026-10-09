import { describe, expect, it } from 'bun:test'
import { redactAccessLogLine } from './accessLogRedaction'

describe('redactAccessLogLine', () => {
    it('hides the JWT on SSE requests but keeps the path', () => {
        expect(redactAccessLogLine('<-- GET /api/events?token=eyJhbGciOiJIUzI1NiJ9.eyJ1aWQiOjF9.sig&visibility=visible'))
            .toBe('<-- GET /api/events?token=[redacted]&visibility=visible')
    })

    it('hides the download token in the path', () => {
        expect(redactAccessLogLine('--> GET /download/abcDEF123/hapi-linux-x64.gz 200 12ms'))
            .toBe('--> GET /download/[redacted]/hapi-linux-x64.gz 200 12ms')
    })

    it('leaves ordinary query parameters alone', () => {
        const line = '--> GET /cli/sessions/7fce8da0/messages?afterSeq=16739&limit=200 200 2ms'
        expect(redactAccessLogLine(line)).toBe(line)
    })

    it('redacts every sensitive parameter in one line', () => {
        expect(redactAccessLogLine('<-- GET /x?a=1&access_token=s1&key=s2'))
            .toBe('<-- GET /x?a=1&access_token=[redacted]&key=[redacted]')
    })
})
