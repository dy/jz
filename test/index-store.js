// An element store whose index the summary cannot bound (`out[k] = v` into an
// array that grew last round, `indices[k] = indices[k + 1]`) stores in place
// when the index is inside the length and asks the helper only past it: the
// helper's growth, its hole fill and its negative-index property write are
// unchanged (emit-assign.js storeArrayPayload).
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { belowOpt, levels } from './_matrix.js'
import { funcWat, oracle, run, wat } from './util.js'

const fnText = (text, name) => funcWat(text, name + '$exp') || funcWat(text, name)

const src = `const out = []
  export const fill = (n) => { for (let i = 0; i < n; i++) out[i] = i * 2; return out.length }
  export const at = (i) => out[i] === undefined ? -1 : out[i]
  export const shift = (n) => { for (let k = 0; k < n; k++) out[k] = out[k + 1]; return out[0] }
  export const gap = () => { const v = [1]; v[3] = 4; return v.length * 10 + (v[1] === undefined ? 1 : 0) }
  export const neg = () => { const v = [1, 2]; v[-1] = 9; return v.length * 10 + v[0] }`

test('index store: growth, in-place stores, holes and a negative index answer what the host answers', () => {
  for (const optimize of levels(0, 2, 3)) {
    const host = oracle(src), jz = run(src, { optimize })
    const steps = [['fill', 5], ['at', 3], ['at', 5], ['fill', 3], ['at', 4], ['shift', 4], ['at', 0], ['at', 3], ['fill', 8], ['at', 7], ['gap'], ['neg']]
    for (const [name, ...args] of steps) is(jz[name](...args), host[name](...args), `${name}(${args.join(', ')}) at ${optimize}`)
  }
})

test('index store: the in-range store is a plain store, the helper stands behind the bounds test', () => {
  if (belowOpt(2)) return
  const body = fnText(wat(src, { optimize: 2 }), 'fill')
  ok(/f64\.store/.test(body), 'the in-range arm stores directly')
  ok(/call \$__arr_set_idx_ptr/.test(body), 'the helper remains for an index at or past the end')
  ok(/i32\.lt_u/.test(body), 'one unsigned bounds test decides between them')
})

test('index store: possibly absent Number keys retain their named property', () => {
  const source = `export function f(mode) {
    const a = [2, 3]; let index; if (mode) index = 0
    const before = a[index]; let effects = 0
    const assigned = a[index] = (effects++, 19)
    return [before, assigned, a[0], a[index], effects]
  }`
  for (const optimize of levels(0, 1, 2, 3, 'size')) {
    const host = oracle(source), wasm = run(source, { optimize })
    for (const mode of [0, 0, 1, 0]) is(wasm.f(mode), host.f(mode), `O${optimize}, mode ${mode}`)
  }
})

test('index store: boxed keys agree across reads, growth and aliases', () => {
  const source = `export function f(mode, count) {
    const a = []; for (let i = 0; i < count; i++) a.push(i + 2)
    const alias = a
    let key
    if (mode === 1) key = 0
    else if (mode === 2) key = null
    else if (mode === 3) key = false
    else if (mode === 4) key = true
    else if (mode === 5) key = 'tag'
    else if (mode === 6) key = 1n
    else if (mode === 7) key = NaN
    const before = a[key]; let effects = 0
    const value = a[key] = (effects++, 19)
    a[8] = 31
    return [before, value, a[key], alias[key], a[0], a[1], a.length, effects]
  }
  export function boolean(n) { const a = [2]; a[n > 0] = 19; return [a[n > 0], a[0], a.length] }
  export function replace(mode) {
    const a = [{ x: 2 }]; let key; if (mode) key = 0
    a[key] = { x: 19 }; return [a[key].x, a[0].x]
  }`
  for (const optimize of levels(0, 1, 2, 3, 'size')) {
    const host = oracle(source), wasm = run(source, { optimize })
    for (const count of [0, 1, 2]) for (const mode of [0, 1, 2, 3, 4, 5, 6, 7, 0])
      is(wasm.f(mode, count), host.f(mode, count), `O${optimize}, key ${mode}, length ${count}`)
    for (const mode of [0, 1, 0]) {
      is(wasm.boolean(mode), host.boolean(mode), `O${optimize}: boolean expression ${mode}`)
      is(wasm.replace(mode), host.replace(mode), `O${optimize}: object value ${mode}`)
    }
  }
})

