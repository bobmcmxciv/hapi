import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DecryptedMessage } from '@/types/api'
import type { PendingSchedule } from '@/components/AssistantChat/ScheduleTimePicker'
import {
 computeCanCancel,
 computeEditPendingSchedule,
 getQueuedMessageEditText,
 getQueuedMessagePreview,
 QueuedMessagesBar,
 sortQueuedMessages,
} from './QueuedMessagesBar'
import { formatScheduledTime } from '@/lib/scheduledTime'
import { clearQueuedEditRecovery, getQueuedEditRecovery } from '@/lib/queued-edit-recovery'
import { clearQueuedOutboxForTests, recordQueuedOutboxItem } from '@/lib/queued-outbox'

type DeferredCancelResult = { status: 'cancelled' | 'invoked' } | { status: 'resolved' | 'unconfirmed'; message: DecryptedMessage }

const mocks = vi.hoisted(() => ({
 composerText: '',
 composerSetText: vi.fn(),
 addToast: vi.fn(),
 mutateAsync: vi.fn(),
 resolveCancel: null as ((result: DeferredCancelResult) => void) | null,
 rejectCancel: null as ((reason?: unknown) => void) | null,
 saveDraft: vi.fn(),
 messageWindowState: { messages: [] as unknown[] },
}))

vi.mock('@assistant-ui/react', () => ({
 useAui: () => ({
  composer: () => ({
   getState: () => ({ text: mocks.composerText }),
   setText: mocks.composerSetText,
  }),
 }),
 useAuiState: (selector: (state: { composer: { text: string } }) => unknown) => selector({
  composer: { text: mocks.composerText },
 }),
}))

vi.mock('@/lib/message-window-store', () => ({
 getMessageWindowState: () => mocks.messageWindowState,
 subscribeMessageWindow: () => () => { },
 appendOptimisticMessage: vi.fn(),
 updateMessageStatus: vi.fn(),
 removeOptimisticMessage: vi.fn(),
 ingestIncomingMessages: vi.fn(),
 markMessagesConsumed: vi.fn(),
 stampForceSendRequested: vi.fn(),
}))

vi.mock('@/hooks/mutations/useCancelQueuedMessage', () => ({
 useCancelQueuedMessage: () => ({
  isPending: false,
  variables: undefined,
  mutateAsync: mocks.mutateAsync,
 }),
}))

vi.mock('@/lib/composer-drafts', () => ({
 saveDraft: mocks.saveDraft,
}))

vi.mock('@/lib/use-translation', () => ({
 useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@/lib/toast-context', () => ({
 useToast: () => ({ addToast: mocks.addToast }),
}))

function makeQueuedMessage(scheduledAt: number | null = null, id = 'server-message-id'): DecryptedMessage {
 return {
  id,
  localId: `local-${id}`,
  createdAt: 1000,
  seq: 1,
  scheduledAt,
  invokedAt: null,
  status: 'queued',
  content: {
   role: 'user',
   content: { type: 'text', text: 'Queued request' },
  },
 } as unknown as DecryptedMessage
}

function renderQueuedMessage(
 scheduledAt: number | null = null,
 pendingSchedule: PendingSchedule | null = null,
 pendingScheduleRevision = 0,
) {
 const onEdit = vi.fn()
 let currentPendingScheduleRevision = pendingScheduleRevision
 mocks.messageWindowState = { messages: [makeQueuedMessage(scheduledAt)] }
 const view = render(
  <QueuedMessagesBar
   sessionId="session-1"
   api={null}
   pendingSchedule={pendingSchedule}
   pendingScheduleRevision={currentPendingScheduleRevision}
   onEdit={onEdit}
  />
 )
 return {
  onEdit,
  unmount: view.unmount,
  rerender: (nextPendingSchedule: PendingSchedule | null, nextPendingScheduleRevision = currentPendingScheduleRevision) => {
   currentPendingScheduleRevision = nextPendingScheduleRevision
   view.rerender(
    <QueuedMessagesBar
     sessionId="session-1"
     api={null}
     pendingSchedule={nextPendingSchedule}
     pendingScheduleRevision={currentPendingScheduleRevision}
     onEdit={onEdit}
    />
   )
  },
 }
}

