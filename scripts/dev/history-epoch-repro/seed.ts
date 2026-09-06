// Real-path seeder for the #323 mechanism-1 reproduction.
// Talks to a running hub exactly like a CLI does: REST session create + socket.io /cli `message` events.
// Usage:
//   bun run .tmp/seed323.ts seed <count>        -> creates a codex-flavored session and streams <count> agent messages
//   bun run .tmp/seed323.ts bump <sid> <msBack> -> sends ONE agent message whose createdAt is <msBack> ms before now
//                                                   (hub stamps position < head -> bumpMessageEpoch, real SSE fan-out)
//   bun run .tmp/seed323.ts append <sid> <n>    -> sends <n> in-order agent messages (no epoch change)
import { io } from 'socket.io-client'
import { readFileSync } from 'node:fs'

const HUB = process.env.HUB_URL ?? 'http://127.0.0.1:3399'
const HOME = process.env.HAPI_HOME ?? '.tmp/hub323'
const token: string = JSON.parse(readFileSync(`${HOME}/settings.json`, 'utf8')).cliApiToken

function agentMessage(text: string) {
    return {
        role: 'agent',
        content: { type: 'codex', data: { type: 'message', message: text } }
    }
}

async function createSession(tag: string): Promise<string> {
    const res = await fetch(`${HUB}/cli/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
            tag,
            metadata: { path: process.cwd(), host: 'local', flavor: 'codex', name: `#323 repro ${tag}` },
            agentState: null
        })
    })
    if (!res.ok) throw new Error(`create session http ${res.status}: ${await res.text()}`)
    const body = await res.json() as { session: { id: string } }
    return body.session.id
}

function connect(): Promise<ReturnType<typeof io>> {
    return new Promise((resolve, reject) => {
        const socket = io(`${HUB}/cli`, { auth: { token, clientType: 'session-scoped' }, transports: ['websocket'] })
        socket.on('connect', () => resolve(socket))
        socket.on('connect_error', (err) => reject(err))
    })
}

async function sendBatch(socket: ReturnType<typeof io>, sid: string, items: Array<{ text: string; createdAt: number }>) {
    for (const item of items) {
        socket.emit('message', { sid, message: agentMessage(item.text), createdAt: item.createdAt })
        // keep the hub's per-socket ordering deterministic without flooding
        if (items.length > 50) await new Promise((r) => setTimeout(r, 2))
    }
}

async function countMessages(sid: string): Promise<{ epoch: number; headAt: number | null; headSeq: number | null }> {
    const auth = await fetch(`${HUB}/api/auth`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accessToken: token })
    })
    const { token: jwt } = await auth.json() as { token: string }
    const page = await fetch(`${HUB}/api/sessions/${sid}/messages?limit=1`, { headers: { authorization: `Bearer ${jwt}` } })
    if (!page.ok) throw new Error(`page http ${page.status}: ${await page.text()}`)
    const pageBody = await page.json() as { page: { epoch: number; snapshotHeadAt: number | null; snapshotHeadSeq: number | null } }
    return { epoch: pageBody.page.epoch, headAt: pageBody.page.snapshotHeadAt, headSeq: pageBody.page.snapshotHeadSeq }
}

function userMessage(text: string) {
    return { role: 'user', content: { type: 'text', text } }
}

const [mode, a, b] = process.argv.slice(2)
if (mode === 'seedmix') {
    // alternating user / agent rows so every row is its own thread message (assistant-ui joins adjacent agent text)
    const count = Number(a ?? 850)
    const sid = await createSession(`repro-323-mix-${Date.now()}`)
    const socket = await connect()
    const base = Date.now() - count * 1000
    for (let i = 0; i < count; i++) {
        const n = String(i + 1).padStart(4, '0')
        const createdAt = base + i * 1000
        const message = i % 2 === 0
            ? userMessage(`Q#${n}: user question number ${n}`)
            : agentMessage(`A#${n}: agent answer number ${n} — filler so the row has some height`)
        socket.emit('message', { sid, message, createdAt })
        await new Promise((r) => setTimeout(r, 2))
    }
    await new Promise((r) => setTimeout(r, 1500))
    socket.close()
    console.log(JSON.stringify({ sid, ...(await countMessages(sid)) }))
} else if (mode === 'seed') {
    const count = Number(a ?? 850)
    const sid = await createSession(`repro-323-${Date.now()}`)
    const socket = await connect()
    const base = Date.now() - count * 1000
    await sendBatch(socket, sid, Array.from({ length: count }, (_, i) => ({
        text: `seed #${String(i + 1).padStart(4, '0')} — history filler line so the row has some height`,
        createdAt: base + i * 1000
    })))
    await new Promise((r) => setTimeout(r, 1500))
    socket.close()
    console.log(JSON.stringify({ sid, ...(await countMessages(sid)) }))
} else if (mode === 'bump') {
    const sid = a
    const msBack = Number(b ?? 120_000)
    const socket = await connect()
    const createdAt = Date.now() - msBack
    await sendBatch(socket, sid, [{ text: `OUT-OF-ORDER insert @${new Date(createdAt).toISOString()}`, createdAt }])
    await new Promise((r) => setTimeout(r, 800))
    socket.close()
    console.log(JSON.stringify({ sid, sentCreatedAt: createdAt, ...(await countMessages(sid)) }))
} else if (mode === 'thinking') {
    // thinking <sid> <true|false>: real CLI 'session-alive' heartbeat toggling the running state
    const sid = a
    const thinking = b === 'true'
    const socket = await connect()
    socket.emit('session-alive', { sid, time: Date.now(), thinking, mode: 'remote' })
    await new Promise((r) => setTimeout(r, 800))
    socket.close()
    console.log(JSON.stringify({ sid, thinking }))
} else if (mode === 'appenduser') {
    // appenduser <sid> <n>: in-order user rows (no localId → invoked immediately by the hub)
    const sid = a
    const n = Number(b ?? 1)
    const socket = await connect()
    const now = Date.now()
    for (let i = 0; i < n; i++) {
        socket.emit('message', { sid, message: userMessage(`user append #${i + 1}`), createdAt: now + i })
        await new Promise((r) => setTimeout(r, 2))
    }
    await new Promise((r) => setTimeout(r, 800))
    socket.close()
    console.log(JSON.stringify({ sid, ...(await countMessages(sid)) }))
} else if (mode === 'append') {
    const sid = a
    const n = Number(b ?? 1)
    const socket = await connect()
    const now = Date.now()
    await sendBatch(socket, sid, Array.from({ length: n }, (_, i) => ({ text: `append #${i + 1}`, createdAt: now + i })))
    await new Promise((r) => setTimeout(r, 800))
    socket.close()
    console.log(JSON.stringify({ sid, ...(await countMessages(sid)) }))
} else {
    console.error('usage: seed <count> | bump <sid> <msBack> | append <sid> <n>')
    process.exit(2)
}
