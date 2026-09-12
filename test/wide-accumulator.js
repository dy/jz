// Wide integer accumulation (src/optimize/wide-accumulator.js): an f64
// accumulator updated by int32 steps and read only through ToInt32 sinks is
// carried as i64 in a guarded loop clone, falling back to the original f64
// loop at the iteration where it would leave the exact-integer range.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz, { compile } from '../index.js'
import { levels, onKernel } from './_matrix.js'
import { oracle, funcWat } from './util.js'
import { genProgram } from '../scripts/perf-corpus.mjs'

const fn = (body) => `export function f(n,p,a){${body}}`
const PROGRAMS = {
  caught: fn('let acc=0;try{for(let i=0;i<n;i++){acc+=((p^i)|0);if(i===2)throw 3}}catch(e){}return acc'),
  signedZero: fn('let acc=0;for(let i=0;i<n;i++)acc=-0-(acc+((p^i)&0));return 1/acc'),
  seed15: genProgram('mixed', 15).replace('export let f = (n, p0, p1, p2) =>', 'export function f(n, p0, p1, p2)'),
  seed29: genProgram('mixed', 29).replace('export let f = (n, p0, p1, p2) =>', 'export function f(n, p0, p1, p2)'),
  // Grows by INT32_MAX per trip: leaves the exact range after 2²² trips, where JS rounds.
  bail: fn('let acc=0;for(let i=0;i<n;i++)acc=acc+((2147483647+(acc|0)*0)|0);return acc'),
  negative: fn('let acc=0;for(let i=0;i<n;i++)acc=acc-((p|0)+(acc&0));return acc'),
  ring: fn('let acc=0;for(let i=0;i<n;i++)acc=acc+(((acc+(p^i))|0)>>1);return acc'),
  sum: fn('let acc=0;for(let i=0;i<n;i++)acc=acc+((3<<acc)|0)+((p|0)&(i|0));return acc'),
  twoSteps: fn('let acc=0;for(let i=0;i<n;i++){acc=acc+((p^i)|0);if((acc&7)==5)break;if((acc&3)==1)continue;acc=acc+1}return acc'),
  fromParam: fn('let acc=+a;for(let i=0;i<n;i++)acc=acc+(((acc|0)^(p^i))|0);return acc'),
  pair: fn('let x=0,y=1;for(let i=0;i<n;i++){x=x+((y|0)^i);y=y+((x|0)|1)}return x*3+y'),
  early: fn('let acc=0;for(let i=0;i<n;i++){acc=acc+((p^i)|0);if((acc|0)==-77)return i}return acc'),
  whileSink: fn('let acc=0,i=0;while((acc|0)!=-1&&i<n){acc=acc+((p^i)|0);i++}return acc'),
  outer: fn('let acc=0;for(let j=0;j<3;j++){for(let i=0;i<n;i++)acc=acc+((p^i)|0);acc=acc+((acc>>2)|0)}return acc'),
}
// Zero trips, short and long runs (below and past the 2²² INT32_MAX trips of `bail`),
// then entry values: -0, a fraction, NaN, ±∞, and integers around ±2⁵³.
const ARGS = [[-1, 7, 0], [0.5, 7, 0], [NaN, 7, 0], [0, 1.5, 0], [1, 1.5, 0], [7, 1.5, 0], [1000, 2.7, 0], [500000, 0.3, 0], [3000000, 1.5, 0], [6000000, 7, 0],
  [50, 1.5, -0], [50, 1.5, 0.5], [50, 1.5, NaN], [50, 1.5, Infinity], [50, 1.5, -Infinity],
  [50, 1.5, 2 ** 53], [50, 1.5, -(2 ** 52)], [3, 1.5, 9e15], [3, 1.5, -9007194324828160]]

test('wide accumulator: every shape matches JS at every tier and regime', () => {
  for (const [name, src] of Object.entries(PROGRAMS)) {
    const want = oracle(src).f
    for (const optimize of levels(0, 2, 3, 'size')) {
      const got = jz(src, { optimize }).exports.f
      for (const args of ARGS) is(got(...args), want(...args), `${name} ${optimize} (${args.join(',')})`)
    }
  }
})

