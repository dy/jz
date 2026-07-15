// Abrupt-edge + OOB-sentinel value semantics — the 2026-07-15 miscompile family.
//
// (1) ABRUPT EDGES: a `break` reaches the loop exit — and a `continue` its back
// edge — carrying the flow state AT the statement. The interval walk once
// published fall-through-only exit states, so `if (c) { x = BIG; break }; x = 0`
// "proved" the post-loop read and emitted a RAW load: `a[x]` with x = BIG
// trapped (or read adjacent heap) instead of yielding `undefined`. Same class
// through do/for-of/labeled loops, switch case-selection, and try/catch
// exception edges (watr's deadset was also try_table-blind: it dropped the
// pre-try store the catch path reads — watr 5.6.1).
//
// (2) OOB SENTINEL: a checked typed read yields the UNDEF sentinel NaN in its
// miss arm. Consumed by f64 ARITHMETIC, hardware NaN propagation carries the
// PAYLOAD to the escape, where the boundary decoded it back as `undefined` —
// JS says ToNumber(undefined) = NaN. The producer/consumer seam now folds the
// miss arm statically (toNumF64 × checkedNumRead), f64 stores apply the spec
// ToNumber, and uninitialized `let`s coerce unless definitely assigned
// (ast.js firstRefKind).
//
// Every case runs the JS source as ground truth, then jz at O0/O2/O3 — the
// four values must agree exactly (NaN compares by Object.is semantics here).
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz from '../index.js'

const agree = (src) => {
  const ref = new Function(`${src.replace('export let f', 'let f')}; return f()`)()
  const out = [ref]
  for (const optimize of [0, 2, 3]) {
    const { exports } = jz(src, { optimize })
    out.push(exports.f())
  }
  return out
}
const allSame = (vals) => vals.every(v => Object.is(v, vals[0]) || (typeof v === 'number' && typeof vals[0] === 'number' && Number.isNaN(v) && Number.isNaN(vals[0])))

const CASES = {
  'while break exits with the mid-body state': `export let f = () => {
    let a = new Float64Array(2)
    a[0] = 7; a[1] = 8
    let x = 0, i = 0
    while (i < 6) {
      i = i + 1
      if (i == 3) { x = 1000000; break }
      x = 0
    }
    return a[x]
  }`,
  'for break exits with the mid-body state': `export let f = () => {
    let a = new Float64Array(2)
    a[0] = 7; a[1] = 8
    let x = 0
    for (let i = 0; i < 6; i++) {
      if (i == 3) { x = 1000000; break }
      x = 0
    }
    return a[x]
  }`,
  'continue carries its state to the next body top': `export let f = () => {
    let a = new Float64Array(2)
    a[0] = 7; a[1] = 8
    let x = 0, i = 0, s = 0
    while (i < 6) {
      i = i + 1
      if (i == 4) { x = 1000000; continue }
      s = s + a[x]
      x = 0
    }
    return s
  }`,
  'do-while break exit': `export let f = () => {
    let a = new Float64Array(2)
    a[0] = 7; a[1] = 8
    let x = 0, i = 0
    do {
      i = i + 1
      if (i == 3) { x = 1000000; break }
      x = 0
    } while (i < 6)
    return a[x]
  }`,
  'switch selects any case directly': `export let f = (v = 2) => {
    let a = new Float64Array(2)
    a[0] = 7; a[1] = 8
    let x = 1000000
    switch (v) {
      case 1: x = 0; break
      case 2: return a[x]
    }
    return a[x]
  }`,
  'exception edge keeps the pre-try store': `export let f = () => {
    let a = new Float64Array(2)
    a[0] = 7; a[1] = 8
    let x = 1000000, t = 0
    try { t = JSON.parse("nope").v; x = 0 } catch (e) { t = 1 }
    return a[x]
  }`,
  'labeled break crosses the inner loop': `export let f = () => {
    let a = new Float64Array(2)
    a[0] = 7; a[1] = 8
    let x = 0
    outer: for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        if (i == 1 && j == 1) { x = 1000000; break outer }
        x = 0
      }
    }
    return a[x]
  }`,
  'for-of break exit': `export let f = () => {
    let a = new Float64Array(2)
    a[0] = 7; a[1] = 8
    let x = 0
    for (let v of [1, 2, 3]) {
      if (v == 2) { x = 1000000; break }
      x = 0
    }
    return a[x]
  }`,
  'OOB read + add is NaN, not undefined': `export let f = () => {
    let a = new Float64Array(2)
    a[0] = 7; a[1] = 8
    let i = 5
    return a[i] + 1
  }`,
  'OOB read summed in a loop is NaN': `export let f = () => {
    let a = new Float64Array(2)
    a[0] = 7; a[1] = 8
    let s = 0
    for (let i = 0; i < 4; i++) s = s + a[i]
    return s
  }`,
  'OOB read × mul is NaN': `export let f = () => {
    let a = new Float64Array(2)
    a[0] = 7
    let i = 9
    return a[i] * 2
  }`,
  'OOB value stored into an f64 slot reads back NaN': `export let f = () => {
    let a = new Float64Array(2)
    a[0] = 7
    let b = new Float64Array(1)
    let i = 5
    b[0] = a[i]
    return b[0] + 1
  }`,
  'uninitialized let coerces to NaN in arithmetic': `export let f = () => {
    let t
    return t + 1
  }`,
  'OOB read observed directly stays undefined': `export let f = () => {
    let a = new Float64Array(2)
    let i = 5
    return a[i]
  }`,
  'OOB read === undefined stays true': `export let f = () => {
    let a = new Float64Array(2)
    let i = 5
    return a[i] === undefined
  }`,
  'OOB read ?? default takes the default': `export let f = () => {
    let a = new Float64Array(2)
    a[0] = 7
    let i = 5
    return a[i] ?? 42
  }`,
}

for (const [name, src] of Object.entries(CASES)) {
  test(`abrupt/oob: ${name}`, () => {
    const vals = agree(src)
    ok(allSame(vals), `js/o0/o2/o3 must agree: ${vals.map(String).join(' / ')}`)
  })
}

// The definite-assignment gate must NOT tax kernels: a `let` assigned in the
// while-cond (the fractal shape) or in BOTH if arms keeps clean numeric IR —
// pinned indirectly by test/examples.js (mandelbrot must vectorize); here pin
// the VALUE side so the gate never over-claims.
test('abrupt/oob: cond-assigned and both-arm-assigned lets stay exact', () => {
  const vals = agree(`export let f = () => {
    let sq, alt
    if (Math.PI > 3) alt = 2; else alt = 3
    let x = 1.5, s = 0, i = 0
    while ((sq = x * x) < 40) { s = s + sq + alt; x = x + 1; i = i + 1 }
    return s + i
  }`)
  ok(allSame(vals), `js/o0/o2/o3 must agree: ${vals.map(String).join(' / ')}`)
})
