/**
 * A typed-array constructor as a value (`jz:typed`, src/std/typed.js): named
 * in a table or an argument, compared, read off an instance as
 * `a.constructor` and constructed from there. Every expectation is what Node
 * computes for the same source (test/util.js `agree`); three.js's
 * MathUtils.denormalize, Interpolant and utils.getTypedArray are written so.
 */
import test from 'tst'
import { is } from 'tst/assert.js'
import jz from '../index.js'
import { agree, oracle } from './util.js'
import { levels } from './_matrix.js'

const agrees = (rows) => { for (const [label, src] of rows) agree(src, 'f', [], undefined, label) }

test('typed constructors: named as a value', () => agrees([
  ['bound to a name, then constructed', `const F = Float32Array; export const f = () => new F(3).length`],
  ['a table by name', `const T = { Float32Array: Float32Array, Int8Array: Int8Array }; export const f = () => new T['Float32Array'](3).length`],
  ['a shorthand table', `const T = { Float32Array, Int8Array }; export const f = () => new T.Int8Array(3).length + (T.Float32Array === Float32Array ? 10 : 0)`],
  ['an argument', `const make = (C, n) => new C(n); export const f = () => make(Float64Array, 4).length + make(Uint8Array, 2).length`],
  ['constructed from an array', `const make = (C, a) => new C(a); export const f = () => { const v = make(Int16Array, [1, 70000, 3]); return v.length * 100000 + v[1] }`],
  ['constructed over a buffer', `const make = (C, b, o, n) => new C(b, o, n); export const f = () => { const b = new ArrayBuffer(16); const v = make(Float32Array, b, 4, 2); v[0] = 1.5; return v.length * 10 + new Float32Array(b)[1] }`],
  ['typeof', `export const f = () => typeof Float32Array`],
  ['a binding of the name shadows it', `export const f = () => { const Float32Array = 5; return Float32Array + 1 }`],
  ['a parameter of the name shadows it', `const g = (Int8Array) => Int8Array * 2; export const f = () => g(4)`],
  // three.js utils.getTypedArray
  ['constructed by the name a string holds', `const TYPED_ARRAYS = { Int8Array: Int8Array, Uint8Array: Uint8Array, Uint8ClampedArray: Uint8ClampedArray, Int16Array: Int16Array, Uint16Array: Uint16Array,
      Int32Array: Int32Array, Uint32Array: Uint32Array, Float32Array: Float32Array, Float64Array: Float64Array }
    function getTypedArray(type, buffer) { return new TYPED_ARRAYS[type](buffer) }
    export const f = () => { const a = getTypedArray('Uint16Array', 4); a[0] = 70000; return a.length * 100000 + a[0] }`],
]))

test('typed constructors: read off an instance', () => agrees([
  ['compared with the constructor', `export const f = () => { const a = new Float32Array(2); return (a.constructor === Float32Array ? 1 : 0) + (a.constructor === Float64Array ? 10 : 0) }`],
  ['a switch over it', `const d = (a) => { switch (a.constructor) { case Float32Array: return 1; case Uint16Array: return 2; default: return 0 } }
    export const f = () => d(new Float32Array(1)) * 100 + d(new Uint16Array(1)) * 10 + d(new Int8Array(1))`],
  ['constructed from it, keeping the kind', `export const f = () => { const a = new Int16Array(2); const b = new a.constructor(5); b[0] = 70000; return b.length * 100000 + b[0] }`],
  // three.js Interpolant
  ['of a parameter', `class I { constructor(values, size, result) { this.resultBuffer = result !== undefined ? result : new values.constructor(size) } }
    export const f = () => { const i = new I(new Float32Array([1.5, 2.5]), 3); i.resultBuffer[0] = 0.1; return i.resultBuffer.length + (i.resultBuffer[0] === Math.fround(0.1) ? 10 : 0) }`],
  // three.js MathUtils.denormalize
  ['every integer kind told apart', `function denormalize(value, array) { switch (array.constructor) { case Float32Array: return value; case Uint32Array: return value / 4294967295.0; case Uint16Array: return value / 65535.0
      case Uint8Array: return value / 255.0; case Int32Array: return Math.max(value / 2147483647.0, -1.0); case Int16Array: return Math.max(value / 32767.0, -1.0)
      case Int8Array: return Math.max(value / 127.0, -1.0); default: throw new Error('Invalid component type.') } }
    export const f = () => [new Uint8Array(1), new Float32Array(1), new Int8Array(1), new Uint16Array(1), new Int16Array(1), new Uint32Array(1), new Int32Array(1)].map(a => denormalize(100, a)).join()`],
  ['a class instance beside a typed array', `class V { constructor() { this.x = 1 } }
    const same = (a, b) => a.constructor === b.constructor ? 1 : 0
    export const f = () => same(new V(), new V()) + same(new Int8Array(1), new Int8Array(2)) * 10 + same(new V(), new Int8Array(1)) * 100 + same(new Int8Array(1), new Uint8Array(1)) * 1000`],
]))

test('typed constructors: instanceof tells every kind a value can carry apart', () => {
  // BigInt64Array and BigUint64Array share one representation (layout.js): the pair is left out
  const names = ['Float64Array', 'Float32Array', 'Float16Array', 'Int32Array', 'Uint32Array', 'Int16Array', 'Uint16Array', 'Int8Array', 'Uint8Array', 'Uint8ClampedArray']
  const src = `const which = (x) => ${names.map((n, i) => `(x instanceof ${n} ? ${2 ** i} : 0)`).join(' + ')}
    const all = [${names.map(n => `new ${n}(1)`).join(', ')}]
    export const f = (i) => which(all[i])`
  const want = oracle(src).f
  for (const optimize of levels(0, 2, 3)) {
    const got = jz(src, { optimize }).exports.f
    names.forEach((n, i) => is(got(i), want(i), `O${optimize}, ${n}`))
  }
})

test('typed constructors: BYTES_PER_ELEMENT of a constructor and of an instance', () => agrees([
  ['the constructors', `export const f = () => [Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Float16Array, Int32Array, Uint32Array, Float32Array, Float64Array].length +
    [Int8Array.BYTES_PER_ELEMENT, Uint8ClampedArray.BYTES_PER_ELEMENT, Int16Array.BYTES_PER_ELEMENT, Float16Array.BYTES_PER_ELEMENT, Uint32Array.BYTES_PER_ELEMENT, Float32Array.BYTES_PER_ELEMENT, Float64Array.BYTES_PER_ELEMENT, BigInt64Array.BYTES_PER_ELEMENT].join('')`],
  ['an instance of a known kind', `export const f = () => new Int16Array(2).BYTES_PER_ELEMENT * 10 + new Float64Array(0).BYTES_PER_ELEMENT`],
  ['an instance of a kind the run decides', `const g = (x) => x.BYTES_PER_ELEMENT; const all = [new Int16Array(1), new Float64Array(1), new Uint8ClampedArray(0), new Float32Array(new ArrayBuffer(8), 4)]
    export const f = () => all.map(g).join()`],
  ['an object\'s own property of the name', `const g = (x) => x.BYTES_PER_ELEMENT; export const f = () => g({ BYTES_PER_ELEMENT: 7 }) + (g({ a: 1 }) === undefined ? 10 : 0)`],
]))
