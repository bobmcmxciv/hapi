import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../../hub/src/store'
import { applyAgyUsageBackfill } from '../../hub/scripts/backfill-agy-usage'
import { __resetUsageEventCacheForTests } from './usageAggregate'

const stores: Store[] = []
afterEach(() => {
    for (const store of stores.splice(0)) store.close()
    __resetUsageEventCacheForTests()
})

function setup() {
    const store = new Store(':memory:')
    stores.push(store)
    const session = store.sessions.getOrCreateSession(
        'agy-usage', { path: '/test', host: 'vircs', flavor: 'agy' }, null, 'default', 'latest-model',
    )
    return { store, session }
}

function reply(step: number, overrides: Record<string, unknown> = {}) {
    return {
        role: 'agent',
        content: { type: 'output', data: {
            type: 'agy_message', content: 'reply', messageId: `agy:brain:${step}`,
            model: 'gemini-4-argon', timestamp: '2026-10-20T08:00:00Z',
            usage: { input_tokens: 2830, output_tokens: 585, cache_creation_input_tokens: 0, cache_read_input_tokens: 222865 },
            ...overrides,
        } },
    }
}

describe('Antigravity model usage', () => {
    it('counts native per-request tokens once across replays, and keeps model switches', () => {
        const { store, session } = setup()
        const resumed = store.sessions.getOrCreateSession('resumed-agy', { path: '/test', flavor: 'agy' }, null, 'default')
        store.messages.addMessage(session.id, reply(7))
        store.messages.addMessage(session.id, reply(7))
        store.messages.addMessage(resumed.id, reply(7))
        store.messages.addMessage(session.id, reply(8, {
            model: 'claude-opus-5-5-high',
            usage: { input_tokens: 1000, output_tokens: 40, cache_creation_input_tokens: 20, cache_read_input_tokens: 500 },
        }))
        expect(store.messages.aggregateUsageForSessions([session.id, resumed.id]).sort((a, b) => a.model.localeCompare(b.model))).toEqual([
            { model: 'claude-opus-5-5-high', requestCount: 1, inputTokens: 1000, outputTokens: 40, cacheCreationInputTokens: 20, cacheReadInputTokens: 500 },
            { model: 'gemini-4-argon', requestCount: 1, inputTokens: 2830, outputTokens: 585, cacheCreationInputTokens: 0, cacheReadInputTokens: 222865 },
        ])
    })

    it('does not subtract cache from native uncached input even when cache is smaller', () => {
        const { store, session } = setup()
        store.messages.addMessage(session.id, reply(1, {
            usage: { input_tokens: 1000, output_tokens: 50, cache_read_input_tokens: 100 },
        }))
        expect(store.messages.aggregateUsageForSessions([session.id])[0]).toEqual({
            model: 'gemini-4-argon', requestCount: 1, inputTokens: 1000, outputTokens: 50,
            cacheCreationInputTokens: 0, cacheReadInputTokens: 100,
        })
    })

    it('filters by the original generation time, including exact window boundaries', () => {
        const { store, session } = setup()
        store.messages.addMessage(session.id, reply(1))
        store.messages.addMessage(session.id, reply(2, { timestamp: '2026-10-20T09:00:00Z' }))
        const rows = store.messages.aggregateUsageForSessions([session.id], {
            sinceIso: '2026-10-20T08:00:00.000Z', untilIso: '2026-10-20T09:00:00.000Z',
        })
        expect(rows[0]?.requestCount).toBe(1)
        expect(rows[0]?.inputTokens).toBe(2830)
    })

    it('never estimates old replies or assigns unknown generations to the latest selected model', () => {
        const { store, session } = setup()
        store.messages.addMessage(session.id, reply(1, { usage: undefined }))
        store.messages.addMessage(session.id, reply(2, { messageId: undefined }))
        expect(store.messages.aggregateUsageForSessions([session.id])).toEqual([])
        store.messages.addMessage(session.id, reply(3, { model: undefined }))
        expect(store.messages.aggregateUsageForSessions([session.id])[0]?.model).toBe('unknown')
    })

    it('counts OMP assistant messages once and ignores OMP context-bar token_count messages', () => {
        const store = new Store(':memory:')
        stores.push(store)
        const ompSession = store.sessions.getOrCreateSession(
            'omp-usage', { path: '/test', host: 'vircs', flavor: 'omp' }, null, 'default',
        )
        store.messages.addMessage(ompSession.id, {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'assistant',
                    uuid: 'omp-turn-1',
                    providerMessageId: 'resp-1',
                    timestamp: '2026-10-20T08:00:00Z',
                    message: {
                        role: 'assistant',
                        model: 'cx2cc/gpt-5.6-sol',
                        usage: {
                            input_tokens: 1200,
                            output_tokens: 300,
                            cache_creation_input_tokens: 0,
                            cache_read_input_tokens: 4500,
                        },
                    },
                },
            },
        })
        store.messages.addMessage(ompSession.id, {
            role: 'agent',
            content: {
                type: 'codex',
                data: {
                    type: 'token_count',
                    model: null,
                    info: {
                        total: {
                            inputTokens: 5700,
                            outputTokens: 300,
                            cachedInputTokens: 4500,
                        },
                        last: {
                            inputTokens: 5700,
                            outputTokens: 300,
                            cachedInputTokens: 4500,
                        },
                    },
                },
            },
        })
        expect(store.messages.aggregateUsageForSessions([ompSession.id])).toEqual([
            {
                model: 'cx2cc/gpt-5.6-sol',
                requestCount: 1,
                inputTokens: 1200,
                outputTokens: 300,
                cacheCreationInputTokens: 0,
                cacheReadInputTokens: 4500,
            },
        ])
    })
})

