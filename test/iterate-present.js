// A for-of iterates what `__iter_arr` hands it, and that throws for a missing
// source: the array it iterates is present (summary/index.js). A bank of ring
// buffers kept in a record field set on first use (`if (!st.c) st.c = [...]`)
// is iterated by the loop's hoisted header, one load per element, with no
// receiver test inside the loop; a missing source still throws.
import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import { belowOpt, levels } from './_matrix.js'
import { funcWat, oracle, run, wat } from './util.js'

const src = `const comb = (data, st) => {
  if (!st.c) st.c = [11, 13, 17].map(len => ({ b: new Float64Array(len), p: 0, f: 0 }))
  let combs = st.c
  for (let i = 0; i < data.length; i++) {
    let x = data[i], out = 0
    for (let c of combs) { let y = c.b[c.p]; c.f = y * 0.5 + c.f * 0.5; c.b[c.p] = x + 0.8 * c.f; c.p = (c.p + 1) % c.b.length; out += y }
    data[i] = out
  }
}
const chans = [{ fs: 1 }, { fs: 2 }], buf = new Float64Array(16)
export let run = (k, n) => { let s = 0
  for (let r = 0; r < n; r++) { for (let i = 0; i < buf.length; i++) buf[i] = ((i + r) % 7) * 0.25 - 0.5; comb(buf, chans[k]); s += buf[3] + buf[15] }
  return s }
export let sum = (o) => { let s = 0; for (let v of o.list) s += v; return s }`

test('iterate present: a list set on first use iterates as the host does, a missing one throws', () => {
  for (const optimize of levels(0, 2, 3)) {
    const host = oracle(src), m = run(src, { optimize })
    for (const [k, n] of [[0, 0], [0, 5], [1, 3], [0, 40], [1, 2]]) is(m.run(k, n), host.run(k, n), `run(${k}, ${n}) at ${optimize}`)
    is(m.sum({ list: [1, 2, 3.5] }), host.sum({ list: [1, 2, 3.5] }), `sum at ${optimize}`)
    throws(() => m.sum({}), `a missing list throws at ${optimize}`)
    throws(() => host.sum({}))
  }
})

test('iterate present: the loop over the list tests no receiver', () => {
  if (belowOpt(2)) return
  const text = funcWat(wat(src, { optimize: 2 }), 'comb')
  const loops = []
  for (let at = text.indexOf('(loop'); at >= 0; at = text.indexOf('(loop', at + 1)) {
    let depth = 0, end = at
    do { const c = text[end++]; if (c === '(') depth++; else if (c === ')') depth-- } while (depth && end < text.length)
    loops.push(text.slice(at, end))
  }
  const inner = loops.filter(l => !/\(loop/.test(l.slice(5)) && /f64\.store offset=16/.test(l))
  ok(inner.length > 0, 'found the loop over the list')
  for (const l of inner) {
    ok(!/__ptr_offset_fwd|__throw_property_nullish/.test(l), 'no forwarding chase and no missing-receiver throw inside the loop')
  }
})
