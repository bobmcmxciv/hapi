(() => {
    const sid = location.pathname.split('/sessions/')[1]?.split('/')[0] ?? null
    const vp = document.querySelector('.chat-scroll-y')
    const rows = Array.from(document.querySelectorAll('[data-hapi-message-role]'))
    const vpRect = vp ? vp.getBoundingClientRect() : null
    const visible = vpRect ? rows.filter((el) => {
        const r = el.getBoundingClientRect()
        return r.bottom > vpRect.top && r.top < vpRect.bottom
    }) : []
    const text = (el) => (el?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 40)
    let win = null
    try {
        const raw = sid ? sessionStorage.getItem('hapi:message-window:v2:' + sid) : null
        if (raw) {
            const s = JSON.parse(raw)
            win = { n: s.messages.length, epoch: s.epoch, hasMore: s.hasMore, oldestSeq: s.oldestPositionSeq, newestSeq: s.newestPositionSeq, firstText: JSON.stringify(s.messages[0]?.content).slice(0, 60) }
        }
    } catch (e) { win = 'err:' + e.message }
    const distanceFromBottom = vp ? Math.round(vp.scrollHeight - vp.scrollTop - vp.clientHeight) : null
    return {
        sid,
        dom: rows.length,
        firstRow: text(rows[0]),
        lastRow: text(rows[rows.length - 1]),
        visibleFirst: text(visible[0]),
        visibleFirstId: visible[0]?.id ?? null,
        visibleCount: visible.length,
        scrollTop: vp ? Math.round(vp.scrollTop) : null,
        scrollHeight: vp ? vp.scrollHeight : null,
        clientHeight: vp ? vp.clientHeight : null,
        distanceFromBottom,
        historyButton: !!Array.from(document.querySelectorAll('button')).find((b) => /older|history|历史|更早/i.test(b.getAttribute('aria-label') || b.textContent || '')),
        win
    }
})()
