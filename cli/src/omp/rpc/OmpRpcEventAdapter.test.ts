import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage } from '@/agent/types';
import type { RawJSONLines } from '@/claude/types';
import type { JsonObject, OmpKnownEventType } from './types';
import type { OmpAgentRunEvent, OmpRpcEventAdapterCallbacks, OmpStructuredEvent } from './OmpRpcEventAdapter';
import { OmpRpcEventAdapter } from './OmpRpcEventAdapter';
import { parseOmpInboundLine } from './schemas';
import { RuntimeTimelineProjection, type RuntimePublication } from '@hapi/protocol/runtimeTimeline';
import { RawJSONLinesSchema } from '@/claude/types';

function rpcEvent(frame: Record<string, unknown>) {
    const parsed = parseOmpInboundLine(JSON.stringify(frame));
    if (parsed.kind !== 'event') throw new Error(`Expected event, received ${parsed.kind}`);
    return parsed.event;
}

function assistantMessage(text: string, responseId?: string): JsonObject {
    return {
        role: 'assistant',
        content: [
            { type: 'thinking', thinking: `reasoning:${text}` },
            { type: 'text', text }
        ],
        provider: 'test-provider',
        model: 'test-model',
        ...(responseId === undefined ? {} : { responseId }),
        usage: {
            input: 11,
            output: 7,
            cacheRead: 3,
            cacheWrite: 2,
            totalTokens: 23,
            reasoningTokens: 5,
            cost: { input: 0.01, output: 0.02, cacheRead: 0.003, cacheWrite: 0.002, total: 0.035 }
        },
        stopReason: 'stop'
    };
}

function createHarness(eventAllowlist?: ReadonlySet<OmpKnownEventType>, enableRuntime = false) {
    const canonicalMessages: RawJSONLines[] = [];
    const agentMessages: AgentMessage[] = [];
    const agentRunEvents: OmpAgentRunEvent[] = [];
    const traces: Array<{
        scope: Parameters<OmpRpcEventAdapterCallbacks['onAgentRunTrace']>[0];
        message: AgentMessage;
    }> = [];
    const structuredEvents: OmpStructuredEvent[] = [];
    const hostEvents: Parameters<OmpRpcEventAdapterCallbacks['onHostEvent']>[0][] = [];
    const availableCommands: Parameters<OmpRpcEventAdapterCallbacks['onAvailableCommandsChanged']>[0][] = [];
    const diagnostics: string[] = [];
    const publications: RuntimePublication[] = [];
    const callbacks: OmpRpcEventAdapterCallbacks = {
        ...(enableRuntime ? { onRuntimePublication: (publication: RuntimePublication) => publications.push(publication) } : {}),
        onAgentMessage: (message) => agentMessages.push(message),
        onCanonicalMessage: (message) => canonicalMessages.push(message),
        onAgentRunEvent: (event) => agentRunEvents.push(event),
        onAgentRunTrace: (scope, message) => traces.push({ scope, message }),
        onStructuredEvent: (event) => structuredEvents.push(event),
        onInkMessage: vi.fn(),
        onUserMessageCommitted: vi.fn(),
        onTurnStarted: vi.fn(),
        onTurnFinished: vi.fn(),
        onPromptResult: vi.fn(),
        onSessionInfoUpdate: vi.fn(),
        onAvailableCommandsChanged: (commands) => availableCommands.push(commands),
        onThinkingStateChanged: vi.fn(),
        onDiagnostic: (message) => diagnostics.push(message),
        onHostEvent: (event) => hostEvents.push(event)
    };
    return {
        adapter: new OmpRpcEventAdapter(callbacks, eventAllowlist),
        callbacks,
        publications,
        canonicalMessages,
        agentMessages,
        agentRunEvents,
        traces,
        structuredEvents,
        hostEvents,
        availableCommands,
        diagnostics
    };
}

