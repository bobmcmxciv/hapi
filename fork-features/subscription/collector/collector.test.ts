import { describe, test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
    authenticate,
    collectAll,
    configFromEnv,
    pushSnapshots,
    readClaudeOAuthToken,
    startCollector,
    type CollectorConfig
} from './collector'
import type { SubscriptionSnapshot } from '../domain'

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const ANTHROPIC_USAGE = {
    limits: [{ kind: 'session', percent: 10, severity: 'normal', resets_at: '2026-08-15T10:30:00Z', is_active: true, scope: null }]
}
const ANTHROPIC_PROFILE = { account: { email: 'a@b.com', has_claude_max: true } }

/** 空 home:阻断 readClaudeOAuthToken 回落读本机真实 ~/.claude/.credentials.json。
 *  不隔离的话 vircs 上真有那个文件,测试会莫名多出一条 anthropic 快照。 */
const EMPTY_HOME = mkdtempSync(join(tmpdir(), 'hapi-sub-empty-'))

function baseConfig(overrides: Partial<CollectorConfig> = {}): CollectorConfig {
    return {
        hubUrl: 'https://hub.example.com',
        hubToken: 'cli-token-abc',
        machine: 'vircs',
        now: () => 1_700_000_000_000,
        log: () => {},
        credentials: {},
        homeDir: EMPTY_HOME,
        eager: false,
        ...overrides
    }
}

describe('readClaudeOAuthToken', () => {
    test('reads claudeAiOauth.accessToken from ~/.claude/.credentials.json', () => {
        const home = mkdtempSync(join(tmpdir(), 'hapi-sub-'))
        try {
            mkdirSync(join(home, '.claude'), { recursive: true })
            writeFileSync(join(home, '.claude', '.credentials.json'), JSON.stringify({
                claudeAiOauth: { accessToken: 'sk-ant-oat-xyz', expiresAt: 1 }
            }))
            expect(readClaudeOAuthToken(home)).toBe('sk-ant-oat-xyz')
        } finally { rmSync(home, { recursive: true, force: true }) }
    })

    test('missing file returns null instead of throwing', () => {
        const home = mkdtempSync(join(tmpdir(), 'hapi-sub-'))
        try {
            expect(readClaudeOAuthToken(home)).toBeNull()
        } finally { rmSync(home, { recursive: true, force: true }) }
    })

    test('malformed JSON returns null', () => {
        const home = mkdtempSync(join(tmpdir(), 'hapi-sub-'))
        try {
            mkdirSync(join(home, '.claude'), { recursive: true })
            writeFileSync(join(home, '.claude', '.credentials.json'), '{ broken')
            expect(readClaudeOAuthToken(home)).toBeNull()
        } finally { rmSync(home, { recursive: true, force: true }) }
    })
})

describe('configFromEnv', () => {
    test('reports which required vars are missing', () => {
        const result = configFromEnv({})
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.missing).toEqual(['HAPI_SUB_HUB_URL', 'HAPI_SUB_HUB_TOKEN'])
    })

    test('builds config from env and defaults interval to 5m', () => {
        const result = configFromEnv({
            HAPI_SUB_HUB_URL: 'https://hub.example.com',
            HAPI_SUB_HUB_TOKEN: 'tok',
            HAPI_SUB_MACHINE: 'vircs',
            HAPI_SUB_DEEPSEEK_KEY: 'ds-key'
        })
        expect(result.ok).toBe(true)
        if (result.ok) {
            expect(result.config.intervalMs).toBe(300_000)
            expect(result.config.machine).toBe('vircs')
            expect(result.config.credentials.deepseekApiKey).toBe('ds-key')
            expect(result.config.credentials.kimiApiKey).toBeNull()
        }
    })

    test('rejects an interval below the 30s floor and falls back to default', () => {
        const result = configFromEnv({
            HAPI_SUB_HUB_URL: 'https://h', HAPI_SUB_HUB_TOKEN: 't', HAPI_SUB_INTERVAL_MS: '1000'
        })
        expect(result.ok).toBe(true)
        if (result.ok) expect(result.config.intervalMs).toBe(300_000)
    })
})

