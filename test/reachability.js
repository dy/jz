// Reachability, judged from the source: each program below carries hand-authored
// expectations (its roots, the functions it needs, the ones it does not, the
// order its functions run in, and the values its exports return), and every
// compiled program is executed against them. The JS results are also checked
// against Node running the same source, so an authoring mistake cannot pass as
// a compiler fact. ProgramIndex and the emitted function census are then
// compared with the same expectations as a consistency diagnostic (the second
// block of tests): they are what is being checked, never the oracle.
//
// test/reachability-mutants.js runs this file under test/_mutations.js's
// compiler mutants (a required root lost, a required edge lost) and requires
// it to fail. Optimization is off for the census, so an inlined callee cannot
// vanish from the output for a legitimate reason; the behavior is checked at
// O0 and O2.
import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { compile } from '../index.js'
import { instantiate } from '../interop.js'
import { ctx } from '../src/ctx.js'
import { onKernel, levels } from './_matrix.js'

// Every program appends to `t` as its functions run and reads it through `trace()`.
const T = `let t = ''\nexport const trace = () => t\n`
export const PROGRAMS = {
  'export aliases and a default': {
    src: T + `const f = x => { t += 'f;'; return x + 1 }
const g = x => { t += 'g;'; return f(x) * 2 }
export { f as plus, g as twice }
export default g`,
    roots: ['f', 'g', 'trace'], reachable: ['f', 'g', 'trace'], dead: [],
    run: ex => [ex.plus(1), ex.twice(2), ex.default(3)], results: [2, 6, 8], calls: 'f;g;f;g;f;',
  },
  'a re-exported entry and its callees': {
    src: T + `export { h } from './m.js'\nexport { k as kk } from './m.js'`,
    modules: { './m.js': `const inner = x => x * 2\nexport const h = x => inner(x) + 1\nexport const k = x => h(x) - 1\nexport const unused = x => x` },
    roots: ['h', 'k', 'trace'], reachable: ['h', 'k', 'inner', 'trace'], dead: ['unused'],
    run: ex => [ex.h(2), ex.kk(2)], results: [5, 4], calls: '',
  },
  'import startup': {
    src: T + `import { seed } from './m.js'
const init = () => { t += 'init;'; return 7 }
let base = init()
export const read = () => base + seed`,
    modules: { './m.js': `export const seed = 5` },
    roots: ['init', 'read', 'trace'], reachable: ['init', 'read', 'trace'], dead: [],
    run: ex => [ex.trace(), ex.read()], results: ['init;', 12], calls: 'init;',
  },
  'recursion and a mutual SCC': {
    src: T + `const even = n => { t += 'e'; return n === 0 ? true : odd(n - 1) }
const odd = n => { t += 'o'; return n === 0 ? false : even(n - 1) }
const fact = n => { t += 'f'; return n < 2 ? 1 : n * fact(n - 1) }
export const go = () => (even(4) ? 100 : 0) + fact(4)`,
    roots: ['go', 'trace'], reachable: ['even', 'odd', 'fact', 'go', 'trace'], dead: [],
    run: ex => [ex.go()], results: [124], calls: 'eoeoeffff',
  },
  'closures returned, stored in an object and an array': {
    src: T + `const mk = k => { const c = x => { t += 'c' + k + ';'; return x + k }; return c }
const box = { fn: mk(10) }
const arr = [mk(1), mk(2)]
export const go = () => box.fn(1) + arr[1](1) + arr[0](1)`,
    roots: ['mk', 'go', 'trace'], reachable: ['mk', 'go', 'trace'], dead: [],
    run: ex => [ex.go()], results: [16], calls: 'c10;c2;c1;',
  },
  'higher-order callbacks, one callee reached only from a closure': {
    src: T + `const each = (xs, fn) => { let s = 0; for (let i = 0; i < xs.length; i++) s += fn(xs[i]); return s }
const inc = x => { t += 'i'; return x + 1 }
const dbl = x => { t += 'd'; return x * 2 }
export const go = () => each([1, 2, 3], inc) + [1, 2].map(x => dbl(x)).length`,
    roots: ['go', 'trace', 'inc'], reachable: ['each', 'inc', 'dbl', 'go', 'trace'], dead: [],
    run: ex => [ex.go()], results: [11], calls: 'iiidd',
  },
  'class and method dispatch': {
    src: T + `class A { constructor(v) { this.v = v } get2() { t += 'A;'; return this.v * 2 } }
class B extends A { get2() { t += 'B;'; return super.get2() + 1 } }
const pick = i => i ? new B(3) : new A(1)
export const go = () => pick(1).get2() + pick(0).get2()`,
    roots: ['go', 'trace'], reachable: ['pick', 'go', 'trace'], dead: [],
    run: ex => [ex.go()], results: [9], calls: 'B;A;A;',
  },
  'a named function expression\'s own name': {
    src: T + `const f = function g(n) { t += 'g'; return n > 0 ? g(n - 1) + 1 : 0 }
export const go = () => f(3)`,
    roots: ['go', 'trace'], reachable: ['go', 'trace'], dead: [],
    run: ex => [ex.go()], results: [3], calls: 'gggg',
  },
  'address-taken calls through a table and a conditional': {
    src: T + `const a = x => { t += 'a'; return x }
const b = x => { t += 'b'; return -x }
const table = [a, b]
export const go = i => table[i](5) + (i ? a : b)(1)`,
    roots: ['a', 'b', 'go', 'trace'], reachable: ['a', 'b', 'go', 'trace'], dead: [],
    run: ex => [ex.go(1), ex.go(0)], results: [-4, 4], calls: 'baab',
  },
  'a genuinely dead callable beside a live one': {
    src: T + `const dead = x => { t += 'DEAD'; return x }
const live = x => { t += 'l'; return x + 1 }
export const go = () => live(1)`,
    without: T + `const live = x => { t += 'l'; return x + 1 }\nexport const go = () => live(1)`,
    roots: ['go', 'trace'], reachable: ['live', 'go', 'trace'], dead: ['dead'],
    run: ex => [ex.go()], results: [2], calls: 'l',
  },
}

