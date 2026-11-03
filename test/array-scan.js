// A counted loop indexing arrays by its counter under another bound (a
// constant, a count, another array's length) runs in bounds up to the shortest
// length and as written past it (plan/loops.js splitArrayScanLoops); a loop
// from a constant start under the array's own length is in bounds outright
// (type/canonical-bounds.js scanBoundedArrIdx). Both answer what the host
// answers wherever the split must keep the loop as written: growth past the
// end, holes, a fractional, NaN or negative bound, a start past the length, a
// string element's concatenation, a `continue` and a `return` in the body, a
// copy a later pass makes of the main loop.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { belowOpt, levels } from './_matrix.js'
import { funcWat, oracle, run, wat } from './util.js'

const src = `
const N = 2
const build = (n) => { const a = []; for (let i = 0; i < n; i++) a.push(i); return a }
// every slot of an array as one number: a hole, NaN and a string each marked apart
const digest = (a) => {
  let h = a.length
  for (let i = 0; i < a.length; i++) {
    const v = a[i]
    h = (h * 31 + (v === undefined ? 7 : typeof v === 'string' ? v.length * 1000 : v !== v ? 13 : v)) | 0
  }
  return h
}
const bumpTo6 = (a) => { for (let i = 0; i < 6; i++) a[i] = a[i] + 1; return a }
const bumpTo = (a, n) => { for (let i = 0; i < n; i++) a[i] = a[i] + 1; return a }
const doubleInto = (a, b) => { for (let i = 0; i < a.length; i++) b[i] = a[i] * 2; return b }
const fillFrom5 = (a) => { for (let i = 5; i < 8; i++) a[i] = a[i] === undefined ? i : a[i] + 10; return a }
const skip2 = (a) => { for (let i = 0; i < 5; i++) { if (i === 2) continue; a[i] = a[i] * 3 } return a }
const stopAt = (a, v) => { for (let i = 0; i < 6; i++) { if (a[i] > v) return i; a[i] = -a[i] } return -1 }
const fromN = (a) => { for (let i = N + 1; i < a.length; i++) a[i] = a[i] + 1; return a }
export const fixed = (len) => digest(bumpTo6(build(len)))
export const counted = (len, n) => digest(bumpTo(build(len), n))
export const pair = (la, lb) => digest(doubleInto(build(la), build(lb)))
export const offset = (len) => digest(fillFrom5(build(len)))
export const mixed = (len) => { const a = build(len); a[1] = 'ab'; return digest(bumpTo6(a)) }
export const holes = (len) => { const a = build(len); a[len + 2] = 7; return digest(bumpTo(a, len + 4)) }
export const skip = (len) => digest(skip2(build(len)))
export const stop = (len, v) => { const a = build(len); return stopAt(a, v) * 100000 + digest(a) }
export const from = (len) => digest(fromN(build(len)))
// (a later pass copies the main loop, here on a receiver that may be missing: the tail reads the bound both see)
const filter = (data, params) => {
  const n = params.coefs.length
  if (!params.state) { params.state = new Array(n); for (let i = 0; i < n; i++) params.state[i] = [0, 0] }
  const state = params.state, c = params.coefs
  for (let i = 0; i < data.length; i++) {
    let x = data[i]
    for (let j = 0; j < n; j++) { const s = state[j], y = c[j] * x + s[0]; s[0] = c[j] * 0.5 * x - 0.25 * y + s[1]; s[1] = 0.125 * x - 0.0625 * y; x = y }
    data[i] = x
  }
  return data
}
export const filtered = (len, k) => {
  const d = []
  for (let i = 0; i < len; i++) d.push(((i * 37) % 11 - 5) * k)
  const p = { coefs: [0.9, 0.8, 0.7] }
  filter(d, p); filter(d, p)
  let h = 0
  for (let i = 0; i < len; i++) h += d[i] * (i + 1)
  return h
}`

