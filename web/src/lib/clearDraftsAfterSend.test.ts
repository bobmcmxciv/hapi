import { describe, it, expect } from 'vitest'
import { captureComposerDraft, getDraft, saveDraft } from '@/lib/composer-drafts'
import { clearDraftsAfterSend } from './clearDraftsAfterSend'

describe('successful-send draft ownership', () => {
    it('clears the submitted snapshot when no later draft replaced it', () => {
        const id = 'cleanup-owned'
        saveDraft(id, 'submitted')
        const checkpoint = captureComposerDraft(id)
        clearDraftsAfterSend([checkpoint])
        expect(getDraft(id)).toBe('')
    })

    it('does not let an old acknowledgement erase a newer unsent draft', () => {
        const id = 'cleanup-newer'
        saveDraft(id, 'submitted')
        const checkpoint = captureComposerDraft(id)
        saveDraft(id, 'replacement draft')
        clearDraftsAfterSend([checkpoint])
        expect(getDraft(id)).toBe('replacement draft')
    })

    it('preserves identical text that the user deleted and entered again', () => {
        const id = 'cleanup-aba'
        saveDraft(id, 'same text')
        const checkpoint = captureComposerDraft(id)
        saveDraft(id, '')
        saveDraft(id, 'same text')
        clearDraftsAfterSend([checkpoint])
        expect(getDraft(id)).toBe('same text')
    })

    it('clears an owned resumed target without erasing new source-session work', () => {
        saveDraft('cleanup-source', 'submitted')
        saveDraft('cleanup-target', 'submitted')
        const checkpoints = [captureComposerDraft('cleanup-source'), captureComposerDraft('cleanup-target')]
        saveDraft('cleanup-source', 'another source draft')
        clearDraftsAfterSend(checkpoints)
        expect(getDraft('cleanup-source')).toBe('another source draft')
        expect(getDraft('cleanup-target')).toBe('')
    })
})
