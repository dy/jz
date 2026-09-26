// Flow-sensitive intervals (optimize/flow-range.js): a clamp's guarded writes
// bound the local for the reads that follow, so its ToInt32 needs no ±∞ guard.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { levels } from './_matrix.js'
import { agree, wat } from './util.js'

const guards = text => (text.match(/f64\.const inf/g) || []).length

// The edge inputs ToInt32 distinguishes: NaN and ±∞ map to 0, large values wrap
// (within the documented ±2^63 boundary), the rails clamp, signed zero and
// subnormals truncate to 0.
const EDGE = [NaN, Infinity, -Infinity, 0, -0, 1e18, -1e18, 2147483648, -2147483649, 4294967296.5,
  1, -1, 0.99999, 1.00001, -1.00001, 32768 / 32767, -32769 / 32767, 0.5, -0.5, 5e-324, 9007199254740993]

const program = clamp => `export let enc = (s, n) => {
  let h = 0
  for (let i = 0; i < n; i++) {
    let v = s[i] * 32767.0
    ${clamp}
    h = (h * 31 + ((v | 0) & 0xffff)) | 0
  }
  return h
}`

const check = (src, name) => {
  for (const optimize of levels(0, 2, 3, 'size'))
    agree(src, 'enc', [new Float64Array(EDGE), EDGE.length], { optimize }, `${name} at ${optimize}`)
}

test('flow range: a two-sided clamp retires the ToInt32 guard', () => {
  const src = program('if (v > 32767.0) v = 32767.0\n    else if (v < -32768.0) v = -32768.0')
  const text = wat(src, { optimize: 3 })
  is(guards(text), 0, 'no ±∞ guard remains')
  ok(text.includes('(i64.trunc_sat_f64_s'), 'the conversion is the bare i64 wrap')
  check(src, 'if/else clamp')
})

test('flow range: two guarded statements clamp as well as one if/else', () => {
  const src = program('if (v > 32767.0) v = 32767.0\n    if (v < -32768.0) v = -32768.0')
  is(guards(wat(src, { optimize: 3 })), 0, 'two statements bound both sides')
  check(src, 'two-statement clamp')
})

test('flow range: a ternary clamp is bounded through its select', () => {
  const src = program('v = v > 32767.0 ? 32767.0 : v < -32768.0 ? -32768.0 : v')
  is(guards(wat(src, { optimize: 3 })), 0, 'the select arms carry the comparison facts')
  check(src, 'ternary clamp')
})

test('flow range: a one-sided clamp keeps the guard', () => {
  const src = program('if (v > 32767.0) v = 32767.0')
  ok(guards(wat(src, { optimize: 3 })) > 0, 'unbounded below: the guard stays')
  check(src, 'one-sided clamp')
})

test('flow range: a later write cancels the clamp', () => {
  const src = program('if (v > 32767.0) v = 32767.0\n    else if (v < -32768.0) v = -32768.0\n    v = s[i]')
  ok(guards(wat(src, { optimize: 3 })) > 0, 'the read sees the unbounded write')
  check(src, 'overwritten clamp')
})

test('flow range: a fact does not survive a loop back-edge', () => {
  const src = `export let enc = (s, n) => {
    let h = 0, v = 0
    for (let i = 0; i < n; i++) {
      if (v > 100.0) v = 100.0
      h = (h * 31 + (v | 0)) | 0
      v = s[i]
    }
    return h
  }`
  ok(guards(wat(src, { optimize: 3 })) > 0, 'the head value comes from the previous iteration')
  check(src, 'loop-carried value')
})

test('flow range: the arm that writes a local after its test gets no fact', () => {
  const src = `export let enc = (s, n) => {
    let h = 0
    for (let i = 0; i < n; i++) {
      let v = s[i]
      if (v < 10.0) { v = s[i + 1] * 1e300; if (v > 5.0) v = 5.0 } else v = 3.0
      h = (h * 31 + (v | 0)) | 0
    }
    return h
  }`
  ok(guards(wat(src, { optimize: 3 })) > 0, 'the rewritten local is bounded above only')
  check(src, 'rewritten arm')
})
