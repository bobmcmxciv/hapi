import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { clearDraft, saveDraft } from '@/lib/composer-drafts'
import { useComposerDraft } from './useComposerDraft'

const ids = ['page-lifecycle-current', 'page-lifecycle-hydrating']
const addAttachment = async (_file: File) => { }
function mountDraft(sessionId: string) {
    return renderHook(() => {
        const [text, setText] = useState('')
        const hydration = useComposerDraft(sessionId, text, [], true, setText, addAttachment)
        return { text, setText, hydration }
    })
}
function storedDraft(sessionId: string): unknown {
    return JSON.parse(sessionStorage.getItem('hapi:composer-drafts') ?? '{}')[sessionId]
}
afterEach(() => {
    cleanup()
    for (const id of ids) clearDraft(id)
    vi.restoreAllMocks()
})

describe('active composer document lifecycle', () => {
    it('persists current edits on pagehide and backgrounding without requiring a React unmount', async () => {
        const id = ids[0]
        saveDraft(id, 'previous draft')
        const { result } = mountDraft(id)
        await waitFor(() => expect(result.current.hydration.complete).toBe(true))
        expect(result.current.text).toBe('previous draft')
        act(() => result.current.setText('new unsent input'))
        act(() => window.dispatchEvent(new Event('pagehide')))
        expect(storedDraft(id)).toBe('new unsent input')

        act(() => result.current.setText('latest background input'))
        vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
        act(() => document.dispatchEvent(new Event('visibilitychange')))
        expect(storedDraft(id)).toBe('latest background input')
    })

    it('does not replace a persisted draft with initial empty text when pagehide precedes hydration', async () => {
        const id = ids[1]
        saveDraft(id, 'recover after immediate reload')
        const { result } = mountDraft(id)
        act(() => window.dispatchEvent(new Event('pagehide')))
        expect(storedDraft(id)).toBe('recover after immediate reload')
        await waitFor(() => expect(result.current.hydration.complete).toBe(true))
        expect(result.current.text).toBe('recover after immediate reload')
    })
})
