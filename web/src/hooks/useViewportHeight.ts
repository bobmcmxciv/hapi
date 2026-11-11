import { useEffect, useSyncExternalStore } from 'react'
import { isTelegramApp } from '@/hooks/useTelegram'
import { BETA_TIMELINE_ENABLED } from '@/fork-features/beta-timeline/enabled'

/**
 * Sets a CSS custom property `--app-viewport-height` on <html> that tracks the
 * visual viewport height. This is a fallback for browsers that do not support
 * the `interactive-widget=resizes-content` viewport meta attribute — on those
 * browsers `100dvh` does NOT shrink when the virtual keyboard opens, so the
 * composer input is hidden behind the keyboard.
 *
 * The hook listens to `window.visualViewport.resize` and writes the viewport
 * height into the CSS variable. The CSS height chain is:
 *   var(--tg-viewport-stable-height, var(--app-viewport-height, 100dvh))
 *
 * Skipped in Telegram Mini Apps (Telegram SDK provides its own height variable).
 *
 * It is also the SINGLE source of truth for "the on-screen keyboard is open":
 * every resize/rotation/focus signal feeds `detectVirtualKeyboardOpen`. The
 * result is published — on the Beta channel ONLY — as the `app-kbd-open`
 * class on <html> (so pure-CSS collapses like .collapsible-panel keep
 * working in tests without React re-mounts) and through
 * `useVirtualKeyboardOpen` for component-level compaction. The keyboard
 * compact layout is a Beta refactor; the classic channel keeps the
 * viewport-height fix but never enters compact mode. Never compute keyboard
 * state per component.
 */

/** Class toggled on <html> while the virtual keyboard compact mode is active. */
export const VIRTUAL_KEYBOARD_CLASS = 'app-kbd-open'

/** Vertical shrink that clearly cannot be the address bar or rounding. */
const KEYBOARD_MIN_LOSS_PX = 120
/** Same, expressed as a fraction of the keyboard-closed baseline height. */
const KEYBOARD_MIN_LOSS_RATIO = 0.18
/**
 * Grace after an editable element loses focus. Mobile pickers inside the
 * composer (attach, schedule, model) shift focus for a moment while the
 * keyboard is still up; without this the compact layout flickers open/closed.
 */
const FOCUS_BLUR_GRACE_MS = 2500
/** Same-order focus shift between two editables must not drop the flag. */
const FOCUS_SWAP_GRACE_MS = 120

interface VirtualKeyboardState {
 open: boolean
 /** Largest available height seen while the keyboard was (probably) closed. */
 baselineHeight: number
 /** Width at which the baseline was captured; a change means rotation. */
 baselineWidth: number
 /** Timestamp of the last focusin on an editable element. */
 lastEditableAt: number
 /** Timestamp of the last blur of an editable element. */
 lastBlurAt: number
}

/** Input types that never summon the software keyboard. */
const NON_TEXT_INPUT_TYPES: Record<string, true> = {
 button: true, checkbox: true, color: true, file: true, hidden: true, image: true,
 radio: true, range: true, reset: true, submit: true,
}

/**
 * True when focusing this element opens the on-screen keyboard: text inputs,
 * textareas and contenteditable surfaces (the composer is a
 * contenteditable="plaintext-only" div with role="textbox").
 */
export function isKeyboardEditableElement(element: Element | null): boolean {
 if (!element) return false
 if (element instanceof HTMLTextAreaElement) {
  return !element.disabled && !element.readOnly
 }
 if (element instanceof HTMLInputElement) {
  if (element.disabled || element.readOnly) return false
  return !NON_TEXT_INPUT_TYPES[element.type]
 }
 if (element instanceof HTMLSelectElement) {
  // Selects trigger a picker that also eats viewport height.
  return !element.disabled
 }
 if (element instanceof HTMLElement) {
  // isContentEditable first; fall back to the attribute so jsdom-style DOMs
  // (which expose contentEditable but not isContentEditable) still match.
  return Boolean(element.isContentEditable) || element.contentEditable === 'true' || element.contentEditable === 'plaintext-only'
 }
 return false
}

/** Narrow-screen or touch-first device — the only places a soft keyboard can exist. */
function isCompactEligibleDevice(): boolean {
 if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
 return (
  window.matchMedia('(pointer: coarse)').matches ||
  (window.matchMedia('(max-width: 919px)').matches && window.matchMedia('(hover: none)').matches)
 )
}

function visualViewportScale(): number {
 const scale = window.visualViewport?.scale
 return typeof scale === 'number' && scale > 0 ? scale : 1
}

/**
 * Height actually available to the layout. iOS overlays the keyboard (only
 * visualViewport shrinks); Android `resizes-content` shrinks the layout
 * viewport (innerHeight) and usually visualViewport too. `min` covers all
 * three models — do NOT gate detection on innerHeight alone.
 */
