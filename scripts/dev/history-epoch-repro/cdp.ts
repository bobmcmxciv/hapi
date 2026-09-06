// Minimal raw-CDP driver for the #323 reproduction (bypasses the agent-browser daemon).
// Usage (bun run .tmp/cdp323.ts <cmd> ...):
//   open <url>                         -> creates a new page target, prints targetId
//   eval <targetId> <js>               -> Runtime.evaluate (awaits promises), prints JSON value
//   evalfile <targetId> <path>         -> same, JS read from a file
//   key <targetId> <Key> [times] [gapMs] -> Input.dispatchKeyEvent for named keys (PageUp/PageDown/Home/End)
//   shot <targetId> <out.png>          -> Page.captureScreenshot
//   nav <targetId> <url>               -> Page.navigate + wait for load
//   close <targetId>
const CDP = process.env.CDP_URL ?? 'http://127.0.0.1:9222'

type Target = { id: string; type: string; url: string; webSocketDebuggerUrl: string }

async function listTargets(): Promise<Target[]> {
    return await (await fetch(`${CDP}/json/list`)).json() as Target[]
}

async function wsFor(targetId: string): Promise<string> {
    const t = (await listTargets()).find((x) => x.id === targetId)
    if (!t) throw new Error(`target ${targetId} not found`)
    return t.webSocketDebuggerUrl
}

class Session {
    private ws!: WebSocket
    private nextId = 1
    private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
    events: Array<{ method: string; params: unknown }> = []
    static async connect(url: string): Promise<Session> {
        const s = new Session()
        await new Promise<void>((resolve, reject) => {
            s.ws = new WebSocket(url)
            s.ws.onopen = () => resolve()
            s.ws.onerror = () => reject(new Error('ws error'))
            s.ws.onmessage = (ev) => {
                const msg = JSON.parse(String(ev.data)) as { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: unknown }
                if (msg.id !== undefined) {
                    const p = s.pending.get(msg.id)
                    if (!p) return
                    s.pending.delete(msg.id)
                    if (msg.error) p.reject(new Error(msg.error.message))
                    else p.resolve(msg.result)
                } else if (msg.method) {
                    s.events.push({ method: msg.method, params: msg.params })
                }
            }
        })
        return s
    }
    send<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
        const id = this.nextId++
        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)) }, timeoutMs)
            this.pending.set(id, {
                resolve: (v) => { clearTimeout(timer); resolve(v as T) },
                reject: (e) => { clearTimeout(timer); reject(e) }
            })
            this.ws.send(JSON.stringify({ id, method, params }))
        })
    }
    close() { this.ws.close() }
}

async function evaluate(s: Session, expression: string): Promise<unknown> {
    const r = await s.send<{ result: { value?: unknown; description?: string; type: string }; exceptionDetails?: { text: string; exception?: { description?: string } } }>(
        'Runtime.evaluate',
        { expression, awaitPromise: true, returnByValue: true }
    )
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
    return r.result.value ?? r.result.description ?? null
}

const KEYS: Record<string, { code: string; keyCode: number }> = {
    PageUp: { code: 'PageUp', keyCode: 33 },
    PageDown: { code: 'PageDown', keyCode: 34 },
    End: { code: 'End', keyCode: 35 },
    Home: { code: 'Home', keyCode: 36 },
    ArrowUp: { code: 'ArrowUp', keyCode: 38 },
    ArrowDown: { code: 'ArrowDown', keyCode: 40 }
}

