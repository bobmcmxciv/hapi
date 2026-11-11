import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryObserver } from '@tanstack/react-query'
import type { Machine, MachineWithOwner, Session, SessionSummary, SessionsResponse, SyncEvent } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'
import {
    applySessionDetailPatch,
    isNewerVersionedPatch,
    isRenderIrrelevantPatch,
    isRenderIrrelevantSessionPatch,
    mergeCachedMachine,
    QueryCacheProjector,
    shouldInvalidateSessionListForEvent
} from './query-cache-projector'

function makeSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
    return {
        id: 'session-1',
        active: true,
        thinking: false,
        activeAt: 1_000,
        updatedAt: 2_000,
        metadata: null,
        metadataVersion: 0,
        agentStateVersion: 0,
        todosUpdatedAt: 0,
        todoProgress: null,
        pendingRequestsCount: 0,
        pendingRequestKinds: [],
        pendingRequests: [],
        backgroundTaskCount: 0,
        futureScheduledMessageCount: 0,
        nextScheduledAt: null,
        model: null,
        effort: null,
        ...overrides
    } as SessionSummary
}

function makeDetail(overrides: Partial<Session> = {}): Session {
    return {
        id: 'session-1',
        namespace: 'default',
        seq: 1,
        createdAt: 500,
        updatedAt: 2_000,
        active: true,
        thinking: true,
        activeAt: 1_000,
        thinkingAt: 900,
        activeTurnStartedAt: 1_500,
        backgroundTaskCount: 2,
        metadata: null,
        metadataVersion: 0,
        agentState: null,
        agentStateVersion: 0,
        todosUpdatedAt: 0,
        teamStateUpdatedAt: 0,
        model: null,
        modelReasoningEffort: null,
        effort: null,
        serviceTier: null,
        resumeWithSessionModel: false,
        ...overrides
    } as Session
}

function seed(queryClient: QueryClient, sessions: SessionSummary[], detail?: Session): void {
    queryClient.setQueryData<SessionsResponse>(queryKeys.sessions, { sessions })
    if (detail) {
        queryClient.setQueryData(queryKeys.session(detail.id), { session: detail })
    }
}

function makeProjector(scope: 'global' | 'full' = 'global') {
    const queryClient = new QueryClient()
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    const projector = new QueryCacheProjector({ queryClient, scope })
    const sessions = () => queryClient.getQueryData<SessionsResponse>(queryKeys.sessions)
    const detail = (id: string) => queryClient.getQueryData<{ session: Session }>(queryKeys.session(id))
    const flushed = () => {
        vi.advanceTimersByTime(20)
        return invalidate.mock.calls.map((call) => call[0])
    }
    return { queryClient, projector, invalidate, sessions, detail, flushed }
}

afterEach(() => {
    vi.useRealTimers()
})

describe('isNewerVersionedPatch (PR #897 review, HAPI Bot 2026-06-16 Major)', () => {
    // Pin the version-monotonicity contract for structured metadata /
    // agentState patches. Without this gate, an SSE reconnect that replays
    // a buffered older patch after a fresh REST refetch would regress the
    // cached metadata to a stale write.
    it('accepts a strictly newer patch', () => {
        expect(isNewerVersionedPatch(5, 4)).toBe(true)
    })

    it('rejects an older patch (the bug case: stale buffered patch on reconnect)', () => {
        expect(isNewerVersionedPatch(4, 5)).toBe(false)
    })

    it('rejects an equal patch (replay of the same event must be idempotent no-op)', () => {
        expect(isNewerVersionedPatch(5, 5)).toBe(false)
    })
})

describe('projector scope handling', () => {
    it('invalidates the global session list when message ownership changes', () => {
        expect(shouldInvalidateSessionListForEvent('global', 'messages-invalidated')).toBe(true)
        expect(shouldInvalidateSessionListForEvent('full', 'messages-invalidated')).toBe(false)
    })
})

