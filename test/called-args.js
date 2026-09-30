// A function whose parameter is only called runs, for a call passing a named
// function there, as a copy calling that function by name (plan/called-args.js):
// the calls are direct, typed and inlinable, with the same results.
import test from 'tst'
import { ok } from 'tst/assert.js'
import jz from '../index.js'
import { belowOpt, levels } from './_matrix.js'
import { oracle, wat } from './util.js'

const res = (f) => { try { return f() } catch (e) { return 'throws ' + e.constructor.name } }
const agrees = (src, calls) => {
  for (const optimize of levels(0, 1, 2, 3, 'size')) {
    const js = oracle(src), m = jz(src, { optimize }).exports
    for (const [name, ...args] of calls) {
      const a = res(() => js[name](...args)), b = res(() => m[name](...args))
      ok(Object.is(a, b) || a === b, `${name}(${args.join(', ')}) at ${optimize}: ${b} for ${a}`)
    }
  }
}

// the band-limited step's shape: a residual summed over the discontinuities around a phase
const blep = `const K = 4
const lookup = (x) => x * 0.5 + 1
const step = x => x <= -K || x >= K ? 0 : lookup(x) - (x >= 0 ? 1 : 0)
const ramp = x => x <= -K || x >= K ? 0 : lookup(x) * x
function around (t, dt, at, f) {
  let p = t - at, s = 0
  if (p < 0) p += 1
  for (let x = p / dt; x < K; x += 1 / dt) s += f(x)
  for (let x = (p - 1) / dt; x > -K; x -= 1 / dt) s += f(x)
  return s
}
export let wave = (t, dt, sq) => sq ? around(t, dt, 0, step) - around(t, dt, 0.5, step) : around(t, dt, 0.5, ramp) - around(t, dt, 0, ramp)
export let run = (n) => { let s = 0; for (let i = 0; i < n; i++) s += wave((i * 0.013) % 1, 0.37, i & 1); return s }`

test('called args: a function given as an argument it only calls is called directly', () => {
  agrees(blep, [['run', 100], ['wave', 0.3, 0.2, 1], ['wave', 0.9, 0.05, 0]])
  if (!belowOpt(2)) ok(!/call_indirect/.test(wat(blep, { optimize: 2 })), 'no indirect call')
})