test('index store: receiver, key and RHS are captured before key coercion', () => {
  const source = `export function f(mode) {
    let effects = 0; const a = [2, 3]
    let key = { toString() { effects = effects * 10 + 3; if (mode === 2) throw 7; return mode ? '1' : 'name' } }
    try {
      const assigned = a[(effects = effects * 10 + 1, key)] =
        (effects = effects * 10 + 2, key = { toString() { return 'other' } }, 19)
      return [assigned, a[1], a.name, a.other, effects]
    } catch (e) { return [e, a[1], a.name, a.other, effects] }
  }
  export function rebind(key, rhs) {
    let a = [2, 3]; const old = a, b = [4, 5]
    const v = rhs ? a[key] = (a = b, 19) : a[(a = b, key)] = 19
    return [v, old[key], a[key], old[0], a[0]]
  }`
  for (const level of levels(0, 1, 2, 3, 'size')) {
    // Keep the coercion callback and its captured mutation as an actual call.
    const host = oracle(source), wasm = run(source, { optimize: { level, sourceInline: false } })
    for (const mode of [0, 0, 2, 1, 0]) is(wasm.f(mode), host.f(mode), `O${level}, mode ${mode}`)
    for (const rhs of [0, 1]) for (const key of [undefined, 0, 3, 'x'])
      is(wasm.rebind(key, rhs), host.rebind(key, rhs), `O${level}, rebind ${rhs}, key ${key}`)
  }
})

// A key with an effect is staged before the right side; the store after it is
// still the assignment's value where the program reads one (a void store there
// left the comparison an operand short: invalid wasm at every level).
test('index store: a staged key leaves the store its value', () => {
  const source = `export let f = () => { const t = new Float64Array(4), u = new Float64Array(4); let i = 0; while (i < 4 && (t[i++] = 1) > 0) { u[i] = 7; t[i] = 9 } return [t, u] }
    export let g = (n) => { const a = [0, 0, 0]; let k = 0, s = 0; while (k < n && (a[k++] = k * 2) < 5) s += a[k - 1]; return [s, a] }`
  for (const level of levels(0, 1, 2, 3, 'size', 'speed')) {
    const host = oracle(source), wasm = run(source, { optimize: level })
    is(wasm.f().map(a => [...a]), host.f().map(a => [...a]), `O${level}, typed`)
    for (const n of [0, 2, 3]) is(wasm.g(n), host.g(n), `O${level}, array ${n}`)
  }
})

// A store whose right side calls reads its receiver into a temp first
// (emit/assignment.js stagedReference).
test('index store: a binding staged before the right side follows its array as it grows', () => {
  const source = `export let table = []
    let made = 0
    const make = (k) => (made++, (a) => a + k)
    const reg = (c) => (table[c] = make(c % 3))
    let other = [1, 2, 3]
    const swap = () => { const prev = other; other = [9]; return prev.length }
    export function fill() { for (let c = 33; c < 127; c += 7) reg(c); return [table.length, made] }
    export function sum(s) { let n = 0; for (let i = 0; i < s.length; i++) { const f = table[s.charCodeAt(i)]; if (f) n += f(1) } return n }
    export function rebound() { other[50] = swap(); return [other.length, other[0]] }`
  for (const level of levels(0, 1, 2, 3, 'size')) {
    const host = oracle(source), wasm = run(source, { optimize: level })
    is(wasm.fill(), host.fill(), `O${level}, fill`)
    is(wasm.sum('!(/=DKRY`gnu|'), host.sum('!(/=DKRY`gnu|'), `O${level}, sum`)
    // the right side rebinds the binding: the store goes to the old array, the binding keeps the new one
    is(wasm.rebound(), host.rebound(), `O${level}, rebound`)
  }
  if (belowOpt(2)) return
  // (`reg` inlines into `fill`)
  ok(/global\.set \$table/.test(funcWat(wat(source, { optimize: 2 }), 'fill')), 'the growing store rebinds the module binding')
})