describe('OmpRpcEventAdapter', () => {
    it('keeps input receipt controls out of timeline, chat, and native user-commit callbacks', () => {
        const harness = createHarness(undefined, true);
        const initialPublications = structuredClone(harness.publications);
        harness.adapter.handle(rpcEvent({
            type: 'input_receipt', receipt: {
                token: 'local-id', sessionId: 'original-native', admitted: true, delivered: true, entryId: 'user-entry'
            }
        }));
        expect(harness.canonicalMessages).toEqual([]);
        expect(harness.agentMessages).toEqual([]);
        expect(harness.structuredEvents).toEqual([]);
        expect(harness.publications).toEqual(initialPublications);
        expect(harness.callbacks.onUserMessageCommitted).not.toHaveBeenCalled();
    });
    it.each(['open-elsewhere', 'replaced', 'contested'])('reconciles %s persistence relocation before the turn ends even when notices are hidden', (reason) => {
        const harness = createHarness(new Set<OmpKnownEventType>());
        harness.adapter.handle(rpcEvent({
            type: 'notice', level: 'warning', message: 'Session moved',
            source: 'session-persistence', reason, from: '/old.jsonl', to: '/new.jsonl'
        }));
        expect(harness.callbacks.onSessionInfoUpdate).toHaveBeenCalledOnce();
        expect(harness.callbacks.onTurnFinished).not.toHaveBeenCalled();
        expect(harness.structuredEvents).toEqual([]);
    });

    it('does not treat an unrelated or incomplete notice as a native relocation', () => {
        const harness = createHarness();
        for (const frame of [
            { source: 'extension', reason: 'open-elsewhere', from: '/old', to: '/new' },
            { source: 'session-persistence', reason: 'open-elsewhere', from: '/old' },
            { source: 'session-persistence' }
        ]) {
            harness.adapter.handle(rpcEvent({ type: 'notice', level: 'warning', message: 'Notice', ...frame }));
        }
        expect(harness.callbacks.onSessionInfoUpdate).not.toHaveBeenCalled();
        expect(harness.structuredEvents).toHaveLength(3);
    });

    it('passes the failure text only for prompts that failed before reaching the agent', () => {
        const harness = createHarness();
        harness.adapter.handle(rpcEvent({
            type: 'prompt_result', id: 'hapi_12', agentInvoked: false, status: 'error',
            error: { message: 'Session file is locked', retryable: false }, sessionSettled: true
        }));
        harness.adapter.handle(rpcEvent({ type: 'prompt_result', id: 'hapi_13', agentInvoked: false, status: 'error' }));
        harness.adapter.handle(rpcEvent({
            type: 'prompt_result', id: 'hapi_14', agentInvoked: true, status: 'error', error: { message: '429 from provider' }
        }));
        harness.adapter.handle(rpcEvent({ type: 'prompt_result', id: 'hapi_15', agentInvoked: false, status: 'completed' }));
        expect(vi.mocked(harness.callbacks.onPromptResult).mock.calls).toEqual([
            [false, 'Session file is locked'],
            [false, 'OMP reported an error without a message'],
            [true, undefined],
            [false, undefined]
        ]);
    });

    it('forwards the complete dynamic command catalog through a typed callback', () => {
        const harness = createHarness();
        harness.adapter.handle(rpcEvent({
            type: 'available_commands_update',
            commands: [{
                name: 'review',
                aliases: ['rv'],
                description: 'Review changes',
                input: { hint: 'path' },
                subcommands: [{ name: 'staged', usage: '/review staged' }],
                source: 'extension'
            }]
        }));

        expect(harness.availableCommands).toEqual([[
            {
                name: 'review',
                aliases: ['rv'],
                description: 'Review changes',
                input: { hint: 'path' },
                subcommands: [{ name: 'staged', usage: '/review staged' }],
                source: 'extension'
            }
        ]]);
        expect(harness.callbacks.onSessionInfoUpdate).not.toHaveBeenCalled();
    });

    it('commits one canonical assistant snapshot with separate display/provider IDs and native usage', () => {
        const harness = createHarness();
        const initial = assistantMessage('initial', 'provider-response-1');
        harness.adapter.handle(rpcEvent({ type: 'message_start', message: initial }));
        harness.adapter.handle(rpcEvent({
            type: 'message_update',
            message: assistantMessage('streamed', 'provider-response-1'),
            assistantMessageEvent: { type: 'text_delta', delta: 'streamed' }
        }));
        harness.adapter.handle(rpcEvent({
            type: 'message_end',
            message: assistantMessage('final', 'provider-response-1')
        }));

        expect(harness.canonicalMessages).toHaveLength(1);
        const committed = harness.canonicalMessages[0];
        if (committed.type !== 'assistant') throw new Error(`Expected assistant, received ${committed.type}`);
        expect(committed.uuid).not.toBe('provider-response-1');
        expect(committed.providerMessageId).toBe('provider-response-1');
        expect(committed.message).toMatchObject({
            model: 'test-provider/test-model',
            content: [
                { type: 'thinking', thinking: 'reasoning:final' },
                { type: 'text', text: 'final' }
            ],
            usage: {
                input_tokens: 11,
                output_tokens: 7,
                reasoning_output_tokens: 5,
                cost_usd: 0.035
            }
        });
        expect(harness.agentMessages).toContainEqual({
            type: 'usage',
            inputTokens: 11,
            outputTokens: 7,
            totalTokens: 23,
            thoughtTokens: 5,
            cacheReadTokens: 3,
            cacheCreationTokens: 2,
            costUsd: 0.035
        });
    });
    it('propagates authoritative nativeOrder to canonical, agent, and structured outputs', () => {
        const origins: unknown[] = [];
        const structuredOrigins: unknown[] = [];
        const harness = createHarness();
        const callbacks: OmpRpcEventAdapterCallbacks = {
            ...harness.callbacks,
            onCanonicalMessage: (message, nativeOrder) => origins.push(nativeOrder),
            onStructuredEvent: (event, nativeOrder) => structuredOrigins.push(nativeOrder)
        };
        const adapter = new OmpRpcEventAdapter(callbacks);
        const order = { sessionId: 'native-a', entryId: 'E7', entryOrder: 7, eventOrder: 2 };
        adapter.handle(rpcEvent({ type: 'message_start', message: assistantMessage('x'), nativeOrder: order }));
        adapter.handle(rpcEvent({ type: 'message_end', message: assistantMessage('x'), nativeOrder: order }));
        expect(origins).toEqual([order]);
        adapter.handle(rpcEvent({
            type: 'notice', level: 'info', message: 'm', source: 'status', nativeOrder: order
        }));
        expect(structuredOrigins).toEqual([order]);
    });

    it('keeps an interrupted assistant message on its message_start journal anchor', () => {
        const origins: unknown[] = [];
        const harness = createHarness();
        const adapter = new OmpRpcEventAdapter({
            ...harness.callbacks,
            onCanonicalMessage: (message, nativeOrder) => origins.push(nativeOrder)
        });
        const startOrder = { sessionId: 'native-a', entryId: 'U1', entryOrder: 4, eventOrder: 1 };
        const laterAnchor = { sessionId: 'native-a', entryId: 'E9', entryOrder: 9, eventOrder: 0 };
        adapter.handle(rpcEvent({ type: 'message_start', message: assistantMessage('partial'), nativeOrder: startOrder }));
        adapter.handle(rpcEvent({ type: 'turn_end', nativeOrder: laterAnchor }));
        expect(origins).toEqual([startOrder]);
    });

    it('publishes tokenless local user entries as canonical user rows on their committed entry', () => {
        const committed: Array<{ message: RawJSONLines; nativeOrder: unknown }> = [];
        const harness = createHarness();
        const adapter = new OmpRpcEventAdapter({
            ...harness.callbacks,
            onCanonicalMessage: (message, nativeOrder) => committed.push({ message, nativeOrder })
        });
        const order = { sessionId: 'native-a', entryId: 'E3', entryOrder: 3, eventOrder: 0 };
        adapter.handle(rpcEvent({
            type: 'message_end',
            message: { role: 'user', content: 'typed locally', timestamp: 1_710_000_000_000 },
            nativeOrder: order
        }));
        expect(harness.callbacks.onUserMessageCommitted).toHaveBeenCalledOnce();
        expect(committed).toHaveLength(1);
        expect(committed[0].nativeOrder).toEqual(order);
        expect(committed[0].message.type).toBe('user');
        adapter.handle(rpcEvent({
            type: 'message_end',
            message: { role: 'user', clientToken: 'remote-local-id', content: 'remote prompt' },
            nativeOrder: order
        }));
        expect(committed).toHaveLength(1);
    });

    it('stamps native-ordered assistants with their source timestamp; legacy stays commit time', () => {
        // With nativeOrder the hub sorts by journal coordinates, so wall-time
        // provenance must be preserved. Without the capability, commit time
        // remains the legacy causal approximation.
        const harness = createHarness();
        const turnStart = Date.now() - 10_000;
        const message = { ...assistantMessage('final', 'provider-response-1'), timestamp: turnStart };
        const order = { sessionId: 'native-a', entryId: 'E1', entryOrder: 1, eventOrder: 0 };
        harness.adapter.handle(rpcEvent({ type: 'message_start', message, nativeOrder: order }));
        harness.adapter.handle(rpcEvent({ type: 'message_end', message, nativeOrder: order }));
        const committed = harness.canonicalMessages[0];
        if (committed.type !== 'assistant') throw new Error(`Expected assistant, received ${committed.type}`);
        expect(Date.parse(committed.timestamp ?? '')).toBe(turnStart);

        const legacy = createHarness();
        legacy.adapter.handle(rpcEvent({ type: 'message_start', message }));
        legacy.adapter.handle(rpcEvent({ type: 'message_end', message }));
        const legacyCommitted = legacy.canonicalMessages[0];
        if (legacyCommitted.type !== 'assistant') throw new Error(`Expected assistant, received ${legacyCommitted.type}`);
        expect(Date.parse(legacyCommitted.timestamp ?? '')).toBeGreaterThanOrEqual(turnStart + 9_000);
    });

    it('keeps one tool card identity through start/update/end and commits only the message_end result', () => {
        const harness = createHarness();
        harness.adapter.handle(rpcEvent({
            type: 'tool_execution_start',
            toolCallId: 'tool-1',
            toolName: 'bash',
            args: { command: 'printf start' }
        }));
        harness.adapter.handle(rpcEvent({
            type: 'tool_execution_update',
            toolCallId: 'tool-1',
            toolName: 'bash',
            args: { command: 'mutated update args' },
            partialResult: { content: 'partial' }
        }));
        harness.adapter.handle(rpcEvent({
            type: 'tool_execution_end',
            toolCallId: 'tool-1',
            toolName: 'bash',
            result: { content: 'execution end' },
            isError: false
        }));
        harness.adapter.handle(rpcEvent({
            type: 'message_start',
            message: {
                role: 'toolResult',
                toolCallId: 'tool-1',
                toolName: 'bash',
                content: [{ type: 'text', text: 'canonical result' }],
                isError: false
            }
        }));
        harness.adapter.handle(rpcEvent({
            type: 'message_end',
            message: {
                role: 'toolResult',
                toolCallId: 'tool-1',
                toolName: 'bash',
                content: [{ type: 'text', text: 'canonical result' }],
                details: { exitCode: 0 },
                isError: false
            }
        }));

        const lifecycle = harness.agentMessages.filter((message) => message.type === 'tool_call');
        // Neither update nor end repeats the card once in_progress has been emitted; completion comes from toolResult.
        expect(lifecycle).toHaveLength(1);
        expect(lifecycle.map((message) => message.id)).toEqual(['tool-1']);
        expect(lifecycle.map((message) => message.status)).toEqual(['in_progress']);
        expect(lifecycle.map((message) => message.input)).toEqual([
            { command: 'printf start' }
        ]);
        expect(harness.agentMessages.some((message) => message.type === 'tool_result')).toBe(false);
        expect(harness.canonicalMessages).toHaveLength(1);
        expect(harness.canonicalMessages[0]).toMatchObject({
            type: 'user',
            message: {
                content: [{
                    type: 'tool_result',
                    tool_use_id: 'tool-1',
                    content: {
                        content: [{ type: 'text', text: 'canonical result' }],
                        details: { exitCode: 0 }
                    },
                    is_error: false
                }]
            }
        });
    });

    it('owns two OMP subagents with stable cards, exact retry state, child traces, and terminal results', () => {
        const harness = createHarness();
        for (const [index, id] of ['alpha', 'beta'].entries()) {
            harness.adapter.handle(rpcEvent({
                type: 'subagent_lifecycle',
                payload: {
                    id,
                    agent: 'task',
                    agentSource: 'bundled',
                    description: `worker ${id}`,
                    status: 'started',
                    parentToolCallId: 'task-parent',
                    index
                }
            }));
        }
        harness.adapter.handle(rpcEvent({
            type: 'subagent_progress',
            payload: {
                index: 0,
                agent: 'task',
                agentSource: 'bundled',
                task: 'alpha work',
                parentToolCallId: 'task-parent',
                progress: {
                    id: 'alpha',
                    status: 'running',
                    retryState: {
                        attempt: 2,
                        maxAttempts: 4,
                        delayMs: 1500,
                        errorMessage: 'rate limited',
                        startedAtMs: 123456
                    }
                }
            }
        }));
        for (const id of ['alpha', 'beta']) {
            harness.adapter.handle(rpcEvent({
                type: 'subagent_event',
                payload: {
                    id,
                    event: { type: 'message_end', message: assistantMessage(`${id} final`) }
                }
            }));
            harness.adapter.handle(rpcEvent({
                type: 'subagent_lifecycle',
                payload: {
                    id,
                    agent: 'task',
                    agentSource: 'bundled',
                    description: `worker ${id}`,
                    status: 'completed',
                    parentToolCallId: 'task-parent',
                    index: id === 'alpha' ? 0 : 1
                }
            }));
        }

        const starts = harness.agentRunEvents.filter((event) => event.type === 'agent-run-start');
        expect(starts.map((event) => event.cardId)).toEqual([
            'omp-subagent:alpha',
            'omp-subagent:beta'
        ]);
        expect(starts.every((event) => event.parentToolCallId === 'task-parent')).toBe(true);
        const retry = harness.agentRunEvents.find((event) => (
            event.type === 'agent-run-update' && event.retryState !== undefined
        ));
        expect(retry).toMatchObject({
            agentId: 'alpha',
            retryState: {
                attempt: 2,
                maxAttempts: 4,
                delayMs: 1500,
                errorMessage: 'rate limited',
                startedAtMs: 123456
            }
        });
        expect(JSON.stringify(retry)).not.toContain('reset');
        expect(harness.traces.filter((trace) => trace.message.type === 'text')).toEqual([
            expect.objectContaining({ scope: expect.objectContaining({ agentId: 'alpha', cardId: 'omp-subagent:alpha' }) }),
            expect.objectContaining({ scope: expect.objectContaining({ agentId: 'beta', cardId: 'omp-subagent:beta' }) })
        ]);
        const terminal = harness.agentRunEvents.filter((event) => (
            event.type === 'agent-run-update' && event.status === 'completed'
        ));
        expect(terminal).toEqual(expect.arrayContaining([
            expect.objectContaining({ agentId: 'alpha', result: 'alpha final' }),
            expect.objectContaining({ agentId: 'beta', result: 'beta final' })
        ]));
    });

    it('keeps subagent tool identity and original arguments through execution and canonical result', () => {
        const harness = createHarness();
        harness.adapter.handle(rpcEvent({
            type: 'subagent_lifecycle',
            payload: {
                id: 'alpha',
                agent: 'task',
                agentSource: 'bundled',
                status: 'started',
                parentToolCallId: 'task-parent',
                index: 0
            }
        }));
        for (const event of [
            {
                type: 'tool_execution_start',
                toolCallId: 'child-tool',
                toolName: 'bash',
                args: { command: 'printf original' }
            },
            {
                type: 'tool_execution_update',
                toolCallId: 'child-tool',
                toolName: 'bash',
                args: { command: 'mutated update args' },
                partialResult: { content: 'partial' }
            },
            {
                type: 'tool_execution_end',
                toolCallId: 'child-tool',
                toolName: 'bash',
                result: { content: 'execution result' },
                isError: false
            }
        ]) {
            harness.adapter.handle(rpcEvent({
                type: 'subagent_event',
                payload: { id: 'alpha', event }
            }));
        }
        harness.adapter.handle(rpcEvent({
            type: 'subagent_event',
            payload: {
                id: 'alpha',
                event: {
                    type: 'message_end',
                    message: {
                        role: 'toolResult',
                        toolCallId: 'child-tool',
                        toolName: 'bash',
                        content: [{ type: 'text', text: 'canonical result' }],
                        isError: false
                    }
                }
            }
        }));

        const childLifecycle = harness.traces
            .map((trace) => trace.message)
            .filter((message) => message.type === 'tool_call');
        expect(childLifecycle.map((message) => message.id)).toEqual([
            'child-tool'
        ]);
        expect(childLifecycle.map((message) => message.status)).toEqual(['in_progress']);
        expect(childLifecycle.map((message) => message.input)).toEqual([
            { command: 'printf original' }
        ]);
        expect(harness.traces.map((trace) => trace.message)).toContainEqual({
            type: 'tool_result',
            id: 'child-tool',
            output: {
                content: [{ type: 'text', text: 'canonical result' }],
                details: undefined
            },
            status: 'completed'
        });
    });

    it('uses a successful task yield as the subagent result when no assistant text exists', () => {
        const harness = createHarness();
        harness.adapter.handle(rpcEvent({
            type: 'subagent_lifecycle',
            payload: {
                id: 'alpha',
                agent: 'task',
                agentSource: 'bundled',
                status: 'started',
                parentToolCallId: 'task-parent',
                index: 0
            }
        }));
        harness.adapter.handle(rpcEvent({
            type: 'subagent_progress',
            payload: {
                index: 0,
                agent: 'task',
                agentSource: 'bundled',
                task: 'alpha work',
                parentToolCallId: 'task-parent',
                progress: {
                    id: 'alpha',
                    status: 'completed',
                    extractedToolData: {
                        yield: [
                            { data: 'ignored failure', status: 'error' },
                            { data: 'alpha yielded final', status: 'success' }
                        ]
                    }
                }
            }
        }));
        harness.adapter.handle(rpcEvent({
            type: 'subagent_lifecycle',
            payload: {
                id: 'alpha',
                agent: 'task',
                agentSource: 'bundled',
                status: 'completed',
                parentToolCallId: 'task-parent',
                index: 0
            }
        }));

        const completed = harness.agentRunEvents.filter((event) => (
            event.type === 'agent-run-update' && event.status === 'completed'
        ));
        expect(completed).toHaveLength(2);
        expect(completed).toEqual(expect.arrayContaining([
            expect.objectContaining({ agentId: 'alpha', result: 'alpha yielded final' })
        ]));
    });

    it('summarizes compaction events without forwarding snapcompact payloads', () => {
        const harness = createHarness();
        harness.adapter.handle(rpcEvent({
            type: 'auto_compaction_start',
            reason: 'threshold',
            action: 'snapcompact'
        }));
        harness.adapter.handle(rpcEvent({
            type: 'auto_compaction_end',
            action: 'snapcompact',
            aborted: false,
            willRetry: false,
            result: {
                shortSummary: 'Archived conversation history',
                tokensBefore: 182_000,
                preserveData: {
                    snapcompact: {
                        frames: [
                            { data: 'iVBORw0KGgo=', mimeType: 'image/png' },
                            { data: 'another-frame', mimeType: 'image/png' }
                        ],
                        totalChars: 217_555,
                        truncatedChars: 1_024,
                        text: 'archived conversation source'
                    }
                }
            }
        }));

        expect(harness.structuredEvents).toEqual([
            {
                type: 'omp-compaction',
                phase: 'started',
                action: 'snapcompact',
                reason: 'threshold'
            },
            {
                type: 'omp-compaction',
                phase: 'finished',
                action: 'snapcompact',
                willRetry: false,
                outcome: 'completed',
                result: {
                    shortSummary: 'Archived conversation history',
                    tokensBefore: 182_000,
                    archive: {
                        frameCount: 2,
                        totalChars: 217_555,
                        truncatedChars: 1_024
                    }
                }
            }
        ]);
        expect(JSON.stringify(harness.structuredEvents)).not.toContain('iVBORw0KGgo');
        expect(JSON.stringify(harness.structuredEvents)).not.toContain('archived conversation source');
    });

    it('preserves the fallback reason when OMP skips shake compaction', () => {
        const harness = createHarness();
        harness.adapter.handle(rpcEvent({
            type: 'auto_compaction_end',
            action: 'shake',
            aborted: false,
            willRetry: false,
            skipped: true,
            errorMessage: 'Auto-shake found nothing eligible to drop; falling back to context-full compaction.'
        }));

        expect(harness.structuredEvents).toEqual([{
            type: 'omp-compaction',
            phase: 'finished',
            action: 'shake',
            willRetry: false,
            outcome: 'skipped',
            message: 'Auto-shake found nothing eligible to drop; falling back to context-full compaction.'
        }]);
    });

    it('forwards model_changed as a session event instead of an unknown warning', () => {
        const harness = createHarness(new Set(['model_changed']));
        harness.adapter.handle(rpcEvent({ type: 'model_changed' }));

        expect(harness.structuredEvents).toEqual([{
            type: 'omp-session-event',
            eventType: 'model_changed',
            frame: { type: 'model_changed' }
        }]);
        expect(harness.diagnostics).toEqual([]);
        expect(harness.callbacks.onSessionInfoUpdate).toHaveBeenCalledOnce();
    });
    it('forwards rpc_frame_error as a readable transport warning', () => {
        const harness = createHarness();
        harness.adapter.handle(rpcEvent({
            type: 'rpc_frame_error',
            originalType: 'message_end',
            error: 'RPC frame exceeded the transport limit'
        }));

        expect(harness.structuredEvents).toEqual([{
            type: 'omp-rpc-warning',
            eventType: 'message_end',
            warning: 'OMP frame too large: message end',
            frame: {
                type: 'rpc_frame_error',
                originalType: 'message_end',
                error: 'RPC frame exceeded the transport limit'
            }
        }]);
        expect(harness.diagnostics).toEqual(['OMP rpc_frame_error: RPC frame exceeded the transport limit']);
    });

    it('keeps future events diagnostic without creating timeline warnings', () => {
        const harness = createHarness();
        harness.adapter.handle(rpcEvent({
            type: 'future_event',
            nested: { future: true },
            version: 18
        }));

        expect(harness.structuredEvents).toEqual([]);
        expect(harness.diagnostics).toEqual(['OMP event: future_event']);
    });

    it('keeps native control and accumulators working with no timeline output', () => {
        const harness = createHarness(new Set());
        for (const text of ['first', 'second']) {
            harness.adapter.handle(rpcEvent({ type: 'agent_start' }));
            harness.adapter.handle(rpcEvent({ type: 'message_start', message: assistantMessage(text) }));
            harness.adapter.handle(rpcEvent({
                type: 'message_update', message: assistantMessage(text),
                assistantMessageEvent: { type: 'text_delta', delta: text }
            }));
            harness.adapter.handle(rpcEvent({ type: 'message_end', message: assistantMessage(text) }));
            harness.adapter.handle(rpcEvent({ type: 'message_end', message: { role: 'user', steering: false } }));
            harness.adapter.handle(rpcEvent({ type: 'tool_execution_start', toolCallId: text, toolName: 'read', args: {} }));
            harness.adapter.handle(rpcEvent({ type: 'tool_execution_end', toolCallId: text, toolName: 'read', result: {} }));
            harness.adapter.handle(rpcEvent({ type: 'agent_end' }));
        }
        harness.adapter.handle(rpcEvent({ type: 'prompt_result', agentInvoked: false }));
        harness.adapter.handle(rpcEvent({ type: 'available_commands_update', commands: [{ name: 'review', source: 'extension' }] }));
        harness.adapter.handle(rpcEvent({ type: 'thinking_level_changed', thinkingLevel: 'high' }));
        harness.adapter.handle(rpcEvent({ type: 'config_update' }));
        harness.adapter.handle(rpcEvent({ type: 'host_tool_cancel', id: 'cancel', targetId: 'call' }));
        expect(harness.canonicalMessages).toEqual([]);
        expect(harness.agentMessages).toEqual([]);
        expect(harness.agentRunEvents).toEqual([]);
        expect(harness.traces).toEqual([]);
        expect(harness.structuredEvents).toEqual([]);
        expect(harness.callbacks.onInkMessage).toHaveBeenCalledWith('first', 'assistant');
        expect(harness.callbacks.onInkMessage).toHaveBeenCalledWith('second', 'assistant');
        expect(harness.callbacks.onTurnStarted).toHaveBeenCalledTimes(2);
        expect(harness.callbacks.onTurnFinished).toHaveBeenCalledTimes(2);
        expect(harness.callbacks.onUserMessageCommitted).toHaveBeenCalledTimes(2);
        expect(harness.callbacks.onPromptResult).toHaveBeenCalledWith(false, undefined);
        expect(harness.callbacks.onThinkingStateChanged).toHaveBeenCalledWith({ thinkingLevel: 'high' });
        expect(harness.callbacks.onSessionInfoUpdate).toHaveBeenCalledOnce();
        expect(harness.availableCommands).toEqual([[{ name: 'review', source: 'extension' }]]);
        expect(harness.hostEvents).toEqual([{
            type: 'host_tool_cancel', raw: {
                type: 'host_tool_cancel', id: 'cancel', targetId: 'call'
            }
        }]);
    });

    it('projects selected state and stream events without requiring final messages', () => {
        const harness = createHarness(new Set(['message_start', 'message_update', 'available_commands_update']));
        const frames = [
            { type: 'message_start', message: assistantMessage('start') },
            {
                type: 'message_update', message: assistantMessage('delta'),
                assistantMessageEvent: { type: 'text_delta', delta: 'delta' }
            },
            { type: 'available_commands_update', commands: [{ name: 'review', source: 'extension' }] }
        ];
        for (const frame of frames) harness.adapter.handle(rpcEvent(frame));
        harness.adapter.handle(rpcEvent({ type: 'message_end', message: assistantMessage('hidden') }));
        expect(harness.structuredEvents).toEqual(frames.map((frame) => ({
            type: 'omp-session-event', eventType: frame.type, frame
        })));
        expect(harness.canonicalMessages).toEqual([]);
    });

    it('stores one running card for a long tool call no matter how many progress updates arrive', () => {
        const harness = createHarness();
        harness.adapter.handle(rpcEvent({ type: 'tool_execution_start', toolCallId: 'wait-1', toolName: 'wait', args: { i: 'waiting' } }));
        for (let second = 0; second < 900; second += 1) {
            harness.adapter.handle(rpcEvent({
                type: 'tool_execution_update', toolCallId: 'wait-1', toolName: 'wait',
                args: { i: 'waiting' }, partialResult: { elapsed: second }
            }));
        }
        harness.adapter.handle(rpcEvent({ type: 'tool_execution_end', toolCallId: 'wait-1', toolName: 'wait', result: { done: true } }));
        harness.adapter.handle(rpcEvent({ type: 'tool_execution_start', toolCallId: 'wait-2', toolName: 'wait', args: { i: 'again' } }));

        expect(harness.agentMessages.filter((message) => message.type === 'tool_call').map((message) => [message.id, message.status])).toEqual([
            ['wait-1', 'in_progress'],
            ['wait-2', 'in_progress']
        ]);
    });

    it('shows a running card from the first update when the start event is not forwarded', () => {
        const harness = createHarness(new Set(['tool_execution_update', 'tool_execution_end']));
        harness.adapter.handle(rpcEvent({ type: 'tool_execution_start', toolCallId: 'read-2', toolName: 'read', args: { path: 'a.ts' } }));
        harness.adapter.handle(rpcEvent({ type: 'tool_execution_update', toolCallId: 'read-2', toolName: 'read', args: {}, partialResult: { text: 'p1' } }));
        harness.adapter.handle(rpcEvent({ type: 'tool_execution_update', toolCallId: 'read-2', toolName: 'read', args: {}, partialResult: { text: 'p2' } }));

        expect(harness.agentMessages).toEqual([{
            type: 'tool_call', id: 'read-2', name: 'read', input: { path: 'a.ts' }, status: 'in_progress'
        }]);
    });

    it('reconstructs a selected tool end from excluded start and update events', () => {
        const harness = createHarness(new Set(['tool_execution_end']));
        harness.adapter.handle(rpcEvent({
            type: 'tool_execution_start', toolCallId: 'read-1', toolName: 'read',
            args: { path: 'file.ts' }
        }));
        harness.adapter.handle(rpcEvent({
            type: 'tool_execution_update', toolCallId: 'read-1', toolName: 'read',
            args: {}, partialResult: { text: 'partial' }
        }));
        harness.adapter.handle(rpcEvent({
            type: 'tool_execution_end', toolCallId: 'read-1', toolName: 'read',
            result: { text: 'complete' }
        }));
        expect(harness.agentMessages).toEqual([{
            type: 'tool_call', id: 'read-1', name: 'read', input: { path: 'file.ts' }, status: 'completed'
        }]);
        expect(harness.structuredEvents).toEqual([]);
    });

    it('applies envelope policy to seeded cards and replay, not nested event names', () => {
        const hidden = createHarness(new Set());
        const replayOnly = createHarness(new Set(['subagent_event']));
        for (const harness of [hidden, replayOnly]) {
            harness.adapter.seedSubagents([{
                id: 'alpha', index: 0, agent: 'task', agentSource: 'bundled',
                status: 'running', lastUpdate: 123, progress: { id: 'alpha', status: 'running' }
            }]);
            expect(harness.agentRunEvents).toEqual([]);
            harness.adapter.seedSubagentMessages('alpha', [assistantMessage('replayed', 'replay-id')]);
            harness.adapter.handle(rpcEvent({
                type: 'subagent_event', payload: {
                    id: 'alpha', event: {
                        type: 'tool_execution_start', toolCallId: 'child', toolName: 'read',
                        args: { path: 'child.ts' }
                    }
                }
            }));
        }
        expect(hidden.agentRunEvents).toEqual([]);
        expect(hidden.traces).toEqual([]);
        expect(hidden.structuredEvents).toEqual([]);
        expect(replayOnly.agentRunEvents).toEqual([expect.objectContaining({
            type: 'agent-run-start', agentId: 'alpha', cardId: 'omp-subagent:alpha'
        })]);
        expect(replayOnly.traces.map((trace) => trace.message)).toEqual([
            expect.objectContaining({ type: 'reasoning', text: 'reasoning:replayed' }),
            expect.objectContaining({ type: 'text', text: 'replayed' }),
            expect.objectContaining({ type: 'tool_call', id: 'child', input: { path: 'child.ts' } })
        ]);
        expect(replayOnly.structuredEvents).toEqual([]);
    });

    it('does not replace intentionally silent rich projections with generic timeline rows', () => {
        const harness = createHarness(new Set(['message_end', 'subagent_lifecycle', 'subagent_event']));
        harness.adapter.handle(rpcEvent({ type: 'message_end', message: { role: 'user', steering: false } }));
        harness.adapter.handle(rpcEvent({ type: 'message_end', message: { role: 'developer', content: 'context' } }));
        const lifecycle = {
            type: 'subagent_lifecycle', payload: {
                id: 'alpha', index: 0, agent: 'task', agentSource: 'bundled', status: 'started'
            }
        };
        harness.adapter.handle(rpcEvent(lifecycle));
        harness.adapter.handle(rpcEvent(lifecycle));
        harness.adapter.seedSubagentMessages('alpha', [assistantMessage('replayed', 'same-response')]);
        harness.adapter.handle(rpcEvent({
            type: 'subagent_event', payload: {
                id: 'alpha', event: { type: 'message_end', message: assistantMessage('replayed', 'same-response') }
            }
        }));
        expect(harness.structuredEvents).toEqual([]);
        expect(harness.canonicalMessages).toEqual([]);
        expect(harness.agentRunEvents).toEqual([expect.objectContaining({
            type: 'agent-run-start', agentId: 'alpha'
        })]);
        expect(harness.traces.map((trace) => trace.message)).toEqual([
            expect.objectContaining({ type: 'reasoning', text: 'reasoning:replayed' }),
            expect.objectContaining({ type: 'text', text: 'replayed' })
        ]);
    });

    it('inherits the parent journal anchor for replayed child transcripts', () => {
        const traces: Array<{ message: AgentMessage; nativeOrder: unknown }> = [];
        const harness = createHarness();
        const adapter = new OmpRpcEventAdapter({
            ...harness.callbacks,
            onAgentRunTrace: (_scope, message, nativeOrder) => traces.push({ message, nativeOrder })
        });
        const parentAnchor = { sessionId: 'native-parent', entryId: 'E2', entryOrder: 2, eventOrder: 1 };
        adapter.seedSubagents([{
            id: 'alpha', index: 0, agent: 'task', agentSource: 'bundled',
            status: 'running', lastUpdate: 123,
            nativeOrder: parentAnchor
        } as Parameters<OmpRpcEventAdapter['seedSubagents']>[0][number]]);
        adapter.seedSubagentMessages('alpha', [
            { ...assistantMessage('first replay'), nativeOrder: { sessionId: 'child-sess', entryId: 'C9', entryOrder: 9, eventOrder: 0 } },
            { ...assistantMessage('second replay'), nativeOrder: { sessionId: 'child-sess', entryId: 'C11', entryOrder: 11, eventOrder: 0 } }
        ]);
        // Each replayed assistant has separate reasoning and text projections;
        // both must inherit the same parent entry, never the child's session.
        expect(traces).toEqual([
            { message: expect.objectContaining({ type: 'reasoning', text: 'reasoning:first replay' }), nativeOrder: { ...parentAnchor, eventOrder: 9 } },
            { message: expect.objectContaining({ type: 'text', text: 'first replay' }), nativeOrder: { ...parentAnchor, eventOrder: 9 } },
            { message: expect.objectContaining({ type: 'reasoning', text: 'reasoning:second replay' }), nativeOrder: { ...parentAnchor, eventOrder: 11 } },
            { message: expect.objectContaining({ type: 'text', text: 'second replay' }), nativeOrder: { ...parentAnchor, eventOrder: 11 } }
        ]);
    });

    it('keeps nested stream and state events quiet while retaining final child traces', () => {
        const visible = createHarness();
        const hidden = createHarness(new Set());
        const childEvents: JsonObject[] = [
            { type: 'message_start', message: assistantMessage('partial') },
            {
                type: 'message_update', message: assistantMessage('partial'),
                assistantMessageEvent: { type: 'text_delta', delta: 'partial' }
            },
            {
                type: 'message_update', message: assistantMessage('final'),
                assistantMessageEvent: { type: 'done', message: assistantMessage('final') }
            },
            { type: 'advisor_yielded' },
            { type: 'config_warnings_changed' },
            { type: 'turn_end', message: assistantMessage('final'), toolResults: [] },
            { type: 'message_end', message: assistantMessage('final', 'child-final') },
            { type: 'tool_execution_start', toolCallId: 'read-child', toolName: 'read', args: { path: 'child.ts' } },
            {
                type: 'tool_execution_end', toolCallId: 'read-child', toolName: 'read',
                result: { content: [{ type: 'text', text: 'read output' }] }, isError: false
            }
        ];
        for (const harness of [visible, hidden]) {
            harness.adapter.handle(rpcEvent({
                type: 'subagent_lifecycle', payload: {
                    id: 'alpha', index: 0, agent: 'task', agentSource: 'bundled', status: 'started'
                }
            }));
            for (const event of childEvents) {
                harness.adapter.handle(rpcEvent({ type: 'subagent_event', payload: { id: 'alpha', event } }));
            }
            expect(harness.structuredEvents).toEqual([]);
            expect(harness.canonicalMessages).toEqual([]);
            expect(harness.agentMessages).toEqual([]);
        }
        expect(visible.traces.map((trace) => trace.message)).toEqual([
            expect.objectContaining({ type: 'reasoning', text: 'reasoning:final' }),
            expect.objectContaining({ type: 'text', text: 'final' }),
            { type: 'tool_call', id: 'read-child', name: 'read', input: { path: 'child.ts' }, status: 'in_progress' }
        ]);
        expect(hidden.traces).toEqual([]);
        expect(hidden.agentRunEvents).toEqual([]);
    });

    it('keeps native streaming visible locally when default policy excludes hub stream events', () => {
        const harness = createHarness();
        harness.adapter.handle(rpcEvent({ type: 'message_start', message: assistantMessage('initial') }));
        harness.adapter.handle(rpcEvent({
            type: 'message_update', message: assistantMessage('streamed'),
            assistantMessageEvent: { type: 'thinking_delta', delta: 'considering' }
        }));
        harness.adapter.handle(rpcEvent({
            type: 'message_update', message: assistantMessage('streamed'),
            assistantMessageEvent: { type: 'text_delta', delta: 'streamed' }
        }));
        expect(harness.callbacks.onInkMessage).toHaveBeenCalledWith('[Thinking] considering', 'system');
        expect(harness.callbacks.onInkMessage).toHaveBeenCalledWith('streamed', 'assistant');
        expect(harness.structuredEvents).toEqual([]);
        expect(harness.canonicalMessages).toEqual([]);
        expect(harness.agentMessages).toEqual([]);
        harness.adapter.handle(rpcEvent({ type: 'message_end', message: assistantMessage('final') }));
        expect(harness.canonicalMessages).toEqual([expect.objectContaining({
            type: 'assistant', message: expect.objectContaining({
                content: [
                    { type: 'thinking', thinking: 'reasoning:final' },
                    { type: 'text', text: 'final' }
                ]
            })
        })]);
        expect(harness.structuredEvents).toEqual([]);
    });

    it('shows OMP custom messages marked display:true as one-line notices and keeps the rest out of chat and logs', () => {
        const harness = createHarness();
        harness.adapter.handle(rpcEvent({
            type: 'message_end',
            message: {
                role: 'custom',
                customType: 'async-result',
                display: true,
                content: '<system-notice>\nBackground job bg_1 has completed. Resume your work using the result below.\n[Command timed out after 20 seconds]\n</system-notice>'
            }
        }));
        harness.adapter.handle(rpcEvent({
            type: 'message_end',
            message: { role: 'custom', customType: 'mid-run-todo-nudge', display: false, content: '<system-reminder>\n4 todo items still open.' }
        }));
        expect(harness.structuredEvents).toEqual([expect.objectContaining({
            type: 'omp-notice',
            level: 'info',
            message: 'Background job bg_1 has completed. Resume your work using the result below.',
            source: 'async-result'
        })]);
        expect(harness.diagnostics.filter(line => line.includes('Unsupported OMP message_end role'))).toEqual([]);
    });

    it('skips empty thinking blocks (encrypted reasoning) without a diagnostic', () => {
        const harness = createHarness();
        harness.adapter.handle(rpcEvent({
            type: 'message_end',
            message: { ...assistantMessage('answer'), content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'answer' }] }
        }));
        expect(harness.canonicalMessages).toEqual([expect.objectContaining({
            type: 'assistant', message: expect.objectContaining({ content: [{ type: 'text', text: 'answer' }] })
        })]);
        expect(harness.diagnostics.filter(line => line.includes('Unknown OMP assistant content block'))).toEqual([]);
    });

    it('keeps tool_stream_update and future event types out of the chat', () => {
        const harness = createHarness();
        harness.adapter.handle(rpcEvent({ type: 'tool_stream_update', toolCallId: 't1', toolName: 'edit', preview: { diff: '+a' } }));
        harness.adapter.handle(rpcEvent({ type: 'session_settled' }));
        expect(harness.structuredEvents).toEqual([]);
    });

    it('deduplicates high-frequency running subagent_progress events until activity or terminal state changes', () => {
        const harness = createHarness();
        harness.adapter.handle(rpcEvent({
            type: 'subagent_lifecycle',
            payload: {
                id: 'worker-1',
                agent: 'task',
                agentSource: 'bundled',
                description: 'high-freq worker',
                status: 'started',
                parentToolCallId: 'task-parent',
                index: 0
            }
        }));

        for (let tick = 0; tick < 200; tick += 1) {
            harness.adapter.handle(rpcEvent({
                type: 'subagent_progress',
                payload: {
                    index: 0,
                    agent: 'task',
                    agentSource: 'bundled',
                    task: 'work',
                    parentToolCallId: 'task-parent',
                    progress: {
                        id: 'worker-1',
                        status: 'running',
                        tokens: tick * 50,
                        durationMs: tick * 100
                    }
                }
            }));
        }

        for (let tick = 0; tick < 100; tick += 1) {
            harness.adapter.handle(rpcEvent({
                type: 'subagent_progress',
                payload: {
                    index: 0,
                    agent: 'task',
                    agentSource: 'bundled',
                    task: 'work',
                    parentToolCallId: 'task-parent',
                    progress: {
                        id: 'worker-1',
                        status: 'running',
                        currentTool: 'read',
                        tokens: 10_000 + tick * 50
                    }
                }
            }));
        }

        harness.adapter.handle(rpcEvent({
            type: 'subagent_lifecycle',
            payload: {
                id: 'worker-1',
                agent: 'task',
                agentSource: 'bundled',
                description: 'high-freq worker',
                status: 'completed',
                parentToolCallId: 'task-parent',
                index: 0
            }
        }));

        const updates = harness.agentRunEvents.filter((event) => event.type === 'agent-run-update');
        expect(updates.map((event) => [event.status, event.activity])).toEqual([
            ['running', 'Running'],
            ['running', 'Using read'],
            ['completed', 'Completed']
        ]);
    });
});

