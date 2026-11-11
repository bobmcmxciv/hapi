import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import type { HappyThreadProps } from '@/components/AssistantChat/HappyThread'
import { ConversationOutlinePanel, getPullToLoadState } from '@/components/AssistantChat/HappyThread'
import { HappyChatProvider, type HappyChatContextValue, type OlderHistoryLoadResult } from '@/components/AssistantChat/context'
import type { VisibleChatBlock } from '@/chat/toolGroups'
import type { ConversationOutlineItem } from '@/chat/outline'
import { ShareTurnDialog } from '@/components/AssistantChat/ShareTurnDialog'
import { useTerminalToolDisplayMode } from '@/hooks/useTerminalToolDisplayMode'
import { useTranslation } from '@/lib/use-translation'
import { aggregateResponseGroups } from '@/lib/assistant-runtime'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/Spinner'
import { BetaRow, BetaRowView, BetaBlockContent } from './BetaRow'
import { useRuntimeTimeline } from './useRuntimeTimeline'
import type { BetaRow as BetaRowData, BetaTimelineStore } from './store'
import { buildBetaShareHiddenIds, hasPendingRequest, isShareableUserRow, rowDomId, rowToVisibleBlock, selectShareTurnRows, runtimeRunTerminalLabel } from './betaTimelineView'
import { createVirtualRowHeights, selectVirtualIndices } from './betaVirtualizer'
import { useBetaShareMetadata } from './useBetaShareMetadata'
import { BetaTurnProcess, BetaTurnArtifact, BetaTurnTool, BetaLiveActivity } from './BetaTurnProcess'
import { currentRunState, generatedArtifacts, orphanPendingBlocks, partitionBetaTurns, presentBetaTurns } from './betaTurns'
import { BetaExpansionProvider } from './BetaExpansion'
import type { MessageTurnSegment } from '@hapi/protocol/messageTurns'
import { hydrateBetaShareRows, type BetaCompleteTurnLoader } from './betaTurnShare'
import './beta-timeline.css'

export type BetaThreadProps = HappyThreadProps & {
    historyBlocks: readonly VisibleChatBlock[]
    turnSegments?: readonly MessageTurnSegment[]
    loadCompleteTurn?: BetaCompleteTurnLoader
}
type Anchor = { id: string; offset: number }
type Snapshot = { html: string; text: string; role?: 'user' | 'assistant' }
type Share = { id: number; snapshots: Snapshot[]; width: number; title: string }
const ESTIMATED_HEIGHT = 160
const MAX_MOUNTED_ROWS = 100

export function BetaThread(props: BetaThreadProps) {
    const store = useRuntimeTimeline(props.api, props.sessionId, props.historyBlocks)
    return <BetaThreadView {...props} store={store} />
}

