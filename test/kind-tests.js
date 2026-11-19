// A test the summary's kinds decide takes one arm on every run: `x instanceof
// Float32Array` of a binding that only ever holds Float32Arrays, Array.isArray
// of one that holds none, `typeof x === 'function'` of one that holds numbers,
// a name that only holds null (summary/index.js decided). The summary walks
// the arm that runs alone, so an overloaded function, its first argument
// samples here and options there, keeps the options object's shape where only
// the samples' path runs; the plan drops the other arm (plan/fold-kind-tests.js).
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { levels } from './_matrix.js'
import { oracle, jz, compile, compileInProcess } from './util.js'
import { ctx } from '../src/ctx.js'

const src = `
let settings = (o) => ({ size: o?.frameSize ?? 2048, f: o?.factor ?? 1 })
let stretch = (data, opts) => {
  if (Array.isArray(data) && data.length) return data.map(ch => stretch(ch, opts))
  if (data instanceof Float64Array) data = Float32Array.from(data)
  if (!(data instanceof Float32Array)) return settings(data).size
  let o = settings(opts), s = 0
  for (let i = 0; i < data.length; i++) s += data[i] * o.f
  return s + o.size
}
let inp = new Float32Array(8).fill(0.5)
export let batch = (k) => stretch(inp, { factor: k, frameSize: 1024 })
let kind = (v) => v instanceof Float32Array ? 'f32' : Array.isArray(v) ? 'arr' : v instanceof Map ? 'map' : v instanceof Set ? 'set' : typeof v
export let mixed = (k) => [kind(inp), kind([1]), kind(new Map()), kind(new Set()), kind(k), kind(k > 0 ? inp : [2]), kind(inp.subarray(2))].join()
`

for (const optimize of levels(0, 2, 3, 'size'))
  test(`kind tests: decided and open tests agree with the host at ${optimize}`, () => {
    const host = oracle(src), mod = jz(src, { optimize }).exports
    for (const k of [0, 3]) {
      is(mod.batch(k), host.batch(k), `batch(${k})`)
      is(mod.mixed(k), host.mixed(k), `mixed(${k})`)
    }
  })

test('kind tests: the arm a decided test never takes loses no shape', () => {
  const entries = []
  compile(src, { warnings: w => entries.push(w) })
  const lost = entries.filter(e => e.code === 'shape-lost' && /factor|frameSize/.test(e.message))
  ok(!lost.length, lost.map(e => e.message).join('; '))
})

// An option that may be a number or a function (a stretch factor, a hop):
// given a number, `typeof f === 'function'` is false, the hook it guards stays
// null, and the object handed to the hook's call is never handed anywhere.
const hooks = `
let settings = (o) => { let f = o?.factor ?? 1, hop = typeof f === 'function' ? (t) => 512 / f(t) : 512 / f; return { hop } }
let run = (o) => { const h = settings(o).hop, fn = typeof h === 'function' ? h : null; const ctx = { a: 1, b: 2 }; let s = 0; for (let i = 0; i < 4; i++) { if (fn) ctx.a = fn(i, ctx); s += ctx.a * ctx.b + (fn ? 0 : h) } return s }
export let lit = () => run({ factor: 0.8 })
let kind = (v) => typeof v === 'number' ? 'n' : typeof v === 'string' ? 's' : typeof v === 'object' ? (v === null ? 'null' : 'o') : typeof v === 'undefined' ? 'u' : typeof v
export let kinds = (k) => [kind(1), kind('a'), kind(null), kind(undefined), kind({}), kind([]), kind(() => 1), kind(k > 0 ? 1 : 'x'), kind(k > 0 ? null : undefined)].join()`

test('kind tests: typeof and a name decide their tests where the kinds do', () => {
  const host = oracle(hooks)
  for (const optimize of levels(0, 2, 3)) {
    const mod = jz(hooks, { optimize }).exports
    is(mod.lit(), host.lit(), `lit at ${optimize}`)
    for (const k of [0, 1]) is(mod.kinds(k), host.kinds(k), `kinds(${k}) at ${optimize}`)
  }
  const entries = []
  compile(hooks, { warnings: w => entries.push(w) })
  ok(!entries.some(e => e.code === 'shape-lost'), entries.filter(e => e.code === 'shape-lost').map(e => e.message).join('; '))
})

