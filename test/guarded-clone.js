// A typed-guard clone (narrow/specialize.js) runs where its origin's call
// passes typed arrays of its constructor; no static call names it. The
// summary binds it at every call of its origin, the guarded arguments as that
// typed array (summary/index.js bindGuarded), so its body keeps the kinds the
// origin's own view has: a window memoized by size (`windows[n] ??= …`, the
// mel spectrum of audio/fn/spectrum.js) reads as a Float32Array there. An
// exported kernel called inside the module took every element access through
// the runtime's dispatch, the loop counter's number included.
import test from 'tst'
import { is } from 'tst/assert.js'
import { levels, onKernel } from './_matrix.js'
import { agree, wat, funcWat } from './util.js'

const src = `let windows = {}
let hann = (n) => { if (windows[n]) return windows[n]; let w = new Float32Array(n); for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n); return (windows[n] = w) }
export function energy(x) { let w = hann(x.length), s = 0; for (let i = 0; i < x.length; i++) s += (x[i] * w[i]) ** 2; return s }
let blk = new Float32Array(64).fill(0.5)
export let run = () => energy(blk)`

for (const optimize of levels(2, 3))
  test(`guarded clone: the clone's body keeps its origin's kinds at ${optimize}`, () => {
    agree(src, 'run', [], { optimize }, `run() at ${optimize}`)
    if (onKernel()) return
    const body = funcWat(wat(src, { optimize }), 'energy$spec')
    is(body ? (body.match(/call \$(__dyn_get\w*|__typed_idx\w*|__arr_typed\w*)/g) || []).length : 0, 0, `no runtime element dispatch in the clone at ${optimize}`)
  })
