import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'bun:test'
import { normalizeOmpUsage, OmpUsageReader, readOmpUsageCommand } from './usage'
import { OMP_USAGE_CACHE_MS, type OmpUsageResponse } from '@hapi/protocol/ompUsage'
import { getFreshOmpUsageReports } from '@hapi/protocol/ompUsage'
import {
    buildCx2ccUsageExtensionSource,
    CX2CC_USAGE_EXTENSION_FILENAME,
    CX2CC_USAGE_EXTENSION_MARKER,
    ensureCx2ccUsageExtension,
} from './cx2ccUsageExtension'
import { createCx2ccUsageProvider, parseCx2ccUsageReport, resolveCx2ccUsageEndpoint, selectCx2ccProviderCandidates } from './cx2ccUsageProvider'

function nativeReport(accountId = 'private@example.com', fetchedAt = 1000, remaining: number | undefined = 0) {
    return {
        provider: 'extension-provider', fetchedAt, metadata: { accountId, email: accountId, token: 'private-token' },
        raw: { authorization: 'private-token' }, notes: ['private note'],
        limits: [{
            id: `pool/${accountId}`, label: 'Shared weekly pool',
            scope: { provider: 'extension-provider', accountId, shared: true, sharedGroup: 'weekly-shared', modelId: 'model-a' },
            window: { id: 'weekly', label: 'Weekly' },
            amount: { unit: 'credits', ...(remaining !== undefined ? { remaining } : {}) },
            status: 'unknown', notes: ['private note']
        }]
    }
}
function nativeEnvelope(reports = [nativeReport()]) {
    return { generatedAt: 2000, reports, accountsWithoutUsage: [], disabledCredentials: [], capacity: { private: 'secret' } }
}
function requireSuccess(response: OmpUsageResponse) {
    if (!response.success) throw new Error(`Unexpected ${response.errorCode}`)
    return response
}
function child(script: string, budgets?: { timeoutMs?: number; maxOutputBytes?: number }) {
    return readOmpUsageCommand({ command: process.execPath, args: ['-e', script], cwd: process.cwd(), env: process.env }, budgets)
}

describe('native usage host boundary', () => {
    test('preserves true zero and fetchedAt; strips raw credentials and notes', () => {
        const report = nativeReport()
        report.limits[0].label = 'Quota private@example.com'
        const result = requireSuccess(normalizeOmpUsage(nativeEnvelope([report])))
        expect(result.generatedAt).toBe(2000)
        expect(result.reports[0].fetchedAt).toBe(1000)
        expect(result.reports[0].limits[0].amount.remaining).toBe(0)
        expect(result.reports[0].accountId).not.toContain('private')
        const serialized = JSON.stringify(result)
        for (const secret of ['private@example.com', 'private-token', 'private note', 'metadata', 'capacity', 'authorization']) {
            expect(serialized).not.toContain(secret)
        }
    })
    test('deduplicates routing copies of a shared pool without summing; separates accounts and windows', () => {
        const first = nativeReport('account-one')
        first.limits.push({ ...first.limits[0], id: 'routing-copy', scope: { ...first.limits[0].scope, modelId: 'model-b' } })
        first.limits.push({ ...first.limits[0], id: 'other-window', window: { id: 'daily', label: 'Daily' } })
        const result = requireSuccess(normalizeOmpUsage(nativeEnvelope([first, nativeReport('account-two')])))
        expect(result.reports[0].limits).toHaveLength(2)
        expect(result.reports[1].limits).toHaveLength(1)
        expect(result.reports[0].accountId).not.toBe(result.reports[1].accountId)
        expect(result.reports[0].limits[0].amount.remaining).toBe(0)
    })
    test('retains only the newest duplicate snapshot without washing timestamps on other limits', () => {
        const old = nativeReport('same-account', 100, 10)
        old.limits.push({ ...old.limits[0], id: 'old-unique', scope: { ...old.limits[0].scope, sharedGroup: 'different-pool' } })
        const fresh = nativeReport('same-account', 200, 0)
        const result = requireSuccess(normalizeOmpUsage(nativeEnvelope([old, fresh])))
        expect(result.reports[0].fetchedAt).toBe(100)
        expect(result.reports[0].limits).toHaveLength(1)
        expect(result.reports[0].limits[0].amount.remaining).toBe(10)
        expect(result.reports[1].fetchedAt).toBe(200)
        expect(result.reports[1].limits[0].amount.remaining).toBe(0)
    })
    test('unknown values remain missing; an extension provider with no reports is not declared unsupported', () => {
        const report = nativeReport('account', 1000, undefined)
        // Explicitly omit rather than relying on a fixture's default argument.
        report.limits[0].amount = { unit: 'credits' }
        const unknown = requireSuccess(normalizeOmpUsage(nativeEnvelope([report])))
        expect(unknown.reports[0].limits[0].amount.remaining).toBeUndefined()
        const empty = requireSuccess(normalizeOmpUsage({
            ...nativeEnvelope([]), accountsWithoutUsage: [{ provider: 'new-extension', email: 'private@example.com' }],
            disabledCredentials: [{ token: 'private-token', email: 'private@example.com' }]
        }))
        expect(empty.reports).toEqual([])
        expect(empty.accountsWithoutUsage[0].provider).toBe('new-extension')
        expect(empty.disabledCredentialCount).toBe(1)
        expect(JSON.stringify(empty)).not.toContain('private')
    })
    test('rejects malformed or non-native CLI data without forwarding it', () => {
        expect(normalizeOmpUsage({ error: 'private-token' })).toMatchObject({ success: false, errorCode: 'invalid_output' })
    })
})

