import { describe, expect, it } from 'vitest'
import { isTerminalTarget, matchTabShortcut } from './tabShortcuts'

const key = (over: Partial<Parameters<typeof matchTabShortcut>[0]>) => ({
    key: '', code: '', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, isComposing: false, ...over
})

describe('matchTabShortcut', () => {
    it('maps Ctrl/⌘+W and Alt/⌥+W to close, Ctrl/⌘+T and Alt/⌥+T to new', () => {
        expect(matchTabShortcut(key({ key: 'w', code: 'KeyW', ctrlKey: true }))).toBe('close')
        expect(matchTabShortcut(key({ key: 'w', code: 'KeyW', metaKey: true }))).toBe('close')
        expect(matchTabShortcut(key({ key: '∑', code: 'KeyW', altKey: true }))).toBe('close')
        expect(matchTabShortcut(key({ key: 't', code: 'KeyT', ctrlKey: true }))).toBe('new')
        expect(matchTabShortcut(key({ key: '†', code: 'KeyT', altKey: true }))).toBe('new')
    })

    it('follows the typed letter for Ctrl/⌘ on non-QWERTY layouts', () => {
        // AZERTY: the physical KeyZ position types "w"
        expect(matchTabShortcut(key({ key: 'w', code: 'KeyZ', ctrlKey: true }))).toBe('close')
        expect(matchTabShortcut(key({ key: 'z', code: 'KeyW', ctrlKey: true }))).toBeNull()
    })

    it('ignores plain letters, other combos, auto-repeat and IME composition', () => {
        expect(matchTabShortcut(key({ key: 'w', code: 'KeyW' }))).toBeNull()
        expect(matchTabShortcut(key({ key: 'W', code: 'KeyW', ctrlKey: true, shiftKey: true }))).toBeNull()
        expect(matchTabShortcut(key({ key: 'w', code: 'KeyW', ctrlKey: true, altKey: true }))).toBeNull()
        expect(matchTabShortcut(key({ key: 'w', code: 'KeyW', ctrlKey: true, repeat: true }))).toBeNull()
        expect(matchTabShortcut(key({ key: 'w', code: 'KeyW', altKey: true, isComposing: true }))).toBeNull()
        expect(matchTabShortcut(key({ key: 'm', code: 'KeyM', ctrlKey: true }))).toBeNull()
    })

    it('recognises focus inside the terminal', () => {
        const term = document.createElement('div')
        term.className = 'xterm'
        const textarea = document.createElement('textarea')
        term.appendChild(textarea)
        document.body.appendChild(term)
        expect(isTerminalTarget(textarea)).toBe(true)
        expect(isTerminalTarget(document.body)).toBe(false)
        expect(isTerminalTarget(null)).toBe(false)
        term.remove()
    })
})
