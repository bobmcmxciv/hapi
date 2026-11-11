import { useEffect, useMemo, useRef, useState } from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider, createMemoryHistory, createRootRoute, createRouter } from '@tanstack/react-router'
import '../src/index.css'
import { I18nProvider } from '../src/lib/i18n-context'
import { ToastProvider } from '../src/lib/toast-context'
import { AppContextProvider } from '../src/lib/app-context'
import { BetaThreadView } from '../src/fork-features/beta-timeline/BetaThread'
import { BetaTimelineStore } from '../src/fork-features/beta-timeline/store'
import { buildConversationOutline } from '../src/chat/outline'
import type { ChatBlock, ToolCallBlock } from '../src/chat/types'
import type { VisibleChatBlock } from '../src/chat/toolGroups'
import type { ApiClient } from '../src/api/client'
import type { Session } from '../src/types/api'
import type { RuntimeItem, RuntimePublication, RuntimeRun, RuntimeStopReason } from '@hapi/protocol/runtimeTimeline'

// Offline-only driver. Exercises the *real* projection/store/virtualized view;
// no hub or model is required. Not an ECS/backend end-to-end proof.
const AT = 1_780_000_000_000
const TOTAL = 3000
const INITIAL_START = 1800
const allHistory: ChatBlock[] = Array.from({ length: TOTAL }, (_, i) => {
    // Last 199 assistant blocks form one deliberately offscreen-spanning turn.
    const user = i < 2800 ? i % 2 === 0 : i === 2800
    return {
        kind: user ? 'user-text' : 'agent-text', id: `fixture-${i}`, localId: `local-${i}`,
        createdAt: AT + i * 1000, invokedAt: AT + i * 1000,
        text: user ? `History question ${i}: verify scroll ownership` : `Assistant answer **${i}**.\n\nSafe [external link](https://example.com) and code \`row ${i}\`.\n\n${'Historical content. '.repeat(i % 5 + 1)}`,
        status: user ? 'sent' : undefined
    } as ChatBlock
})
const fixtureSession = {
    id: 'beta-fixture', namespace: 'fixture', seq: 1, createdAt: AT, updatedAt: AT + TOTAL * 1000,
    active: true, activeAt: AT, metadata: { flavor: 'omp', path: '/fixture', name: 'Beta offline timeline', capabilities: { conversationHistory: { forkCurrent: true, forkAtMessage: true, rewindToMessage: true } }, conversationHistoryPoints: { 'local-2800': true } },
    metadataVersion: 1, agentState: null, agentStateVersion: 1, thinking: false, thinkingAt: 0,
    model: null, modelReasoningEffort: null, effort: null, serviceTier: null, resumeWithSessionModel: false
} as Session
const api = {
    getMachines: async () => ({ machines: [] }),
    getFlavorCapabilities: async () => ({ capabilities: { omp: { fork: 'at-message', files: 'none' } } }),
    approvePermission: async () => { }, denyPermission: async () => { },
    forkSession: async () => ({ type: 'blocked', reason: 'Offline fixture does not create server sessions' }),
    getGeneratedFileBlob: async () => new Blob(['fixture download'], { type: 'text/plain' })
} as unknown as ApiClient

export type TailFrame = { top: number; height: number; mounted: number; visible: number; tailBottom: number | null; gap: number }
type Probe = {
    mountedRows: () => number
    totalRows: () => number
    nodeCount: () => number
    maximumMountedRows: number
    publications: number
    start: () => void
    finish: (reason?: RuntimeStopReason) => void
    prepend: () => void
    growTail: () => void
    publishRuntime: (publication: RuntimePublication) => void
    loadDelay: number
    failLoad: boolean
    viewMode: 'tail' | 'history'
    captureTailJump: (frames?: number) => Promise<TailFrame[]>
}
declare global { interface Window { __betaProbe: Probe } }