describe('owned native command bounds', () => {
    test('uses a real child to read native JSON', async () => {
        const result = await child(`process.stdout.write(${JSON.stringify(JSON.stringify(nativeEnvelope()))})`)
        expect(requireSuccess(result).reports[0].limits[0].amount.remaining).toBe(0)
    })
    test('a large stdout or stderr fails closed rather than retaining a partial report', async () => {
        for (const stream of ['stdout', 'stderr']) {
            const result = await child(`process.${stream}.write('x'.repeat(100000))`, { maxOutputBytes: 1000 })
            expect(result).toMatchObject({ success: false, errorCode: 'output_limit' })
        }
    })
    test('a non-zero exit does not leak stderr or credentials', async () => {
        const result = await child("console.error('Authorization: Bearer private-token private@example.com');process.exit(4)")
        expect(result).toMatchObject({ success: false, errorCode: 'command_failed' })
        expect(JSON.stringify(result)).not.toContain('private')
    })
    test('missing usage capability is explicit, never an external fallback', async () => {
        expect(await child("console.error('unknown command usage');process.exit(2)")).toMatchObject({ success: false, errorCode: 'unsupported' })
    })
    test('kills only its timed-out child; an independent child still completes', async () => {
        // Integration: real OS children exercise SIGKILL isolation; fake timers cannot drive child-process exit.
        const independent = child(`setTimeout(()=>process.stdout.write(${JSON.stringify(JSON.stringify(nativeEnvelope()))}),150)`)
        const timed = await child('setInterval(()=>{},1000)', { timeoutMs: 30 })
        expect(timed).toMatchObject({ success: false, errorCode: 'timeout' })
        expect((await independent).success).toBe(true)
    })
})

describe('native usage demand cache', () => {
    test('shares a flight and expires its short cache without mutating fetchedAt', async () => {
        let now = 1000
        let calls = 0
        const pending = Promise.withResolvers<OmpUsageResponse>()
        const reader = new OmpUsageReader(() => { calls++; return pending.promise }, () => now)
        const first = reader.read()
        expect(reader.read()).toBe(first)
        pending.resolve(normalizeOmpUsage(nativeEnvelope()))
        const result = await first
        expect(await reader.read()).toBe(result)
        expect(calls).toBe(1)
        now += OMP_USAGE_CACHE_MS
        expect(requireSuccess(await reader.read()).reports[0].fetchedAt).toBe(1000)
        expect(calls).toBe(2)
    })
    test('does not cache failures or retain stale success after a failed refresh', async () => {
        let now = 1000
        let calls = 0
        const reader = new OmpUsageReader(async () => {
            calls++
            if (calls === 1) return normalizeOmpUsage(nativeEnvelope())
            throw new Error('private-token')
        }, () => now)
        expect((await reader.read()).success).toBe(true)
        now += OMP_USAGE_CACHE_MS
        expect(await reader.read()).toMatchObject({ success: false, errorCode: 'unavailable' })
        expect(await reader.read()).toMatchObject({ success: false, errorCode: 'unavailable' })
        expect(calls).toBe(3)
    })
})

