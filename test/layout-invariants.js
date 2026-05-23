/**
 * Guard layout.js as the sole source of NaN-box carrier i64 hex in WAT templates.
 */
import test from 'tst'
import { ok } from 'tst/assert.js'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join, relative } from 'path'

const ROOT = join(import.meta.dirname, '..')
const SCAN = [join(ROOT, 'module'), join(ROOT, 'src')]
const ALLOW = new Set([join(ROOT, 'layout.js')])

/** Discriminator bits that must come from layout.js helpers, not hand literals. */
const LAYOUT_I64 = [
  /\(i64\.const 0x7FF80{8}[0-9A-Fa-f]{0,8}\)/g,
  /\(i64\.const 0x0000400000000000\)/g,
  /\(i64\.const 0x0000200000000000\)/g,
]

function jsFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) jsFiles(p, out)
    else if (p.endsWith('.js') && !ALLOW.has(p)) out.push(p)
  }
  return out
}

test('layout: NaN-box carrier i64 hex only via layout.js helpers', () => {
  const violations = []
  for (const dir of SCAN) {
    for (const file of jsFiles(dir)) {
      const src = readFileSync(file, 'utf8')
      for (const re of LAYOUT_I64) {
        re.lastIndex = 0
        for (const m of src.matchAll(re)) {
          violations.push(`${relative(ROOT, file)}: ${m[0]}`)
        }
      }
    }
  }
  ok(violations.length === 0, violations.length
    ? `use layout.js helpers (nanPrefixHex, ssoBitI64Hex, sliceBitI64Hex, …):\n${violations.join('\n')}`
    : 'no hand-rolled layout hex')
})