// A store into an array whose index is a Number no proof makes an element index
// takes the inline arm inside the length and one call past it: an element's
// growth, or the property any other Number names (module/collection.js
// `__arr_set_num`). A counter its loop bounds by a parameter, a running cursor
// and an affine index of a counter are element indices (static.js
// storeCounterTop, compile/analyze-scans.js stampStoreCursors): their stores
// link no hash store at all, and none warns of a dynamic write, the receiver
// being an array.
const HASH = /\$__dyn_set\b|\$__dyn_set_own\b|\$__hash_set_local\b|\$__typed_set_idx/
const kernels = [
  ['a counter a parameter bounds', `const buf = []
export let f = (n) => { for (let i = 0; i < n; i++) buf[i] = i; return buf[1] }`],
  ['a local array', `export let f = (n) => { const buf = []; for (let i = 0; i < n; i++) buf[i] = i; return buf[1] }`],
  ['a running cursor', `const buf = []
export let f = (n) => { let k = 0; for (let i = 0; i < n; i++) { buf[k++] = i; buf[k++] = i + 1 } return k + buf[1] }`],
  ["a helper's parameter", `const buf = []
const fill = (out, n) => { for (let i = 0; i < n; i++) out[i] = i }
export let f = (n) => { fill(buf, n); return buf[1] }`],
  ['an affine index under a constant of the counter', `const sol = [], bones = []
for (let i = 0; i < 100; i++) { bones.push({ s: [i, i + 1] }); sol.push(0, 0) }
const save = (bones, sol) => { for (let i = 0; i < bones.length; i++) { const b = bones[i], o = i * 2; sol[o] = b.s[0]; sol[o + 1] = b.s[1] } }
export let f = (n) => { save(bones, sol); return sol[1] }`],
  // two counters closing from both ends (pmndrs/math's reverse): the one taken up
  // by its step beside the other's, the one taken down held above it by the test
  // and below its start, a count the one call fixes (compile/analyze-scans.js, static.js counterMove)
  ['two counters closing from both ends', `const reverse = (out, v, n) => {
  for (let lo = 0, hi = n - 1; lo < hi; lo++, hi--) { const x = v[lo * 2], y = v[lo * 2 + 1]; out[lo * 2] = v[hi * 2]; out[lo * 2 + 1] = v[hi * 2 + 1]; out[hi * 2] = x; out[hi * 2 + 1] = y }
  return out
}
const pts = []
for (let i = 0; i < 48; i++) pts.push(i * 0.5)
const copy = (out, v, n) => { for (let k = 0; k < n * 2; k++) out[k] = v[k]; return reverse(out, out, n) }
export let f = (n) => copy([], pts, 24)[n & 31]`],
  // a cursor stepped after its store, in a loop the plan copies (a closed form and
  // an integral copy, each landing the cursor where the loop as written leaves it;
  // the copy's word stepped `(k + 1) | 0`, declared from the cursor's own value)
  ['a cursor stepped after its store, the loop copied', `const buf = []
export let f = (n) => { let k = 0; for (let i = 0; i < n; i++) { buf[k] = i; k++ } return k + buf[1] }`],
  ['a cursor two copied loops step', `export let f = (n) => { const out = []; let k = 0; for (let i = 0; i < n; i++) { out[k] = i; k++ } for (let i = 0; i < n; i++) { out[k] = -i; k++ } return k + out.length + out[k - 1] }`],
  ['a cursor a loop inside a loop steps', `export let f = (n) => { const buf = []; let k = 0; for (let j = 0; j < 3; j++) for (let i = 0; i < n; i++) { buf[k] = i + j; k++ } return k * 1000 + buf.length + buf[k - 1] }`],
]

// A landing proves nothing of its own: a cursor a copied loop moves by a fraction,
// a cursor stepped past a store a `try` holds, and every copy under coldTrap (the
// loop as written a throw, its landings standing alone) store at a Number key.
test('index store: a cursor the plan lands is an index only where its loop as written steps it by its stores', () => {
  const half = `export let f = (n) => { const buf = []; let k = 0; for (let i = 0; i < n; i++) { k += 0.5 } for (let i = 0; i < n; i++) { buf[k] = i; k++ } return buf.length * 1000 + (buf[k - 1] ?? -1) }`
  const tried = `export let f = (n) => { const buf = []; let k = 0; for (let i = 0; i < n; i++) { try { buf[k] = i } catch (e) {} k++ } return k + buf.length }`
  const after = kernels.find(([name]) => name.startsWith('a cursor stepped after'))[1]
  // (under coldTrap a count the copy is not for throws: the counts it is for)
  for (const src of [half, tried, after]) for (const optimize of levels(0, 2, 3, 'size', { level: 2, coldTrap: true }, { level: 3, coldTrap: true })) {
    const host = oracle(src), wasm = run(src, { optimize })
    for (const n of optimize?.coldTrap ? [0, 1, 3, 9] : [0, 1, 3, 7.5, -2]) is(wasm.f(n), host.f(n), `f(${n}) at ${JSON.stringify(optimize)}`)
  }
  if (belowOpt(2)) return
  for (const optimize of levels(2, 3)) {
    ok(/\$__arr_set_num\b/.test(wat(half, { optimize })), `a fractional step leaves a Number key at ${optimize}`)
    ok(/\$__arr_set_num\b/.test(wat(tried, { optimize })), `a store under try leaves a Number key at ${optimize}`)
  }
})

