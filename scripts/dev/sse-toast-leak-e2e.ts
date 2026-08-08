/**
 * 跨账号「提醒弹窗」泄漏的真机复现 —— 本地起真 hub 进程，走真 HTTP / 真 SSE /
 * 真 CLI socket，不 mock 任何一层。
 *
 * 复现的现象：mnmn66（普通账号，与 admin 共享 core namespace `default`，历史账号
 * 都是这个）在 web 上收到**别人会话**的「Ready for input / Task completed」弹窗，
 * 点进去 403。事件流（broadcast）2026-08-02 起已按账号过滤，但提醒走的是
 * `SSEManager.sendToast`，那条路只看 namespace + visible，压根不问谓词。
 *
 * 用法（仓库根目录）：
 *   bun run scripts/dev/sse-toast-leak-e2e.ts
 * 退出码 0 = 没泄漏（admin 收到、mnmn66 没收到）；1 = 泄漏或链路没跑通。
 * 打补丁前后各跑一次才算控制变量：未修版必须复现 FAIL。
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { io } from 'socket.io-client'
import { MultiUserGatewayStore } from '../../fork-features/multi-user/gatewayStore'
import { hashPassword } from '../../fork-features/multi-user/password'
import { hashApiToken } from '../../fork-features/multi-user/token'

const PORT = Number(process.env.E2E_PORT ?? 3399)
const BASE = `http://127.0.0.1:${PORT}`
const CLI_API_TOKEN = 'e2e-sse-toast-leak-token-0123456789'
const MNMN66_PASSWORD = 'e2e-password-0123456789'

const dataDir = mkdtempSync(join(tmpdir(), 'hapi-sse-toast-'))
const failures: string[] = []
const log = (line: string) => console.log(line)

/** 两个账号共享 `default` —— 生产上 admin/peter/bobmcmxciv/mnmn66 都是这个 ns。 */
function seedGateway(): void {
    const store = new MultiUserGatewayStore(join(dataDir, 'multi-user-gateway.sqlite'))
    const admin = store.createAccount('admin', 'admin', 'default', hashPassword(MNMN66_PASSWORD))
    store.createToken(admin.id, 'e2e cli token', hashApiToken(CLI_API_TOKEN))
    store.createAccount('mnmn66', 'user', 'default', hashPassword(MNMN66_PASSWORD))
    store.close()
}

async function waitForHub(): Promise<void> {
    for (let attempt = 0; attempt < 120; attempt += 1) {
        try {
            const response = await fetch(`${BASE}/health`)
            if (response.ok) return
        } catch {
            // hub 还没监听
        }
        await new Promise(resolve => setTimeout(resolve, 500))
    }
    throw new Error('hub did not come up in 60s')
}

async function login(body: Record<string, string>): Promise<string> {
    const response = await fetch(`${BASE}/api/auth`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
    })
    const json = await response.json() as { token?: string; error?: string }
    if (!response.ok || !json.token) throw new Error(`login failed: ${response.status} ${json.error ?? ''}`)
    return json.token
}

type SseTap = { toasts: unknown[]; frames: number; close: () => void }

/** 真 SSE：不用 EventSource 包一层，直接读 `GET /api/events` 的字节流。 */
function openSse(label: string, jwt: string): SseTap {
    const controller = new AbortController()
    const tap: SseTap = { toasts: [], frames: 0, close: () => controller.abort() }
    void (async () => {
        const response = await fetch(`${BASE}/api/events?token=${encodeURIComponent(jwt)}`, {
            headers: { accept: 'text/event-stream' },
            signal: controller.signal
        })
        if (!response.ok || !response.body) throw new Error(`${label} SSE failed: ${response.status}`)
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        while (true) {
            const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }))
            if (done) return
            buffer += decoder.decode(value, { stream: true })
            let index = buffer.indexOf('\n\n')
            while (index >= 0) {
                const frame = buffer.slice(0, index)
                buffer = buffer.slice(index + 2)
                index = buffer.indexOf('\n\n')
                const payload = frame.split('\n').filter(line => line.startsWith('data:'))
                    .map(line => line.slice(5).trim()).join('')
                if (!payload) continue
                tap.frames += 1
                const event = JSON.parse(payload) as { type?: string }
                if (event.type === 'toast') {
                    tap.toasts.push(event)
                    log(`  [${label}] <- toast ${JSON.stringify(event)}`)
                }
            }
        }
    })().catch(error => {
        if (!controller.signal.aborted) failures.push(`${label} SSE error: ${String(error)}`)
    })
    return tap
}

