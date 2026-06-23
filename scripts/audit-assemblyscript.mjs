#!/usr/bin/env node
// One-shot BIAS AUDIT against the AssemblyScript canon.
//
// The bench corpus grew up alongside the compiler, so it tends to exhibit exactly
// the shapes the optimizer's whitelists recognize (a real selection bias). This
// audit counters that: a third-party-shaped corpus the compiler was NOT tuned on
// — the canonical numeric kernels from AssemblyScript's own examples/benchmarks —
// written in PLAIN, ANNOTATION-FREE JavaScript. AS needs explicit `i32`/`f64`
// types and `load`/`store` intrinsics to make these fast; the test is whether jz,
// told nothing, INFERS the same structure and emits waste-free output.
//
// Not a CI gate — run on demand (`node scripts/audit-assemblyscript.mjs`). It
// reports, per kernel: wasm byte size, and whether the absence-of-overhead
// contract holds (no f64 round-trip in an integer loop; no per-iteration pointer
// decode). A clean integer kernel = jz inferred i32 with zero annotations. A
// dirty one = a generality gap the in-house bench may not surface. Head-to-head
// size vs `asc -Oz` lives in `npm run bench:size`.
import { compile } from '../index.js'
import { parse, loopHas, COUNTER_CMP_F64, PTR_HELPER } from './wat-probe.mjs'

// What this audits — two SOUND absence-of-overhead signals (not body f64, which
// for general integer code is often the integer-overflow contract, not a deopt):
//   • counter-in-f64 : an i32 loop counter compared in f64 (`f64.le(convert(i),…)`)
//                       — a counted loop whose bound narrowLoopBound failed to snap.
//   • ptr-in-loop    : a loop-invariant pointer/length helper re-run per iteration.
// Both are unambiguous waste on ANY code. `kind` only labels expected body f64.
const CORPUS = [
  // ── integer (jz must infer i32 with no annotation) ──────────────────────────
  { name: 'fib (recursive)', kind: 'int',
    src: `export let fib = (n) => n < 2 ? n : fib(n - 1) + fib(n - 2)` },
  { name: 'factorial', kind: 'int',
    src: `export let fact = (n) => { let r = 1; for (let i = 2; i <= n; i++) r = (r * i) | 0; return r | 0 }` },
  { name: 'gcd (euclid)', kind: 'int',
    src: `export let gcd = (a, b) => { while (b !== 0) { let t = b; b = a % b | 0; a = t } return a | 0 }` },
  { name: 'collatz length', kind: 'int',
    src: `export let collatz = (n) => { let c = 0; while (n > 1) { n = (n & 1) === 0 ? (n / 2) | 0 : (3 * n + 1) | 0; c = c + 1 | 0 } return c | 0 }` },
  { name: 'sieve count (Int32Array)', kind: 'int',
    src: `export let primes = (n) => { const s = new Int32Array(n); let c = 0; for (let i = 2; i < n; i++) { if (s[i] === 0) { c = c + 1 | 0; for (let j = i * 2; j < n; j = j + i | 0) s[j] = 1 } } return c | 0 }` },
  { name: 'popcount loop', kind: 'int',
    src: `export let popcnt = (x) => { let c = 0; while (x !== 0) { c = (c + (x & 1)) | 0; x = x >>> 1 } return c | 0 }` },
  { name: 'integer pow', kind: 'int',
    src: `export let ipow = (b, e) => { let r = 1; for (let i = 0; i < e; i++) r = (r * b) | 0; return r | 0 }` },
  { name: 'sum multiples 3/5', kind: 'int',
    src: `export let sumdiv = (n) => { let s = 0; for (let i = 0; i < n; i++) if (i % 3 === 0 || i % 5 === 0) s = (s + i) | 0; return s | 0 }` },
  { name: 'reverse digits', kind: 'int',
    src: `export let rev = (n) => { let r = 0; while (n > 0) { r = (r * 10 + n % 10) | 0; n = (n / 10) | 0 } return r | 0 }` },
  // ── float (audit pointer hoisting only; f64 is intrinsic) ───────────────────
  { name: 'mandelbrot escape', kind: 'float',
    src: `export let mandel = (cx, cy, max) => { let zx = 0.0, zy = 0.0, i = 0; while (i < max && zx * zx + zy * zy <= 4.0) { let t = zx * zx - zy * zy + cx; zy = 2.0 * zx * zy + cy; zx = t; i = i + 1 | 0 } return i | 0 }` },
  { name: 'dot product (Float64Array)', kind: 'float',
    src: `export let dot = () => { const a = new Float64Array(256); const b = new Float64Array(256); let s = 0.0; for (let i = 0; i < 256; i++) s = s + a[i] * b[i]; return s }` },
  { name: 'newton sqrt', kind: 'float',
    src: `export let nsqrt = (x) => { let g = x; for (let i = 0; i < 20; i++) g = (g + x / g) * 0.5; return g }` },
  { name: 'sum array (Float64Array)', kind: 'float',
    src: `export let sum = () => { const a = new Float64Array(1024); for (let i = 0; i < 1024; i++) a[i] = i * 0.5; let s = 0.0; for (let i = 0; i < 1024; i++) s = s + a[i]; return s }` },
]

const pad = (s, n) => String(s).padEnd(n)
const padL = (s, n) => String(s).padStart(n)

console.log('AssemblyScript-canon bias audit — jz on annotation-free JS\n')
console.log(`${pad('kernel', 30)} ${pad('kind', 6)} ${padL('bytes', 7)}  ${pad('counter-in-f64', 16)} ptr-decode-in-loop`)
console.log('─'.repeat(84))

let totalBytes = 0, compiled = 0
const gaps = []
for (const { name, kind, src } of CORPUS) {
  let bytes, tree
  try {
    const w = compile(src, { optimize: 2 })
    bytes = w.byteLength ?? Buffer.byteLength(w)
    tree = parse(src, 2)
  } catch (e) {
    console.log(`${pad(name, 30)} ${pad(kind, 6)} ${padL('ERR', 7)}  ${e.message.slice(0, 40)}`)
    continue
  }
  compiled++; totalBytes += bytes
  const cnt = loopHas(tree, COUNTER_CMP_F64)
  const ptr = loopHas(tree, PTR_HELPER)
  if (cnt || ptr) gaps.push({ name, cnt, ptr })
  console.log(`${pad(name, 30)} ${pad(kind, 6)} ${padL(bytes, 7)}  ${pad(cnt ? '✗ bound not snapped' : '✓ i32', 16)} ${ptr ? '✗ per-iter decode' : '✓ hoisted'}`)
}

console.log('─'.repeat(84))
console.log(`compiled ${compiled}/${CORPUS.length}, total ${totalBytes} bytes (${Math.round(totalBytes / compiled)} avg)`)
if (!gaps.length) {
  console.log(`\nPASS: no counter-in-f64 and no per-iteration pointer decode across the AS canon — no selection-bias gap found.`)
} else {
  console.log(`\nATTENTION: ${gaps.length} kernel(s) carry waste the in-house bench didn't surface:`)
  for (const g of gaps) console.log(`  ${g.name}: ${[g.cnt && 'counter compared in f64 — narrowLoopBound didn\'t snap the bound (operator other than `<`, or a counter it can\'t prove ≥0)', g.ptr && 'pointer re-decoded per iteration'].filter(Boolean).join('; ')}`)
  console.log(`(NB: f64 in the loop BODY from bare \`*\`/\`+\`/\`%\` is the integer-overflow contract, NOT a deopt — not counted here.)`)
}
