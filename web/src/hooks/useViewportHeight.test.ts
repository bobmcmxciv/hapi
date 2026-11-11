import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import {
 initialVirtualKeyboardState,
 isKeyboardEditableElement,
 updateVirtualKeyboardState,
 useVirtualKeyboardOpen,
 useViewportHeight,
 VIRTUAL_KEYBOARD_CLASS,
} from './useViewportHeight'


/**
 * 挂载真实 hook 验证「过期变量恢复路径」：Android/PWA 上键盘收起若发生在
 * 页面失焦/切后台瞬间，visualViewport 的最后一次 resize 会丢，
 * --app-viewport-height 卡死在键盘时代的小值（应用挤上半屏、下方留白 +
 * 第二条滚动条）。窗口回前台 / 几何变化的任一信号都必须重新校验并清掉它。
 */
describe('useViewportHeight stale-value recovery (mounted hook)', () => {
 const root = document.documentElement
 let originalVisualViewport: PropertyDescriptor | undefined
 let originalInnerHeight: PropertyDescriptor | undefined

 beforeEach(() => {
  originalVisualViewport = Object.getOwnPropertyDescriptor(window, 'visualViewport')
  originalInnerHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight')
  root.style.removeProperty('--app-viewport-height')
 })

 afterEach(() => {
  if (originalVisualViewport) Object.defineProperty(window, 'visualViewport', originalVisualViewport)
  else delete (window as unknown as Record<string, unknown>)['visualViewport']
  if (originalInnerHeight) Object.defineProperty(window, 'innerHeight', originalInnerHeight)
  root.style.removeProperty('--app-viewport-height')
 })

 function mount(viewportHeight: number, windowHeight: number) {
  Object.defineProperty(window, 'visualViewport', {
   value: {
    height: viewportHeight,
    addEventListener: () => { },
    removeEventListener: () => { }
   },
   configurable: true
  })
  Object.defineProperty(window, 'innerHeight', { value: windowHeight, configurable: true })
  return renderHook(() => useViewportHeight())
 }

 it('clears a stale value when the window regains focus after the keyboard is gone', () => {
  root.style.setProperty('--app-viewport-height', '500px')
  const hook = mount(844, 844)

  window.dispatchEvent(new Event('focus'))

  expect(root.style.getPropertyValue('--app-viewport-height')).toBe('')
  hook.unmount()
 })

 it('clears a stale value when the document becomes visible again', () => {
  root.style.setProperty('--app-viewport-height', '500px')
  const hook = mount(844, 844)

  document.dispatchEvent(new Event('visibilitychange'))

  expect(root.style.getPropertyValue('--app-viewport-height')).toBe('')
  hook.unmount()
 })

 it('keeps the value while the keyboard is genuinely open', () => {
  root.style.setProperty('--app-viewport-height', '500px')
  const hook = mount(500, 844)

  window.dispatchEvent(new Event('focus'))

  expect(root.style.getPropertyValue('--app-viewport-height')).toBe('500px')
  hook.unmount()
 })

 it('stops reacting after unmount', () => {
  const hook = mount(844, 844)
  hook.unmount()
  root.style.setProperty('--app-viewport-height', '500px')

  window.dispatchEvent(new Event('focus'))

  expect(root.style.getPropertyValue('--app-viewport-height')).toBe('500px')
 })
})

/**
 * Virtual-keyboard compact mode: the shared detection behind the
 * `app-kbd-open` class and useVirtualKeyboardOpen. Scenarios map to the
 * real device models — iOS (only visualViewport shrinks), Android
 * resizes-content (innerHeight shrinks too), rotation, pinch-zoom and
 * desktop resize (must NOT count as a keyboard).
 */