// The counter taken down at its edges, its value read at the test before a first round
// (a count of 0 or 1) and after the body's last step, each count fixed by its one call.
test('index store: two counters closing from both ends answer at every count', () => {
  const src = (n) => `const rev = (out, n) => {
  let last = -99
  for (let lo = 0, hi = n - 1; lo < hi; lo++, hi--) { const t = out[lo]; out[lo] = out[hi]; out[hi] = t; last = hi }
  for (let lo = 0, hi = n - 1; lo <= hi; lo++, hi--) { out[hi] = out[hi] + 1; last = last * 10 + hi }
  return last
}
export let f = () => { const a = [10, 20, 30, 40, 50]; const r = rev(a, ${n}); return r * 1000 + a[0] + a[1] * 3 + a[2] * 7 + a.length }`
  for (const n of [0, 1, 2, 3, 5, 7]) for (const optimize of levels(0, 2, 3, 'size'))
    is(run(src(n), { optimize }).f(), oracle(src(n)).f(), `a count of ${n} at ${optimize}`)
})

test('index store: the kernels answer what the host answers', () => {
  for (const [name, src] of kernels) for (const optimize of levels(0, 2, 3, 'size')) {
    const host = oracle(src), wasm = run(src, { optimize })
    for (const n of [3, 5, 9]) is(wasm.f(n), host.f(n), `${name}: f(${n}) at ${optimize}`)
  }
})

test('index store: a counter, a cursor and an affine index link no hash store and warn of no dynamic write', () => {
  if (belowOpt(2)) return
  for (const [name, src] of kernels) for (const optimize of levels(2, 3, 'size')) {
    const seen = []
    const text = wat(src, { optimize, warnings: (w) => seen.push(w.code) })
    ok(!HASH.test(text), `${name} at ${optimize}: no hash store`)
    ok(!/\$__arr_set_num\b/.test(text), `${name} at ${optimize}: an element index's call is the element store`)
    ok(!seen.includes('deopt-dyn-write'), `${name} at ${optimize}: no dynamic write`)
  }
})

// Any other Number key is one call past the inline arm: no key-kind dispatch.
test('index store: a Number key of any value is one call past the inline arm', () => {
  if (belowOpt(2)) return
  const src = `const buf = [1, 2, 3]
export let f = (k, v) => { buf[+k] = v; return buf.length }`
  for (const optimize of levels(2, 'size')) {
    const seen = []
    const text = wat(src, { optimize, warnings: (w) => seen.push(w.code) })
    // (the helper may be spliced into its one caller)
    ok(!/\$__dyn_set\b/.test(text), `no key-kind dispatch at ${optimize}`)
    ok(!seen.includes('deopt-dyn-write'), `no dynamic write warned at ${optimize}: the receiver is an array`)
  }
})

// An index names an element up to 2^32 - 2, a store at one an array cannot
// reach throws the allocation's RangeError (README: `32-bit element indices`),
// through a key of any kind; a Number past it, negative, fractional or NaN names
// a property, as the host stores it.
test('index store: an index past every length throws, any other Number stores its property', () => {
  const src = `const A = [1, 2, 3]
const T = [1, 2, 3]
export let num = (k, v) => { A[+k] = v; return A.length * 1000 + (A[k] === undefined ? -1 : A[k]) }
export let any = (k, v) => { T[k] = v; return T.length * 1000 + (T[k] === undefined ? -1 : T[k]) }
export let lit = () => { const L = [1]; L[3e9] = 5; return L.length }
export let wide = (i) => { const L = [1]; const o = (i >>> 0) * 2; L[o] = 5; return L.length }`
  const DENSE = 0x1ffffc00
  const store = (a, k, v) => { if (Number.isInteger(k) && k >= DENSE && k <= 4294967294) throw new RangeError('length'); a[k] = v }
  const host = { A: [1, 2, 3], T: [1, 2, 3] }
  const answer = (a, k, v) => { try { store(a, +k, v); return a.length * 1000 + (a[k] === undefined ? -1 : a[k]) } catch { return 'throws' } }
  const keys = [-1, 1.5, NaN, 2 ** 31, 3e9, 4294967294, 4294967295, 2 ** 32, 1e21, 5, -0]
  for (const optimize of levels(0, 2, 3, 'size')) {
    const wasm = run(src, { optimize })
    host.A = [1, 2, 3]; host.T = [1, 2, 3]
    for (const k of keys) for (const [name, arr] of [['num', 'A'], ['any', 'T']]) {
      let got
      try { got = wasm[name](k, 7) } catch { got = 'throws' }
      is(got, answer(host[arr], k, 7), `${name}(${k}) at ${optimize}`)
    }
    let lit
    try { lit = wasm.lit() } catch { lit = 'throws' }
    is(lit, 'throws', `a literal index past every length throws at ${optimize}`)
    let wide
    try { wide = wasm.wide(1610612736) } catch { wide = 'throws' }
    is(wide, 'throws', `an index past 2^31 an array cannot reach throws at ${optimize}`)
    is(wasm.wide(3), 7, `a small one grows the array at ${optimize}`)
  }
})

