// A local every read of which re-applies ToInt32/ToUint32 holds its word, whatever
// number each write gives (src/compile/analyze-scans.js narrowWordLocals): a hash
// seeded above 2^31 and stepped by Math.imul and `^` is an i32, never an f64 that
// converts at each operator. ToInt32 is idempotent (ECMA-262 7.1.6), so the word
// stored at the write is the word each read would have taken from the number.
// Every value is a differential against the host running the same source; the
// local's storage is read from the WAT. A read that observes the number (a
// return, a comparison, an index, a step, a float or clamped store, a capture)
// keeps the f64.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { agree, oracle, run, wat, funcWat as funcWatOf } from './util.js'
import { belowOpt, levels } from './_matrix.js'

const funcWat = (text, name) => funcWatOf(text, name) || funcWatOf(text, `${name}$exp`)
/** The storage of the local `name` in `fn`, through any inlining prefix. */
const storage = (src, fn, name) => {
  const m = new RegExp(`\\(local \\$(?:\\w+_)?${name} (i32|f64)\\)`).exec(funcWat(wat(src), fn))
  return m ? m[1] : null
}
// The storage holds once the optimizer ran; every leg runs the differentials.
const word = (src, name = 'h') => { if (!belowOpt(2)) is(storage(src, 'f', name), 'i32', `${name} holds its word`) }
// A local the optimizer folded away stores nothing: only an i32 would be wrong.
const wide = (src, name = 'h') => { if (!belowOpt(2)) ok(storage(src, 'f', name) !== 'i32', `${name} keeps the number`) }

// Arguments the conversions disagree on: past 2^31, past 2^32, fractions, -0, NaN,
// infinities. Each kernel keeps them within (-2^63, 2^63), the span `|0` wraps
// over (src/ir/numeric.js toI32): past it the dialect saturates, word or number.
const NUMS = [0, 1, -1, 7.9, -7.9, 2147483647, 2147483648, 4294967295, 4294967296, 4294967297.5, -2147483649, 4e18, -4e18, -0, NaN, Infinity, -Infinity]

test('word local: initializer products keep Number rounding before taking the word', () => {
  const sources = [
    `export function f(k) { const x=k|0; let h=x*x; return [h|0,h&255,h>>>0,Math.imul(h,3)] }`,
    `export function f(k) { const x=k|0; let h=x*x-(x-1)*(x+1); return h|0 }`,
    `export function f(k) { let x=k|0; x*=x; return x|0 }`,
    `export function f(k) { const x=k|0; let h=x*x; const a=new Int32Array(1);a[0]=h;return a[0] }`,
    `export function f() { let x=2147483647;x*=2147483647;return x|0 }`,
  ]
  for (const optimize of levels(0, 1, 2, 3, 'size')) for (const src of sources) {
    const actual=run(src,{optimize}).f, expected=oracle(src).f
    for (const k of [0,-0,1,-1,65537,67108865,94906265,94906266,2147483647,-2147483648,2147483647,0])
      is(actual(k),expected(k),`O${optimize}: ${k}`)
  }
})

test('word local: copy chains and cycles keep words through loop entry and exit', () => {
  const sources = [
    `export function f(x,n) { let h=x*1.25;let a=h;let b=a;
      for(let i=0;i<n;i++){h=(x+i)*1.25;a=h;b=a}
      return(h|0)^(a<<3)^(b>>>1) }`,
    `export function f(x,n) { let h=x*.5;let a=1.25;let b=2.75;
      for(let i=0;i<n;i++){a=h;b=a;h=b;h=(x+i)*1.25}
      return(h|0)^(a<<3)^(b>>>1) }`,
  ]
  for (const src of sources) {
    for (const name of ['h', 'a', 'b']) word(src, name)
    for (const optimize of levels(0, 1, 2, 3, 'size')) {
      const actual = run(src, { optimize }).f, expected = oracle(src).f
      for (const x of NUMS) for (const n of [0, 1, 3, 0]) is(actual(x, n), expected(x, n), `O${optimize}: ${x}/${n}`)
    }
  }
})

