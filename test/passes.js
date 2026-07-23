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
  // Bare truthy reads escape the comparison-shaped idiom above — the exact hole
  // that let `transform.optimize?.approxPow` (module/math.js) go unregistered
  // while this test claimed coverage. The canonical module-tier read path is
  // unambiguous, so match it in ANY expression context.
  const reBare = /transform\.optimize\?\.\s*([A-Za-z_$][\w$]*)/g
  const unknown = new Map()
  for (const p of files) {
    // strip line + block comments so documented idioms don't false-positive
    const src = readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    for (const rx of [re, reBare]) for (const m of src.matchAll(rx)) {
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

test('passes: unknown optimize keys and presets fail loudly', () => {
  // Silent acceptance shipped wrong pipelines: { watrLcm: true } was a no-op
  // typo of watrLicm; optimize: 'sped' silently meant level 2.
  const throws = (fn, match, msg) => {
    try { fn() } catch (e) { ok(match.test(String(e.message)), `${msg}: ${e.message}`); return }
    ok(false, `${msg}: did not throw`)
  }
  throws(() => compile('export let f = () => 1', { optimize: { watrLcm: true } }), /watrLicm/,
    'typo key suggests the registered name')
  // Under JZ_TEST_OPTIMIZE legs the harness merges the string into { level },
  // so the throw comes from the level branch — accept either message.
  throws(() => compile('export let f = () => 1', { optimize: 'sped' }), /Unknown optimize (preset|level)/,
    'unknown preset string throws')
  throws(() => compile('export let f = () => 1', { optimize: { level: 7 } }), /Unknown optimize level/,
    'unknown level throws')
  // Registered tuning keys still pass through.
  compile('export let f = (x) => Math.pow(x, 0.2)', { optimize: { approxPow: true } })
  compile('export let f = () => 1', { optimize: { noSimd: true } })
})

test('passes: dead code never changes retained-code bytes (no hidden auto-tuning)', () => {
  // The retired AST-shape auto-tuner flipped watr:false past size thresholds,
  // so appending DEAD functions changed the LIVE function's optimization
  // (+30% size at the crossing). Default must name one stable pipeline.
  const live = `export let f = (x) => x * 2 + 1`
  const dead = live + '\n' + Array.from({ length: 60 }, (_, i) =>
    `let unused${i} = (a) => { let s = 0; for (let k = 0; k < 9; k++) s += a * k; return s }`).join('\n')
  // Explicit level 2 always; the bare-default form ONLY when no JZ_TEST_OPTIMIZE
  // env override is in play — under the O0 battery leg treeshake is off BY DESIGN,
  // so dead code legitimately stays and byte equality doesn't apply.
  const envTier = typeof process !== 'undefined' && process.env?.JZ_TEST_OPTIMIZE != null
  for (const opts of envTier ? [{ optimize: 2 }] : [{ optimize: 2 }, {}]) {
    const a = compile(live, opts), b = compile(dead, opts)
    is(a.length, b.length, `byte count stable under appended dead code (${opts.optimize ?? 'default'})`)
    ok(Buffer.from(a).equals(Buffer.from(b)), `bytes identical under appended dead code (${opts.optimize ?? 'default'})`)
  }
})

test('passes: emission tier never writes durable analysis state (slice-4 exit grep)', () => {
  // Stage 2's finish line, held statically: emit and the module/ tier contain
  // ZERO updateRep / schema.vars.set calls — discovery lives in plan passes,
  // emission products in transient channels (localValTypesOverlay, closureAux).
  // A static source check beats a runtime tripwire here: it needs no subset
  // support in the self-host kernel (a Proxy-based guard broke the kernel
  // build — 'Proxy' is not jz) and covers paths no test executes.
  const files = []
  const walkDir = (dir) => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f)
      if (statSync(p).isDirectory()) walkDir(p)
      else if (f.endsWith('.js')) files.push(p)
    }
  }
  walkDir(join(ROOT, 'module'))
  files.push(join(ROOT, 'src/compile/emit.js'))
  const offenders = []
  for (const p of files) {
    const src = readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    for (const pat of [/\bupdateRep\s*\(/g, /schema\.vars\.set\s*\(/g])
      if (pat.test(src)) offenders.push(`${p.slice(ROOT.length + 1)}: ${pat.source}`)
  }
  is(offenders.join(', '), '', `emission-tier durable writes: ${offenders.join('; ')}`)
})

test('passes: no bare optimization-object truthiness gates (audit P1 exit grep)', () => {
  // resolveOptimize(0) returns an all-false OBJECT — truthy. A transform gated
  // on bare `ctx.transform.optimize` therefore ran at O0, silently weakening it
  // as the representation-free correctness oracle. Every emit-time transform
  // must read a NAMED registered flag (`ctx.transform.optimize?.pass`); the
  // whole-object read is legal only for presence checks on properties.
  const files = []
  const walkDir = (dir) => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f)
      if (statSync(p).isDirectory()) walkDir(p)
      else if (f.endsWith('.js')) files.push(p)
    }
  }
  walkDir(join(ROOT, 'module'))
  walkDir(join(ROOT, 'src'))
  const offenders = []
  const BARE = /ctx\.transform\.optimize\s*(?:\)\s*\{|\?[^.]|&&)/g
  for (const p of files) {
    const src = readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    let m
    while ((m = BARE.exec(src))) {
      // `if (ctx.transform.optimize) {` / `… ? … :` / `… && …` — truthiness use
      offenders.push(`${p.slice(ROOT.length + 1)}: …${src.slice(Math.max(0, m.index - 20), m.index + 30).replace(/\s+/g, ' ')}…`)
    }
  }
  is(offenders.join(', '), '', `bare optimize-object gates: ${offenders.join('; ')}`)
})