describe('isRenderIrrelevantPatch', () => {
    it('treats a keep-alive that only moves activeAt as irrelevant', () => {
        const current = makeSummary({ activeAt: 1_000 })
        const next = makeSummary({ activeAt: 11_000 })

        expect(isRenderIrrelevantPatch(current, next)).toBe(true)
    })

    it('treats an identical summary as irrelevant', () => {
        expect(isRenderIrrelevantPatch(makeSummary(), makeSummary())).toBe(true)
    })

    it.each([
        ['active', { active: false }],
        ['thinking', { thinking: true }],
        ['updatedAt', { updatedAt: 9_999 }],
        ['backgroundTaskCount', { backgroundTaskCount: 3 }],
        ['model', { model: 'opus' }],
        ['modelReasoningEffort', { modelReasoningEffort: 'high' }],
        ['effort', { effort: 'medium' }],
        ['pendingRequestsCount', { pendingRequestsCount: 2 }],
        ['metadata.path', { metadata: { path: '/other', name: undefined } }],
        ['metadata.flavor', { metadata: { path: '/tmp', flavor: 'claude' as const } }],
        ['metadata.machineId', { metadata: { path: '/tmp', machineId: 'Teemo' } }],
        ['metadata.worktree.branch', {
            metadata: {
                path: '/tmp',
                worktree: {
                    basePath: '/tmp',
                    branch: 'feat/x',
                    name: 'x',
                    worktreePath: '/tmp/x'
                }
            }
        }]
    ] as Array<[string, Partial<SessionSummary>]>)('reports %s changes as relevant', (_field, change) => {
        const current = makeSummary()
        const next = makeSummary({ ...change, activeAt: 11_000 })

        expect(isRenderIrrelevantPatch(current, next)).toBe(false)
    })
})

describe('isRenderIrrelevantSessionPatch', () => {
    const session = {
        id: 'session-1',
        active: true,
        thinking: false,
        activeAt: 1_000,
        updatedAt: 2_000,
        model: 'opus',
        effort: null,
        permissionMode: 'default',
        serviceTier: null
    } as unknown as Session

    it('treats a sub-minute activeAt keep-alive as irrelevant', () => {
        // Relative age stays in the `just now` bucket until 60s; accepting
        // every ~10s heartbeat would thrash the full chat tree for no visible change.
        expect(isRenderIrrelevantSessionPatch(session, {
            active: true,
            thinking: false,
            activeAt: 11_000,
            model: 'opus',
            effort: null,
            permissionMode: 'default',
            serviceTier: null
        })).toBe(true)
    })

    it('treats an activeAt move of at least one minute as render-relevant', () => {
        // Live sessions need the cached stamp to advance so the header does
        // not flip from `just now` to `1m ago` while keep-alives continue.
        expect(isRenderIrrelevantSessionPatch(session, {
            active: true,
            thinking: false,
            activeAt: 1_000 + 60_000,
            model: 'opus',
            effort: null,
            permissionMode: 'default',
            serviceTier: null
        })).toBe(false)
    })

    it('reports a changed field as relevant even alongside a new activeAt', () => {
        expect(isRenderIrrelevantSessionPatch(session, {
            thinking: true,
            activeAt: 11_000
        })).toBe(false)
    })

    it('reports a field the session does not carry yet as relevant', () => {
        // scratchlistUpdatedAt is absent from the cached session, so the patch
        // genuinely adds information and must not be dropped.
        expect(isRenderIrrelevantSessionPatch(session, {
            activeAt: 11_000,
            scratchlistUpdatedAt: 5_000
        })).toBe(false)
    })

    it('treats an empty patch as irrelevant', () => {
        expect(isRenderIrrelevantSessionPatch(session, {})).toBe(true)
    })
})

