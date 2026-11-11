import { useEffect, useRef, useState, type RefObject } from 'react'
import { formatGeneratedBlobProgress, type GeneratedBlobProgress } from '@/api/client'
import type { ToolCallMessagePartProps } from '@assistant-ui/react'
import type { ChatBlock } from '@/chat/types'
import type { GeneratedFileBlock, GeneratedImageBlock, ToolCallBlock } from '@/chat/types'
import { FileIcon } from '@/components/FileIcon'
import { formatFileSize } from '@/components/AssistantChat/messages/MessageAttachments'
import type { ToolGroupBlock } from '@/chat/toolGroups'
import { isObject, safeStringify } from '@hapi/protocol'
import { isSubagentToolName } from '@/chat/subagentTool'
import { ToolGroupCard } from '@/components/ToolCard/ToolGroupCard'
import { getEventPresentation } from '@/chat/presentation'
import { isEventVisibleForFlavor } from '@/fork-features/omp-product/eventVisibility'
import { CodeBlock } from '@/components/CodeBlock'
import { EventNotice } from '@/components/AssistantChat/messages/EventNotice'
import { MarkdownRenderer } from '@/components/MarkdownRenderer'
import { MessageStatusIndicator } from '@/components/AssistantChat/messages/MessageStatusIndicator'
import { ToolCard } from '@/components/ToolCard/ToolCard'
import { useHappyChatContext } from '@/components/AssistantChat/context'
import { CliOutputBlock } from '@/components/CliOutputBlock'
import { UserBubbleContent, getUserBubbleClassName, shouldShowMessageStatus } from '@/components/AssistantChat/messages/user-bubble'
import { ImagePreview } from '@/components/ImagePreview'
import { isInlineVideoMimeType } from '@/lib/generatedInlineMedia'
import { useTranslation, type I18nContextValue } from '@/lib/use-translation'

import {
 acquireSaveTargetInUserGesture,
 formatP2pRouteLabel,
 runP2pDirectFileDownload,
 type AcquiredSaveTarget,
 type P2pDownloadStatus
} from '@/lib/p2pFileDownload'
function isToolCallBlock(value: unknown): value is ToolCallBlock {
 if (!isObject(value)) return false
 if (value.kind !== 'tool-call') return false
 if (typeof value.id !== 'string') return false
 if (value.localId !== null && typeof value.localId !== 'string') return false
 if (typeof value.createdAt !== 'number') return false
 if (!Array.isArray(value.children)) return false
 if (!isObject(value.tool)) return false
 if (typeof value.tool.name !== 'string') return false
 if (!('input' in value.tool)) return false
 if (value.tool.description !== null && typeof value.tool.description !== 'string') return false
 if (value.tool.state !== 'pending' && value.tool.state !== 'running' && value.tool.state !== 'completed' && value.tool.state !== 'error') return false
 return true
}

function isToolGroupBlock(value: unknown): value is ToolGroupBlock {
 if (!isObject(value)) return false
 if (value.kind !== 'tool-group') return false
 if (typeof value.id !== 'string') return false
 if (!Array.isArray(value.tools)) return false
 return true
}

function isGeneratedImageBlock(value: unknown): value is GeneratedImageBlock {
 if (!isObject(value)) return false
 if (value.kind !== 'generated-image') return false
 if (typeof value.id !== 'string') return false
 if (typeof value.imageId !== 'string') return false
 if (typeof value.fileName !== 'string') return false
 if (value.mimeType !== null && typeof value.mimeType !== 'string') return false
 return true
}

/**
 * True once the element has been scrolled near the viewport (sticky). Cards
 * that are never seen never start a transfer — a long chat with many
 * screenshots used to open every one of them at mount, all at once.
 */
function useNearViewport(ref: RefObject<HTMLElement | null>): boolean {
 const [near, setNear] = useState(() => typeof IntersectionObserver === 'undefined')

 useEffect(() => {
  if (near) return
  const element = ref.current
  if (!element || typeof IntersectionObserver === 'undefined') {
   setNear(true)
   return
  }
  const observer = new IntersectionObserver((entries) => {
   if (entries.some((entry) => entry.isIntersecting)) {
    setNear(true)
    observer.disconnect()
   }
  }, { rootMargin: '400px 0px' })
  observer.observe(element)
  return () => observer.disconnect()
 }, [near, ref])

 return near
}

