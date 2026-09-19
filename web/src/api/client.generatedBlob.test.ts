import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiClient, ApiError, formatGeneratedBlobProgress, generatedBlobRequestsInFlight, isRetryableBlobStatus } from './client'

type Scripted = Array<() => Response | Promise<Response>>

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

function bytesResponse(text: string): Response {
    return new Response(text, { status: 200, headers: { 'content-type': 'application/pdf', 'content-length': String(text.length) } })
}

let fetchMock: ReturnType<typeof vi.fn>
let calls: { url: string; auth: string | null }[]

function scriptFetch(script: Scripted): void {
    calls = []
    fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers)
        calls.push({ url: String(input), auth: headers.get('authorization') })
        const next = script.shift()
        if (!next) throw new Error('unexpected fetch')
        return await next()
    })
    vi.stubGlobal('fetch', fetchMock)
}

beforeEach(() => {
    vi.useFakeTimers()
})

afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
})

async function drain<T>(promise: Promise<T>): Promise<T> {
    // Advance fake timers until the promise settles.
    let settled = false
    let value: T | undefined
    let failure: unknown
    promise.then((v) => { settled = true; value = v }, (e) => { settled = true; failure = e })
    for (let i = 0; i < 200 && !settled; i++) {
        await vi.advanceTimersByTimeAsync(1000)
    }
    if (!settled) throw new Error('promise did not settle')
    if (failure !== undefined) throw failure
    return value as T
}

describe('generated blob download', () => {
    it('polls a 202 with progress until the hub serves the bytes', async () => {
        scriptFetch([
            () => jsonResponse(202, { success: false, state: 'uploading', received: 1000, size: 4000, retryAfterMs: 1000 }),
            () => jsonResponse(202, { success: false, state: 'fetching', received: 3000, size: 4000, retryAfterMs: 1000 }),
            () => bytesResponse('pdf-bytes')
        ])
        const progress: string[] = []
        const client = new ApiClient('jwt-1')

        const blob = await drain(client.getGeneratedFileBlob('session-1', 'file-1', {
            onProgress: (p) => progress.push(formatGeneratedBlobProgress(p))
        }))

        expect(blob.size).toBe('pdf-bytes'.length)
        expect(blob.type).toBe('application/pdf')
        expect(progress).toEqual(['Uploading from machine 25%', 'Fetching from machine 75%', 'Downloading…'])
        expect(calls.map((c) => c.url)).toEqual(Array(3).fill('/api/sessions/session-1/generated-files/file-1'))
        expect(calls[0].auth).toBe('Bearer jwt-1')
    })

    it('retries a bad gateway with backoff and then succeeds', async () => {
        scriptFetch([
            () => new Response('bad gateway', { status: 502 }),
            () => new Response('unavailable', { status: 503 }),
            () => bytesResponse('ok')
        ])
        const client = new ApiClient('jwt-1')
        const blob = await drain(client.getGeneratedImageBlob('session-1', 'img-1'))
        expect(blob.size).toBe('ok'.length)
        expect(fetchMock).toHaveBeenCalledTimes(3)
    })

    it('gives up on a 404 at once with the hub reason in the error body', async () => {
        scriptFetch([
            () => jsonResponse(404, { success: false, reason: 'not-found', error: 'Sent file not found' })
        ])
        const client = new ApiClient('jwt-1')
        await expect(drain(client.getGeneratedFileBlob('session-1', 'file-1'))).rejects.toMatchObject({ status: 404 })
        expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('stops after the retry budget on persistent gateway errors', async () => {
        scriptFetch(Array(10).fill(() => new Response('bad gateway', { status: 502 })))
        const client = new ApiClient('jwt-1')
        let error: unknown
        try {
            await drain(client.getGeneratedFileBlob('session-1', 'file-1'))
        } catch (e) {
            error = e
        }
        expect(error).toBeInstanceOf(ApiError)
        expect((error as ApiError).status).toBe(502)
        expect(fetchMock).toHaveBeenCalledTimes(5)
    })

    it('refreshes the token once on 401', async () => {
        scriptFetch([
            () => new Response('expired', { status: 401 }),
            () => bytesResponse('ok')
        ])
        const client = new ApiClient('jwt-old', { onUnauthorized: async () => 'jwt-new' })
        const blob = await drain(client.getGeneratedFileBlob('session-1', 'file-1'))
        expect(blob.size).toBe('ok'.length)
        expect(calls.map((c) => c.auth)).toEqual(['Bearer jwt-old', 'Bearer jwt-new'])
    })

    it('never has more than two blob requests in flight', async () => {
        let release: (() => void)[] = []
        const gated = () => new Promise<Response>((resolve) => {
            release.push(() => resolve(bytesResponse('x')))
        })
        scriptFetch([gated, gated, gated, gated])
        const client = new ApiClient('jwt-1')

        const downloads = [1, 2, 3, 4].map((i) => client.getGeneratedImageBlob('session-1', `img-${i}`))
        await vi.advanceTimersByTimeAsync(10)
        expect(fetchMock).toHaveBeenCalledTimes(2)
        expect(generatedBlobRequestsInFlight()).toBe(2)

        release.shift()!()
        await vi.advanceTimersByTimeAsync(10)
        expect(fetchMock).toHaveBeenCalledTimes(3)

        release.shift()!()
        release.shift()!()
        await vi.advanceTimersByTimeAsync(10)
        expect(fetchMock).toHaveBeenCalledTimes(4)
        release.shift()!()
        await drain(Promise.all(downloads))
        expect(generatedBlobRequestsInFlight()).toBe(0)
    })

    it('classifies only edge failures as retryable', () => {
        expect(isRetryableBlobStatus(502)).toBe(true)
        expect(isRetryableBlobStatus(503)).toBe(true)
        expect(isRetryableBlobStatus(504)).toBe(true)
        expect(isRetryableBlobStatus(404)).toBe(false)
        expect(isRetryableBlobStatus(202)).toBe(false)
    })
})
