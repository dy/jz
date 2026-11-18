// A name a statement checked present (a member or element read that throws
// for a missing receiver) is present for the rest of its block to the
// summary's consumers too, as to the emitter's (compile/emit/dispatch.js
// emitBlockBody, the query layer's `present` mark): a list element read past
// its `.length` is a typed array, and `Float64Array.from` of it copies as the
// constructor does, with no list between. A missing element still throws.
import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import { belowOpt, levels } from './_matrix.js'
import { funcWat, oracle, run, wat } from './util.js'

const src = `const bufs = [new Float32Array([1.5, 2.5, -3]), new Float32Array([4, 5])]
const scale = (d) => { const n = d.length; const c = Float64Array.from(d); let s = 0
  for (let i = 0; i < n; i++) s += c[i] * 2 + i
  return s }
export let f = (m) => { let s = 0; for (let k = 0; k < m; k++) s += scale(bufs[k]); return s }`

test('block present: a checked element reads as the host reads it, a missing one throws', () => {
  for (const optimize of levels(0, 2, 3)) {
    const host = oracle(src), m = run(src, { optimize })
    for (const m0 of [0, 1, 2]) is(m.f(m0), host.f(m0), `f(${m0}) at ${optimize}`)
    throws(() => m.f(3), `a missing element throws at ${optimize}`)
    throws(() => host.f(3))
  }
})

test('block present: the checked element reads and copies as a typed array', () => {
  if (belowOpt(2)) return
  const text = wat(src, { optimize: 2 })
  ok(!/call \$__(typed_idx|dyn_get|arr_from)/.test(text), 'the length and the copy read the typed array directly')
})

// A receiver the initializer of a `for` checked present stays so through the
// loop (compile/emit/control-flow.js): the initializer runs before every test,
// body and step, so `d` is tested once, before the loop, not on each pass.
const loop = `const bufs = [new Float32Array([1.5, 2.5, -3]), new Float32Array([4, 5])]
const total = (d) => { let s = 0; for (let i = 0, n = d.length; i < n; i++) { s += d[i]; d[i] = s } return s }
export let g = (m) => { let s = 0; for (let k = 0; k < m; k++) s += total(bufs[k]); return s }`

test('block present: a loop over a receiver its initializer checked runs as the host runs it', () => {
  for (const optimize of levels(0, 2, 3)) {
    const host = oracle(loop), m = run(loop, { optimize })
    for (const m0 of [0, 1, 2, 2]) is(m.g(m0), host.g(m0), `g(${m0}) at ${optimize}`)
    throws(() => m.g(3), `a missing element throws at ${optimize}`)
    throws(() => host.g(3))
  }
})

test('block present: the loop tests its receiver once, before it', () => {
  if (belowOpt(2)) return
  const text = wat(loop, { optimize: 2 })
  const loops = []
  for (let at = text.indexOf('(loop'); at >= 0; at = text.indexOf('(loop', at + 1)) {
    let depth = 0, end = at
    do { const c = text[end++]; if (c === '(') depth++; else if (c === ')') depth-- } while (depth && end < text.length)
    loops.push(text.slice(at, end))
  }
  const inner = loops.filter(l => !/\(loop/.test(l.slice(5)) && /f32\.store/.test(l))
  ok(inner.length > 0, 'found the loop over the receiver')
  for (const l of inner) ok(!/__throw_property_nullish|call \$__throw/.test(l), 'no missing-receiver test inside the loop')
})

// Past its own check a receiver is present (module/core.js dotRead): the
// length of a typed array that may be missing is its header's word, with no
// runtime dispatch over every kind a length can come from.
test('block present: a length read past the receiver\'s check reads the header', () => {
  if (belowOpt(2)) return
  const text = wat(loop, { optimize: 2 })
  const g = funcWat(text, 'g$exp', 'g')
  ok(g.length > 0 && !/call \$__(length|str_eq|str_length|ptr_offset_fwd)/.test(g), 'no length dispatch')
})

// A loose comparison with null or undefined proves the name present where it
// holds (flow-types.js extractRefinements): `a != null` on its arm, `a == null`
// off it. The array a module `let` holds, missing until its init call, is read
// on that arm with no missing-receiver test, in a loop and out of one.
const guarded = `let a
export let fill = (n) => { a = []; for (let i = 0; i < n; i++) a.push(i * 1.5); return 0 }
export let sum = (m) => { let s = 0; if (a != null) for (let i = 0; i < m; i++) s += a[i] | 0; return s }
export let either = (k) => a == null ? -2 : a.length + k
export let undef = (k) => undefined != a ? a[k] : -3`

test('block present: a name compared loosely with null answers as the host does', () => {
  const calls = [['sum', 3], ['either', 1], ['undef', 0], ['fill', 5], ['sum', 3], ['sum', 8], ['either', 1], ['undef', 4], ['undef', 9]]
  for (const optimize of levels(0, 2, 3)) {
    const host = oracle(guarded), m = run(guarded, { optimize })
    for (const [name, arg] of calls) is(m[name](arg), host[name](arg), `${name}(${arg}) at ${optimize}`)
  }
  if (belowOpt(2)) return
  const text = wat(guarded, { optimize: 2 })
  for (const name of ['sum', 'either', 'undef']) {
    const f = funcWat(text, `${name}$exp`) || funcWat(text, name)
    ok(f.length > 0 && !/__throw_property_nullish/.test(f), `${name} reads the array with no missing-receiver test`)
  }
})
