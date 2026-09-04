// The program summary (src/summary): one kind per binding, slot and result,
// joined over the whole program before per-function analysis. The tests read
// the summary after a compile and pin what it answers, then the codegen it
// unlocks: a record with a typed-array field read through a parameter, a
// factory result, a class instance, a method closure over the instance.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz, { compile } from '../index.js'
import { ctx } from '../src/ctx.js'
import { K, kind, join, orNull, tagOf, paramOf, isNullable, UNKNOWN } from '../src/summary/index.js'
import { T as MARK } from '../src/ast.js'
import { onKernel, OPT_LEVEL } from './_matrix.js'

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
  is(tagOf(kindOf('run', 'n')), K.ANY, 'an exported parameter read only as a typed-array size stays ANY: the constructor copies an array')
  ok(!ctx.summary.numericDemand(binding('run', 'n')))
  is(tagOf(ctx.summary.resultOf('mk')), K.OBJECT, 'a result is the join of its returns')
  summarize(`export const h = (s, k, o, p, q) => { const t = s + ''; return t.length + k * 2 + o.x + (p + 1) + (q < 3 ? 1 : 0) }`)
  is(tagOf(kindOf('h', 's')), K.ANY, 'a parameter concatenated with a string comes from the host as ANY')
  is(tagOf(kindOf('h', 'k')), K.NUMBER, 'a parameter multiplied is demanded'); ok(ctx.summary.numericDemand(binding('h', 'k')))
  is(tagOf(kindOf('h', 'o')), K.ANY, 'a parameter read as an object is not')
  is(tagOf(kindOf('h', 'p')), K.NUMBER, 'a parameter added to a number is compatible'); ok(!ctx.summary.numericDemand(binding('h', 'p')))
  is(tagOf(kindOf('h', 'q')), K.NUMBER, 'a parameter compared against a number is demanded'); ok(ctx.summary.numericDemand(binding('h', 'q')))
  // Demand follows a store into a slot and a destructured read out of it.
  summarize(`const mk = (g) => ({ gain: g })
    const use = (o) => { const { gain } = o; return gain * 2 }
    const use2 = ({ gain }) => gain + ''
    export const times = (g) => use(mk(g))
    export const text = (g) => use2(mk(g))`)
  is(tagOf(kindOf('times', 'g')), K.ANY, 'the slot is also read as a string elsewhere: not demanded')
  summarize(`const mk = (g) => ({ gain: g })
    const use = (o) => { const { gain } = o; return gain * 2 }
    export const times = (g) => use(mk(g))`)
  is(tagOf(kindOf('times', 'g')), K.NUMBER, 'stored into a slot every read of which multiplies: demanded')
  is(jz(`const mk = (g) => ({ gain: g })
    const use = (o) => { const { gain } = o; return gain * 2 }
    export const times = (g) => use(mk(g))`).exports.times('4'), 8, 'the host string converts at the boundary')
  // A demand is evidence of a ToNumber read, never its absence: a value the
  // program stores and never reads rests where the host reads it back.
  summarize(`export const mk = (x, y) => ({ x, y })`)
  is(tagOf(kindOf('mk', 'x')), K.ANY, 'a slot with no read demands nothing')
  is(jz(`function RegExp(x) { return { x } }
    export let regexp = x => new RegExp(x).x`).exports.regexp('r'), 'r', 'a slot returned as it is keeps the host value')
  summarize(`export const get = (a, k) => a[k]`)
  is(tagOf(kindOf('get', 'k')), K.ANY, 'an index is a property key, not a ToNumber context')
  is(jz(`export const get = (k) => { const a = [10, 20, 30]; return a[k] }`).exports.get('1.0'), undefined, "a['1.0'] is no element")
})