describe('applySessionDetailPatch (PR #897 review, Copilot keep-alive)', () => {
    const session = {
        id: 'session-1',
        active: true,
        thinking: false,
        activeAt: 1_000,
        updatedAt: 2_000,
        model: 'gpt-5',
        effort: null,
        permissionMode: 'default',
        collaborationMode: undefined,
        copilotAgentMode: 'interactive',
        serviceTier: null,
        metadataVersion: 1,
        agentStateVersion: 1,
        todosUpdatedAt: 0,
        teamStateUpdatedAt: 0
    } as unknown as Session

    it('applies a copilotAgentMode keep-alive change to the detail session', () => {
        // Hub emits copilotAgentMode from markSessionActive keep-alives. The
        // field-by-field mapper must copy it — otherwise detailPatched=true
        // suppresses invalidation and SessionChat keeps the stale mode.
        const next = applySessionDetailPatch(session, {
            active: true,
            thinking: false,
            activeAt: 11_000,
            copilotAgentMode: 'plan'
        })
        expect(next).not.toBeNull()
        expect(next?.copilotAgentMode).toBe('plan')
        expect(next?.activeAt).toBe(11_000)
    })

    it('returns null for a keep-alive that only repeats the current Copilot mode', () => {
        expect(applySessionDetailPatch(session, {
            active: true,
            thinking: false,
            activeAt: 11_000,
            copilotAgentMode: 'interactive'
        })).toBeNull()
    })

    it('carries activeTurnStartedAt so the running-turn anchor survives patches', () => {
        const running = { ...session, activeTurnStartedAt: 4_200 } as Session
        const next = applySessionDetailPatch(running, { activeTurnStartedAt: 5_800 })
        expect(next?.activeTurnStartedAt).toBe(5_800)

        const cleared = applySessionDetailPatch(running, {
            active: false,
            thinking: false,
            activeTurnStartedAt: null
        })
        expect(cleared?.activeTurnStartedAt).toBeNull()
    })

    it('carries resumeWithSessionModel so composer resume state does not go stale', () => {
        const next = applySessionDetailPatch(session, { resumeWithSessionModel: true })
        expect(next?.resumeWithSessionModel).toBe(true)
    })
})

describe('mergeCachedMachine (machine filter bar owner-grouping flicker)', () => {
    const cached: MachineWithOwner = {
        id: 'm1',
        namespace: 'default',
        seq: 1,
        createdAt: 0,
        updatedAt: 0,
        active: true,
        activeAt: 0,
        metadata: { host: 'DESKTOP-4SQALMG', platform: 'win32', happyCliVersion: '0.27.0', displayName: '小主机' },
        metadataVersion: 1,
        runnerState: null,
        runnerStateVersion: 0,
        ownerUsername: 'admin'
    }

    function event(overrides: Partial<Machine>): Machine {
        return { ...cached, ownerUsername: undefined, ...overrides } as Machine
    }

    it('keeps the gateway-assigned owner that the event never carries', () => {
        // This is the bug: a bare heartbeat used to overwrite the decorated
        // entry, dropping the owner and flattening the whole filter bar.
        const merged = mergeCachedMachine(cached, event({ activeAt: 999 }))

        expect(merged.ownerUsername).toBe('admin')
        expect(merged.activeAt).toBe(999)
    })

    it('keeps the alias when the event omits metadata entirely', () => {
        const merged = mergeCachedMachine(cached, event({ metadata: null }))

        expect(merged.metadata?.displayName).toBe('小主机')
        expect(merged.metadata?.host).toBe('DESKTOP-4SQALMG')
    })

    it('keeps metadata keys the event does not mention', () => {
        const merged = mergeCachedMachine(
            cached,
            event({ metadata: { host: 'DESKTOP-4SQALMG', platform: 'win32', happyCliVersion: '0.27.1' } })
        )

        expect(merged.metadata?.happyCliVersion).toBe('0.27.1')
        expect(merged.metadata?.displayName).toBe('小主机')
    })

    it('still lets the event win on the fields it does report', () => {
        const merged = mergeCachedMachine(
            cached,
            event({ metadata: { host: 'renamed-host', platform: 'win32', happyCliVersion: '0.27.0', displayName: 'new alias' } })
        )

        expect(merged.metadata?.displayName).toBe('new alias')
        expect(merged.metadata?.host).toBe('renamed-host')
    })
})