beforeEach(() => {
 mocks.composerText = ''
 mocks.composerSetText.mockReset()
 mocks.addToast.mockReset()
 mocks.mutateAsync.mockReset()
 mocks.resolveCancel = null
 mocks.rejectCancel = null
 mocks.saveDraft.mockReset()
 mocks.messageWindowState = { messages: [] }
 clearQueuedEditRecovery('session-1')
 clearQueuedOutboxForTests()
 mocks.mutateAsync.mockImplementation(() => new Promise<DeferredCancelResult>((resolve, reject) => {
  mocks.resolveCancel = resolve
  mocks.rejectCancel = reject
 }))
})

async function resolveCancel(result: DeferredCancelResult): Promise<void> {
 await act(async () => {
  mocks.resolveCancel?.(result)
  await Promise.resolve()
 })
}

function installManualAnimationFrames() {
 let nextHandle = 1
 const pending = new Map<number, FrameRequestCallback>()
 const history = new Map<number, FrameRequestCallback>()
 vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
  const handle = nextHandle++
  pending.set(handle, callback)
  history.set(handle, callback)
  return handle
 })
 vi.stubGlobal('cancelAnimationFrame', (handle: number) => {
  pending.delete(handle)
 })

 return {
  flushPending() {
   while (pending.size > 0) {
    const [handle, callback] = pending.entries().next().value as [number, FrameRequestCallback]
    pending.delete(handle)
    callback(Date.now())
   }
  },
  flushHistory() {
   for (const callback of history.values()) {
    callback(Date.now())
   }
  },
 }
}

afterEach(() => {
 vi.unstubAllGlobals()
})

