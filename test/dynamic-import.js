// `import('x')` of a literal specifier: 'x' joins the compile-time graph, the
// call is the promise of its namespace object, and a module only `import()`
// reaches evaluates at the first read, after its lazy imports, once (jzify
// hoistDynamicImports, prepare/module-eval.js). Every program runs as files
// under Node and as one jz module, at every level; a shared `log.js` records
// when each module evaluates.
import test from 'tst'
import { is, throws } from 'tst/assert.js'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { pathToFileURL } from 'url'
import jz from '../index.js'
import { resolveModuleGraph } from '../src/resolve.js'
import { levels, onWasi, onKernel } from './_matrix.js'

const show = (v) => JSON.stringify(v, (k, x) => x === undefined ? '<undefined>' : x)
// each program's files in a directory of their own: Node caches a module by its path
const scratch = mkdtempSync(join(tmpdir(), 'jz-import-'))
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }))
let programs = 0
const files = (modules, entry) => {
  const dir = join(scratch, String(programs++))
  mkdirSync(dir)
  for (const [name, src] of Object.entries({ ...modules, 'main.js': entry })) writeFileSync(join(dir, name), src)
  return join(dir, 'main.js')
}
const specifiers = (modules) => Object.fromEntries(Object.entries(modules).map(([name, src]) => ['./' + name, src]))
const settle = async (f) => { try { return show(await f()) } catch (e) { return 'rejects ' + (e?.message ?? e) } }
const agree = async (cases) => {
  if (onWasi() || onKernel()) return   // the promise crosses to the host
  for (const [name, modules, entry] of cases) {
    const want = await settle(async () => (await import(pathToFileURL(files(modules, entry)))).f())
    for (const optimize of levels(0, 2, 3))
      is(await settle(() => jz(entry, { modules: specifiers(modules), optimize }).exports.f()), want, `${name} O${optimize}`)
  }
}

const log = { 'log.js': 'export let log = []' }
const dep = { ...log, 'dep.js': `import { log } from './log.js'\nlog.push('dep')\nexport let twice = n => n * 2\nexport default 42` }
const chain = {
  ...log,
  'a.js': `import { log } from './log.js'\nimport './b.js'\nlog.push('a')\nexport let a = 1`,
  'b.js': `import { log } from './log.js'\nlog.push('b')`,
  'c.js': `import { log } from './log.js'\nimport './b.js'\nlog.push('c')`,
}

test('import(): a module evaluates at its first import, once', () => agree([
  ['in a function', dep, `export let f = async () => (await import('./dep.js')).twice(3)`],
  ['first read', dep, `import { log } from './log.js'\nlog.push('main')\nexport let f = async () => { log.push('call'); const m = await import('./dep.js'); log.push('got'); return log.join() + m.twice(2) }`],
  ['once', dep, `import { log } from './log.js'\nlet g = async () => (await import('./dep.js')).twice(1)\nexport let f = async () => { await g(); await g(); return log.join() }`],
  ['after the call', dep, `import { log } from './log.js'\nexport let f = async () => { const p = import('./dep.js'); log.push('after'); await p; return log.join() }`],
  ['also imported statically', dep, `import { log } from './log.js'\nimport { twice } from './dep.js'\nlog.push('main')\nexport let f = async () => log.join() + (await import('./dep.js')).twice(3) + twice(1)`],
  ['its lazy imports first', chain, `import { log } from './log.js'\nlog.push('main')\nexport let f = async () => { await import('./a.js'); return log.join() }`],
  ['a static import stays at start-up', chain, `import { log } from './log.js'\nimport './c.js'\nlog.push('main')\nexport let f = async () => { await import('./a.js'); return log.join() }`],
  ['module level, not awaited', dep, `import { log } from './log.js'\nlet p = import('./dep.js')\nlog.push('main')\nexport let f = async () => log.join() + (await p).twice(5)`],
  ['module level, awaited', dep, `let d = await import('./dep.js')\nexport let f = () => d.twice(4) + d.default`],
  ['from a lazy module', { ...dep, 'outer.js': `export let get = async () => (await import('./dep.js')).twice(7)` }, `export let f = async () => (await import('./outer.js')).get()`],
]))

