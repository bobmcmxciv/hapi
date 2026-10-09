import { stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { configuration } from '../../cli/src/configuration'
import { getAuthToken } from '../../cli/src/api/auth'
import { logger } from '../../cli/src/ui/logger'
import { loadSessionRelayConfig, SESSION_RELAY_CONFIG_PATH } from './config'
import { SessionRelayController, type RelayContextUsage, type SessionRelayLaunch } from './controller'
import { createSessionRelayHub } from './hubClient'

const TICK_MS = 60_000

export type OmpSessionRelay = {
    controller: SessionRelayController
    stop: () => void
}

/**
 * fork(session-relay): wires the relay controller into an OMP remote session.
 * Returns null when the project has no `.hapi/session-relay.json`.
 */
export async function startOmpSessionRelay(args: {
    cwd: string
    hubSessionId: string
    launchSettings: () => Omit<SessionRelayLaunch, 'directory' | 'agent'> | null
    readContextUsage: () => Promise<RelayContextUsage | null>
    isIdle: () => boolean
    abortRun: () => Promise<void>
    notify: (message: string) => void
}): Promise<OmpSessionRelay | null> {
    let config
    try {
        config = await loadSessionRelayConfig(args.cwd)
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        args.notify(`会话接力未启用：${SESSION_RELAY_CONFIG_PATH} 无法解析（${detail}）。`)
        return null
    }
    if (!config) return null

    const handoffPath = isAbsolute(config.handoffFile) ? config.handoffFile : join(args.cwd, config.handoffFile)
    const controller = new SessionRelayController({
        config,
        sessionId: args.hubSessionId,
        directory: args.cwd,
        hub: createSessionRelayHub({ apiUrl: configuration.apiUrl, accessToken: getAuthToken() }),
        readContextUsage: args.readContextUsage,
        launchSettings: args.launchSettings,
        handoffFileMtimeMs: async () => {
            try {
                return (await stat(handoffPath)).mtimeMs
            } catch {
                return null
            }
        },
        isIdle: args.isIdle,
        abortRun: args.abortRun,
        notify: args.notify,
        log: (message, error) => (error === undefined ? logger.debug(message) : logger.warn(message, error))
    })
    const timer = setInterval(() => void controller.tick(), TICK_MS)
    timer.unref?.()
    logger.debug(`[session-relay] enabled: ${config.thresholdTokens} tokens / ${config.thresholdPercent}% → ${config.handoffFile}`)
    return {
        controller,
        stop: () => clearInterval(timer)
    }
}