export function GeneratedImageCard(props: { block: GeneratedImageBlock }) {
 const ctx = useHappyChatContext()
 const { t } = useTranslation()
 const [objectUrl, setObjectUrl] = useState<string | null>(null)
 const [error, setError] = useState<string | null>(null)
 const [progress, setProgress] = useState<GeneratedBlobProgress | null>(null)
 const [retryKey, setRetryKey] = useState(0)
 const objectUrlRef = useRef<string | null>(null)
 const cardRef = useRef<HTMLDivElement | null>(null)
 const nearViewport = useNearViewport(cardRef)
 const isVideo = isInlineVideoMimeType(props.block.mimeType)
 const mediaLabel = t(isVideo ? 'generatedFile.video' : 'generatedFile.image')

 useEffect(() => {
  return () => {
   if (objectUrlRef.current) {
    URL.revokeObjectURL(objectUrlRef.current)
    objectUrlRef.current = null
   }
  }
 }, [])

 useEffect(() => {
  let disposed = false

  if (objectUrlRef.current) {
   URL.revokeObjectURL(objectUrlRef.current)
   objectUrlRef.current = null
  }
  setObjectUrl(null)
  setError(null)
  setProgress(null)
  if (!nearViewport) {
   return
  }
  const controller = new AbortController()
  void ctx.api.getGeneratedImageBlob(ctx.sessionId, props.block.imageId, {
   signal: controller.signal,
   onProgress: (next) => {
    if (!disposed) setProgress(next)
   }
  })
   .then((blob) => {
    if (disposed) return
    const nextObjectUrl = URL.createObjectURL(blob)
    objectUrlRef.current = nextObjectUrl
    setObjectUrl(nextObjectUrl)
    setProgress(null)
   })
   .catch((err: unknown) => {
    if (disposed) return
    if (err instanceof DOMException && err.name === 'AbortError') return
    setProgress(null)
    setError(err instanceof Error ? err.message : '')
   })

  return () => {
   disposed = true
   controller.abort()
  }
 }, [ctx.api, ctx.sessionId, props.block.imageId, isVideo, nearViewport, retryKey])

 return (
  <div ref={cardRef} className="max-w-[92%] rounded-2xl border border-[var(--app-border)] bg-[var(--app-tool-card-bg)] p-3">
   <div className="mb-2 min-w-0 truncate text-xs font-medium text-[var(--app-hint)]">
    {mediaLabel} · {props.block.fileName}
    {progress ? ` · ${formatGeneratedBlobProgress(progress, t)}` : ''}
   </div>
   {objectUrl ? (
    isVideo ? (
     <video
      src={objectUrl}
      controls
      playsInline
      className="max-h-[min(28rem,60vh)] max-w-full rounded-xl"
     />
    ) : (
     <ImagePreview
      src={objectUrl}
      fileName={props.block.fileName}
      label={props.block.fileName}
      buttonClassName="block max-w-full cursor-zoom-in rounded-xl text-left"
      imageClassName="max-h-[min(28rem,60vh)] max-w-full rounded-xl object-contain"
     />
    )
   ) : error !== null ? (
    <div className="text-sm text-[var(--app-hint)]">
     {t('generatedFile.mediaUnavailable', { media: mediaLabel })} {error}{' '}
     <button
      type="button"
      onClick={() => setRetryKey((key) => key + 1)}
      className="font-medium text-[var(--app-link)] hover:underline"
     >
      {t('generatedFile.retry')}
     </button>
    </div>
   ) : (
    <div className="h-48 w-72 max-w-full animate-pulse rounded-xl bg-[var(--app-subtle-bg)]" />
   )}
  </div>
 )
}

function isGeneratedFileBlock(value: unknown): value is GeneratedFileBlock {
 if (!isObject(value)) return false
 if (value.kind !== 'generated-file') return false
 if (typeof value.id !== 'string') return false
 if (typeof value.fileId !== 'string') return false
 if (typeof value.fileName !== 'string') return false
 if (value.mimeType !== null && typeof value.mimeType !== 'string') return false
 if (value.size !== null && typeof value.size !== 'number') return false
 return true
}

