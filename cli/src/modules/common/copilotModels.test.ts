import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('@/copilot/utils/copilotBackend', () => ({
    createCopilotBackend: () => ({
        initialize: async () => {
            throw new Error('copilot ACP is not installed');
        },
        newSession: async () => '',
        getSessionModelsMetadata: () => undefined,
        getConfigOptionByCategory: () => undefined,
        disconnect: async () => {}
    })
}));

import { listCopilotModelsForCwd } from './copilotModels';

describe('listCopilotModelsForCwd without a Copilot CLI', () => {
    const originalCliPath = process.env.COPILOT_CLI_PATH;

    afterEach(() => {
        if (originalCliPath === undefined) {
            delete process.env.COPILOT_CLI_PATH;
        } else {
            process.env.COPILOT_CLI_PATH = originalCliPath;
        }
    });

    test('fails the probe without an unhandled rejection from the destroyed stdin', async () => {
        process.env.COPILOT_CLI_PATH = 'hapi-test-copilot-not-installed';
        const unhandled: unknown[] = [];
        const onUnhandled = (reason: unknown) => {
            unhandled.push(reason);
        };
        process.on('unhandledRejection', onUnhandled);
        try {
            const response = await listCopilotModelsForCwd(`missing-copilot-${Date.now()}`);
            expect(response.success).toBe(false);
            expect(response.availableModels).toEqual([]);
            // The rethrown write error used to surface a few ticks after the probe settled.
            await new Promise(resolve => setTimeout(resolve, 300));
            expect(unhandled).toEqual([]);
        } finally {
            process.off('unhandledRejection', onUnhandled);
        }
    });
});