// Names in ctx.funcs are the source names, prefixed for a bundled module (`__m_js$h`).
const named = name => ctx.funcs.list.filter(f => !f.raw && (f.name === name || f.name.endsWith('$' + name)))
const one = name => { const fs = named(name); if (fs.length !== 1) throw new Error(`${fs.length} functions named ${name}: ${fs.map(f => f.name).join(', ')}`); return fs[0] }
// Node runs the same source: the authored results are checked against it once.
const oracle = ({ src, modules = {} }) => {
  const dir = mkdtempSync(join(tmpdir(), 'jz-reach-'))
  try {
    for (const [spec, code] of Object.entries(modules)) { mkdirSync(join(dir, spec, '..'), { recursive: true }); writeFileSync(join(dir, spec), code) }
    writeFileSync(join(dir, 'entry.mjs'), src)
    return import(pathToFileURL(join(dir, 'entry.mjs')).href + '?' + Math.random())
  } finally { setTimeout(() => rmSync(dir, { recursive: true, force: true }), 5000).unref() }
}
const behavior = (p, level) => {
  const ex = instantiate(compile(p.src, { optimize: level, modules: p.modules }), { memory: 64 }).exports
  const results = p.run(ex)
  return { results, calls: ex.trace() }
}
const census = p => {
  const wat = compile(p.src, { optimize: 0, modules: p.modules, wat: true })
  const emitted = new Set([...wat.matchAll(/\(func \$([^\s()]+)/g)].map(m => m[1]))
  const index = ctx.plans.programIndex
  const reach = name => { const f = one(name); const id = index.graphFunctionIdOfName(f.name); return id >= 0 && index.isGraphReachable(id) }
  const rootNames = new Set([...index.getCallGraph().rootIds].map(id => index.graphFunctionById(id).name))
  return { emitted, reach, root: name => rootNames.has(one(name).name), name: name => one(name).name }
}

for (const [title, p] of Object.entries(PROGRAMS)) test(`reachability: ${title}`, async () => {
  if (onKernel()) return
  const js = await oracle(p)
  is(p.run(js), p.results, 'the authored results are what Node computes for the source')
  is(js.trace(), p.calls, 'and so is the authored call order')
  for (const level of levels(0, 2)) {
    const { results, calls } = behavior(p, level)
    is(results, p.results, `results at O${level}`)
    is(calls, p.calls, `the functions ran in the expected order at O${level}`)
  }
  if (p.without) for (const level of levels(0, 2)) {
    const bytes = compile(p.src, { optimize: level }), pruned = compile(p.without, { optimize: level })
    const exWithout = instantiate(pruned, { memory: 64 }).exports
    is(p.run(exWithout), p.results, `deleting the dead callable from the source changes nothing (O${level})`)
    is(exWithout.trace(), p.calls)
    ok(bytes.length === pruned.length && bytes.every((b, i) => b === pruned[i]), `and the compiled bytes are identical (O${level})`)
  }
})

for (const [title, p] of Object.entries(PROGRAMS)) test(`reachability census: ${title}`, () => {
  if (onKernel()) return
  const c = census(p)
  for (const name of p.roots) ok(c.root(name), `${name} is a ProgramIndex root`)
  for (const name of p.reachable) ok(c.reach(name) && c.emitted.has(c.name(name)), `${name} is reachable in ProgramIndex and emitted`)
  for (const name of p.dead) ok(!c.reach(name) && !c.emitted.has(c.name(name)), `${name} is unreachable in ProgramIndex and not emitted`)
})

test('reachability: an empty program, a reference the source cannot satisfy, and reuse', async () => {
  if (onKernel()) return
  const empty = instantiate(compile('', { optimize: 0 }))
  is(Object.keys(empty.exports).filter(k => !k.startsWith('_') && k !== 'memory'), [], 'nothing exported')
  is(ctx.plans.programIndex.graphFunctionCount, 0, 'no graph function')
  throws(() => compile(T + 'export const go = () => missing(1)', { optimize: 0 }), /missing/, 'a call to a name the source never defines rejects at compile')
  const first = Object.values(PROGRAMS).map(p => [compile(p.src, { optimize: 2, modules: p.modules }), behavior(p, 2)])
  const again = Object.values(PROGRAMS).map(p => [compile(p.src, { optimize: 2, modules: p.modules }), behavior(p, 2)])
  ok(first.every(([bytes, b], i) => bytes.length === again[i][0].length && bytes.every((x, j) => x === again[i][0][j]) && JSON.stringify(b) === JSON.stringify(again[i][1])),
    'every program compiles to the same bytes and behaves the same the second time through')
})
