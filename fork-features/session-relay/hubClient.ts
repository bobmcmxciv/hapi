import { randomUUID } from 'node:crypto'
import axios, { type AxiosInstance } from 'axios'
import { buildHubRequestHeaders } from '../../cli/src/api/hubExtraHeaders'
import type { SessionRelayHub, SessionRelayLaunch } from './controller'

/** A freshly spawned session only accepts messages once its CLI has attached. */
const ACTIVE_WAIT_MS = 120_000
const ACTIVE_POLL_MS = 2_000

class HubRequestError extends Error {
    constructor(message: string, readonly status: number, readonly code: string | null) {
        super(message)
    }
}

/**
 * fork(session-relay): the hub calls a relay needs, made with the session's
 * own CLI credentials (`POST /api/auth` with CLI_API_TOKEN, same as ping-peer).
 */
export function createSessionRelayHub(options: {
    apiUrl: string
    accessToken: string
    http?: AxiosInstance
    sleep?: (ms: number) => Promise<void>
    now?: () => number
}): SessionRelayHub {
    const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
    const now = options.now ?? Date.now
    const apiUrl = options.apiUrl.trim().replace(/\/+$/, '')
    const http = options.http ?? axios.create()
    let jwt: string | null = null

    const authenticate = async (): Promise<string> => {
        const response = await http.post(`${apiUrl}/api/auth`, { accessToken: options.accessToken }, {
            headers: buildHubRequestHeaders({ 'Content-Type': 'application/json' }),
            timeout: 15_000,
            validateStatus: () => true
        })
        const token = typeof response.data?.token === 'string' ? response.data.token : ''
        if (response.status !== 200 || !token) {
            throw new Error(`hub auth failed (HTTP ${response.status})`)
        }
        jwt = token
        return token
    }

    const request = async (method: 'get' | 'post', path: string, body?: unknown, timeout = 30_000): Promise<unknown> => {
        for (let attempt = 0; attempt < 2; attempt += 1) {
            const token = jwt ?? await authenticate()
            const config = {
                headers: buildHubRequestHeaders({
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`
                }),
                timeout,
                validateStatus: () => true
            }
            const response = method === 'get'
                ? await http.get(`${apiUrl}${path}`, config)
                : await http.post(`${apiUrl}${path}`, body, config)
            if (response.status === 401 && attempt === 0) {
                jwt = null
                continue
            }
            if (response.status < 200 || response.status >= 300) {
                const data = typeof response.data === 'object' && response.data ? response.data as { error?: unknown; code?: unknown } : {}
                const detail = data.error !== undefined ? String(data.error) : `HTTP ${response.status}`
                throw new HubRequestError(`${path}: ${detail}`, response.status, typeof data.code === 'string' ? data.code : null)
            }
            return response.data
        }
        throw new HubRequestError(`${path}: unauthorized`, 401, null)
    }
    const post = (path: string, body: unknown, timeout?: number) => request('post', path, body, timeout)

    const waitUntilActive = async (sessionId: string): Promise<void> => {
        const deadline = now() + ACTIVE_WAIT_MS
        while (now() < deadline) {
            const data = await request('get', `/api/sessions/${encodeURIComponent(sessionId)}`) as { session?: { active?: boolean } }
            if (data?.session?.active) return
            await sleep(ACTIVE_POLL_MS)
        }
        throw new Error(`session ${sessionId} did not become active within ${ACTIVE_WAIT_MS / 1000} s`)
    }

    return {
        sendMessage: async (sessionId, text, messageOptions) => {
            const body = {
                text,
                localId: `session-relay-${randomUUID()}`,
                ...(messageOptions?.steer ? { ompInputMode: 'steer' } : {})
            }
            const path = `/api/sessions/${encodeURIComponent(sessionId)}/messages`
            try {
                await post(path, body)
            } catch (error) {
                if (!(error instanceof HubRequestError) || error.code !== 'session_inactive') throw error
                await waitUntilActive(sessionId)
                await post(path, body)
            }
        },
        spawnSession: async (launch: SessionRelayLaunch) => {
            const result = await post(`/api/machines/${encodeURIComponent(launch.machineId)}/spawn`, {
                directory: launch.directory,
                agent: launch.agent,
                sessionType: 'simple',
                ...(launch.model ? { model: launch.model } : {}),
                ...(launch.effort ? { effort: launch.effort } : {}),
                ...(launch.permissionMode ? { permissionMode: launch.permissionMode } : {})
            }, 90_000) as { type?: string; sessionId?: string; message?: string }
            if (result?.type !== 'success' || typeof result.sessionId !== 'string') {
                throw new Error(`spawn failed: ${result?.message ?? JSON.stringify(result)}`)
            }
            return result.sessionId
        },
        archiveSession: async (sessionId) => {
            await post(`/api/sessions/${encodeURIComponent(sessionId)}/archive`, {})
        }
    }
}