// The copies pass `undefined` where the function was: step and ramp are no values
// then, and each (a leaf over a leaf, lookup, that both call) splices into the sums.
test('called args: the function a copy calls splices into its loops', () => {
  if (belowOpt(2)) return
  const w = wat(blep, { optimize: 2 })
  ok(!/\(call \$(step|ramp|lookup)\b/.test(w), 'step, ramp and lookup spliced')
  ok(!/\(elem/.test(w), 'no function table')
})

test('called args: a parameter used otherwise, or a name that may change, keeps the value', () => {
  // the parameter is also read as a value
  agrees(`const a = x => x + 1, b = x => x * 2
    function ap (f, x) { return f === a ? f(x) + 100 : f(x) }
    export let run = (x) => ap(a, x) + ap(b, x)`, [['run', 3]])
  // the function name is assigned elsewhere
  agrees(`let g = x => x + 1
    function ap (f, x) { return f(x) }
    export let run = (x, c) => { if (c) g = y => y * 10; return ap(g, x) }`, [['run', 3, 0], ['run', 3, 1]])
  // a local of the callee shadows the argument's name
  agrees(`const h = x => x + 1
    function ap (f, x) { let h = 7; return f(x) + h }
    export let run = (x) => ap(h, x)`, [['run', 3]])
  // passed along, recursively
  agrees(`const inc = x => x + 1
    function rep (f, x, n) { return n ? rep(f, f(x), n - 1) : x }
    export let run = (x) => rep(inc, x, 5)`, [['run', 3]])
  // a default fills the parameter
  agrees(`const inc = x => x + 1, dec = x => x - 1
    function ap (x, f = dec) { return f(x) }
    export let run = (x) => ap(x, inc) + ap(x)`, [['run', 3]])
})

test('called args: other parameter defaults can read, capture or reassign the specialized argument', () => {
  for (const params of ['x = f(3)', 'x = (f = dec)(3)']) agrees(`
    function inc(x) { return x + 1 }
    function dec(x) { return x - 1 }
    function ap(f, ${params}) { return f(x) }
    export function run(supplied) { return supplied ? ap(inc, 7) : ap(inc) }`,
  [['run', 0], ['run', 0], ['run', 1], ['run', 0]])
  for (const value of ['f', 'x => f(x)']) agrees(`
    function inc(x) { return x + 1 }
    function ap(f, other = ${value}) { return f(2) + other(3) }
    export function probe() { return ap(inc) }`, [['probe'], ['probe']])
  agrees(`function pick(mode, x = (mode = 'b')) { return mode === 'a' ? 1 : 2 }
    export function run(supplied) { return supplied ? pick('a', 7) : pick('a') }`,
  [['run', 0], ['run', 0], ['run', 1], ['run', 0]])
})

test('called args: nested closures keep captured argument values and writes', () => {
  for (const [getter, call] of [['() => [f][0]', 'get()(3)'], ['() => () => f', 'get()()(3)']]) agrees(`
    function inc(x) { return x + 1 }
    function ap(f) { const get = ${getter}; return f(2) + ${call} }
    export function probe() { return ap(inc) }`, [['probe'], ['probe']])
  agrees(`function pick(mode) {
      const change = () => { mode = 'b' }
      if (mode === 'a') change()
      return mode === 'b' ? 2 : 1
    }
    export function probe() { return pick('a') }`, [['probe'], ['probe']])
})

// A mode string per call site: the copy reads the literal, its tests decide and
// the arms they rule out go (the band-limited `wave(type, t, dt)` of synth-osc).
const modes = `const around = (t, dt) => t * dt
function wave (type, t, dt) {
  if (type === 'sine') return Math.sin(2 * Math.PI * t)
  let bl = dt > 0
  if (type === 'sawtooth') return 1 - 2 * t + (bl ? 2 * around(t, dt) : 0)
  if (type === 'square') return (t < 0.5 ? 1 : -1) + (bl ? 2 * (around(t, dt) - around(t - 0.5, dt)) : 0)
  if (type === 'triangle' || type === 'tri') return (t < 0.5 ? 1 - 4 * t : 4 * t - 3)
  throw new RangeError('wave: unknown type ' + type)
}
export let run = (n, k) => { let s = 0; for (let i = 0; i < n; i++) { let t = (i * 0.013) % 1; s += k === 0 ? wave('square', t, 0.01) : k === 1 ? wave('sawtooth', t, 0.01) : k === 2 ? wave('tri', t, 0.01) : wave('saw', t, 0.01) } return s }
export let tone = (t) => { try { return Math.round(wave('sine', t, 0) * 1e9) } catch (e) { return -1 } }`

test('called args: a string a function tests its parameter against settles in a copy', () => {
  agrees(modes, [['run', 100, 0], ['run', 100, 1], ['run', 100, 2], ['tone', 0.3], ['run', 3, 3]])
  if (belowOpt(2)) return
  ok(!/call \$__str_eq/.test(wat(modes, { optimize: 2 })), 'no string test left where every mode is a literal')
})

test('called args: a parameter written, seen by a closure, or given many strings keeps its body', () => {
  agrees(`function f (m, x) { if (m === 'a') m = 'b'; return m === 'b' ? x + 1 : x }
    export let run = (x) => f('a', x) + f('b', x) + f('c', x)`, [['run', 3]])
  agrees(`function f (m, x) { let g = () => m === 'a' ? 1 : 2; return g() + x }
    export let run = (x) => f('a', x) + f('b', x)`, [['run', 3]])
  const many = Array.from({ length: 9 }, (_, i) => `f('m${i}', x)`).join(' + ')
  agrees(`function f (m, x) { return m === 'm3' ? x * 3 : m === 'm7' ? x * 7 : x }
    export let run = (x) => ${many}`, [['run', 2]])
})
