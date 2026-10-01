// `%` of a runtime divisor (module/core.js `__rem`): the dividend below the
// divisor is itself, below twice the divisor one exact subtraction, integers
// with the dividend below 2^53 the quotient's truncation, anything else the
// long division of `__rem_div`. The first two are the whole of
// `__rem`, small enough for the engine to inline at a ring buffer's wrap
// (`(p + 1) % n`, `(x % n + n) % n`). Every sign, zero, infinity and NaN
// agrees with the host.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { belowOpt, levels } from './_matrix.js'
import { funcWat, oracle, run, wat } from './util.js'

const VALUES = [0, -0, 1, -1, 2.5, -2.5, 3, -3, 5, 6, 7, 10, 0.1, 0.3, 4.999999999999999, 9.999999999999998, 2 ** 31, -(2 ** 31), 2 ** 53, 1e300, -1e300,
  5e-324, Number.MAX_VALUE, -Number.MAX_VALUE, Infinity, -Infinity, NaN]
const src = `export let rem = (a, b) => a % b
export let wrap = (x, n) => (x % n + n) % n
export let ring = (n, len, steps) => { let buf = new Float64Array(len), p = 0, s = 0
  for (let i = 0; i < steps; i++) { buf[p] = i; s += buf[(p + len - 1) % len]; p = (p + 1) % n } return s + p }`

test('remainder: integer dividends retain zero sign through returns, storage and updates', () => {
  const source = `
    export function direct(x) { return (x | 0) % 3 }
    export function negative(x) { return (x | 0) % -3 }
    export function local(x) { const r = (x | 0) % 3; return r }
    export function update(x) { let r = x | 0; r %= 3; return r }
    export function runtime(x, y) { let r = x | 0; r %= y | 0; return r }
    export function truncated(x, y) { let r = x | 0; r %= y | 0; return r | 0 }
    export function member(x) { const a = new Int32Array([x]); return a[0] % 3 }
    export function effect(x) { let calls = 0; function next() { calls++; return x | 0 }
      const r = next() % 3; return [r, calls] }
  `
  const host = oracle(source)
  for (const optimize of levels(0, 1, 2, 3, 'size')) {
    const wasm = run(source, { optimize })
    for (const x of [0, -0, -6, -6, 6, -1, 1, -2147483648, 2147483647, NaN, 0]) {
      for (const name of ['direct', 'negative', 'local', 'update', 'member'])
        ok(Object.is(wasm[name](x), host[name](x)), `${optimize}: ${name}(${x})`)
      for (const y of [0, -1, 1, 3, -3, -2147483648]) for (const name of ['runtime', 'truncated'])
        ok(Object.is(wasm[name](x, y), host[name](x, y)), `${optimize}: ${name}(${x}, ${y})`)
      const got = wasm.effect(x), want = host.effect(x)
      ok(Object.is(got[0], want[0]) && got[1] === 1, `${optimize}: dividend runs once`)
    }
  }
})

test('remainder: every pair of operands agrees with the host', () => {
  for (const optimize of levels(0, 2, 3)) {
    const host = oracle(src), m = run(src, { optimize })
    let bad = 0
    for (const a of VALUES) for (const b of VALUES) {
      if (!Object.is(m.rem(a, b), host.rem(a, b)) || !Object.is(m.wrap(a, b), host.wrap(a, b))) { bad++; is(m.rem(a, b), host.rem(a, b), `${a} % ${b} at ${optimize}`); is(m.wrap(a, b), host.wrap(a, b), `wrap(${a}, ${b}) at ${optimize}`) }
    }
    is(bad, 0, `no pair disagrees at ${optimize}`)
    for (const [n, len, steps] of [[7, 7, 30], [5, 8, 30], [1, 3, 10], [0, 4, 6], [2.5, 4, 9]])
      ok(Object.is(m.ring(n, len, steps), host.ring(n, len, steps)), `ring(${n}, ${len}, ${steps}) at ${optimize}`)
  }
})

test('remainder: positive runtime integer divisors use exact word arithmetic', () => {
  const source = `
    export function unsigned(x, y) { const d = (y & 255) + 1; const r = (x >>> 0) % d; return r }
    export function signed(x, y) { return (x | 0) % ((y & 255) + 1) }
    export function bounded(x, y) { const r = (x & 65535) % ((y & 255) + 1); return r }
    export function order(x, y) { let a = x | 0; const r = a % ((a = y & 255) + 1); return [r, a] }
  `
  const host = oracle(source)
  for (const optimize of levels(0, 1, 2, 3, 'size')) {
    const wasm = run(source, { optimize })
    for (const x of [0, -0, -6, 6, -1, 2147483647, 2147483648, 4294967295, NaN])
      for (const y of [0, 1, 2, 255, -1, 0]) {
        for (const name of ['unsigned', 'signed', 'bounded'])
          ok(Object.is(wasm[name](x, y), host[name](x, y)), `${optimize}: ${name}(${x}, ${y})`)
        const got = wasm.order(x, y), want = host.order(x, y)
        ok(Object.is(got[0], want[0]) && got[1] === want[1], `${optimize}: dividend precedes divisor assignment`)
      }
  }
  const text = wat(source, { optimize: 0 })
  ok(text.includes('i32.rem_u'), 'unsigned integer remainder is native')
  ok(text.includes('i32.rem_s'), 'signed integer remainder is native')
  for (const name of ['unsigned', 'signed', 'bounded'])
    ok(!funcWat(text, name).includes('call $__rem'), `${name}: proved nonzero divisor needs no generic remainder helper`)
})