test('import(): an evaluation that throws rejects every import', () => agree([
  ['rejects', { 'bad.js': `export let x = 1\nthrow new Error('boom')` }, `export let f = () => import('./bad.js').then(() => 'no', e => e.message)`],
  ['again', { 'bad.js': `export let x = 1\nthrow new Error('boom')` }, `let g = () => import('./bad.js').then(() => 'no', e => e.message)\nexport let f = async () => (await g()) + (await g())`],
]))

test('import(): the namespace object', () => agree([
  ['one object', dep, `export let f = async () => (await import('./dep.js')) === (await import('./dep.js'))`],
  ['keys in order', dep, `export let f = async () => Object.keys(await import('./dep.js')).join() + typeof (await import('./dep.js'))`],
  ['default', dep, `export let f = async () => { const { twice, default: d } = await import('./dep.js'); return twice(d) }`],
  ['live binding', { 'counter.js': `export let count = 0\nexport let inc = () => { count++ }` }, `export let f = async () => { const m = await import('./counter.js'); m.inc(); m.inc(); return m.count }`],
  ['static namespace as a value', { 'counter.js': `export let count = 0\nexport let inc = () => { count++ }` }, `import * as m from './counter.js'\nexport let f = () => { let ns = m; ns.inc(); return [ns.count, Object.keys(ns)] }`],
  ['re-exports', { 'm.js': `export * from './n.js'\nexport * as sub from './n.js'\nexport { w as ww } from './n.js'`, 'n.js': `export let w = 3\nexport let v = () => w + 1` }, `export let f = async () => { const m = await import('./m.js'); return [m.w, m.ww, m.v(), m.sub.w, Object.keys(m)] }`],
]))

test('import(): what a lazy module runs', () => agree([
  ['constants', { 'm.js': `export const T = [1, 2, 3]\nexport const O = { a: 1, b: [2] }\nexport const N = T.length * 2` }, `export let f = async () => { const m = await import('./m.js'); return [m.T, m.O, m.N] }`],
  ['a loop filling state', { 'm.js': `export const buf = new Float64Array(4)\nfor (let i = 0; i < 4; i++) buf[i] = i * 1.5\nexport let sum = () => buf[0] + buf[1] + buf[2] + buf[3]` }, `export let f = async () => (await import('./m.js')).sum()`],
  ['a class', { 'm.js': `export class P { static count = 2; constructor(x) { this.x = x } get double() { return this.x * 2 } }\nexport let make = (x) => new P(x).double + P.count` }, `export let f = async () => (await import('./m.js')).make(5)`],
  ['destructuring', { 'm.js': `const src = { a: 1, b: 2, c: 3 }\nexport const { a, ...rest } = src` }, `export let f = async () => { const m = await import('./m.js'); return [m.a, m.rest] }`],
  ['state across imports', { 'm.js': `let n = 0\nexport let next = () => ++n` }, `let g = async () => (await import('./m.js')).next()\nexport let f = async () => { await g(); return await g() }`],
]))

test('import(): a module the build cannot find, or a computed specifier, fails to compile', () => {
  throws(() => jz(`export let f = () => import('./missing.js')`), /import\('\.\/missing\.js'\): unknown module/)
  throws(() => jz(`export let f = (p) => import(p)`), /import\(\) takes one string literal/)
})

test('import(): the file resolver bundles a module import() names', async () => {
  if (onWasi() || onKernel()) return
  const entry = files({ 'meta.js': `import { scale } from './util.js'\nexport let metaChunks = (n) => scale * n`, 'util.js': 'export const scale = 3' },
    `export let f = async (n) => n > 0 ? (await import('./meta.js')).metaChunks(n) : 0`)
  const { code, modules } = resolveModuleGraph(entry)
  is(Object.keys(modules).length, 2, 'meta.js and what it imports')
  const { f } = jz(code, { modules }).exports
  is(await f(5), 15)
  is(await f(0), 0)
})
