// A name a statement checked present (a member or element read that throws
// for a missing receiver) is present for the rest of its block to the
// summary's consumers too, as to the emitter's (compile/emit/dispatch.js
// emitBlockBody, the query layer's `present` mark): a list element read past
// its `.length` is a typed array, and `Float64Array.from` of it copies as the
// constructor does, with no list between. A missing element still throws.
import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import { belowOpt, levels } from './_matrix.js'
import { oracle, run, wat } from './util.js'

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