test('remainder: cyclic bounds preserve fractions and negative writes', () => {
  const source = `
    export function fraction(n) { let j = 0; for(let i = 0; i < n; i++) j = (j + 0.5) % 7; return j }
    export function mixed(n) { let j = 0; for(let i = 0; i < n; i++) {
      if (i === 2) j = -8; j = (j + 1) % 7
    } return j }
    export function zero(n) { let j = -0; for(let i = 0; i < n; i++) j = j % 7; return j }
  `
  const host = oracle(source)
  for (const optimize of levels(0, 1, 2, 3, 'size')) {
    const wasm = run(source, { optimize })
    for (const name of ['fraction', 'mixed', 'zero']) for (const n of [0, 1, 2, 3, 3, 4, 14, 15, 0])
      ok(Object.is(wasm[name](n), host[name](n)), `${optimize}: ${name}(${n})`)
  }
})

test('remainder: unsigned helper results retain their word proof in floating locals', () => {
  const source = `export function sequence(seed,n){
    let state=seed|0;
    const next=()=>{state=(state+1)|0;return state>>>0};
    let sum=0;
    for(let i=0;i<n;i++){const count=3+next()%5;sum+=next()%(16-count)}
    return [sum,state]
  }`
  const unsafe = `
    export function absent(x,i,y){const a=new Uint32Array([x]);const v=a[i];return v%((y&7)+1)}
    export function union(x,c,y){let v=x>>>0;if(c)v=undefined;return v%((y&7)+1)}
    export function plain(x,y){const v=x;return v%((y&7)+1)}
    export function zero(y){let v=-0;return v%((y&7)+1)}
    export function order(x,y){let value=x|0,calls=0;
      const next=()=>{calls++;value=(value+1)|0;return value>>>0};
      const r=next()%((next()&7)+1);return [r,value,calls]}
  `
  const host=oracle(source), fallback=oracle(unsafe)
  for(const optimize of levels(0,1,2,3,'size')) {
    const wasm=run(source,{optimize}), other=run(unsafe,{optimize})
    for(const seed of [0,-1,2147483646,2147483647,4294967295,NaN])
      for(const n of [0,1,2,9,9,0]) is(wasm.sequence(seed,n),host.sequence(seed,n),`${optimize}: sequence(${seed},${n})`)
    for(const x of [0,-0,-6,-1,2147483648,4294967295,2**40+0.5,NaN,Infinity])
      for(const y of [0,1,7]) {
        for(const i of [-1,0,1]) ok(Object.is(other.absent(x,i,y),fallback.absent(x,i,y)),`${optimize}: present element required`)
        for(const c of [0,1]) ok(Object.is(other.union(x,c,y),fallback.union(x,c,y)),`${optimize}: missing union retained`)
        ok(Object.is(other.plain(x,y),fallback.plain(x,y)),`${optimize}: unproven number retained`)
        ok(Object.is(other.zero(y),-0),`${optimize}: negative zero is not uint32`)
        is(other.order(x,y),fallback.order(x,y),`${optimize}: both source calls run once in order`)
      }
  }
  if(belowOpt(2)) return
  const text=wat(source,{optimize:'size'})
  ok(text.includes('i32.rem_u'),'helper results use unsigned word remainder')
  ok(!text.includes('$__rem'),'bounded divisors need no generic remainder runtime')
})

test('remainder: the wrap runs without the division loop', () => {
  if (belowOpt(2)) return
  const text = wat(src, { optimize: 2 })
  const rem = funcWat(text, '__rem')
  ok(rem.length > 0, '__rem is linked')
  ok(!/\(loop/.test(rem), '__rem itself has no loop')
  ok(/call \$__rem_div/.test(rem), 'it leaves the division to __rem_div')
})

// Integers below 2^53 take x − trunc(x/y)·y: exact, since the quotient's rounding
// error (below 1/y) never reaches an integer the true quotient is not. Pairs from
// every magnitude to 2^53, both signs, and the neighbours of 2^53 either side.
test('remainder: integer operands agree with the host at every magnitude', () => {
  const m = run(src, { optimize: 2 })
  let r = 12345, bad = 0
  const rnd = () => (r = (Math.imul(r, 1664525) + 1013904223) >>> 0) / 4294967296
  for (let i = 0; i < 20000; i++) {
    const a = Math.floor(rnd() * 2 ** Math.floor(rnd() * 54)) * (rnd() < 0.5 ? -1 : 1)
    const b = Math.max(1, Math.floor(rnd() * 2 ** Math.floor(rnd() * 40))) * (rnd() < 0.3 ? -1 : 1)
    for (const [x, y] of [[a, b], [a, 3 * b], [-0, b], [2 ** 53 - 1 - i, b], [2 ** 53 + 2 * i, b], [a + 0.5, b]])
      if (!Object.is(m.rem(x, y), x % y) && bad++ < 5) is(m.rem(x, y), x % y, `${x} % ${y}`)
  }
  is(bad, 0, 'no integer pair disagrees')
})
