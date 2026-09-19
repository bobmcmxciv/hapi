import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ApiClient, GeneratedBlobFetchOptions } from '@/api/client'
import type { GeneratedFileBlock, GeneratedImageBlock } from '@/chat/types'
import { HappyChatProvider, type HappyChatContextValue } from '@/components/AssistantChat/context'
import { GeneratedFileCard, GeneratedImageCard } from './ToolMessage'

function imageBlock(imageId: string): GeneratedImageBlock {
    return { kind: 'generated-image', id: `message:${imageId}`, localId: null, createdAt: 1, imageId, fileName: 'shot.png', mimeType: 'image/png' }
}

function fileBlock(fileId: string): GeneratedFileBlock {
    return { kind: 'generated-file', id: `message:${fileId}`, localId: null, createdAt: 1, fileId, fileName: 'report.pdf', mimeType: 'application/pdf', size: 4000 }
}

function context(api: Partial<ApiClient>): HappyChatContextValue {
    return {
        api: api as ApiClient,
        sessionId: 'session-1',
        metadata: null,
        terminalToolDisplayMode: 'detailed',
        disabled: false,
        onRefresh: () => undefined,
        hasMoreMessages: false,
        isSyncingTail: false,
        isLoadingMoreMessages: false,
        loadOlderMessagesPreservingScroll: async () => 'terminal-stop'
    }
}

type ObserverCallback = (entries: IntersectionObserverEntry[]) => void

/** Install a controllable IntersectionObserver; returns a trigger for "now visible". */
function installIntersectionObserver(): { reveal: () => void; observed: number } {
    const state = { callbacks: [] as ObserverCallback[], observed: 0 }
    class FakeObserver {
        constructor(callback: ObserverCallback) {
            state.callbacks.push(callback)
        }
        observe() { state.observed += 1 }
        disconnect() {}
        unobserve() {}
        takeRecords() { return [] }
    }
    vi.stubGlobal('IntersectionObserver', FakeObserver)
    return {
        reveal: () => state.callbacks.forEach((cb) => cb([{ isIntersecting: true } as IntersectionObserverEntry])),
        get observed() { return state.observed }
    }
}

describe('GeneratedImageCard lazy loading and progress', () => {
    afterEach(() => {
        vi.unstubAllGlobals()
        vi.restoreAllMocks()
    })

    it('does not start the transfer until the card is near the viewport', async () => {
        const observer = installIntersectionObserver()
        vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:img')
        vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
        const getGeneratedImageBlob = vi.fn(async () => new Blob(['png'], { type: 'image/png' }))

        render(
            <HappyChatProvider value={context({ getGeneratedImageBlob })}>
                <GeneratedImageCard block={imageBlock('img-1')} />
            </HappyChatProvider>
        )
        await new Promise((resolve) => setTimeout(resolve, 10))
        expect(getGeneratedImageBlob).not.toHaveBeenCalled()
        expect(observer.observed).toBe(1)

        observer.reveal()
        await waitFor(() => expect(getGeneratedImageBlob).toHaveBeenCalledTimes(1))
        await waitFor(() => expect(document.querySelector('img')).not.toBeNull())
    })

    it('shows transfer progress from the hub and a retry affordance on failure', async () => {
        const observer = installIntersectionObserver()
        vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:img')
        vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
        let attempts = 0
        const getGeneratedImageBlob = vi.fn(async (_s: string, _i: string, options?: GeneratedBlobFetchOptions) => {
            attempts += 1
            options?.onProgress?.({ state: 'uploading', received: 1000, size: 4000 })
            if (attempts === 1) {
                await new Promise((resolve) => setTimeout(resolve, 20))
                throw new Error('HTTP 503')
            }
            return new Blob(['png'], { type: 'image/png' })
        })

        render(
            <HappyChatProvider value={context({ getGeneratedImageBlob })}>
                <GeneratedImageCard block={imageBlock('img-1')} />
            </HappyChatProvider>
        )
        observer.reveal()
        expect(await screen.findByText(/Uploading from machine 25%/)).toBeInTheDocument()
        expect(await screen.findByText(/is unavailable\. HTTP 503/)).toBeInTheDocument()

        fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
        await waitFor(() => expect(getGeneratedImageBlob).toHaveBeenCalledTimes(2))
        await waitFor(() => expect(document.querySelector('img')).not.toBeNull())
        expect(screen.queryByText(/is unavailable/)).toBeNull()
    })
})

describe('GeneratedFileCard progress', () => {
    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('reports the hub-side transfer state while a download is pending', async () => {
        vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:file')
        vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
        vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
        let finish: (() => void) | null = null
        const getGeneratedFileBlob = vi.fn(async (_s: string, _i: string, options?: GeneratedBlobFetchOptions) => {
            options?.onProgress?.({ state: 'fetching', received: 2000, size: 4000 })
            await new Promise<void>((resolve) => { finish = resolve })
            return new Blob(['pdf'], { type: 'application/pdf' })
        })

        render(
            <HappyChatProvider value={context({ getGeneratedFileBlob })}>
                <GeneratedFileCard block={fileBlock('file-1')} />
            </HappyChatProvider>
        )
        fireEvent.click(screen.getByRole('button', { name: 'Download report.pdf' }))
        expect(await screen.findByText(/Fetching from machine 50%/)).toBeInTheDocument()

        finish!()
        await waitFor(() => expect(screen.queryByText(/Fetching from machine/)).toBeNull())
        expect(getGeneratedFileBlob).toHaveBeenCalledTimes(1)
    })
})
