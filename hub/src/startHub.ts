import { createConfiguration, type ConfigSource } from './configuration'
import { Store } from './store'
import { BlobStore, GeneratedBlobFetcher } from './blobs'
import { SyncEngine, type SyncEvent } from './sync/syncEngine'
import { NotificationHub } from './notifications/notificationHub'
import type { NotificationChannel } from './notifications/notificationTypes'
import { HappyBot } from './telegram/bot'
import { startWebServer } from './web/server'
import { getOrCreateJwtSecret } from './config/jwtSecret'
import { createSocketServer } from './socket/server'
import { SSEManager } from './sse/sseManager'
import { getOrCreateVapidKeys } from './config/vapidKeys'
import { PushService } from './push/pushService'
import { PushNotificationChannel } from './push/pushNotificationChannel'
import { FcmService } from './fcm/fcmService'
import { FcmNotificationChannel } from './fcm/fcmNotificationChannel'
import { resolveFcmConfig } from './fcm/fcmConfig'
import { VisibilityTracker } from './visibility/visibilityTracker'
import { TunnelManager } from './tunnel'
import { startEventLoopLagMonitor } from './web/eventLoopLag'
import { refreshRejectedRelayAuthKey, resolveRelayAuthKey } from './tunnel/relayAuth'
import { waitForTunnelTlsReady } from './tunnel/tlsGate'
import { ServerChanChannel } from './serverchan/channel'
import QRCode from 'qrcode'
import type { Server as BunServer } from 'bun'
import type { WebSocketData } from '@socket.io/bun-engine'
import { getOrCreateOwnerId } from './config/ownerId'
import { bootstrapForkMultiUser } from '../../fork-features/multi-user/hubMount'
import { resolveTerminalNamespace } from '../../fork-features/multi-user/socketAdapter'
import {
    createPushNotificationRouting,
    createTelegramNotificationNamespaceResolver,
    MultiUserNotificationAdapter
} from '../../fork-features/multi-user/notificationAdapter'
import { resolveGatewayCliNamespace } from '../../fork-features/multi-user/cliAdapter'
import { createGatewayMemoryDelivery } from '../../fork-features/multi-user/memoryAdapter'
import { startCx2ccPoller, type Cx2ccPollerHandle } from '../../fork-features/subscription/cx2ccPoller'
import { startDigestService } from '../../fork-features/session-digest/digestService'
import { startWorkStore, stopWorkStore } from '../../fork-features/work-overview/workStore'

/** Format config source for logging */
function formatSource(source: ConfigSource | 'generated'): string {
    switch (source) {
        case 'env':
            return 'environment'
        case 'file':
            return 'settings.json'
        case 'default':
            return 'default'
        case 'generated':
            return 'generated'
    }
}

type RelayFlagSource = 'default' | '--relay' | '--no-relay'

function resolveRelayFlag(args: string[]): { enabled: boolean; source: RelayFlagSource } {
    let enabled = false
    let source: RelayFlagSource = 'default'

    for (const arg of args) {
        if (arg === '--relay') {
            enabled = true
            source = '--relay'
        } else if (arg === '--no-relay') {
            enabled = false
            source = '--no-relay'
        }
    }

    return { enabled, source }
}

function normalizeOrigin(value: string): string {
    const trimmed = value.trim()
    if (!trimmed) {
        return ''
    }
    try {
        return new URL(trimmed).origin
    } catch {
        return trimmed
    }
}

function normalizeOrigins(origins: string[]): string[] {
    const normalized = origins
        .map(normalizeOrigin)
        .filter(Boolean)
    if (normalized.includes('*')) {
        return ['*']
    }
    return Array.from(new Set(normalized))
}

function mergeCorsOrigins(base: string[], extra: string[]): string[] {
    if (base.includes('*') || extra.includes('*')) {
        return ['*']
    }
    const merged = new Set<string>()
    for (const origin of base) {
        merged.add(origin)
    }
    for (const origin of extra) {
        merged.add(origin)
    }
    return Array.from(merged)
}

export interface HubInstance {
    stop(): Promise<void>
}

export interface StartHubOptions {
    args?: string[]
}

