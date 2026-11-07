import { readFile, stat } from 'node:fs/promises';
import { hostname } from 'node:os';
import type { AttachmentMetadata } from '@/api/types';
import type { OmpImageContent } from './rpc/types';

const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const HAPI_USER_CONTEXT_OPEN_TAG_RE = /<hapi_user_context(\b[^>]*?)>/;

export type PreparedOmpInput = {
    message: string;
    images?: OmpImageContent[];
    ignoredAttachments: AttachmentMetadata[];
};

export function annotateRunnerHostInUserContext(
    message: string,
    runnerHost: string = process.env.HAPI_HOSTNAME || hostname()
): string {
    const trimmedHost = runnerHost.trim();
    if (!trimmedHost || !message.includes('<hapi_user_context')) {
        return message;
    }
    return message.replace(HAPI_USER_CONTEXT_OPEN_TAG_RE, (fullMatch, attrs: string) => {
        const hasRunnerHostAttr = /\brunner_host\s*=/.test(attrs);
        const escapedHost = trimmedHost.replaceAll('"', '&quot;');
        const updatedOpenTag = hasRunnerHostAttr
            ? fullMatch
            : `<hapi_user_context${attrs} runner_host="${escapedHost}">`;
        if (message.includes('Current HAPI Runner execution host')) {
            return updatedOpenTag;
        }
        return `${updatedOpenTag}\nCurrent HAPI Runner execution host (local machine running this session): ${trimmedHost}. Do NOT confuse this local runner host with other user-owned or target machines listed below.`;
    });
}

export async function prepareOmpInput(
    message: string,
    attachments: AttachmentMetadata[]
): Promise<PreparedOmpInput> {
    const imageAttachments = attachments.filter((attachment) => attachment.mimeType.startsWith('image/'));
    const ignoredAttachments = attachments.filter((attachment) => !attachment.mimeType.startsWith('image/'));
    const images: OmpImageContent[] = [];

    for (const attachment of imageAttachments) {
        let metadata;
        try {
            metadata = await stat(attachment.path);
        } catch (error) {
            throw new Error(`Cannot read image attachment ${attachment.filename}`, { cause: error });
        }
        if (!metadata.isFile()) {
            throw new Error(`Image attachment is not a file: ${attachment.filename}`);
        }
        if (metadata.size > MAX_IMAGE_BYTES) {
            throw new Error(`Image attachment exceeds 50MB: ${attachment.filename}`);
        }
        let bytes: Buffer;
        try {
            bytes = await readFile(attachment.path);
        } catch (error) {
            throw new Error(`Cannot read image attachment ${attachment.filename}`, { cause: error });
        }
        images.push({
            type: 'image',
            data: bytes.toString('base64'),
            mimeType: attachment.mimeType
        });
    }

    return {
        message: annotateRunnerHostInUserContext(message),
        ...(images.length > 0 ? { images } : {}),
        ignoredAttachments
    };
}

export function describeIgnoredOmpAttachments(attachments: AttachmentMetadata[]): string | null {
    if (attachments.length === 0) {
        return null;
    }
    const files = attachments
        .map((attachment) => `${attachment.filename} (${attachment.mimeType})`)
        .join(', ');
    return `OMP RPC supports image attachments only; ignored: ${files}`;
}
