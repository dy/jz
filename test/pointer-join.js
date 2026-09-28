// An unboxed pointer (a typed-array parameter, held in an i32) joined with
// another value keeps its kind: `output || scratch` and `ok && arr` box each arm
// by its own kind instead of one numeric widening (compile/emit/shared.js
// i32JoinRep), and a local declared from `cond ? left : right` is a pointer, not
// an integer i32 (type/expr-type.js). Every case mirrors an audiojs atom shape:
// an optional output buffer, a channel chosen by a parameter.
import test from 'tst'
import { levels } from './_matrix.js'
import { agree } from './util.js'

const src = `let sp = new Float64Array(4), L = new Float32Array(4), R = new Float32Array(5), p = { channel: 'right' }
L[1] = 3; R[1] = 7
let fill = (output) => { let out = output || sp; for (let i = 0; i < 4; i++) out[i] = i * 2; return out }
export let orSame = () => { let o = new Float64Array(4); fill(o); return o[1] + o[3] }
export let orOther = () => { let o = new Float32Array(4); fill(o); return o[1] + o[3] }
export let orFallback = () => { let o = new Float64Array(4); fill(o); let s = fill(null); return o[1] + o[3] + s[2] + (s === sp ? 100 : 0) }
let fresh = (output) => { let out = output || new Float64Array(4); for (let i = 0; i < 4; i++) out[i] = i * 2; return out }
export let orFresh = (k) => { let o = new Float64Array(4); fresh(k > 0 ? o : null); return o[1] + o[3] }
let grown = (output) => { let out = output || sp; return out.length }
export let orGrown = (n) => { sp = new Float64Array(n); return grown(null) * 10 + grown(L) }
let guard = (ok, arr) => { let out = ok && arr; return out ? out.length : -1 }
export let andGuard = (k) => guard(k > 0, L) * 10 + guard(k > 5, R)
let nullish = (output) => { let out = output ?? sp; for (let i = 0; i < 4; i++) out[i] = i * 3; return out }
export let nullishFallback = (k) => { let o = new Float64Array(4); nullish(k > 0 ? o : undefined); return o[1] + o[3] + (nullish(null) === sp ? 100 : 0) }
let pickLen = (left, right, params) => { let target = params.channel === 'left' ? left : right; return target.length }
let pickNum = (left, right, k) => { let target = k === 1 ? left : right; return target.length }
let pickElem = (left, right, k) => { const target = k === 1 ? left : right; return target[1] + target.length }
let pickSum = (left, right, k) => { let target = k === 1 ? left : right, s = 0; for (let i = 0; i < target.length; i++) s += target[i]; return s }
let pickAgain = (left, right, k) => { let target = k === 1 ? left : right; if (k > 5) target = left; return target.length }
let pickOr = (left, right, k) => { let target = (k === 1 && left) || right; return target.length }
export let ternary = (k) => [pickLen(L, R, p), pickNum(L, R, k), pickElem(L, R, k), pickSum(L, R, k), pickAgain(L, R, k), pickOr(L, R, k)].join()`
const calls = [['orSame', []], ['orOther', []], ['orFallback', []], ['orFresh', [1]], ['orFresh', [0]], ['orGrown', [8]], ['andGuard', [1]], ['andGuard', [9]], ['andGuard', [0]],
  ['nullishFallback', [1]], ['nullishFallback', [0]], ['ternary', [1]], ['ternary', [2]], ['ternary', [7]]]

for (const optimize of levels(0, 2, 3, 'size'))
  test(`pointer join: an unboxed typed array through ||, && and ?: at ${optimize}`, () => {
    for (const [name, args] of calls) agree(src, name, args, { optimize }, `${name}(${args}) at ${optimize}`)
  })
