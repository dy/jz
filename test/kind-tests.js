// A test the summary's kinds decide takes one arm on every run: `x instanceof
// Float32Array` of a binding that only ever holds Float32Arrays, Array.isArray
// of one that holds none, `typeof x === 'function'` of one that holds numbers,
// a name that only holds null (summary/index.js decided). The summary walks
// the arm that runs alone, so an overloaded function, its first argument
// samples here and options there, keeps the options object's shape where only
// the samples' path runs; the plan drops the other arm (plan/fold-kind-tests.js).
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { levels, onWasi } from './_matrix.js'
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

// A value a store or a method call went through is not nullish after it:
// `p.rate = 0.1` throws where `p` is undefined or null, so past it `p` is an
// object, and a call passing it lets no default run (summary deref). An
// element read that may be past the end (`chP[c]`) then reaches
// `kernel(d, params = {})` as an object, and `process` allocates nothing.
// Every store and call folds alike; every path the dereference may not be on
// keeps the default, and the answer is the host's. (A member read proves
// nothing: summary deref says why.)
const DEREF = `const chP = [{ rate: 1, v: [2] }, { rate: 3, v: [4] }]
const kernel = (d, params = { rate: 7 }) => d * params.rate`
const DEREFS = {
  'a store': 'p.rate = 0.5',
  'a computed store': 'p[KEY] = 0.5',
  'a method call': 'd += p.hasOwnProperty("rate") ? 1 : 0',
  'a compound store': 'p.rate += 1',
  'an update': 'p.rate++',
}
const derefSrc = (body) => `${DEREF}\nconst KEY = 'rate'\nexport const process = (c, d) => { let p = chP[c | 0]; ${body}; return kernel(d, p) }`
// an index store of a typed array an element read may leave missing
const ROWS = `const rows = [new Float64Array(2), new Float64Array(2)]
const kern = (d, s = new Float64Array(2)) => d + s[0] + s[1]`
const INDEXED = { 'an index store': 's[1] = d', 'an index update': 's[0]++' }

test('kind tests: a dereferenced value reaches a call as an object', () => {
  const cases = [...Object.entries(DEREFS).map(([name, body]) => [name, derefSrc(body)]),
    ...Object.entries(INDEXED).map(([name, body]) => [name, `${ROWS}\nexport const process = (c, d) => { const s = rows[c | 0]; ${body}; return kern(d, s) }`])]
  for (const optimize of levels(0, 2, 3, 'size')) for (const [name, src] of cases) {
    is(refusal(src, optimize), null, `${name}: process allocates nothing at ${optimize}`)
    const mod = jz(src, { optimize }).exports, host = oracle(src)
    for (const c of [0, 1, 2]) is(answer(mod.process, c, 2), answer(host.process, c, 2), `${name}, process(${c}) at ${optimize}`)
  }
})

// the dereference on no path to the call, or one the value may not keep
const OFF_PATH = {
  'an optional read': 'd += p?.rate ?? 0',
  'a branch': 'if (d > 1) p.rate = 0.5',
  'a loop that may not run': 'for (let i = 0; i < d - 2; i++) p.rate = 0.5',
  "a loop's update": 'for (let i = 0; i < d - 2; p.rate++) i++',
  'a logical operand': 'd > 1 && (p.rate = 0.5)',
  'a choice': 'd = d > 1 ? p.rate : d',
  'an assignment after': 'p.rate = 0.5; p = chP[c + 2]',
  'a closure that assigns it': 'const drop = () => { p = undefined }; p.rate = 0.5; if (d > 1) drop()',
  'a closure beside it assigns it': 'const drop = () => { p = undefined }; const f = () => { p.rate = 0.5; if (d > 1) drop(); return kernel(d, p) }; return f()',
  'a try whose catch goes on': 'try { p.rate = 0.5 } catch (e) { d = -d }',
  'a try whose catch calls': 'try { p.rate = 0.5 } catch (e) { return kernel(d, p) + 1000 }',
  'a finally': 'try { if (d > 1) throw 1; p.rate = 0.5 } catch (e) {} finally { d += 1 }',
  'a default': 'const f = (q, r = p.rate) => q + r; d = f(d, 1)',
  'the read after the call': 'd = kernel(d, p); p.rate',
}