function availableViewportHeight(): number {
 const visual = window.visualViewport?.height ?? Number.POSITIVE_INFINITY
 return Math.min(window.innerHeight, visual)
}

function screenPortraitFallbackHeight(viewportWidth: number): number {
 if (typeof window === 'undefined' || !window.screen) return 0
 const screenH = Math.max(window.screen.availHeight || 0, window.screen.height || 0)
 // Only apply when the screen is clearly taller than the current narrow portrait viewport.
 if (viewportWidth > 0 && screenH >= viewportWidth * 1.3 && screenH <= 1400) {
  return Math.round(screenH * 0.88)
 }
 return 0
}

/**
 * Pure keyboard-state machine, exported for unit tests.
 *
 * `open` requires ALL of:
 *  - a compact-eligible device (never fires for desktop window resizes),
 *  - an editable currently focused OR one blurred < FOCUS_BLUR_GRACE_MS ago
 *    (so pinch-zoom/address-bar shrink alone never toggles compact mode),
 *  - a height loss that is clearly the keyboard, not the address bar,
 *  - visualViewport.scale ≈ 1 (pinch-zoom shrink is not the keyboard).
 *
 * Once open it stays open while the significant loss persists, even if focus
 * momentarily leaves the composer (toolbar taps, pickers). It closes when the
 * height is restored (keyboard dismissed), on rotation (baseline reset), or
 * when focus has been away longer than the grace period AND the loss is gone.
 */
export function updateVirtualKeyboardState(
 state: VirtualKeyboardState,
 now: number,
 viewportWidth: number,
): VirtualKeyboardState {
 const eligible = isCompactEligibleDevice()
 const available = Math.max(0, availableViewportHeight())

 // Rotation / form-factor change: baseline for the old geometry is invalid.
 // Reset both baseline and the open flag so a keyboard-era baseline never
 // leaves compact mode stuck in the new orientation.
 if (state.baselineWidth !== 0 && viewportWidth !== state.baselineWidth) {
  state = {
   ...state,
   open: false,
   baselineHeight: 0,
   baselineWidth: viewportWidth,
  }
 }
 if (state.baselineWidth === 0) {
  state = { ...state, baselineWidth: viewportWidth }
 }

 const editableNow = isKeyboardEditableElement(document.activeElement)
 if (editableNow) {
  state = { ...state, lastEditableAt: now }
 }

 // Grow the baseline only while an editable is NOT focused and the keyboard
 // is not open — Android WebViews often shrink innerHeight BEFORE firing
 // resize, or mount the page while the keyboard is already up.
 if (!state.open && !editableNow && available > state.baselineHeight) {
  state = { ...state, baselineHeight: available }
 }
 if (state.baselineHeight === 0) {
  state = {
   ...state,
   baselineHeight: Math.max(available, screenPortraitFallbackHeight(viewportWidth)),
  }
 }

 const effectiveBaseline = Math.max(state.baselineHeight, screenPortraitFallbackHeight(viewportWidth))
 const loss = effectiveBaseline - available
 const significantLoss =
  loss >= KEYBOARD_MIN_LOSS_PX && loss >= effectiveBaseline * KEYBOARD_MIN_LOSS_RATIO
 const constrainedMobileViewport = viewportWidth <= 640 && available > 0 && available <= 560
 const notZoomed = Math.abs(visualViewportScale() - 1) < 0.05
 const editableRecent =
  editableNow ||
  (state.lastEditableAt > 0 && now - state.lastEditableAt < FOCUS_BLUR_GRACE_MS) ||
  (state.lastBlurAt > 0 && now - state.lastBlurAt < FOCUS_SWAP_GRACE_MS)

 const open =
  eligible &&
  notZoomed &&
  (significantLoss || constrainedMobileViewport) &&
  (state.open ? true : editableRecent)
 if (open !== state.open) {
  state = { ...state, open }
 }
 return state
}

export function initialVirtualKeyboardState(): VirtualKeyboardState {
 return {
  open: false,
  baselineHeight: 0,
  baselineWidth: 0,
  lastEditableAt: 0,
  lastBlurAt: 0,
 }
}

/* ---- module-level published state (single shared source) ---- */

let keyboardOpen = false
const keyboardListeners = new Set<() => void>()

function publishKeyboardOpen(next: boolean): void {
 if (next === keyboardOpen) return
 keyboardOpen = next
 for (const listener of keyboardListeners) listener()
}

function subscribeKeyboardOpen(listener: () => void): () => void {
 keyboardListeners.add(listener)
 return () => keyboardListeners.delete(listener)
}

function getKeyboardOpen(): boolean {
 return keyboardOpen
}

