#!/usr/bin/env node
// Cold-start / REPL benchmark: substantiates (or refutes) the "compiles faster
// than eval" claim. Measures the *time-to-first-result* path that live-coding
// actually experiences, for jz vs the JS engine's own `new Function`.
//
//   jz   src→wasm  (compile)  +  wasm→instance         = jz cold (ready to call)
//   js   new Function(src)    +  first invocation       = js  cold (first result)
//
// Caveat made explicit in the output: `new Function` parses eagerly but compiles
// the body *lazily* — V8 only emits bytecode on first call, then tiers up on
// repeat. So the fair "ready to produce a result" comparison includes one JS
// call. jz is AOT: its first call is already native. Warm per-call is reported
// separately to keep the startup axis and the steady-state axis distinct.
//
// Snippets are pure scalar kernels (no heap, no imports) so they are valid jz
// *and* valid standalone JS — the whole point of `valid jz = valid JS`.

import { compile } from '../index.js'

const args = process.argv.slice(2)
const itersArg = args.find(a => a.startsWith('--iters='))
const ITERS = Math.max(5, Number(itersArg?.slice(8)) || 31)        // cold-path samples
const WARM = 200_000                                                // warm-call samples

// Each snippet: a bare arrow source, valid as both `export let f = <src>` (jz)
// and `new Function('return (' + <src> + ')')` (js), plus sample call args.
const snippets = [
  { name: 'dist',   src: `(x, y) => (x*x + y*y) ** 0.5`, args: [3, 4] },
  { name: 'poly',   src: `(x) => { let s = 0; for (let i = 0; i < 8; i++) s = s*x + i; return s }`, args: [1.5] },
  { name: 'loop1k',  src: `(n) => { let s = 0; for (let i = 0; i < n; i++) s += i*i - (i>>1); return s }`, args: [1000] },
  { name: 'mandel',  src: `(cx, cy) => { let x = 0, y = 0, i = 0; while (i < 1000 && x*x + y*y < 4) { let t = x*x - y*y + cx; y = 2*x*y + cy; x = t; i++ } return i }`, args: [-0.5, 0.6] },
  { name: 'collatz', src: `(n) => { let s = 0; while (n > 1) { n = (n & 1) ? 3*n + 1 : n >> 1; s++ } return s }`, args: [97] },
]

const median = xs => { const a = [...xs].sort((p, q) => p - q); return a[a.length >> 1] }
const fmt = n => n == null ? '   n/a' : (n < 10 ? n.toFixed(3) : n.toFixed(2))

// Time a thunk `reps` times, return median ms per call.
const timeMed = (fn, reps = ITERS) => {
  const samples = []
  for (let i = 0; i < reps; i++) {
    const t = performance.now()
    fn()
    samples.push(performance.now() - t)
  }
  return median(samples)
}

// Warm steady-state: median ms per call over a long inner loop, outer-median'd.
const timeWarm = (fn, a0, a1) => {
  fn(a0, a1) // prime
  const trial = () => {
    const t = performance.now()
    for (let i = 0; i < WARM; i++) fn(a0, a1)
    return (performance.now() - t) / WARM
  }
  for (let i = 0; i < 3; i++) trial() // jit warmup
  const s = []
  for (let i = 0; i < 7; i++) s.push(trial())
  return median(s)
}

// Warm up the jz compiler itself (V8 tiers it up) so per-case numbers reflect
// amortized REPL compile cost, not the one-time first-ever-compile spike. Use
// the actual snippets (plus a few op variants) so feature-specific compiler
// paths — `**`, bitwise, loops — are all tiered before measuring.
for (let i = 0; i < 30; i++) {
  for (const { src } of snippets) compile(`export let w = ${src}`)
  compile(`export let w = (a) => (a*a) ** 0.5 + (a|0) - (a>>2)`)
}

console.log(`startup / REPL timing  (median over ${ITERS} cold samples, jz compiler pre-warmed; ms)`)
console.log(`note: js cold = new Function + 1 call (lazy body compile fires on first call); jz is AOT`)
console.log('')
console.log('case      jzCompile  jzInst   jzCold  |  jsNewFn  jsCold  |  cold×   |  jzWarm   jsWarm   warm×   bytes')
console.log('─'.repeat(104))

for (const { name, src, args: callArgs } of snippets) {
  const jzSrc = `export let f = ${src}`
  const jsSrc = `return (${src})`

  // jz: source → wasm
  const jzCompile = timeMed(() => compile(jzSrc))
  const wasm = compile(jzSrc)

  // jz: wasm → instance (raw, no interop wrapper — the minimal callable)
  const jzInst = timeMed(() => {
    const mod = new WebAssembly.Module(wasm)
    new WebAssembly.Instance(mod)
  })

  // js: source → callable (eager parse, lazy body compile)
  const jsNewFn = timeMed(() => new Function(jsSrc)())

  // js cold: new Function + first call → first actual result
  const jsCold = timeMed(() => { new Function(jsSrc)()(...callArgs) })
  const jzCold = jzCompile + jzInst

  // warm callables
  const jzInstance = new WebAssembly.Instance(new WebAssembly.Module(wasm))
  const jzFn = jzInstance.exports.f
  const jsFn = new Function(jsSrc)()
  const jzWarm = timeWarm(jzFn, callArgs[0], callArgs[1])
  const jsWarm = timeWarm(jsFn, callArgs[0], callArgs[1])

  const coldRatio = jsCold > 0 ? jzCold / jsCold : null     // <1 ⇒ jz cold beats eval
  const warmRatio = jzWarm > 0 ? jsWarm / jzWarm : null     // >1 ⇒ jz warm beats js

  console.log(
    `${name.padEnd(9)} ${fmt(jzCompile).padStart(8)} ${fmt(jzInst).padStart(7)} ${fmt(jzCold).padStart(8)}  | ` +
    `${fmt(jsNewFn).padStart(7)} ${fmt(jsCold).padStart(7)}  | ` +
    `${(coldRatio == null ? 'n/a' : coldRatio.toFixed(2) + '×').padStart(6)}  | ` +
    `${fmt(jzWarm).padStart(7)} ${fmt(jsWarm).padStart(7)} ${(warmRatio == null ? 'n/a' : warmRatio.toFixed(1) + '×').padStart(6)} ` +
    `${String(wasm.byteLength).padStart(7)}`
  )
}

console.log('')
console.log('cold× <1 ⇒ jz source→callable is faster than new Function→first result')
console.log('warm× >1 ⇒ jz steady-state call is faster than the JS engine (post-JIT)')