describe('QueuedMessagesBar edit restore', () => {
 it('retains queue ownership and reports unconfirmed cancellation instead of restoring a delivery draft', async () => {
  const { onEdit } = renderQueuedMessage()
  fireEvent.click(screen.getByRole('button', { name: 'Edit queued message' }))
  await resolveCancel({ status: 'unconfirmed', message: makeQueuedMessage() })
  expect(mocks.composerSetText).not.toHaveBeenCalled()
  expect(onEdit).not.toHaveBeenCalled()
  expect(getQueuedEditRecovery('session-1')).toBeNull()
  expect(mocks.addToast).toHaveBeenCalledWith(expect.objectContaining({ title: 'queuedMessages.cancelUnconfirmed' }))
 })
 it.each(['handled', 'cancelled'] as const)('does not restore %s terminal input as a new delivery draft', async (outcome) => {
  const { onEdit, unmount } = renderQueuedMessage()
  fireEvent.click(screen.getByRole('button', { name: 'Edit queued message' }))
  unmount()
  await resolveCancel({ status: 'resolved', message: { ...makeQueuedMessage(), resolution: { outcome, resolvedAt: 2000 } } })
  expect(mocks.composerSetText).not.toHaveBeenCalled()
  expect(onEdit).not.toHaveBeenCalled()
  expect(getQueuedEditRecovery('session-1')).toBeNull()
 })
 it('keeps a newly typed draft and its schedule when the deferred cancel succeeds', async () => {
  const scheduledAt = Date.now() + 60_000
  const { onEdit } = renderQueuedMessage(scheduledAt)

  fireEvent.click(screen.getByRole('button', { name: 'Edit queued message' }))
  expect(mocks.resolveCancel).not.toBeNull()

  // The user starts a new draft while DELETE /messages/:id is still pending.
  mocks.composerText = 'New draft typed while cancelling'
  await resolveCancel({ status: 'cancelled' })

  expect(mocks.composerSetText).not.toHaveBeenCalled()
  expect(onEdit).not.toHaveBeenCalled()
  expect(mocks.addToast).toHaveBeenCalledWith({
   title: 'queuedMessages.editCurrentDraftKept',
   body: '',
   sessionId: 'session-1',
   url: window.location.href,
  })
 })

 it('keeps a newly selected schedule when the composer text is unchanged', async () => {
  const scheduledAt = Date.now() + 60_000
  const { onEdit, rerender } = renderQueuedMessage(scheduledAt)

  fireEvent.click(screen.getByRole('button', { name: 'Edit queued message' }))
  // The user changes only the clock selection while DELETE /messages/:id is pending.
  rerender({ type: 'preset', preset: '+30m' }, 1)
  await resolveCancel({ status: 'cancelled' })

  expect(mocks.composerSetText).not.toHaveBeenCalled()
  expect(onEdit).not.toHaveBeenCalled()
  expect(mocks.addToast).toHaveBeenCalledWith({
   title: 'queuedMessages.editCurrentDraftKept',
   body: '',
   sessionId: 'session-1',
   url: window.location.href,
  })
 })

 it('keeps the current state after selecting and then clearing a schedule', async () => {
  const scheduledAt = Date.now() + 60_000
  const { onEdit, rerender } = renderQueuedMessage(scheduledAt)

  fireEvent.click(screen.getByRole('button', { name: 'Edit queued message' }))
  rerender({ type: 'preset', preset: '+30m' }, 1)
  rerender(null, 2)
  await resolveCancel({ status: 'cancelled' })

  expect(mocks.composerSetText).not.toHaveBeenCalled()
  expect(onEdit).not.toHaveBeenCalled()
  expect(mocks.addToast).toHaveBeenCalledWith({
   title: 'queuedMessages.editCurrentDraftKept',
   body: '',
   sessionId: 'session-1',
   url: window.location.href,
  })
 })

 it('restores both text and schedule when the composer is unchanged', async () => {
  const scheduledAt = Date.now() + 60_000
  const { onEdit } = renderQueuedMessage(scheduledAt)

  fireEvent.click(screen.getByRole('button', { name: 'Edit queued message' }))
  await resolveCancel({ status: 'cancelled' })

  expect(mocks.composerSetText).toHaveBeenCalledWith('Queued request')
  expect(onEdit).toHaveBeenCalledWith({
   text: 'Queued request',
   pendingSchedule: { type: 'absolute', ms: scheduledAt },
  })
  expect(mocks.addToast).not.toHaveBeenCalled()
 })

 it('treats structurally equal schedule props as unchanged', async () => {
  const scheduledAt = Date.now() + 60_000
  const { onEdit, rerender } = renderQueuedMessage(scheduledAt, { type: 'preset', preset: '+5m' })

  fireEvent.click(screen.getByRole('button', { name: 'Edit queued message' }))
  rerender({ type: 'preset', preset: '+5m' })
  await resolveCancel({ status: 'cancelled' })

  expect(mocks.composerSetText).toHaveBeenCalledWith('Queued request')
  expect(onEdit).toHaveBeenCalledWith({
   text: 'Queued request',
   pendingSchedule: { type: 'absolute', ms: scheduledAt },
  })
 })

 it('globally disables queued operations and keeps the first edit completion', async () => {
  const scheduledAt = Date.now() + 60_000
  const first = makeQueuedMessage(null, 'server-message-a')
  const second = makeQueuedMessage(scheduledAt, 'server-message-b')
  mocks.messageWindowState = { messages: [first, second] }
  const onEdit = vi.fn()
  render(
   <QueuedMessagesBar
    sessionId="session-1"
    api={null}
    pendingSchedule={null}
    pendingScheduleRevision={0}
    onEdit={onEdit}
   />
  )

  const editButtons = screen.getAllByRole('button', { name: 'Edit queued message' })
  const cancelButtons = screen.getAllByRole('button', { name: 'Cancel queued message' })
  // QueuedMessagesBar orders immediate rows first, so the scheduled edit is second.
  fireEvent.click(editButtons[1]!)

  await waitFor(() => {
   for (const button of [...screen.getAllByRole('button', { name: 'Edit queued message' }), ...screen.getAllByRole('button', { name: 'Cancel queued message' })]) {
    expect(button).toBeDisabled()
   }
  })
  fireEvent.click(cancelButtons[0]!)
  fireEvent.click(editButtons[0]!)
  expect(mocks.mutateAsync).toHaveBeenCalledTimes(1)

  await resolveCancel({ status: 'cancelled' })
  expect(mocks.composerSetText).toHaveBeenCalledWith('Queued request')
  expect(onEdit).toHaveBeenCalledWith({
   text: 'Queued request',
   pendingSchedule: { type: 'absolute', ms: scheduledAt },
  })
 })

 it('persists an unmounted edit result and restores it after the same session remounts', async () => {
  const scheduledAt = Date.now() + 60_000
  const { unmount } = renderQueuedMessage(scheduledAt)

  fireEvent.click(screen.getByRole('button', { name: 'Edit queued message' }))
  unmount()
  await resolveCancel({ status: 'cancelled' })

  expect(mocks.saveDraft).not.toHaveBeenCalled()
  expect(getQueuedEditRecovery('session-1')).toEqual(expect.objectContaining({
   text: 'Queued request',
   pendingSchedule: { type: 'absolute', ms: scheduledAt },
   composerTextAtEdit: '',
   pendingScheduleAtEdit: null,
  }))

  const { onEdit } = renderQueuedMessage(scheduledAt)
  await waitFor(() => expect(mocks.composerSetText).toHaveBeenCalledWith('Queued request'))
  expect(onEdit).toHaveBeenCalledWith({
   text: 'Queued request',
   pendingSchedule: { type: 'absolute', ms: scheduledAt },
  })
  expect(getQueuedEditRecovery('session-1')).toBeNull()
 })

 it('notifies a same-session remount that returns before the edit cancellation completes', async () => {
  const scheduledAt = Date.now() + 60_000
  const { unmount } = renderQueuedMessage(scheduledAt)

  fireEvent.click(screen.getByRole('button', { name: 'Edit queued message' }))
  unmount()
  const { onEdit } = renderQueuedMessage(scheduledAt)

  await waitFor(() => {
   expect(screen.getByRole('button', { name: 'Edit queued message' })).toBeDisabled()
   expect(screen.getByRole('button', { name: 'Cancel queued message' })).toBeDisabled()
  })
  fireEvent.click(screen.getByRole('button', { name: 'Cancel queued message' }))
  expect(mocks.mutateAsync).toHaveBeenCalledTimes(1)

  await resolveCancel({ status: 'cancelled' })

  await waitFor(() => expect(mocks.composerSetText).toHaveBeenCalledWith('Queued request'))
  expect(onEdit).toHaveBeenCalledWith({
   text: 'Queued request',
   pendingSchedule: { type: 'absolute', ms: scheduledAt },
  })
  expect(getQueuedEditRecovery('session-1')).toBeNull()
 })

 it('keeps a remounted session busy until its queued-edit recovery is consumed', async () => {
  const raf = installManualAnimationFrames()
  const scheduledAt = Date.now() + 60_000
  const { unmount } = renderQueuedMessage(scheduledAt)

  fireEvent.click(screen.getByRole('button', { name: 'Edit queued message' }))
  unmount()
  const { onEdit } = renderQueuedMessage(scheduledAt)
  await resolveCancel({ status: 'cancelled' })

  // The mutation token has ended, but the unconsumed recovery keeps Q2 busy.
  expect(screen.getByRole('button', { name: 'Edit queued message' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'Cancel queued message' }))
  expect(mocks.mutateAsync).toHaveBeenCalledTimes(1)

  raf.flushPending()
  await waitFor(() => expect(screen.getByRole('button', { name: 'Edit queued message' })).not.toBeDisabled())
  expect(onEdit).toHaveBeenCalledWith({
   text: 'Queued request',
   pendingSchedule: { type: 'absolute', ms: scheduledAt },
  })
 })

 it('ignores overlapping and disposed recovery animation callbacks, then allows a fresh remount to consume', async () => {
  const raf = installManualAnimationFrames()
  const scheduledAt = Date.now() + 60_000
  const first = renderQueuedMessage(scheduledAt)

  fireEvent.click(screen.getByRole('button', { name: 'Edit queued message' }))
  first.unmount()
  const second = renderQueuedMessage(scheduledAt)
  await resolveCancel({ status: 'cancelled' })
  second.unmount()

  raf.flushHistory()
  expect(mocks.composerSetText).not.toHaveBeenCalled()
  expect(second.onEdit).not.toHaveBeenCalled()
  expect(getQueuedEditRecovery('session-1')).not.toBeNull()

  const third = renderQueuedMessage(scheduledAt)
  raf.flushPending()
  await waitFor(() => expect(mocks.composerSetText).toHaveBeenCalledWith('Queued request'))
  expect(third.onEdit).toHaveBeenCalledWith({
   text: 'Queued request',
   pendingSchedule: { type: 'absolute', ms: scheduledAt },
  })
  expect(getQueuedEditRecovery('session-1')).toBeNull()
 })

 it('clears a conflicting recovery once and never restores it after a later composer clear', async () => {
  const scheduledAt = Date.now() + 60_000
  const { unmount } = renderQueuedMessage(scheduledAt)

  fireEvent.click(screen.getByRole('button', { name: 'Edit queued message' }))
  unmount()
  await resolveCancel({ status: 'cancelled' })
  mocks.composerText = 'Current draft wins'

  const { onEdit, rerender } = renderQueuedMessage(scheduledAt)
  await waitFor(() => expect(mocks.addToast).toHaveBeenCalledWith({
   title: 'queuedMessages.editCurrentDraftKept',
   body: '',
   sessionId: 'session-1',
   url: window.location.href,
  }))
  expect(getQueuedEditRecovery('session-1')).toBeNull()

  mocks.composerText = ''
  rerender(null, 0)
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(mocks.composerSetText).not.toHaveBeenCalled()
  expect(onEdit).not.toHaveBeenCalled()
 })

 it('keeps the already-invoked toast behavior', async () => {
  const { onEdit } = renderQueuedMessage()

  fireEvent.click(screen.getByRole('button', { name: 'Edit queued message' }))
  await resolveCancel({ status: 'invoked' })

  expect(mocks.composerSetText).not.toHaveBeenCalled()
  expect(onEdit).not.toHaveBeenCalled()
  expect(mocks.addToast).toHaveBeenCalledWith({
   title: 'queuedMessages.editAlreadyInvoked',
   body: '',
   sessionId: 'session-1',
   url: window.location.href,
  })
 })

 it('does not restore an edit when cancel fails', async () => {
  const { onEdit } = renderQueuedMessage(Date.now() + 60_000)

  fireEvent.click(screen.getByRole('button', { name: 'Edit queued message' }))
  await act(async () => {
   mocks.rejectCancel?.(new Error('network failed'))
   await Promise.resolve()
  })

  expect(mocks.composerSetText).not.toHaveBeenCalled()
  expect(onEdit).not.toHaveBeenCalled()
 })
})