test('kind tests: a default read by position runs only where a call leaves the argument out', () => {
  const cases = [
    `function f(a = 9) { return arguments.length * 100 + (a === null ? 10 : a === undefined ? 20 : a) }
export let g = () => f() * 1000 + f(null)`,
    `function f(a = 9) { return arguments.length * 100 + a }
export let g = () => f() * 1000 + f(5)`,
    `function f(a = 9) { return arguments.length * 100 + a }
export let g = () => f() * 1000 + f(undefined)`,
    `function f(a, b = 7) { return arguments.length * 100 + a + b }
export let g = () => f(1) * 1000 + f(1, 2)`,
  ]
  for (const src of cases) {
    const want = oracle(src).g()
    for (const optimize of levels(0, 2)) is(jz(src, { optimize }).exports.g(), want, `${src.split('\n')[1]} at ${optimize}`)
  }
})

// A decided test still runs where evaluating it may do something: a call its
// `||` evaluates before the operand that decided it, a member read that throws
// on a missing receiver.
test('kind tests: a decided test keeps its effects', () => {
  const cases = [
    `let n = 0
let bump = () => { n++; return 0 }
export let f = (k) => { const o = { a: k }; if (bump() || o) return n * 10 + o.a; return -1 }`,
    `let n = 0
let bump = () => { n++; return 1 }
export let f = (k) => { const s = 'x'; const r = (bump() && typeof s === 'number') ? 1 : 2; return n * 10 + r }`,
    `export let f = (k) => { const x = k > 0 ? 5 : null; try { if (x.foo) return 1; return 2 } catch (e) { return 3 } }`,
  ]
  for (const src of cases) for (const optimize of levels(0, 2)) {
    const js = oracle(src), mod = jz(src, { optimize }).exports
    is([mod.f(0), mod.f(1)], [js.f(0), js.f(1)], `${src.split('\n').pop()} at ${optimize}`)
  }
})

// A test of a binding the first rounds see empty (`let c = p.coefs`, the field
// holding what a function the walk meets later returns) is decided by the round
// whose kinds settled: `c` holds the array every caller builds, so the library's
// `if (!Array.isArray(c)) c = [c]` never runs, and neither does what it calls.
test('kind tests: a test is decided by the kinds the last round settles on', () => {
  const src = `let wrap = (x) => [x, x]
let total = (p) => { let c = p.coefs; if (!Array.isArray(c)) c = wrap(c); let s = 0; for (let i = 0; i < c.length; i++) s += c[i]; return s * 10 + c.length }
let design = (n) => { const a = []; for (let i = 0; i < n; i++) a.push(i * 0.5); return a }
let run = (k) => total({ coefs: design(k) })
export let f = (k) => run(k)`
  for (const optimize of levels(0, 2, 3)) is(jz(src, { optimize }).exports.f(4), oracle(src).f(4), `at ${optimize}`)
  ok(!/\$wrap/.test(compile(src, { optimize: 0, wat: true })), 'the arm never taken is gone, and the function only it calls')
})

// A sequence a fold leaves where a call's sole argument stood stays one value:
// `h(x.isV ? 1 : 2)` with `x` a number keeps the member read (it may throw)
// and passes 2 alone, not `x.isV` and 2.
test('kind tests: a folded test is one argument', () => {
  const src = `const h = (a, b) => b === undefined ? a : 100 + b
const g = (x) => h(x.isV ? 1 : 2)
export const f = () => g(3)`
  for (const optimize of levels(0, 2, 3)) is(jz(src, { optimize }).exports.f(), oracle(src).f(), `at ${optimize}`)
})