const [cmd, ...args] = process.argv.slice(2)
if (cmd === 'open') {
    const url = args[0]
    const created = await (await fetch(`${CDP}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json() as Target
    const s = await Session.connect(created.webSocketDebuggerUrl)
    await s.send('Page.enable')
    await new Promise((r) => setTimeout(r, 2500))
    s.close()
    console.log(created.id)
} else if (cmd === 'openwin') {
    // openwin <url>: create the page in its own window so it owns a compositor and produces frames
    const version = await (await fetch(`${CDP}/json/version`)).json() as { webSocketDebuggerUrl: string }
    const b = await Session.connect(version.webSocketDebuggerUrl)
    const created = await b.send<{ targetId: string }>('Target.createTarget', { url: args[0], newWindow: true, width: 1280, height: 900 })
    b.close()
    await new Promise((r) => setTimeout(r, 2500))
    console.log(created.targetId)
} else if (cmd === 'wake') {
    // wake <targetId>: activate via the browser session, force lifecycle active + focus emulation, then test rAF
    const version = await (await fetch(`${CDP}/json/version`)).json() as { webSocketDebuggerUrl: string }
    const b = await Session.connect(version.webSocketDebuggerUrl)
    await b.send('Target.activateTarget', { targetId: args[0] })
    b.close()
    const s = await Session.connect(await wsFor(args[0]))
    await s.send('Page.enable')
    try { await s.send('Page.setWebLifecycleState', { state: 'active' }) } catch (e) { console.log('lifecycle:', (e as Error).message) }
    try { await s.send('Emulation.setFocusEmulationEnabled', { enabled: true }) } catch (e) { console.log('focus:', (e as Error).message) }
    try { await s.send('Page.bringToFront') } catch (e) { console.log('bringToFront:', (e as Error).message) }
    const raf = await evaluate(s, "Promise.race([new Promise(r => requestAnimationFrame(() => r('raf-fired'))), new Promise(r => setTimeout(() => r('raf-timeout-3s'), 3000))])")
    s.close()
    console.log(JSON.stringify({ raf }))
} else if (cmd === 'metrics') {
    // metrics <targetId> <width> <height>: shrink the emulated viewport to cut software-rendering cost
    const s = await Session.connect(await wsFor(args[0]))
    await s.send('Emulation.setDeviceMetricsOverride', { width: Number(args[1] ?? 800), height: Number(args[2] ?? 600), deviceScaleFactor: 1, mobile: false })
    s.close()
    console.log(`metrics ${args[1]}x${args[2]}`)
} else if (cmd === 'nav') {
    const s = await Session.connect(await wsFor(args[0]))
    await s.send('Page.enable')
    await s.send('Page.navigate', { url: args[1] })
    await new Promise((r) => setTimeout(r, 3000))
    s.close()
    console.log('ok')
} else if (cmd === 'eval' || cmd === 'evalfile') {
    const s = await Session.connect(await wsFor(args[0]))
    const js = cmd === 'evalfile' ? await Bun.file(args[1]).text() : args.slice(1).join(' ')
    try {
        console.log(JSON.stringify(await evaluate(s, js)))
    } finally {
        s.close()
    }
} else if (cmd === 'key') {
    const s = await Session.connect(await wsFor(args[0]))
    const key = KEYS[args[1]]
    if (!key) throw new Error(`unknown key ${args[1]}`)
    const times = Number(args[2] ?? 1)
    const gap = Number(args[3] ?? 350)
    for (let i = 0; i < times; i++) {
        await s.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: args[1], code: key.code, windowsVirtualKeyCode: key.keyCode, nativeVirtualKeyCode: key.keyCode })
        await s.send('Input.dispatchKeyEvent', { type: 'keyUp', key: args[1], code: key.code, windowsVirtualKeyCode: key.keyCode, nativeVirtualKeyCode: key.keyCode })
        await new Promise((r) => setTimeout(r, gap))
    }
    s.close()
    console.log(`pressed ${args[1]} x${times}`)
} else if (cmd === 'wheel') {
    // wheel <targetId> <deltaY> [times] [gapMs]  (negative deltaY = scroll up, dispatched at the chat viewport centre)
    const s = await Session.connect(await wsFor(args[0]))
    const deltaY = Number(args[1] ?? -300)
    const times = Number(args[2] ?? 1)
    const gap = Number(args[3] ?? 250)
    const rect = await evaluate(s, "(() => { const r = document.querySelector('.chat-scroll-y').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()") as { x: number; y: number }
    for (let i = 0; i < times; i++) {
        await s.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: rect.x, y: rect.y, deltaX: 0, deltaY })
        await new Promise((r) => setTimeout(r, gap))
    }
    s.close()
    console.log(`wheel ${deltaY} x${times} at ${Math.round(rect.x)},${Math.round(rect.y)}`)
} else if (cmd === 'shot') {
    const s = await Session.connect(await wsFor(args[0]))
    await s.send('Page.enable')
    await fetch(`${CDP}/json/activate/${args[0]}`)
    await s.send('Page.bringToFront')
    await s.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
    await new Promise((r) => setTimeout(r, 600))
    const r = await s.send<{ data: string }>('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, 45_000)
    await Bun.write(args[1], Buffer.from(r.data, 'base64'))
    s.close()
    console.log(args[1])
} else if (cmd === 'netwatch') {
    // netwatch <targetId> <url> <ms>: navigate and record every /api/ request's lifecycle for <ms>
    const s = await Session.connect(await wsFor(args[0]))
    await s.send('Network.enable')
    await s.send('Page.enable')
    await s.send('Page.navigate', { url: args[1] })
    await new Promise((r) => setTimeout(r, Number(args[2] ?? 8000)))
    const reqs = new Map<string, { url: string; status?: number; done?: string; t: number }>()
    for (const ev of s.events) {
        const p = ev.params as Record<string, unknown>
        if (ev.method === 'Network.requestWillBeSent') {
            const req = p.request as { url: string }
            if (req.url.includes('/api/')) reqs.set(p.requestId as string, { url: req.url.replace(/^https?:\/\/[^/]+/, '').slice(0, 110), t: p.timestamp as number })
        } else if (ev.method === 'Network.responseReceived') {
            const r = reqs.get(p.requestId as string); if (r) r.status = (p.response as { status: number }).status
        } else if (ev.method === 'Network.loadingFinished') {
            const r = reqs.get(p.requestId as string); if (r) r.done = 'finished'
        } else if (ev.method === 'Network.loadingFailed') {
            const r = reqs.get(p.requestId as string); if (r) r.done = 'failed:' + String((p as { errorText?: string }).errorText)
        }
    }
    const list = [...reqs.values()].sort((a, b) => a.t - b.t)
    for (const r of list) console.log(`${r.done ?? 'PENDING'}\t${r.status ?? '-'}\t${r.url}`)
    s.close()
} else if (cmd === 'close') {
    await fetch(`${CDP}/json/close/${args[0]}`)
    console.log('closed')
} else {
    console.error('usage: open <url> | nav <t> <url> | eval <t> <js> | evalfile <t> <path> | key <t> <Key> [times] [gapMs] | shot <t> <png> | close <t>')
    process.exit(2)
}