/**
 * Unit tests for computeCanCancel — the race guard that prevents sending
 * DELETE before the hub has a row to delete (pre-server-echo scenario).
 *
 * Key invariant: useSendMessage.onMutate creates an optimistic message with
 *   { id: localId, localId }
 * so id === localId until the server echo (message-received SSE) arrives and
 * message-window-store replaces the row with the server-assigned UUID id.
 * After that replace, id !== localId.
 *
 * canCancel = hasServerEcho && !isPending
 */
describe('computeCanCancel', () => {
 describe('hasServerEcho detection', () => {
  it('is false when id === localId (purely optimistic, no server echo)', () => {
   // useSendMessage.onMutate sets id = localId before POST /messages completes.
   const localId = 'local-abc-123'
   expect(computeCanCancel({ id: localId, localId, isPending: false })).toBe(false)
  })

  it('is true when id !== localId (server echo replaced id with server UUID)', () => {
   const localId = 'local-abc-123'
   const serverId = 'server-uuid-456'
   expect(computeCanCancel({ id: serverId, localId, isPending: false })).toBe(true)
  })

  it('is true when localId is undefined/null (server-only row, no local tracking)', () => {
   // Rows from server-loaded history have no localId — treat as already echoed.
   expect(computeCanCancel({ id: 'server-uuid-789', localId: undefined, isPending: false })).toBe(true)
   expect(computeCanCancel({ id: 'server-uuid-789', localId: null, isPending: false })).toBe(true)
  })
 })

 describe('isPending guard', () => {
  it('is false when a cancel mutation is already in-flight, even with server echo', () => {
   const localId = 'local-abc-123'
   const serverId = 'server-uuid-456'
   expect(computeCanCancel({ id: serverId, localId, isPending: true })).toBe(false)
  })

  it('is false when purely optimistic AND isPending', () => {
   const localId = 'local-abc-123'
   expect(computeCanCancel({ id: localId, localId, isPending: true })).toBe(false)
  })
 })

 describe('combined conditions', () => {
  it('is true only when server echo received AND no in-flight cancel', () => {
   const localId = 'local-abc-123'
   const serverId = 'server-uuid-456'
   // The normal case: user can click ✕ or ✎
   expect(computeCanCancel({ id: serverId, localId, isPending: false })).toBe(true)
  })
 })
})