/**
 * React binding for the shared virtual-keyboard flag. Always false outside
 * the Beta channel — publication is gated on BETA_TIMELINE_ENABLED inside
 * useViewportHeight. True on compact-eligible devices while an editable is
 * focused and the viewport lost keyboard-sized height. Use it for temporary
 * presentation changes ONLY — never for state that outlives the keyboard
 * (drafts, prefs, queues).
 */
export function useVirtualKeyboardOpen(): boolean {
 return useSyncExternalStore(subscribeKeyboardOpen, getKeyboardOpen, () => false)
}

export function useViewportHeight(): void {
 useEffect(() => {
  // Telegram Mini App has its own viewport management via --tg-viewport-stable-height
  if (isTelegramApp()) return

  const viewport = window.visualViewport
  const root = document.documentElement
  let keyboardState = initialVirtualKeyboardState()
  let blurReevalTimer: number | null = null

  function clearBlurTimer() {
   if (blurReevalTimer !== null) {
    window.clearTimeout(blurReevalTimer)
    blurReevalTimer = null
   }
  }
  function update() {
   // Only apply when the visual viewport is meaningfully smaller than
   // the window (keyboard is open). A small threshold (1px) avoids
   // false positives from sub-pixel rounding.
   if (viewport) {
    const diff = window.innerHeight - viewport.height
    if (diff > 1) {
     root.style.setProperty('--app-viewport-height', `${viewport.height}px`)
     // On iOS PWA (black-translucent status bar + viewport-fit=cover),
     // the browser scrolls the page upward when the keyboard opens to
     // keep the focused input visible. This pushes the header behind
     // the iOS status bar. Reset the page scroll so the app stays
     // pinned to the top — the inner flex layout already handles
     // keeping the composer visible.
     if (window.scrollY > 0) {
      window.scrollTo(0, 0)
     }
    } else {
     root.style.removeProperty('--app-viewport-height')
    }
   } else {
    root.style.removeProperty('--app-viewport-height')
   }

   keyboardState = updateVirtualKeyboardState(
    keyboardState,
    Date.now(),
    window.innerWidth,
   )
   // Channel gate: `app-kbd-open` compact mode is Beta-only. The classic
   // channel still gets the --app-viewport-height fix above but never
   // publishes keyboard-compact state.
   if (BETA_TIMELINE_ENABLED) {
    root.classList.toggle(VIRTUAL_KEYBOARD_CLASS, keyboardState.open)
    publishKeyboardOpen(keyboardState.open)
   }
  }

  function onFocusIn(event: FocusEvent) {
   clearBlurTimer()
   if (isKeyboardEditableElement(event.target as Element | null)) {
    keyboardState = { ...keyboardState, lastEditableAt: Date.now() }
   }
   update()
  }

  function onFocusOut(event: FocusEvent) {
   if (isKeyboardEditableElement(event.target as Element | null)) {
    keyboardState = { ...keyboardState, lastBlurAt: Date.now() }
    clearBlurTimer()
    blurReevalTimer = window.setTimeout(update, FOCUS_BLUR_GRACE_MS + 50)
   }
   update()
  }

  update()

  viewport?.addEventListener('resize', update)
  viewport?.addEventListener('scroll', update)
  // Recovery path: Android (esp. installed PWA) can drop the final
  // visualViewport resize when the keyboard dismisses while the page is
  // losing focus or being backgrounded. The stale --app-viewport-height
  // then pins <html>/<body> to the keyboard-era height: the app squeezes
  // into the top of the screen with dead space (and a second scrollbar)
  // below the composer until a reload. Re-validate whenever the window
  // geometry changes or the app returns to the foreground.
  window.addEventListener('resize', update)
  window.addEventListener('orientationchange', update)
  window.addEventListener('focus', update)
  window.addEventListener('pageshow', update)
  document.addEventListener('visibilitychange', update)
  document.addEventListener('focusin', onFocusIn, true)
  document.addEventListener('focusout', onFocusOut, true)

  return () => {
   clearBlurTimer()
   viewport?.removeEventListener('resize', update)
   viewport?.removeEventListener('scroll', update)
   window.removeEventListener('resize', update)
   window.removeEventListener('orientationchange', update)
   window.removeEventListener('focus', update)
   window.removeEventListener('pageshow', update)
   document.removeEventListener('visibilitychange', update)
   document.removeEventListener('focusin', onFocusIn, true)
   document.removeEventListener('focusout', onFocusOut, true)
   root.style.removeProperty('--app-viewport-height')
   root.classList.remove(VIRTUAL_KEYBOARD_CLASS)
   keyboardState = initialVirtualKeyboardState()
   publishKeyboardOpen(false)
  }
 }, [])
}