const calls = [
  ...[0, 3, 6, 9].map(len => ['fixed', len]),
  ...[[0, 0], [5, 2.5], [5, 4], [3, 7], [4, NaN], [4, -3], [4, -2.5], [6, 6]].map(a => ['counted', ...a]),
  ...[[3, 0], [3, 2], [3, 5], [0, 4]].map(a => ['pair', ...a]),
  ...[0, 3, 5, 6, 10].map(len => ['offset', len]),
  ...[2, 4, 8].map(len => ['mixed', len]),
  ...[0, 2, 5].map(len => ['holes', len]),
  ...[0, 3, 7].map(len => ['skip', len]),
  ...[[0, 1], [4, 1], [4, 9], [8, 6]].map(a => ['stop', ...a]),
  ...[0, 2, 3, 6].map(len => ['from', len]),
  ...[[0, 1], [5, 0.3], [40, 0.07]].map(a => ['filtered', ...a]),
]

test('array scan: split and constant-start loops answer what the host answers', () => {
  const host = oracle(src)
  for (const optimize of levels(0, 2, 3, 'size')) {
    const jz = run(src, { optimize })
    for (const [name, ...args] of calls) is(jz[name](...args), host[name](...args), `${name}(${args.join(', ')}) at ${optimize}`)
  }
})

// The innermost loops of a function's text.
const innerLoops = (text) => {
  const out = []
  for (let at = text.indexOf('(loop '); at >= 0; at = text.indexOf('(loop ', at + 1)) {
    let depth = 0, end = at
    for (; end < text.length; end++) { if (text[end] === '(') depth++; else if (text[end] === ')' && --depth === 0) break }
    const body = text.slice(at + 6, end)
    if (!body.includes('(loop ')) out.push(body)
  }
  return out
}
const shape = { sourceInline: false, watr: false }   // (each kernel a function of its own)

test('array scan: under a bound other than the length, the main loop stores in place', () => {
  if (belowOpt(2)) return
  for (const level of [2, 'speed']) {
    const text = wat(src, { optimize: { level, ...shape } })
    for (const name of ['bumpTo6', 'bumpTo', 'doubleInto']) {
      const loops = innerLoops(funcWat(text, name))
      ok(loops.some(l => /f64\.store/.test(l) && !/\$__arr_set_idx_ptr/.test(l)), `${name} at ${level}: a loop stores without the growth call`)
      ok(loops.some(l => /\$__arr_set_idx_ptr/.test(l)), `${name} at ${level}: the steps past the end keep it`)
    }
  }
})

// The tail's counter starts where the main loop's stopped, at the min of the
// bound and the length, in a word: an index (the summary's hull of the bound,
// the word's integrality), so neither its store nor a read of the array
// elsewhere (`a[a.length - 1]`) takes the named-property path. The second
// kernel is the mixed array of a downgraded scan, its loop inside another,
// whose tail counter only the word makes whole.
const kernels = [
  [`const build = (n) => { const a = []; for (let i = 0; i < n; i++) a.push(i); return a }
  const bump = (a) => { for (let i = 0; i < 6; i++) a[i] = a[i] + 1; return a[0] + a[a.length - 1] }
  export const go = (n) => bump(build(n)) + bump(build(n + 1))`, [0, 1, 5, 6, 9]],
  [`const N = 50
  const build = (n) => { const a = []; for (let i = 0; i < n; i++) a.push(i); a[N] = { value: 7 }; a[N + 1] = 'tail'; return a }
  const bump = (a) => {
    let sum = 0
    for (let r = 0; r < 3; r++) {
      for (let i = 0; i < N; i++) a[i] = a[i] + 1
      sum = sum + a[0] + a[a.length - 1] + a[N].value
      if (a[N + 1] !== '') sum = sum + 3
    }
    return sum
  }
  export const go = (n) => bump(build(n))`, [0, 10, 50, 60]],
]

test('array scan: the tail counter is an index', () => {
  for (const [kernel, inputs] of kernels) {
    const host = oracle(kernel)
    for (const optimize of levels(0, 2, 3, 'size')) {
      const jz = run(kernel, { optimize })
      for (const n of inputs) is(jz.go(n), host.go(n), `go(${n}) at ${optimize}`)
    }
  }
  if (belowOpt(2)) return
  for (const level of [2, 'speed']) {
    const [plain, mixed] = kernels.map(([kernel]) => wat(kernel, { optimize: { level, ...shape } }))
    ok(!/\$__dyn_set\b/.test(plain) && !/\$__dyn_set\b/.test(mixed), `at ${level}: the tail stores at an index`)
    ok(!/\$__arr_prop\b/.test(plain), `at ${level}: the array holds no named numeric property`)
  }
})