test('word local: one magnitude observer rejects every preceding copy', () => {
  const sources = [
    `export function f(x,n) { let h=x*1.25;let a=h;let b=a;
      for(let i=0;i<n;i++){a=h;b=a;h=b}return[h|0,a&255,b] }`,
    `export function f(x,n) { let h=x*1.25;let a=h;const read=()=>a;
      for(let i=0;i<n;i++){h=(x+i)*1.25;a=h}return[h|0,read()] }`,
    `export function f(x,n) { let h=x*1.25;let a=h;
      for(let i=0;i<n;i++){h=(x+i)*1.25;a=h;a+=.5}return[h|0,a|0] }`,
    `export function f(x,n) { let h=x*1.25;n=h;return n }`,
    `let saved=0;export function f(x,n) { let h=x*1.25;saved=h;return saved }`,
    `export function f(x,n) { let h=x*1.25;let a=0;return(a=h) }`,
    `function observe(value){return value}export function f(x,n) { let h=x*1.25;return observe(h) }`,
  ]
  for (const src of sources) {
    wide(src)
    for (const optimize of levels(0, 1, 2, 3, 'size')) {
      const actual = run(src, { optimize: { level: optimize, sourceInline: false } }).f, expected = oracle(src).f
      for (const x of NUMS) for (const n of [0, 2, 0]) is(actual(x, n), expected(x, n), `O${optimize}: ${x}/${n}`)
    }
  }
})

test('word local: a copied product preserves Number rounding before its word', () => {
  const src = `export function f(k,n) { const x=k|0;let h=x*x;let a=h;
    for(let i=0;i<n;i++){a=h;h=a}return[h|0,a&255,a>>>0] }`
  for (const optimize of levels(0, 1, 2, 3, 'size')) {
    const actual = run(src, { optimize }).f, expected = oracle(src).f
    for (const k of [0, -0, 1, -1, 94906265, 94906266, 2147483647, -2147483648, 0])
      for (const n of [0, 1, 3]) is(actual(k, n), expected(k, n), `O${optimize}: ${k}/${n}`)
  }
})

test('word local: an FNV hash seeded above 2^31', () => {
  const src = `export let f = (n, k) => {
    let h = 2166136261
    for (let i = 0; i < n; i++) h = Math.imul(h ^ (i * k), 16777619)
    h ^= h >>> 16
    return h >>> 0 }`
  word(src)
  for (const n of [0, 1, 5, 1000]) for (const k of [1, 31, 65537]) agree(src, 'f', [n, k])
})

test('word local: a bare argument of Math.imul and Math.clz32', () => {
  const src = `export let f = (n, k) => {
    let h = 3735928559
    for (let i = 0; i < n; i++) { h = Math.imul(h, 1540483477); h ^= k + i }
    return Math.clz32(h) + (h & 65535) }`
  word(src)
  for (const n of [0, 1, 9]) for (const k of [0, 3, 1e9]) agree(src, 'f', [n, k])
})

test('word local: any number written, fractions and non-finite included', () => {
  const src = `export let f = (x, n) => {
    let t = x * 0.5, s = 0
    for (let i = 0; i < n; i++) { s += (t | 0) + (t & 255) + (t >>> 28) + (~t) + (t << 3) + (t >> 2); t = (x + i) * 1.25 }
    return s }`
  word(src, 't')
  for (const x of NUMS) for (const n of [1, 3]) agree(src, 'f', [x, n])
})

test('word local: the value stored to an integer element', () => {
  const src = `export let f = (n) => {
    const a = new Int32Array(2), b = new Uint32Array(2), c = new Uint8Array(2), d = new Int16Array(2)
    let h = 2166136261
    for (let i = 0; i < n; i++) h = Math.imul(h ^ i, 16777619)
    a[0] = h; b[0] = h; c[0] = h; d[0] = h
    return a[0] + b[0] * 3 + c[0] * 5 + d[0] * 7 }`
  word(src)
  for (const n of [0, 1, 4, 77]) agree(src, 'f', [n])
})

test('word local: a possibly missing element read as a word', () => {
  // `undefined & 255` is 0 and `undefined >>> 4` is 0: the word of a missing element is zero.
  const src = `export let f = (a, k) => { let h = a[k]; return (h & 255) + (h >>> 4) }`
  if (!belowOpt(2)) ok(storage(src, 'f', 'h') !== 'f64', 'h holds its word or none')
  for (const k of [0, 1, 2, 3, 7, -1]) agree(src, 'f', [new Int32Array([300, 2, -1]), k], `k=${k}`)
})

test('word local: a returned number stays a number', () => {
  const src = `export let f = (n) => { let h = 2166136261; for (let i = 0; i < n; i++) h = Math.imul(h ^ i, 16777619); return h }`
  wide(src)
  for (const n of [0, 1, 4]) agree(src, 'f', [n])
})