function Fixture() {
    const store = useMemo(() => new BetaTimelineStore(), [])
    const [history, setHistory] = useState<readonly VisibleChatBlock[]>(() => allHistory.slice(INITIAL_START))
    const [startIndex, setStartIndex] = useState(INITIAL_START)
    const startRef = useRef(startIndex)
    const [historyVersion, setHistoryVersion] = useState(1)
    const [outline, setOutline] = useState(false)
    const [force, setForce] = useState(0)
    const [session, setSession] = useState(fixtureSession)
    const [stats, setStats] = useState('')
    const seq = useRef(0)
    const run = useRef<RuntimeRun | null>(null)
    const item = useRef<RuntimeItem | null>(null)
    const clock = useRef<number | null>(null)
    const runCounter = useRef(0)
    const [actions, setActions] = useState<string[]>([])
    const initialized = useRef(false)
    if (!initialized.current) {
        store.setHistory(history)
        store.setConnection('live')
        initialized.current = true
    }
    useEffect(() => { store.setHistory(history) }, [history, store])
    const publish = (nextItem: RuntimeItem, nextRun: RuntimeRun) => {
        item.current = nextItem
        run.current = nextRun
        const changes = [{ type: 'item' as const, item: nextItem }, { type: 'run' as const, run: nextRun }]
        if (seq.current === 0) {
            store.applyPublication({ kind: 'snapshot', snapshot: { version: 1, epoch: 'fixture-epoch', seq: 0, items: [nextItem], run: nextRun, updatedAt: Date.now() } })
        } else {
            store.applyPublication({ kind: 'patch', patch: { version: 1, epoch: 'fixture-epoch', seq: seq.current, changes, updatedAt: Date.now() } })
        }
        seq.current += 1
        window.__betaProbe.publications += 1
    }
    const stopClock = () => { if (clock.current !== null) window.clearInterval(clock.current); clock.current = null }
    const start = () => {
        stopClock()
        const number = ++runCounter.current
        const now = Date.now()
        const nextRun: RuntimeRun = { id: `run-${number}`, state: 'running', startedAt: now }
        const nextItem: RuntimeItem = { id: `native-${number}`, canonicalId: `canonical-native-${number}`, kind: 'assistant', runId: nextRun.id, state: 'running', createdAt: now, updatedAt: now, text: '', reasoning: 'Native thinking updates are independently subscribed.' }
        publish(nextItem, nextRun)
        clock.current = window.setInterval(() => {
            if (!item.current || !run.current) return
            publish({ ...item.current, text: `${item.current.text ?? ''}token ${seq.current} · `, updatedAt: Date.now() }, run.current)
        }, 60)
    }
    const finish = (reason: RuntimeStopReason = 'stop') => {
        stopClock()
        if (!item.current || !run.current) return
        const state = reason === 'aborted' ? 'aborted' : reason === 'error' ? 'error' : 'completed'
        const next = { ...item.current, state, stopReason: reason, updatedAt: Date.now(), errorMessage: reason === 'error' ? 'Fixture native terminal error' : undefined } as RuntimeItem
        publish(next, { ...run.current, state: reason === 'aborted' ? 'aborted' : reason === 'error' ? 'error' : 'idle', endedAt: Date.now(), stopReason: reason, errorMessage: next.errorMessage })
        // Canonical arrival supersedes the temporary representation, retaining
        // stop reason and the entire answer (not just the mounted viewport).
        const block: ChatBlock = { kind: 'agent-text', id: `${next.canonicalId}:0`, localId: null, createdAt: next.createdAt, text: next.text || 'No assistant text before termination.', meta: { runtimeCanonicalId: next.canonicalId, runtimeRunId: next.runId, runtimeStopReason: reason, runtimeErrorMessage: next.errorMessage } }
        setHistory((old) => [...old, block])
    }
    const prepend = () => {
        const end = startRef.current
        const next = Math.max(0, end - 100)
        startRef.current = next
        setStartIndex(next)
        setHistory((old) => [...allHistory.slice(next, end), ...old])
        setHistoryVersion((old) => old + 1)
    }
    const growTail = () => setHistory((old) => old.map((row, i) => i === old.length - 1 && row.kind === 'agent-text'
        ? { ...row, text: row.text + '\n\n' + 'Tail growth paragraph.\n\n'.repeat(20) }
        : row))
    const question = () => {
        const now = Date.now()
        const block: ToolCallBlock = {
            kind: 'tool-call', id: 'fixture-question-block', localId: null, createdAt: now, children: [],
            tool: { id: 'fixture-question', name: 'AskUserQuestion', state: 'pending', input: { questions: [{ question: 'Do pending questions remain reachable outside the virtual window?', header: 'Beta', options: [{ label: 'Yes', description: 'Exercise the real question footer' }, { label: 'No', description: 'Inspect failure' }], multiSelect: false }] }, createdAt: now, startedAt: null, completedAt: null, execStartedAt: null, execCompletedAt: null, description: null, permission: { id: 'fixture-question', status: 'pending' } }
        }
        setHistory((old) => [...old.filter((row) => row.id !== block.id), block])
        setSession((old) => ({ ...old, agentState: { requests: { 'fixture-question': { tool: 'AskUserQuestion', arguments: block.tool.input, createdAt: now } } } }))
    }
    useEffect(() => {
        const update = () => {
            const mounted = document.querySelectorAll('.beta-viewport [data-beta-row-id]').length
            window.__betaProbe.maximumMountedRows = Math.max(mounted, window.__betaProbe.maximumMountedRows)
            setStats(`mounted ${mounted} / ${store.getRows().length} · active DOM nodes ${document.querySelector('.beta-viewport')?.querySelectorAll('*').length ?? 0}`)
        }
        const observer = new MutationObserver(update)
        observer.observe(document.querySelector('.beta-viewport')!, { childList: true, subtree: true })
        update()
        return () => { observer.disconnect(); stopClock(); store.dispose() }
    }, [store])
    window.__betaProbe = {
        ...window.__betaProbe,
        mountedRows: () => document.querySelectorAll('.beta-viewport [data-beta-row-id]').length,
        totalRows: () => store.getRows().length,
        nodeCount: () => document.querySelector('.beta-viewport')?.querySelectorAll('*').length ?? 0,
        start, finish, prepend, growTail,
        publishRuntime: store.applyPublication,
        captureTailJump: (count = 75) => {
            const { promise, resolve } = Promise.withResolvers<TailFrame[]>()
            const viewport = document.querySelector<HTMLElement>('.beta-viewport')!
            const frames: TailFrame[] = []
            const sample = () => {
                const bounds = viewport.getBoundingClientRect()
                const nodes = [...viewport.querySelectorAll<HTMLElement>('[data-beta-measure-id]')]
                const last = nodes.at(-1)
                frames.push({
                    top: viewport.scrollTop, height: viewport.scrollHeight, mounted: nodes.length,
                    visible: nodes.filter((node) => { const box = node.getBoundingClientRect(); return box.bottom > bounds.top && box.top < bounds.bottom }).length,
                    tailBottom: last ? last.getBoundingClientRect().bottom - bounds.bottom : null,
                    gap: viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop
                })
                if (frames.length < count) requestAnimationFrame(sample)
                else resolve(frames)
            }
            document.querySelector<HTMLButtonElement>('.beta-jump-tail')!.click()
            requestAnimationFrame(sample)
            return promise
        }
    }
    return <div className="flex h-screen min-h-0 flex-col">
        <header className="flex shrink-0 flex-wrap items-center gap-2 border-b p-2 text-xs">
            <strong>OFFLINE beta fixture</strong><output data-testid="beta-counts">{stats}</output>
            <button onClick={start}>Live</button><button onClick={() => finish()}>Finalize</button><button onClick={() => finish('aborted')}>Abort</button><button onClick={() => finish('length')}>Length</button><button onClick={() => finish('error')}>Error</button>
            <button onClick={prepend}>Prepend 100</button><button onClick={() => setOutline(true)}>Outline</button><button onClick={() => setForce((n) => n + 1)}>Tail</button><button onClick={question}>Question</button>
            <button onClick={growTail}>Grow tail</button>
            <button onClick={() => {
                stopClock()
                const now = Date.now()
                const process: ToolCallBlock[] = Array.from({ length: 220 }, (_, i) => ({
                    kind: 'tool-call', id: `long-process-${i}`, localId: null, createdAt: now + i + 1, children: [],
                    tool: { id: `long-process-${i}`, name: 'Bash', state: i === 80 ? 'error' : 'completed', input: { command: `inspect-step-${i}` }, result: `Process step ${i}\n${'Measured process output. '.repeat(30)}`, createdAt: now + i + 1, startedAt: now + i + 1, completedAt: now + i + 2, execStartedAt: null, execCompletedAt: null, description: null }
                }))
                startRef.current = 0
                setStartIndex(0)
                setHistory([
                    { kind: 'user-text', id: 'long-process-user', localId: null, createdAt: now, invokedAt: now, text: 'Review the long execution process, then collapse midway.', status: 'sent' },
                    ...process,
                    { kind: 'agent-text', id: 'long-process-answer', localId: null, createdAt: now + 230, text: 'Final result remains after collapsing the execution process.\n\n' + 'Final answer paragraph outside the execution details.\n\n'.repeat(40) }
                ])
                setHistoryVersion(value => value + 1)
                setSession(value => ({ ...value, thinking: false, agentState: null }))
            }}>Long process</button>
            <button onClick={() => {
                stopClock()
                const now = Date.now()
                const tools: ToolCallBlock[] = ['completed', 'error', 'running'].map((state, i) => ({
                    kind: 'tool-call', id: `feedback-tool-${i}`, localId: null, createdAt: now + i * 2 + 1, children: [],
                    tool: { id: `feedback-tool-${i}`, name: 'read', state: state as 'completed' | 'error' | 'running', input: { i: 'Inspecting source', path: `C:/workspace/source-${i}.tsx:10-30` }, result: state === 'error' ? 'Permission denied' : undefined, createdAt: now + i * 2 + 1, startedAt: now, completedAt: state === 'running' ? null : now + i * 2 + 2, execStartedAt: null, execCompletedAt: null, description: null }
                }))
                startRef.current = 0
                setStartIndex(0)
                setHistory([
                    { kind: 'user-text', id: 'feedback-user', localId: null, createdAt: now, invokedAt: now, text: '检查源文件并报告进度。', status: 'sent' },
                    tools[0],
                    { kind: 'agent-text', id: 'feedback-progress', localId: null, createdAt: now + 2, text: '第一段完整文字应始终显示，前后的工具可以分别折叠。' },
                    tools[1],
                    { kind: 'agent-text', id: 'feedback-answer', localId: null, createdAt: now + 4, text: '已定位权限问题，继续检查剩余文件。' },
                    tools[2]
                ])
                setHistoryVersion(value => value + 1)
                setSession(value => ({ ...value, thinking: true, agentState: null }))
                setForce(value => value + 1)
            }}>Feedback segments</button>
            <button onClick={() => store.setConnection('legacy')}>Legacy</button><button onClick={() => store.setConnection('reconnecting')}>Reconnect</button><button onClick={() => store.setConnection('live')}>Connected</button>
            <button onClick={() => {
                setHistory((old) => old.map((row, i) => i === 1 && row.kind === 'agent-text'
                    ? { ...row, text: row.text + '\n\n' + 'Dynamic resize paragraph.\n\n'.repeat(50) }
                    : row))
            }}>Grow old row</button>
            <output>{actions.join(' · ')}</output>
        </header>
        <BetaThreadView store={store} api={api} session={session} sessionId={session.id} metadata={session.metadata} historyBlocks={history} disabled={false} onRefresh={() => setSession((old) => ({ ...old, agentState: null }))}
            onRetryMessage={(id) => setActions((old) => [...old, `retry:${id}`])} onForkConversation={async (id) => setActions((old) => [...old, `fork:${id ?? 'current'}`])} onRewindConversation={async (id) => setActions((old) => [...old, `rewind:${id}`])} isLatestCompletedBoundary={(id) => id === 'agent-text:fixture-2801'}
            onViewModeChange={(mode) => { window.__betaProbe.viewMode = mode }} isSyncingTail={false} messagesWarning={null} hasMoreMessages={startIndex > 0} isLoadingMoreMessages={false}
            onLoadMore={async (before) => {
                if (window.__betaProbe.loadDelay) {
                    const { promise, resolve } = Promise.withResolvers<void>()
                    window.setTimeout(resolve, window.__betaProbe.loadDelay)
                    await promise
                }
                if (window.__betaProbe.failLoad) return { kind: 'failed', error: new Error('Controlled fixture history failure') }
                if (startRef.current === 0) return { kind: 'stopped', reason: 'exhausted' }
                const next = historyVersion + 1
                if (before && !before(next)) return { kind: 'stopped', reason: 'invalidated' }
                prepend()
                return { kind: 'applied', historyVersion: next, hasMore: startRef.current > 0, addedRenderableCount: 100 }
            }} onCancelLoadMore={() => { }}
            unseenCount={0} rawMessagesCount={history.length} normalizedMessagesCount={history.length} messagesVersion={history.length} historyVersion={historyVersion} forceScrollToken={force} outlineOpen={outline} outlineItems={buildConversationOutline(history as ChatBlock[])} onOutlineOpenChange={setOutline} />
    </div >
}
window.__betaProbe = { maximumMountedRows: 0, publications: 0, loadDelay: 0, failLoad: false, viewMode: 'tail' } as Probe
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
const rootRoute = createRootRoute({ component: Fixture })
const router = createRouter({ routeTree: rootRoute, history: createMemoryHistory({ initialEntries: ['/'] }) }) as unknown as Parameters<typeof RouterProvider>[0]['router']
ReactDOM.createRoot(document.getElementById('root')!).render(
    <QueryClientProvider client={queryClient}><ToastProvider><I18nProvider><AppContextProvider value={{ api, token: 'fixture', baseUrl: window.location.origin }}><RouterProvider router={router} /></AppContextProvider></I18nProvider></ToastProvider></QueryClientProvider>
)
