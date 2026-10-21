import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
    PingPeerError,
    formatInspectPeerReport,
    inspectPeer,
    extractInspectMessageSnippet,
    type PingPeerSessionSummary
} from './pingPeer'

type MockResponse = {
    status: number
    data: unknown
}

function createHttpMock(handlers: {
    post?: (url: string, body?: unknown) => MockResponse | Promise<MockResponse>
    get?: (url: string, config?: { params?: Record<string, unknown> }) => MockResponse | Promise<MockResponse>
}) {
    return {
        post: vi.fn(async (url: string, body?: unknown) => {
            if (!handlers.post) {
                throw new Error(`unexpected POST ${url}`)
            }
            return handlers.post(url, body)
        }),
        get: vi.fn(async (url: string, config?: { params?: Record<string, unknown> }) => {
            if (!handlers.get) {
                throw new Error(`unexpected GET ${url}`)
            }
            return handlers.get(url, config)
        })
    }
}

describe('inspectPeer', () => {
    it('keeps clean user/agy text and attachment paths, not injected context or preview URLs', () => {
        expect(extractInspectMessageSnippet({
            role: 'user',
            content: {
                text: '<hapi_user_context user="a">private</hapi_user_context>Inspect this',
                attachments: [null, {}, { filename: 'error.png', mimeType: 'image/png', path: 'C:\\tmp\\error.png', previewUrl: 'secret' }]
            }
        })).toMatchObject({
            role: 'user', text: 'Inspect this',
            attachments: [{ filename: 'error.png', mimeType: 'image/png', path: 'C:\\tmp\\error.png' }]
        })
        expect(extractInspectMessageSnippet({
            role: 'user', content: { text: '<hapi_user_context>private</hapi_user_context>', attachments: [{ path: '/tmp/file.txt' }] }
        })).toMatchObject({
            text: '', attachments: [{ filename: 'attachment', mimeType: null, path: '/tmp/file.txt' }]
        })
        expect(extractInspectMessageSnippet({
            role: 'agent', content: { type: 'output', data: { type: 'agy_message', content: 'Fixed src/main.ts' } }
        })?.text).toBe('Fixed src/main.ts')
        for (const content of ['', ' \n ']) {
            expect(extractInspectMessageSnippet({
                role: 'agent', content: { type: 'output', data: { type: 'agy_message', content } }
            })).toBeNull()
        }
    })

    it('returns a structured brief and targeted evidence without resuming or sending messages', async () => {
        const sessionId = 'evidence-peer'
        const peer = { id: sessionId, active: false, metadata: { name: 'Scope fix', path: 'C:\\repo' } }
        const attachment = { filename: 'error.png', mimeType: 'image/png', path: 'C:\\tmp\\error.png' }
        const http = createHttpMock({
            post: (url, body) => {
                if (url.endsWith('/api/auth')) return { status: 200, data: { token: 'jwt' } }
                if (url.endsWith('/api/voice/session-qa')) {
                    expect(body).toEqual({ sessionId, question: 'Which error?', mode: 'evidence' })
                    return { status: 200, data: { answer: 'src/main.ts: E_SCOPE', model: 'extractor' } }
                }
                throw new Error(`unexpected POST ${url}`)
            },
            get: (url) => {
                if (url.endsWith('/api/sessions')) return { status: 200, data: { sessions: [peer] } }
                if (url.endsWith(`/api/sessions/${sessionId}`)) return { status: 200, data: { session: peer } }
                if (url.endsWith('/messages')) return {
                    status: 200, data: { messages: [{
                        id: 'user1', seq: 42, content: { role: 'user', content: { text: 'See error', attachments: [{ ...attachment, previewUrl: 'secret' }] } }
                    }] }
                }
                if (url.endsWith(`/api/digests/sessions/${sessionId}`)) return {
                    status: 200, data: { digest: {
                        title: 'Scope fix', status: 'Fixed', done: ['Read logs', 'Fixed scope'], todo: ['Deploy'],
                        artifacts: { files: ['src/main.ts'], commits: ['abc fix scope'] }
                    } }
                }
                throw new Error(`unexpected GET ${url}`)
            }
        })
        const result = await inspectPeer({
            sessionIdPrefix: sessionId, question: ' Which error? ', apiUrl: 'http://hub.test', accessToken: 'tok', http: http as never
        })
        expect(result.digest).toEqual({
            title: 'Scope fix', status: 'Fixed', done: ['Read logs', 'Fixed scope'], todo: ['Deploy'],
            files: ['src/main.ts'], commits: ['abc fix scope']
        })
        expect(result.attachments).toEqual([attachment])
        expect(result.messages[0]?.seq).toBe(42)
        expect(result.answer).toEqual({ question: 'Which error?', answer: 'src/main.ts: E_SCOPE', model: 'extractor' })
        const report = formatInspectPeerReport(result)
        expect(report).toContain('digest.status: Fixed')
        expect(report).toContain('digest.done: Read logs；Fixed scope')
        expect(report).toContain('digest.todo: Deploy')
        expect(report).toContain('artifacts.files: src/main.ts')
        expect(report).toContain('artifacts.commits: abc fix scope')
        expect(report).toContain('attachments: error.png (image/png) -> C:\\tmp\\error.png')
        expect(report).toContain('[user] See error [attachments: error.png (image/png) -> C:\\tmp\\error.png]')
        expect(report).toContain('evidence (q: Which error?, model: extractor):\nsrc/main.ts: E_SCOPE')
        expect(report).not.toContain('secret')
        expect(http.post).toHaveBeenCalledTimes(2)
    })

    it('preserves Tier 1 with a clear reason when evidence or digest is unavailable', async () => {
        for (const failure of ['http', 'network']) {
            const peer = { id: 'peer01', active: false, metadata: { name: 'Still readable' } }
            const http = createHttpMock({
                post: (url) => {
                    if (url.endsWith('/api/auth')) return { status: 200, data: { token: 'jwt' } }
                    if (failure === 'network') throw new Error('network offline')
                    return { status: 503, data: { error: 'not configured' } }
                },
                get: (url) => {
                    if (url.endsWith('/api/sessions')) return { status: 200, data: { sessions: [peer] } }
                    if (url.endsWith('/api/sessions/peer01')) return { status: 200, data: { session: peer } }
                    if (url.endsWith('/messages')) return { status: 200, data: { messages: [{
                        content: { role: 'agent', content: { type: 'output', data: { type: 'agy_message', content: 'Last known fact' } } }
                    }] } }
                    throw new Error('digest unavailable')
                }
            })
            const result = await inspectPeer({
                sessionIdPrefix: peer.id, question: 'What happened?', apiUrl: 'http://hub.test', accessToken: 'tok', http: http as never
            })
            expect(result.digest).toBeNull()
            expect(result.messages[0]?.text).toBe('Last known fact')
            expect(result.answer?.answer).toBe(`[evidence_unavailable: ${failure === 'network' ? 'network offline' : 'not configured'}]`)
            expect(formatInspectPeerReport(result)).toContain('Last known fact')
        }
    })

    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('loads metadata and recent messages without calling resume', async () => {
        const sessionId = '7d55ed21-8a9f-4309-b4f8-30069df36b4b'
        const http = createHttpMock({
            post: (url) => {
                if (url.endsWith('/api/auth')) {
                    return { status: 200, data: { token: 'jwt' } }
                }
                throw new Error(`unexpected POST ${url}`)
            },
            get: (url, config) => {
                if (url.endsWith('/api/sessions')) {
                    return {
                        status: 200,
                        data: {
                            sessions: [{
                                id: sessionId,
                                active: false,
                                updatedAt: 1_700_000_000_000,
                                metadata: {
                                    name: 'hub runner version governance',
                                    flavor: 'cursor',
                                    path: '/home/heavygee/coding/hapi'
                                }
                            } satisfies PingPeerSessionSummary]
                        }
                    }
                }
                if (url.endsWith(`/api/sessions/${sessionId}`)) {
                    return {
                        status: 200,
                        data: {
                            session: {
                                id: sessionId,
                                active: false,
                                thinking: false,
                                updatedAt: 1_700_000_000_000,
                                metadata: {
                                    name: 'hub runner version governance',
                                    flavor: 'cursor',
                                    path: '/home/heavygee/coding/hapi',
                                    lifecycleState: 'archived'
                                }
                            }
                        }
                    }
                }
                if (url.endsWith(`/api/sessions/${sessionId}/messages`)) {
                    expect(config?.params).toEqual({ limit: 30 })
                    return {
                        status: 200,
                        data: {
                            messages: [
                                {
                                    id: 'm1',
                                    createdAt: 1_700_000_000_100,
                                    content: {
                                        role: 'user',
                                        content: { text: 'status on runner versions?' }
                                    }
                                },
                                {
                                    id: 'm2',
                                    createdAt: 1_700_000_000_200,
                                    content: {
                                        role: 'agent',
                                        content: {
                                            type: 'codex',
                                            data: {
                                                type: 'message',
                                                message: 'Looking into it.'
                                            }
                                        }
                                    }
                                }
                            ],
                            page: { hasMore: false }
                        }
                    }
                }
                throw new Error(`unexpected GET ${url}`)
            }
        })

        const result = await inspectPeer({
            sessionIdPrefix: sessionId,
            accessToken: 'tok',
            apiUrl: 'http://hub.test',
            http: http as never
        })

        expect(result.sessionId).toBe(sessionId)
        expect(result.name).toBe('hub runner version governance')
        expect(result.active).toBe(false)
        expect(result.flavor).toBe('cursor')
        expect(result.path).toBe('/home/heavygee/coding/hapi')
        expect(result.messages).toHaveLength(2)
        expect(result.messages[0]).toMatchObject({
            role: 'user',
            text: 'status on runner versions?'
        })
        expect(result.messages[1]?.text).toContain('Looking into it.')

        // Read-only: never resume
        expect(http.post).toHaveBeenCalledTimes(1)
        expect(http.post.mock.calls[0]![0]).toContain('/api/auth')
        expect(http.post.mock.calls.some((call) => String(call[0]).includes('/resume'))).toBe(false)
    })

    it('respects messageLimit and refuses empty prefix', async () => {
        await expect(inspectPeer({
            sessionIdPrefix: '  ',
            accessToken: 'tok',
            apiUrl: 'http://hub.test',
            http: createHttpMock({}) as never
        })).rejects.toMatchObject({ code: 'bad_args' } satisfies Partial<PingPeerError>)

        const sessionId = 'aaaaaaaa-1111-1111-1111-111111111111'
        const http = createHttpMock({
            post: (url) => {
                if (url.endsWith('/api/auth')) {
                    return { status: 200, data: { token: 'jwt' } }
                }
                throw new Error(`unexpected POST ${url}`)
            },
            get: (url, config) => {
                if (url.endsWith('/api/sessions')) {
                    return {
                        status: 200,
                        data: { sessions: [{ id: sessionId, active: true, metadata: { name: 'A' } }] }
                    }
                }
                if (url.endsWith(`/api/sessions/${sessionId}`)) {
                    return {
                        status: 200,
                        data: { session: { id: sessionId, active: true, metadata: { name: 'A' } } }
                    }
                }
                if (url.endsWith(`/api/sessions/${sessionId}/messages`)) {
                    expect(config?.params).toEqual({ limit: 5 })
                    return { status: 200, data: { messages: [], page: {} } }
                }
                throw new Error(`unexpected GET ${url}`)
            }
        })

        await inspectPeer({
            sessionIdPrefix: 'aaaaaaaa',
            messageLimit: 5,
            accessToken: 'tok',
            apiUrl: 'http://hub.test',
            http: http as never
        })
    })

    it('clamps messageLimit to 1..100', async () => {
        const sessionId = 'bbbbbbbb-3333-3333-3333-333333333333'
        const http = createHttpMock({
            post: (url) => {
                if (url.endsWith('/api/auth')) {
                    return { status: 200, data: { token: 'jwt' } }
                }
                throw new Error(`unexpected POST ${url}`)
            },
            get: (url, config) => {
                if (url.endsWith('/api/sessions')) {
                    return {
                        status: 200,
                        data: { sessions: [{ id: sessionId, active: true, metadata: { name: 'C' } }] }
                    }
                }
                if (url.endsWith(`/api/sessions/${sessionId}`)) {
                    return {
                        status: 200,
                        data: { session: { id: sessionId, active: true, metadata: { name: 'C' } } }
                    }
                }
                if (url.endsWith(`/api/sessions/${sessionId}/messages`)) {
                    expect(config?.params).toEqual({ limit: 100 })
                    return { status: 200, data: { messages: [], page: {} } }
                }
                throw new Error(`unexpected GET ${url}`)
            }
        })

        await inspectPeer({
            sessionIdPrefix: sessionId,
            messageLimit: 999,
            accessToken: 'tok',
            apiUrl: 'http://hub.test',
            http: http as never
        })
    })

    it('accepts a pasted Copy-reference citation as sessionIdPrefix', async () => {
        const sessionId = '7ee03698-0fe7-4f76-b8a8-d84f4eddbf5c'
        const http = createHttpMock({
            post: async () => ({ status: 200, data: { token: 'jwt' } }),
            get: async (url) => {
                if (url.endsWith('/api/sessions')) {
                    return {
                        status: 200,
                        data: {
                            sessions: [
                                {
                                    id: sessionId,
                                    active: true,
                                    thinking: false,
                                    updatedAt: 1,
                                    metadata: { name: 'Coding', flavor: 'codex' }
                                }
                            ]
                        }
                    }
                }
                if (url.endsWith(`/api/sessions/${sessionId}`)) {
                    return {
                        status: 200,
                        data: {
                            session: {
                                id: sessionId,
                                active: true,
                                thinking: false,
                                updatedAt: 1,
                                metadata: { name: 'Coding', flavor: 'codex' }
                            }
                        }
                    }
                }
                if (url.endsWith(`/api/sessions/${sessionId}/messages`)) {
                    return {
                        status: 200,
                        data: { messages: [], page: { hasMore: false } }
                    }
                }
                throw new Error(`unexpected GET ${url}`)
            }
        })

        const result = await inspectPeer({
            sessionIdPrefix: `See session "Coding" (/sessions/${sessionId}) for context`,
            accessToken: 'tok',
            apiUrl: 'http://hub.test',
            http: http as never
        })

        expect(result.sessionId).toBe(sessionId)
        expect(result.name).toBe('Coding')
    })
})

describe('formatInspectPeerReport', () => {
    it('includes session id and message snippets for agent consumption', () => {
        const report = formatInspectPeerReport({
            sessionId: '7d55ed21-8a9f-4309-b4f8-30069df36b4b',
            name: 'hub runner version governance',
            active: true,
            thinking: false,
            flavor: 'cursor',
            path: '/tmp/x',
            lifecycleState: null,
            updatedAt: 1_700_000_000_000,
            messages: [
                { id: '1', role: 'user', text: 'hello', createdAt: 1 },
                { id: '2', role: 'agent', text: 'world', createdAt: 2 }
            ]
        })
        expect(report).toContain('7d55ed21-8a9f-4309-b4f8-30069df36b4b')
        expect(report).toContain('hub runner version governance')
        expect(report).toContain('[user] hello')
        expect(report).toContain('[agent] world')
        expect(report).toContain('/sessions/7d55ed21-8a9f-4309-b4f8-30069df36b4b')
    })
})
