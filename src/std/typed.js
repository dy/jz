/**
 * `jz:typed` – the typed-array constructors as values. `new Float32Array(n)`,
 * `a instanceof Float32Array` and `Float32Array.from(…)` name the constructor
 * where the compiler resolves it; anywhere else (`{ Float32Array }`, an
 * argument, `a.constructor === Float32Array`) it is the function here, one per
 * constructor, so identity holds across the program. `__ctor(x)` is
 * `x.constructor`: a typed array's is its function, any other value's the
 * member it carries (a class instance's is its class, jzify/classes.js).
 * BigInt64Array and BigUint64Array share one representation (layout.js), so
 * neither is recovered from a value: their `constructor` reads undefined.
 *
 * @module std/typed
 */

const NAMES = ['Float64Array', 'Float32Array', 'Float16Array', 'Int32Array', 'Uint32Array', 'Int16Array', 'Uint16Array',
  'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'BigInt64Array', 'BigUint64Array']

/** The constructors `jz:typed` makes functions of, each as `__` + its name. */
export const TYPED_CTORS = new Set(NAMES)
/** Bytes an element takes, by constructor. */
export const TYPED_BYTES = { Float64Array: 8, Float32Array: 4, Float16Array: 2, Int32Array: 4, Uint32Array: 4, Int16Array: 2, Uint16Array: 2,
  Int8Array: 1, Uint8Array: 1, Uint8ClampedArray: 1, BigInt64Array: 8, BigUint64Array: 8 }

export default `
${NAMES.map(n => `export let __${n} = (a, b, c) => b === undefined ? new ${n}(a) : c === undefined ? new ${n}(a, b) : new ${n}(a, b, c)`).join('\n')}
export let __ctor = (x) => ${NAMES.filter(n => !n.startsWith('Big')).map(n => `x instanceof ${n} ? __${n}`).join('\n  : ')}
  : x.constructor
`
