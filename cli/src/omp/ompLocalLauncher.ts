import { ompLocal } from './ompLocal';
import { OmpSession, type OmpShutdownReceipt } from './session';
import { BaseLocalLauncher } from '@/modules/common/launcher/BaseLocalLauncher';
import { createOmpLocalSessionScanner } from './utils/ompSessionScanner';
import { buildOmpEnv } from './utils/config';
import type { OmpConfiguredThinkingLevel } from '@hapi/protocol/omp';

export async function ompLocalLauncher(
    session: OmpSession,
    opts: {
        model?: string;
        effort?: OmpConfiguredThinkingLevel;
    }
): Promise<'switch' | 'exit'> {
    if (session.isShutdownRequested()) return 'exit';
    const nativeExit = Promise.withResolvers<OmpShutdownReceipt>();
    let receipt: OmpShutdownReceipt = { kind: 'omp-local', status: 'not-started' };
    const scanner = createOmpLocalSessionScanner({
        workingDirectory: session.path,
        env: buildOmpEnv(),
        onSnapshot: session.applyNativeSessionSnapshot
    });
    await scanner.start();

    const launcher = new BaseLocalLauncher({
        label: 'omp-local',
        failureLabel: 'Local omp process failed',
        queue: session.queue,
        rpcHandlerManager: session.client.rpcHandlerManager,
        startedBy: session.startedBy,
        startingMode: session.startingMode,
        launch: async (abortSignal) => {
            receipt = { kind: 'omp-local', status: 'unverified' };
            session.recordShutdownReceipt(receipt);
            await ompLocal({
                path: session.path,
                sessionId: session.sessionId,
                abort: abortSignal,
                model: opts.model,
                effort: opts.effort,
                onExit: (result) => {
                    receipt = result;
                    session.recordShutdownReceipt(result);
                }
            });
        },
        sendFailureMessage: (message) => {
            session.sendSessionEvent({ type: 'message', message });
        },
        recordLocalLaunchFailure: (message, exitReason) => {
            session.recordLocalLaunchFailure(message, exitReason);
        }
    });
    const unregisterShutdown = session.registerShutdownHandle({
        requestExit: () => launcher.control.requestExit(),
        waitForExit: () => nativeExit.promise
    });
    if (session.isShutdownRequested()) launcher.control.requestExit();

    try {
        const reason = await launcher.run();
        if ((receipt as OmpShutdownReceipt).status === 'unverified') {
            throw new Error('OMP local runtime did not confirm disposal; refusing to launch a second native instance');
        }
        return session.isShutdownRequested() ? 'exit' : reason;
    } finally {
        try {
            await scanner.cleanup();
        } finally {
            session.recordShutdownReceipt(receipt);
            nativeExit.resolve(receipt);
            unregisterShutdown();
        }
    }
}
