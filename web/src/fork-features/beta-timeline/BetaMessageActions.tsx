import { useState } from 'react'
import * as Popover from '@radix-ui/react-popover'
import { CheckIcon, CopyIcon, ForkIcon, InfoIcon, RewindIcon } from '@/components/icons'
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard'
import { useTranslation } from '@/lib/use-translation'
import { MessageMetadata, buildMessageMetadataLabels, type MessageMetadataProps } from '@/components/AssistantChat/messages/MessageMetadata'
import { formatMessageTimestamp, formatMessageTimestampTitle } from '@/chat/presentation'
import { cn } from '@/lib/utils'
import { useOptionalHappyChatContext } from '@/components/AssistantChat/context'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'

/**
 * AUI-free port of `MessageActions`: copy / timestamp / metadata / share /
 * fork / rewind. Share gating and running state arrive as props instead of
 * `useAuiState` selectors; share resolves the whole turn from row data via
 * the context `onShareTurn`, never from viewport DOM alone.
 */

export type BetaMessageActionsProps = {
 align: 'start' | 'end'
 copyText?: string
 metadata?: Omit<MessageMetadataProps, 'className'>
 createdAt?: number
 /** DOM anchor id (`hapi-message-*`) passed to the share handler. */
 messageElementId?: string
 /** Hide the share button (inside the active turn while running). */
 hideShare?: boolean
 /** Text of the nearest preceding user message — share fallback. */
 fallbackUserText?: string
 showFork?: boolean
 showRewind?: boolean
 historyActionPending?: boolean
 threadIsRunning?: boolean
 onFork?: () => Promise<void>
 onRewind?: () => Promise<void>
}

function ShareIcon(props: { className?: string }) {
 return (
  <svg
   xmlns="http://www.w3.org/2000/svg"
   viewBox="0 0 24 24"
   fill="none"
   stroke="currentColor"
   strokeWidth="2"
   strokeLinecap="round"
   strokeLinejoin="round"
   className={props.className}
  >
   <circle cx="18" cy="5" r="3" />
   <circle cx="6" cy="12" r="3" />
   <circle cx="18" cy="19" r="3" />
   <path d="M8.6 10.7 15.4 6.3" />
   <path d="M8.6 13.3 15.4 17.7" />
  </svg>
 )
}

function BetaShareTurnButton(props: {
 messageElementId: string
 className?: string
 fallbackUserText?: string
 fallbackText?: string
}) {
 const ctx = useOptionalHappyChatContext()
 const { t } = useTranslation()
 const onShareTurn = ctx?.onShareTurn
 if (!onShareTurn) return null
 const userText = props.fallbackUserText?.trim() ?? ''
 const copyText = props.fallbackText?.trim() ?? ''

 return (
  <button
   type="button"
   data-hapi-share-action="true"
   title={t('message.shareTurn')}
   aria-label={t('message.shareTurn')}
   className={props.className ?? 'rounded-md p-0.5 opacity-60 transition-[opacity,background-color] hover:bg-[var(--app-subtle-bg)]'}
   onClick={(event) => {
    event.stopPropagation()
    const messageElement = event.currentTarget.closest('[data-hapi-message-role]')
    onShareTurn(
     messageElement instanceof HTMLElement && messageElement.id ? messageElement : props.messageElementId,
     event.clientY,
     userText.length > 0
      ? { html: '', text: userText, role: 'user' }
      : copyText.length > 0
       ? { html: '', text: copyText, role: 'assistant' }
       : undefined
    )
   }}
  >
   <ShareIcon className="h-3.5 w-3.5 text-[var(--app-hint)]" />
  </button>
 )
}

function BetaTimestamp(props: { createdAt: number; className?: string }) {
 const date = new Date(props.createdAt)
 return (
  <time
   dateTime={date.toISOString()}
   title={formatMessageTimestampTitle(date)}
   className={cn('tabular-nums', props.className)}
  >
   {formatMessageTimestamp(date)}
  </time>
 )
}

function DesktopTimestamp(props: { createdAt?: number }) {
 if (props.createdAt === undefined) return null
 return (
  <span className="inline-flex ml-1 items-center">
   <BetaTimestamp createdAt={props.createdAt} className="text-[10px] leading-none text-[var(--app-hint)]" />
  </span>
 )
}

function MessageInfoPopover({ metadata }: { metadata: Omit<MessageMetadataProps, 'className'> }) {
 const { t } = useTranslation()
 return (
  <Popover.Root>
   <Popover.Trigger asChild>
    <button
     type="button"
     title={t('message.info')}
     aria-label={t('message.info')}
     className="flex h-5 w-5 items-center justify-center rounded text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
    >
     <InfoIcon className="h-3.5 w-3.5" />
    </button>
   </Popover.Trigger>
   <Popover.Portal>
    <Popover.Content
     side="bottom"
     align="start"
     sideOffset={6}
     collisionPadding={8}
     className="z-50 rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 shadow-lg"
    >
     <MessageMetadata {...metadata} />
    </Popover.Content>
   </Popover.Portal>
  </Popover.Root>
 )
}

