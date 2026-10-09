import type { SessionRelayConfig } from './config'

/**
 * fork(session-relay): decides when a long-running session hands its work to a
 * fresh one, and drives the handover through the hub API.
 *
 *   watching ──(context over threshold, or OMP just compacted)──▶ requested
 *     · steers the running agent: write the handover file, then end the run
 *   requested ──(file written and run ended | file settled | max wait)──▶ relaying
 *     · aborts a run that is still going, spawns the successor with the same
 *       machine / directory / agent / model / effort / permission mode, sends it
 *       the kickoff message, archives this session
 *
 * A successor is spawned at most once: if anything after the spawn fails, the
 * retry only resends the kickoff and the archive request, so the project never
 * ends up with two agents driving the same game.
 */

export type RelayContextUsage = {
    tokens: number
    contextWindow: number | null
}

export type SessionRelayLaunch = {
    machineId: string
    directory: string
    agent: 'omp'
    model?: string
    effort?: string
    permissionMode?: string
}

export type SessionRelayHub = {
    sendMessage: (sessionId: string, text: string, options?: { steer?: boolean }) => Promise<void>
    spawnSession: (launch: SessionRelayLaunch) => Promise<string>
    archiveSession: (sessionId: string) => Promise<void>
}

export type SessionRelayDeps = {
    config: SessionRelayConfig
    /** Hub session id of this session. */
    sessionId: string
    directory: string
    hub: SessionRelayHub
    readContextUsage: () => Promise<RelayContextUsage | null>
    /** Settings the successor is started with; null while the machine id is unknown. */
    launchSettings: () => Omit<SessionRelayLaunch, 'directory' | 'agent'> | null
    handoffFileMtimeMs: () => Promise<number | null>
    isIdle: () => boolean
    abortRun: () => Promise<void>
    /** Visible status line in this session's transcript. */
    notify: (message: string) => void
    log: (message: string, error?: unknown) => void
    now?: () => number
}

export type SessionRelayPhase = 'watching' | 'requested' | 'relaying' | 'done'
type RelayReason = 'tokens' | 'percent' | 'compaction'

const REQUEST_RETRY_MS = 10 * 60 * 1000
const RELAY_RETRY_MS = 30 * 60 * 1000
/** Once the successor exists only the kickoff / archive is left; retry those soon. */
const FINISH_RETRY_MS = 60 * 1000

export class SessionRelayController {
    private phase: SessionRelayPhase = 'watching'
    private baselineTokens: number | null = null
    private compactionSeen = false
    private requestedAt = 0
    private retryAfter = 0
    private successorId: string | null = null
    private successorBriefed = false
    private busy = false
    private readonly now: () => number

    constructor(private readonly deps: SessionRelayDeps) {
        this.now = deps.now ?? Date.now
    }

    get currentPhase(): SessionRelayPhase {
        return this.phase
    }

    onCompactionCompleted(): void {
        if (!this.deps.config.relayAfterCompaction) return
        this.compactionSeen = true
        void this.tick()
    }

    onTurnFinished(): void {
        void this.tick()
    }

    async tick(): Promise<void> {
        if (this.busy || this.phase === 'done') return
        this.busy = true
        try {
            if (this.now() < this.retryAfter) return
            if (this.phase === 'watching') {
                await this.watch()
            } else {
                await this.maybeRelay()
            }
        } catch (error) {
            this.deps.log('[session-relay] tick failed', error)
        } finally {
            this.busy = false
        }
    }

    private async watch(): Promise<void> {
        const usage = await this.deps.readContextUsage()
        if (usage && this.baselineTokens === null) {
            this.baselineTokens = usage.tokens
        }
        const reason = this.relayReason(usage)
        if (!reason) return
        const text = buildHandoffRequest(this.deps.config, usage, reason)
        try {
            await this.deps.hub.sendMessage(this.deps.sessionId, text, { steer: true })
        } catch (error) {
            this.deps.log('[session-relay] could not send the handover request', error)
            this.retryAfter = this.now() + REQUEST_RETRY_MS
            return
        }
        this.phase = 'requested'
        this.requestedAt = this.now()
        this.deps.log(`[session-relay] handover requested (${reason}, ${usage?.tokens ?? '?'} tokens)`)
    }