async function main(): Promise<number> {
    seedGateway()
    const hub = spawn(process.execPath, ['run', 'hub/src/index.ts'], {
        cwd: join(import.meta.dir, '..', '..'),
        env: {
            ...process.env,
            HAPI_HOME: dataDir,
            HAPI_LISTEN_HOST: '127.0.0.1',
            HAPI_LISTEN_PORT: String(PORT),
            CLI_API_TOKEN,
            HAPI_DISABLE_TUNNEL: '1'
        },
        stdio: ['ignore', 'pipe', 'pipe']
    })
    hub.stdout.on('data', chunk => { if (process.env.E2E_VERBOSE) process.stdout.write(`[hub] ${chunk}`) })
    hub.stderr.on('data', chunk => process.stderr.write(`[hub!] ${chunk}`))

    try {
        await waitForHub()
        log('hub is up')

        const adminJwt = await login({ accessToken: CLI_API_TOKEN })
        const mnmn66Jwt = await login({ username: 'mnmn66', password: MNMN66_PASSWORD })
        log('logged in as admin + mnmn66')

        // admin 的 CLI 在自己的机器上建会话（真 /cli 路由）
        const machineId = randomUUID()
        const sessionId = randomUUID()
        const created = await fetch(`${BASE}/cli/sessions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${CLI_API_TOKEN}` },
            body: JSON.stringify({
                id: sessionId,
                tag: `e2e-${sessionId}`,
                metadata: { path: '/tmp/e2e-repo', host: 'E2E_BOX', machineId, flavor: 'claude' },
                machine: { id: machineId, metadata: { host: 'E2E_BOX', platform: 'linux', happyHomeDir: '/tmp' } }
            })
        })
        if (!created.ok) throw new Error(`create session failed: ${created.status} ${await created.text()}`)

        // admin 刷一次列表 → bind-on-view 认领成 owner（与生产状态一致）
        const adminList = await fetch(`${BASE}/api/sessions`, { headers: { authorization: `Bearer ${adminJwt}` } })
        const adminSessions = (await adminList.json() as { sessions: Array<{ id: string }> }).sessions
        if (!adminSessions.some(session => session.id === sessionId)) {
            failures.push('admin 的会话列表里没有这条会话，链路没跑通')
        }
        const strangerList = await fetch(`${BASE}/api/sessions`, { headers: { authorization: `Bearer ${mnmn66Jwt}` } })
        const strangerSessions = (await strangerList.json() as { sessions: Array<{ id: string }> }).sessions
        log(`admin sees ${adminSessions.length} session(s); mnmn66 sees ${strangerSessions.length}`)
        if (strangerSessions.some(session => session.id === sessionId)) {
            failures.push('mnmn66 的会话列表里出现了 admin 的会话（列表层就泄漏了）')
        }

        const adminTap = openSse('admin', adminJwt)
        const strangerTap = openSse('mnmn66', mnmn66Jwt)
        await new Promise(resolve => setTimeout(resolve, 1500))

        // 真 CLI socket：会话置活 + 推一条 ready 事件，NotificationHub 据此发提醒
        const cli = io(`${BASE}/cli`, { auth: { token: CLI_API_TOKEN }, transports: ['websocket'] })
        await new Promise<void>((resolve, reject) => {
            cli.on('connect', () => resolve())
            cli.on('connect_error', error => reject(new Error(`cli socket: ${error.message}`)))
            setTimeout(() => reject(new Error('cli socket connect timeout')), 10_000)
        })
        cli.emit('session-alive', { sid: sessionId, time: Date.now(), thinking: false })
        await new Promise(resolve => setTimeout(resolve, 500))
        cli.emit('message', {
            sid: sessionId,
            localId: randomUUID(),
            message: JSON.stringify({ type: 'event', data: { type: 'ready' } })
        })
        log('emitted ready event from the CLI socket')

        await new Promise(resolve => setTimeout(resolve, 3000))
        cli.close()
        adminTap.close()
        strangerTap.close()

        log(`admin   frames=${adminTap.frames} toasts=${adminTap.toasts.length}`)
        log(`mnmn66  frames=${strangerTap.frames} toasts=${strangerTap.toasts.length}`)
        if (adminTap.toasts.length === 0) {
            failures.push('admin（会话 owner）没收到提醒 —— 要么链路没跑通，要么过滤把正主也拦了')
        }
        if (strangerTap.toasts.length > 0) {
            failures.push(`LEAK: mnmn66 收到了 ${strangerTap.toasts.length} 条不属于他的会话提醒`)
        }
    } catch (error) {
        failures.push(String(error))
    } finally {
        hub.kill()
        await new Promise(resolve => setTimeout(resolve, 500))
        rmSync(dataDir, { recursive: true, force: true })
    }

    if (failures.length > 0) {
        log('\nFAIL')
        for (const failure of failures) log(`  - ${failure}`)
        return 1
    }
    log('\nPASS: 提醒只到达会话 owner，同 namespace 的旁观账号一条都没收到')
    return 0
}

process.exit(await main())