describe('applyAgyUsageBackfill', () => {
    it('backfills missing agy generations idempotently and fixes legacy null-model opencode sessions', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-agy-backfill-test-'))
        const dbPath = join(dir, 'hapi.db')
        try {
            const store = new Store(dbPath)
            const agySession = store.sessions.getOrCreateSession(
                'agy-main',
                { path: '/test', host: 'WIN-GVHSJ7B378A', flavor: 'agy', agySessionId: '00000000-0000-4000-8000-000000000001' },
                null,
                'default'
            )
            store.close()

            const records = [
                {
                    brainUuid: '00000000-0000-4000-8000-000000000001',
                    stepIndex: 2,
                    messageId: 'agy:00000000-0000-4000-8000-000000000001:generation:1',
                    model: 'gemini-4-argon',
                    timestamp: '2026-10-20T08:00:00.000Z',
                    usage: {
                        input_tokens: 1500,
                        output_tokens: 250,
                        cache_creation_input_tokens: 0,
                        cache_read_input_tokens: 20000,
                    },
                },
                {
                    brainUuid: '00000000-0000-4000-8000-000000000002',
                    stepIndex: 4,
                    messageId: 'agy:00000000-0000-4000-8000-000000000002:generation:3',
                    model: 'gemini-3.8-flash',
                    timestamp: '2026-10-20T09:00:00.000Z',
                    usage: {
                        input_tokens: 800,
                        output_tokens: 100,
                        cache_creation_input_tokens: 0,
                        cache_read_input_tokens: 5000,
                    },
                },
            ]

            const first = applyAgyUsageBackfill(dbPath, records)
            expect(first.insertedMessages).toBe(2)
            expect(first.skippedExisting).toBe(0)
            expect(first.createdHistorySessionId).toBe('antigravity-history-vircs')

            const second = applyAgyUsageBackfill(dbPath, records)
            expect(second.insertedMessages).toBe(0)
            expect(second.skippedExisting).toBe(2)

            const verifyStore = new Store(dbPath)
            const rows = verifyStore.messages
                .aggregateUsageForSessions([agySession.id, 'antigravity-history-vircs'])
                .sort((a, b) => a.model.localeCompare(b.model))
            expect(rows).toEqual([
                {
                    model: 'gemini-3.8-flash',
                    requestCount: 1,
                    inputTokens: 800,
                    outputTokens: 100,
                    cacheCreationInputTokens: 0,
                    cacheReadInputTokens: 5000,
                },
                {
                    model: 'gemini-4-argon',
                    requestCount: 1,
                    inputTokens: 1500,
                    outputTokens: 250,
                    cacheCreationInputTokens: 0,
                    cacheReadInputTokens: 20000,
                },
            ])
            verifyStore.close()
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })
})