function projectedRuntime(publications: RuntimePublication[]) {
    const projection = new RuntimeTimelineProjection('test');
    for (const publication of publications) {
        if (publication.kind === 'snapshot') projection.replace(publication.snapshot);
        else projection.apply(publication.patch);
    }
    return projection.snapshot();
}

describe('OMP native runtime timeline', () => {
    afterEach(() => vi.useRealTimers());
    it('keeps stable assistant UUIDs, thinking and native toolUse without finishing the run', () => {
        vi.useFakeTimers();
        const h = createHarness(undefined, true);
        h.adapter.handle(rpcEvent({ type: 'agent_start' }));
        h.adapter.handle(rpcEvent({ type: 'message_start', message: assistantMessage('') }));
        vi.advanceTimersByTime(50);
        const startedId = projectedRuntime(h.publications).items[0].id;
        h.adapter.handle(rpcEvent({ type: 'message_update', message: assistantMessage('partial'), assistantMessageEvent: { type: 'text_delta', delta: 'partial' } }));
        vi.advanceTimersByTime(50);
        expect(projectedRuntime(h.publications).items[0]).toMatchObject({ id: startedId, text: 'partial', reasoning: 'reasoning:partial' });
        h.adapter.handle(rpcEvent({ type: 'message_end', message: { ...assistantMessage('final', 'provider-id'), stopReason: 'toolUse' } }));
        const live = projectedRuntime(h.publications);
        expect(live.run?.state).toBe('running');
        expect(live.items).toHaveLength(1);
        expect(live.items[0].id).toBe(startedId);
        expect(live.items[0]).toMatchObject({
            id: h.canonicalMessages[0].uuid, canonicalId: h.canonicalMessages[0].uuid,
            text: 'final', reasoning: 'reasoning:final', state: 'completed', stopReason: 'toolUse'
        });
        expect(RawJSONLinesSchema.parse(h.canonicalMessages[0])).toMatchObject({
            stopReason: 'toolUse', runId: live.run?.id, providerMessageId: 'provider-id', isSidechain: false
        });
        h.adapter.handle(rpcEvent({ type: 'agent_end' }));
        expect(projectedRuntime(h.publications).run).toMatchObject({ state: 'idle', stopReason: 'toolUse' });
        h.adapter.closeRuntime();
    });

    it.each(['length', 'error', 'aborted'] as const)('retains native %s instead of inferring success from answer text', (stopReason) => {
        const h = createHarness(undefined, true);
        h.adapter.handle(rpcEvent({ type: 'agent_start' }));
        h.adapter.handle(rpcEvent({ type: 'message_start', message: assistantMessage('') }));
        h.adapter.handle(rpcEvent({ type: 'message_end', message: { ...assistantMessage('Looks done.'), stopReason, errorMessage: stopReason === 'error' ? 'Provider disconnected' : undefined } }));
        h.adapter.handle(rpcEvent({ type: 'agent_end' }));
        const runtime = projectedRuntime(h.publications);
        expect(runtime.items[0].stopReason).toBe(stopReason);
        expect(runtime.run).toMatchObject({ stopReason, state: stopReason === 'length' ? 'idle' : stopReason });
        expect(RawJSONLinesSchema.parse(h.canonicalMessages[0])).toMatchObject({ stopReason, runId: runtime.run?.id });
        h.adapter.closeRuntime();
    });

    it('drops the finished run from the live projection when the next run starts', () => {
        const h = createHarness(undefined, true);
        h.adapter.handle(rpcEvent({ type: 'agent_start' }));
        h.adapter.handle(rpcEvent({ type: 'message_start', message: assistantMessage('') }));
        h.adapter.handle(rpcEvent({ type: 'message_end', message: assistantMessage('first answer') }));
        h.adapter.handle(rpcEvent({ type: 'agent_end' }));
        const first = projectedRuntime(h.publications);
        expect(first.items.map(item => item.text)).toEqual(['first answer']);
        h.adapter.handle(rpcEvent({ type: 'agent_start' }));
        h.adapter.handle(rpcEvent({ type: 'message_start', message: assistantMessage('') }));
        h.adapter.handle(rpcEvent({ type: 'message_end', message: assistantMessage('second answer') }));
        const second = projectedRuntime(h.publications);
        expect(second.run?.id).not.toBe(first.run?.id);
        expect(second.items.map(item => [item.runId, item.text])).toEqual([[second.run?.id, 'second answer']]);
        h.adapter.closeRuntime();
    });

    it('publishes tool input/progress/result and runtime control even with every presentation event hidden', () => {
        const h = createHarness(new Set<OmpKnownEventType>(), true);
        h.adapter.handle(rpcEvent({ type: 'agent_start' }));
        h.adapter.handle(rpcEvent({ type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'bash', args: { command: 'echo hi' } }));
        h.adapter.handle(rpcEvent({ type: 'tool_execution_update', toolCallId: 'tool-1', toolName: 'bash', args: {}, partialResult: { text: 'partial' } }));
        h.adapter.handle(rpcEvent({ type: 'tool_execution_end', toolCallId: 'tool-1', toolName: 'bash', result: { content: [{ type: 'text', text: 'hi' }] }, isError: true }));
        expect(projectedRuntime(h.publications).items[0]).toMatchObject({
            id: 'tool-1', state: 'error', tool: { id: 'tool-1', name: 'bash', input: { command: 'echo hi' }, isError: true, output: { content: [{ type: 'text', text: 'hi' }] } }
        });
        expect(h.agentMessages).toEqual([]);
        expect(h.canonicalMessages).toEqual([]);
        h.adapter.handle(rpcEvent({ type: 'agent_end' }));
        expect(projectedRuntime(h.publications).run?.state).toBe('idle');
        h.adapter.closeRuntime();
    });

    it('keeps tool identity and structured details through the durable result UUID bridge', () => {
        const h = createHarness(undefined, true);
        h.adapter.handle(rpcEvent({ type: 'agent_start' }));
        h.adapter.handle(rpcEvent({ type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'read', args: { path: 'file' } }));
        h.adapter.handle(rpcEvent({ type: 'tool_execution_end', toolCallId: 'tool-1', toolName: 'read', result: { content: [] }, isError: false }));
        const createdAt = projectedRuntime(h.publications).items[0].createdAt;
        h.adapter.handle(rpcEvent({
            type: 'message_end', message: {
                role: 'toolResult', toolCallId: 'tool-1', toolName: 'read',
                content: [{ type: 'text', text: 'contents' }], details: { lines: 3 }, isError: false
            }
        }));
        expect(projectedRuntime(h.publications).items[0]).toMatchObject({
            id: 'tool-1', createdAt, canonicalId: h.canonicalMessages[0].uuid, state: 'completed',
            tool: { id: 'tool-1', name: 'read', input: { path: 'file' }, output: { content: [{ type: 'text', text: 'contents' }], details: { lines: 3 } } }
        });
        h.adapter.closeRuntime();
    });

    it('flushes unfinished text before agent_end and preserves it on abort without late resurrection', () => {
        const h = createHarness(undefined, true);
        h.adapter.handle(rpcEvent({ type: 'agent_start' }));
        h.adapter.handle(rpcEvent({ type: 'message_start', message: assistantMessage('partial') }));
        h.adapter.noteExternalAbort();
        const aborted = projectedRuntime(h.publications);
        expect(aborted.items[0]).toMatchObject({ text: 'partial', reasoning: 'reasoning:partial', state: 'aborted' });
        h.adapter.handle(rpcEvent({ type: 'message_end', message: assistantMessage('Late final') }));
        h.adapter.handle(rpcEvent({ type: 'agent_end' }));
        expect(projectedRuntime(h.publications)).toEqual(aborted);
        expect(h.canonicalMessages[0]).toMatchObject({ uuid: aborted.items[0].canonicalId, stopReason: 'aborted' });
        h.adapter.closeRuntime();
    });

    it('reconciles an unfinished native assistant before the final run update', () => {
        const h = createHarness(undefined, true);
        h.adapter.handle(rpcEvent({ type: 'agent_start' }));
        h.adapter.handle(rpcEvent({ type: 'message_start', message: assistantMessage('last chunk') }));
        h.adapter.handle(rpcEvent({ type: 'agent_end' }));
        const runtime = projectedRuntime(h.publications);
        expect(runtime.items[0]).toMatchObject({ text: 'last chunk', state: 'aborted' });
        expect(runtime.run?.state).toBe('idle');
        expect(h.canonicalMessages[0]).toMatchObject({ stopReason: 'aborted', message: { content: [{ type: 'thinking', thinking: 'reasoning:last chunk' }, { type: 'text', text: 'last chunk' }] } });
        h.adapter.closeRuntime();
    });

    it('keeps one assistant identity while custom notices and steering echoes interleave', () => {
        vi.useFakeTimers();
        const h = createHarness(undefined, true);
        h.adapter.handle(rpcEvent({ type: 'agent_start' }));
        h.adapter.handle(rpcEvent({ type: 'message_start', message: assistantMessage('first') }));
        vi.advanceTimersByTime(50);
        const id = projectedRuntime(h.publications).items[0].id;
        h.adapter.handle(rpcEvent({ type: 'message_end', message: { role: 'custom', display: true, customType: 'async-result', content: 'Background completed' } }));
        h.adapter.handle(rpcEvent({ type: 'message_start', message: { role: 'user', content: 'steer' } }));
        h.adapter.handle(rpcEvent({ type: 'message_end', message: { role: 'user', content: 'steer', steering: true } }));
        h.adapter.handle(rpcEvent({ type: 'message_update', message: assistantMessage('continued'), assistantMessageEvent: { type: 'text_delta', delta: 'continued' } }));
        h.adapter.handle(rpcEvent({ type: 'message_end', message: assistantMessage('final') }));
        const snapshot = projectedRuntime(h.publications);
        expect(snapshot.items.map(item => item.id)).toEqual([id]);
        expect(snapshot.items[0]).toMatchObject({ text: 'final', state: 'completed' });
        expect(h.canonicalMessages[0].uuid).toBe(id);
        h.adapter.closeRuntime();
    });

    it('does not create a ghost assistant row for a tool-only native message', () => {
        const h = createHarness(undefined, true);
        const message = { ...assistantMessage(''), content: [{ type: 'toolCall', id: 'native-read', name: 'read', arguments: { path: 'file' } }], stopReason: 'toolUse' };
        h.adapter.handle(rpcEvent({ type: 'agent_start' }));
        h.adapter.handle(rpcEvent({ type: 'message_start', message }));
        h.adapter.handle(rpcEvent({ type: 'message_end', message }));
        h.adapter.handle(rpcEvent({ type: 'tool_execution_start', toolCallId: 'native-read', toolName: 'read', args: { path: 'file' } }));
        h.adapter.handle(rpcEvent({ type: 'tool_execution_end', toolCallId: 'native-read', toolName: 'read', result: { content: [] }, isError: false }));
        expect(projectedRuntime(h.publications).items.map(item => [item.id, item.kind])).toEqual([['native-read', 'tool']]);
        expect(h.canonicalMessages[0]).toMatchObject({ stopReason: 'toolUse' });
        h.adapter.closeRuntime();
    });
});
