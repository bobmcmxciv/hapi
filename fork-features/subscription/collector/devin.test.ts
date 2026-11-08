import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import {
    collectDevin,
    convertDevinUserStatus,
    decodeDevinGetUserStatusResponse,
    encodeDevinGetUserStatusRequest,
    readDevinToken
} from './devin'

describe('Devin collector adapter', () => {
    test('encodes GetUserStatusRequest with Metadata field 1 and apiKey', () => {
        const bytes = encodeDevinGetUserStatusRequest('devin-session-token$abc12345')
        expect(bytes.length).toBeGreaterThan(20)
        // Field 1, wire type 2 (length-delimited) -> tag 0x0a
        expect(bytes[0]).toBe(0x0a)
        const text = new TextDecoder().decode(bytes)
        expect(text).toContain('devin-cli')
        expect(text).toContain('devin-session-token$abc12345')
    })

    test('converts quota-based Devin Pro response into daily and weekly windows', () => {
        const snapshot = convertDevinUserStatus(
            {
                userStatus: {
                    email: 'tadokorokouji734@gmail.com',
                    userId: 'user-123',
                    planStatus: {
                        planInfo: {
                            planName: 'Pro',
                            billingStrategy: 2
                        },
                        dailyQuotaRemainingPercent: 99,
                        weeklyQuotaRemainingPercent: 100,
                        dailyQuotaResetAtUnix: 1793952000,
                        weeklyQuotaResetAtUnix: 1794124800
                    }
                }
            },
            { machine: 'vircs', reportedAt: 1700000000000, accountKey: '…abc12345' }
        )

        expect(snapshot).toEqual({
            machine: 'vircs',
            provider: 'devin',
            account_key: 'tadokorokouji734@gmail.com',
            plan_name: 'Devin Pro',
            windows: [
                {
                    key: 'duration_1440',
                    label: '24 小时窗口',
                    used_percent: 1,
                    reset_at: 1793952000000,
                    severity: 'normal',
                    is_active: true
                },
                {
                    key: 'weekly',
                    label: '周窗口',
                    used_percent: 0,
                    reset_at: 1794124800000,
                    severity: 'normal',
                    is_active: false
                }
            ],
            balance: null,
            error: null,
            reported_at: 1700000000000
        })
    })

    test('reads Devin token from credentials.toml or ~/.omp/agent/agent.db', () => {
        const home = mkdtempSync(join(tmpdir(), 'hapi-devin-'))
        try {
            expect(readDevinToken(home, {})).toBeNull()

            // 1) OMP agent.db fallback
            const ompDir = join(home, '.omp', 'agent')
            mkdirSync(ompDir, { recursive: true })
            const db = new Database(join(ompDir, 'agent.db'))
            db.exec('CREATE TABLE auth_credentials (id INTEGER PRIMARY KEY, provider TEXT, data TEXT, disabled INTEGER DEFAULT 0)')
            db.run(
                'INSERT INTO auth_credentials (provider, data, disabled) VALUES (?, ?, 0)',
                ['devin', JSON.stringify({ type: 'api_key', access: 'devin-from-omp-db' })]
            )
            db.close()
            expect(readDevinToken(home, {})).toBe('devin-from-omp-db')

            // 2) credentials.toml takes precedence
            const devinDir = join(home, 'AppData', 'Roaming', 'devin')
            mkdirSync(devinDir, { recursive: true })
            writeFileSync(join(devinDir, 'credentials.toml'), 'windsurf_api_key = "devin-from-toml"\n')
            expect(readDevinToken(home, {})).toBe('devin-from-toml')
        } finally {
            rmSync(home, { recursive: true, force: true })
        }
    })

    test('collectDevin returns error snapshot on HTTP 401', async () => {
        const snap = await collectDevin(
            {
                machine: 'vircs',
                now: () => 12345,
                fetchImpl: (async () => new Response('', { status: 401 })) as unknown as typeof fetch
            },
            'devin-session-token$12345678'
        )
        expect(snap.provider).toBe('devin')
        expect(snap.account_key).toBe('…12345678')
        expect(snap.error).toBe('HTTP 401(凭据无效或过期)')
    })

    test('collectDevin: headers 到了但 body 迟迟不到——超时要盖到 arrayBuffer 读完', async () => {
        // protobuf 走 arrayBuffer()，与 JSON 适配器同一条挂死路径：响应头一到
        // fetch 就 resolve，body 若永不到达且无 abort 兜底，整条采集永不返回。
        const fetchImpl = ((_url: string, init?: RequestInit) => Promise.resolve(new Response(
            new ReadableStream<Uint8Array>({ start(controller) {
                init?.signal?.addEventListener('abort', () => controller.error(new Error('aborted')))
            } }),
            { status: 200, headers: { 'content-type': 'application/proto' } }
        ))) as unknown as typeof fetch

        const snap = await collectDevin(
            { machine: 'vircs', now: () => 12345, fetchImpl, timeoutMs: 30 },
            'devin-session-token$12345678'
        )
        expect(snap.provider).toBe('devin')
        expect(snap.error).not.toBeNull()
        expect(snap.error).toContain('abort')
    })

    test('decodeDevinGetUserStatusResponse returns empty object on empty buffer', () => {
        expect(decodeDevinGetUserStatusResponse(new Uint8Array(0))).toEqual({})
    })

    test('decodes real GetUserStatusResponse wire fields (14=daily%, 15=weekly%, 17=dailyReset, 18=weeklyReset)', () => {
        // Construct PlanInfo: field 2 (planName)="Pro", field 35 (billingStrategy)=2
        const planInfo = new Uint8Array([0x12, 0x03, 0x50, 0x72, 0x6f, 0x98, 0x02, 0x02])
        // Construct PlanStatus: field 1 (planInfo), field 14 (daily%)=99, field 15 (weekly%)=100, field 17 (dailyReset)=1793952000, field 18 (weeklyReset)=1794124800
        const planStatus = new Uint8Array([
            0x0a, planInfo.length, ...planInfo,
            0x70, 99,
            0x78, 100,
            0x88, 0x01, 0x80, 0x92, 0xb6, 0xd7, 0x06,
            0x90, 0x01, 0x80, 0xd8, 0xc0, 0xd7, 0x06
        ])
        // Construct UserStatus: field 7 (email)="a@b.com", field 13 (planStatus)
        const emailBytes = new TextEncoder().encode('a@b.com')
        const userStatus = new Uint8Array([
            0x3a, emailBytes.length, ...emailBytes,
            0x6a, planStatus.length, ...planStatus
        ])
        // Construct GetUserStatusResponse: field 1 (userStatus)
        const respBytes = new Uint8Array([0x0a, userStatus.length, ...userStatus])

        const decoded = decodeDevinGetUserStatusResponse(respBytes)
        expect(decoded.userStatus?.email).toBe('a@b.com')
        expect(decoded.userStatus?.planStatus?.planInfo?.planName).toBe('Pro')
        expect(decoded.userStatus?.planStatus?.planInfo?.billingStrategy).toBe(2)
        expect(decoded.userStatus?.planStatus?.dailyQuotaRemainingPercent).toBe(99)
        expect(decoded.userStatus?.planStatus?.weeklyQuotaRemainingPercent).toBe(100)
        expect(decoded.userStatus?.planStatus?.dailyQuotaResetAtUnix).toBe(1793952000)
        expect(decoded.userStatus?.planStatus?.weeklyQuotaResetAtUnix).toBe(1794124800)
    })
})
