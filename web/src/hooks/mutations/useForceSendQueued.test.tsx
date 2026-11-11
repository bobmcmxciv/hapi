import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import type { ApiClient } from '@/api/client'
import type { ForceSendQueuedResponse } from '@/api/client'
import type { AttachmentMetadata } from '@hapi/protocol'
import { useForceSendQueued, type ForceSendSummary } from './useForceSendQueued'
import {
 clearQueuedOutboxForTests,
 getQueuedOutboxItem,
 recordQueuedOutboxItem,
 resetQueuedOutboxCacheForTests,
 type QueuedOutboxItem,
} from '@/lib/queued-outbox'
import { getDraft, saveDraft } from '@/lib/composer-drafts'
import {
 appendOptimisticMessage,
 getMessageWindowState,
 ingestIncomingMessages,
 markMessagesConsumed,
} from '@/lib/message-window-store'

vi.mock('@/lib/message-window-store', () => ({
 appendOptimisticMessage: vi.fn(),
 getMessageWindowState: vi.fn(() => ({ messages: [] })),
 updateMessageStatus: vi.fn(),
 removeOptimisticMessage: vi.fn(),
 ingestIncomingMessages: vi.fn(),
 markMessagesConsumed: vi.fn(),
}))

type SendMessageCall = [
 sessionId: string,
 text: string,
 localId?: string | null,
 attachments?: AttachmentMetadata[],
 scheduledAt?: number | null,
 ompInputMode?: unknown,
 deliveryMode?: unknown,
]

function createMockApi(overrides: Partial<ApiClient> = {}): ApiClient {
 return {
  sendMessage: vi.fn(async () => { }),
  forceSendQueuedMessages: vi.fn(async (): Promise<ForceSendQueuedResponse> => ({ results: [], messages: [] })),
  ...overrides,
 } as unknown as ApiClient
}

function seedOutboxItem(localId: string, text: string, overrides: Partial<QueuedOutboxItem> = {}) {
 recordQueuedOutboxItem({
  localId,
  sessionId: 'session-A',
  text,
  scheduledAt: null,
  deliveryMode: 'queue',
  createdAt: Date.now(),
  ...overrides,
 })
}

