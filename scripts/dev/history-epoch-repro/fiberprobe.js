(() => {
    const vp = document.querySelector('.chat-scroll-y')
    const key = Object.keys(vp).find((k) => k.startsWith('__reactFiber$'))
    let f = vp[key]
    const out = []
    let depth = 0
    while (f && depth < 80) {
        const p = f.memoizedProps
        if (p && typeof p === 'object' && ('hasMoreMessages' in p || 'isSyncingTail' in p || 'isLoadingMoreMessages' in p || 'viewMode' in p)) {
            out.push({
                comp: (f.type && (f.type.displayName || f.type.name)) || String(f.type),
                hasMoreMessages: p.hasMoreMessages,
                isSyncingTail: p.isSyncingTail,
                isLoadingMoreMessages: p.isLoadingMoreMessages,
                viewMode: p.viewMode,
                messagesWarning: p.messagesWarning ?? null
            })
        }
        f = f.return
        depth++
    }
    return out
})()
