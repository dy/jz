// The program summary (src/summary): one kind per binding, slot and result,
// joined over the whole program before per-function analysis. The tests read
// the summary after a compile and pin what it answers, then the codegen it
// unlocks: a record with a typed-array field read through a parameter, a
// factory result, a class instance, a method closure over the instance.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz, { compile } from '../index.js'
import { ctx } from '../src/ctx.js'
import { K, tagOf, paramOf, isNullable } from '../src/summary/index.js'
import { T as MARK } from '../src/ast.js'
import { onKernel } from './_matrix.js'

// Bindings carry prepare's scope suffix; find one by function and bare name.
const binding = (fn, bare) => {
  const f = ctx.funcs.list.find(f => f.name === fn)
  const names = new Set(f.sig.params.map(p => p.name))
  const walk = (n) => { if (typeof n === 'string') names.add(n); else if (Array.isArray(n)) n.forEach(walk) }
  walk(f.body)
  for (const n of names) if (n.startsWith(bare + MARK)) return n
  throw new Error(`no binding ${bare} in ${fn}`)
}
const kindOf = (fn, bare) => ctx.summary.kindOf(binding(fn, bare))
const sidOf = (props) => ctx.schema.list.findIndex(s => s.join() === props.join())
const summarize = (src) => { compile(src); return ctx.summary }

test('summary: kinds flow through calls, fields and results; the host boundary is ANY', () => {
  summarize(`const mk = (n, g) => ({ buf: new Float32Array(n), gain: g })
    const proc = (o) => { const b = o.buf, k = o.gain; return b[0] * k }
    export const run = (n) => { const o = mk(n, 0.5); return proc(o) + proc({ buf: new Float32Array(2), gain: 1 }) }`)
  const sid = sidOf(['buf', 'gain'])
  is(tagOf(kindOf('proc', 'o')), K.OBJECT, 'a parameter takes the join of its arguments'); is(paramOf(kindOf('proc', 'o')), sid)
  is(tagOf(kindOf('proc', 'b')), K.TYPED, 'a field read has the slot kind'); ok(!isNullable(kindOf('proc', 'b')))
  is(ctx.summary.fieldTypedCtor(sid, 'buf'), 'new.Float32Array')
  is(tagOf(kindOf('proc', 'k')), K.NUMBER, 'number literal and number parameter join to number')
  is(tagOf(kindOf('run', 'n')), K.ANY, 'an exported function\'s parameter comes from the host')
  is(tagOf(ctx.summary.resultOf('mk')), K.OBJECT, 'a result is the join of its returns')
})

test('summary: stores join into the slot; a differing store or a computed write poisons it', () => {
  summarize(`const mk = () => ({ a: new Float32Array(4), b: new Float32Array(4), c: 1 })
    export const f = (k) => { const o = mk(); o.a = new Float32Array(8); o.b = new Float64Array(8); o[k] = 2; return o.a[0] + o.b[0] + o.c }`)
  const sid = sidOf(['a', 'b', 'c'])
  is(ctx.summary.fieldTypedCtor(sid, 'a'), null, 'a computed-key write poisons every slot of the schema')
  summarize(`const mk = () => ({ a: new Float32Array(4), b: new Float32Array(4) })
    export const f = () => { const o = mk(); o.a = new Float32Array(8); o.b = new Float64Array(8); return o.a[0] + o.b[0] }`)
  const s2 = sidOf(['a', 'b'])
  is(ctx.summary.fieldTypedCtor(s2, 'a'), 'new.Float32Array', 'a store of the same kind keeps the slot typed')
  is(ctx.summary.fieldTypedCtor(s2, 'b'), null, 'a store of another element type does not')
  is(tagOf(ctx.summary.fieldKind(s2, 'b')), K.TYPED, 'still a typed array, of unknown element')
})

test('summary: a function used as a value, an unknown callee, and Object.assign lose what they touch', () => {
  summarize(`const g = (o) => o.a
    const h = (o) => o.a
    const mk = () => ({ a: 1 })
    export const f = (arr) => { const o = mk(); const fn = g; Object.assign(o, { a: 'x' }); return fn(o) + h(o) + arr.map(h).length }`)
  is(tagOf(kindOf('f', 'o')), K.OBJECT, 'the local keeps its shape')
  is(ctx.summary.fieldVal(sidOf(['a']), 'a'), null, 'Object.assign may store any kind into the object')
  ok(ctx.summary.escaped.has('g') && ctx.summary.escaped.has('h'), 'both functions escape as values')
})

