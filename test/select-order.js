// A conditional lowers to a wasm `select` only when its arms may run before its
// test: `select` evaluates both arms first, so a test that assigns what an arm
// reads (`(t = h + n - 1) >= D ? t - D : t`, a ring index) must stay an
// `if`/`else` (compile/emit/shared.js selectOK). A test without writes keeps
// the branchless form.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { levels } from './_matrix.js'
import { agree, wat, funcWat } from './util.js'

const src = `let val = new Float64Array(8); val[0] = 24; val[1] = 91
export let plain = (h, n, D) => { let t; return (t = h + n - 1) >= D ? t - D : t }
export let added = (h, n, D) => { let t, o = 3; return o + ((t = h + n - 1) >= D ? t - D : t) }
export let index = (h, n, D) => { let t, o = 0; return val[o + ((t = h + n - 1) >= D ? t - D : t)] }
export let loop = (h, n, D, v) => { let t, o = 0; while (n && val[o + ((t = h + n - 1) >= D ? t - D : t)] >= v) n--; return n * 10 + t }
export let both = (a, b) => { let t; return (t = a * 2) > b ? t : b - t }
export let andThen = (a, b) => { let t = 0; return ((t = a) > 1 && (t = b) > 1) ? t : -t }
export let ring = (v) => { let D = 4, val = new Float64Array(D), size = 2, h = 0, t; val[0] = 24; val[1] = 91
  let n = size
  while (n && val[(t = h + n - 1) >= D ? t - D : t] >= v) n--
  t = h + n >= D ? h + n - D : h + n
  val[t] = v; return (n + 1) * 100 + t * 10 + val[0] / 24 }
let g = 0
let bump = (x) => { g = x; return x }
export let moduleWrite = (x) => { let r = (g = x * 2) > 3 ? g : -g; return r * 100 + g }
export let callWrite = (x) => (bump(x) > 3 ? g : -g) * 100 + g`
const calls = [['plain', [0, 2, 4]], ['plain', [3, 2, 4]], ['added', [0, 2, 4]], ['added', [3, 2, 4]], ['index', [0, 2, 4]], ['index', [3, 2, 4]],
  ['loop', [0, 2, 4, 61]], ['loop', [0, 2, 4, 30]], ['both', [3, 4]], ['both', [1, 4]], ['andThen', [2, 3]], ['andThen', [0, 3]], ['andThen', [2, 0]],
  ['ring', [61]], ['ring', [30]], ['moduleWrite', [5]], ['moduleWrite', [1]], ['callWrite', [5]], ['callWrite', [1]]]

for (const optimize of levels(0, 2, 3, 'size'))
  test(`select order: a test that assigns what the arms read at ${optimize}`, () => {
    for (const [name, args] of calls) agree(src, name, args, { optimize }, `${name}(${args}) at ${optimize}`)
  })

test('select order: only a writing test forfeits the branchless select', () => {
  const text = wat(`export let writes = (h, n, D) => { let t, o = 3; return o + ((t = h + n - 1) >= D ? t - D : t) }
    export let reads = (h, D) => { let o = 3; return o + (h >= D ? h - D : h) }`, { optimize: 0 })
  // The assignment's own NaN canon is a select too: probe the ternary's `if`.
  ok(/\(if\s+\(result f64\)/.test(funcWat(text, 'writes')), 'the arms wait for the assignment')
  ok(!/\(if\b/.test(funcWat(text, 'reads')) && /select/.test(funcWat(text, 'reads')), 'a pure test keeps the select')
})
