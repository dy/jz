#!/usr/bin/env node
/**
 * jsstring carrier bench — paired-compilation comparison.
 *
 * The same JS source is compiled twice:
 *   - jz default     → narrower flips eligible exported string params to
 *                       `externref` and lowers `.length`/`.charCodeAt` to the
 *                       `wasm:js-string` builtins. Zero-copy boundary.
 *   - optimize.jsstring:false → param stays `f64` (NaN-boxed SSO carrier).
 *                       String bytes are written to wasm linear memory at
 *                       each call; `.charCodeAt` is a normal f64 load.
 *
 * We feed the WASM-exported function a JS string from the host and time the
 * end-to-end roundtrip. This isolates the boundary-marshalling cost (the work
 * the jsstring opt-in saves), not the per-char loop cost itself.
 *
 * Two micro-kernels:
 *   - `len` — single `.length` access. Defaults `(s = '')` → string-default
 *     proof; tests the trivial boundary case.
 *   - `sum` — bounded char-code sum. Tests `.charCodeAt` opt-in (requires
 *     scanBoundedLoops to prove in-bounds).
 *
 * Caveat: with native `wasm:js-string` builtins (V8 17+/Safari 18.4+) the
 * engine inlines the calls. Without native support, interop.js attaches a JS
 * polyfill — correct but each call hops back to JS, blunting the win on
 * char-heavy loops. The boundary cost (string write) is saved either way.
 *
 * Usage:  node bench/jsstring/bench-jsstring.mjs [--samples=N] [--reps=N]
 */
import { instantiate } from '../../interop.js'
import { compile } from '../../index.js'

const args = Object.fromEntries(
  process.argv.slice(2).flatMap(a => {
    const m = a.match(/^--([^=]+)=(.+)$/)
    return m ? [[m[1], m[2]]] : []
  })
)
const N_SAMPLES = +args.samples || 21
const N_REPS    = +args.reps    || 5000

// Detect native wasm:js-string support in the current engine.
const probeNative = () => {
  try {
    // Compile a tiny module that imports a wasm:js-string fn, then try to
    // instantiate it with the `builtins` Module option and an empty imports
    // object. Engines that honor the option satisfy the import themselves.
    const bytes = compile(`export const f = (s) => { let n = 0; for (let i = 0; i < s.length; i++) n += s.charCodeAt(i); return n }`, { optimize: { watr: false } })
    const mod = new WebAssembly.Module(bytes, { builtins: ['js-string'] })
    new WebAssembly.Instance(mod, {})
    return true
  } catch { return false }
}

const SRC = `
  export const sum = (s) => {
    let n = 0
    for (let i = 0; i < s.length; i++) n += s.charCodeAt(i)
    return n
  }
  export const len = (s = '') => s.length
`

const buildVariant = (label, optimize) => {
  const wasm = compile(SRC, { optimize })
  const { exports } = instantiate(wasm)
  const externref = /\(param \$s externref\)/.test(compile(SRC, { wat: true, optimize: { ...optimize, watr: false } }))
  return { label, exports, externref, bytes: wasm.byteLength }
}

const median = (arr) => {
  const a = arr.slice().sort((a, b) => a - b)
  return a[(a.length - 1) >> 1]
}

const timeKernel = (fn, arg, reps) => {
  // Warmup
  for (let i = 0; i < 10; i++) fn(arg)
  const samples = new Float64Array(N_SAMPLES)
  for (let s = 0; s < N_SAMPLES; s++) {
    const t0 = performance.now()
    let acc = 0
    for (let i = 0; i < reps; i++) acc = acc + fn(arg) | 0
    samples[s] = performance.now() - t0
    if (acc === Number.MAX_SAFE_INTEGER) console.log(acc)  // DCE guard
  }
  return median(samples)
}

const fmt = (ms) => ms.toFixed(3) + ' ms'
const fmtUs = (us) => us.toFixed(2) + ' µs'

