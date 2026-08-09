/**
 * 拿生产库副本离线复算用量，并顺带打印信封形状直方图。
 *
 * 为什么需要它：用量聚合的输入是 `messages.content` 里的信封，而**信封形状
 * 随 flavor 变**，光读 CLI 源码猜会猜错。2026-08-09 就是靠这个脚本发现
 * Codex 的信封是 `content.type === 'codex'` 而不是 `'output'`、且完全没有
 * `data.timestamp` —— 两个都会让整支用量被静默丢光，而按错误假设写的单测
 * 一个都测不出来。
 *
 * 用法：
 *   bun scripts/dev/recompute-usage-prod.ts <subset.db> [--shapes]
 *
 * 副本怎么来（在 ECS 上**只读**取，不碰生产库）：
 *   sqlite3 /tmp/usage-subset.db "
 *     ATTACH 'file:/root/.hapi/hapi.db?mode=ro' AS src;
 *     CREATE TABLE sessions AS SELECT * FROM src.sessions WHERE <筛选>;
 *     CREATE TABLE messages AS SELECT * FROM src.messages
 *       WHERE session_id IN (SELECT id FROM sessions);
 *     VACUUM;"
 *   scp ecs:/tmp/usage-subset.db .   # 传完必须比 md5，不能看大小（见 CLAUDE.md §2.6）
 *
 * 聚合引擎只读 sessions / messages 两张表，所以两表副本就够复算，不需要整库。
 */
import { Database } from 'bun:sqlite'

import { decodeMessageContent } from '../../hub/src/store/contentCodec'
import { aggregateUsageForSessions, type UsageAggregateRow } from '../../fork-features/usage/usageAggregate'

const dbPath = process.argv[2]
if (!dbPath) {
    console.error('usage: bun scripts/dev/recompute-usage-prod.ts <subset.db> [--shapes]')
    process.exit(2)
}
const withShapes = process.argv.includes('--shapes')

const db = new Database(dbPath, { readonly: true })

const sessions = db.prepare(`
    SELECT id, COALESCE(json_extract(metadata, '$.flavor'), '(null)') AS flavor
    FROM sessions
`).all() as Array<{ id: string; flavor: string }>

const byFlavor = new Map<string, string[]>()
for (const s of sessions) byFlavor.set(s.flavor, [...(byFlavor.get(s.flavor) ?? []), s.id])

const tokens = (r: UsageAggregateRow): number =>
    r.inputTokens + r.outputTokens + r.cacheCreationInputTokens + r.cacheReadInputTokens
const fmt = (n: number): string => n.toLocaleString('en-US')

console.log(`副本: ${dbPath}`)
console.log(`会话: ${sessions.length}，flavor: ${[...byFlavor].map(([f, ids]) => `${f}=${ids.length}`).join(', ')}`)
console.log('')

if (withShapes) {
    // 信封形状直方图 —— 判断「是没数据」还是「解析器没接住」的唯一办法。
    const shapes = new Map<string, number>()
    let noTimestamp = 0
    const rows = db.prepare('SELECT content FROM messages').all() as Array<{ content: string | Uint8Array }>
    for (const row of rows) {
        let c: unknown
        try { c = decodeMessageContent(row.content as never) } catch { continue }
        const rec = c as Record<string, any> | null
        const outer = rec?.content
        const data = outer?.data
        if (!data) continue
        if (typeof data.timestamp !== 'string') noTimestamp++
        const key = `${rec?.role ?? '-'} / ${outer?.type ?? '-'} / ${data?.type ?? '-'}`
        shapes.set(key, (shapes.get(key) ?? 0) + 1)
    }
    console.log('── 信封形状 (role / content.type / data.type)')
    for (const [k, v] of [...shapes].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
        console.log(`   ${String(v).padStart(6)}  ${k}`)
    }
    console.log(`   缺 data.timestamp 的消息: ${noTimestamp}`)
    console.log('')
}

let grand = 0
for (const [flavor, ids] of [...byFlavor].sort()) {
    const rows = aggregateUsageForSessions(db, ids)
    const total = rows.reduce((a, r) => a + tokens(r), 0)
    grand += total
    console.log(`── flavor=${flavor}  (${ids.length} 会话)  总 token ${fmt(total)}  行数 ${rows.length}`)
    for (const row of [...rows].sort((x, y) => tokens(y) - tokens(x))) {
        console.log(`     ${row.model.padEnd(28)} req=${String(row.requestCount).padStart(5)}  `
            + `in=${fmt(row.inputTokens).padStart(13)}  out=${fmt(row.outputTokens).padStart(11)}  `
            + `cacheR=${fmt(row.cacheReadInputTokens).padStart(13)}`)
    }
    console.log('')
}
console.log(`合计: ${fmt(grand)}`)
db.close()