describe('cx2cc native OMP usage extension adapter', () => {
    test('discovers cx2cc providers from models.yml candidates and forwards apiKey reference verbatim', () => {
        const candidates = selectCx2ccProviderCandidates({
            'cx2cc-ecs': { baseUrl: 'https://cx2cc.bobmcmxciv.xin/api/v1', apiKey: 'CX2CC_API_KEY' },
            'custom-proxy': { baseUrl: 'https://gateway.example.com/cx2cc-api/v1', apiKey: '!secret-tool read cx2cc' },
            anthropic: { baseUrl: 'https://api.anthropic.com/v1', apiKey: 'ANTHROPIC_API_KEY' }
        })
        expect(candidates).toEqual([
            { providerId: 'cx2cc-ecs', baseUrl: 'https://cx2cc.bobmcmxciv.xin/api/v1', apiKey: 'CX2CC_API_KEY' },
            { providerId: 'custom-proxy', baseUrl: 'https://gateway.example.com/cx2cc-api/v1', apiKey: '!secret-tool read cx2cc' }
        ])
        expect(resolveCx2ccUsageEndpoint('https://cx2cc.bobmcmxciv.xin/api/v1')).toEqual({
            url: 'https://cx2cc.bobmcmxciv.xin/api/usage',
            origin: 'https://cx2cc.bobmcmxciv.xin'
        })
        expect(resolveCx2ccUsageEndpoint('https://cx2cc.bobmcmxciv.xin/v1')).toEqual({
            url: 'https://cx2cc.bobmcmxciv.xin/api/usage',
            origin: 'https://cx2cc.bobmcmxciv.xin'
        })
        expect(resolveCx2ccUsageEndpoint('ftp://cx2cc.bobmcmxciv.xin/api/v1')).toBeNull()
        expect(resolveCx2ccUsageEndpoint('https://user:pass@cx2cc.bobmcmxciv.xin/api/v1')).toBeNull()
    })

    test('normalizes live cx2cc /api/usage primary window, credits balance, reset credits, and omits null secondary window', () => {
        const nowMs = 1_760_000_000_000
        const report = parseCx2ccUsageReport({
            plan_type: 'pro',
            rate_limit: {
                allowed: true,
                limit_reached: false,
                primary_window: {
                    limit_window_seconds: 604_800,
                    reset_at: 1_760_500_000,
                    used_percent: 62
                },
                secondary_window: null
            },
            credits: {
                has_credits: true,
                unlimited: false,
                balance: '42.50',
                overage_limit_reached: false
            },
            rate_limit_reset_credits: {
                available_count: 2
            }
        }, { provider: 'cx2cc-ecs', accountKey: 'key-fingerprint', nowMs })

        expect(report).not.toBeNull()
        expect(report!.provider).toBe('cx2cc-ecs')
        expect(report!.fetchedAt).toBe(nowMs)
        expect(report!.resetCredits).toEqual({ availableCount: 2 })
        expect(report!.limits).toHaveLength(2)
        expect(report!.limits[0]).toEqual({
            id: 'cx2cc-ecs:primary',
            label: '7 days',
            scope: {
                provider: 'cx2cc-ecs',
                accountId: 'key-fingerprint',
                windowId: '7d',
                shared: true,
                sharedGroup: 'cx2cc:primary:7d'
            },
            window: {
                id: '7d',
                label: '7 days',
                durationMs: 604_800_000,
                resetsAt: 1_760_500_000_000
            },
            amount: {
                unit: 'percent',
                used: 62,
                limit: 100,
                remaining: 38,
                usedFraction: 0.62,
                remainingFraction: 0.38
            },
            status: 'ok'
        })
        expect(report!.limits[1]).toEqual({
            id: 'cx2cc-ecs:credits',
            label: 'Credits balance',
            scope: {
                provider: 'cx2cc-ecs',
                accountId: 'key-fingerprint',
                tier: 'credits',
                windowId: 'credits',
                shared: true,
                sharedGroup: 'cx2cc:credits'
            },
            window: {
                id: 'credits',
                label: 'Credits'
            },
            amount: {
                unit: 'credits',
                remaining: 42.5
            },
            status: 'ok'
        })

        const normalized = requireSuccess(normalizeOmpUsage({
            generatedAt: nowMs,
            reports: [report!],
            accountsWithoutUsage: [],
            disabledCredentials: []
        }))
        const fresh = getFreshOmpUsageReports(normalized, nowMs)
        expect(fresh).toHaveLength(1)
        expect(fresh[0].provider).toBe('cx2cc-ecs')
        expect(fresh[0].limits).toHaveLength(2)
        expect(fresh[0].limits[0].amount.used).toBe(62)
        expect(fresh[0].limits[1].amount.remaining).toBe(42.5)
    })

    test('preserves true 0% used and 0 remaining credits, credit overage allowance, and unknown missing amounts', () => {
        const zeroUsed = parseCx2ccUsageReport({
            rate_limit: {
                allowed: true,
                limit_reached: false,
                primary_window: { limit_window_seconds: 18_000, reset_at: 1_800_000_000, used_percent: 0 }
            },
            credits: {
                has_credits: true,
                unlimited: false,
                balance: '0',
                overage_limit_reached: true
            }
        }, { provider: 'cx2cc-ecs', nowMs: 1_700_000_000_000 })
        expect(zeroUsed?.limits[0].amount).toMatchObject({ used: 0, remaining: 100, usedFraction: 0, remainingFraction: 1 })
        expect(zeroUsed?.limits[0].status).toBe('ok')
        expect(zeroUsed?.limits[1].amount).toEqual({ unit: 'credits', remaining: 0 })
        expect(zeroUsed?.limits[1].status).toBe('exhausted')

        const overageAllowed = parseCx2ccUsageReport({
            rate_limit: {
                allowed: false,
                limit_reached: true,
                primary_window: { limit_window_seconds: 604_800, reset_at: 1_800_000_000, used_percent: 100 }
            },
            credits: {
                has_credits: true,
                unlimited: false,
                balance: '19.75',
                overage_limit_reached: false
            }
        }, { provider: 'cx2cc-ecs', nowMs: 1_700_000_000_000 })
        expect(overageAllowed?.limits[0].status).toBe('warning')
        expect(overageAllowed?.metadata).toMatchObject({ allowed: true, limitReached: false })

        const unknownPercent = parseCx2ccUsageReport({
            rate_limit: {
                primary_window: { limit_window_seconds: 604_800, reset_at: 1_800_000_000 }
            }
        }, { provider: 'cx2cc-ecs', nowMs: 1_700_000_000_000 })
        expect(unknownPercent?.limits[0].amount).toEqual({ unit: 'percent' })
        expect(unknownPercent?.limits[0].status).toBe('unknown')
    })

    test('fetchUsage sends GET /api/usage with x-api-key only, never calls /api/accounts, blocks cross-origin redirects, and returns null on auth failure', async () => {
        const provider = createCx2ccUsageProvider('cx2cc-ecs', { now: () => 1_760_000_000_000 })
        const seen: Array<{ url: string; init?: RequestInit }> = []
        const okReport = await provider.fetchUsage({
            provider: 'cx2cc-ecs',
            credential: { type: 'api_key', apiKey: 'secret-cx2cc-key' },
            accountKey: 'acct-1',
            baseUrl: 'https://cx2cc.bobmcmxciv.xin/api/v1'
        }, {
            fetch: async (url, init) => {
                seen.push({ url, init })
                return new Response(JSON.stringify({
                    plan_type: 'pro',
                    rate_limit: {
                        allowed: true,
                        limit_reached: false,
                        primary_window: { limit_window_seconds: 604_800, reset_at: 1_760_500_000, used_percent: 62 }
                    }
                }), { status: 200 })
            }
        })
        expect(okReport?.limits).toHaveLength(1)
        expect(seen).toHaveLength(1)
        expect(seen[0].url).toBe('https://cx2cc.bobmcmxciv.xin/api/usage')
        expect(seen[0].url).not.toContain('accounts')
        expect(seen[0].init?.redirect).toBe('error')
        expect(new Headers(seen[0].init?.headers).get('x-api-key')).toBe('secret-cx2cc-key')

        const authFail = await provider.fetchUsage({
            provider: 'cx2cc-ecs',
            credential: { type: 'api_key', apiKey: 'secret-cx2cc-key' },
            baseUrl: 'https://cx2cc.bobmcmxciv.xin/api/v1'
        }, {
            fetch: async () => new Response('{"error":"invalid secret-cx2cc-key"}', { status: 401 })
        })
        expect(authFail).toBeNull()

        const crossOrigin = await provider.fetchUsage({
            provider: 'cx2cc-ecs',
            credential: { type: 'api_key', apiKey: 'secret-cx2cc-key' },
            baseUrl: 'https://cx2cc.bobmcmxciv.xin/api/v1'
        }, {
            fetch: async () => {
                const res = new Response(JSON.stringify({
                    rate_limit: { primary_window: { limit_window_seconds: 3600, used_percent: 10 } }
                }), { status: 200 })
                Object.defineProperty(res, 'url', { value: 'https://evil.example.com/api/usage' })
                return res
            }
        })
        expect(crossOrigin).toBeNull()
    })

    test('installer writes dedicated hapi-cx2cc-usage.ts idempotently, preserves hapi-usage.ts and user extensions, and refuses foreign collisions', async () => {
        const tempHome = await mkdtemp(path.join(os.tmpdir(), 'hapi-cx2cc-ext-'))
        try {
            const env = { PI_CODING_AGENT_DIR: path.join(tempHome, '.omp', 'agent'), OMP_PROFILE: '', PI_PROFILE: '' }
            const extDir = path.join(env.PI_CODING_AGENT_DIR, 'extensions')
            await mkdir(extDir, { recursive: true })
            const bindingExt = path.join(extDir, 'hapi-usage.ts')
            const userExt = path.join(extDir, 'custom-user.ts')
            await writeFile(bindingExt, '// Managed by HAPI: native OMP usage binding\nexport default () => {}\n')
            await writeFile(userExt, '// user extension\nexport default () => {}\n')

            const installedPath = await ensureCx2ccUsageExtension({ env, homeDirectory: tempHome })
            expect(path.basename(installedPath)).toBe(CX2CC_USAGE_EXTENSION_FILENAME)
            const content = await readFile(installedPath, 'utf8')
            expect(content.startsWith(CX2CC_USAGE_EXTENSION_MARKER)).toBe(true)
            expect(content).toBe(buildCx2ccUsageExtensionSource())

            const firstStat = await stat(installedPath, { bigint: true })
            await ensureCx2ccUsageExtension({ env, homeDirectory: tempHome })
            expect((await stat(installedPath, { bigint: true })).mtimeNs).toBe(firstStat.mtimeNs)

            expect(await readFile(bindingExt, 'utf8')).toContain('native OMP usage binding')
            expect(await readFile(userExt, 'utf8')).toContain('user extension')

            await writeFile(installedPath, '// user collision\n')
            await expect(ensureCx2ccUsageExtension({ env, homeDirectory: tempHome })).rejects.toThrow('Refusing to overwrite')
            expect(await readFile(installedPath, 'utf8')).toBe('// user collision\n')
        } finally {
            await rm(tempHome, { recursive: true, force: true })
        }
    })
})