// Browsers can render these inline in a new tab; everything else is download-only.
export function isPreviewableGeneratedFileMimeType(mimeType: string | null): boolean {
 if (!mimeType) return false
 if (mimeType === 'application/pdf' || mimeType === 'application/json') return true
 if (mimeType === 'text/plain' || mimeType === 'text/markdown' || mimeType === 'text/csv' || mimeType === 'text/tab-separated-values') return true
 return (mimeType.startsWith('image/') && mimeType !== 'image/svg+xml')
  || mimeType.startsWith('video/')
  || mimeType.startsWith('audio/')
}

function downloadGeneratedFile(fileName: string, blob: Blob): void {
 const url = URL.createObjectURL(blob)
 const anchor = document.createElement('a')
 anchor.href = url
 anchor.download = fileName
 anchor.click()
 // iOS Safari 异步接手 object URL，同步撤销会让下载静默失败；
 // 与下方 handleOpen 的 60s 延迟撤销保持同一口径。
 window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

function triggerNativeFileDownload(url: string, fileName: string): void {
 const anchor = document.createElement('a')
 anchor.href = url
 anchor.download = fileName
 anchor.rel = 'noopener'
 document.body.appendChild(anchor)
 anchor.click()
 anchor.remove()
}

function formatP2pStatusLine(status: P2pDownloadStatus, t: I18nContextValue['t']): string {
 const speed = status.speedBytesPerSec > 0
  ? ` · ${formatFileSize(status.speedBytesPerSec)}/s`
  : ''
 const progressBytes = status.totalBytes !== null && status.totalBytes > 0
  ? ` (${formatFileSize(status.receivedBytes)} / ${formatFileSize(status.totalBytes)})`
  : status.receivedBytes > 0
   ? ` (${formatFileSize(status.receivedBytes)})`
   : ''
 switch (status.state) {
  case 'preparing':
   return t('generatedFile.preparingDirect')
  case 'negotiating':
   return t('generatedFile.negotiating')
  case 'transferring-direct':
   return `${t('generatedFile.transferringDirect')}${progressBytes}${speed}`
  case 'verifying':
   return t('generatedFile.verifying')
  case 'switching-to-hub':
   return t('generatedFile.switchingToHub')
  case 'transferring-hub':
   return `${t('generatedFile.transferringHub')}${progressBytes}${speed}`
  case 'completed': {
   const route = status.routeCategory === 'hub-cache' ? t('generatedFile.hubRoute') : formatP2pRouteLabel(status.routeCategory)
   const timing = status.negotiateMs !== null ? ` · ${t('generatedFile.handshake', { ms: status.negotiateMs })}` : ''
   return `${t('generatedFile.completed')}${route ? ` · ${route}` : ''}${timing}${speed}`
  }
  case 'cancelled':
   return t('generatedFile.cancelled')
  case 'failed':
   return t('files.directories.download.error.title')
 }
}

export function GeneratedFileCard(props: { block: GeneratedFileBlock }) {
 const ctx = useHappyChatContext()
 const { t } = useTranslation()
 const [busy, setBusy] = useState(false)
 const [error, setError] = useState<string | null>(null)
 const [progress, setProgress] = useState<GeneratedBlobProgress | null>(null)
 const [p2pStatus, setP2pStatus] = useState<P2pDownloadStatus | null>(null)
 const abortRef = useRef<AbortController | null>(null)
 const mimeType = props.block.mimeType ?? 'application/octet-stream'

 useEffect(() => {
  return () => {
   abortRef.current?.abort()
  }
 }, [])

 const fetchBlob = async (signal?: AbortSignal): Promise<Blob> => {
  return await ctx.api.getGeneratedFileBlob(ctx.sessionId, props.block.fileId, {
   onProgress: setProgress,
   signal
  })
 }

 const downloadViaHub = async (
  saveTarget: AcquiredSaveTarget,
  signal: AbortSignal,
  fallbackReason: string | null
 ): Promise<void> => {
  setP2pStatus((prev) => ({
   state: 'transferring-hub',
   receivedBytes: 0,
   totalBytes: props.block.size,
   speedBytesPerSec: 0,
   routeCategory: 'hub-cache',
   negotiateMs: prev?.negotiateMs ?? null,
   fallbackReason,
   candidateTypes: prev?.candidateTypes ?? [],
   error: null
  }))
  if (saveTarget.kind === 'file-handle') {
   const blob = await fetchBlob(signal)
   const bytes = new Uint8Array(await blob.arrayBuffer())
   const writable = await saveTarget.handle.createWritable()
   try {
    await writable.write(bytes)
    await writable.close()
   } catch (writeErr) {
    await writable.abort().catch(() => { })
    throw writeErr
   }
  } else {
   if (typeof ctx.api.acquireGeneratedFileDownloadTicket === 'function') {
    const ticket = await ctx.api.acquireGeneratedFileDownloadTicket(
     ctx.sessionId,
     props.block.fileId,
     { onProgress: setProgress, signal }
    )
    if (ticket) {
     triggerNativeFileDownload(ticket.url, ticket.fileName || props.block.fileName)
     setP2pStatus((prev) => ({
      state: 'completed',
      receivedBytes: ticket.size,
      totalBytes: ticket.size,
      speedBytesPerSec: 0,
      routeCategory: 'hub-cache',
      negotiateMs: prev?.negotiateMs ?? null,
      fallbackReason,
      candidateTypes: prev?.candidateTypes ?? [],
      error: null
     }))
     return
    }
   }
   const blob = await fetchBlob(signal)
   downloadGeneratedFile(props.block.fileName, blob)
  }
  setP2pStatus((prev) => ({
   state: 'completed',
   receivedBytes: props.block.size ?? prev?.receivedBytes ?? 0,
   totalBytes: props.block.size,
   speedBytesPerSec: 0,
   routeCategory: 'hub-cache',
   negotiateMs: prev?.negotiateMs ?? null,
   fallbackReason,
   candidateTypes: prev?.candidateTypes ?? [],
   error: null
  }))
 }

 const handleDownload = () => {
  if (busy) return
  setBusy(true)
  setError(null)
  setProgress(null)
  setP2pStatus(null)
  const controller = new AbortController()
  abortRef.current = controller

  void (async () => {
   try {
    const saveTarget = await acquireSaveTargetInUserGesture(props.block.fileName)
    if (saveTarget.kind === 'aborted') {
     setP2pStatus({
      state: 'cancelled',
      receivedBytes: 0,
      totalBytes: props.block.size,
      speedBytesPerSec: 0,
      routeCategory: null,
      negotiateMs: null,
      fallbackReason: null,
      candidateTypes: [],
      error: null
     })
     return
    }

    if (
     typeof ctx.api.createP2pFileTransfer === 'function'
     && typeof ctx.api.signalP2pFileTransfer === 'function'
    ) {
     const p2pResult = await runP2pDirectFileDownload({
      api: ctx.api,
      sessionId: ctx.sessionId,
      fileId: props.block.fileId,
      fileName: props.block.fileName,
      mimeType,
      saveTarget,
      signal: controller.signal,
      onStatus: setP2pStatus
     })
     if (p2pResult.outcome === 'cancelled' || controller.signal.aborted) {
      setP2pStatus((prev) => prev ? { ...prev, state: 'cancelled' } : null)
      return
     }
     if (p2pResult.outcome === 'completed') {
      if (p2pResult.blob) {
       downloadGeneratedFile(props.block.fileName, p2pResult.blob)
      }
      setP2pStatus((prev) => ({
       state: 'completed',
       receivedBytes: p2pResult.bytes,
       totalBytes: p2pResult.bytes,
       speedBytesPerSec: prev?.speedBytesPerSec ?? 0,
       routeCategory: p2pResult.routeCategory,
       negotiateMs: p2pResult.negotiateMs,
       fallbackReason: null,
       candidateTypes: prev?.candidateTypes ?? [],
       error: null
      }))
      return
     }
     // Automatic fallback to Hub
     setP2pStatus((prev) => prev ? {
      ...prev,
      state: 'switching-to-hub',
      fallbackReason: p2pResult.reason
     } : null)
     await downloadViaHub(saveTarget, controller.signal, p2pResult.reason)
     return
    }

    await downloadViaHub(saveTarget, controller.signal, null)
   } catch (err: unknown) {
    if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
     setP2pStatus((prev) => prev ? { ...prev, state: 'cancelled' } : null)
     return
    }
    const msg = err instanceof Error ? err.message : t('files.directories.download.error.default')
    setError(msg)
    setP2pStatus((prev) => prev ? { ...prev, state: 'failed', error: msg } : null)
   } finally {
    if (abortRef.current === controller) {
     abortRef.current = null
    }
    setBusy(false)
    setProgress(null)
   }
  })()
 }

 const handleHubOnlyDownload = () => {
  if (busy) return
  setBusy(true)
  setError(null)
  setProgress(null)
  const controller = new AbortController()
  abortRef.current = controller

  void (async () => {
   try {
    await downloadViaHub({ kind: 'browser-default' }, controller.signal, null)
   } catch (err: unknown) {
    if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
     return
    }
    setError(err instanceof Error ? err.message : t('generatedFile.hubDownloadFailed'))
   } finally {
    if (abortRef.current === controller) {
     abortRef.current = null
    }
    setBusy(false)
    setProgress(null)
   }
  })()
 }

 const handleCancel = () => {
  abortRef.current?.abort()
 }

 const handleOpen = () => {
  if (busy) return
  setBusy(true)
  setError(null)
  setProgress(null)
  void fetchBlob()
   .then((blob) => {
    const typed = blob.type ? blob : new Blob([blob], { type: mimeType })
    const url = URL.createObjectURL(typed)
    window.open(url, '_blank', 'noopener')
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
   })
   .catch((err: unknown) => {
    setError(err instanceof Error ? err.message : t('generatedFile.openFailed'))
   })
   .finally(() => {
    setBusy(false)
    setProgress(null)
   })
 }

 const statusSummary = busy
  ? (progress ? formatGeneratedBlobProgress(progress, t) : p2pStatus ? formatP2pStatusLine(p2pStatus, t) : t('generatedFile.downloading'))
  : (p2pStatus && (p2pStatus.state === 'completed' || p2pStatus.state === 'cancelled') ? formatP2pStatusLine(p2pStatus, t) : '')

 return (
  <div className="max-w-[92%] rounded-2xl border border-[var(--app-border)] bg-[var(--app-tool-card-bg)] p-3">
   <button
    type="button"
    onClick={handleDownload}
    disabled={busy}
    className="flex w-full items-center gap-3 rounded-xl text-left transition-opacity hover:opacity-80 disabled:cursor-wait disabled:opacity-60"
    aria-label={t('files.directories.downloadNamed', { name: props.block.fileName })}
   >
    <FileIcon fileName={props.block.fileName} size={36} />
    <div className="min-w-0 flex-1">
     <div className="truncate text-sm font-medium text-[var(--app-fg)]">
      {props.block.fileName}
     </div>
     <div className="text-xs text-[var(--app-hint)]">
      {props.block.size !== null ? formatFileSize(props.block.size) : t('generatedFile.file')}
      {statusSummary ? ` · ${statusSummary}` : ''}
     </div>
    </div>
   </button>
   <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
    <button
     type="button"
     onClick={handleDownload}
     disabled={busy}
     className="font-medium text-[var(--app-link)] hover:underline disabled:opacity-60"
    >
     {t('files.directories.download')}
    </button>
    <button
     type="button"
     onClick={handleHubOnlyDownload}
     disabled={busy}
     className="font-medium text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:underline disabled:opacity-60"
    >
     {t('generatedFile.downloadHub')}
    </button>
    {busy ? (
     <button
      type="button"
      onClick={handleCancel}
      className="font-medium text-amber-500 hover:underline"
     >
      {t('generatedFile.cancel')}
     </button>
    ) : null}
    {isPreviewableGeneratedFileMimeType(props.block.mimeType) ? (
     <button
      type="button"
      onClick={handleOpen}
      disabled={busy}
      className="font-medium text-[var(--app-link)] hover:underline disabled:opacity-60"
     >
      {t('generatedFile.open')}
     </button>
    ) : null}
   </div>
   {p2pStatus?.fallbackReason ? (
    <div className="mt-1.5 text-[11px] text-[var(--app-hint)]">
     {t('generatedFile.fallback', { reason: p2pStatus.fallbackReason })}
    </div>
   ) : null}
   {error ? (
    <div className="mt-2 text-xs text-red-500">
     {t('generatedFile.unavailable')} {error}
    </div>
   ) : null}
  </div>
 )
}