describe('QueryCacheProjector — reference retention', () => {
    it('keeps list cache identity when a keep-alive patch changes nothing renderable', () => {
        vi.useFakeTimers()
        const { queryClient, projector, sessions } = makeProjector()
        const initial = makeSummary()
        seed(queryClient, [initial], makeDetail({ thinking: false }))
        const response = sessions()

        projector.project({
            type: 'session-updated',
            sessionId: 'session-1',
            data: { active: true, thinking: false, activeAt: 11_000 }
        } as SyncEvent)

        // Same SessionsResponse object AND same summary object — no re-render
        // broadcast for an invisible field.
        expect(sessions()?.sessions[0]).toBe(initial)
        expect(sessions()).toBe(response)
        vi.advanceTimersByTime(20)
        expect(queryClient.getQueryState(queryKeys.sessions)?.isInvalidated).toBe(false)
        expect(queryClient.getQueryState(queryKeys.session('session-1'))?.isInvalidated).toBe(false)
    })

    it('revalidates an unhydrated detail without invalidating the unchanged summary list', () => {
        vi.useFakeTimers()
        const { queryClient, projector, sessions } = makeProjector()
        seed(queryClient, [makeSummary()])
        const response = sessions()
        // Model an inactive detail query whose data has not been hydrated.
        // The projector cannot fold a patch into it; it must be stale on open.
        const detailQuery = queryClient.getQueryCache().build(queryClient, {
            queryKey: queryKeys.session('session-1')
        })
        projector.project({
            type: 'session-updated',
            sessionId: 'session-1',
            data: { active: true, thinking: false, activeAt: 11_000 }
        } as SyncEvent)
        vi.advanceTimersByTime(20)
        expect(sessions()).toBe(response)
        expect(queryClient.getQueryState(queryKeys.sessions)?.isInvalidated).toBe(false)
        expect(detailQuery.state.isInvalidated).toBe(true)
    })

    it('keeps sibling summary references when one session updates', () => {
        vi.useFakeTimers()
        const { queryClient, projector, sessions } = makeProjector()
        const first = makeSummary({ id: 'a' })
        const second = makeSummary({ id: 'b' })
        seed(queryClient, [first, second])

        projector.project({
            type: 'session-updated',
            sessionId: 'b',
            data: { thinking: true }
        } as SyncEvent)

        const next = sessions()!
        expect(next.sessions.find((s) => s.id === 'a')).toBe(first)
        expect(next.sessions.find((s) => s.id === 'b')).not.toBe(second)
        expect(next.sessions.find((s) => s.id === 'b')?.thinking).toBe(true)
    })

    it('keeps detail cache identity on a keep-alive churn patch', () => {
        vi.useFakeTimers()
        const { queryClient, projector, detail } = makeProjector()
        const session = makeDetail({ activeTurnStartedAt: null, backgroundTaskCount: 0 })
        seed(queryClient, [], session)

        projector.project({
            type: 'session-updated',
            sessionId: 'session-1',
            data: { active: true, thinking: true, activeAt: 1_010 }
        } as SyncEvent)

        expect(detail('session-1')?.session).toBe(session)
    })
})

describe('QueryCacheProjector — versioned gates', () => {
    it('rejects a stale metadata patch on the summary but keeps newer state', () => {
        vi.useFakeTimers()
        const { queryClient, projector, sessions } = makeProjector()
        const summary = makeSummary({
            metadataVersion: 3,
            metadata: { path: '/work', name: 'alpha' } as SessionSummary['metadata']
        })
        seed(queryClient, [summary])

        projector.project({
            type: 'session-updated',
            sessionId: 'session-1',
            data: { metadata: { version: 2, value: { path: '/stale', host: 'test' } } }
        } as SyncEvent)

        const current = sessions()!.sessions[0]
        expect(current).toBe(summary)
        expect(current.metadata?.path).toBe('/work')
    })

    it('applies a newer metadata patch to the summary', () => {
        vi.useFakeTimers()
        const { queryClient, projector, sessions } = makeProjector()
        seed(queryClient, [makeSummary({ metadataVersion: 1 })])

        projector.project({
            type: 'session-updated',
            sessionId: 'session-1',
            data: { metadata: { version: 4, value: { path: '/new', host: 'test', name: 'beta' } } }
        } as SyncEvent)

        expect(sessions()!.sessions[0].metadata?.path).toBe('/new')
        expect(sessions()!.sessions[0].metadataVersion).toBe(4)
    })

    it('never rewinds updatedAt on the summary when an older patch replays', () => {
        vi.useFakeTimers()
        const { queryClient, projector, sessions } = makeProjector()
        seed(queryClient, [makeSummary({ updatedAt: 9_000 })])

        projector.project({
            type: 'session-updated',
            sessionId: 'session-1',
            data: { updatedAt: 4_000 }
        } as SyncEvent)

        expect(sessions()!.sessions[0].updatedAt).toBe(9_000)
    })
})