test('summary: join is a lattice join, so the fixpoint terminates', () => {
  // Every element and its nullable form; ANY absorbs the bit (the flagship
  // oscillated between ANY and nullable ANY for 64 rounds and stopped short).
  const base = [K.NONE, kind(K.NUMBER), kind(K.STRING), kind(K.NULLISH), kind(K.OBJECT, 1), kind(K.OBJECT, 2), kind(K.OBJECT, UNKNOWN), kind(K.ARRAY, 0), kind(K.CLOSURE, 3), kind(K.ANY)]
  const all = [...base, ...base.map(orNull)]
  for (const a of all) for (const b of all) {
    const j = join(a, b)
    is(join(b, a), j, 'commutative')
    is(join(a, j), j, 'absorbing: the join is above its operands')
    is(join(j, b), j)
    for (const c of all) is(join(join(a, b), c), join(a, join(b, c)), 'associative')
  }
  is(join(kind(K.ANY), kind(K.NULLISH)), kind(K.ANY), 'ANY absorbs nullish')
  is(join(orNull(K.NONE), kind(K.NUMBER)), orNull(kind(K.NUMBER)), 'nullable bottom joins as nullish')
  is(join(kind(K.OBJECT, 1), orNull(kind(K.OBJECT, 2))), orNull(kind(K.OBJECT, UNKNOWN)), 'two shapes join to the tag')
})