// ---------------------------------------------------------------------------
// #4 computeEditPendingSchedule — edit restores scheduledAt as absolute pending
// ---------------------------------------------------------------------------

describe('computeEditPendingSchedule', () => {
 it('returns null for immediate-queued message (no scheduledAt)', () => {
  const now = Date.now()
  expect(computeEditPendingSchedule(null, now)).toBeNull()
  expect(computeEditPendingSchedule(undefined, now)).toBeNull()
 })

 it('returns null for scheduledAt in the past (message matured)', () => {
  const now = Date.now()
  const past = now - 5000 // 5 seconds ago
  expect(computeEditPendingSchedule(past, now)).toBeNull()
 })

 it('returns absolute PendingSchedule for future scheduledAt', () => {
  const now = Date.now()
  const future = now + 60_000 // 1 minute from now
  const result = computeEditPendingSchedule(future, now)
  expect(result).not.toBeNull()
  expect(result?.type).toBe('absolute')
  if (result?.type === 'absolute') {
   expect(result.ms).toBe(future)
  }
 })
})

describe('sortQueuedMessages', () => {
 const make = (id: string, createdAt: number, scheduledAt: number | null = null): DecryptedMessage => ({
  id,
  localId: id,
  createdAt,
  seq: createdAt,
  scheduledAt,
  invokedAt: null,
  content: { role: 'user', content: { type: 'text', text: id } },
 } as unknown as DecryptedMessage)

 it('places immediate-queued messages before scheduled ones', () => {
  const a = make('a-immediate', 1000)
  const b = make('b-scheduled-soon', 500, Date.now() + 60_000)
  const result = sortQueuedMessages([b, a])
  expect(result.map((m) => m.id)).toEqual(['a-immediate', 'b-scheduled-soon'])
 })

 it('orders immediate-queued messages by createdAt ascending', () => {
  const older = make('older', 1000)
  const newer = make('newer', 2000)
  const result = sortQueuedMessages([newer, older])
  expect(result.map((m) => m.id)).toEqual(['older', 'newer'])
 })

 it('orders scheduled messages by scheduledAt ascending (soonest first)', () => {
  const later = make('fires-later', 1000, 10_000)
  const sooner = make('fires-sooner', 2000, 5_000)
  const result = sortQueuedMessages([later, sooner])
  expect(result.map((m) => m.id)).toEqual(['fires-sooner', 'fires-later'])
 })

 it('combined: immediate first, then scheduled in fire-time order', () => {
  const im1 = make('im1', 1000)
  const im2 = make('im2', 2000)
  const sched1 = make('sched-near', 500, 5_000)
  const sched2 = make('sched-far', 600, 10_000)
  const result = sortQueuedMessages([sched2, im2, sched1, im1])
  expect(result.map((m) => m.id)).toEqual(['im1', 'im2', 'sched-near', 'sched-far'])
 })
})