// A closure's proof about a binding it captures holds past no call where a
// closure beside it assigns the binding: `drop()` may store undefined, so the
// guard `p == null` no longer says what `p` holds (summary outerAssigned).
test('kind tests: a captured binding a closure beside assigns holds no proof past a call', () => {
  const uses = {
    'a default': ['const kernel = (d, params = { rate: 7 }) => d * params.rate', 'return kernel(3, p)'],
    'a test': ['', 'return p == null ? 9 : p.rate'],
  }
  for (const [use, [head, tail]] of Object.entries(uses)) {
    const src = `${head}
export const run = (k) => {
  let p = { rate: 2 }
  const drop = () => { p = undefined }
  const f = () => { if (p == null) return -1; if (k) drop(); ${tail} }
  return f()
}`
    for (const optimize of levels(0, 2, 3, 'size')) {
      const mod = jz(src, { optimize }).exports, host = oracle(src)
      for (const k of [0, 1]) { let a, b; try { a = mod.run(k) } catch (e) { a = e.constructor.name } try { b = host.run(k) } catch (e) { b = e.constructor.name } is(a, b, `${use}, run(${k}) at ${optimize}`) }
    }
  }
})

// A nullish or falsy test of a parameter is decided by what its calls pass
// (summary testKind, rightRuns): a parameter every call passes a typed array
// is never nullish, so `p ??= make()` never runs `make()` and `process`
// allocates nothing; one no call passes is undefined, so `p && make()` never
// runs it either. Each form below folds there; each precondition broken in
// turn keeps the test, and the answer is the host's.
const MAKE = `const make = () => new Float64Array(2)
const S = make()
S[0] = 5`
const READ = 'return p ? p[0] + d : -d'
const NULLISH_FORMS = {
  '??=': 'p ??= make()',
  '??': 'p = p ?? make()',
  '== null': 'if (p == null) p = make()',
  '=== undefined': 'if (p === undefined) p = make()',
  '=== null': 'if (p === null) p = make()',
  '!': 'if (!p) p = make()',
  '||': 'p = p || make()',
  '||=': 'p ||= make()',
  '?.': 'if (p?.length !== 2) p = make()',
}
// the forms whose right operand runs where the left is truthy
const TRUTHY_FORMS = { '&&': 'p = p && make()', '&&=': 'p &&= make()' }
const answer = (f, ...args) => { try { return f(...args) } catch (e) { return `throws ${e?.constructor?.name}` } }
const refusal = (src, optimize) => { try { compile(src, { optimize, memory: { fixed: ['process'] } }); return null } catch (e) { return e.message.split('\n')[0] } }

test('kind tests: a test of a parameter every call passes alike folds', () => {
  for (const optimize of levels(0, 2, 3, 'size')) {
    for (const [name, form] of Object.entries(NULLISH_FORMS)) {
      const src = `${MAKE}\nconst k = (d, p) => { ${form}; ${READ} }\nexport const process = (d) => k(d, S)`
      if (name !== '?.') is(refusal(src, optimize), null, `${name}: process allocates nothing at ${optimize}`)
      is(jz(src, { optimize }).exports.process(2), oracle(src).process(2), `${name} at ${optimize}`)
    }
    for (const [name, form] of Object.entries(TRUTHY_FORMS)) {
      const src = `${MAKE}\nconst k = (d, p) => { ${form}; ${READ} }\nexport const process = (d) => k(d)`
      is(refusal(src, optimize), null, `${name}: process allocates nothing at ${optimize}`)
      is(jz(src, { optimize }).exports.process(2), oracle(src).process(2), `${name} at ${optimize}`)
    }
  }
  // the optional member of a receiver never nullish is a member once planned
  const src = `${MAKE}\nconst k = (d, p) => { ${NULLISH_FORMS['?.']}; ${READ} }\nexport const process = (d) => k(d, S)`
  compileInProcess(src, { optimize: { level: 2, sourceInline: false } })
  ok(!JSON.stringify(ctx.funcs.map.get('k').body).includes('"?."'), 'x?.p is x.p')
})

