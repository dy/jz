// A number key names an element only as an integer the i32 index holds
// exactly (emit/dispatch.js keyIndex). A fraction, NaN, ±Infinity, a value
// past 2^31 or a missing value names none: a typed array or a string reads
// undefined there and a typed store drops, like an index past the length,
// even where the loop proves the range (the key's own bit guards the access).
// The search of @audio/stretch-psola's peakNear, whose window starts at a
// fractional center, found every sample undefined under V8 and a truncated
// neighbour here. An integer-certain name may hold NaN (`Math.floor` of one),
// which names no element either (compile/emit/dispatch.js emitIndex).
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { belowOpt, levels } from './_matrix.js'
import { agree, funcWat, oracle, run, wat } from './util.js'

const src = `let t = new Float32Array(4); t[0] = 1; t[1] = 2; t[2] = 3; t[3] = 4
let b = [1, 2, 3, 4]
let at = (x, i) => x[i]
let put = (x, i, v) => { x[i] = v; return x[i] }
let peak = (data, center, radius) => { let s = 0, n = 0
  for (let i = Math.max(1, center - radius); i <= Math.min(data.length - 2, center + radius); i++) { let v = Math.abs(data[i]); if (v >= 0) { s += v; n++ } }
  return s * 100 + n }
export let reads = () => [t[1.5], typeof t[1.5], t[NaN], at(t, 1.5), at(t, 2), at(t, -0), at(t, NaN), at(t, Infinity), at(t, 2 ** 32 + 1),
  at(b, 1.5), at(b, 2), at(b, NaN), at(b, 2 ** 31), at('abc', 1.5), at('abc', 1)].map(String).join()
export let typedWrites = () => { let u = new Float64Array(4)
  return [put(u, 1.5, 9), put(u, NaN, 3), put(u, Infinity, 5), put(u, 2, 7), u.join()].map(String).join() }
export let arrayWrites = () => { let a = [1, 2, 3, 4]; a[1.5] = 9; a[NaN] = 8; return [a[1], a[0], a.length].join() }
export let window = (center) => peak(t, center, 1)
export let floored = (x) => { let i = Math.floor(x), j = i + 1; let u = new Float64Array(4); u[i] = 9; return [t[i], t[j], b[i], u.join()].map(String).join() }`
const calls = [['reads', []], ['typedWrites', []], ['arrayWrites', []], ['window', [1.5]], ['window', [2.5]], ['window', [2]],
  ['floored', [NaN]], ['floored', [1.5]], ['floored', [-0.5]], ['floored', [Infinity]], ['floored', [2 ** 40]]]

for (const optimize of levels(0, 2, 3, 'size'))
  test(`index key: a number that names no element reads undefined and stores nothing at ${optimize}`, () => {
    for (const [name, args] of calls) agree(src, name, args, { optimize }, `${name}(${args}) at ${optimize}`)
  })

// The key's int32 test truncates through i64: V8's arm64 code for the
// saturating i32 truncation rounds, converts, compares and branches out of
// line; the i64 one is a single instruction, and its low word converted back
// equals the key exactly when the key is an int32, as the i32 one's does.
test('index key: a key of unknown integrality tests its int32 through the i64 truncation', () => {
  if (belowOpt(2)) return
  const text = wat(`const t = new Float64Array(8); export let get = (i) => t[i]; export let put = (i, v) => { t[i] = v }`, { optimize: 2 })
  for (const name of ['get', 'put']) {
    const f = funcWat(text, name + '$exp') || funcWat(text, name)
    ok(/i64\.trunc_sat_f64_s/.test(f) && !/i32\.trunc_sat_f64_s/.test(f), `${name}: the i64 truncation, no saturating i32 one`)
  }
})

test('index key: signed integer offsets keep word arithmetic without wrapping into an element', () => {
  const src = `const a = new Float64Array([10, 20, 30, 40])
    export function plus(n) { const i = n | 0; return a[i + 1] }
    export function minus(n) { const i = n | 0; return a[i - 1] }
    export function product(n) { const i = n | 0; return a[i * 65536] }
    export function unsigned(n) { const i = n >>> 0; return a[i + 1] }
    export function rounded(n) { const i = n | 0; if (i === 2147483647) return a[(i * i + 1) - i * i]; return -1 }
    export function put(n, v) { const i = n | 0; a[i + 1] = v; return a[0] + a[1] * 10 + a[2] * 100 + a[3] * 1000 }`
  for (const optimize of levels(0, 2, 3, 'size')) {
    const host = oracle(src), actual = run(src, { optimize })
    for (const n of [0, 0, 1, 2, 3, -1, -2, 65536, -65536, 2147483647, -2147483648, 4294967295, 4294967296, NaN, Infinity]) {
      for (const name of ['plus', 'minus', 'product', 'unsigned', 'rounded']) is(actual[name](n), host[name](n), `${name}(${n}), ${optimize}`)
      is(actual.put(n, n & 255), host.put(n, n & 255), `put(${n}), ${optimize}`)
    }
    if (optimize >= 2 && !belowOpt(2)) {
      const text = wat(src, { optimize }), f = funcWat(text, 'plus$exp') || funcWat(text, 'plus')
      ok(!/i64\.add|f64\.add|i32\.trunc_sat/.test(f), `plus: the input and offset stay in word arithmetic, ${optimize}`)
    }
  }
})
