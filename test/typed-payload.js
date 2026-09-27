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
