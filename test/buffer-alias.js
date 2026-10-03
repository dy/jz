// Two module bindings name two buffers only when each holds arrays of its own:
// every write an allocation of a length or a list (plan/literals.js
// analyzeFreshTypedGlobals). Then a loop that stores through one reads the
// other's invariant elements once (optimize/licm.js), and a function reads such
// a fixed cell at its entry (optimize/globals.js). A binding assigned another's
// array, or a view of its buffer, is that buffer: its stores reach the reads.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import parseWat from 'watr/parse'
import jz from '../index.js'
import { belowOpt, levels } from './_matrix.js'
import { funcWat, oracle, wat } from './util.js'

test('buffer alias: a binding assigned another array, or a view of its buffer, is that buffer', () => {
  for (const init of ['b = a', 'b = new Float64Array(a.buffer)', 'b = a.subarray(0)']) {
    const src = `let a = new Float64Array(4), b = new Float64Array(4)
      export let init = () => { ${init} }
      export let run = (n) => { let s = 0; for (let i = 0; i < n; i++) { b[1] = i; s += a[1] } return s }`
    for (const optimize of levels(0, 2, 'speed')) {
      const got = jz(src, { optimize }).exports, host = oracle(src)
      got.init(); host.init()
      is(got.run(10), host.run(10), `O${optimize} ${init}`)
    }
  }
})

test('buffer alias: a loop storing to one array reads the invariant elements of another once', () => {
  // (a palette over a row-major image, as a gallery page shades its cells)
  const src = `let W = 0, H = 0, px, cell, th = new Float64Array(6)
    export let resize = (w, h) => { W = w; H = h; px = new Uint32Array(w * h); cell = new Float32Array(w * h)
      for (let i = 0; i < w * h; i++) cell[i] = (i % 7) / 6; return px }
    export let theme = (r, g) => { th[0] = r; th[3] = g }
    export let frame = () => {
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        let v = cell[y * W + x]
        px[y * W + x] = (255 << 24) | ((th[0] + (th[3] - th[0]) * v) | 0)
      }
      return px[W * H - 1] + px[W]
    }`
  for (const optimize of levels(0, 2, 'speed')) {
    const got = jz(src, { optimize }).exports, host = oracle(src)
    for (const m of [got, host]) { m.resize(23, 9); m.theme(10, 250) }
    is(got.frame(), host.frame(), `O${optimize} frame`)
  }
  if (belowOpt(2)) return
  const loops = []
  const walk = n => { if (!Array.isArray(n)) return; if (n[0] === 'loop') loops.push(n); n.forEach(walk) }
  walk(parseWat(funcWat(wat(src, { optimize: 'speed' }), 'frame')))
  const has = (n, op) => Array.isArray(n) && (n[0] === op || n.some(c => has(c, op)))
  const inner = loops.filter(l => !l.slice(1).some(c => has(c, 'loop')))
  ok(inner.length && inner.every(l => !has(l, 'f64.load')), 'no element of th is read in a row loop')
})
