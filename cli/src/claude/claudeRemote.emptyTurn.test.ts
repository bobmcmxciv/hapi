import { describe, expect, it, vi } from 'vitest';
import * as claudeSdk from '@/claude/sdk';
import type { SDKMessage } from '@/claude/sdk/types';
import { describeEmptyTurn } from './claudeRemote';

vi.mock('@/claude/utils/claudeCheckSession', () => ({ claudeCheckSession: () => true }));
vi.mock('@/modules/watcher/awaitFileExist', () => ({ awaitFileExist: async () => true }));
vi.mock('@/claude/sdk/utils', () => ({ getDefaultClaudeCodePath: () => '/usr/bin/claude' }));

const queryMock = vi.fn();

function createAsyncStream(messages: SDKMessage[]): AsyncIterable<SDKMessage> {
    return {
        async *[Symbol.asyncIterator]() {
            for (const message of messages) {
                await Promise.resolve();
                yield message;
            }
        }
    };
}

/** Drive one real claudeRemote() turn over a canned SDK stream. */
async function runTurn(sdkMessages: SDKMessage[]): Promise<string[]> {
    const querySpy = vi.spyOn(claudeSdk, 'query').mockImplementation(queryMock as typeof claudeSdk.query);
    const { claudeRemote } = await import('./claudeRemote');
    const completionEvents: string[] = [];
    queryMock.mockReturnValueOnce(createAsyncStream(sdkMessages));

    let nextCallCount = 0;
    try {
        await claudeRemote({
            sessionId: 'session-1',
            path: process.cwd(),
            mcpServers: {},
            claudeEnvVars: {},
            claudeArgs: [],
            allowedTools: [],
            hookSettingsPath: '/tmp/hook.json',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            nextMessage: async () => {
                nextCallCount += 1;
                if (nextCallCount === 1) {
                    return { message: '请继续推进所有未完成工作。', mode: { permissionMode: 'default' } };
                }
                return null;
            },
            onReady: () => {},
            isAborted: () => false,
            onSessionFound: () => {},
            onMessage: () => {},
            onCompletionEvent: (message) => { completionEvents.push(message); },
            onSessionReset: () => {}
        });
    } finally {
        queryMock.mockReset();
        querySpy.mockRestore();
    }
    return completionEvents;
}

const EMPTY_TURN_RESULT = {
    type: 'result',
    subtype: 'success',
    is_error: false,
    num_turns: 2,
    stop_reason: 'end_turn',
    session_id: 's-1',
    uuid: 'u-r',
    modelUsage: {
        'claude-fable-5[1m]': { inputTokens: 73906108, outputTokens: 9040, contextWindow: 1000000 }
    }
} as unknown as SDKMessage;

describe('claudeRemote empty-turn reporting (real turn)', () => {
    it('emits a completion event when a result carries no assistant output', async () => {
        // Exactly the observed stream: init, Claude Code's synthetic
        // "no visible output" retry, then a successful result -- and never an
        // assistant message. Pre-fix this produced only `ready`, i.e. silence.
        const events = await runTurn([
            { type: 'system', subtype: 'init', session_id: 's-1', uuid: 'u-1' } as unknown as SDKMessage,
            {
                type: 'user',
                message: { role: 'user', content: [{ type: 'text', text: '[Your previous response had no visible output. Please continue and produce a user-visible response.]' }] },
                isSynthetic: true,
                session_id: 's-1',
                uuid: 'u-2'
            } as unknown as SDKMessage,
            EMPTY_TURN_RESULT
        ]);

        expect(events.length).toBe(1);
        expect(events[0]).toContain('empty turn');
        expect(events[0]).toContain('73,906,108');
    });

    it('stays silent when the turn did produce an assistant message', async () => {
        // Guard against the fix firing on healthy turns.
        const events = await runTurn([
            { type: 'system', subtype: 'init', session_id: 's-1', uuid: 'u-1' } as unknown as SDKMessage,
            {
                type: 'assistant',
                message: { model: 'claude-fable-5[1m]', content: [{ type: 'text', text: 'done' }] },
                session_id: 's-1',
                uuid: 'u-2'
            } as unknown as SDKMessage,
            EMPTY_TURN_RESULT
        ]);

        expect(events).toEqual([]);
    });
});

// Reproduces the shape actually observed on DESKTOP-HT3P09U sessions
// 5720ad1a (预检上海地铁1号线运营数据) and e05a489d (查找迦勒底之门入口):
// the user sent a prompt, Claude returned an empty turn, Claude Code injected
// its own synthetic "[Your previous response had no visible output...]" retry,
// that came back empty too, and the SDK reported success. hapi then emitted
// `ready` and displayed nothing, so the user saw only silence and resent the
// same prompt repeatedly.
describe('describeEmptyTurn', () => {
    it('reports the context math from the real e05a489d result', () => {
        const message = describeEmptyTurn({
            is_error: false,
            num_turns: 2,
            stop_reason: 'end_turn',
            modelUsage: {
                'claude-fable-5[1m]': {
                    inputTokens: 73906108,
                    outputTokens: 9040,
                    contextWindow: 1000000
                }
            }
        });

        expect(message).toContain('empty turn');
        expect(message).toContain('stop_reason=end_turn');
        expect(message).toContain('num_turns=2');
        // The numbers are the actionable part -- they show the transcript has
        // outgrown the window by ~74x.
        expect(message).toContain('73,906,108');
        expect(message).toContain('1,000,000');
        expect(message).toContain('/compact');
    });

    it('still produces a useful message when usage details are absent', () => {
        const message = describeEmptyTurn({ is_error: false });

        expect(message).toContain('empty turn');
        expect(message).toContain('/compact');
        // No stray empty parenthetical when there is nothing to report.
        expect(message).not.toContain('()');
    });

    it('tolerates a malformed or missing result without throwing', () => {
        expect(() => describeEmptyTurn(undefined)).not.toThrow();
        expect(() => describeEmptyTurn(null)).not.toThrow();
        expect(() => describeEmptyTurn({ modelUsage: 'nonsense' })).not.toThrow();
        expect(describeEmptyTurn(undefined)).toContain('empty turn');
    });

    it('omits the context comparison when the window is unknown', () => {
        const message = describeEmptyTurn({
            num_turns: 2,
            modelUsage: { 'some-model': { inputTokens: 1234 } }
        });

        expect(message).toContain('1,234 input tokens');
        // The "X vs Y context window" comparison must be omitted; the closing
        // advice sentence still mentions the phrase, so match the comparison.
        expect(message).not.toMatch(/vs [\d,]+ context window/);
    });
});