test('kind tests: a value dereferenced off the path to the call stays nullish', () => {
  const src = `${DEREF}\n${Object.values(OFF_PATH).map((body, i) => `export const run${i} = (c, d) => { let p = chP[c | 0]; ${body}; return kernel(d, p) }`).join('\n')}`
  for (const optimize of levels(0, 2, 3, 'size')) {
    // (the runs store into chP's objects: each compile meets a host of its own)
    const mod = jz(src, { optimize }).exports, host = oracle(src)
    Object.keys(OFF_PATH).forEach((name, i) => {
      for (const c of [0, 2]) for (const d of [1, 3]) is(answer(mod[`run${i}`], c, d), answer(host[`run${i}`], c, d), `${name}, run(${c}, ${d}) at ${optimize}`)
    })
  }
})

// A module binding a function assigns holds no fact past a call: `reset()` may store undefined.
test('kind tests: a dereferenced module binding a call may reassign stays nullish', () => {
  const src = `${DEREF}
let G = chP[0]
const reset = () => { G = undefined }
export const run = (k, d) => { G.rate = 0.5; if (k) reset(); return kernel(d, G) }
export const again = () => { G = chP[1] }`
  for (const optimize of levels(0, 2, 3, 'size')) {
    const mod = jz(src, { optimize }).exports, host = oracle(src)
    for (const k of [0, 1]) { mod.again(); host.again(); is(answer(mod.run, k, 2), answer(host.run, k, 2), `run(${k}) at ${optimize}`) }
  }
})

