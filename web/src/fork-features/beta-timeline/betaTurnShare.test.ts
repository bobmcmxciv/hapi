import { describe, expect, it, vi } from 'vitest'
import type { VisibleChatBlock } from '@/chat/toolGroups'
import { hydrateBetaShareRows } from './betaTurnShare'

const user: VisibleChatBlock = { kind: 'user-text', id: 'turn', localId: null, invokedAt: 1, createdAt: 1, text: 'prompt' }

describe('complete-turn capture outside the virtual history cache', () => {
 it('captures an entire turn larger than the viewport cache without truncating its real artifacts', async () => {
  const file: VisibleChatBlock = { kind: 'generated-file', id: 'file', localId: null, createdAt: 3, fileId: 'real-file', fileName: 'result.txt', mimeType: 'text/plain', size: 17 }
  const blocks: VisibleChatBlock[] = [user, ...Array.from({ length: 9000 }, (_, i): VisibleChatBlock => ({ kind: 'agent-text', id: `answer:${i}`, localId: null, createdAt: 2, text: `part ${i}` })), file]
  const loader = vi.fn(async () => blocks)
  const signal = new AbortController().signal
  const rows = await hydrateBetaShareRows('turn', loader, signal)
  expect(loader).toHaveBeenCalledWith('turn', signal)
  expect(rows).toHaveLength(9002)
  const artifact = rows[rows.length - 1]
  expect(artifact.kind === 'history' && artifact.block).toBe(file)
  expect(blocks).toHaveLength(9002)
 })
 it('rejects missing or mismatched turn identity rather than exporting some other data', async () => {
  const signal = new AbortController().signal
  await expect(hydrateBetaShareRows('turn', async () => [], signal)).rejects.toThrow('beta.timeline.shareIncomplete')
  await expect(hydrateBetaShareRows('other-turn', async () => [user], signal)).rejects.toThrow('beta.timeline.shareIncomplete')
 })
 it('does not produce a capture after cancellation even when the loader ignores the signal', async () => {
  const deferred = Promise.withResolvers<readonly VisibleChatBlock[]>()
  const controller = new AbortController()
  const collecting = hydrateBetaShareRows('turn', () => deferred.promise, controller.signal)
  controller.abort()
  deferred.resolve([user])
  await expect(collecting).rejects.toMatchObject({ name: 'AbortError' })
 })
})