describe('collectAll', () => {
    test('skips providers with no credentials — zero requests fired', async () => {
        const snapshots = await collectAll(baseConfig({
            credentials: { anthropicAccessToken: null, deepseekApiKey: null, kimiApiKey: null, glmApiKey: null },
            // 若真发了请求就会 throw,快照里出现 error 行,下面的长度断言即失败。
            fetchImpl: (async () => { throw new Error('should not be called') }) as unknown as typeof fetch
        }))
        expect(snapshots).toHaveLength(0)
    })

    test('falls back to reading the CLI credential file when no explicit anthropic token', async () => {
        const home = mkdtempSync(join(tmpdir(), 'hapi-sub-'))
        try {
            mkdirSync(join(home, '.claude'), { recursive: true })
            writeFileSync(join(home, '.claude', '.credentials.json'), JSON.stringify({
                claudeAiOauth: { accessToken: 'from-file' }
            }))
            let seenAuth = ''
            const fetchImpl = (async (url: string, init?: RequestInit) => {
                if (String(url).includes('oauth/usage')) {
                    seenAuth = new Headers(init?.headers).get('authorization') ?? ''
                    return jsonResponse(ANTHROPIC_USAGE)
                }
                return jsonResponse(ANTHROPIC_PROFILE)
            }) as unknown as typeof fetch

            const snapshots = await collectAll(baseConfig({
                homeDir: home, fetchImpl,
                credentials: { anthropicAccessToken: null, deepseekApiKey: null, kimiApiKey: null, glmApiKey: null }
            }))
            expect(snapshots).toHaveLength(1)
            expect(seenAuth).toBe('Bearer from-file')
        } finally { rmSync(home, { recursive: true, force: true }) }
    })

    test('collects every configured provider in one pass', async () => {
        let calls = 0
        const fetchImpl = (async (url: string) => {
            calls++
            const u = String(url)
            if (u.includes('oauth/usage')) return jsonResponse(ANTHROPIC_USAGE)
            if (u.includes('oauth/profile')) return jsonResponse(ANTHROPIC_PROFILE)
            if (u.includes('deepseek')) return jsonResponse({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '10.5' }] })
            if (u.includes('kimi')) return jsonResponse({ user: { userId: 'u1' }, usage: { limit: '100', used: '20' } })
            if (u.includes('bigmodel')) return jsonResponse({ code: 200, success: true, data: { level: 'max', limits: [{ type: 'TOKENS_LIMIT', unit: 3, percentage: 5, nextResetTime: 1 }] } })
            return new Response('', { status: 404 })
        }) as unknown as typeof fetch

        const snapshots = await collectAll(baseConfig({
            fetchImpl,
            credentials: { anthropicAccessToken: 'a', deepseekApiKey: 'd', kimiApiKey: 'k', glmApiKey: 'g' }
        }))
        expect(snapshots.map(s => s.provider).sort()).toEqual(['anthropic', 'deepseek', 'glm', 'kimi'])
        expect(calls).toBe(5) // 4 providers + anthropic profile
        expect(snapshots.every(s => s.machine === 'vircs')).toBe(true)
    })

    test('one provider failing does not drop the others', async () => {
        const fetchImpl = (async (url: string) => {
            const u = String(url)
            if (u.includes('deepseek')) throw new Error('DNS fail')
            if (u.includes('kimi')) return jsonResponse({ user: { userId: 'u1' }, usage: { limit: '100', used: '20' } })
            return new Response('', { status: 404 })
        }) as unknown as typeof fetch

        const snapshots = await collectAll(baseConfig({
            fetchImpl,
            credentials: { anthropicAccessToken: null, deepseekApiKey: 'd', kimiApiKey: 'k', glmApiKey: null }
        }))
        expect(snapshots).toHaveLength(2)
        const ds = snapshots.find(s => s.provider === 'deepseek')
        const kimi = snapshots.find(s => s.provider === 'kimi')
        expect(ds?.error).toBe('DNS fail')
        expect(kimi?.error).toBeNull()
        expect(kimi?.windows.length).toBeGreaterThan(0)
    })
})

describe('authenticate / pushSnapshots', () => {
    test('authenticate posts accessToken to /api/auth and returns the token', async () => {
        let capturedUrl = ''
        let capturedBody: any = null
        const fetchImpl = (async (url: string, init?: RequestInit) => {
            capturedUrl = String(url)
            capturedBody = JSON.parse(String(init?.body))
            return jsonResponse({ token: 'jwt-with-gaid' })
        }) as unknown as typeof fetch
        const token = await authenticate(baseConfig(), fetchImpl)
        expect(capturedUrl).toBe('https://hub.example.com/api/auth')
        expect(capturedBody).toEqual({ accessToken: 'cli-token-abc' })
        expect(token).toBe('jwt-with-gaid')
    })

    test('authenticate throws on non-2xx', async () => {
        const fetchImpl = (async () => new Response('', { status: 401 })) as unknown as typeof fetch
        await expect(authenticate(baseConfig(), fetchImpl)).rejects.toThrow('HTTP 401')
    })

    test('pushSnapshots sends Bearer token and snapshot array', async () => {
        let headers: Record<string, string> = {}
        let body: any = null
        const fetchImpl = (async (_url: string, init?: RequestInit) => {
            headers = Object.fromEntries(new Headers(init?.headers).entries())
            body = JSON.parse(String(init?.body))
            return jsonResponse({ accepted: 1 })
        }) as unknown as typeof fetch
        const snap: SubscriptionSnapshot = {
            machine: 'vircs', provider: 'anthropic', account_key: 'a@b.com', plan_name: 'Claude Max',
            windows: [], balance: null, error: null, reported_at: 1
        }
        await pushSnapshots(baseConfig(), 'jwt', [snap], fetchImpl)
        expect(headers['authorization']).toBe('Bearer jwt')
        expect(body.snapshots).toHaveLength(1)
        expect(body.snapshots[0].provider).toBe('anthropic')
    })

    test('pushSnapshots throws with hub error text on failure', async () => {
        const fetchImpl = (async () => new Response('{"error":"Admin only"}', { status: 403 })) as unknown as typeof fetch
        const snap: SubscriptionSnapshot = {
            machine: 'v', provider: 'p', account_key: 'a', plan_name: null,
            windows: [], balance: null, error: null, reported_at: 1
        }
        await expect(pushSnapshots(baseConfig(), 'jwt', [snap], fetchImpl)).rejects.toThrow('Admin only')
    })
})