console.log(`# jsstring carrier bench`)
console.log(`engine: node ${process.version}`)
console.log(`native wasm:js-string: ${probeNative() ? 'YES (engine inlines builtins)' : 'NO (polyfill attached — per-call wasm→JS hop)'}`)
console.log(`samples=${N_SAMPLES} reps_per_sample=${N_REPS}`)
console.log()

const variants = [
  buildVariant('jsstring',    {}),                          // default = opt-in on
  buildVariant('SSO (f64)',   { jsstring: false }),
]

console.log(`variant         externref  wasm size`)
console.log(`-----------     ---------  ---------`)
for (const v of variants) {
  console.log(`${v.label.padEnd(14)} ${(v.externref ? 'yes' : 'no').padEnd(10)} ${v.bytes} B`)
}
console.log()

// Three string-length tiers — boundary cost dominates at large sizes; tiny
// strings are dominated by the call overhead itself.
const SIZES = [8, 256, 8192]

for (const size of SIZES) {
  const s = 'a'.repeat(size)
  console.log(`# string size = ${size} chars`)
  console.log(`  kernel          variant          median        ns/call    speedup`)
  console.log(`  ------          --------         ----------    -------    -------`)
  const kernels = [
    { name: 'len(s)',     fn: 'len',  reps: N_REPS },
    { name: 'sum(s)',     fn: 'sum',  reps: Math.max(50, (N_REPS * 64 / Math.max(8, size)) | 0) },
  ]
  for (const k of kernels) {
    const results = variants.map(v => ({
      label: v.label,
      median: timeKernel(v.exports[k.fn], s, k.reps),
      reps: k.reps,
    }))
    const sso = results.find(r => r.label === 'SSO (f64)')
    for (const r of results) {
      const nsPerCall = (r.median * 1e6 / r.reps)
      const speedup = r.label === 'SSO (f64)' ? '' :
        (sso.median / r.median).toFixed(2) + '×'
      console.log(`  ${k.name.padEnd(15)} ${r.label.padEnd(16)} ${fmt(r.median).padStart(10)}    ${nsPerCall.toFixed(1).padStart(7)}    ${speedup.padStart(7)}`)
    }
  }
  console.log()
}

// Also: the full jessie kernel, with an externalized source-passing wrapper.
// jessie's `parse` reads `src.charCodeAt(i)` deep in a Pratt loop — exactly
// the workload the opt-in targets. We build a thin export that takes the
// source string and returns a hash, so the WASM boundary actually sees a JS
// string crossing in (the original jessie bench makes the source internally).

const JESSIE_SRC = `
import { parse } from '../../node_modules/subscript/feature/jessie.js'

// Structural FNV over the AST. Pure ABI-agnostic so the same checksum lands
// either side. (Char hash trimmed: we just need a result the engine can't DCE.)
const hashNode = (node, h) => {
  if (Array.isArray(node)) {
    h = Math.imul(h ^ node.length, 0x01000193) | 0
    for (let i = 0; i < node.length; i++) h = hashNode(node[i], h)
    return h
  }
  if (typeof node === 'string') {
    h = Math.imul(h ^ (node.length + 256), 0x01000193) | 0
    for (let i = 0; i < node.length; i++) h = Math.imul(h ^ node.charCodeAt(i), 0x01000193) | 0
    return h
  }
  if (typeof node === 'number') return Math.imul(h ^ (node | 0), 0x01000193) | 0
  return Math.imul(h ^ 7, 0x01000193) | 0
}

export const parseAndHash = (src) => hashNode(parse(src), 0x811c9dc5 | 0) >>> 0
`

// The corpus the original jessie bench uses.
const BLOCK = `let total = 0
const limit = 64
function step(a, b) { return a * b + (a - b) }
const scale = (x) => x * 3 + 1
for (let i = 0; i < limit; i = i + 1) {
  let v = step(i, i + 2)
  if (v > 100) { total = total + scale(v) } else { total = total - i }
  while (v > 0) { v = v - 7 }
}
const data = [1, 2, 3, 4, 5]
let acc = data[0] + data[1] * data[2]
const obj = { x: acc, y: total, z: limit }
total = obj.x + obj.y - obj.z
`