test('summary: two closures joined are called from where the summary cannot see', () => {
  // The lattice keeps one closure identity; the join of two is a call to
  // either, so both take ANY parameters rather than staying at bottom.
  summarize(`const tbl = [(x) => x.length, (x) => x * 2]
    export const f = (i, v) => tbl[i & 1](v)`)
  for (const id of [0, 1]) ok(ctx.summary.escaped.has(id), `closure ${id} escaped by the join`)
  is(jz(`const tbl = [(x) => x.length, (x) => x * 2]
    export const f = (i, v) => tbl[i & 1](v)`).exports.f(0, 'abc'), 3)
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

test('summary codegen: a method called through an array of instances, an exported constructor parameter stored to a numeric slot', () => {
  if (onKernel()) return
  const src = `class Gain {
      constructor(n, gain) { this.buf = new Float64Array(n); this.gain = gain }
      process(input) { const b = this.buf, g = this.gain; for (let i = 0; i < b.length; i++) b[i] = input[i] * g; return b }
    }
    const mkChain = (n, count) => { const nodes = []; for (let k = 0; k < count; k++) nodes.push(new Gain(n, 0.5 + k)); return nodes }
    const render = (input, nodes) => { let x = input; for (let k = 0; k < nodes.length; k++) x = nodes[k].process(x); return x }
    export const run = (n) => { const input = new Float64Array(n); input[1] = 2; return render(input, mkChain(n, 3))[1] }`
  // level 2: below it the method's dispatcher, dead here, is not shaken
  if (OPT_LEVEL === 2) ok(!/__dyn_get|__hash|__to_str/.test(compile(src, { wat: true })), 'the method comes from the element\'s schema slot, the method parameter is a typed array')
  is(jz(src).exports.run(4), 2 * 0.5 * 1.5 * 2.5)
  if (OPT_LEVEL === 2) ok(compile(src).length < 3100, `the typed tier's size class (${compile(src).length} B)`)
  // An exported class: its constructor parameter is read only through a slot
  // every read of which multiplies, so the f64 boundary is the coercion.
  const cls = `export class Gain { constructor(n, gain) { this.buf = new Float32Array(n); this.gain = gain }
      process() { const b = this.buf, g = this.gain; for (let i = 0; i < b.length; i++) b[i] = b[i] * g; return b[0] } }
    export const run = (n, gain) => { const g = new Gain(n, gain); g.buf[0] = 2; g.process(); return g.process() }`
  if (OPT_LEVEL === 2) ok(!/__to_str/.test(compile(cls, { wat: true })), 'no string machinery: the gain slot is read only as a number')
  is(jz(cls).exports.run(8, 0.5), 0.5)
  is(jz(cls).exports.run(8, '0.5'), 0.5, 'the host string converts at the boundary')
  if (OPT_LEVEL === 2) ok(compile(cls).length < 2000, `bytes: ${compile(cls).length}`)
})

test('summary: a module global is the join of every store; the declaration\'s claim yields', () => {
  // The declaration says number, a function stores a string: `g + 1` concatenates as JS does.
  const m = jz(`let g = 1; export let f = () => { g = 'abc'; return g.length }; export let h = () => g + 1`)
  is(m.exports.h(), 2); is(m.exports.f(), 3); is(m.exports.h(), 'abc1')
  // A `let` assigned a typed array in an initializer is typed, nullable until then; a const
  // bound to a factory's record has its schema; an exported `let` keeps its kind.
  const src = `let mem, W = 0; const P = mk(4); export let n = 0
    const mk = (k) => ({ x: new Float32Array(k), y: k })
    export const init = (w) => { W = w; mem = new Float64Array(W * 2) }
    export const at = (i) => mem[i] + P.x[0] + P.y + n`
  compile(src)
  is(ctx.scope.globalTypedElem.get('mem'), 'new.Float64Array'); ok(ctx.scope.globalReps.get('mem').nullable)
  is(ctx.scope.globalValTypes.get('W'), 'number', 'a host parameter every read of which converts is a number')
  is(ctx.schema.vars.get('P'), ctx.schema.list.findIndex(s => s.join() === 'x,y'))
  is(ctx.scope.globalValTypes.get('n'), 'number')
  const m2 = jz(src); m2.exports.init(3); is(m2.exports.at(0), 4)
})

test('summary: a numeric-compatible parameter arrives as a number (spec/boundary.md)', () => {
  // `row += W` is a `+` operand, `xi < W` a compare against a number: W is a number and so is `w`.
  const src = `let W = 0, H = 0; export let resize = (w, h) => { W = w; H = h }
    export let area = () => { let row = 0, y = 0; while (y < H) { let x = 0; while (x < W) x++; row += W; y++ } return row }`
  compile(src); is(ctx.scope.globalValTypes.get('W'), 'number')
  if (OPT_LEVEL === 2) ok(!/__to_str|__str_concat/.test(compile(src, { wat: true })), 'no string machinery')
  const m = jz(src); m.exports.resize(3, 4); is(m.exports.area(), 12)
  // A typed array's size: ToIndex of a number; a negative or heap-sized count traps, on both the
  // boxed path (a parameter read only there copies an array) and the numeric one.
  const m2 = jz(`export let f = (n) => { let a = new Float64Array(n); return a.length }`)
  is(m2.exports.f(4), 4); is(m2.exports.f(2.5), 2, 'ToIndex truncates'); is(m2.exports.f(NaN), 0)
  let err; try { m2.exports.f(-1) } catch (e) { err = e }
  ok(err instanceof WebAssembly.RuntimeError, 'a negative size traps (JS: a RangeError)')
  err = null; try { m2.exports.f(2 ** 34) } catch (e) { err = e }
  ok(err instanceof WebAssembly.RuntimeError, 'a size past the heap traps (JS: a RangeError)')
  is(m2.exports.f(new Uint8Array([1, 2, 3])), 3, 'an array copies')
  const m3 = jz(`export let f = (n) => { let a = new Float64Array(n * 1); return a.length }`)
  is(m3.exports.f(2.5), 2)
  err = null; try { m3.exports.f(2 ** 29) } catch (e) { err = e }
  ok(err instanceof WebAssembly.RuntimeError, 'the numeric path traps too (before: a wrapped byte count, length 0)')
})

test('summary: a parameter read before its reassignment has its incoming kind', () => {
  // subscript's parse: `cur = s` precedes `s = expr()`, so `cur` is the argument's string.
  compile(`let cur = ''; const parse = (s) => (cur = s, s = [1, 2], s.length); export const run = () => parse('abc') + cur.length`)
  is(ctx.scope.globalValTypes.get('cur'), 'string')
  is(tagOf(kindOf('parse', 's')), K.ANY, 'the parameter itself joins its reassignment')
  // A loop that assigns the parameter, and a closure that does, end the region.
  const loop = jz(`const h = (p) => { let a = p; for (let i = 0; i < 2; i++) { a = a + p; p = 'x' } return a }; export const f = () => h(1)`)
  is(loop.exports.f(), '2x')
  const clos = jz(`export const f = (p) => { const g = () => { p = 5 }; g(); return p * 2 }`)
  is(clos.exports.f(1), 10)
})