describe('QueryCacheProjector — unversioned session-ended revalidation', () => {
    it('does not kill a resumed same-ID session when an older end event replays', async () => {
        vi.useFakeTimers()
        const { queryClient, projector, sessions, detail } = makeProjector()
        const resumed = makeDetail({
            active: true, thinking: true, activeAt: 90_000,
            activeTurnStartedAt: 89_000, updatedAt: 90_000,
            metadataVersion: 8, backgroundTaskCount: 3
        })
        const summary = makeSummary({ active: true, thinking: true, updatedAt: 90_000, metadataVersion: 8 })
        seed(queryClient, [summary], resumed)
        const authoritative = { ...resumed, updatedAt: 91_000 }
        const authoritativeSummary = { ...summary, updatedAt: 91_000 }
        const listObserver = new QueryObserver(queryClient, {
            queryKey: queryKeys.sessions,
            queryFn: async () => ({ sessions: [authoritativeSummary] }),
            staleTime: Infinity
        })
        const detailObserver = new QueryObserver(queryClient, {
            queryKey: queryKeys.session(resumed.id),
            queryFn: async () => ({ session: authoritative }),
            staleTime: Infinity
        })
        const unsubscribeList = listObserver.subscribe(() => { })
        const unsubscribeDetail = detailObserver.subscribe(() => { })
        try {
            projector.project({ type: 'session-ended', sessionId: resumed.id, reason: 'terminated' })
            // The old writer's unversioned end cannot mutate current state,
            // even temporarily before REST returns.
            expect(sessions()!.sessions[0]).toBe(summary)
            expect(detail(resumed.id)!.session).toBe(resumed)
            await vi.advanceTimersByTimeAsync(20)
            // Real active observers fetched authoritative state, not merely
            // an invalidation spy call.
            expect(sessions()!.sessions[0].updatedAt).toBe(91_000)
            expect(sessions()!.sessions[0].active).toBe(true)
            expect(detail(resumed.id)!.session).toMatchObject({
                active: true, thinking: true, activeTurnStartedAt: 89_000,
                backgroundTaskCount: 3, metadataVersion: 8, updatedAt: 91_000
            })
        } finally {
            unsubscribeList()
            unsubscribeDetail()
            projector.dispose()
            queryClient.clear()
        }
    })

    it.each(['terminated', 'cleared'] as const)('reconciles an ordinary %s end from REST without dropping pending state', async (reason) => {
        vi.useFakeTimers()
        const { queryClient, projector, sessions, detail } = makeProjector()
        const summary = makeSummary({
            thinking: true, pendingRequestsCount: 1, pendingRequestKinds: ['permission'],
            pendingRequests: [{ id: 'req-1', kind: 'permission', tool: 'Write', since: 1_000 }],
            futureScheduledMessageCount: 2, nextScheduledAt: 100_000
        })
        const session = makeDetail({ agentState: { requests: { 'req-1': { tool: 'Write', arguments: {} } } } })
        seed(queryClient, [summary], session)
        const ended = { ...session, active: false, thinking: false, activeTurnStartedAt: null, backgroundTaskCount: 0 }
        const endedSummary = { ...summary, active: false, thinking: false, backgroundTaskCount: 0 }
        const listObserver = new QueryObserver(queryClient, {
            queryKey: queryKeys.sessions,
            queryFn: async () => ({ sessions: [endedSummary] }),
            staleTime: Infinity
        })
        const detailObserver = new QueryObserver(queryClient, {
            queryKey: queryKeys.session(session.id),
            queryFn: async () => ({ session: ended }),
            staleTime: Infinity
        })
        const unsubscribeList = listObserver.subscribe(() => { })
        const unsubscribeDetail = detailObserver.subscribe(() => { })
        try {
            projector.project({ type: 'session-ended', sessionId: session.id, reason })
            expect(detail(session.id)!.session).toBe(session)
            await vi.advanceTimersByTimeAsync(20)
            expect(detail(session.id)!.session).toMatchObject({
                active: false, thinking: false, activeTurnStartedAt: null, backgroundTaskCount: 0,
                agentState: session.agentState
            })
            expect(sessions()!.sessions).toHaveLength(1)
            expect(sessions()!.sessions[0]).toMatchObject({
                active: false, thinking: false, pendingRequestsCount: 1,
                pendingRequests: summary.pendingRequests,
                futureScheduledMessageCount: 2, nextScheduledAt: 100_000
            })
        } finally {
            unsubscribeList()
            unsubscribeDetail()
            projector.dispose()
            queryClient.clear()
        }
    })
})

