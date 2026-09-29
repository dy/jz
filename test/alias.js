// A spliced call leaves names for one value and statements in its caller's
// lists. A binding that only ever holds another binding's value is that binding
// (src/compile/plan/alias.js, pass `aliases`), a list inside a body splits over
// the bindings it declares (prepare/split-bindings.js), a body that makes
// closures splices with them and a lambda in a list of its own splices where it
// is called (plan/inline.js), a loop that calls its parameter splices where the
// argument is a function, and a read of a name an object literal does not
// declare is undefined (plan/literals.js). With the names gone a library's
// series through a generator closure, its options object and its two results
// through an array are loops over locals. Every form answers what the host
// answers.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { belowOpt, levels } from './_matrix.js'
import { funcWat, oracle, run, wat } from './util.js'

const EPS = 'var EPS = 2.220446049250313e-16\n'
// a series summed from a generator, as a numeric library writes it
const SUM = `function sumSeries(generator, options) {
  var isgenerator, tolerance, nextTerm, counter, result, opts
  opts = {}
  if (arguments.length > 1) opts = options
  tolerance = opts.tolerance || EPS
  counter = opts.maxTerms || 1000000
  result = opts.initialValue || 0
  isgenerator = typeof generator.next === 'function'
  if (isgenerator === true) {
    for (nextTerm of generator) { result += nextTerm; if (Math.abs(tolerance * result) >= Math.abs(nextTerm) || --counter === 0) break }
  } else {
    do { nextTerm = generator(); result += nextTerm } while (Math.abs(tolerance * result) < Math.abs(nextTerm) && --counter)
  }
  return result
}
`
const SERIES = `function series(x) {
  var mult = -x, prod = -1.0, k = 0
  return next
  function next() { prod *= mult; k += 1; return prod / k }
}
`
// two results through an array, two helpers deep
const PAIR = `var SMALLEST = 2.2250738585072014e-308, SCALE = 4503599627370496
function normalize(x, out, stride, offset) {
  if (x !== x || x === Infinity || x === -Infinity) { out[offset] = x; out[offset + stride] = 0; return out }
  if (x !== 0 && (x < 0 ? -x : x) < SMALLEST) { out[offset] = x * SCALE; out[offset + stride] = -52; return out }
  out[offset] = x; out[offset + stride] = 0
  return out
}
function split(x, out, stride, offset) {
  var parts = normalize(x, [0, 0], 1, 0)
  out[offset] = parts[0] * 0.5
  out[offset + stride] = parts[1] + 1
  return out
}
function frexp(x) { return split(x, [0, 0], 1, 0) }
`
const DRIVER = (call, reduce = 'r') => `const X = new Float64Array(64), OUT = new Float64Array(64)
export let xs = () => X
export let outs = () => OUT
export let each = (n) => { for (let i = 0; i < n; i++) { const r = ${call}; OUT[i] = ${reduce} } }
export let loop = (n) => { let s = 0; for (let i = 0; i < n; i++) { const r = ${call}; s += ${reduce} } return s }
`
const INPUTS = Float64Array.from({ length: 64 }, (_, i) => i === 0 ? 0 : i === 1 ? -0 : i === 2 ? NaN : i === 3 ? Infinity : i === 4 ? 3e-310 : (i - 32) / 40)

const kernels = {
  'a series through a closure and an options object': EPS + SUM + SERIES + 'function log1pmx(x) { var opts = { initialValue: -x }; return sumSeries(series(x), opts) }\n' + DRIVER('log1pmx(X[i] * 0.9)'),
  'a series from three callers': EPS + SUM + SERIES +
    'function a(x) { return sumSeries(series(x), { initialValue: -x }) }\nfunction b(x) { return 2 * sumSeries(series(x * 0.5)) }\nfunction c(x) { var s = series(x * 0.25); return sumSeries(s, { initialValue: 1, maxTerms: 5 }) + 1 }\n' +
    DRIVER('a(X[i] * 0.9) + b(X[i] * 0.9) * c(X[i] * 0.9)'),
  'two results through an array, two helpers deep': PAIR + DRIVER('frexp(X[i])', 'r[0] + r[1]'),
  'a closure over a parameter the caller stores to after': 'function make(v) { return get\n  function get() { return v * 2 } }\n' + DRIVER('twice(X[i])') +
    'function twice(x) { var y = x; var g = make(y); y = y + 100; return g() + y }\n',
  'a closure that counts across its calls': 'function counter(step) { var n = 0; return next\n  function next() { n += step; return n } }\n' +
    'function run(x) { var c = counter(x); c(); c(); return c() }\n' + DRIVER('run(X[i])'),
}