describe('getQueuedMessagePreview', () => {
 it('keeps attachment names with a text prompt', () => {
  const message = {
   id: 'queued-with-image',
   localId: 'queued-with-image',
   createdAt: 1000,
   seq: null,
   invokedAt: null,
   status: 'queued',
   content: {
    role: 'user',
    content: {
     type: 'text',
     text: 'Analyze this screenshot',
     attachments: [{
      id: 'att-1',
      filename: 'image.png',
      mimeType: 'image/png',
      size: 1234,
      path: '/tmp/image.png',
     }],
    },
   },
  } as unknown as DecryptedMessage

  expect(getQueuedMessagePreview(message)).toEqual({
   text: 'Analyze this screenshot',
   attachmentNames: ['image.png'],
  })
 })

 it('uses attachment names for attachment-only queued messages', () => {
  const message = {
   id: 'queued-image-only',
   localId: 'queued-image-only',
   createdAt: 1000,
   seq: null,
   invokedAt: null,
   status: 'queued',
   content: {
    role: 'user',
    content: {
     type: 'text',
     text: '',
     attachments: [{
      id: 'att-1',
      filename: 'image.png',
      mimeType: 'image/png',
      size: 1234,
      path: '/tmp/image.png',
     }],
    },
   },
  } as unknown as DecryptedMessage

  expect(getQueuedMessagePreview(message)).toEqual({
   text: '',
   attachmentNames: ['image.png'],
  })
 })
})