// A key that names no element below 2^31 is index -1 to the inline arm, whose
// test `-1 <u length` holds for no length. The intervals decide it (optimize/
// int-range.js: an unsigned compare of a word of known sign), so the arm is
// gone: left in, its store is folded to the header's offset, `base - 8`, which
// the effects solve refuses under JZ_DEBUG_INVARIANTS (optimize/address.js headerStore).
test('index store: a constant key that names no element leaves no inline arm', () => {
  if (belowOpt(2)) return
  const src = `export let past = () => { const L = [1]; L[3e9] = 5; return L.length }
export let frac = () => { const L = [1, 2]; L[1.5] = 5; return L.length }
export let nan = () => { const L = [1, 2]; L[NaN] = 5; return L.length }`
  for (const optimize of levels(2, 3)) {
    const text = wat(src, { optimize })
    for (const name of ['past', 'frac', 'nan']) {
      const body = fnText(text, name)
      ok(body && !/i32\.lt_u\s*\(i32\.const -1\)/.test(body), `${name}: no test of index -1 against a length at ${optimize}`)
      ok(body && !/\(i32\.add\s*\(local\.get \$[\w$]+\)\s*\(i32\.const -8\)\)/.test(body), `${name}: no address at the header's offset at ${optimize}`)
    }
    const host = oracle(src), wasm = run(src, { optimize })
    for (const name of ['frac', 'nan']) is(wasm[name](), host[name](), `${name}() at ${optimize}`)
  }
})

// A receiver that is an array where it is present (a local or a field holding null until
// it is given one) takes its store's key as a known array does: a Number that names no
// element (-1, 1.5, one past 2^32) names a property. The store there took every Number for
// an index, and the property was lost (emit-assign.js, case 6b).
test('index store: a Number that names no element is a property of an array that may be missing', () => {
  const head = `const side = (v) => v === undefined ? 0 : v\nconst X = [-1, 1.5, 0, 4294967297, 2, 5, 7]\n`
  const programs = {
    'a local': head + `const put = (v, i) => { let w = null; if (i !== 3) w = v; w[i] = 50 }
      export const go = (p) => { const a = [10, 20, 30]; put(a, X[p] * 1); return side(a[-1]) + side(a[1.5]) * 3 + side(a[0]) * 7 + side(a[4294967297]) * 11 + side(a[2]) * 13 + a.length * 1000 + side(a[5]) * 17 }`,
    'a field': head + `class Late { constructor() { this.v = null } fill(v) { this.v = v } put(i, x) { this.v[i] = x } get(i) { return this.v[i] } }
      export const go = (p) => { const a = [10, 20, 30]; const o = new Late(); if (p !== 9) o.fill(a); o.put(X[p] * 1, 50); return side(o.get(-1)) + side(o.get(1.5)) * 3 + side(o.get(0)) * 7 + side(a[4294967297]) * 11 + a.length * 1000 + side(o.get(X[p] * 1)) * 19 }`,
    'the receiver missing': head + `const put = (v, i) => { let w = null; if (i === 77) w = v; w[i] = 50 }
      export const go = (p) => { const a = [10, 20, 30]; let h = 0; try { put(a, X[p] * 1) } catch (e) { h += 1 } return h + a.length * 10 }`,
  }
  for (const [name, source] of Object.entries(programs)) {
    const want = [0, 1, 2, 3, 4, 5, 6].map(oracle(source).go)
    for (const optimize of levels(0, 1, 2, 3, 'size', 'speed')) is([0, 1, 2, 3, 4, 5, 6].map(run(source, { optimize }).go), want, `${name} at ${optimize}`)
  }
})
