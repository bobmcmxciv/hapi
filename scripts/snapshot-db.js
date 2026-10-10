// Consistent online snapshot of a live SQLite database with VACUUM INTO.
// The sqlite3 CLI on ECS (3.26) has no VACUUM INTO, and its .backup restarts every time
// the hub writes, so it never finishes on hapi.db during the day.
// Run with the hub binary's SQLite: BUN_BE_BUN=1 <hapi binary> snapshot-db.js <src> <dst>
import { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'

const [src, dst] = process.argv.slice(2)
if (!src || !dst) {
  console.error('usage: snapshot-db.js <src> <dst>')
  process.exit(2)
}
if (existsSync(dst)) {
  console.error(`refusing to overwrite ${dst}`)
  process.exit(2)
}
const startedAt = performance.now()
const db = new Database(src, { readonly: true })
db.exec('PRAGMA busy_timeout = 20000')
db.prepare('VACUUM INTO ?').run(dst)
db.close()
const copy = new Database(dst, { readonly: true })
const check = copy.prepare('PRAGMA quick_check').get()
const version = copy.prepare('PRAGMA user_version').get()
copy.close()
const quick = Object.values(check)[0]
console.log(JSON.stringify({ src, dst, ms: Math.round(performance.now() - startedAt), quick_check: quick, user_version: Object.values(version)[0] }))
process.exit(quick === 'ok' ? 0 : 1)