describe('getQueuedMessageEditText', () => {
 it('keeps the prompt text when queued message has both text and attachments', () => {
  expect(getQueuedMessageEditText({
   text: 'Analyze this screenshot',
   attachmentNames: ['image.png'],
  })).toBe('Analyze this screenshot')
 })

 it('falls back to attachment names for attachment-only queued messages', () => {
  expect(getQueuedMessageEditText({
   text: '',
   attachmentNames: ['image.png', 'trace.log'],
  })).toBe('image.png, trace.log')
 })
})

// ---------------------------------------------------------------------------
// formatScheduledTime — cross-year support (#8)
// ---------------------------------------------------------------------------

describe('formatScheduledTime', () => {
 it('omits year for a date in the current year', () => {
  const now = new Date()
  // Use a date 1 month ahead in the same year, guarding against Dec edge case
  const sameYearDate = new Date(now.getFullYear(), now.getMonth() + 1 < 12 ? now.getMonth() + 1 : 0, 15, 10, 30)
  if (sameYearDate.getFullYear() !== now.getFullYear()) {
   // Wrapped to next year — skip (edge case in late December)
   return
  }
  const result = formatScheduledTime(sameYearDate.getTime())
  // Year digits should not appear
  expect(result).not.toContain(String(now.getFullYear()))
 })

 it('includes year for a date in a different year', () => {
  const nextYear = new Date().getFullYear() + 1
  const crossYearDate = new Date(nextYear, 0, 15, 10, 30) // Jan 15 next year
  const result = formatScheduledTime(crossYearDate.getTime())
  expect(result).toContain(String(nextYear))
 })
})

describe('force-send action and durable outbox', () => {
 it('shows a force-send button while typing, without replacing the composer draft', () => {
  mocks.composerText = 'newer draft still being typed'
  renderQueuedMessage()
  expect(screen.getByTestId('force-send-queued')).toBeInTheDocument()
  expect(mocks.composerSetText).not.toHaveBeenCalled()
 })

 it('shows attachment-only browser outbox items after reload even without Hub queued rows', () => {
  recordQueuedOutboxItem({
   localId: 'local-outbox-att', sessionId: 'session-1', text: '',
   attachments: [{ id: 'a1', filename: 'photo.png', mimeType: 'image/png', size: 1, path: '/tmp/photo.png' }],
   createdAt: Date.now(), scheduledAt: null, deliveryMode: 'queue',
  })
  render(<QueuedMessagesBar sessionId="session-1" api={null} pendingSchedule={null} pendingScheduleRevision={0} />)
  expect(document.querySelector('[data-outbox-item="local-outbox-att"]')).not.toBeNull()
  expect(screen.getByTestId('force-send-queued')).toBeInTheDocument()
  expect(mocks.composerSetText).not.toHaveBeenCalled()
 })
})