function isPendingPermissionBlock(block: ChatBlock): boolean {
 return block.kind === 'tool-call' && block.tool.permission?.status === 'pending'
}

function splitTaskChildren(block: ToolCallBlock): { pending: ChatBlock[]; rest: ChatBlock[] } {
 const pending: ChatBlock[] = []
 const rest: ChatBlock[] = []

 for (const child of block.children) {
  if (isPendingPermissionBlock(child)) {
   pending.push(child)
  } else {
   rest.push(child)
  }
 }

 return { pending, rest }
}

function HappyNestedBlockList(props: {
 blocks: ChatBlock[]
}) {
 const ctx = useHappyChatContext()

 return (
  <div className="flex flex-col gap-3">
   {props.blocks.map((block) => {
    if (block.kind === 'user-text') {
     const status = block.status
     const canRetry = status === 'failed' && typeof block.localId === 'string' && Boolean(ctx.onRetryMessage)
     const onRetry = canRetry ? () => ctx.onRetryMessage!(block.localId!) : undefined
     const showStatus = shouldShowMessageStatus(status)

     return (
      <div key={`user:${block.id}`} className={getUserBubbleClassName(status)}>
       <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
         <UserBubbleContent text={block.text} />
        </div>
        {showStatus ? (
         <div className="happy-message-actions-first-line shrink-0">
          <MessageStatusIndicator status={status} onRetry={onRetry} />
         </div>
        ) : null}
       </div>
      </div>
     )
    }

    if (block.kind === 'agent-text') {
     return (
      <div key={`agent:${block.id}`} className="px-1">
       <MarkdownRenderer content={block.text} />
      </div>
     )
    }

    if (block.kind === 'cli-output') {
     const alignClass = block.source === 'user' ? 'ml-auto w-full max-w-[92%]' : ''
     return (
      <div key={`cli:${block.id}`} className="px-1 min-w-0 max-w-full overflow-x-clip">
       <div className={alignClass}>
        <CliOutputBlock text={block.text} />
       </div>
      </div>
     )
    }

    if (block.kind === 'generated-image') {
     return (
      <div key={`generated-image:${block.id}`} className="px-1">
       <GeneratedImageCard block={block} />
      </div>
     )
    }

    if (block.kind === 'generated-file') {
     return (
      <div key={`generated-file:${block.id}`} className="px-1">
       <GeneratedFileCard block={block} />
      </div>
     )
    }

    if (block.kind === 'agent-event') {
     if (!isEventVisibleForFlavor(block.event, ctx.metadata?.flavor)) return null
     const presentation = getEventPresentation(block.event)
     return (
      <div key={`event:${block.id}`} className="py-1">
       <EventNotice
        icon={presentation.icon}
        text={presentation.text}
        details={presentation.details}
       />
      </div>
     )
    }

    if (block.kind === 'tool-call') {
     const isTask = isSubagentToolName(block.tool.name)
     const hideChildren = block.tool.name === 'CodexAgent'
     const taskChildren = isTask ? splitTaskChildren(block) : null

     return (
      <div key={`tool:${block.id}`} data-hapi-share-exclude="true" className="py-1">
       <ToolCard
        api={ctx.api}
        sessionId={ctx.sessionId}
        metadata={ctx.metadata}
        terminalToolDisplayMode={ctx.terminalToolDisplayMode}
        disabled={ctx.disabled}
        onDone={ctx.onRefresh}
        block={block}
       />
       {!hideChildren && block.children.length > 0 ? (
        isTask ? (
         <>
          {taskChildren && taskChildren.pending.length > 0 ? (
           <div className="mt-2 pl-3">
            <HappyNestedBlockList blocks={taskChildren.pending} />
           </div>
          ) : null}
          {taskChildren && taskChildren.rest.length > 0 ? (
           <details className="mt-2">
            <summary className="sticky top-0 z-10 cursor-pointer bg-[var(--app-bg)] py-1 text-xs text-[var(--app-hint)]">
             Task details ({taskChildren.rest.length})
            </summary>
            <div className="mt-2 pl-3">
             <HappyNestedBlockList blocks={taskChildren.rest} />
            </div>
           </details>
          ) : null}
         </>
        ) : (
         <div className="mt-2 pl-3">
          <HappyNestedBlockList blocks={block.children} />
         </div>
        )
       ) : null}
      </div>
     )
    }

    return null
   })}
  </div>
 )
}

