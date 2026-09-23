// Carried elements (src/compile/carry-elements.js): an element a loop stores
// for its next pass stays in a local across the back edge. Every kernel runs
// against the host; the stores wrap (Uint8, Int8), so the carried value must be
// the converted element, not the stored expression.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz, { compile } from '../index.js'
import { onKernel, levels } from './_matrix.js'
import { funcWat, oracle } from './util.js'

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
  const carried = funcWat(compile(src, { optimize: 'speed', wat: true }), 'f')
  const reloaded = funcWat(compile(src, { optimize: CARRY_OFF, wat: true }), 'f')
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