const agree = (src, opts, label) => {
  const host = oracle(src)
  host.xs().set(INPUTS); host.each(64)
  const want = host.outs().slice(), sum = host.loop(64)
  for (const optimize of levels(0, 2, 3)) {
    const m = run(src, { jzify: true, optimize: opts ? { level: optimize, ...opts } : optimize })
    m.xs().set(INPUTS); m.each(64)
    const got = m.outs()
    for (let i = 0; i < 64; i++) is(got[i], want[i], `${label} at ${optimize}: element ${i} (${INPUTS[i]})`)
    is(m.loop(64), sum, `${label} at ${optimize}: the sum`)
  }
}

test('alias: a library kernel answers what the host answers', () => {
  for (const [name, src] of Object.entries(kernels)) agree(src, null, name)
})

test('alias: with its names left, the kernel answers the same', () => {
  for (const [name, src] of Object.entries(kernels)) agree(src, { aliases: false }, name)
})

test('alias: the kernel is a loop over locals', () => {
  if (belowOpt(3)) return
  for (const [name, src] of Object.entries(kernels)) {
    if (name.includes('counts across') || name.includes('stores to after')) continue
    const text = wat(src, { jzify: true, optimize: 3 })
    for (const fn of ['each', 'loop']) {
      const body = funcWat(text, fn)
      ok(body.length > 0, `${name}: ${fn}`)
      ok(!/call_indirect/.test(body), `${name}: ${fn} calls through no table`)
      ok(!/\(call \$__alloc|\(call \$__mkptr|\(call \$__dyn_get/.test(body), `${name}: ${fn} makes no object and reads no key`)
    }
    ok(!/\(func \$closure\d/.test(text), `${name}: no closure is left`)
  }
})

// [source, the calls]: a name that stands for another only where it always held it
const names = {
  'a copy read after its source is stored to in an arm': ['export let f = (x, c) => { let a = x; let b = a; if (c > 0) a = a + 1; return b * 10 + a }',
    [[1, 0], [1, 1], [2.5, 1]]],
  'a copy of a parameter stored to in a loop': ['export let f = (x, n) => { let b = x; for (let i = 0; i < n; i++) x += 1; return b * 100 + x }',
    [[1, 0], [1, 3]]],
  'a name that holds one of two in its arms': ['export let f = (x, c) => { const p = x + 1, q = x * 2; let b; if (c > 0) b = p; else b = q; return b }',
    [[3, 1], [3, 0]]],
  'a name assigned in one arm only': ['export let f = (x, c) => { const p = x + 1; let b; if (c > 0) b = p; return b === undefined ? -1 : b }',
    [[3, 1], [3, 0]]],
  'a name a closure reads': ['export let f = (x) => { const p = x + 1; let b = p; const g = () => b; b = p * 2; return g() }',
    [[3], [0.5]]],
  'a copy passed among the arguments of a call': ['function take(a, b, c, d) { if (a > 100) { return take(a - 100, b, c, d) } return a * 1000 + b * 100 + c * 10 + d }\nexport let f = (x, y) => { const p = y; const q = x; return take(x, p, q, y) + take(p, 1, 2, q) }',
    [[3, 4], [0.5, 7]]],
  'a copy in a sequence': ['export let f = (x, y) => { const p = y; let r = 0; r = (r = x, p, x + p); return r + (p, x) }',
    [[3, 4], [0.5, 7]]],
  'a chain of copies': ['export let f = (x) => { const a = x * 3; const b = a; const c = b; let d; d = c; return d + c + b + a }',
    [[3], [0.5]]],
  'a copy of an array the source stores through': ['export let f = (x) => { const a = [x, x + 1]; const b = a; a[0] = 7; return b[0] + b[1] + a.length }',
    [[3], [0.5]]],
  'a lambda with a member stored': ['export let f = (x) => { const g = () => x; g.next = 5; return typeof g.next === "number" ? g.next + g() : -1 }',
    [[3]]],
  'a lambda passed to a function that stores a member': ['const tag = (h) => { h.next = () => 9; return h }\nexport let f = (x) => { const g = () => x; tag(g); return typeof g.next === "function" ? g.next() + g() : -1 }',
    [[3]]],
  'what a function has': ['export let f = (x) => { const g = (a, b) => a + b + x; return g.length * 10 + g.call(null, 1, 2) }',
    [[3]]],
  'a member no function has': ['export let f = (x) => { const g = () => x; return (typeof g.next === "function" ? 1 : 0) + (g.next === undefined ? 10 : 0) + g() }',
    [[3]]],
  'a name an object literal does not declare': ['export let f = (x) => { const o = { a: x, b: 2 }; return (o.c === undefined ? 100 : 0) + (o.c || 7) + o.a + o.b }',
    [[3], [0]]],
  'a name every object inherits': ['export let f = (x) => { const o = { a: x }; return (o.hasOwnProperty("a") ? 10 : 0) + (o.hasOwnProperty("c") ? 1 : 0) + o.a + o.toString().length }',
    [[3]]],
  'a decided test keeps its effects': ['export let f = (x) => { let n = 0; const t = true; if (t === true) n += x; else n -= x; const u = undefined; n += (u || 5); return (t && n) + (false || x) }',
    [[3], [0]]],
  'the count of arguments': ['function pick(a, b) { if (arguments.length > 1) return a + b; return arguments.length === 1 ? a * 2 : -1 }\nexport let f = (x, y) => pick(x, y) * 100 + pick(x) * 10 + pick()',
    [[3, 4], [0.5, -1]]],
  'a call stored to an element': ['const OUT = new Float64Array(4)\nlet hits = 0\nconst probe = (v) => { hits += 1; let s = 0; for (let i = 0; i < 3; i++) s += v * i; return s + hits }\nexport let f = (x, i) => { OUT[i & 3] = probe(x); OUT[(i + 1) & 3] = probe(x + 1); return OUT[i & 3] * 1000 + OUT[(i + 1) & 3] + hits }',
    [[3, 0], [0.5, 3], [1, 6]]],
  'a call stored to an element the call moves': ['const OUT = new Float64Array(4)\nlet at = 0\nconst step = (v) => { at += 1; let s = 0; for (let i = 0; i < 3; i++) s += v; return s }\nexport let f = (x) => { at = 0; OUT[0] = 0; OUT[1] = 0; OUT[at] = step(x); return OUT[0] * 100 + OUT[1] + at }',
    [[3], [0.5]]],
}

test('alias: a name stands for another only where it always held it', () => {
  for (const [name, [src, calls]] of Object.entries(names)) {
    const host = oracle(src), want = calls.map(a => host.f(...a))
    for (const optimize of levels(0, 2, 3)) {
      const m = run(src, { jzify: true, optimize })
      calls.forEach((a, i) => is(m.f(...a), want[i], `${name} at ${optimize}: f(${a.join(', ')})`))
    }
  }
})

// A list inside a body splits over the bindings it declares and nothing outside it mentions.
const lists = {
  'a binding of a loop body reassigned in it': 'export let f = (n, y) => { let s = 0; for (let i = 0; i < n; i++) { let v = i * 0.5; v = v | 0; v = v + y; s += v } return s }',
  'a binding read after its block': 'export let f = (n, y) => { let s = 0, last = -1; for (let i = 0; i < n; i++) { let v = i + y; v = v * 2; last = v; s += v } return s * 1000 + last }',
  'a binding of the body assigned in a loop': 'export let f = (n, y) => { let v = y; for (let i = 0; i < n; i++) { v = v + i; v = v * 2 } return v }',
  'a binding of an arm': 'export let f = (n, y) => { let s = 0; if (n > 2) { let v = y * 2; v = v + 1; v += n; s = v } else { let w = y; w = w - 1; s = w } return s }',
  'a binding a closure of the list reads': 'export let f = (n, y) => { let s = 0; for (let i = 0; i < n; i++) { let v = i; const g = () => v; v = v + y; s += g() } return s }',
}

test('alias: a list inside a body splits over its own bindings', () => {
  for (const [name, src] of Object.entries(lists)) {
    const host = oracle(src)
    for (const optimize of levels(0, 2, 3)) {
      const m = run(src, { optimize })
      for (const a of [[0, 1], [3, 2.5], [5, -1]]) is(m.f(...a), host.f(...a), `${name} at ${optimize}: f(${a.join(', ')})`)
    }
  }
})

test('alias: a driver of many loops is not one function', () => {
  if (belowOpt(3)) return
  // each kernel is called once: spliced, the driver would be every loop in one function
  const N = 60
  const src = 'const X = new Float64Array(256), OUT = new Float64Array(256)\n' +
    Array.from({ length: N }, (_, k) => `const k${k} = (u, out) => { for (let i = 0; i < 256; i++) { const v = u[i] * ${k + 1}; const w = v * v + ${k}; const z = w > 100 ? w - 100 : w + ${k}; const q = z * 0.5 + v; const r = q * q - w; const t = r > 0 ? r : -r; const p = t * 0.25 + z; out[i] = p + q + (v > w ? v : w) + (z > q ? z : q) * ${k + 2} } }`).join('\n') +
    `\nconst sweep = (u, out) => {\n${Array.from({ length: N }, (_, k) => `  k${k}(u, out)`).join('\n')}\n}\nexport let xs = () => X\nexport let f = () => { sweep(X, OUT); let s = 0; for (let i = 0; i < 256; i++) s += OUT[i]; return s }`
  const text = wat(src, { optimize: 3 })
  const kept = (text.match(/\(func \$k\d+/g) || []).length
  ok(kept >= N / 2, `${kept} of ${N} kernels are functions of their own`)
  const host = oracle(src), m = run(src, { optimize: 3 })
  for (let i = 0; i < 256; i++) { host.xs()[i] = i / 64 - 2; m.xs()[i] = i / 64 - 2 }
  is(m.f(), host.f(), 'the driver answers the same')
})