/** Exported for the offline fixture; production always enters through BetaThread. */
export function BetaThreadView(props: BetaThreadProps & { store: BetaTimelineStore }) {
    const { store } = props
    const { t } = useTranslation()
    const { terminalToolDisplayMode } = useTerminalToolDisplayMode()
    const rawRows = useSyncExternalStore(store.subscribeRows, store.getRows, store.getRows)
    const [expandedTurns, setExpandedTurns] = useState<ReadonlySet<string>>(() => new Set())
    const turns = useMemo(() => partitionBetaTurns(rawRows, store.getRow, props.turnSegments?.[0]?.turnId), [rawRows, props.historyBlocks, props.turnSegments, store])
    const orphanRequests = useMemo(() => orphanPendingBlocks(props.session.agentState, rawRows.map((ref) => store.getRow(ref.id)).filter((row): row is BetaRowData => Boolean(row))), [props.session.agentState, props.historyBlocks, rawRows, store])
    const turnsRef = useRef(turns)
    turnsRef.current = turns
    const rows = useMemo(() => presentBetaTurns(turns, expandedTurns), [turns, expandedTurns])
    const turnById = useMemo(() => new Map(turns.map((turn) => [turn.id, turn])), [turns])
    const segmentById = useMemo(() => new Map(turns.flatMap((turn) => turn.segments.map((seg) => [seg.id, seg]))), [turns])
    const processWindows = useMemo(() => {
        const windows = new Map<string, { start: number; end: number }>()
        for (const [position, row] of rows.entries()) {
            const segId = row.segmentId ?? row.turnId
            if (row.kind !== 'process' || !expandedTurns.has(segId)) continue
            const count = (segmentById.get(segId) ?? turnById.get(row.turnId))?.entities.length ?? 0
            if (count) windows.set(segId, { start: position, end: position + count + 1 })
        }
        return windows
    }, [rows, expandedTurns, segmentById, turnById])
    const [stickyTurnId, setStickyTurnId] = useState<string | null>(null)
    const status = useSyncExternalStore(store.subscribeStatus, store.getStatus, store.getStatus)
    const viewportRef = useRef<HTMLDivElement>(null)
    const messagesRef = useRef<HTMLDivElement>(null)
    const processFocusRef = useRef<string | null>(null)
    const index = useMemo(() => createVirtualRowHeights(ESTIMATED_HEIGHT), [store])
    const rowsRef = useRef(rows)
    const propsRef = useRef(props)
    propsRef.current = props
    const modeRef = useRef<'tail' | 'history'>('tail')
    const [atTail, setAtTail] = useState(true)
    const [range, setRange] = useState({ start: Math.max(0, rows.length - 12), end: rows.length })
    const [measurementVersion, setMeasurementVersion] = useState(0)
    const [loadError, setLoadError] = useState<string | null>(null)
    const [shareError, setShareError] = useState<string | null>(null)
    const [pull, setPull] = useState<'idle' | 'pulling' | 'ready'>('idle')
    const [share, setShare] = useState<Share | null>(null)
    const [shareLoading, setShareLoading] = useState(false)
    const shareInFlight = useRef(false)
    const shareAbort = useRef<AbortController | null>(null)
    const [capture, setCapture] = useState<{ id: number; rows: readonly BetaRowData[]; width: number; title: string } | null>(null)
    const shareMetadataItems = useBetaShareMetadata(props.api, props.session, props.serviceTier, share !== null)
    const captureRef = useRef<HTMLDivElement>(null)
    const shareId = useRef(0)
    const frameRef = useRef<number | null>(null)
    const observerRef = useRef<ResizeObserver | null>(null)
    const elements = useRef(new Map<string, HTMLElement>())
    const elementRefs = useRef(new Map<string, (node: HTMLDivElement | null) => void>())
    const anchorRef = useRef<Anchor | null>(null)
    const pendingLoad = useRef<Promise<OlderHistoryLoadResult> | null>(null)
    const pendingRestore = useRef<{ version: number; resolve: (result: OlderHistoryLoadResult) => void } | null>(null)
    const coverageArmed = useRef(true)
    const previousTop = useRef(0)
    const mounted = useRef(true)
    const interactionUntil = useRef(0)
    const pinnedId = useRef<string | null>(null)
    const selectionPins = useRef(new Set<string>())

    const writtenTop = useRef<number | null>(null)
    const navigationVersion = useRef(0)
    const setMode = useCallback((mode: 'tail' | 'history') => {
        if (modeRef.current === mode) return
        modeRef.current = mode
        setAtTail(mode === 'tail')
        propsRef.current.onViewModeChange(mode)
    }, [])
    const listTop = useCallback(() => messagesRef.current?.offsetTop ?? 0, [])
    const saveAnchor = useCallback(() => {
        const viewport = viewportRef.current
        if (!viewport) return
        const y = Math.max(0, viewport.scrollTop - listTop())
        const position = Math.min(rowsRef.current.length - 1, index.indexAtY(y))
        const row = rowsRef.current[position]
        anchorRef.current = row ? { id: row.id, offset: index.offsetOf(position) - y } : null
    }, [index, listTop])
    const restoreAnchor = useCallback(() => {
        const viewport = viewportRef.current
        const anchor = anchorRef.current
        if (!viewport || !anchor) return
        const position = rowsRef.current.findIndex((row) => row.id === anchor.id)
        if (position >= 0) {
            viewport.scrollTop = listTop() + index.offsetOf(position) - anchor.offset
            writtenTop.current = viewport.scrollTop
        }
    }, [index, listTop])
    const updateStickyTurn = useCallback(() => {
        const viewport = viewportRef.current
        if (!viewport) return
        const currentRows = rowsRef.current
        if (currentRows.length === 0) { setStickyTurnId(null); return }
        const y = Math.max(0, viewport.scrollTop - listTop())
        const topIndex = Math.min(currentRows.length - 1, index.indexAtY(y))
        const topRow = currentRows[topIndex]
        if (!topRow) { setStickyTurnId(null); return }
        const segId = topRow.segmentId ?? topRow.turnId
        const window = processWindows.get(segId)
        const passedHeader = window && y > index.offsetOf(window.start)
        const beforeResult = window && y < index.offsetOf(window.end)
        setStickyTurnId(passedHeader && beforeResult ? segId : null)
    }, [processWindows, index, listTop])
    const toggleTurnProcess = useCallback((turnId: string, fromSticky = false) => {
        const collapsing = expandedTurns.has(turnId)
        setMode('history')
        if (collapsing && fromSticky) {
            const processId = `process:${turnId}`
            anchorRef.current = { id: processId, offset: 0 }
            pinnedId.current = processId
            processFocusRef.current = processId
            setStickyTurnId(null)
        } else {
            saveAnchor()
        }
        setExpandedTurns((old) => { const next = new Set(old); if (next.has(turnId)) next.delete(turnId); else next.add(turnId); return next })
    }, [expandedTurns, saveAnchor, setMode])
    const calculateRange = useCallback(() => {
        const viewport = viewportRef.current
        if (!viewport) return
        const currentRows = rowsRef.current
        // Tail owns a destination window, not a journey through estimated
        // spacers. Mount that window before positioning it in the layout phase.
        const y = modeRef.current === 'tail'
            ? Math.max(0, index.totalHeight() - viewport.clientHeight)
            : Math.max(0, viewport.scrollTop - listTop())
        const overscan = Date.now() < interactionUntil.current ? viewport.clientHeight : viewport.clientHeight / 2
        const start = index.indexAtY(Math.max(0, y - overscan))
        let end = Math.min(currentRows.length, index.indexAtY(y + viewport.clientHeight + overscan) + 1)
        // A pathological stream of tiny rows is still a bounded DOM window.
        if (end - start > MAX_MOUNTED_ROWS) end = start + MAX_MOUNTED_ROWS
        // Do not expand a contiguous span across thousands of rows for a pin:
        // render individual pinned rows with their own intervening spacers.
        setRange((old) => old.start === start && old.end === end ? old : { start, end })
    }, [index, listTop])
    const scheduleRange = useCallback(() => {
        if (frameRef.current !== null) return
        frameRef.current = requestAnimationFrame(() => {
            frameRef.current = null
            calculateRange()
        })
    }, [calculateRange])
    const tail = useCallback(() => {
        navigationVersion.current += 1
        pinnedId.current = null
        anchorRef.current = null
        setMode('tail')
        calculateRange()
        // Even an already-mounted destination may need to catch footer growth.
        setMeasurementVersion((n) => n + 1)
    }, [setMode, calculateRange])

    // Re-index only on structural changes. Content-only runtime patches notify
    // their named BetaRow and its ResizeObserver, never this list subscription.
    useMemo(() => {
        rowsRef.current = rows
        index.setRowIds(rows.map((row) => row.id))
    }, [rows, index])

    const rowElementRef = useCallback((id: string) => {
        let callback = elementRefs.current.get(id)
        if (!callback) {
            callback = (node) => {
                const old = elements.current.get(id)
                if (old) observerRef.current?.unobserve(old)
                if (node) {
                    elements.current.set(id, node)
                    observerRef.current?.observe(node)
                } else {
                    elements.current.delete(id)
                }
            }
            elementRefs.current.set(id, callback)
        }
        return callback
    }, [])

    useLayoutEffect(() => {
        if (typeof ResizeObserver === 'undefined') return
        const observer = new ResizeObserver((entries) => {
            let changed = false
            for (const entry of entries) {
                const node = entry.target as HTMLElement
                if (node === viewportRef.current) { scheduleRange(); continue }
                const id = node.dataset.betaMeasureId
                // Measure the slot's full DOM footprint (beta-row-slot padding
                // supplies the gap). Geometry must equal DOM height exactly, or
                // mounted rows drift against spacer-sized unmounted regions on
                // every window-boundary change (12px per row observed).
                if (id) changed = index.setHeight(id, node.getBoundingClientRect().height) || changed
            }
            // Publish geometry first. Only the layout owner may scroll, after
            // React has committed spacers for these measurements.
            if (changed || entries.some((entry) => !entry.target.hasAttribute('data-beta-measure-id'))) {
                setMeasurementVersion((n) => n + 1)
            }
        })
        observerRef.current = observer
        for (const node of elements.current.values()) observer.observe(node)
        if (viewportRef.current) observer.observe(viewportRef.current)
        if (messagesRef.current?.parentElement) observer.observe(messagesRef.current.parentElement)
        return () => { observer.disconnect(); observerRef.current = null }
    }, [index, scheduleRange])

    useLayoutEffect(() => {
        // Measure the destination before paint; a ResizeObserver-only correction
        // would first expose an estimated spacer and then visibly snap backwards.
        let changed = false
        for (const [id, node] of elements.current) {
            changed = index.setHeight(id, node.getBoundingClientRect().height) || changed
        }
        if (changed) {
            calculateRange()
            setMeasurementVersion((n) => n + 1)
            return // commit the measured spacers before using scrollHeight
        }
        const viewport = viewportRef.current
        if (modeRef.current === 'tail') {
            if (viewport) {
                viewport.scrollTop = viewport.scrollHeight
                writtenTop.current = viewport.scrollTop
                previousTop.current = viewport.scrollTop
            }
        } else {
            restoreAnchor()
        }
        calculateRange()
        updateStickyTurn()
        const focusId = processFocusRef.current
        const focusTarget = focusId ? elements.current.get(focusId)?.querySelector('button') : null
        if (focusTarget) {
            focusTarget.focus({ preventScroll: true })
            processFocusRef.current = null
            pinnedId.current = null
        }
        const pending = pendingRestore.current
        if (pending && props.historyVersion >= pending.version) {
            pendingRestore.current = null
            pending.resolve('loaded')
        }
    }, [rows, range, props.historyVersion, measurementVersion, index, calculateRange, restoreAnchor, updateStickyTurn])

    useEffect(() => {
        // Structural cleanup is not part of the scrolling/measurement hot path.
        const ids = new Set(rows.map((row) => row.id))
        for (const id of elementRefs.current.keys()) if (!ids.has(id)) elementRefs.current.delete(id)
    }, [rows])

    const loadOlder = useCallback((): Promise<OlderHistoryLoadResult> => {
        if (pendingLoad.current) return pendingLoad.current
        const current = propsRef.current
        if (!current.hasMoreMessages) return Promise.resolve('terminal-stop')
        if (current.isSyncingTail || current.isLoadingMoreMessages) return Promise.resolve('transient-stop')
        setMode('history')
        saveAnchor()
        setLoadError(null)
        coverageArmed.current = false
        const promise = (async (): Promise<OlderHistoryLoadResult> => {
            try {
                const outcome = await current.onLoadMore(() => {
                    if (!mounted.current) return false
                    // Capture at apply, not request start: scrolling during a
                    // slow request must retain the user's *current* anchor.
                    if (modeRef.current === 'history') saveAnchor()
                    return true
                })
                if (!mounted.current) return 'transient-stop'
                if (outcome.kind === 'applied') {
                    if (propsRef.current.historyVersion >= outcome.historyVersion) {
                        setMeasurementVersion((n) => n + 1)
                        return 'loaded'
                    }
                    const completion = Promise.withResolvers<OlderHistoryLoadResult>()
                    pendingRestore.current = { version: outcome.historyVersion, resolve: completion.resolve }
                    return await completion.promise
                }
                if (outcome.kind === 'failed') {
                    setLoadError(outcome.error.message)
                    return 'transient-stop'
                }
                return outcome.reason === 'exhausted' || outcome.reason === 'unavailable' || outcome.reason === 'epoch-reset' ? 'terminal-stop' : 'transient-stop'
            } catch (error) {
                if (mounted.current) setLoadError(error instanceof Error ? error.message : t('beta.timeline.loadFailed'))
                return 'transient-stop'
            } finally {
                pendingLoad.current = null
            }
        })()
        pendingLoad.current = promise
        return promise
    }, [restoreAnchor, saveAnchor, scheduleRange, setMode, t])

    useEffect(() => {
        mounted.current = true
        return () => {
            mounted.current = false
            shareAbort.current?.abort()
            shareId.current += 1
            if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
            pendingRestore.current?.resolve('transient-stop')
            pendingRestore.current = null
            propsRef.current.onCancelLoadMore()
        }
    }, [])
    const force = useRef(props.forceScrollToken)
    useEffect(() => {
        if (force.current === props.forceScrollToken) return
        force.current = props.forceScrollToken
        tail()
    }, [props.forceScrollToken, tail])

    useEffect(() => {
        const viewport = viewportRef.current
        if (!viewport) return
        const cancelTail = () => {
            navigationVersion.current += 1
            pinnedId.current = null
            interactionUntil.current = Date.now() + 600
            writtenTop.current = null
            setMode('history')
            saveAnchor()
        }
        const pointer = (event: PointerEvent) => {
            if (event.button !== 0) return
            const rect = viewport.getBoundingClientRect()
            if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) return
            interactionUntil.current = Date.now() + 1000
            if (!(event.target instanceof HTMLElement) || !event.target.closest('button, a, input, textarea, select, summary')) cancelTail()
        }
        const scroll = () => {
            const top = viewport.scrollTop
            const distance = viewport.scrollHeight - top - viewport.clientHeight
            const up = top < previousTop.current - 1
            const programmatic = writtenTop.current !== null && Math.abs(top - writtenTop.current) <= 1
            writtenTop.current = null
            // Native scroll events from our own correction (or a shrinking
            // scrollHeight) never transfer ownership away from the tail.
            if (modeRef.current === 'history' && !programmatic) {
                if (distance <= 1) setMode('tail')
                saveAnchor()
            }
            previousTop.current = top
            scheduleRange()
            updateStickyTurn()
            if (top > 240) coverageArmed.current = true
            if (modeRef.current === 'history' && !programmatic && top <= 120 && up && coverageArmed.current) void loadOlder()
        }
        const wheel = (event: WheelEvent) => {
            if (event.deltaY !== 0) cancelTail()
            if (event.deltaY < 0) {
                if (viewport.scrollTop <= 120) { coverageArmed.current = true; void loadOlder() }
            }
        }
        const key = (event: KeyboardEvent) => {
            const target = event.target
            if (target instanceof HTMLElement && (target.isContentEditable || /INPUT|TEXTAREA|SELECT/.test(target.tagName))) return
            if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home'].includes(event.key)) cancelTail()
            if (event.key === 'End' && !event.shiftKey) { event.preventDefault(); tail() }
        }
        let touchStart: number | null = null
        const touchstart = (event: TouchEvent) => {
            interactionUntil.current = Date.now() + 1000
            cancelTail()
            touchStart = viewport.scrollTop <= 0 ? event.touches[0]?.clientY ?? null : null
        }
        const touchmove = (event: TouchEvent) => {
            cancelTail()
            if (touchStart !== null) setPull(getPullToLoadState((event.touches[0]?.clientY ?? touchStart) - touchStart))
        }
        const touchend = () => {
            setPull((state) => { if (state === 'ready') void loadOlder(); return 'idle' })
            touchStart = null
        }
        const selection = () => {
            const pins = new Set<string>()
            const selected = document.getSelection()
            if (selected && !selected.isCollapsed) {
                for (const [id, node] of elements.current) {
                    for (let i = 0; i < selected.rangeCount; i += 1) {
                        if (selected.getRangeAt(i).intersectsNode(node)) { pins.add(id); break }
                    }
                }
            }
            selectionPins.current = pins
            scheduleRange()
        }
        viewport.addEventListener('scroll', scroll, { passive: true })
        viewport.addEventListener('wheel', wheel, { passive: true })
        window.addEventListener('pointerdown', pointer, { capture: true, passive: true })
        viewport.addEventListener('keydown', key)
        viewport.addEventListener('touchstart', touchstart, { passive: true })
        viewport.addEventListener('touchmove', touchmove, { passive: true })
        viewport.addEventListener('touchend', touchend, { passive: true })
        viewport.addEventListener('touchcancel', touchend, { passive: true })
        viewport.addEventListener('focusin', scheduleRange)
        document.addEventListener('selectionchange', selection)
        window.addEventListener('resize', scheduleRange)
        return () => {
            viewport.removeEventListener('scroll', scroll)
            viewport.removeEventListener('wheel', wheel)
            window.removeEventListener('pointerdown', pointer, true)
            viewport.removeEventListener('keydown', key)
            viewport.removeEventListener('touchstart', touchstart)
            viewport.removeEventListener('touchmove', touchmove)
            viewport.removeEventListener('touchend', touchend)
            viewport.removeEventListener('touchcancel', touchend)
            viewport.removeEventListener('focusin', scheduleRange)
            document.removeEventListener('selectionchange', selection)
            window.removeEventListener('resize', scheduleRange)
        }
    }, [loadOlder, saveAnchor, scheduleRange, setMode, tail, updateStickyTurn])

    const scrollToRow = useCallback(async (rowId: string) => {
        const viewport = viewportRef.current
        if (!viewport) return
        const navigation = ++navigationVersion.current
        const ownerSeg = turnsRef.current.flatMap((turn) => turn.segments).find((seg) => seg.process.includes(rowId))
        const targetId = ownerSeg ? ownerSeg.rowId : rowId
        if (ownerSeg) setExpandedTurns((old) => new Set(old).add(ownerSeg.id))
        const position = rowsRef.current.findIndex((row) => row.id === targetId)
        if (position < 0) return
        setMode('history')
        pinnedId.current = targetId
        viewport.scrollTop = listTop() + index.offsetOf(position)
        saveAnchor()
        calculateRange()
        // The first position uses cached/estimated geometry; correct once the
        // real row mounts and is measured. No whole-list forced mounting.
        const ready = Promise.withResolvers<void>()
        requestAnimationFrame(() => requestAnimationFrame(() => ready.resolve()))
        await ready.promise
        if (!mounted.current || navigationVersion.current !== navigation) return
        let resolvedId = rowId
        if (ownerSeg) {
            const source = store.getRow(rowId)
            const criticalIndex = source?.kind === 'history' && source.block.kind === 'tool-group' ? source.block.tools.findIndex((tool) => hasPendingRequest(tool) || tool.tool.state === 'error') : -1
            const actualPosition = rowsRef.current.findIndex((row) => row.id === rowId || (row.sourceId === rowId && (criticalIndex < 0 || row.toolIndex === criticalIndex)))
            if (actualPosition >= 0) {
                resolvedId = rowsRef.current[actualPosition].id
                pinnedId.current = resolvedId
                viewport.scrollTop = listTop() + index.offsetOf(actualPosition)
                saveAnchor()
                calculateRange()
                const revealed = Promise.withResolvers<void>()
                requestAnimationFrame(() => requestAnimationFrame(() => revealed.resolve()))
                await revealed.promise
            }
        }
        if (!mounted.current || navigationVersion.current !== navigation) return
        const target = elements.current.get(resolvedId) ?? elements.current.get(targetId)
        if (target) {
            viewport.scrollTop += target.getBoundingClientRect().top - viewport.getBoundingClientRect().top
            target.querySelector<HTMLElement>('button, [data-beta-row-id]')?.focus({ preventScroll: true })
        }
        pinnedId.current = null
        saveAnchor()
        scheduleRange()
    }, [calculateRange, index, listTop, saveAnchor, scheduleRange, setMode, store])
    const outline = useCallback(async (item: ConversationOutlineItem) => {
        const domId = `hapi-message-${item.targetMessageId}`
        let target = store.getRows().find((ref) => { const row = store.getRow(ref.id); return row && rowDomId(row) === domId })
        while (!target && propsRef.current.hasMoreMessages) {
            if (await loadOlder() !== 'loaded') break
            target = store.getRows().find((ref) => { const row = store.getRow(ref.id); return row && rowDomId(row) === domId })
        }
        if (target) await scrollToRow(target.id)
        propsRef.current.onOutlineItemClick?.(item)
        propsRef.current.onOutlineOpenChange(false)
    }, [loadOlder, scrollToRow, store])

    const isRunning = status.run ? status.run.state === 'running' : props.session.thinking
    // These projections run only on durable history/order or run transitions;
    // token updates never change `rows` or subscribeStatus snapshots.
    const derived = useMemo(() => {
        const data = rawRows.map((ref) => store.getRow(ref.id)).filter((row): row is BetaRowData => Boolean(row))
        return { hidden: buildBetaShareHiddenIds(data, isRunning), aggregates: aggregateResponseGroups(data.map(rowToVisibleBlock)) }
    }, [rawRows, props.historyBlocks, isRunning, store])
    const shareTurn = useCallback(async (target: HTMLElement | string | null, _clientY?: number, fallback?: Snapshot) => {
        if (shareInFlight.current) return
        const all = store.getAllRows()
        const domId = typeof target === 'string' ? target : target?.closest<HTMLElement>('[data-hapi-message-role]')?.id
        const row = all.find((row) => rowDomId(row) === domId || (row.kind === 'history' && (generatedArtifacts(row.block).some((block) => rowDomId({ id: block.id, kind: 'history', block }) === domId) || (row.block.kind === 'tool-group' && row.block.tools.some((block) => rowDomId({ id: block.id, kind: 'history', block }) === domId)))))
        if (!row) {
            setShareError(t('beta.timeline.shareUnavailable'))
            return
        }
        let selected = selectShareTurnRows(all, row.id)
        const user = selected.find(isShareableUserRow)
        const turnId = user?.kind === 'history' ? user.block.id : propsRef.current.turnSegments?.[0]?.turnId
        const segment = propsRef.current.turnSegments?.find((entry) => entry.turnId === (turnId ?? null))
        if ((segment && (!segment.completeBefore || !segment.completeAfter)) || (!user && propsRef.current.hasMoreMessages) || selected.some((entry) => entry.kind === 'runtime' && entry.item.previewOmitted)) {
            const loader = propsRef.current.loadCompleteTurn
            if (!loader || !turnId) { setShareError(t('beta.timeline.shareIncomplete')); return }
            const requestId = ++shareId.current
            const sessionId = propsRef.current.sessionId
            const controller = new AbortController()
            shareAbort.current = controller
            shareInFlight.current = true
            setShareLoading(true)
            setShareError(null)
            try {
                const complete = await hydrateBetaShareRows(turnId, loader, controller.signal)
                if (!mounted.current || shareId.current !== requestId || propsRef.current.sessionId !== sessionId) return
                selected = complete
            } catch (error) {
                if (!controller.signal.aborted && mounted.current && shareId.current === requestId) setShareError(error instanceof Error ? t(error.message) : t('beta.timeline.shareUnavailable'))
                return
            } finally {
                if (shareAbort.current === controller) shareAbort.current = null
                shareInFlight.current = false
                if (mounted.current) setShareLoading(false)
            }
        }
        if (selected.length === 0 && fallback) {
            setShare({ id: ++shareId.current, snapshots: [fallback], width: messagesRef.current?.clientWidth ?? 640, title: propsRef.current.sessionId })
            return
        }
        setShareError(null)
        setCapture({ id: ++shareId.current, rows: selected, width: messagesRef.current?.clientWidth ?? 640, title: propsRef.current.metadata?.summary?.text ?? propsRef.current.metadata?.name ?? propsRef.current.sessionId.slice(0, 8) })
    }, [store, t])
    useEffect(() => {
        if (!capture) return
        let cancelled = false
        let timer: number
        const started = Date.now()
        let previous = ''
        let stableSince = Date.now()
        const collect = () => {
            if (cancelled) return
            const node = captureRef.current
            if (!node) { timer = window.setTimeout(collect, 50); return }
            const fingerprint = node.innerHTML
            if (fingerprint !== previous) { previous = fingerprint; stableSince = Date.now() }
            const images = Array.from(node.querySelectorAll('img'))
            const loadingMedia = node.querySelector('[aria-busy="true"], .animate-pulse')
            if ((loadingMedia || images.some((image) => !image.complete) || Date.now() - stableSince < 250) && Date.now() - started < 10000) {
                timer = window.setTimeout(collect, 100)
                return
            }
            if (loadingMedia || images.some((image) => !image.complete)) {
                setShareError(t('beta.timeline.shareMediaLoading'))
                setCapture(null)
                return
            }
            const snapshots: Snapshot[] = Array.from(node.children).map((wrapper) => wrapper.firstElementChild).filter((element): element is HTMLElement => element instanceof HTMLElement).map((element) => ({ html: element.outerHTML, text: (element.innerText || element.textContent || '').trim(), role: element.dataset.hapiMessageRole === 'user' ? 'user' : 'assistant' }))
            setShare({ id: capture.id, snapshots, width: capture.width, title: capture.title })
            setCapture(null)
        }
        timer = window.setTimeout(collect, 100)
        return () => { cancelled = true; clearTimeout(timer) }
    }, [capture, t])

    const context = useMemo<HappyChatContextValue>(() => ({
        api: props.api, sessionId: props.sessionId, metadata: props.metadata, terminalToolDisplayMode,
        disabled: props.disabled, onRefresh: props.onRefresh, onRetryMessage: props.onRetryMessage,
        historyActionPending: props.historyActionPending, onForkConversation: props.onForkConversation,
        onRewindConversation: props.onRewindConversation, isLatestCompletedBoundary: props.isLatestCompletedBoundary,
        onShareTurn: shareTurn, hasMoreMessages: props.hasMoreMessages, isSyncingTail: props.isSyncingTail,
        isLoadingMoreMessages: props.isLoadingMoreMessages, loadOlderMessagesPreservingScroll: loadOlder
    }), [props.api, props.sessionId, props.metadata, terminalToolDisplayMode, props.disabled, props.onRefresh, props.onRetryMessage, props.historyActionPending, props.onForkConversation, props.onRewindConversation, props.isLatestCompletedBoundary, shareTurn, props.hasMoreMessages, props.isSyncingTail, props.isLoadingMoreMessages, loadOlder])

    // Mount a real window plus disjoint interaction pins; intervening rows are
    // spacers, not hidden DOM. Selection/focus pins never expand the whole span.
    const focusId = typeof document !== 'undefined' ? document.activeElement?.closest<HTMLElement>('[data-beta-measure-id]')?.dataset.betaMeasureId : undefined
    const pins = new Set(selectionPins.current)
    if (focusId) pins.add(focusId)
    if (pinnedId.current) pins.add(pinnedId.current)
    const pinIndices = Array.from(pins, (id) => rows.findIndex((row) => row.id === id))
    const ordered = selectVirtualIndices(range, rows.length, pinIndices, MAX_MOUNTED_ROWS)
    const nodes = []
    let cursor = 0
    for (const position of ordered) {
        const ref = rows[position]
        const gap = index.offsetOf(position) - index.offsetOf(cursor)
        if (gap > 0) nodes.push(<div key={`spacer:${cursor}`} aria-hidden="true" data-beta-spacer="true" style={{ height: gap }} />)
        const turn = turnById.get(ref.turnId)!
        const seg = (ref.segmentId ? segmentById.get(ref.segmentId) : undefined) ?? turn.segments[0]
        const row = store.getRow(ref.id)
        const aggregate = row ? derived.aggregates.get(row.kind === 'history' ? row.block.id : `runtime:${row.item.id}`) : undefined
        const segId = seg?.id ?? turn.id
        const segProcess = seg?.process ?? turn.process
        const segCount = seg?.entities.length ?? turn.entities.length
        if (ref.kind === 'process') nodes.push(<BetaTurnProcess key={ref.id} store={store} id={ref.id} ids={segProcess} count={segCount} expanded={expandedTurns.has(segId)} onToggle={() => toggleTurnProcess(segId, false)} measureRef={rowElementRef(ref.id)} />)
        else if (ref.kind === 'tool') nodes.push(<BetaTurnTool key={ref.id} store={store} id={ref.id} sourceId={ref.sourceId!} toolIndex={ref.toolIndex} measureRef={rowElementRef(ref.id)} hideShare={derived.hidden.has(ref.sourceId!)} isRunning={isRunning} />)
        else if (ref.kind === 'artifact') nodes.push(<BetaTurnArtifact key={ref.id} store={store} id={ref.id} sourceId={ref.sourceId!} blockId={ref.blockId!} measureRef={rowElementRef(ref.id)} hideShare={derived.hidden.has(ref.sourceId!)} isRunning={isRunning} />)
        else nodes.push(<BetaRow key={ref.id} store={store} id={ref.id} isRunning={isRunning} hideShare={derived.hidden.has(ref.id)} metadata={aggregate} measureRef={rowElementRef(ref.id)} />)
        cursor = position + 1
    }
    const bottomGap = index.totalHeight() - index.offsetOf(cursor)
    if (bottomGap > 0) nodes.push(<div key="spacer:bottom" aria-hidden="true" data-beta-spacer="true" style={{ height: bottomGap }} />)
    void measurementVersion
    const requests = Object.entries(props.session.agentState?.requests ?? {})
    const runLabel = runtimeRunTerminalLabel(status.run)
    const statusText = t(`beta.timeline.connection.${status.connection}`)
    const runState = currentRunState(status, props.session, requests.length > 0)
    const bannerState = runState === 'error' ? (props.session.active ? 'idle' : 'offline') : runState
    const stickySeg = stickyTurnId ? segmentById.get(stickyTurnId) : undefined
    const lastRawId = rawRows[rawRows.length - 1]?.id

    return <HappyChatProvider value={context}><BetaExpansionProvider>
        <div className="beta-thread relative flex min-h-0 flex-1 flex-col" data-beta-connection={status.connection}>
            <div className="beta-connection-banner" role="status" aria-live="polite">{t(`beta.timeline.state.${bannerState}`)} · {props.isSyncingTail ? `${t('beta.timeline.catchingUp')} · ` : ''}{statusText}</div>
            {requests.length > 0 ? <button type="button" className="beta-attention" onClick={() => {
                const requestIds = new Set(requests.map(([id]) => id))
                const pending = store.getRows().find((ref) => {
                    const row = store.getRow(ref.id)
                    return row?.kind === 'history' && hasPendingRequest(row.block, requestIds)
                })
                if (pending) void scrollToRow(pending.id)
                else document.getElementById('beta-orphan-requests')?.focus({ preventScroll: false })
            }}>{t('beta.timeline.pending', { n: requests.length })}</button> : null}
            {orphanRequests.length ? <div id="beta-orphan-requests" tabIndex={-1} className="beta-orphan-requests" aria-label={t('beta.timeline.requests')}>
                {orphanRequests.map((block) => <BetaBlockContent key={block.id} block={block} />)}
            </div> : null}
            {(loadError || shareError) ? <div role="alert" className="p-2 text-xs text-red-500">{loadError || shareError}</div> : null}
            {capture || shareLoading ? <div role="status" className="p-1 text-center text-xs text-[var(--app-hint)]">{t('beta.timeline.preparingShare')}</div> : null}
            <div ref={viewportRef} className="app-scroll-y chat-scroll-y beta-viewport min-h-0 flex-1 overflow-x-hidden" tabIndex={0} aria-label={t('beta.timeline.conversation')}>
                <div className="sticky top-0 z-20 h-0">
                    {stickySeg ? <div className="mx-auto w-full max-w-content px-3 max-[480px]:px-2"><BetaTurnProcess store={store} id={stickySeg.rowId} ids={stickySeg.process} count={stickySeg.entities.length} expanded onToggle={() => toggleTurnProcess(stickySeg.id, true)} sticky /></div> : null}
                </div>
                <div className="chat-scroll-content relative mx-auto w-full max-w-content min-w-0 p-3">
                    {props.messagesWarning ? <div className="mb-3 rounded-md bg-amber-500/10 p-2 text-xs">{props.messagesWarning}</div> : null}
                    {props.hasMoreMessages ? <div className="mb-2 flex justify-center"><Button variant="outline" size="sm" onClick={() => void loadOlder()} disabled={props.isLoadingMoreMessages || props.isSyncingTail} aria-busy={props.isLoadingMoreMessages}>{props.isLoadingMoreMessages ? <Spinner size="sm" label={null} /> : '↑'} {t('session.outline.loadOlder')}</Button></div> : null}
                    {pull !== 'idle' ? <div className="p-1 text-center text-xs" role="status">{pull === 'ready' ? t('misc.releaseToLoadOlder') : t('misc.pullToLoadOlder')}</div> : null}
                    {props.turnSegments?.some((segment) => !segment.completeBefore || !segment.completeAfter) ? <div className="beta-continuation" role="status">{t('beta.timeline.continuation')}</div> : null}
                    <div ref={messagesRef} className="happy-thread-messages relative" data-beta-total-rows={rows.length} data-beta-mounted-rows={ordered.length}>{nodes}</div>
                    {rows.length === 0 && !props.isSyncingTail ? <div className="p-6 text-center text-sm text-[var(--app-hint)]">{t('beta.timeline.empty')}</div> : null}
                    {isRunning ? <div data-beta-run-status="true" className="flex items-center gap-2 py-2 text-xs text-[var(--app-hint)]" role="status"><Spinner size="sm" label={null} /><span>{t(`beta.timeline.state.${runState}`)}</span>{lastRawId ? <BetaLiveActivity store={store} id={lastRawId} /> : null}</div> : runLabel ? <div data-beta-run-status="true" className="py-2 text-xs text-[var(--app-hint)]" role="status">{t(runLabel)}</div> : null}
                </div>
            </div>
            {!atTail ? <button className="beta-jump-tail" type="button" onClick={tail}>{props.unseenCount > 0 ? t('misc.newMessage', { n: props.unseenCount }) : t('beta.timeline.latest')} ↓</button> : null}
            {props.outlineOpen ? <>
                <button type="button" className="absolute inset-0 z-20 bg-black/20" aria-label={t('session.outline.close')} onClick={() => props.onOutlineOpenChange(false)} />
                <ConversationOutlinePanel items={props.outlineItems} hasMoreMessages={props.hasMoreMessages} isLoadingMoreMessages={props.isLoadingMoreMessages} onLoadMore={() => void loadOlder()} onSelect={(item) => void outline(item)} onClose={() => props.onOutlineOpenChange(false)} />
            </> : null}
            {capture ? createPortal(<div className="beta-share-capture" style={{ width: capture.width }} aria-hidden="true" inert><div ref={captureRef}>{capture.rows.map((row) => <div key={row.id} className="beta-share-capture-row"><BetaRowView row={row} capture /></div>)}</div></div>, document.body) : null}
            <ShareTurnDialog key={share?.id ?? 'closed'} isOpen={share !== null} title={share?.title ?? ''} metadataItems={shareMetadataItems} sourceSnapshots={share?.snapshots ?? []} sourceContentWidth={share?.width ?? null} onClose={() => setShare(null)} />
        </div>
    </BetaExpansionProvider></HappyChatProvider>
}
