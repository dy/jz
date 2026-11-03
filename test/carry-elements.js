// Carried elements (src/compile/carry-elements.js): an element a loop stores
// for its next pass stays in a local across the back edge. Every kernel runs
// against the host; the stores wrap (Uint8, Int8), so the carried value must be
// the converted element, not the stored expression.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { onKernel, levels } from './_matrix.js'
import { funcWat, oracle, jz, compile } from './util.js'
import { compileJzAt } from '../bench/_lib/compile.js'
import { compileInternal } from '../src/compiler.js'
import jzify from '../jzify/index.js'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const CARRY_OFF = { level: 'speed', carryElements: false }
const kernel = (ctor, store) => `
const f = (v, z, n) => { let k = 0, s = 0
  v[0] = 3
  for (let q = 1; q < n; q++) {
    const t = v[k]
    s = s * 7 + t | 0
    k = (k + 1) & 7
    v[k] = ${store}
    z[k] = s
  }
  return s + '/' + z[k] }
export let run = (n) => { const v = new ${ctor}(8), z = new Float64Array(8); return f(v, z, n | 0) }`

const CASES = {
  int32: kernel('Int32Array', 'q * 3 - 7'),
  uint8: kernel('Uint8Array', 'q * 37'),
  int8: kernel('Int8Array', 'q * 45 - 100'),
  float64: kernel('Float64Array', 'q / 3'),
  // two carried elements in one loop, each through its own cursor
  twoCarried: `const f = (v, w, n) => { let k = 0, j = 0, s = 0
      for (let q = 1; q < n; q++) { const a = v[k], b = w[j]; s = s * 3 + a + b | 0; k = (k + 1) & 3; j = (j + 3) & 3; v[k] = q; w[j] = q * 2 }
      return s }
    export let run = (n) => f(new Int32Array(4), new Int32Array(4), n | 0)`,
}

test('carried elements: the carried value is the converted element, at every level', () => {
  for (const [name, src] of Object.entries(CASES)) {
    const native = oracle(src).run
    for (const optimize of [...levels(0, 2, 3, 'size'), CARRY_OFF]) {
      const wasm = jz(src, { optimize }).exports.run
      for (const n of [0, 1, 2, 3, 9, 40]) is(wasm(n), native(n), `${name} ${JSON.stringify(optimize)}: run(${n})`)
    }
  }
})

test('carried elements: the next pass reads the stored element from a local', () => {
  if (onKernel()) return
  // the i32 loads inside the function's loops (a paren-matched `(loop …)`)
  const loopText = (w) => {
    let out = '', i = 0
    while ((i = w.indexOf('(loop ', i)) >= 0) {
      let d = 0, j = i
      for (; j < w.length; j++) { if (w[j] === '(') d++; else if (w[j] === ')' && --d === 0) break }
      out += w.slice(i, j + 1); i = j
    }
    return out
  }
  const loads = (w) => (loopText(w).match(/\(i32\.load(?!8|16)/g) || []).length
  const src = CASES.int32
  // pre-watr: `run` releases what it made as it returns, so its call of `f` is one watr inlines
  const carried = funcWat(compile(src, { optimize: { level: 'speed', watr: false }, wat: true }), 'f')
  const reloaded = funcWat(compile(src, { optimize: { ...CARRY_OFF, watr: false }, wat: true }), 'f')
  ok(/\(local \$[^\s)]*ce\d+_v i32\)/.test(carried), 'the carried element is an i32 local')
  is(loads(carried), loads(reloaded) - 1, 'the loop no longer loads v[k]')
})

// Declines, each against the host: a store the program cannot prove in bounds
// (a dropped store leaves the element undefined), a `continue` that skips the
// store, a tail that moves the index, and a tail that calls a function.
test('carried elements: an unproven store, a skipped store, a moved index and a call keep the loads', () => {
  const cases = {
    unproven: `const f = (v, n, m) => { let k = 0, s = 0
        for (let q = 1; q < n; q++) { const t = v[k]; s = s * 5 + (t | 0) | 0; k = q % m; v[k] = q }
        return s }
      export let run = (n) => f(new Int32Array(4), n | 0, 6)`,
    skipped: `const f = (v, n) => { let k = 0, s = 0
        for (let q = 1; q < n; q++) { const t = v[k]; s = s * 5 + t | 0; if (q % 3 === 0) continue; k = q & 3; v[k] = q }
        return s }
      export let run = (n) => f(new Int32Array(4), n | 0)`,
    moved: `const f = (v, n) => { let k = 0, s = 0
        for (let q = 1; q < n; q++) { const t = v[k]; s = s * 5 + t | 0; v[k] = q; k = (k + 1) & 3 }
        return s }
      export let run = (n) => f(new Int32Array(4), n | 0)`,
    called: `const bump = (v) => { v[0] = v[0] + 1; return 1 }
      const f = (v, n) => { let k = 0, s = 0, calls = 0
        for (let q = 1; q < n; q++) { const t = v[k]; s = s * 5 + t | 0; k = q & 3; v[k] = q; calls += bump(v) }
        return s + '/' + calls }
      export let run = (n) => f(new Int32Array(4), n | 0)`,
  }
  for (const [name, src] of Object.entries(cases)) {
    const native = oracle(src).run
    for (const optimize of levels(0, 2, 3, 'size')) {
      const wasm = jz(src, { optimize }).exports.run
      for (const n of [0, 1, 2, 7, 20]) is(wasm(n), native(n), `${name}(${n}), O${optimize}`)
    }
  }
})