test('wide accumulator: the clone converts nothing per iteration; the size tier keeps one loop', () => {
  if (onKernel()) return
  const count = (text, re) => (text.match(re) || []).length
  for (const name of ['seed15', 'seed29', 'bail', 'ring', 'sum', 'twoSteps', 'fromParam', 'pair', 'early', 'whileSink']) {
    const src = PROGRAMS[name]
    const versioned = funcWat(compile(src, { optimize: { level: 2, watr: false, wideAccumulator: true }, wat: true }), 'f')
    const plain = funcWat(compile(src, { optimize: { level: 2, watr: false, wideAccumulator: false }, wat: true }), 'f')
    const carriers = count(versioned, /\(local \$__wa\d+ i64\)/g)
    ok(carriers >= 1, `${name}: carried as i64`)
    // The versioned body keeps every original conversion (the fallback loop) and adds
    // exactly one entry round-trip per carrier: the fast clone itself converts nothing.
    is(count(versioned, /i64\.trunc_sat_f64_s/g), count(plain, /i64\.trunc_sat_f64_s/g) + 2 * carriers, `${name}: no conversion inside the fast loop`)
    ok(/i64\.(add|sub)/.test(versioned), `${name}: integer update`)
    ok(!/\$__wa\d+/.test(compile(src, { optimize: 'size', wat: true })), `${name}: size tier is not versioned`)
  }
  // A plain f64 read of the accumulator inside the loop declines the whole loop.
  const plainRead = fn('let acc=0,s=0;for(let i=0;i<n;i++){acc=acc+((p^i)|0);s+=acc*0.5}return s+(acc|0)')
  ok(!/\$__wa\d+/.test(compile(plainRead, { optimize: 2, wat: true })), 'declined: f64 read')
})

// Exceptions must preserve the pre-throw accumulator, including observations
// after the catch. These functions deliberately decline versioning.
test('wide accumulator: caught exits and signed zero retain the scalar loop', () => {
  for (const name of ['caught', 'signedZero']) {
    const src = PROGRAMS[name]
    for (const n of [0, 1, 2, 4]) is(jz(src, { optimize: 'speed' }).exports.f(n, 7), oracle(src).f(n, 7), `${name} n=${n}`)
    if (!onKernel()) ok(!/\$__wa/.test(compile(src, { optimize: { level: 2, watr: false, wideAccumulator: true }, wat: true })), `${name}: declined`)
  }
})

test('wide accumulator: a guard temporary read after the loop remains live', () => {
  const src = fn('let acc=0,t=0;for(let i=0;i<n;i++){t=acc+((p^i)|0);acc+=t|0}return t+acc')
  const want = oracle(src).f
  for (const optimize of levels(0, 2, 3, 'size')) {
    const got = jz(src, { optimize }).exports.f
    for (const n of [0, 1, 4, 1000]) is(got(n, 7), want(n, 7), `${optimize} n=${n}`)
  }
})

test('wide accumulator: deleted conversion tees cannot feed a later read', async () => {
  const { default: parseWat } = await import('watr/parse')
  const { wideAccumulator } = await import('../src/optimize/wide-accumulator.js')
  const fn = parseWat(`(func $f (param $n i32) (result f64)
    (local $i i32) (local $acc f64) (local $tmp f64)
    (block $exit (loop $loop
      (br_if $exit (i32.ge_s (local.get $i) (local.get $n)))
      (local.set $acc (f64.add (local.get $acc) (f64.convert_i32_s
        (select (i32.wrap_i64 (i64.trunc_sat_f64_s
          (local.tee $tmp (f64.add (local.get $acc) (f64.const 1)))))
          (i32.const 0) (f64.ne (local.get $tmp) (f64.const inf))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $loop)))
    (local.get $tmp))`)
  const before = JSON.stringify(fn)
  wideAccumulator(fn)
  is(JSON.stringify(fn), before, 'live-out guard temporary prevents the rewrite')
})