export function BetaMessageActions({
 align,
 copyText,
 metadata,
 createdAt,
 messageElementId,
 hideShare = false,
 fallbackUserText,
 showFork = false,
 showRewind = false,
 historyActionPending = false,
 threadIsRunning = false,
 onFork,
 onRewind
}: BetaMessageActionsProps) {
 const { copied, copy } = useCopyToClipboard()
 const { t } = useTranslation()
 const canCopy = Boolean(copyText)
 const hasMetadata = metadata ? buildMessageMetadataLabels(metadata).length > 0 : false
 const [forkOpen, setForkOpen] = useState(false)
 const [rewindOpen, setRewindOpen] = useState(false)
 const [forkPending, setForkPending] = useState(false)
 const [rewindPending, setRewindPending] = useState(false)
 const actionsLocked = historyActionPending || forkPending || rewindPending || threadIsRunning

 const shareButton = messageElementId && !hideShare ? (
  <BetaShareTurnButton
   messageElementId={messageElementId}
   fallbackUserText={fallbackUserText}
   fallbackText={copyText}
   className="flex h-5 w-5 items-center justify-center rounded text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
  />
 ) : null

 const historyButtons = (
  <>
   {showFork && onFork ? (
    <button
     type="button"
     title={t('message.fork')}
     aria-label={t('message.fork')}
     disabled={actionsLocked}
     className="flex h-5 w-5 items-center justify-center rounded text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] disabled:opacity-40"
     onClick={() => setForkOpen(true)}
    >
     <ForkIcon className="h-3.5 w-3.5" />
    </button>
   ) : null}
   {showRewind && onRewind ? (
    <button
     type="button"
     title={t('message.rewind')}
     aria-label={t('message.rewind')}
     disabled={actionsLocked}
     className="flex h-5 w-5 items-center justify-center rounded text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] disabled:opacity-40"
     onClick={() => setRewindOpen(true)}
    >
     <RewindIcon className="h-3.5 w-3.5" />
    </button>
   ) : null}
  </>
 )

 return (
  <>
   <div
    className={cn(
     'happy-message-actions mt-1 flex h-5 items-center gap-1',
     align === 'end' ? 'justify-end' : 'justify-start'
    )}
   >
    {align === 'end' ? <DesktopTimestamp createdAt={createdAt} /> : null}
    {align === 'end' && hasMetadata && metadata ? <MessageInfoPopover metadata={metadata} /> : null}
    {align === 'end' ? shareButton : null}
    {canCopy ? (
     <button
      type="button"
      title={copied ? t('message.copied') : t('message.copy')}
      aria-label={copied ? t('message.copied') : t('message.copy')}
      className="flex h-5 w-5 items-center justify-center rounded text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
      onClick={() => copy(copyText!)}
     >
      {copied ? <CheckIcon className="h-3.5 w-3.5 text-green-500" /> : <CopyIcon className="h-3.5 w-3.5" />}
     </button>
    ) : null}
    {historyButtons}
    {align === 'start' ? shareButton : null}
    {align === 'start' && hasMetadata && metadata ? <MessageInfoPopover metadata={metadata} /> : null}
    {align === 'start' ? <DesktopTimestamp createdAt={createdAt} /> : null}
   </div>

   <ConfirmDialog
    isOpen={forkOpen}
    onClose={() => {
     if (!forkPending) setForkOpen(false)
    }}
    title={t('message.fork.confirmTitle')}
    description={t('message.fork.confirmDescription')}
    confirmLabel={t('message.fork')}
    confirmingLabel={t('message.fork.confirming')}
    isPending={forkPending}
    onConfirm={async () => {
     if (!onFork) return
     setForkPending(true)
     try {
      await onFork()
      setForkOpen(false)
     } finally {
      setForkPending(false)
     }
    }}
   />

   <ConfirmDialog
    isOpen={rewindOpen}
    onClose={() => {
     if (!rewindPending) setRewindOpen(false)
    }}
    title={t('message.rewind.confirmTitle')}
    description={t('message.rewind.confirmDescription')}
    confirmLabel={t('message.rewind')}
    confirmingLabel={t('message.rewind.confirming')}
    isPending={rewindPending}
    destructive
    onConfirm={async () => {
     if (!onRewind) return
     setRewindPending(true)
     try {
      await onRewind()
      setRewindOpen(false)
     } finally {
      setRewindPending(false)
     }
    }}
   />
  </>
 )
}