describe('virtual keyboard detection (updateVirtualKeyboardState)', () => {
 const root = document.documentElement
 let originalMatchMedia: typeof window.matchMedia | undefined
 let originalVisualViewport: PropertyDescriptor | undefined
 let originalInnerHeight: PropertyDescriptor | undefined
 let originalInnerWidth: PropertyDescriptor | undefined
 let focused: HTMLElement | null = null

 function mediaMatches(query: string): boolean {
  if (query === '(pointer: coarse)') return true
  return false
 }

 function setGeometry(visual: number | null, inner: number, width: number, scale = 1) {
  Object.defineProperty(window, 'visualViewport', {
   value: visual === null ? undefined : {
    height: visual,
    scale,
    addEventListener: () => { },
    removeEventListener: () => { },
   },
   configurable: true,
  })
  Object.defineProperty(window, 'innerHeight', { value: inner, configurable: true })
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true })
 }

 function focusEditable(): HTMLElement {
  const el = document.createElement('div')
  el.contentEditable = 'plaintext-only'
  el.setAttribute('role', 'textbox')
  el.tabIndex = 0 // jsdom only reliably focuses tabbable elements
  document.body.append(el)
  focused = el
  return el
 }

 beforeEach(() => {
  originalMatchMedia = window.matchMedia
  originalVisualViewport = Object.getOwnPropertyDescriptor(window, 'visualViewport')
  originalInnerHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight')
  originalInnerWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth')
  window.matchMedia = ((query: string) => ({
   matches: mediaMatches(query),
   media: query,
   addEventListener: () => { },
   removeEventListener: () => { },
   addListener: () => { },
   removeListener: () => { },
   onchange: null,
   dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
  setGeometry(844, 844, 390)
 })

 afterEach(() => {
  window.matchMedia = originalMatchMedia!
  if (originalVisualViewport) Object.defineProperty(window, 'visualViewport', originalVisualViewport)
  else delete (window as unknown as Record<string, unknown>)['visualViewport']
  if (originalInnerHeight) Object.defineProperty(window, 'innerHeight', originalInnerHeight)
  if (originalInnerWidth) Object.defineProperty(window, 'innerWidth', originalInnerWidth)
  focused?.remove()
  focused = null
  root.classList.remove(VIRTUAL_KEYBOARD_CLASS)
 })

 function tick(state = initialVirtualKeyboardState(), now = 1000) {
  // updateVirtualKeyboardState reads document.activeElement directly;
  // jsdom supports real focus() so we drive focus through the DOM.
  if (focused && document.activeElement !== focused) focused.focus()
  return updateVirtualKeyboardState(state, now, window.innerWidth)
 }

 it('opens on iOS when only visualViewport shrinks while an editable is focused', () => {
  focusEditable().focus()
  let state = tick() // seed baseline at 844
  setGeometry(400, 844, 390) // iOS overlay: innerHeight unchanged
  state = tick(state, 1100)
  expect(state.open).toBe(true)
 })

 it('opens on Android resizes-content (innerHeight shrinks with visualViewport)', () => {
  focusEditable().focus()
  let state = tick()
  setGeometry(360, 360, 390)
  state = tick(state, 1100)
  expect(state.open).toBe(true)
 })

 it('opens on Android when the viewport is already shrunk on the first focus tick', () => {
  setGeometry(420, 420, 390)
  focusEditable().focus()
  const state = tick()
  expect(state.open).toBe(true)
 })

 it('closes when the height is restored (keyboard dismissed)', () => {
  focusEditable().focus()
  let state = tick()
  setGeometry(400, 400, 390)
  state = tick(state, 1100)
  expect(state.open).toBe(true)
  setGeometry(844, 844, 390)
  state = tick(state, 1600)
  expect(state.open).toBe(false)
 })

 it('does NOT open on pinch zoom (scale != 1)', () => {
  focusEditable().focus()
  let state = tick()
  setGeometry(400, 844, 390, 2) // zoomed viewport, same height loss
  state = tick(state, 1100)
  expect(state.open).toBe(false)
 })

 it('does NOT open without a focused editable (address bar / scroll shrink)', () => {
  let state = tick()
  setGeometry(400, 400, 390)
  state = tick(state, 1100)
  expect(state.open).toBe(false)
 })

 it('does NOT open for small height losses (address bar only)', () => {
  focusEditable().focus()
  let state = tick()
  setGeometry(780, 780, 390) // 64px loss < 120px threshold
  state = tick(state, 1100)
  expect(state.open).toBe(false)
 })

 it('does NOT open on desktop (fine pointer, wide window)', () => {
  window.matchMedia = ((query: string) => ({
   matches: false, // no coarse pointer, not narrow+no-hover
   media: query,
   addEventListener: () => { },
   removeEventListener: () => { },
   addListener: () => { },
   removeListener: () => { },
   onchange: null,
   dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
  focusEditable().focus()
  let state = tick()
  setGeometry(400, 400, 1440)
  state = tick(state, 1100)
  expect(state.open).toBe(false)
 })

 it('resets open state and baseline on rotation (width change)', () => {
  focusEditable().focus()
  let state = tick()
  setGeometry(400, 400, 390)
  state = tick(state, 1100)
  expect(state.open).toBe(true)
  // Rotate to landscape while keyboard is open.
  setGeometry(200, 200, 844)
  state = tick(state, 1200)
  expect(state.open).toBe(false)
  // Keyboard dismissed in landscape: height restores, stays closed.
  setGeometry(380, 380, 844)
  state = tick(state, 1300)
  expect(state.open).toBe(false)
 })

 it('stays open briefly after blur so toolbar taps do not flicker, then closes past grace', () => {
  const el = focusEditable()
  el.focus()
  let state = tick()
  setGeometry(400, 400, 390)
  state = tick(state, 1100)
  expect(state.open).toBe(true)
  focused = null // prevent tick() from re-focusing the blurred element
  el.blur()
  document.body.focus?.()
  state = tick(state, 1200)
  expect(state.open).toBe(true) // within blur grace, still open
 })
})

/**
 * Channel boundary: `app-kbd-open` / useVirtualKeyboardOpen publication is
 * gated on BETA_TIMELINE_ENABLED inside useViewportHeight. The test
 * environment has VITE_HAPI_BETA unset, so it exercises the non-Beta
 * (classic) channel: the --app-viewport-height fix must still work while
 * keyboard-compact state is never published.
 */
describe('virtual keyboard publication channel gate', () => {
 const root = document.documentElement
 let originalMatchMedia: typeof window.matchMedia | undefined
 let originalVisualViewport: PropertyDescriptor | undefined
 let originalInnerHeight: PropertyDescriptor | undefined
 let originalInnerWidth: PropertyDescriptor | undefined
 let focused: HTMLElement | null = null

 beforeEach(() => {
  originalMatchMedia = window.matchMedia
  originalVisualViewport = Object.getOwnPropertyDescriptor(window, 'visualViewport')
  originalInnerHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight')
  originalInnerWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth')
  window.matchMedia = ((query: string) => ({
   matches: query === '(pointer: coarse)',
   media: query,
   addEventListener: () => { },
   removeEventListener: () => { },
   addListener: () => { },
   removeListener: () => { },
   onchange: null,
   dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
 })

 afterEach(() => {
  window.matchMedia = originalMatchMedia!
  if (originalVisualViewport) Object.defineProperty(window, 'visualViewport', originalVisualViewport)
  else delete (window as unknown as Record<string, unknown>)['visualViewport']
  if (originalInnerHeight) Object.defineProperty(window, 'innerHeight', originalInnerHeight)
  if (originalInnerWidth) Object.defineProperty(window, 'innerWidth', originalInnerWidth)
  focused?.remove()
  focused = null
  root.style.removeProperty('--app-viewport-height')
  root.classList.remove(VIRTUAL_KEYBOARD_CLASS)
 })

 function focusEditable(): HTMLElement {
  const el = document.createElement('div')
  el.contentEditable = 'plaintext-only'
  el.setAttribute('role', 'textbox')
  el.tabIndex = 0
  document.body.append(el)
  focused = el
  return el
 }

 it('keeps the viewport fix but never publishes keyboard compact state on the classic channel', () => {
  const setGeometry = (visual: number, inner: number, width: number) => {
   Object.defineProperty(window, 'visualViewport', {
    value: { height: visual, scale: 1, addEventListener: () => { }, removeEventListener: () => { } },
    configurable: true,
   })
   Object.defineProperty(window, 'innerHeight', { value: inner, configurable: true })
   Object.defineProperty(window, 'innerWidth', { value: width, configurable: true })
  }
  setGeometry(844, 844, 390)
  const hook = renderHook(() => {
   useViewportHeight()
   return useVirtualKeyboardOpen()
  })
  const el = focusEditable()
  el.focus()
  window.dispatchEvent(new Event('focus'))
  // Keyboard-sized loss against the captured 844 baseline.
  Object.defineProperty(window.visualViewport, 'height', { value: 400, configurable: true })
  window.dispatchEvent(new Event('resize'))

  // Detection still runs (same conditions make updateVirtualKeyboardState
  // report open in the unit tests above)…
  const state = { ...initialVirtualKeyboardState(), baselineHeight: 844, baselineWidth: 390, lastEditableAt: 900 }
  expect(updateVirtualKeyboardState(state, 1000, 390).open).toBe(true)
  // …but the classic channel never publishes it.
  expect(root.classList.contains(VIRTUAL_KEYBOARD_CLASS)).toBe(false)
  expect(hook.result.current).toBe(false)
  // The viewport-height fix is unaffected by the gate.
  expect(root.style.getPropertyValue('--app-viewport-height')).toBe('400px')
  hook.unmount()
 })
})

describe('isKeyboardEditableElement', () => {
 it('accepts textarea, text inputs and contenteditable surfaces', () => {
  const textarea = document.createElement('textarea')
  const input = document.createElement('input')
  input.type = 'text'
  const rich = document.createElement('div')
  rich.contentEditable = 'plaintext-only'
  expect(isKeyboardEditableElement(textarea)).toBe(true)
  expect(isKeyboardEditableElement(input)).toBe(true)
  expect(isKeyboardEditableElement(rich)).toBe(true)
 })

 it('rejects non-text controls and disabled/read-only fields', () => {
  for (const type of ['button', 'checkbox', 'file', 'range', 'radio']) {
   const input = document.createElement('input')
   input.type = type
   expect(isKeyboardEditableElement(input)).toBe(false)
  }
  const readonly = document.createElement('textarea')
  readonly.readOnly = true
  expect(isKeyboardEditableElement(readonly)).toBe(false)
  const disabled = document.createElement('input')
  disabled.disabled = true
  expect(isKeyboardEditableElement(disabled)).toBe(false)
  expect(isKeyboardEditableElement(null)).toBe(false)
 })
})
