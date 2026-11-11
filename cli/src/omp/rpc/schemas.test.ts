import { describe, expect, it } from 'vitest';
import { parseOmpInboundLine, parseOmpResponseData } from './schemas';
import type { JsonValue } from './types';

const MODEL = {
    id: 'model-1',
    name: 'Model One',
    api: 'openai-completions',
    provider: 'provider-1',
    baseUrl: 'https://api.example.test',
    reasoning: true,
    input: ['text', 'image'],
    contextWindow: 128_000,
    maxTokens: 16_384,
    thinking: {
        mode: 'levels',
        efforts: ['minimal', 'low', 'high', 'xhigh'],
        defaultLevel: 'high'
    }
} satisfies JsonValue;

const STATE = {
    model: MODEL,
    capabilities: { inputReceipts: true, nativeOrder: true },
    thinkingLevel: 'off',
    isStreaming: false,
    isCompacting: false,
    steeringMode: 'all',
    followUpMode: 'one-at-a-time',
    interruptMode: 'wait',
    sessionFile: '/home/user/session.jsonl',
    sessionId: 'session-1',
    sessionName: 'Session one',
    autoCompactionEnabled: true,
    messageCount: 2,
    queuedMessageCount: 0,
    todoPhases: [],
    systemPrompt: ['system'],
    dumpTools: [],
    contextUsage: { tokens: 100, contextWindow: 128_000, percent: 0.078125 }
} satisfies JsonValue;


describe('OMP RPC protocol schemas', () => {
    it('gates token promotion on the decoded native capability rather than assuming receipt support implies it', () => {
        const supported = parseOmpResponseData('get_state', { ...STATE, capabilities: { ...STATE.capabilities, queuePromotion: true } });
        const disabled = parseOmpResponseData('get_state', { ...STATE, capabilities: { ...STATE.capabilities, queuePromotion: false } });
        const legacy = parseOmpResponseData('get_state', STATE);
        expect(supported.capabilities?.queuePromotion === true).toBe(true);
        expect(disabled.capabilities?.queuePromotion === true).toBe(false);
        expect(legacy.capabilities?.queuePromotion === true).toBe(false);
        expect(() => parseOmpResponseData('get_state', { ...STATE, capabilities: { ...STATE.capabilities, queuePromotion: 'true' } })).toThrow();
    });

    it('decodes per-token promotion outcomes and refuses malformed identities or statuses', () => {
        const results = [
            { token: 'pending', status: 'promoted' },
            { token: 'repeated', status: 'already-priority' },
            { token: 'consumed', status: 'not-found' }
        ];
        expect(parseOmpResponseData('promote_queued_message', { promoted: true, results }).results).toEqual(results);
        expect(parseOmpResponseData('promote_queued_message', { promoted: false }).results).toBeUndefined();
        expect(() => parseOmpResponseData('promote_queued_message', { promoted: true, results: [{ token: '', status: 'promoted' }] })).toThrow();
        expect(() => parseOmpResponseData('promote_queued_message', { promoted: true, results: [{ token: 'pending', status: 'consumed' }] })).toThrow();
    });

    it('retains parent and child journal identities through subagent response decoding', () => {
        const parent = parseOmpResponseData('get_subagents', {
            subagents: [{
                id: 'subagent-1', index: 0, agent: 'explore', agentSource: 'built-in', status: 'running', lastUpdate: 1,
                nativeOrder: { sessionId: 'session-1', entryId: 'task-entry', entryOrder: 4, eventOrder: 1 }
            }]
        });
        const child = parseOmpResponseData('get_subagent_messages', {
            sessionFile: '/home/user/subagent.jsonl', fromByte: 0, nextByte: 10, reset: false, entries: [],
            messages: [{ role: 'assistant', content: [], nativeOrder: { sessionId: 'child-1', entryId: 'child-entry', entryOrder: 2, eventOrder: 1 } }]
        });
        expect(parent.subagents[0]!.nativeOrder).toEqual({ sessionId: 'session-1', entryId: 'task-entry', entryOrder: 4, eventOrder: 1 });
        expect(child.messages[0]!.raw.nativeOrder).toEqual({ sessionId: 'child-1', entryId: 'child-entry', entryOrder: 2, eventOrder: 1 });
    });

    it('does not infer ordered-input support from receipts or accept a nonboolean advertisement', () => {
        expect(parseOmpResponseData('get_state', { ...STATE, capabilities: { inputReceipts: true } }).capabilities?.nativeOrder).toBeUndefined();
        expect(parseOmpResponseData('get_state', { ...STATE, capabilities: { inputReceipts: true, nativeOrder: false } }).capabilities?.nativeOrder).toBe(false);
        expect(() => parseOmpResponseData('get_state', { ...STATE, capabilities: { inputReceipts: true, nativeOrder: 'true' } })).toThrow();
    });

    it('parses todo statuses omp introduced after the schema, including blocked', () => {
        const base = {
            isStreaming: false,
            isCompacting: false,
            steeringMode: 'all',
            followUpMode: 'all',
            interruptMode: 'immediate',
            autoCompactionEnabled: false,
            messageCount: 0,
            queuedMessageCount: 0
        };
        const state = (status: string): JsonValue => ({
            sessionId: 'session-1',
            ...base,
            todoPhases: [{ name: 'Phase', tasks: [{ content: 'task', status }] }]
        });

        const blocked = parseOmpResponseData('get_state', state('blocked'));
        expect(blocked.todoPhases[0].tasks[0].status).toBe('blocked');

        const unknown = parseOmpResponseData('get_state', state('deferred_future_x'));
        expect(unknown.todoPhases[0].tasks[0].status).toBe('unknown');
    });

    it('separates exhaustive known events from unknown raw diagnostic frames', () => {
        expect(parseOmpInboundLine('{"type":"message_end","futureField":true}')).toEqual({
            kind: 'event',
            event: {
                kind: 'known',
                type: 'message_end',
                raw: { type: 'message_end', futureField: true }
            }
        });
        expect(parseOmpInboundLine('{"type":"future_event","value":42}')).toEqual({
            kind: 'event',
            event: {
                kind: 'unknown',
                type: 'future_event',
                raw: { type: 'future_event', value: 42 }
            }
        });
    });

    it('rejects malformed JSON and malformed response envelopes', () => {
        expect(() => parseOmpInboundLine('not-json')).toThrow('malformed JSON');
        expect(() => parseOmpInboundLine('{"type":"response","success":true}')).toThrow();
    });
});