describe('pending receipt feedback', () => {
 it('keeps a single compact action row through submitting, acceptance, refresh and force request until native consumption', () => {
  const text = 'Review the pending request without repeating the entire message in the queue controls. '.repeat(4).trim()
  const original = makeQueuedMessage()
  const localId = original.localId!
  const content = { role: 'user', content: { type: 'text', text } }
  let message: DecryptedMessage = { ...original, id: localId, seq: null, status: 'sending', content }
  recordQueuedOutboxItem({ localId, sessionId: 'session-1', text, createdAt: 1000, scheduledAt: null, deliveryMode: 'queue' })
  mocks.messageWindowState = { messages: [message] }
  const element = <QueuedMessagesBar sessionId="session-1" api={null} pendingSchedule={null} pendingScheduleRevision={0} />
  const view = render(element)
  const expectSingleReceipt = () => {
   expect(screen.getByRole('status', { name: '1 queued message pending invocation' })).toBeInTheDocument()
   expect(document.querySelectorAll('[data-queued-list] > li')).toHaveLength(1)
   expect(document.querySelector('[data-outbox-item]')).toBeNull()
   expect(screen.queryByText(text)).toBeNull()
   expect(screen.getByTitle(text)).toHaveTextContent(`${text.trim().slice(0, 80)}…`)
  }
  const update = (next: DecryptedMessage) => {
   message = next
   mocks.messageWindowState = { messages: [message] }
   view.rerender(<QueuedMessagesBar sessionId="session-1" api={null} pendingSchedule={null} pendingScheduleRevision={0} />)
  }
  expectSingleReceipt()
  expect(screen.getByRole('button', { name: 'Cancel queued message' })).toBeDisabled()
  expect(screen.getByText('queuedMessages.forceSend.sending')).toBeInTheDocument()

  // HTTP success is not consumption; a persisted echo unlocks actions.
  update({ ...message, id: 'server-receipt', seq: 1, status: 'sent' })
  expectSingleReceipt()
  expect(screen.getByRole('button', { name: 'Cancel queued message' })).toBeEnabled()
  expect(screen.queryByText('queuedMessages.forceSend.sending')).toBeNull()

  // A reconnect/history refresh carries no client-side status.
  update({ ...message, status: undefined })
  expectSingleReceipt()
  expect(screen.getByRole('button', { name: 'Edit queued message' })).toBeEnabled()

  // Dispatch acknowledgement must not remove pending input or its actions.
  update({ ...message, content: { ...content, meta: { forceSendRequestedAt: 2000 } } })
  expectSingleReceipt()
  expect(screen.getByText('queuedMessages.forceSend.awaiting')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Cancel queued message' })).toBeEnabled()

  update({ ...message, invokedAt: 3000, status: 'sent' })
  expect(screen.queryByRole('status')).toBeNull()
  expect(screen.queryByTestId('force-send-queued')).toBeNull()
 })

 it.each(['consumed', 'resolved'] as const)('does not revive a %s receipt from a stale browser outbox failure', (terminal) => {
  const message = makeQueuedMessage()
  mocks.messageWindowState = { messages: [{
   ...message,
   status: 'failed',
   ...(terminal === 'consumed' ? { invokedAt: 1234 } : { resolution: { outcome: 'handled', resolvedAt: 1234 } }),
  }] }
  recordQueuedOutboxItem({ localId: message.localId!, sessionId: 'session-1', text: 'Already acknowledged', createdAt: 1000, scheduledAt: null, deliveryMode: 'queue' })
  render(<QueuedMessagesBar sessionId="session-1" api={null} pendingSchedule={null} pendingScheduleRevision={0} />)
  expect(screen.queryByRole('status')).toBeNull()
  expect(screen.queryByTestId('force-send-queued')).toBeNull()
 })

 it('shows submitting scheduled input in the queue while it is intentionally absent from the thread', () => {
  mocks.messageWindowState = { messages: [{ ...makeQueuedMessage(Date.now() + 60_000), status: 'sending' }] }
  render(<QueuedMessagesBar sessionId="session-1" api={null} pendingSchedule={null} pendingScheduleRevision={0} />)
  expect(screen.getByText('Queued request')).toBeInTheDocument()
  expect(screen.getByText('queuedMessages.forceSend.sending')).toBeInTheDocument()
  expect(screen.getByText('queuedMessages.scheduledFor')).toBeInTheDocument()
 })
})
