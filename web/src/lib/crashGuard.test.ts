import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
    CHUNK_RELOAD_GUARD_WINDOW_MS,
    __resetCrashGuardForTests,
    attachCrashReporter,
    isChunkLoadError,
    reportCrash,
    shouldAttemptChunkReload,
    type ClientErrorReport,
} from './crashGuard'

describe('isChunkLoadError', () => {
    it('识别三家浏览器对动态 import 失败的措辞与 Vite CSS 预载失败', () => {
        const positives = [
            new TypeError('Failed to fetch dynamically imported module: https://hub/assets/chunk-abc.js'),
            new TypeError('Importing a module script failed.'),
            new Error('error loading dynamically imported module'),
            new TypeError('Failed to load module script: Expected a JavaScript module script'),
            new Error('Unable to preload CSS for /assets/index-abc.css'),
            'ChunkLoadError: Loading chunk 42 failed',
        ]
        for (const candidate of positives) {
            expect(isChunkLoadError(candidate), String(candidate)).toBe(true)
        }
    })

    it('普通错误与空值不误判', () => {
        expect(isChunkLoadError(new TypeError("Cannot read properties of undefined (reading 'id')"))).toBe(false)
        expect(isChunkLoadError('Session expired. Please sign in again.')).toBe(false)
        expect(isChunkLoadError(null)).toBe(false)
        expect(isChunkLoadError(undefined)).toBe(false)
    })
})

describe('shouldAttemptChunkReload', () => {
    it('无历史刷新记录时放行', () => {
        expect(shouldAttemptChunkReload(1000, null)).toBe(true)
    })

    it('护栏窗口内拒绝二次自动刷新，窗口外放行', () => {
        const last = 1_000_000
        expect(shouldAttemptChunkReload(last + CHUNK_RELOAD_GUARD_WINDOW_MS - 1, last)).toBe(false)
        expect(shouldAttemptChunkReload(last + CHUNK_RELOAD_GUARD_WINDOW_MS + 1, last)).toBe(true)
    })

    it('损坏的时间戳视为无记录', () => {
        expect(shouldAttemptChunkReload(1000, Number.NaN)).toBe(true)
    })
})

describe('reportCrash / attachCrashReporter', () => {
    beforeEach(() => __resetCrashGuardForTests())
    afterEach(() => __resetCrashGuardForTests())

    it('attach 前的崩溃积压，attach 时按序补发', () => {
        reportCrash(new Error('first'), 'window-error')
        reportCrash(new Error('second'), 'sse')
        const received: ClientErrorReport[] = []
        attachCrashReporter((report) => received.push(report))
        expect(received.map((r) => r.message)).toEqual(['Error: first', 'Error: second'])
        expect(received[0]?.source).toBe('window-error')
        expect(received[1]?.source).toBe('sse')
    })

    it('同一 source+message 只上报一次', () => {
        const received: ClientErrorReport[] = []
        attachCrashReporter((report) => received.push(report))
        reportCrash(new Error('dup'), 'window-error')
        reportCrash(new Error('dup'), 'window-error')
        reportCrash(new Error('dup'), 'sse')
        expect(received).toHaveLength(2)
    })

    it('单页上报总量封顶 10 条', () => {
        const received: ClientErrorReport[] = []
        attachCrashReporter((report) => received.push(report))
        for (let index = 0; index < 20; index += 1) {
            reportCrash(new Error(`crash ${index}`), 'window-error')
        }
        expect(received).toHaveLength(10)
    })

    it('报告字段带 url/userAgent/appVersion 且长度受限', () => {
        const received: ClientErrorReport[] = []
        attachCrashReporter((report) => received.push(report))
        const error = new Error('x'.repeat(2000))
        error.stack = 'y'.repeat(10_000)
        reportCrash(error, 'error-boundary')
        const report = received[0]
        expect(report).toBeDefined()
        expect(report!.message.length).toBeLessThanOrEqual(500)
        expect(report!.stack?.length).toBeLessThanOrEqual(4000)
        expect(report!.url).toBeTruthy()
        expect(report!.userAgent).toBeTruthy()
        expect(typeof report!.appVersion).toBe('string')
        expect(report!.occurredAt).toBeGreaterThan(0)
    })
})
