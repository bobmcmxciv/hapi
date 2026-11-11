import { clearDraft, composerDraftUnchanged, type ComposerDraftCheckpoint } from '@/lib/composer-drafts'
import { clearDraftAttachments } from '@/lib/composer-attachment-drafts'

/** A response may clear only the snapshots owned by that submitted attempt. */
export function clearDraftsAfterSend(checkpoints: readonly ComposerDraftCheckpoint[]): void {
    for (const checkpoint of checkpoints) {
        if (!composerDraftUnchanged(checkpoint)) continue
        clearDraft(checkpoint.sessionId)
        clearDraftAttachments(checkpoint.sessionId)
    }
}