describe('startCollector', () => {
    test('runOnce authenticates once then reuses the cached JWT', async () => {
        let authCalls = 0
        let reportCalls = 0
        const fetchImpl = (async (url: string) => {
            const u = String(url)
            if (u.endsWith('/api/auth')) { authCalls++; return jsonResponse({ token: 'jwt' }) }
            if (u.endsWith('/api/subscription/report')) { reportCalls++; return jsonResponse({ accepted: 1 }) }
            if (u.includes('deepseek')) return jsonResponse({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '1' }] })
            return new Response('', { status: 404 })
        }) as unknown as typeof fetch

        const handle = startCollector(baseConfig({
            fetchImpl, intervalMs: 999_999_999,
            credentials: { anthropicAccessToken: null, deepseekApiKey: 'd', kimiApiKey: null, glmApiKey: null }
        }))
        await handle.runOnce()
        await handle.runOnce()
        handle.stop()
        expect(authCalls).toBe(1)
        expect(reportCalls).toBeGreaterThanOrEqual(2)
    })

    test('a failed push clears the cached token so the next round re-auths', async () => {
        let authCalls = 0
        let reportAttempt = 0
        const fetchImpl = (async (url: string) => {
            const u = String(url)
            if (u.endsWith('/api/auth')) { authCalls++; return jsonResponse({ token: `jwt-${authCalls}` }) }
            if (u.endsWith('/api/subscription/report')) {
                reportAttempt++
                return reportAttempt === 1 ? new Response('expired', { status: 401 }) : jsonResponse({ accepted: 1 })
            }
            if (u.includes('deepseek')) return jsonResponse({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '1' }] })
            return new Response('', { status: 404 })
        }) as unknown as typeof fetch

        const handle = startCollector(baseConfig({
            fetchImpl, intervalMs: 999_999_999,
            credentials: { anthropicAccessToken: null, deepseekApiKey: 'd', kimiApiKey: null, glmApiKey: null }
        }))
        await expect(handle.runOnce()).rejects.toThrow('401')
        const result = await handle.runOnce()
        handle.stop()
        expect(result.pushed).toBe(true)
        expect(authCalls).toBe(2)
    })

    test('no credentials means no push at all', async () => {
        let reportCalls = 0
        const fetchImpl = (async (url: string) => {
            if (String(url).endsWith('/api/subscription/report')) reportCalls++
            return jsonResponse({ token: 'jwt', accepted: 0 })
        }) as unknown as typeof fetch
        const handle = startCollector(baseConfig({
            fetchImpl, intervalMs: 999_999_999,
            credentials: { anthropicAccessToken: null, deepseekApiKey: null, kimiApiKey: null, glmApiKey: null }
        }))
        const result = await handle.runOnce()
        handle.stop()
        expect(result).toEqual({ collected: 0, pushed: false })
        expect(reportCalls).toBe(0)
    })

    test('concurrent rounds share one in-flight auth instead of double-logging-in', async () => {
        let authCalls = 0
        const fetchImpl = (async (url: string) => {
            const u = String(url)
            if (u.endsWith('/api/auth')) {
                authCalls++
                // 让 auth 慢一拍,确保两轮真的重叠在同一个时间窗里。
                await new Promise(r => setTimeout(r, 10))
                return jsonResponse({ token: 'jwt' })
            }
            if (u.endsWith('/api/subscription/report')) return jsonResponse({ accepted: 1 })
            if (u.includes('deepseek')) return jsonResponse({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '1' }] })
            return new Response('', { status: 404 })
        }) as unknown as typeof fetch

        const handle = startCollector(baseConfig({
            fetchImpl, intervalMs: 999_999_999,
            credentials: { anthropicAccessToken: null, deepseekApiKey: 'd', kimiApiKey: null, glmApiKey: null }
        }))
        await Promise.all([handle.runOnce(), handle.runOnce(), handle.runOnce()])
        handle.stop()
        expect(authCalls).toBe(1)
    })

    test('log 抛异常也不能停掉轮询——这正是线上停 13 小时的形状', async () => {
        // 计划任务里 stdout 是关闭句柄，写它会抛。旧代码把 scheduleNext() 放在
        // catch 之后而不是 finally 里，catch 里那句 log 一抛，定时器就再也不重新
        // 武装：进程活着、循环已死、页面数据冻结在最后一次。
        let rounds = 0
        const store: string[] = []
        const handle = startCollector(baseConfig({
            intervalMs: 5,
            log: () => { throw new Error('EPIPE: stdout closed') },
            credentials: { anthropicAccessToken: null, deepseekApiKey: 'd', kimiApiKey: null, glmApiKey: null },
            fetchImpl: (async (url: string) => {
                const u = String(url)
                if (u.includes('deepseek')) { rounds++; store.push('collect') }
                if (u.endsWith('/api/auth')) return jsonResponse({ token: 'jwt' })
                if (u.endsWith('/api/subscription/report')) return jsonResponse({ accepted: 1 })
                return jsonResponse({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '1' }] })
            }) as unknown as typeof fetch
        }))
        // 等几个 interval，确认循环还在转
        await new Promise(r => setTimeout(r, 80))
        handle.stop()
        expect(rounds).toBeGreaterThan(1)
    })

    /** 模拟一个挂住的连接：永不响应，但**尊重 AbortSignal**（真 fetch 就是这样，
     *  超时能生效正是靠这一点）。断言的是"我们确实传了 signal 进去"。 */
    const hangingFetch = (() => (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal
            if (!signal) return // 没传 signal → 永远挂着，测试会超时失败，这正是我们要防的
            signal.addEventListener('abort', () => reject(new Error('The operation was aborted.')))
        })) ()

    test('authenticate 带超时——挂住的连接不能让 await 永不返回', async () => {
        await expect(authenticate(
            baseConfig({ hubTimeoutMs: 50 }),
            hangingFetch as unknown as typeof fetch
        )).rejects.toThrow(/abort/i)
    }, 45_000)

    test('pushSnapshots 带超时', async () => {
        const snap: SubscriptionSnapshot = {
            machine: 'v', provider: 'p', account_key: 'a', plan_name: null,
            windows: [], balance: null, error: null, reported_at: 1
        }
        await expect(pushSnapshots(
            baseConfig({ hubTimeoutMs: 50 }), 'jwt', [snap], hangingFetch as unknown as typeof fetch
        )).rejects.toThrow(/abort/i)
    }, 45_000)

    test('看门狗：连续没有成功推送就退出，让计划任务重启', async () => {
        // 不真的 process.exit，替换掉观察调用。
        const realExit = process.exit
        // 用容器持有，避免 TS 把闭包外的 let 窄化成 null（赋值发生在它看不见的回调里）
        const observed: { exitCode: number | null } = { exitCode: null }
        process.exit = ((code?: number) => { observed.exitCode = code ?? 0 }) as never
        try {
            let t = 1_700_000_000_000
            const handle = startCollector(baseConfig({
                intervalMs: 5,
                watchdogMs: 50,
                now: () => t,
                credentials: { anthropicAccessToken: null, deepseekApiKey: 'd', kimiApiKey: null, glmApiKey: null },
                // 推送恒失败 → 永远不会更新 lastSuccessAt
                fetchImpl: (async (url: string) => {
                    const u = String(url)
                    if (u.endsWith('/api/auth')) return new Response('', { status: 500 })
                    return jsonResponse({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '1' }] })
                }) as unknown as typeof fetch
            }))
            // 把时钟推过看门狗窗口，再等一个 interval 让回调跑到 checkWatchdog
            t += 200
            await new Promise(r => setTimeout(r, 60))
            handle.stop()
            expect(observed.exitCode).toBe(1)
        } finally {
            process.exit = realExit
        }
    })

    test('stop() prevents further scheduled rounds', async () => {
        let calls = 0
        const fetchImpl = (async (url: string) => {
            const u = String(url)
            if (u.includes('deepseek')) { calls++; return jsonResponse({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '1' }] }) }
            return jsonResponse({ token: 'jwt', accepted: 1 })
        }) as unknown as typeof fetch
        const handle = startCollector(baseConfig({
            fetchImpl, intervalMs: 5,
            credentials: { anthropicAccessToken: null, deepseekApiKey: 'd', kimiApiKey: null, glmApiKey: null }
        }))
        await handle.runOnce()
        handle.stop()
        const before = calls
        await new Promise(r => setTimeout(r, 40))
        expect(calls).toBe(before)
    })
})