describe('useForceSendQueued', () => {
 beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getMessageWindowState).mockReturnValue({ messages: [] } as unknown as ReturnType<typeof getMessageWindowState>)
  clearQueuedOutboxForTests()
 })

 it('uploads outbox items in submission order with stable localIds, then snapshots', async () => {
  const sendMock = vi.fn(async (..._args: SendMessageCall) => { })
  const forceMock = vi.fn(async (): Promise<ForceSendQueuedResponse> => ({ results: [], messages: [] }))
  const api = createMockApi({ sendMessage: sendMock, forceSendQueuedMessages: forceMock })
  const now = Date.now()
  seedOutboxItem('local-1', 'first', { createdAt: now - 2000 })
  seedOutboxItem('local-2', 'second', { createdAt: now - 1000 })
  seedOutboxItem('local-3', 'third', { createdAt: now })

  const { result } = renderHook(() => useForceSendQueued(api, 'session-A'))
  let summary: ForceSendSummary | null | undefined
  await act(async () => {
   summary = await result.current.forceSendAll({ includeScheduled: false })
  })

  expect(sendMock).toHaveBeenCalledTimes(3)
  const order = sendMock.mock.calls.map((call) => call[2])
  expect(order).toEqual(['local-1', 'local-2', 'local-3'])
  // Snapshot call carries no localIds — the hub force-sends everything it holds.
  expect(forceMock).toHaveBeenCalledWith('session-A', { includeScheduled: false })
  expect(summary?.uploadedLocalIds).toEqual(['local-1', 'local-2', 'local-3'])
  expect(getQueuedOutboxItem('session-A', 'local-1')).toBeNull()
 })

 it('settles outbox uploads independently: partial failure keeps the failed record and still snapshots', async () => {
  const sendMock = vi.fn(async (..._args: SendMessageCall) => { })
   .mockRejectedValueOnce(new Error('flaky network'))
   .mockResolvedValue(undefined)
  const forceMock = vi.fn(async (): Promise<ForceSendQueuedResponse> => ({ results: [], messages: [] }))
  const api = createMockApi({ sendMessage: sendMock, forceSendQueuedMessages: forceMock })
  seedOutboxItem('local-fail', 'will fail')
  seedOutboxItem('local-ok', 'will land')

  const { result } = renderHook(() => useForceSendQueued(api, 'session-A'))
  let summary: ForceSendSummary | null | undefined
  await act(async () => {
   summary = await result.current.forceSendAll({ includeScheduled: false })
  })

  expect(summary?.uploadFailures).toEqual([{ localId: 'local-fail', error: 'flaky network' }])
  expect(summary?.uploadedLocalIds).toEqual(['local-ok'])
  const stored = getQueuedOutboxItem('session-A', 'local-fail')
  expect(stored?.status).toBe('failed')
  expect(stored?.text).toBe('will fail')
  expect(getQueuedOutboxItem('session-A', 'local-ok')).toBeNull()
  // The force call still ran — a failed upload never blocks the hub snapshot.
  expect(forceMock).toHaveBeenCalledTimes(1)
  expect(summary?.forceError).toBeNull()
 })

 it('prevents duplicate concurrent clicks: the second call is a no-op', async () => {
  const gate = Promise.withResolvers<void>()
  const sendMock = vi.fn(async (..._args: SendMessageCall) => { await gate.promise })
  const forceMock = vi.fn(async (): Promise<ForceSendQueuedResponse> => ({ results: [], messages: [] }))
  const api = createMockApi({ sendMessage: sendMock, forceSendQueuedMessages: forceMock })
  seedOutboxItem('local-1', 'one')

  const { result } = renderHook(() => useForceSendQueued(api, 'session-A'))
  let first: Promise<ForceSendSummary | null> | undefined
  await act(async () => {
   first = result.current.forceSendAll({ includeScheduled: false })
  })
  expect(result.current.isForceSending).toBe(true)
  const second = await result.current.forceSendAll({ includeScheduled: false })
  expect(second).toBeNull()
  expect(sendMock).toHaveBeenCalledTimes(1)
  await act(async () => {
   gate.resolve()
   await first
  })
  await waitFor(() => expect(result.current.isForceSending).toBe(false))
  expect(forceMock).toHaveBeenCalledTimes(1)
 })

 it('keeps every item visible when the force endpoint is missing (404/unsupported hub)', async () => {
  const sendMock = vi.fn(async (..._args: SendMessageCall) => { })
  const forceMock = vi.fn(async (): Promise<ForceSendQueuedResponse> => {
   throw new Error('HTTP 404 Not Found')
  })
  const api = createMockApi({ sendMessage: sendMock, forceSendQueuedMessages: forceMock })
  seedOutboxItem('local-1', 'queued input')

  const { result } = renderHook(() => useForceSendQueued(api, 'session-A'))
  let summary: ForceSendSummary | null | undefined
  await act(async () => {
   summary = await result.current.forceSendAll({ includeScheduled: false })
  })

  expect(summary?.forceError).toContain('404')
  // The durable upload still landed — receipt closed — and nothing pretended
  // to be force-delivered.
  expect(summary?.uploadedLocalIds).toEqual(['local-1'])
  expect(appendOptimisticMessage).toHaveBeenCalledWith('session-A', expect.objectContaining({ localId: 'local-1', invokedAt: null, status: 'queued' }))
 })

 it('does not touch the composer: a typed draft and attachments are never sent or cleared', async () => {
  const sendMock = vi.fn(async (..._args: SendMessageCall) => { })
  const forceMock = vi.fn(async (): Promise<ForceSendQueuedResponse> => ({ results: [], messages: [] }))
  const api = createMockApi({ sendMessage: sendMock, forceSendQueuedMessages: forceMock })
  saveDraft('session-A', 'half-typed draft text')
  seedOutboxItem('local-1', 'only the outbox item')

  const { result } = renderHook(() => useForceSendQueued(api, 'session-A'))
  await act(async () => {
   await result.current.forceSendAll({ includeScheduled: false })
  })

  // Only the outbox payload went out — the draft text was never a POST arg.
  for (const call of sendMock.mock.calls) {
   expect(call[1]).toBe('only the outbox item')
  }
  // And the composer draft survives intact for the operator to finish.
  expect(getDraft('session-A')).toBe('half-typed draft text')
 })

 it('merges authoritative rows without inventing invocation or force timestamps', async () => {
  const api = createMockApi({
   forceSendQueuedMessages: vi.fn(async (): Promise<ForceSendQueuedResponse> => ({
    results: [
     { localId: 'srv-1', status: 'invoked' },
     { localId: 'srv-2', status: 'dispatched' },
     { localId: 'srv-3', status: 'failed', error: 'refused' },
    ],
    messages: [
     { id: 'srv-1', seq: 1, localId: 'srv-1', content: {}, createdAt: 1, invokedAt: 2 },
     { id: 'srv-2', seq: 2, localId: 'srv-2', content: { role: 'user', content: { type: 'text', text: 'pending' }, meta: { forceSendRequestedAt: 3 } }, createdAt: 1, invokedAt: null },
    ],
   })),
  })

  const { result } = renderHook(() => useForceSendQueued(api, 'session-A'))
  let summary: ForceSendSummary | null | undefined
  await act(async () => {
   summary = await result.current.forceSendAll({ includeScheduled: false })
  })

  expect(ingestIncomingMessages).toHaveBeenCalledTimes(1)
  expect(ingestIncomingMessages).toHaveBeenCalledWith('session-A', expect.arrayContaining([
   expect.objectContaining({ localId: 'srv-2', invokedAt: null, content: expect.objectContaining({ meta: { forceSendRequestedAt: 3 } }) }),
  ]))
  expect(markMessagesConsumed).not.toHaveBeenCalled()
  expect(summary?.results).toHaveLength(3)
 })

 it('uploads legacy failed rows using their existing identities', async () => {
  vi.mocked(getMessageWindowState).mockReturnValue({
   messages: [{
    id: 'legacy', localId: 'legacy', seq: null, createdAt: 1,
    invokedAt: null, status: 'failed', originalText: 'recover this',
    content: { role: 'user', content: { type: 'text', text: 'recover this' } },
   }]
  } as unknown as ReturnType<typeof getMessageWindowState>)
  const send = vi.fn(async (..._args: SendMessageCall) => { })
  const api = createMockApi({ sendMessage: send })
  const { result } = renderHook(() => useForceSendQueued(api, 'session-A'))
  await act(async () => { await result.current.forceSendAll() })
  expect(send).toHaveBeenCalledWith('session-A', 'recover this', 'legacy', undefined, null, undefined, 'queue')
 })
 it('does not steer a later Pi turn when uploading an uncertain outbox receipt', async () => {
  seedOutboxItem('uncertain-steer', 'original input', { deliveryMode: 'steer' })
  const send = vi.fn(async (..._args: SendMessageCall) => { })
  const api = createMockApi({ sendMessage: send })
  const { result } = renderHook(() => useForceSendQueued(api, 'session-A'))
  await act(async () => { await result.current.forceSendAll() })
  expect(send).toHaveBeenCalledWith('session-A', 'original input', 'uncertain-steer', undefined, null, undefined, 'queue')
 })
 it('retries a lost upload acknowledgement after reload with the identical localId and attachments', async () => {
  const attachments: AttachmentMetadata[] = [{ id: 'a', filename: 'a.png', mimeType: 'image/png', size: 4, path: '/a.png' }]
  seedOutboxItem('lost-ack', '', { attachments, scheduledAt: 12345 })
  const send = vi.fn(async (..._args: SendMessageCall) => { })
   .mockRejectedValueOnce(new Error('connection closed after admission'))
  const api = createMockApi({ sendMessage: send })
  const first = renderHook(() => useForceSendQueued(api, 'session-A'))
  await act(async () => { await first.result.current.uploadOutboxItem(getQueuedOutboxItem('session-A', 'lost-ack')!) })
  expect(getQueuedOutboxItem('session-A', 'lost-ack')?.status).toBe('failed')
  first.unmount()
  resetQueuedOutboxCacheForTests()
  const reloaded = renderHook(() => useForceSendQueued(api, 'session-A'))
  await act(async () => { await reloaded.result.current.forceSendAll() })
  expect(send).toHaveBeenCalledTimes(2)
  expect(send.mock.calls[1]).toEqual(send.mock.calls[0])
  expect(send.mock.calls[1]).toEqual(['session-A', '', 'lost-ack', attachments, 12345, undefined, 'queue'])
 })
})
