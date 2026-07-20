// Stage-0 architecture gates (see .work/architecture-plan.md):
//   1. REGISTRY COVERAGE — every flag any call site reads off the optimize
//      config must be declared in PASS_NAMES or TUNING_KEYS. An unlisted name
//      reads `undefined !== false` and silently runs at O0, breaking the
//      representation-free reference tier (six passes did exactly this).
//   2. FORMATTING INVARIANCE — comments/whitespace must never change output
//      bytes at any preset (a 5 KB comment used to flip the auto-tuner's
//      source-length heuristic: 70 B → 204 B on the same program).
import { execSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { compile } from '../index.js'
import { PASS_NAMES, TUNING_KEYS } from '../src/optimize/index.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

test('passes: every optimize-config read is a registered pass or tuning key', () => {
  const registered = new Set([...PASS_NAMES, ...TUNING_KEYS])
  const files = []
  const walk = (dir) => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f)
      if (statSync(p).isDirectory()) walk(p)
      else if (f.endsWith('.js')) files.push(p)
    }
  }
  walk(join(ROOT, 'src'))
  walk(join(ROOT, 'module'))
  files.push(join(ROOT, 'index.js'))
  // Match the gate idioms: `optimize.NAME !==/===`, `optimize?.NAME !==/===`,
  // `_o.NAME !==/===`, `cfg.NAME ===/!==`, `o.NAME === false` — the receiver
  // must be an optimize-config alias, so key off the known alias spellings.
  const re = /(?:optimize\??|_o|cfg)\s*\.\s*([A-Za-z_$][\w$]*)\s*(?:!==|===)\s*(?:false|true|'|")/g
  const unknown = new Map()
  for (const p of files) {
    // strip line + block comments so documented idioms don't false-positive
    const src = readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    for (const m of src.matchAll(re)) {
      const name = m[1]
      if (!registered.has(name)) {
        if (!unknown.has(name)) unknown.set(name, [])
        unknown.get(name).push(p.slice(ROOT.length + 1))
      }
    }
  }
  is([...unknown.keys()].sort().join(', '), '',
    `unregistered optimize flags read at call sites: ${[...unknown].map(([n, ps]) => `${n} (${ps[0]})`).join('; ')}`)
})

test('passes: comments and whitespace never change output bytes', () => {
  const SRCS = [
    // small scalar program (the original 2.9× repro shape)
    `export let main = (n) => { let s = 0; for (let i = 0; i < n; i++) s += i * 2; return s }`,
    // typed-array program (exercises the auto-tuner's typed path)
    `export let main = (n) => {
  const a = new Float64Array(64)
  for (let i = 0; i < 64; i++) a[i] = i * 0.5
  let s = 0
  for (let i = 0; i < 64; i++) s += a[i]
  return s + n
}`,
  ]
  const PAD = '// ' + 'x'.repeat(97) + '\n'
  const pad5k = PAD.repeat(50)   // ~5 KB of comment
  for (const src of SRCS) {
    for (const optimize of [undefined, 0, 2, 'speed', 'size']) {
      const opts = optimize === undefined ? {} : { optimize }
      const plain = compile(src, opts)
      const padded = compile(pad5k + src + '\n' + pad5k, opts)
      is(plain.length, padded.length, `O${optimize}: byte count invariant under 10 KB of comments`)
      ok(Buffer.from(plain).equals(Buffer.from(padded)), `O${optimize}: bytes identical`)
    }
  }
})
