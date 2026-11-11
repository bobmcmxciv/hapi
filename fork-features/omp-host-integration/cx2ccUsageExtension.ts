import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { resolveOmpAgentCategoryDirectory } from '../../cli/src/omp/utils/ompSessionScanner';
import * as providerText from './cx2ccUsageProvider' with { type: 'text' };

export const CX2CC_USAGE_EXTENSION_FILENAME = 'hapi-cx2cc-usage.ts';
export const CX2CC_USAGE_EXTENSION_MARKER = '// Managed by HAPI: native OMP cx2cc quota adapter (no transcript or credentials).';

// Bun's text loader exposes a default string; TypeScript resolves the source module instead.
const providerSource = (providerText as unknown as { default: string }).default;


export function buildCx2ccUsageExtensionSource(): string {
    return `${CX2CC_USAGE_EXTENSION_MARKER}
import * as path from 'node:path';
import type { UsageProvider } from '@oh-my-pi/pi-ai';
import { getAgentDir, type ExtensionFactory } from '@oh-my-pi/pi-coding-agent';
import { ModelsConfigFile } from '@oh-my-pi/pi-coding-agent/config/models-config';

${providerSource}

const extension: ExtensionFactory = (pi) => {
    let candidates: Array<{ providerId: string; apiKey?: string }> = [];
    try {
        const loaded = ModelsConfigFile.relocate(path.join(getAgentDir(), 'models.yml')).tryLoad();
        if (loaded.status === 'ok') {
            candidates = selectCx2ccProviderCandidates(loaded.value.providers);
        }
    } catch {
        // Ignore invalid/unreadable models.yml; normal OMP config diagnostics handle it.
    }
    for (const candidate of candidates) {
        pi.registerProvider(candidate.providerId, {
            ...(candidate.apiKey ? { apiKey: candidate.apiKey } : {}),
            usage: createCx2ccUsageProvider(candidate.providerId) as UsageProvider
        });
    }
};

export default extension;
`;
}

export function resolveCx2ccUsageExtensionPath(
    options: {
        env?: NodeJS.ProcessEnv;
        homeDirectory?: string;
        platform?: NodeJS.Platform;
    } = {}
): string {
    const configAgentDirectory = resolveOmpAgentCategoryDirectory('data', {
        ...options,
        env: { ...(options.env ?? process.env), XDG_DATA_HOME: undefined }
    });
    return path.join(configAgentDirectory, 'extensions', CX2CC_USAGE_EXTENSION_FILENAME);
}

/** Installs only HAPI's reserved cx2cc usage extension; leaves user extensions and hapi-usage.ts untouched. */
export async function ensureCx2ccUsageExtension(
    options: {
        env?: NodeJS.ProcessEnv;
        homeDirectory?: string;
        platform?: NodeJS.Platform;
    } = {}
): Promise<string> {
    const extensionFile = resolveCx2ccUsageExtensionPath(options);
    const extensionDirectory = path.dirname(extensionFile);
    const source = buildCx2ccUsageExtensionSource();
    let existing: string | undefined;
    try {
        existing = await fs.readFile(extensionFile, 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (existing === source) return extensionFile;
    if (existing !== undefined && !existing.startsWith(CX2CC_USAGE_EXTENSION_MARKER)) {
        throw new Error(`Refusing to overwrite a non-HAPI extension: ${extensionFile}`);
    }
    await fs.mkdir(extensionDirectory, { recursive: true });
    await fs.writeFile(extensionFile, source, { mode: 0o600 });
    return extensionFile;
}