    private relayReason(usage: RelayContextUsage | null): RelayReason | null {
        const config = this.deps.config
        if (this.compactionSeen) return 'compaction'
        if (!usage) return null
        if (usage.tokens - (this.baselineTokens ?? usage.tokens) < config.minGrowthTokens) return null
        if (usage.tokens >= config.thresholdTokens) return 'tokens'
        if (usage.contextWindow && (usage.tokens / usage.contextWindow) * 100 >= config.thresholdPercent) {
            return 'percent'
        }
        return null
    }

    private async maybeRelay(): Promise<void> {
        const config = this.deps.config
        const now = this.now()
        const mtime = await this.deps.handoffFileMtimeMs()
        const handoffWritten = mtime !== null && mtime >= this.requestedAt
        const settled = handoffWritten && now - (mtime ?? now) >= config.settleMinutes * 60_000
        const timedOut = now - this.requestedAt >= config.maxWaitMinutes * 60_000
        if (!((handoffWritten && this.deps.isIdle()) || settled || timedOut)) return
        await this.relay(handoffWritten)
    }

    private async relay(handoffWritten: boolean): Promise<void> {
        this.phase = 'relaying'
        try {
            if (!this.successorId) {
                const launch = this.deps.launchSettings()
                if (!launch) throw new Error('machine id of this session is unknown')
                if (!this.deps.isIdle()) {
                    await this.deps.abortRun()
                }
                this.successorId = await this.deps.hub.spawnSession({
                    ...launch,
                    directory: this.deps.directory,
                    agent: 'omp'
                })
                this.deps.log(`[session-relay] successor spawned: ${this.successorId}`)
            }
            if (!this.successorBriefed) {
                await this.deps.hub.sendMessage(
                    this.successorId,
                    buildKickoff(this.deps.config, this.deps.sessionId, handoffWritten)
                )
                this.successorBriefed = true
                this.deps.notify(`会话接力：工作已交给新会话 ${this.successorId}，本会话随即归档。`)
            }
            this.phase = 'done'
            await this.deps.hub.archiveSession(this.deps.sessionId)
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error)
            this.deps.log('[session-relay] relay failed', error)
            this.phase = 'requested'
            this.retryAfter = this.now() + (this.successorId ? FINISH_RETRY_MS : RELAY_RETRY_MS)
            this.deps.notify(this.successorId
                ? `会话接力：新会话 ${this.successorId} 已启动，但${this.successorBriefed ? '本会话归档' : '交接消息发送'}失败（${detail}），1 分钟后重试。`
                : `会话接力失败（${detail}），本会话继续运行，30 分钟后重试。`)
        }
    }
}

export function buildHandoffRequest(
    config: SessionRelayConfig,
    usage: RelayContextUsage | null,
    reason: RelayReason
): string {
    const share = usage?.contextWindow ? `，占窗口 ${Math.round((usage.tokens / usage.contextWindow) * 100)}%` : ''
    const why = reason === 'compaction'
        ? '本会话的上下文刚刚被自动压缩过'
        : `本会话上下文已用 ${usage?.tokens ?? '?'} tokens${share}`
    return [
        `【HAPI 会话接力】${why}，HAPI 将换到一个新会话继续这项工作。请现在：`,
        `1. 把交接写入 ${config.handoffFile}（整体覆盖，写给一个没有任何上下文的接手者）：目标、当前进度、正在进行的操作和它的状态、未完成事项、下一步、踩过的坑。`,
        '2. 不要再启动新的长时间等待或新任务；已经在后台运行的任务保持原样，在交接里写清楚怎么检查它。',
        '3. 写完后只回复一行 RELAY-READY，然后结束本轮。',
        'HAPI 会新开会话、把交接文件交给它，然后归档本会话。',
        ...(config.handoffNotes ? [config.handoffNotes] : [])
    ].join('\n')
}

export function buildKickoff(config: SessionRelayConfig, previousSessionId: string, handoffWritten: boolean): string {
    return [
        `【HAPI 会话接力】你接替会话 ${previousSessionId}。上一会话的上下文已满，已归档。`,
        `先完整阅读 ${config.handoffFile}（上一会话留下的交接），再按其中的下一步继续；已完成的步骤不要重做，项目规则照旧。`,
        ...(handoffWritten
            ? []
            : ['注意：上一会话没有在时限内更新交接文件，内容可能不是最新的。先核对当前的实际状态（日志、截图、进程）再继续。']),
        ...(config.kickoffNotes ? [config.kickoffNotes] : [])
    ].join('\n')
}
