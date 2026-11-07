import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { buildOmpLocalArgs, ompLocal } from './ompLocal';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
vi.mock('./utils/config', () => ({
    resolveOmpLaunchCommand: () => ({ command: 'bun', args: ['omp-cli.js'] })
}));

describe('ompLocal graceful shutdown', () => {
    it('uses a launch-bound private request and waits for the native OS exit', async () => {
        const child = Object.assign(new EventEmitter(), { pid: 4242 });
        vi.mocked(spawn).mockReturnValueOnce(child as never);
        const controller = new AbortController();
        const onExit = vi.fn();
        const originalSession = process.env.HAPI_SESSION_ID;
        process.env.HAPI_SESSION_ID = 'hapi-test';
        try {
            const running = ompLocal({ path: '/workspace', sessionId: 'native-test', abort: controller.signal, onExit });
            await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
            const options = vi.mocked(spawn).mock.calls.at(-1)?.[2] as { env: NodeJS.ProcessEnv; shell: boolean };
            expect(options.shell).toBe(false);
            controller.abort();
            await vi.waitFor(async () => {
                const request = JSON.parse(await readFile(options.env.HAPI_OMP_STOP_FILE!, 'utf8'));
                expect(request).toEqual({ nonce: options.env.HAPI_OMP_STOP_NONCE, hapiSessionId: 'hapi-test' });
            });
            expect(onExit).not.toHaveBeenCalled();
            child.emit('close', 0, null);
            await running;
            expect(onExit).toHaveBeenCalledWith({ kind: 'omp-local', status: 'disposed', pid: 4242, exitCode: 0, signal: null });
        } finally {
            if (originalSession === undefined) delete process.env.HAPI_SESSION_ID;
            else process.env.HAPI_SESSION_ID = originalSession;
        }
    });
});

describe('buildOmpLocalArgs', () => {
    it('pins local OMP sessions to native yolo execution', () => {
        expect(buildOmpLocalArgs({ sessionId: null })).toEqual([
            '--approval-mode', 'yolo'
        ]);
    });

    it('keeps resume, model, and thinking arguments before fixed yolo', () => {
        expect(buildOmpLocalArgs({
            sessionId: 'native-session',
            model: 'openai-codex/gpt-5.4-mini',
            effort: 'auto'
        })).toEqual([
            '--resume', 'native-session',
            '--model', 'openai-codex/gpt-5.4-mini',
            '--thinking', 'auto',
            '--approval-mode', 'yolo'
        ]);
    });
});
