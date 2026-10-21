import type { AttachmentMetadata } from '@/api/types'
import { formatAttachmentsForClaude, formatMessageWithAttachments } from '@/utils/attachmentFormatter'

/** Agy's /boost is a per-turn command, not a persistent effort setting. */
export function formatAgyUserMessage(
    text: string,
    attachments: AttachmentMetadata[] | undefined
): { message: string; isolate: boolean } {
    const command = text.trimStart()
    if (!/^\/boost(?:\s|$)/i.test(command)) {
        return { message: formatMessageWithAttachments(text, attachments), isolate: false }
    }

    // The common formatter prepends @paths, which would hide /boost from the
    // CLI's slash-command parser. Keep the command at the start of the input.
    const attachmentPaths = formatAttachmentsForClaude(attachments)
    return {
        message: attachmentPaths ? `${command} ${attachmentPaths}` : command,
        isolate: true
    }
}