// Every part of the walk that may not run where what encloses it does (summary
// `apart`, its sites read off the source here), by every way a statement
// proves its receiver an object: where the part does not run, `p` stays what
// the call passed, and `(p ?? { x: 5 }).x` reads 5. A site the walk walks apart
// that has no program here fails the test until one is listed. Each part runs
// where `k` is truthy; `z` is a parameter whose default runs where `k` is.
const PROVES = { 'a member store': 'p.x = 1', 'an index store': "p[['x'][0]] = 1", 'a compound store': 'p.x += 1', 'an increment': 'p.x++', 'a method call': 'p.m()' }
const MAY_NOT_RUN = {
  logical: [(S) => `k && (${S})`, (S) => `!k || (${S})`, (S) => `(k ? null : 1) ?? (${S})`],
  choice: [(S) => `k ? (${S}) : 0`, (S) => `!k ? 0 : (${S})`],
  'logical assignment': [(S) => `let q = k; q &&= (${S})`, (S) => `let q = !k; q ||= (${S})`, (S) => `let q = k ? null : 1; q ??= (${S})`,
    (S) => `const o = { q: k ? null : 1 }; o.q ??= (${S})`, (S) => `const o = { q: k }; o.q &&= (${S})`, (S) => `const o = { q: !k }; o.q ||= (${S})`],
  'optional call': [(S) => `const o = k ? { m(a) { return a } } : null; o?.m(${S})`, (S) => `const g = k ? ((a) => a) : null; g?.(${S})`,
    (S) => `const o = k ? { a: { m(a) { return a } } } : null; o?.a.m(${S})`, (S) => `const o = { m: k ? ((a) => a) : null }; o.m?.(${S})`,
    (S) => `const o = k ? { m(a) { return a } } : null; o?.m(\`\${${S}}\`)`],
  'optional key': [(S) => `const o = k ? [1, 2] : null; const r = o?.[(${S}, 0)]`, (S) => `const o = k ? { a: [1, 2] } : null; const r = o?.a[(${S}, 0)]`],
  try: [(S) => `try { if (!k) throw 0; ${S} } catch (e) { }`, (S) => `try { if (!k) throw 0; ${S} } catch (e) { } finally { }`],
  label: [(S) => `l: { if (!k) break l; ${S} }`],
  default: [(S) => ({ param: `z = (${S})`, body: '' })],
  // a statement's arms, a loop's body and update (their own marks in `stmt`)
  statement: [(S) => `if (k) ${S}`, (S) => `if (!k) { } else ${S}`, (S) => `for (let i = 0; i < k; i++) ${S}`, (S) => `let n = k; while (n-- > 0) ${S}`, (S) => `for (let i = 0; i < k; ${S}) i++`],
}
test('kind tests: a store or a call in a part that may not run proves nothing past it', async () => {
  const { readFileSync } = await import('node:fs')
  const walked = new Set([...readFileSync(new URL('../src/summary/index.js', import.meta.url), 'utf8').matchAll(/\bapart\('([^']+)'\)/g)].map(m => m[1]))
  for (const site of walked) ok(MAY_NOT_RUN[site]?.length, `the walk's site '${site}' has its programs`)
  for (const [prover, S] of Object.entries(PROVES)) {
    const forms = Object.entries(MAY_NOT_RUN).flatMap(([site, list]) => list.map((form, j) => [`${site} ${j}`, form(S)]))
    const src = forms.map(([, form], i) => {
      const { param = 'z', body = form } = typeof form === 'string' ? { body: form } : form
      return `const f${i} = (p, k, ${param}) => { ${body}; return (p ?? { x: 5 }).x }
export const t${i} = (c) => f${i}({ x: 0, m() { return 1 } }, 1) * 10 + f${i}(c ? { x: 2, m() { return 1 } } : undefined, c ? 1 : 0, c ? undefined : 3)`
    }).join('\n')
    for (const optimize of levels(0, 2, 3, 'size')) {
      const mod = jz(src, { optimize }).exports, host = oracle(src)
      forms.forEach(([name], i) => { for (const c of [0, 1]) is(answer(mod[`t${i}`], c), answer(host[`t${i}`], c), `${prover} in ${name}, t(${c}) at ${optimize}`) })
    }
  }
})

// A field every creation of its objects sets, which no store makes nullish,
// is never nullish (summary fieldTags): `params._glide ??= make()` where every
// object reaching `params` is made with the array never makes one, and
// `process` allocates nothing. Each test of the field below folds there; each
// way an object of the shape may hold it nullish, or a value of another
// shape reach the test, keeps it, and the answer is the host's.
const FIELD_FORMS = {
  '??=': 'const e = params._glide ??= make()',
  '??': 'const e = params._glide ?? make()',
  '== null': 'if (params._glide == null) params._glide = make(); const e = params._glide',
  '=== undefined': 'if (params._glide === undefined) params._glide = make(); const e = params._glide',
  '!': 'if (!params._glide) params._glide = make(); const e = params._glide',
  '||=': 'const e = params._glide ||= make()',
}
const FIELD_READ = 'e[0] += d; return e[0]'
const fieldKernel = (k, form) => `const ${k} = (d, params) => { ${form}; ${FIELD_READ} }`

test('kind tests: a field every creation sets folds its tests', () => {
  for (const optimize of levels(0, 2, 3, 'size')) for (const [name, form] of Object.entries(FIELD_FORMS)) {
    const src = `const make = () => new Float64Array(1)\n${fieldKernel('k', form)}\nconst P = { g: 2, _glide: make() }\nexport const process = (d) => k(d, P)`
    is(refusal(src, optimize), null, `${name}: process allocates nothing at ${optimize}`)
    const mod = jz(src, { optimize }).exports, host = oracle(src)
    for (const d of [1, 2]) is(answer(mod.process, d), answer(host.process, d), `${name}, process(${d}) at ${optimize}`)
  }
})

// the object setup and the run that read each kernel `k`: every precondition broken in turn
const FIELD_BROKEN = {
  'a creation leaves it out': (k) => `const P_${k} = [{ g: 2, _glide: make() }, { g: 2 }]\nexport const run_${k} = (d) => ${k}(d, P_${k}[0]) * 100 + ${k}(d, P_${k}[1])`,
  'a creation sets it null': (k) => `const P_${k} = [{ g: 2, _glide: make() }, { g: 2, _glide: null }]\nexport const run_${k} = (d) => ${k}(d, P_${k}[0]) * 100 + ${k}(d, P_${k}[1])`,
  'a creation sets it undefined': (k) => `const P_${k} = [{ g: 2, _glide: make() }, { g: 2, _glide: undefined }]\nexport const run_${k} = (d) => ${k}(d, P_${k}[0]) * 100 + ${k}(d, P_${k}[1])`,
  'a store sets it null': (k) => `const P_${k} = { g: 2, _glide: make() }\nexport const run_${k} = (d) => { const a = ${k}(d, P_${k}); if (d > 1) P_${k}._glide = null; return a * 100 + ${k}(d, P_${k}) }`,
  'a store through another name': (k) => `const P_${k} = { g: 2, _glide: make() }\nexport const run_${k} = (d) => { const a = ${k}(d, P_${k}); const q = P_${k}; if (d > 1) q._glide = undefined; return a * 100 + ${k}(d, P_${k}) }`,
  'a store of an element past the end': (k) => `const P_${k} = { g: 2, _glide: make() }, L_${k} = [make()]\nexport const run_${k} = (d) => { const a = ${k}(d, P_${k}); P_${k}._glide = L_${k}[d - 1]; return a * 100 + ${k}(d, P_${k}) }`,
  'a computed key stores null': (k) => `const P_${k} = { g: 2, _glide: make() }, K_${k} = ['_glide', 'g']\nexport const run_${k} = (d) => { const a = ${k}(d, P_${k}); if (d > 1) P_${k}[K_${k}[0]] = null; return a * 100 + ${k}(d, P_${k}) }`,
  'Object.assign stores null': (k) => `const P_${k} = { g: 2, _glide: make() }\nexport const run_${k} = (d) => { const a = ${k}(d, P_${k}); if (d > 1) Object.assign(P_${k}, { _glide: null }); return a * 100 + ${k}(d, P_${k}) }`,
  // (a fixed shape refuses `delete o.f`; a computed key may name any field)
  'a delete': (k) => `const P_${k} = { g: 2, _glide: make() }, K_${k} = ['_glide', 'g']\nexport const run_${k} = (d) => { const a = ${k}(d, P_${k}); if (d > 1) delete P_${k}[K_${k}[0]]; return a * 100 + ${k}(d, P_${k}) }`,
  'an accessor of the name': (k) => `class G_${k} { constructor () { this.v = null } get _glide () { return this.v } set _glide (x) { this.v = x } }\nconst P_${k} = [{ g: 2, _glide: make() }, new G_${k}()]\nexport const run_${k} = (d) => ${k}(d, P_${k}[0]) * 100 + ${k}(d, P_${k}[1])`,
  'the object comes from the host': (k) => `export const run_${k} = (d, o) => ${k}(d, o ?? { g: 2, _glide: make() })`,
}

test('kind tests: a field some object may hold nullish keeps its tests', () => {
  const forms = Object.entries(FIELD_FORMS)
  for (const [why, setup] of Object.entries(FIELD_BROKEN)) {
    const src = `const make = () => new Float64Array(1)\n${forms.map(([, form], i) => `${fieldKernel(`k${i}`, form)}\n${setup(`k${i}`)}`).join('\n')}`
    for (const optimize of levels(0, 2, 3, 'size')) {
      const mod = jz(src, { optimize }).exports, host = oracle(src)
      forms.forEach(([name], i) => {
        const run = `run_k${i}`
        for (const d of [1, 2]) is(answer(mod[run], d), answer(host[run], d), `${why}, ${name}, run(${d}) at ${optimize}`)
        // (an object each: a store into the field reaches the host's own; WASI passes no host object)
        if (why === 'the object comes from the host' && !onWasi()) for (const o of ['{ "g": 2 }', '{ "g": 2, "_glide": null }']) is(answer(mod[run], 2, JSON.parse(o)), answer(host[run], 2, JSON.parse(o)), `${why}, ${name}, given ${o} at ${optimize}`)
      })
    }
  }
})