describe('QueryCacheProjector — session-removed vs ended', () => {
    it('drops summary and detail on removal, unlike session-ended', () => {
        vi.useFakeTimers()
        const { queryClient, projector, sessions, detail } = makeProjector()
        seed(queryClient, [makeSummary()], makeDetail())

        projector.project({ type: 'session-removed', sessionId: 'session-1' } as SyncEvent)

        expect(sessions()!.sessions).toHaveLength(0)
        expect(detail('session-1')).toBeUndefined()
    })
})

describe('QueryCacheProjector — invalidation fallbacks and batching', () => {
    it('falls back to detail + list invalidation when a patch cannot be applied', () => {
        vi.useFakeTimers()
        const { projector, flushed } = makeProjector()
        // Empty caches: patch applies nowhere → both invalidations queued.
        projector.project({
            type: 'session-updated',
            sessionId: 'ghost',
            data: { thinking: true }
        } as SyncEvent)

        const calls = flushed()
        expect(calls).toContainEqual({ queryKey: queryKeys.session('ghost') })
        expect(calls).toContainEqual({ queryKey: queryKeys.sessions })
    })

    it('queues scratchlist invalidation when the patch carries the piggyback token', () => {
        vi.useFakeTimers()
        const { queryClient, projector, flushed } = makeProjector()
        seed(queryClient, [makeSummary()], makeDetail())

        projector.project({
            type: 'session-updated',
            sessionId: 'session-1',
            data: { scratchlistUpdatedAt: 9_999 }
        } as SyncEvent)

        expect(flushed()).toContainEqual({ queryKey: queryKeys.scratchlist('session-1') })
    })

    it('batches several queued invalidations into one flush', () => {
        vi.useFakeTimers()
        const { queryClient, projector, flushed, invalidate } = makeProjector()
        seed(queryClient, [makeSummary()])

        projector.project({ type: 'messages-invalidated', sessionId: 'session-1' } as SyncEvent)
        projector.project({ type: 'scheduled-matured', sessionId: 'session-1' } as SyncEvent)
        projector.project({ type: 'messages-consumed', sessionId: 'session-1', localIds: ['l1'], invokedAt: 1 } as SyncEvent)

        const calls = flushed()
        // One batched flush: sessions invalidation once, not three times.
        expect(invalidate).toHaveBeenCalledTimes(1)
        expect(calls).toEqual([{ queryKey: queryKeys.sessions }])
    })

    it('does not queue message-ownership invalidation on the session-scoped connection', () => {
        vi.useFakeTimers()
        const { projector, flushed } = makeProjector('full')

        projector.project({ type: 'messages-invalidated', sessionId: 'session-1' } as SyncEvent)
        projector.project({ type: 'messages-consumed', sessionId: 'session-1', localIds: ['l1'], invokedAt: 1 } as SyncEvent)

        expect(flushed()).toEqual([])
    })

    it('cancels a pending flush on dispose', () => {
        vi.useFakeTimers()
        const { projector, invalidate } = makeProjector()
        projector.project({ type: 'messages-invalidated', sessionId: 'session-1' } as SyncEvent)
        projector.dispose()
        vi.advanceTimersByTime(1_000)
        expect(invalidate).not.toHaveBeenCalled()
    })

    it('removes a machine on active=false patch and queues invalidation for unknown payloads', () => {
        vi.useFakeTimers()
        const { queryClient, projector, flushed } = makeProjector()
        queryClient.setQueryData(queryKeys.machines, {
            machines: [{ id: 'm1', active: true } as MachineWithOwner]
        })

        projector.project({ type: 'machine-updated', machineId: 'm1', data: { active: false } } as SyncEvent)
        expect(queryClient.getQueryData<{ machines: MachineWithOwner[] }>(queryKeys.machines)?.machines).toHaveLength(0)

        projector.project({ type: 'machine-updated', machineId: 'm2', data: { activeAt: 5 } } as SyncEvent)
        expect(flushed()).toContainEqual({ queryKey: queryKeys.machines })
    })
})
