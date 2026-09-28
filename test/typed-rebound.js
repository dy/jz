// A typed-array binding reassigned to another array denotes the new one
// everywhere: its length read in the body, in a callee, from another function;
// a module scratch array grown on demand (the audiojs stretch kernels' idiom).
// Neither the plan's literal length (compile/plan, infer.js) nor the
// scalarizer's mirror (compile/plan/literals.js) may keep the first array's size.
// A binding that holds a typed array on one path and something else on another
// (a parameter of any kind, a host view) is typed as neither (compile/analyze/
// trackers.js dropDisagreeingTypedDefs): `instanceof` stays a runtime test and a
// view keeps its byteOffset.
import test from 'tst'
import { levels } from './_matrix.js'
import { agree } from './util.js'

const src = `let buf = new Float64Array(0)
let len = (x) => x.length
let sum = (x) => { let s = 0; for (let i = 0; i < x.length; i++) s += x[i]; return s }
let grow = (n) => { buf = new Float64Array(n); buf[n - 1] = 5 }
let frame = (n) => { if (buf.length !== n) buf = new Float64Array(n); buf.fill(1); return sum(buf) }
export let callee = (n) => { grow(n); return len(buf) * 100 + buf[n - 1] + buf.length }
export let onDemand = (n) => frame(n) + frame(2 * n) + frame(n)
export let local = () => { let b = new Float64Array(0); b = new Float64Array(8); return len(b) * 10 + b.length }
export let localRead = () => { let b = new Float64Array(2); b[1] = 5; let a = b.length; b = new Float64Array(8); b[1] = 7; return a * 1000 + b[1] * 10 + b.length }
export let conditional = (k) => { let b = new Float64Array(0); if (k) b = new Float64Array(8); return b.length }
export let alike = () => { let b = new Int32Array(8); b[3] = 4; b = new Int32Array(8); return b[3] * 10 + b.length }`
const calls = [['callee', [8]], ['callee', [3]], ['onDemand', [8]], ['local', []], ['localRead', []], ['conditional', [1]], ['conditional', [0]], ['alike', []]]

for (const optimize of levels(0, 1, 2, 3, 'size'))
  test(`typed rebound: a reassigned typed binding is the new array at ${optimize}`, () => {
    for (const [name, args] of calls) agree(src, name, args, { optimize }, `${name}(${args}) at ${optimize}`)
  })

const mixed = `function isF32(data, flag) { if (flag) data = new Float32Array(4); return data instanceof Float32Array ? 1 : 0 }
let pick = (o, flag) => { let data = o; if (flag) data = new Float32Array(4); return data instanceof Float32Array ? 1 : 0 }
let batch = (d) => new Float32Array(d.length * 2)
let writer = (o) => (chunk) => chunk
function go(data) {
  if (data instanceof Float64Array) data = Float32Array.from(data)
  if (!(data instanceof Float32Array)) return writer(data)
  return batch(data)
}
export let param = () => [isF32({ factor: 2 }, 0), isF32(new Float64Array(2), 0), isF32([1, 2], 0), isF32({ factor: 2 }, 1), isF32(new Float32Array(1), 0)].join()
export let local = () => [pick({ factor: 2 }, 0), pick(new Float64Array(2), 0), pick(new Float32Array(1), 0), pick({ factor: 2 }, 1)].join()
export let entry = () => [typeof go({ factor: 2 }), go(new Float64Array(3)).length, go(new Float32Array(2)).length].join()
export let view = (b) => { let src = b.subarray(44); if (b.length < 0) src = new Uint8Array(8); return [src.byteOffset, src.length, src[0]].join() }
let samples = (raw, n) => { let src = raw; if (n < 0) src = new Uint8Array(n * 2); return new Uint16Array(src.buffer, src.byteOffset, n) }
export let viewCtor = (b) => { let s = samples(b.subarray(44), 4); return [s.length, s.byteOffset, s[0], s[1]].join() }
// A value absent on one path (an uninitialized let returned, a record field
// assigned on the other path) keeps a boxed carrier into the callee, where
// instanceof stays a runtime test (narrow/param-abi.js, emit/instanceof.js).
let kindOf = (o) => o instanceof Float32Array ? 'F32' : typeof o
function coreRec(data) { if (data.length < 100) return { out: new Float32Array(data.length), contour: null }; let out; return { out, contour: 0 } }
let batchRec = (data) => coreRec(data).out
function maybe(k) { let out; if (k) out = new Float32Array(2); return out }
export let absentField = () => [kindOf(batchRec(new Float32Array(64))), kindOf(batchRec(new Float32Array(200))), typeof coreRec(new Float32Array(200)).out].join()
export let absentLocal = () => [kindOf(maybe(0)), kindOf(maybe(1)), maybe(0) instanceof Float32Array ? 1 : 0, maybe(1) instanceof Float32Array ? 1 : 0].join()
let lengthOr = (o) => [o == null ? -1 : o.length, o === undefined ? 1 : 0, o ? 1 : 0, typeof o].join()
export let absentTests = () => lengthOr(maybe(0)) + ';' + lengthOr(maybe(1))
let isArr = (o) => o instanceof Array ? 1 : 0
function maybeArr(k) { let out; if (k) out = [1, 2]; return out }
export let absentArray = () => [isArr(maybeArr(0)), isArr(maybeArr(1))].join()`
const bytes = Uint8Array.from({ length: 128 }, (_, i) => i)

for (const optimize of levels(0, 2, 3, 'size'))
  test(`typed rebound: a binding typed on one path only stays untyped at ${optimize}`, () => {
    for (const [name, args] of [['param', []], ['local', []], ['entry', []], ['view', [bytes]], ['viewCtor', [bytes]], ['absentField', []], ['absentLocal', []], ['absentTests', []], ['absentArray', []]])
      agree(mixed, name, args, { optimize }, `${name} at ${optimize}`)
  })