// Each way a call can leave the parameter nullish, or a caller the summary
// cannot see: the kernel for a form, and the run its answers are read by.
const BROKEN = {
  'a call passes undefined': (k, form) => `const ${k} = (d, p) => { ${form}; ${READ} }\nexport const run_${k} = (d) => ${k}(d, S) * 100 + ${k}(d, undefined)`,
  'a call passes null': (k, form) => `const ${k} = (d, p) => { ${form}; ${READ} }\nexport const run_${k} = (d) => ${k}(d, S) * 100 + ${k}(d, null)`,
  'a call leaves it out': (k, form) => `const ${k} = (d, p) => { ${form}; ${READ} }\nexport const run_${k} = (d) => ${k}(d, S) * 100 + ${k}(d)`,
  'a call passes an element past the end': (k, form) => `const L_${k} = [S]\nconst ${k} = (d, p) => { ${form}; ${READ} }\nexport const run_${k} = (d) => ${k}(d, L_${k}[d > 1 ? 1 : 0]) * 100 + ${k}(d, S)`,
  'the function is exported': (k, form) => `export const ${k} = (d, p) => { ${form}; ${READ} }\nexport const run_${k} = (d) => ${k}(d, S) * 100 + ${k}(d, S)`,
  'the function is held by the host': (k, form) => `const ${k} = (d, p) => { ${form}; ${READ} }\nexport const get_${k} = () => ${k}\nexport const run_${k} = (d) => ${k}(d, S) * 100 + ${k}(d, S)`,
  'the function is called through call()': (k, form) => `const ${k} = (d, p) => { ${form}; ${READ} }\nexport const run_${k} = (d) => ${k}(d, S) * 100 + ${k}.call(null, d)`,
  'the parameter is assigned first': (k, form) => `const ${k} = (d, p, q) => { if (d > 1) p = q; ${form}; ${READ} }\nexport const run_${k} = (d) => ${k}(d, S, undefined) * 100 + ${k}(d, S, S)`,
  'a closure assigns the parameter': (k, form) => `const ${k} = (d, p) => { const drop = () => { p = undefined }; if (d > 1) drop(); ${form}; ${READ} }\nexport const run_${k} = (d) => ${k}(d, S) * 100 + ${k}(d, S)`,
  'a closure beside assigns the binding': (k, form) => `export const run_${k} = (d) => { let p = S; const drop = () => { p = undefined }; const ${k} = () => { if (d > 1) drop(); ${form}; ${READ} }; return ${k}() * 100 + ${k}() }`,
  'the parameter is read through arguments': (k, form) => `function ${k} (d) { let p = arguments[1]; ${form}; ${READ} }\nexport const run_${k} = (d) => ${k}(d, S) * 100 + ${k}(d)`,
  'the parameter is a rest element': (k, form) => `const ${k} = (d, ...ps) => { let p = ps[0]; ${form}; ${READ} }\nexport const run_${k} = (d) => ${k}(d, S) * 100 + ${k}(d)`,
}

test('kind tests: a test of a parameter some call may leave nullish stays', () => {
  const forms = Object.entries({ ...NULLISH_FORMS, ...TRUTHY_FORMS })
  for (const [why, kernel] of Object.entries(BROKEN)) {
    const src = `${MAKE}\n${forms.map(([, form], i) => kernel(`k${i}`, form)).join('\n')}`
    const host = oracle(src)
    for (const optimize of levels(0, 2, 3, 'size')) {
      const mod = jz(src, { optimize }).exports
      forms.forEach(([name], i) => {
        const k = `k${i}`
        for (const d of [1, 2]) is(answer(mod[`run_${k}`], d), answer(host[`run_${k}`], d), `${why}, ${name}, run(${d}) at ${optimize}`)
        if (mod[k]) for (const p of [undefined, null, 0]) is(answer(mod[k], 2, p), answer(host[k], 2, p), `${why}, ${name}, the host passes ${p} at ${optimize}`)
        if (mod[`get_${k}`]) for (const p of [undefined, null]) is(answer(mod[`get_${k}`](), 2, p), answer(host[`get_${k}`](), 2, p), `${why}, ${name}, the held function given ${p} at ${optimize}`)
      })
    }
  }
})