export async function startHub(options: StartHubOptions = {}): Promise<HubInstance> {
    console.log('HAPI Hub starting...')

    let syncEngine: SyncEngine | null = null
    let happyBot: HappyBot | null = null
    let webServer: BunServer<WebSocketData> | null = null
    let sseManager: SSEManager | null = null
    let visibilityTracker: VisibilityTracker | null = null
    let notificationHub: NotificationHub | null = null
    let tunnelManager: TunnelManager | null = null
    let cx2ccPoller: Cx2ccPollerHandle | null = null

    // Load configuration (async - loads from env/file with persistence)
    const relayApiDomain = process.env.HAPI_RELAY_API || 'relay.hapi.run'
    const relayFlag = resolveRelayFlag(options.args ?? process.argv)
    const officialWebUrl = process.env.HAPI_OFFICIAL_WEB_URL || 'https://app.hapi.run'
    const config = await createConfiguration()
    const baseCorsOrigins = normalizeOrigins(config.corsOrigins)
    const relayCorsOrigin = normalizeOrigin(officialWebUrl)
    const corsOrigins = relayFlag.enabled
        ? mergeCorsOrigins(baseCorsOrigins, relayCorsOrigin ? [relayCorsOrigin] : [])
        : baseCorsOrigins

    // Display CLI API token information
    if (config.cliApiTokenIsNew) {
        console.log('')
        console.log('='.repeat(70))
        console.log('  NEW CLI_API_TOKEN GENERATED')
        console.log('='.repeat(70))
        console.log('')
        console.log(`  Token: ${config.cliApiToken}`)
        console.log('')
        console.log(`  Saved to: ${config.settingsFile}`)
        console.log('')
        console.log('='.repeat(70))
        console.log('')
    } else {
        console.log(`[Hub] CLI_API_TOKEN: loaded from ${formatSource(config.sources.cliApiToken)}`)
    }

    // Display other configuration sources
    console.log(`[Hub] HAPI_LISTEN_HOST: ${config.listenHost} (${formatSource(config.sources.listenHost)})`)
    console.log(`[Hub] HAPI_LISTEN_PORT: ${config.listenPort} (${formatSource(config.sources.listenPort)})`)
    console.log(`[Hub] HAPI_PUBLIC_URL: ${config.publicUrl} (${formatSource(config.sources.publicUrl)})`)

    if (!config.telegramEnabled) {
        console.log('[Hub] Telegram: disabled (no TELEGRAM_BOT_TOKEN)')
    } else {
        const tokenSource = formatSource(config.sources.telegramBotToken)
        console.log(`[Hub] Telegram: enabled (${tokenSource})`)
        const notificationSource = formatSource(config.sources.telegramNotification)
        console.log(`[Hub] Telegram notifications: ${config.telegramNotification ? 'enabled' : 'disabled'} (${notificationSource})`)
    }
    if (config.serverChanSendKey) {
        const source = formatSource(config.sources.serverChanSendKey)
        const notificationSource = formatSource(config.sources.serverChanNotification)
        console.log(`[Hub] ServerChan: enabled (${source})`)
        console.log(`[Hub] ServerChan notifications: ${config.serverChanNotification ? 'enabled' : 'disabled'} (${notificationSource})`)
    } else {
        console.log('[Hub] ServerChan: disabled (no SERVERCHAN_SENDKEY)')
    }

    // Display tunnel status
    if (relayFlag.enabled) {
        console.log(`[Hub] Tunnel: enabled (${relayFlag.source}), API: ${relayApiDomain}`)
    } else {
        console.log(`[Hub] Tunnel: disabled (${relayFlag.source})`)
    }

    // Phase timings: a restart once took 36 s before the hub listened, with
    // nothing in the log to say where the time went.
    const startupStartedAt = Date.now()
    const logStartupPhase = (phase: string) => {
        console.log(`[Hub] startup: ${phase} (+${((Date.now() - startupStartedAt) / 1000).toFixed(1)}s)`)
    }

    const { store, multiUserGatewayStore, subscriptionStore } = bootstrapForkMultiUser(config)
    logStartupPhase('databases open')
    const plannerStatistics = store.ensurePlannerStatistics()
    if (plannerStatistics.rebuilt) {
        console.log(`[Hub] SQLite planner statistics were missing; rebuilt in ${plannerStatistics.ms} ms`)
    }
    const gatewayMemoryDelivery = createGatewayMemoryDelivery(multiUserGatewayStore)
    const jwtSecret = await getOrCreateJwtSecret()
    const vapidKeys = await getOrCreateVapidKeys(config.dataDir)
    const vapidSubject = process.env.VAPID_SUBJECT ?? 'mailto:admin@hapi.run'
    const pushService = new PushService(vapidKeys, vapidSubject, store)
    const pushNotificationRouting = createPushNotificationRouting(multiUserGatewayStore, store)

    visibilityTracker = new VisibilityTracker()
    sseManager = new SSEManager(30_000, visibilityTracker)

    const socketServer = createSocketServer({
        store,
        jwtSecret,
        corsOrigins,
        getSession: (sessionId) => {
            if (syncEngine) {
                return syncEngine.getSession(sessionId) ?? null
            }
            return store.sessions.getSession(sessionId)
        },
        onWebappEvent: (event: SyncEvent) => syncEngine?.handleRealtimeEvent(event),
        onSessionAlive: (payload) => syncEngine?.handleSessionAlive(payload),
        onSessionReady: (payload) => syncEngine?.handleSessionReady(payload),
        onSessionEnd: (payload) => syncEngine?.handleSessionEnd(payload),
        onMachineAlive: (payload) => syncEngine?.handleMachineAlive(payload),
        onBackgroundTaskDelta: (sessionId, delta) => syncEngine?.handleBackgroundTaskDelta(sessionId, delta),
        onSessionActivity: (sessionId, updatedAt) => syncEngine?.recordSessionActivity(sessionId, updatedAt),
        onSweepImmediateQueued: (sessionId, now) => syncEngine?.sweepImmediateQueuedOnSessionEnd(sessionId, now),
        onMessagesConsumed: (sessionId) => syncEngine?.clearQueuedThinkingGrace(sessionId),
        resolveTerminalNamespace: (accountId, sessionId) => resolveTerminalNamespace({
            store: multiUserGatewayStore,
            accountId,
            sessionId,
            getCoreSession: (id) => syncEngine?.getSession(id) ?? store.sessions.getSession(id)
        }),
        resolveCliNamespace: token => resolveGatewayCliNamespace(multiUserGatewayStore, token),
        sanitizeSessionMetadata: metadata => gatewayMemoryDelivery.sanitizeMetadata(metadata)
    })

    syncEngine = new SyncEngine(store, socketServer.io, socketServer.rpcRegistry, sseManager, gatewayMemoryDelivery.decorateForCli)
    logStartupPhase('session and machine caches loaded')

    const fcmConfig = resolveFcmConfig()

    // Build the optional FCM service early so the native-fallback probe
    // can consult its health gate. When FCM is configured, `fcmService` is
    // shared between the FcmNotificationChannel and the probe so a broken
    // pipeline (expired credentials, sustained 5xx) lets web-push run as
    // a last-resort surface for the namespace instead of silently muting
    // both channels.
    const fcmService = fcmConfig
        ? new FcmService(fcmConfig.projectId, fcmConfig.serviceAccount, store)
        : null

    const notificationChannels: NotificationChannel[] = []

    if (fcmConfig && fcmService) {
        notificationChannels.push(
            new MultiUserNotificationAdapter(
                multiUserGatewayStore,
                new FcmNotificationChannel(fcmService, sseManager, visibilityTracker, store)
            )
        )
        console.log('[Fcm] Native companion push enabled (project:', fcmConfig.projectId + ')')
    }

    notificationChannels.push(
        new MultiUserNotificationAdapter(
            multiUserGatewayStore,
            new PushNotificationChannel(
                pushService,
                sseManager,
                visibilityTracker,
                config.publicUrl,
                pushNotificationRouting.endpointsForAudience
            ),
            pushNotificationRouting.namespacesForAccount
        )
    )

    if (config.serverChanSendKey && config.serverChanNotification) {
        notificationChannels.push(new ServerChanChannel(config.serverChanSendKey, config.publicUrl))
    }

    // Initialize Telegram bot (optional)
    if (config.telegramEnabled && config.telegramBotToken) {
        happyBot = new HappyBot({
            syncEngine,
            botToken: config.telegramBotToken,
            publicUrl: config.publicUrl,
            store
        })
        // Only add to notification channels if notifications are enabled
        if (config.telegramNotification) {
            notificationChannels.push(new MultiUserNotificationAdapter(
                multiUserGatewayStore,
                happyBot,
                createTelegramNotificationNamespaceResolver(multiUserGatewayStore, store)
            ))
        }
    }

    notificationHub = new NotificationHub(syncEngine, notificationChannels)

    // Generated blobs (sent files, inline media) live on the hub's own disk so
    // viewers never depend on the sending machine's uplink. HAPI_BLOB_DIR points
    // production at the data volume rather than the system disk.
    const blobStore = await BlobStore.open(config.blobDir, {
        maxBytes: config.blobMaxBytes,
        maxAgeMs: config.blobMaxAgeDays * 24 * 60 * 60 * 1000,
        minFreeBytes: config.blobMinFreeBytes
    })
    const blobUsage = blobStore.usage()
    console.log(`[Hub] Blob store at ${config.blobDir}: ${blobUsage.count} blobs, ${Math.round(blobUsage.bytes / (1024 * 1024))} MiB`)
    const blobPruneTimer = setInterval(() => {
        void blobStore.prune().catch((error) => console.warn('[Hub] Blob prune failed:', error))
    }, 60 * 60 * 1000)
    blobPruneTimer.unref()
    const blobs = { store: blobStore, fetcher: new GeneratedBlobFetcher(blobStore) }
    logStartupPhase('blob store indexed')

    const eventLoopLag = startEventLoopLagMonitor()
    // Keeps planner statistics current between the weekly full ANALYZE on ECS.
    const optimizeTimer = setInterval(() => {
        try {
            const ms = store.optimize()
            if (ms >= 100) console.log(`[Hub] PRAGMA optimize took ${ms} ms`)
        } catch (error) {
            console.warn('[Hub] PRAGMA optimize failed:', error instanceof Error ? error.message : error)
        }
    }, 6 * 60 * 60 * 1000)
    optimizeTimer.unref()

    // Start HTTP service first (before tunnel, so tunnel has something to forward to)
    webServer = await startWebServer({
        blobs,
        getEventLoopLag: eventLoopLag.snapshot,
        getSyncEngine: () => syncEngine,
        getSseManager: () => sseManager,
        getVisibilityTracker: () => visibilityTracker,
        jwtSecret,
        store,
        vapidPublicKey: vapidKeys.publicKey,
        socketEngine: socketServer.engine,
        corsOrigins,
        relayMode: relayFlag.enabled,
        officialWebUrl,
        multiUser: {
            store: multiUserGatewayStore,
            coreUserId: await getOrCreateOwnerId(),
            subscriptionStore
        }
    })

    // Start the bot if configured
    if (happyBot) {
        await happyBot.start()
    }

    // fork(subscription): 启动 cx2cc 轮询器(hub 直接调 ECS 上的 cx2cc-api/usage)。
    // 只在两个 env 都设置时启动;缺任一 → 采集不启动、快照表这条留空,与其他
    // provider 一样从 vircs collector 走推送即可。
    const cx2ccUrl = process.env.HAPI_CX2CC_USAGE_URL?.trim()
    const cx2ccKey = process.env.HAPI_CX2CC_API_KEY?.trim()
    if (cx2ccUrl && cx2ccKey) {
        cx2ccPoller = startCx2ccPoller({
            url: cx2ccUrl,
            apiKey: cx2ccKey,
            intervalMs: 5 * 60 * 1000,
            subscriptionStore
        })
        console.log('[Subscription] cx2cc poller started (interval=5m)')
    } else {
        console.log('[Subscription] cx2cc poller disabled (HAPI_CX2CC_USAGE_URL/HAPI_CX2CC_API_KEY unset)')
    }

    // fork(session-digest): 会话/项目 AI 摘要调度器。env HAPI_DIGEST_API_URL/KEY 缺任一时
    // 只提供读写完结标记，不调模型。
    const digestService = startDigestService({
        dataDir: config.dataDir,
        getSessions: () => syncEngine?.getSessions() ?? [],
        getSession: (sessionId) => syncEngine?.getSession(sessionId),
        getRecentMessages: (sessionId, limit) => store.messages.getMessages(sessionId, limit),
        getFirstMessages: (sessionId, limit) => store.messages.getFirstMessages(sessionId, limit),
        renameSession: async (sessionId, name) => { await syncEngine?.renameSession(sessionId, name) },
        listDirectory: async (machineId, path) => {
            const result = await syncEngine?.listMachineDirectory(machineId, path)
            if (!result?.success || !result.entries) return null
            return result.entries
                .map(entry => (entry.type === 'directory' ? `${entry.name}/` : entry.name))
                .sort()
                .slice(0, 80)
        },
        readFile: async (sessionId, path) => {
            const result = await syncEngine?.readSessionFile(sessionId, path)
            return result?.success && result.content ? Buffer.from(result.content, 'base64').toString('utf8') : null
        }
    })
    console.log(`[Digest] session digest scheduler started (${digestService.status().configured ? 'model configured' : 'HAPI_DIGEST_API_URL/KEY unset: model calls disabled'})`)

    // fork(work-overview): 工作总览的主线/支线归属，独立 sqlite，路由在 executionMount。
    startWorkStore(config.dataDir)

    // fork(usage): 后台分段预热用量事件缓存。不预热的话，重启后第一个打开统计页的请求要
    // 同步解码全部历史消息，整个 hub 停摆几十秒。延后启动，避开启动高峰。
    let usageWarmupStopped = false
    const usageWarmupTimer = setTimeout(() => {
        const startedAt = Date.now()
        store.messages.warmUsageCache({ shouldStop: () => usageWarmupStopped })
            .then(result => console.log(`[Usage] event cache warmed: ${result.sessions} sessions, ${result.rows} rows in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`))
            .catch(error => console.error('[Usage] event cache warm-up failed:', error instanceof Error ? error.message : error))
    }, 20_000)

    logStartupPhase('listening')
    console.log('')
    console.log('[Web] Hub listening on :' + config.listenPort)
    console.log('[Web] Local:  http://localhost:' + config.listenPort)

    // Initialize tunnel AFTER web service is ready
    let tunnelUrl: string | null = null
    if (relayFlag.enabled) {
        try {
            tunnelManager = new TunnelManager({
                localPort: config.listenPort,
                enabled: true,
                apiDomain: relayApiDomain,
                authKey: await resolveRelayAuthKey(relayApiDomain, config.settingsFile),
                refreshAuthKey: rejectedKey => refreshRejectedRelayAuthKey(
                    relayApiDomain,
                    config.settingsFile,
                    rejectedKey
                ),
                useRelay: process.env.HAPI_RELAY_FORCE_TCP === 'true' || process.env.HAPI_RELAY_FORCE_TCP === '1'
            })
            tunnelUrl = await tunnelManager.start()
        } catch (error) {
            console.error('[Tunnel] Failed to start:', error instanceof Error ? error.message : error)
            console.log('[Tunnel] Hub continuing without tunnel. Restart without --relay to disable.')
        }
    }

    if (tunnelUrl && tunnelManager) {
        const manager = tunnelManager
        const announceTunnelAccess = async () => {
            const tlsReady = await waitForTunnelTlsReady(tunnelUrl, manager)
            if (!tlsReady) {
                console.log('[Tunnel] Tunnel stopped before TLS was ready.')
                return
            }

            console.log('[Web] Public: ' + tunnelUrl)

            // Generate direct access link with hub and token
            const params = new URLSearchParams({
                hub: tunnelUrl,
                token: config.cliApiToken
            })
            const directAccessUrl = `${officialWebUrl}/?${params.toString()}`

            console.log('')
            console.log('Open in browser:')
            console.log(`  ${directAccessUrl}`)
            console.log('')
            console.log('or scan the QR code to open:')

            // Display QR code for easy mobile access
            try {
                const qrString = await QRCode.toString(directAccessUrl, {
                    type: 'terminal',
                    small: true,
                    margin: 1,
                    errorCorrectionLevel: 'L'
                })
                console.log('')
                console.log(qrString)
            } catch {
                // QR code generation failure should not affect main flow
            }

            // Companion app pairing QR (deeplink scheme; PWA users ignore, native app picks up).
            const companionParams = new URLSearchParams({
                hub: tunnelUrl,
                code: config.cliApiToken
            })
            const companionDeeplink = `hapicompanion://bind?${companionParams.toString()}`
            console.log('')
            console.log('Or pair the HAPI companion app (Android phone / Wear OS):')
            console.log(`  ${companionDeeplink}`)
            try {
                const companionQrString = await QRCode.toString(companionDeeplink, {
                    type: 'terminal',
                    small: true,
                    margin: 1,
                    errorCorrectionLevel: 'L'
                })
                console.log('')
                console.log(companionQrString)
            } catch {
                // Non-fatal; deeplink text above is sufficient if QR rendering fails.
            }
        }

        void announceTunnelAccess()
    }
    console.log('')
    console.log('HAPI Hub is ready!')

    return {
        stop: async () => {
            await tunnelManager?.stop()
            await happyBot?.stop()
            notificationHub?.stop()
            syncEngine?.stop()
            sseManager?.stop()
            webServer?.stop()
            cx2ccPoller?.stop()
            usageWarmupStopped = true
            clearTimeout(usageWarmupTimer)
            clearInterval(optimizeTimer)
            eventLoopLag.stop()
            stopWorkStore()
            subscriptionStore.close()
            multiUserGatewayStore.close()
        }
    }
}
