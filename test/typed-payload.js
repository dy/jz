// A typed array read out of a list may be missing (the index past the list's
// end), so its kind is one constructor or nothing. A store through it rejects
// the missing receiver itself and stores by the constructor, as a read does
// (module/typedarray.js resolveElem payload).
import test from 'tst'
import { ok } from 'tst/assert.js'
import jz from '../index.js'
import { belowOpt, levels } from './_matrix.js'
import { funcWat, oracle, wat } from './util.js'

const buf = `class Buf {
  #channels
  constructor(nch, len) { const d = new Float32Array(len * nch); this.#channels = []; for (let c = 0; c < nch; c++) this.#channels.push(d.subarray(c * len, (c + 1) * len)) }
  get(c) { return this.#channels[c] }
}
`
const src = `${buf}
export let fill = (n) => { const a = new Buf(2, 8); const x = a.get(n & 1); for (let i = 0; i < 12; i++) x[i] = i + 0.5; let h = 0; for (let i = 0; i < 12; i++) { const v = x[i]; h += v === undefined ? 100 : v } return h }
export let copy = (n) => { const a = new Buf(2, 8), x = a.get(0), y = a.get(1); for (let i = 0; i < 8; i++) x[i] = i * 0.25 + n; for (let i = 0; i < 8; i++) y[i] = x[i] * 2; let h = 0; for (let i = 0; i < 8; i++) h += y[i] * (i + 1); return h }
export let missing = (n) => { const a = new Buf(2, 8); const x = a.get(n + 2); let h = 0; try { h += 1; x[0] = (h += 10, 5); h += 100 } catch (e) { h += 1000 } return h }
export let order = (n) => { const a = new Buf(2, 8); const x = a.get(n + 2); let h = 0; const k = () => { h += 7; return 1 }; try { x[k()] = k() } catch (e) { h += 1000 } return h }`

test('typed payload: stores agree with the host', () => {
  const host = oracle(src)
  for (const optimize of levels(0, 2, 3, 'size')) {
    const mod = jz(src, { optimize }).exports
    for (const name of Object.keys(host)) for (const n of [0, 1]) {
      const want = host[name](n), got = mod[name](n)
      ok(Object.is(want, got), `${name}(${n}) at ${optimize}: ${String(got)} for ${String(want)}`)
    }
  }
})

test('typed payload: the store is direct', () => {
  if (belowOpt(2)) return
  const text = wat(src, { optimize: 2 })
  const body = funcWat(text, 'copy$exp') || funcWat(text, 'copy')
  ok(/f32\.store/.test(body), 'an f32 store')
  ok(!/call \$__typed_set_idx_tagged/.test(body), 'no runtime writer')
})

// A channel read at a loop index may be missing too. Inlined into that loop, a
// kernel's loop is versioned: its guard tests every receiver present, and in the
// fast arm the receiver reads as its constructor (emit/control-flow.js, the
// guard's `notNullish` refinement), not through the run-time element dispatch.
const pairs = `
function pair(x, x2, s, out, k) { let z = s[0], q = 0, q2 = 0; for (let i = 0, l = x.length; i < l; i++) { let v = x[i], v2 = x2[i]; z = z * 0.5 + v; q += v * v; q2 += v2 * v2 } s[0] = z; out[k] = q; out[k + 1] = q2 }
function ms(channels, out) { let n = channels.length, k = 0; for (; k + 1 < n; k += 2) pair(channels[k], channels[k + 1], new Float64Array(4), out, k); return out }
let L = new Float32Array(64), R = new Float32Array(64), o = new Float64Array(2)
export let run = (g) => { for (let i = 0; i < 64; i++) { L[i] = Math.sin(i * g); R[i] = Math.cos(i * g) } ms([L, R], o); return o[0] * 1000 + o[1] }`

test('typed payload: a channel read at a loop index agrees with the host', () => {
  const host = oracle(pairs)
  for (const optimize of levels(0, 2, 3, 'size')) {
    const got = jz(pairs, { optimize }).exports.run(0.3), want = host.run(0.3)
    ok(Object.is(got, want), `run at ${optimize}: ${got} for ${want}`)
  }
})

test('typed payload: a versioned loop reads a present channel directly', () => {
  if (belowOpt(2)) return
  const text = wat(pairs, { optimize: 'speed' })
  const body = funcWat(text, 'run$exp') || funcWat(text, 'run')
  ok(/f32\.load/.test(body), 'an f32 load')
  ok(!/__typed_idx|__utd/.test(body), 'no run-time element dispatch')
})

// A buffer kept in a field set on first use may be missing: its stores take the
// typed writer behind the missing receiver's rejection, as its reads do.
const lazy = `const st = { fs: 48000 }
  function k(data, params) {
    if (!params._buf) params._buf = new Float64Array(8)
    for (let i = 0; i < data.length; i++) { params._buf[i & 7] = data[i]; data[i] = params._buf[(i + 3) & 7] }
    return data
  }
  export let run = (g) => { const d = new Float64Array(16); for (let i = 0; i < 16; i++) d[i] = i * g; k(d, st); return d[5] + d[12] * 10 }`

test('typed payload: a store through a field set on first use is typed', () => {
  const host = oracle(lazy)
  for (const optimize of levels(0, 2, 3)) {
    const m = jz(lazy, { optimize }).exports
    for (const g of [0.5, 2]) ok(Object.is(m.run(g), host.run(g)), `run(${g}) at ${optimize}`)
  }
  if (belowOpt(2)) return
  const text = wat(lazy, { optimize: 2 })
  const body = funcWat(text, 'k') || funcWat(text, 'run')
  ok(body && /f64\.store/.test(body) && !/__dyn_set|__typed_set_idx|__arr_typed_obj_set_idx/.test(body), 'a typed store, no runtime writer')
})
