import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import net from 'node:net'
import { spawn, execSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'

// Workers can't inherit process.env from globalSetup, so we write config to a file
// and let setupFile.ts read it in each worker.
export const TEST_CONFIG_FILE = join(tmpdir(), 'hapi-test-config.json')

async function getFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = net.createServer()
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address() as net.AddressInfo
            server.close(() => resolve(addr.port))
        })
        server.on('error', reject)
    })
}

async function waitForHub(baseUrl: string, timeoutMs = 15_000): Promise<void> {
    const healthUrl = `${baseUrl}/health`
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
        if (hubStartupFailure) throw new Error(`${hubStartupFailure.message}\n${hubOutput}`, { cause: hubStartupFailure })
        try {
            const res = await fetch(healthUrl, { signal: AbortSignal.timeout(1000) })
            if (res.ok) return
        } catch {
            // not ready yet — connection refused or timeout
        }
        await new Promise(resolve => setTimeout(resolve, 200))
    }
    throw new Error(`Hub did not become ready within ${timeoutMs}ms\n${hubOutput}`)
}

function findBunExec(): string {
    const cmd = process.platform === 'win32' ? 'where bun' : 'command -v bun'
    const candidates = execSync(cmd, { encoding: 'utf8' })
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean)
    if (process.platform !== 'win32') {
        const p = candidates[0]
        if (!p) throw new Error('[globalSetup] bun executable not found')
        return p
    }
    // Windows 上 `where bun` 常只返回 npm 的 shim（无扩展名 sh 脚本 + .cmd），
    // 二者都不能被 spawn 直接执行 —— 会 ENOENT。优先 .exe；否则把 npm shim
    // 解析到 node_modules\bun\bin\bun.exe（npm i -g bun 的真实安装位置）。
    const exe = candidates.find(line => line.toLowerCase().endsWith('.exe'))
    if (exe) return exe
    for (const candidate of candidates) {
        const resolved = join(dirname(candidate), 'node_modules', 'bun', 'bin', 'bun.exe')
        if (existsSync(resolved)) return resolved
    }
    if (!candidates[0]) throw new Error('[globalSetup] bun executable not found')
    return candidates[0]
}

let hubProcess: ChildProcess | null = null
let tmpHome: string | null = null
let hubStartupFailure: Error | null = null
let hubOutput = ''
let retainFailedHome = false

export async function setup() {
    hubStartupFailure = null
    hubOutput = ''
    retainFailedHome = false
    const port = await getFreePort()
    tmpHome = mkdtempSync(join(tmpdir(), 'hapi-test-'))
    const token = randomBytes(20).toString('base64url')
    const bunExec = findBunExec()

    // Use a minimal env whitelist to prevent shell credentials (DB_PATH,
    // TELEGRAM_BOT_TOKEN, ELEVENLABS_API_KEY, etc.) from leaking into the
    // test hub and triggering real notifications or opening a production DB.
    const hubEnv: NodeJS.ProcessEnv = {
        PATH: process.env.PATH,
        HOME: tmpHome,
        USERPROFILE: tmpHome,
        APPDATA: tmpHome,
        LOCALAPPDATA: tmpHome,
        TEMP: tmpHome,
        TMP: tmpHome,
        TMPDIR: tmpHome,
        SystemRoot: process.env.SystemRoot,
        WINDIR: process.env.WINDIR,
        COMSPEC: process.env.COMSPEC,
        PATHEXT: process.env.PATHEXT,
        HAPI_HOME: tmpHome,
        DB_PATH: join(tmpHome, 'hapi.db'),
        HAPI_LISTEN_PORT: String(port),
        HAPI_LISTEN_HOST: '127.0.0.1',
        HAPI_PUBLIC_URL: `http://127.0.0.1:${port}`,
        CLI_API_TOKEN: token,
        TELEGRAM_NOTIFICATION: 'false',
        SERVERCHAN_NOTIFICATION: 'false',
    }

    // Write config so setupFile.ts can inject env vars into each test worker
    writeFileSync(TEST_CONFIG_FILE, JSON.stringify({ port, token, tmpHome, bunExec }))

    const hubEntry = join(
        dirname(fileURLToPath(import.meta.url)),
        '../../../hub/src/index.ts'
    )

    // Match the shipped runtime's low-memory mode; never load workstation dotenv.
    const child = spawn(bunExec, ['--smol', '--no-env-file', 'run', hubEntry], {
        env: hubEnv,
        cwd: tmpHome,
        stdio: ['ignore', 'pipe', 'pipe'],
    })
    hubProcess = child
    const collectOutput = (chunk: string) => {
        hubOutput = (hubOutput + chunk.replaceAll(token, '[test credential]')).slice(-32_768)
    }
    child.stdout?.setEncoding('utf8').on('data', collectOutput)
    child.stderr?.setEncoding('utf8').on('data', collectOutput)
    child.on('error', (error) => {
        if (hubProcess === child) hubStartupFailure = new Error(`[globalSetup] Failed to spawn isolated hub: ${error.message}`, { cause: error })
    })
    child.on('close', (code, signal) => {
        if (hubProcess === child) hubStartupFailure = new Error(`[globalSetup] Isolated hub exited before readiness (code=${code}, signal=${signal})`)
    })

    try {
        await waitForHub(`http://127.0.0.1:${port}`)
    } catch (error) {
        retainFailedHome = true
        await stopHubProcess()
        writeFileSync(join(tmpHome, 'startup-failure.json'), JSON.stringify({
            port, bunExec, hubEntry, pid: child.pid, output: hubOutput,
            error: error instanceof Error ? error.message : String(error)
        }, null, 2))
        throw new Error(`Isolated Hub startup failed; retained evidence: ${tmpHome}`, { cause: error })
    }
}

async function stopHubProcess(): Promise<void> {
    const proc = hubProcess
    hubProcess = null
    if (!proc) return
    proc.stdout?.removeAllListeners()
    proc.stderr?.removeAllListeners()
    proc.stdout?.destroy()
    proc.stderr?.destroy()
    if (proc.exitCode !== null) return

    const { promise, resolve } = Promise.withResolvers<void>()
    const timeout = setTimeout(resolve, 3_000)
    proc.once('exit', () => {
        clearTimeout(timeout)
        resolve()
    })
    if (process.platform === 'win32' && proc.pid) {
        try {
            execSync(`taskkill /PID ${proc.pid} /T /F`, { stdio: 'ignore' })
        } catch {
            try { proc.kill() } catch { }
        }
    } else {
        try { proc.kill() } catch { }
    }
    await promise
}

export async function teardown() {
    await stopHubProcess()
    try { rmSync(TEST_CONFIG_FILE) } catch { }
    if (tmpHome && !retainFailedHome) {
        rmSync(tmpHome, { recursive: true, force: true })
    }
}