// A pushed counter (`v[k] = q`, a monotone stack's top) whose element the list before the
// loop left at the counter's first value less its step: every pass reads `q - step`, no
// local crosses the back edge, and a difference with the counter cancels (`2 * q - 2 * t`).
// (a counter the compiler holds to a word: below a masked bound)
const LAGGED = (bottom, step, ctor) => `
const f = (v, n, seed) => { let k = 0, s = seed | 0
  v[0] = ${bottom}
  for (let q = 1; q < (n & 255); q += ${step}) {
    const t = v[k]
    s = (s * 31 + 3 / (2.0 * q - 2.0 * t) * 7 + t) | 0
    k = (s >>> 3) & 7
    v[k] = q
  }
  return s + '/' + v[k] }
export let run = (n, seed) => f(new ${ctor}(8), n | 0, seed | 0)`

test('carried elements: a pushed counter whose bottom holds the index before the first reads the counter less its step', () => {
  const cases = { lag1: LAGGED(0, 1, 'Int32Array'), lag2: LAGGED(-1, 2, 'Int32Array'), lagF64: LAGGED(0, 1, 'Float64Array'),
    offByOne: LAGGED(1, 1, 'Int32Array'), bytes: LAGGED(0, 1, 'Uint8Array'),
    // a bottom stored past the array's end is dropped: the first pass reads undefined
    dropped: LAGGED(0, 1, 'Int32Array').replace('let k = 0', 'let k = 8').replace('v[0] = 0', 'v[8] = 0') }
  for (const [name, src] of Object.entries(cases)) {
    const native = oracle(src).run
    for (const optimize of [...levels(0, 2, 3, 'size'), CARRY_OFF]) {
      const wasm = jz(src, { optimize }).exports.run
      for (const n of [0, 1, 2, 3, 9, 40, 300]) for (const seed of [0, 5]) is(wasm(n, seed), native(n, seed), `${name} ${JSON.stringify(optimize)}: run(${n}, ${seed})`)
    }
  }
  if (onKernel()) return
  const local = (src) => /\(local \$[^\s)]*ce\d+_v (i32|f64)\)/.test(funcWat(compile(src, { optimize: { level: 'speed', watr: false }, wat: true }), 'f'))
  // (the speed tier inlines `f` into `run`: its divisions are the kernel's; the
  // runtime's number formatting, `s + '/'`, divides in a function of its own)
  const divides = (src) => /\(f64\.div\b/.test(funcWat(compile(src, { optimize: 'speed', wat: true }), 'run'))
  ok(!local(cases.lag1) && !local(cases.lag2), 'the lagged counter needs no carried local')
  ok(!divides(cases.lag1) && !divides(cases.lag2), 'its difference with the counter cancels: no division')
  ok(local(cases.offByOne) && divides(cases.offByOne), 'a bottom that is not the counter\'s previous value is carried, and divides')
})

// The lower envelope's first parabola meets the one pushed last pass: `v[k]` is `q - 1`, its
// denominator `2q - 2v[k]` is 2, and the division a multiply (the sdf bench, whose arrays the
// compiler places, so the push is proven in bounds).
test('carried elements: the envelope\'s first boundary divides by nothing', () => {
  if (onKernel()) return
  const c = { id: 'sdf', js: join(ROOT, 'bench/sdf/sdf.js') }
  const edt = (optimize) => funcWat(compileJzAt(c, optimize, (code, opts) => compileInternal(code, { ...opts, wat: true }, jzify)), 'edt1d')
  const divs = (w) => (w.match(/\(f64\.div\b/g) || []).length
  const lagged = edt({ level: 'speed' }), carried = edt(CARRY_OFF)
  is(divs(lagged), divs(carried) - 1, 'a division fewer')
  ok(!/ce\d+_v/.test(lagged), 'no carried local')
})

// A difference whose integer names cancel is its literal; a Number that is not an integer keeps
// its arithmetic (`(x + 1) - x` is 2 at 1e16).
test('a difference whose integer names cancel folds to its literal', () => {
  const src = `export let f = (n) => { let s = 0
      for (let i = 1, m = n | 0; i < m; i++) s += 3 / (2 * i - 2 * (i - 1)) + ((i + 7) - (i - 2))
      return s }
    export let g = (x) => (x + 1) - x
    export let h = (a) => { const b = new Float64Array(1); b[0] = a; return (b[0] * 2 + 1) - b[0] * 2 }`
  const native = oracle(src)
  for (const optimize of levels(0, 2, 3, 'size')) {
    const { f, g, h } = jz(src, { optimize }).exports
    for (const n of [0, 1, 2, 9]) is(f(n), native.f(n), `f(${n}) O${optimize}`)
    for (const x of [0, -0, 0.5, 1e16, -1e16, 2 ** 53, Infinity, NaN]) { is(g(x), native.g(x), `g(${x})`); is(h(x), native.h(x), `h(${x})`) }
  }
  if (onKernel()) return
  ok(!/\(f64\.div\b/.test(funcWat(compile(src, { optimize: 'speed', wat: true }), 'f')), 'the cancelled divisor leaves no division')
})