test('word local: a compared number stays a number', () => {
  const src = `export let f = (n) => { let h = 2166136261; for (let i = 0; i < n; i++) h = Math.imul(h ^ i, 16777619); return (h === 2166136261 ? 10 : 20) + (h & 3) }`
  wide(src)
  for (const n of [0, 1, 4]) agree(src, 'f', [n])
  const src2 = `export let f = (n) => { let h = 4294967296 * n; return (h ? 1 : 2) + (h | 0) }`
  wide(src2)
  for (const n of [0, 1, 2]) agree(src2, 'f', [n])
})

test('word local: an index stays a number', () => {
  // An element index is no ToInt32 sink. The values stay below 2^31: past it the
  // dialect's 32-bit indices (README, "Where behaviour differs") already differ.
  const src = `export let f = (n, k) => {
    const a = new Int32Array(8)
    for (let i = 0; i < 8; i++) a[i] = i * i + 1
    let h = n * 1.5, s = 0
    for (let i = 0; i < k; i++) { s += a[h] + (h & 7); h = (n + i) * 2 }
    return s }`
  wide(src)
  for (const n of [0, 2]) for (const k of [1, 3]) agree(src, 'f', [n, k])
})

test('word local: a stepped number stays a number', () => {
  const src = `export let f = (x) => { let h = x; h += 0.5; h += 0.5; return h | 0 }`
  wide(src)
  for (const x of NUMS) agree(src, 'f', [x])
  const src2 = `export let f = (x) => { let h = x + 0.75; h++; return (h | 0) ^ (h & 15) }`
  wide(src2)
  for (const x of NUMS) agree(src2, 'f', [x])
})

test('word local: a float or clamped store stays a number', () => {
  const src = `export let f = (n) => { const a = new Float64Array(1), c = new Uint8ClampedArray(1); let h = 2166136261 + n; a[0] = h; c[0] = h; return a[0] + c[0] + (h & 1) }`
  wide(src)
  for (const n of [0, 1, -2166136261, 0.5]) agree(src, 'f', [n])
})

test('word local: a captured number stays a number', () => {
  const src = `export let f = (n) => { let h = 2166136261 + n; const g = () => h; return g() + (h & 1) }`
  if (!belowOpt(2)) is(storage(src, 'f', 'h'), null, 'a captured binding lives in its cell')
  for (const n of [0, 1]) agree(src, 'f', [n])
})

test('word local: the weld hash of a vertex', () => {
  // The shape this was found on (three.js MikkTSpace, weldVertices): FNV over the
  // bits of each float, -0 folded to 0, then an open-addressed probe.
  const src = `export let f = (n) => {
    const p = new Float32Array(n * 3), bits = new Uint32Array(p.buffer, p.byteOffset, p.length)
    for (let i = 0; i < p.length; i++) p[i] = ((i * 7919) % 13 - 6) / 4
    const table = new Int32Array(64), mask = table.length - 1
    let sum = 0
    for (let v = 0; v < n; v++) {
      let hash = 2166136261
      for (let c = 0; c < 3; c++) hash = Math.imul(hash ^ (p[v * 3 + c] === 0 ? 0 : bits[v * 3 + c]), 16777619)
      hash ^= hash >>> 16
      let slot = hash & mask
      while (table[slot]) slot = (slot + 1) & mask
      table[slot] = v + 1
      sum += slot * (v + 1)
    }
    return sum }`
  word(src, 'hash')
  for (const n of [0, 1, 7, 20]) agree(src, 'f', [n])
  if (!belowOpt(2)) ok(!/\$__to_num|\$__dyn_/.test(funcWat(wat(src), 'f')), 'no dynamic conversion in the kernel')
})

test('word local: the pass changes no value', () => {
  const src = `export let f = (n, k) => {
    let h = 2166136261
    for (let i = 0; i < n; i++) h = Math.imul(h ^ (i * k), 16777619)
    h ^= h >>> 16
    return h >>> 0 }`
  // (the integer pass carries the hash in an integer of its own: off as well)
  const OFF = { optimize: { level: 2, wordLocals: false, intNarrow: false } }
  word(src)
  ok(new RegExp('\\(local \\$(?:\\w+_)?h f64\\)').test(funcWat(wat(src, OFF), 'f')), 'off: h keeps the number')
  for (const n of [0, 1, 9, 300]) for (const k of [1, 97]) is(run(src).f(n, k), run(src, OFF).f(n, k))
})