// A bound a constant declared before the loop holds below the lengths
// (`const n = a.length`, a `Math.min` of several) proves the loop in bounds as
// a bound of `a.length` itself does, while nothing between shrinks an array:
// a `pop` between keeps the loop as written.
const declared = `const build = (n) => { const a = []; for (let i = 0; i < n; i++) a.push(i); return a }
  const digest = (a) => { let h = a.length; for (let i = 0; i < a.length; i++) h = (h * 31 + (a[i] === undefined ? 7 : a[i] !== a[i] ? 13 : a[i])) | 0; return h }
  const bumpN = (a) => { const n = a.length; for (let i = 0; i < n; i++) a[i] = a[i] + 1; return a }
  const sum2 = (a, b) => { const n = Math.min(a.length, b.length); for (let i = 0; i < n; i++) a[i] = a[i] + b[i]; return a }
  const shrunk = (a) => { const n = a.length; a.pop(); for (let i = 0; i < n; i++) a[i] = a[i] + 1; return a }
  export const one = (len) => digest(bumpN(build(len))) + digest(bumpN(build(len + 1)))
  export const two = (la, lb) => digest(sum2(build(la), build(lb))) + digest(sum2(build(lb), build(la)))
  export const three = (len) => digest(shrunk(build(len))) + digest(shrunk(build(len + 1)))`

test('array scan: a bound declared before the loop', () => {
  const host = oracle(declared)
  for (const optimize of levels(0, 2, 3, 'size')) {
    const jz = run(declared, { optimize })
    for (const len of [0, 1, 4]) {
      is(jz.one(len), host.one(len), `one(${len}) at ${optimize}`)
      is(jz.three(len), host.three(len), `three(${len}) at ${optimize}`)
      for (const lb of [0, 2, 6]) is(jz.two(len, lb), host.two(len, lb), `two(${len}, ${lb}) at ${optimize}`)
    }
  }
  if (belowOpt(2)) return
  for (const level of [2, 'speed']) {
    const text = wat(declared, { optimize: { level, ...shape } })
    for (const name of ['bumpN', 'sum2']) ok(!/\$__arr_set_idx_ptr/.test(funcWat(text, name)), `${name} at ${level}: in bounds, nothing grows`)
    ok(/\$__arr_set_idx_ptr/.test(funcWat(text, 'shrunk')), `shrunk at ${level}: a pop between keeps the growth call`)
  }
})

test('array scan: a constant start under the length is in bounds', () => {
  if (belowOpt(2)) return
  for (const level of [2, 'speed']) {
    const body = funcWat(wat(src, { optimize: { level, ...shape } }), 'fromN')
    ok(/f64\.store/.test(body) && !/\$__arr_set_idx_ptr/.test(body), `fromN at ${level}: stores in place, nothing grows`)
  }
})

// A store a canonical loop holds inside the length writes a cell the array
// has: the frame census counts no growth (analyze/frame-effects.js), so no
// mark of the heap's top stands around it.
const bounded = `const build = (n) => { const a = []; for (let i = 0; i < n; i++) a.push(i); return a }
  const bump = (a) => { for (let i = 0; i < a.length; i++) a[i] = a[i] + 1; return a[0] }
  export const go = (n) => bump(build(n)) + bump(build(n + 1))`

test('array scan: a store inside the length grows nothing', () => {
  const host = oracle(bounded)
  for (const optimize of levels(0, 2, 3, 'size')) {
    const jz = run(bounded, { optimize })
    for (const n of [0, 1, 7]) is(jz.go(n), host.go(n), `go(${n}) at ${optimize}`)
  }
  if (belowOpt(2)) return
  for (const level of [2, 'speed']) {
    const body = funcWat(wat(bounded, { optimize: { level, ...shape } }), 'bump')
    ok(!/global\.get \$__heap(?![\w.])/.test(body), `at ${level}: no mark of the heap's top around the store`)
  }
})

// The size tier stores in place inside the length as the speed tiers do, with
// no growth call beside the store (emit-assign.js storeArrayPayload).
test('array scan: the size tier stores in place inside the length', () => {
  const body = funcWat(wat(bounded, { optimize: { level: 'size', ...shape } }), 'bump')
  ok(/f64\.store/.test(body) && !/\$__arr_set_idx_ptr/.test(body), 'the size tier stores in place, no growth call')
})
