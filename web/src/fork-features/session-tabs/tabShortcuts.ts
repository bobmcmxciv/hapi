export type TabShortcut = 'close' | 'new'

type KeyLike = Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'repeat' | 'isComposing'>

/**
 * 标签快捷键：Ctrl/⌘+W、Alt/⌥+W 关闭当前会话标签；Ctrl/⌘+T、Alt/⌥+T 新建会话。
 * 普通浏览器标签页里 Ctrl/⌘+W、Ctrl/⌘+T 由浏览器先处理、页面收不到（Chrome 把它们列为保留键），
 * 只有安装成应用（独立窗口）或全屏时才会交给页面；Alt 组合在哪都能用。
 * Alt 组合按 code 判断：macOS 上 ⌥+W 的 key 是「∑」。
 */
export function matchTabShortcut(event: KeyLike): TabShortcut | null {
    if (event.repeat || event.isComposing || event.shiftKey) return null
    const primary = (event.ctrlKey || event.metaKey) && !event.altKey
    const alt = event.altKey && !event.ctrlKey && !event.metaKey
    if (!primary && !alt) return null
    const letter = alt ? event.code : (event.key.length === 1 ? `Key${event.key.toUpperCase()}` : event.code)
    if (letter === 'KeyW') return 'close'
    if (letter === 'KeyT') return 'new'
    return null
}

/** 终端里 Ctrl+W 是删词，焦点在终端时快捷键一律不拦。 */
export function isTerminalTarget(target: EventTarget | null): boolean {
    return typeof Element !== 'undefined' && target instanceof Element && target.closest('.xterm') !== null
}
