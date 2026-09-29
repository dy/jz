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
import { ok } from 'tst/assert.js'
import { belowOpt, levels } from './_matrix.js'
import { agree, funcWat, wat } from './util.js'

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