// Jessie shows the negative case: the entry param flows into a non-builtin
// call (`parse(src)` — internal jessie code), so the narrower correctly
// refuses to flip. The opt-in is conservative by design — escaped params keep
// the f64/SSO carrier so internal call sites stay valid. This section
// documents that the rejection is intentional, not a missed optimization.
console.log('# jessie parser — source string passed through to parse()')
try {
  const { resolveModuleGraph } = await import('../../src/resolve.js')
  const path = await import('node:path')
  const fs = await import('node:fs')
  const url = await import('node:url')
  const here = path.dirname(url.fileURLToPath(import.meta.url))
  const benchFile = path.join(here, '_jessie-string-entry.js')
  fs.writeFileSync(benchFile, JESSIE_SRC)
  const { code, modules } = resolveModuleGraph(benchFile)

  const buildJessieVariant = (label, optimize) => {
    const wasm = compile(code, { jzify: true, modules, optimize, alloc: false })
    const { exports } = instantiate(wasm)
    const wat = compile(code, { jzify: true, modules, optimize: { ...optimize, watr: false }, wat: true, alloc: false })
    const externref = /\(func \$parseAndHash[\s\S]*?\(param \$src externref\)/.test(wat)
    return { label, exports, externref, bytes: wasm.byteLength }
  }

  const jessieVariants = [
    buildJessieVariant('jsstring',  {}),
    buildJessieVariant('SSO (f64)', { jsstring: false }),
  ]

  fs.unlinkSync(benchFile)

  // Compose source.
  const N_REPEAT = 32
  let source = ''
  for (let i = 0; i < N_REPEAT; i++) source = source + BLOCK
  console.log(`  source size: ${source.length} chars`)
  console.log(`  expected opt-in: declined (param escapes into parse() — not a builtin)`)
  console.log()
  console.log(`  variant         externref  wasm size   median       ratio`)
  console.log(`  -----------     ---------  ---------   ----------   -----`)

  // Validate parity: both variants must produce identical checksums.
  const refCs = jessieVariants[0].exports.parseAndHash(source)
  for (const v of jessieVariants.slice(1)) {
    const cs = v.exports.parseAndHash(source)
    if (cs !== refCs) {
      console.log(`  PARITY FAIL: ${v.label} produced ${cs}, expected ${refCs}`)
      process.exit(1)
    }
  }

  const N_RUNS = N_SAMPLES
  const results = jessieVariants.map(v => {
    // Warmup
    for (let i = 0; i < 5; i++) v.exports.parseAndHash(source)
    const samples = new Float64Array(N_RUNS)
    for (let i = 0; i < N_RUNS; i++) {
      const t0 = performance.now()
      v.exports.parseAndHash(source)
      samples[i] = performance.now() - t0
    }
    return { ...v, median: median(samples) }
  })

  const sso = results.find(r => r.label === 'SSO (f64)')
  for (const r of results) {
    const ratio = r.label === 'SSO (f64)' ? '' :
      (sso.median / r.median).toFixed(2) + '×'
    console.log(`  ${r.label.padEnd(14)} ${(r.externref ? 'yes' : 'no').padEnd(10)} ${(r.bytes + ' B').padEnd(11)} ${fmt(r.median).padStart(10)}    ${ratio.padStart(5)}`)
  }
  console.log()
  console.log(`  Tie (~1.0×) confirms the rejection has no perf side-effect — the SSO`)
  console.log(`  path is untouched. Jessie's own parser internals receive the string`)
  console.log(`  via memory, so passing externref in would require deep refactoring.`)
} catch (e) {
  console.log('  skipped:', e.message)
}