export function HappyToolMessage(props: ToolCallMessagePartProps) {
 const ctx = useHappyChatContext()
 const artifact = props.artifact

 if (isToolGroupBlock(artifact)) {
  return (
   <div data-hapi-share-exclude="true" className="py-1 min-w-0 max-w-full overflow-x-clip">
    <ToolGroupCard
     block={artifact}
     metadata={ctx.metadata}
    />
   </div>
  )
 }

 if (isGeneratedImageBlock(artifact)) {
  return (
   <div className="py-1 min-w-0 max-w-full overflow-x-clip">
    <GeneratedImageCard block={artifact} />
   </div>
  )
 }

 if (isGeneratedFileBlock(artifact)) {
  return (
   <div className="py-1 min-w-0 max-w-full overflow-x-clip">
    <GeneratedFileCard block={artifact} />
   </div>
  )
 }

 if (!isToolCallBlock(artifact)) {
  const argsText = typeof props.argsText === 'string' ? props.argsText.trim() : ''
  const hasArgsText = argsText.length > 0
  const hasResult = props.result !== undefined
  const resultText = hasResult ? safeStringify(props.result) : ''

  return (
   <div data-hapi-share-exclude="true" className="py-1 min-w-0 max-w-full overflow-x-clip">
    <div className="overflow-clip rounded-[20px] bg-[var(--app-tool-card-bg)] p-3 shadow-none">
     <div className="flex items-center gap-2 text-xs">
      <div className="font-mono text-[var(--app-tool-card-accent)]">
       Tool: {props.toolName}
      </div>
      {props.isError ? (
       <span className="text-red-500">Error</span>
      ) : null}
      {props.status.type === 'running' && !hasResult ? (
       <span className="text-[var(--app-hint)]">Running…</span>
      ) : null}
     </div>

     {hasArgsText ? (
      <div className="mt-2">
       <CodeBlock code={argsText} language="json" title="Input" collapseLongContent />
      </div>
     ) : null}

     {hasResult ? (
      <div className="mt-2">
       <CodeBlock code={resultText} language={typeof props.result === 'string' ? 'text' : 'json'} title="Output" collapseLongContent />
      </div>
     ) : null}
    </div>
   </div>
  )
 }

 const block = artifact
 const isTask = isSubagentToolName(block.tool.name)
 const hideChildren = block.tool.name === 'CodexAgent'
 const taskChildren = isTask ? splitTaskChildren(block) : null

 return (
  <div data-hapi-share-exclude="true" className="py-1 min-w-0 max-w-full overflow-x-clip">
   <ToolCard
    api={ctx.api}
    sessionId={ctx.sessionId}
    metadata={ctx.metadata}
    terminalToolDisplayMode={ctx.terminalToolDisplayMode}
    disabled={ctx.disabled}
    onDone={ctx.onRefresh}
    block={block}
   />
   {!hideChildren && block.children.length > 0 ? (
    isTask ? (
     <>
      {taskChildren && taskChildren.pending.length > 0 ? (
       <div className="mt-2 pl-3">
        <HappyNestedBlockList blocks={taskChildren.pending} />
       </div>
      ) : null}
      {taskChildren && taskChildren.rest.length > 0 ? (
       <details className="mt-2">
        <summary className="sticky top-0 z-10 cursor-pointer bg-[var(--app-bg)] py-1 text-xs text-[var(--app-hint)]">
         Task details ({taskChildren.rest.length})
        </summary>
        <div className="mt-2 pl-3">
         <HappyNestedBlockList blocks={taskChildren.rest} />
        </div>
       </details>
      ) : null}
     </>
    ) : (
     <div className="mt-2 pl-3">
      <HappyNestedBlockList blocks={block.children} />
     </div>
    )
   ) : null}
  </div>
 )
}
