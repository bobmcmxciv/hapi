import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeOmpVersion } from '../rpc/OmpRpcClient';

describe('Windows OMP startup', () => {
    let directory: string | undefined;

    afterEach(async () => {
        vi.unstubAllGlobals();
        if (directory) await rm(directory, { recursive: true, force: true });
    });

    it.runIf(process.platform === 'win32')('starts the native runtime when PATH resolves bun to an npm CMD shim', async () => {
        directory = await mkdtemp(join(tmpdir(), 'hapi-omp-startup-'));
        const entry = join(directory, 'node_modules', '@oh-my-pi', 'pi-coding-agent', 'dist', 'cli.js');
        await mkdir(join(directory, 'node_modules', '@oh-my-pi', 'pi-coding-agent', 'dist'), { recursive: true });
        await writeFile(entry, 'console.log("18.16.0");\n');
        const ompShim = join(directory, 'omp.cmd');
        await writeFile(ompShim, '@exit /b 93\r\n');
        vi.stubGlobal('Bun', {
            which(command: string): string | null {
                if (command === 'omp') return ompShim;
                if (command === 'bun') return join(directory!, 'bun.cmd');
                if (command === 'bun.exe') return process.execPath;
                return null;
            }
        });

        const version = await probeOmpVersion();

        expect(version).toMatchObject({ major: 18, minor: 16, patch: 0 });
    });
});