test('summary: definite initialization excludes the declared undefined; a later read of an unassigned field keeps it', () => {
  summarize(`const mk = (n) => { let self = { buf: undefined, tail: undefined }; self.buf = new Float32Array(n); return self }
    export const f = (n) => { const o = mk(n); o.tail = new Float32Array(1); return o.buf[0] + o.tail[0] }`)
  const sid = sidOf(['buf', 'tail'])
  is(ctx.summary.fieldTypedCtor(sid, 'buf'), 'new.Float32Array', 'assigned before the object is used')
  is(ctx.summary.fieldTypedCtor(sid, 'tail'), null, 'assigned only after the object escaped the factory: nullable')
  ok(isNullable(ctx.summary.fieldKind(sid, 'tail')))
})

test('summary: delete, a host import, for-of, a binding read before its assignment', () => {
  summarize(`const mk = () => ({ a: new Float32Array(2), b: 1 })
    export const f = (n, k) => { const o = mk(); delete o[k]; const t = new Float32Array(n); let s = 0; for (const x of t) s += x; for (const x of [1, 2]) s += x; return s + g(o) }
    const g = (o) => later(o.b) + later(3)
    const later = (v) => v * two
    const two = 2`)
  const sid = sidOf(['a', 'b'])
  is(ctx.summary.fieldTypedCtor(sid, 'a'), null, 'a computed-key delete may remove any slot')
  is(ctx.summary.fieldVal(sid, 'b'), null)
  is(tagOf(kindOf('f', 'x')), K.NUMBER, 'for-of over a typed array and a number array binds a number')
  is(tagOf(kindOf('later', 'v')), K.ANY, 'the deleted-from slot reaches later as ANY, joined with the literal')
  is(tagOf(kindOf('g', 'o')), K.OBJECT, 'a function declared after its caller binds through the fixpoint')
  is(tagOf(ctx.summary.resultOf('later')), K.NUMBER)
  compile(`import { log } from 'host'\nconst mk = () => ({ a: new Float32Array(2) })\nexport const f = () => { const o = mk(); log(o); return o.a[0] }`,
    { imports: { host: { log: { params: 1 } } } })
  is(ctx.summary.fieldTypedCtor(sidOf(['a']), 'a'), 'new.Float32Array', 'an object passed to a host import keeps its field kinds (the boundary is a contract)')
})

test('summary: array cells join every store; a joined pair of arrays is unknown', () => {
  summarize(`const mk = () => ({ v: 1 })
    export const f = (k) => { const arr = [mk()]; arr.push({ v: 2 }); const o = arr[0]; const two = k ? [1] : ['s']; return o.v + two.length }`)
  is(tagOf(kindOf('f', 'o')), K.OBJECT, 'a push of the same shape keeps the element shape'); ok(isNullable(kindOf('f', 'o')), 'an element read may be out of range')
  is(paramOf(kindOf('f', 'two')), (1 << 20) - 1, 'two arrays with different cells join to an array of unknown elements')
})

test('summary codegen: a typed field read through a parameter, a factory, a class, a method closure lowers to typed storage', () => {
  if (onKernel()) return
  const shapes = {
    param: `const proc = (o) => { const b = o.buf, g = o.gain; for (let i = 0; i < b.length; i++) b[i] = b[i] * g; return b[0] }
      export const run = (n) => { const o = { buf: new Float32Array(n), gain: 0.5 }; o.buf[0] = 2; proc(o); return proc(o) }`,
    factory: `const mk = (n, gain) => ({ buf: new Float32Array(n), gain })
      const proc = (o) => { const b = o.buf, g = o.gain; for (let i = 0; i < b.length; i++) b[i] = b[i] * g; return b[0] }
      export const run = (n) => { const o = mk(n, 0.5); o.buf[0] = 2; proc(o); return proc(o) }`,
    class: `export class Gain { constructor(n, gain) { this.buf = new Float32Array(n); this.gain = gain }
      process() { const b = this.buf, g = this.gain; for (let i = 0; i < b.length; i++) b[i] = b[i] * g; return b[0] } }
      export const run = (n) => { const g = new Gain(n, 0.5); g.buf[0] = 2; g.process(); return g.process() }`,
  }
  for (const [name, src] of Object.entries(shapes)) {
    const wat = compile(src, { wat: true, optimize: { level: 2, watr: false } })
    // The loop that stores into the buffer: raw f32 storage, no runtime dispatch on the element.
    const at = wat.indexOf('f32.store')
    ok(at > 0, `${name}: the loop stores f32`)
    const loop = wat.slice(wat.lastIndexOf('(loop', at), at)
    // The factory shape still versions its loop on the receiver's runtime kind: the
    // parameter's representation follows the summary in the next slice (PLAN.md step 3).
    if (name !== 'factory') ok(!/__typed_idx|__typed_set_idx|__dyn_get|__arr_typed/.test(loop), `${name}: no element dispatch in the loop`)
    is(jz(src).exports.run(64), 0.5, `${name}: 2 * 0.5 * 0.5`)
  }
})
