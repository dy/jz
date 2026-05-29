// Audit the test262 "negative: phase: parse" skip set (test/test262.js): for each
// such test, does jz reject (good — a syntax error jz catches) or silently ACCEPT
// (a potential miscompile, the PARSE-2 class)? The invariant we want is 0 accepts —
// jz never gives meaning to invalid JS. Run after touching parse/prepare surface.
//
//   node scripts/neg-parse-audit.mjs
//
import jz from '../index.js'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../test/test262/test/language')
if (!existsSync(ROOT)) { console.error('test262 checkout missing — run the test262 suite first'); process.exit(1) }

const files = []
const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) {
  const p = join(d, e.name); e.isDirectory() ? walk(p) : e.name.endsWith('.js') && files.push(p)
} }
walk(ROOT)

let neg = 0, reject = 0; const accepts = []
for (const f of files) {
  const c = readFileSync(f, 'utf8')
  if (!/negative:\s*\n\s+phase:\s+parse/.test(c)) continue
  neg++
  try { jz(c.replace(/\/\*[\s\S]*?\*\//, '')); accepts.push(f.replace(ROOT + '/', '')) }
  catch { reject++ }
}
console.log(`negative-parse tests: ${neg} | jz REJECTS: ${reject} | jz ACCEPTS (should be 0): ${accepts.length}`)
if (accepts.length) { console.log('\nACCEPTS-INVALID (potential miscompiles):'); accepts.forEach(a => console.log('  ' + a)) }
process.exit(accepts.length ? 1 : 0)
