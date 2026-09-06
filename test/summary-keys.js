// The summary's binding keys (`scope\0name`) and slot keys (`sid\0prop`) are
// built once per pair inside one summarize() call (src/summary/index.js keyIn,
// slotKey). The strings are the ones the reader (src/summary/query.js)
// concatenates on its own, so every answer below reaches the solver's facts
// through the reader's independent keys; the caches are the call's alone.
import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import { compile } from '../index.js'
import { instantiate } from '../interop.js'
import { execFileSync } from 'node:child_process'
import { ctx } from '../src/ctx.js'
import { K, tagOf, hasTag } from '../src/summary/index.js'
import { T as MARK } from '../src/ast.js'
import { onKernel } from './_matrix.js'

const OPTS = { optimize: { level: 2, sourceInline: false, inlineFns: false } }
const summarize = (src) => { compile(src, OPTS); return ctx.summary }
// A binding's prepared name (bare name + scope suffix) in a function's body or params.
const binding = (fn, bare) => {
  const f = ctx.funcs.list.find(f => f.name === fn)
  const names = new Set(f.sig.params.map(p => p.name))
  const walk = (n) => { if (typeof n === 'string') names.add(n); else if (Array.isArray(n)) n.forEach(walk) }
  walk(f.body)
  const found = [...names].filter(n => n === bare || n.startsWith(bare + MARK))
  if (!found.length) throw new Error(`no binding ${bare} in ${fn}`)
  return found
}
const kindsOf = (fn, bare) => binding(fn, bare).map(n => ctx.summary.at(fn).kindOf(n))

test('summary keys: a shadowed name resolves per scope; a captured binding joins its closures\' stores', () => {
  if (onKernel()) return
  summarize(`let x = 'a'
    const f = (x) => { let y = x + 1; const g = (x) => x * 2; return g(y) + x }
    export const main = () => f(3) + x.length`)
  is(tagOf(ctx.summary.kindOf('x')), K.STRING, 'the module x')
  ok(kindsOf('f', 'x').every(k => tagOf(k) === K.NUMBER), 'f\'s x is a number: its own key, not the module\'s')
  ok(kindsOf('f', 'y').every(k => tagOf(k) === K.NUMBER))
  summarize(`const mk = (n) => { let count = n; const inc = () => { count = count + 1; return count }; const dec = () => { count = '' + count; return count }; return [inc, dec] }
    export const run = () => { const [i, d] = mk(1); i(); return d() }`)
  const count = kindsOf('mk', 'count')
  ok(count.every(k => hasTag(k, K.NUMBER) && hasTag(k, K.STRING)), 'the closures\' stores, a number and a string, reach mk\'s binding through the same key')
})

test('summary keys: closures, specialized variants and unusual names keep their own keys', () => {
  if (onKernel()) return
  summarize(`const table = [ (v) => v + 1, (v) => v * 2, (v) => v - 3 ]
    export const dispatch = (i, v) => table[i % 3](v)`)
  const k = ctx.summary.kindOf('table')
  is(tagOf(k), K.ARRAY, 'the table is an array of the closures')
  summarize(`const norm = (v) => v * 2
    export const a = (n) => norm(n)
    export const b = (s) => norm(s.length)`)
  ok(kindsOf('norm', 'v').every(k => tagOf(k) === K.ANY || tagOf(k) === K.NUMBER), 'norm\'s parameter, keyed by its function')
  summarize(`const $ = 1, _ = 2, __x$ = 3, ünï = 4, a1 = 6
    export const main = ($p, _q) => $ + _ + __x$ + ünï + a1 + $p + _q`)
  for (const name of ['$', '_', '__x$', 'ünï', 'a1']) is(tagOf(ctx.summary.kindOf(name)), K.NUMBER, name)
  ok(ctx.summary.at('main').numericDemand(binding('main', '$p')[0]) || tagOf(kindsOf('main', '$p')[0]) === K.NUMBER, 'a $-named parameter keyed under main')
})

test('summary keys: slot keys are their own namespace; the seeded re-fixpoint reuses the keys', () => {
  if (onKernel()) return
  summarize(`class P { x = 1; y = 2; constructor(n) { this.z = n } len() { return this.x + this.y + this.z } }
    export const run = (n) => new P(n).len()`)
  const sid = ctx.schema.list.findIndex(props => props.includes('x') && props.includes('z'))
  ok(sid >= 0)
  is(tagOf(ctx.summary.fieldKind(sid, 'x')), K.NUMBER); is(tagOf(ctx.summary.fieldKind(sid, 'z')), K.NUMBER, 'the constructor parameter\'s slot, demanded numeric')
  summarize(`export const f = (a, b) => a + b * 2
    export const g = (s) => s.length + 1`)
  ok(kindsOf('f', 'a').every(k => tagOf(k) === K.NUMBER), 'a compatible exported parameter is seeded NUMBER by the second fixpoint')
  ok(kindsOf('f', 'b').every(k => tagOf(k) === K.NUMBER))
  ok(binding('f', 'b').every(n => ctx.summary.at('f').numericDemand(n)))
  ok(kindsOf('g', 's').every(k => tagOf(k) === K.ANY), 'g\'s parameter, not seeded')
})

test('summary keys: the caches reach neither the published facts nor ctx; retention across A → A → B → empty → error → A', () => {
  if (onKernel()) return
  const A = 'export function make(){return {buf:new Float32Array(2),gain:3}} export function main(){return make().buf.length}'
  const B = 'export function main(){return {other:41}.other+1}'
  const freshB = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import {compile} from ${JSON.stringify(new URL('../index.js', import.meta.url).href)}
    console.log(Buffer.from(compile(${JSON.stringify(B)}, ${JSON.stringify(OPTS)})).toString('base64'))
  `], {encoding:'utf8'}).trim()
  const a = compile(A, OPTS), saved = ctx.summary, retained = [...a]
  const instanceA = instantiate(a)
  is(instanceA.exports.main(), 2)
  for (const name of ['bindingKeys', 'slotKeys', 'keyIn', 'slotKey']) { ok(!(name in saved), `${name} not on the summary`); ok(!(name in ctx), `${name} not on ctx`) }
  const sid = ctx.schema.list.findIndex(props => props.join() === 'buf,gain')
  const facts = () => [saved.fieldKind(sid, 'gain'), saved.fieldTypedCtor(sid, 'buf'), saved.resultOf('make'), saved.hasTypedFields]
  const first = facts()
  is([...compile(A, OPTS)], [...a])
  const b = compile(B, OPTS), instanceB = instantiate(b)
  is(Buffer.from(b).toString('base64'), freshB, 'immediate A→B agrees with a fresh process')
  is(instanceB.exports.main(), 42)
  const empty = compile('', OPTS)
  ok(WebAssembly.validate(empty), 'empty output remains executable')
  throws(() => compile('export function broken(', OPTS))
  is(facts(), first, 'retained facts through B, empty and a failed compile')
  is([...compile(A, OPTS)], retained, 'A again, the same bytes')
  is([...a], retained, 'later compiles did not mutate retained bytes')
  is(instanceA.exports.main(), 2, 'retained A still executes')
  is(instanceB.exports.main(), 42, 'retained B still executes')
  is(instantiate(a).exports.main(), 2, 'retained bytes can be instantiated again')
})
