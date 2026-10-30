// `class` lowering (jzify): constructor + instance fields + methods + `new` + `this`,
// plus `extends`, `super(…)`, `static` members, and private `#fields`.
// A class at module scope whose base is none or a class of its module is a
// schema with identity and functions of the receiver: an instance holds its
// fields alone, `o.m()` on a receiver the summary knows is a direct call, an
// unknown receiver dispatches on its schema id. Every other class (nested,
// a dynamic base) is pure desugaring — an instance is a plain object, methods
// are per-instance arrows capturing it. `this` is renamed to the instance,
// `new C(a)` becomes `C(a)`, `get x()`/`set x(v)` become the `x__get`/`x__set`
// members the property reader and store dispatch through. Rejected: full
// `super.x` property semantics, a getter or setter with a computed name.
import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import { onWasi, onKernel, OPT_LEVEL, levels } from './_matrix.js'
import { oracle } from './util.js'
import jz, { compile as compileWat } from '../index.js'
import { instantiate } from '../interop.js'

const compile = (src) => jz(src, { jzify: true }).exports
// every export, called without arguments, answers as the same program run by node
const agrees = (src) => { const want = oracle(src), got = jz(src).exports; for (const name of Object.keys(want)) is(got[name](), want[name](), name) }

// A computed member name is evaluated once, where the class is defined, in
// member order: the heritage first, then every key (instance and static,
// methods and fields), then the static initializers; the instance fields'
// initializers at each construction. A member named at run time is the
// instance's (or the class's) property of that name.
test('class: computed member names evaluate in source order', () => {
  agrees(`export let members = () => {
      const log = [], k = s => (log.push(s), s)
      class C { [k('m1')]() { return 1 } static [k('s1')]() { return 2 } [k('f1')] = k('fv1'); static [k('sf')] = k('sfv'); [k('m2')]() { return 3 } }
      log.push('|'); const c = new C()
      return log.join() + c.m1() + C.s1() + c.f1 + C.sf + c.m2()
    }
    export let heritage = () => { const log = [], k = s => (log.push(s), s); class B {} class C extends (log.push('ext'), B) { [k('m')]() { return 1 } } return log.join() + new C().m() }
    export let fields = () => { const log = [], k = s => (log.push(s), s); class C { constructor() { log.push('ctor') } [k('a')] = k('va'); [k('b')]() { return 2 } [k('c')] = k('vc') } log.push('|'); const c = new C(); return log.join() + c.a + c.c + c.b() }
    export let keys = () => { const k = 'kk'; class C { a = 1; [k] = 2; b = 3; constructor() { this.c = 4 } } return Object.keys(new C()).join() + JSON.stringify(new C()) }
    export let overridden = () => { const k = () => 'a'; class C { [k()]() { return 'A' } [k()]() { return 'B' } } return new C().a() }
    export let throwing = () => { const log = []; try { class C { [(log.push('k1'), 'a')]() {} [(() => { throw 'boom' })()]() {} [log.push('k3')]() {} } } catch (e) { log.push(e) } return log.join() }
    export let generator = () => { const k = 'it'; class C { *[k]() { yield 1; yield 2 } } return [...new C().it()].join() }
    export let number = () => { class C { [1 + 1]() { return 'two' } } return new C()[2]() }
    export let derived = () => { const k = 'hi'; class A { base() { return 'b' } } class B extends A { [k]() { return 'h' + this.base() } [k + '2'] = 5 } const b = new B(); return b.hi() + b.hi2 + Object.keys(b).join() }`)
  agrees(`const KEY = ['dyn', 'amic'].join('')
    class M { [KEY]() { return 'ok' } static [KEY + 'S'] = 1 }
    export let module = () => new M().dynamic() + M.dynamicS`)
})

// Field initializers run in declaration order, those reading `this` among
// them, after the methods exist; members run in the class's scope, never
// reading a binding of the constructor's (a parameter, a declaration).
test('class: field order and member scope', () => {
  agrees(`export let order = () => { const log = [], L = s => (log.push(s), s); class C { a = L('a'); b = (L('b'), this.a); c = L('c') } new C(); return log.join() }
    export let param = () => { const x = 'outer'; class C { a = x; constructor(x) { this.b = x } m() { return x } } const c = new C('param'); return [c.a, c.b, c.m()].join() }
    export let local = () => { const y = 'outer'; class C { a = y; constructor() { const y = 'local'; this.b = y } m() { return y } } const c = new C(); return [c.a, c.b, c.m()].join() }
    export let derivedParam = () => { const x = 'outer'; class A {} class B extends A { a = x; constructor(x) { super(); this.b = x } } const b = new B('param'); return b.a + ',' + b.b }
    export let fieldCallsMethod = () => { class A {} class B extends A { x = this.m(); m() { return 9 } } return new B().x }`)
  agrees(`const x = 'outer', y = 'outer'
    class C { a = x; constructor(x) { this.b = x } }
    class D { a = y; constructor() { const y = 'local'; this.b = y } }
    export let module = () => { const c = new C('param'), d = new D(); return [c.a, c.b, d.a, d.b].join() }`)
})

// An object literal's computed key is a property key before its value is
// evaluated (a toString it calls included); a method under any key reads its
// receiver as `this`.
test('object literal: computed keys and methods under them', () => {
  agrees(`export let toKey = () => { const log = [], key = { toString() { log.push('ts'); return 'k' } }; const o = { [key]: (log.push('v'), 1) }; return log.join() + Object.keys(o).join() }
    export let method = () => { const log = [], k = s => (log.push(s), s); const o = { a: k('va'), [k('m')]() { return this.a }, [k('b')]: k('vb') }; return log.join() + '|' + o.m() + '|' + Object.keys(o).join() }
    export let literal = () => { const o = { v: 3, 'a-b'() { return this.v * 2 } }; return o['a-b']() }`)
})

test('derived closure class methods stay hidden through property growth and copying', () => {
  const prefix = `function make(x){class B{x;constructor(v){this.x=v}m(){return this.x}}
    class D extends B{n(){return this.m()+1}get total(){return this.x+2}}return new D(x)}
    export function f(n){let d=make(3);for(let i=0;i<n;i++)d['k'+i]=i;`
  for (const optimize of [0, 2, 'speed']) {
    const keys = jz(prefix + `return Object.keys(d).join(',')}`, { optimize }).exports.f
    for (const n of [0, 1, 32, 0]) is(keys(n), ['x', ...Array.from({ length: n }, (_, i) => 'k' + i)].join(','), `keys ${n}, ${optimize}`)
    for (const expr of ['Object.keys({...d}).join()', 'Object.keys(Object.assign({},d)).join()', 'Object.keys(structuredClone(d)).join()', 'Object.values(d).join()', 'JSON.stringify(d)']) {
      const expected = expr.startsWith('Object.values') ? '3' : expr.startsWith('JSON') ? '{"x":3}' : 'x'
      is(jz(prefix + `return ${expr}}`, { optimize }).exports.f(0), expected, expr)
    }
    is(jz(prefix + `let s='';for(let k in d)s+=k;return s}`, { optimize }).exports.f(0), 'x', 'for-in')
    is(jz(prefix + `return d.n()+d.total+('n' in d)}`, { optimize }).exports.f(32), 10, 'calls, getter and presence survive growth')
    is(jz(prefix + `const before=Object.keys(d).join();d.n=()=>7;return before+':'+Object.keys(d).join()+':'+d.n()}`, { optimize }).exports.f(0), 'x:x,n:7', 'an own assignment invalidates the enumeration cache')
    is(jz(prefix + `return d}`, { optimize }).exports.f(0), {x:3}, 'boundary data uses the same enumeration view')
  }
})
const rejects = (src, re) => {
  let msg = null
  try { jz(src, { jzify: true }) } catch (e) { msg = e.message }
  ok(msg != null, `expected jzify to reject: ${src}`)
  ok(re.test(msg), `error ${JSON.stringify(msg)} should match ${re}`)
}

test('class: fields + constructor + method', () => {
  if (onWasi()) return  // wasi: run-reserved / void command entry
  const { run } = compile(`
    class Point {
      x = 0
      y = 0
      constructor(a, b) { this.x = a; this.y = b }
      sumsq() { return this.x*this.x + this.y*this.y }
    }
    export let run = () => { let p = new Point(3, 4); return p.sumsq() }
  `)
  is(run(), 25)
})

test('class without a constructor', () => {
  if (onWasi()) return  // wasi: run-reserved / void command entry
  const { run } = compile(`
    class Counter { n = 10; inc() { this.n = this.n + 1; return this.n } }
    export let run = () => { let c = new Counter(); return c.inc() + c.inc() }
  `)
  is(run(), 23)   // 11 + 12
})

test('class method calling another method via this', () => {
  if (onWasi()) return  // wasi: run-reserved / void command entry
  const { run } = compile(`
    class Calc {
      v = 0
      add(x) { this.v = this.v + x; return this }
      double() { this.v = this.v * 2; return this.v }
      go() { this.add(5); return this.double() }
    }
    export let run = () => new Calc().go()
  `)
  is(run(), 10)
})

test('uninitialized field reads as undefined', () => {
  if (onWasi()) return  // wasi: run-reserved / void command entry
  const { run } = compile(`
    class Box { val; set(x) { this.val = x } read() { return this.val } }
    export let run = () => { let b = new Box(); let before = b.read() === undefined ? 1 : 0; b.set(42); return before * 100 + b.read() }
  `)
  is(run(), 142)
})

test('field initializer referencing an earlier field via this', () => {
  if (onWasi()) return  // wasi: run-reserved / void command entry
  const { run } = compile(`
    class A { x = 7; y = this.x * 3; getY() { return this.y } }
    export let run = () => new A().getY()
  `)
  is(run(), 21)
})

test('class expression', () => {
  if (onWasi()) return  // wasi: run-reserved / void command entry
  const { run } = compile(`
    let Make = class { constructor(n){ this.n = n } twice(){ return this.n * 2 } }
    export let run = () => new Make(8).twice()
  `)
  is(run(), 16)
})

test('export class — factory exported, methods exercised inside jz', () => {
  if (onWasi()) return  // wasi: run-reserved / void command entry
  const { run } = compile(`
    export class Adder { constructor(b){ this.b = b } plus(x){ return x + this.b } }
    export let run = () => { let a = new Adder(10); return a.plus(5) }
  `)
  is(run(), 15)
})

test('two instances are independent', () => {
  if (onWasi()) return  // wasi: run-reserved / void command entry
  const { run } = compile(`
    class Cell { v = 0; set(x){ this.v = x } get(){ return this.v } }
    export let run = () => { let a = new Cell(); let b = new Cell(); a.set(3); b.set(9); return a.get() * 10 + b.get() }
  `)
  is(run(), 39)
})

test('polymorphic method dispatch over a mixed array', () => {
  if (onWasi()) return  // wasi: run-reserved / void command entry
  const { run } = compile(`
    class Sq { constructor(s){ this.s = s } area(){ return this.s * this.s } }
    class Rect { constructor(w,h){ this.w = w; this.h = h } area(){ return this.w * this.h } }
    export let run = () => { let shapes = [new Sq(3), new Rect(2,5)]; return shapes[0].area() + shapes[1].area() }
  `)
  is(run(), 19)
})

test('private #field', () => {
  if (onWasi()) return  // wasi: run-reserved / void command entry
  const { run } = compile(`
    class Secret { #v = 99; reveal() { return this.#v } bump() { this.#v = this.#v + 1; return this.#v } }
    export let run = () => { let s = new Secret(); return s.reveal() * 1000 + s.bump() }
  `)
  is(run(), 99100)
})

test('new without parentheses', () => {
  if (onWasi()) return  // wasi: run-reserved / void command entry
  const { run } = compile(`
    class Zero { v = 0; val(){ return this.v } }
    export let run = () => (new Zero).val()
  `)
  is(run(), 0)
})

test('this inside a method-nested arrow refers to the instance', () => {
  if (onWasi()) return  // wasi: run-reserved / void command entry
  const { run } = compile(`
    class Summer { base = 100; sumWith(xs) { return xs.reduce((acc, x) => acc + x + this.base, 0) } }
    export let run = () => new Summer().sumWith([1, 2, 3])
  `)
  is(run(), 306)   // (1+100) + (2+100) + (3+100)
})

// A method whose name collides with a Map/Set method (`get`/`set`/`has`/`add`/
// `delete`), called directly on a `new`/call expression: the receiver is an
// untyped call result, so the collection emitter must not be picked for a
// zero-arg call (it would `emit()` a missing key and crash codegen).
test('collection-named method on a direct `new` chain', () => {
  if (onWasi()) return  // wasi: run-reserved / void command entry
  const { run } = compile(`
    class C { constructor(v){ this.v = v } get(){ return this.v + 1 } has(){ return this.v } }
    export let run = () => new C(10).get() * 100 + new C(7).has()
  `)
  is(run(), 1107)   // (10+1)*100 + 7
})

test('class static field and method', () => {
  if (onWasi()) return  // wasi: run-reserved / void command entry
  const { run } = compile(`
    class Counter {
      static start = 10
      static make() { return new Counter(Counter.start) }
      constructor(n) { this.n = n }
      value() { return this.n }
    }
    export let run = () => Counter.make().value()
  `)
  is(run(), 10)
})

test('class constant computed instance field lowers to fixed key', () => {
  if (onWasi()) return  // wasi: run-reserved / void command entry
  const { run } = compile(`
    class Box {
      ["value"] = 41
      inc() { this.value = this.value + 1; return this.value }
    }
    export let run = () => new Box().inc()
  `)
  is(run(), 42)
})

test('class constant computed instance method lowers to fixed key', () => {
  if (onWasi()) return  // wasi: run-reserved / void command entry
  const { run } = compile(`
    class Box {
      ["value"]() { return 42 }
    }
    export let run = () => new Box().value()
  `)
  is(run(), 42)
})

test('class constant computed static field lowers to fixed key', () => {
  if (onWasi()) return  // wasi: run-reserved / void command entry
  const { run } = compile(`
    class Counter {
      static ["start"] = 10
      static next() { return Counter.start + 1 }
    }
    export let run = () => Counter.next()
  `)
  is(run(), 11)
})

test('class constant computed static method lowers to fixed key', () => {
  if (onWasi()) return  // wasi: run-reserved / void command entry
  const { run } = compile(`
    class Counter {
      static ["next"]() { return 12 }
    }
    export let run = () => Counter.next()
  `)
  is(run(), 12)
})

test('class static method uses this as class binding', () => {
  if (onWasi()) return  // wasi: run-reserved / void command entry
  const { run } = compile(`
    class Counter {
      static start = 10
      static next() { return this.start + 1 }
    }
    export let run = () => Counter.next()
  `)
  is(run(), 11)
})

// A class whose `constructor` is read is a value (the binder hands it out), so
// its statics keep their table; a call `C.m(…)` is still the call of the
// static's function, seen as one by the inliner and the parameter census
// (plan/scope.js flattenFuncNamespaces): three's `Quaternion.slerpFlat` in a
// loop, spliced there with its offsets as integers.
test('class static method of a class handed out as a value is a direct call before emission', () => {
  const src = `
    class Q {
      constructor(x = 0, w = 1) { this.x = x; this.w = w }
      clone() { return new this.constructor(this.x, this.w) }
      static mix(dst, d, a, o, t) { dst[d] = a[o] * (1 - t) + a[o + 1] * t }
    }
    export let run = () => {
      const n = 64, a = new Float64Array(n * 2), dst = new Float64Array(n)
      for (let i = 0; i < a.length; i++) a[i] = i * 0.5
      for (let i = 0; i < n; i++) Q.mix(dst, i, a, i * 2, 0.25)
      let s = 0
      for (let i = 0; i < n; i++) s += dst[i]
      const held = new Q(4).clone().constructor.mix
      held(dst, 0, a, 6, 0.5)
      return s + new Q(3).clone().x + dst[0]
    }`
  for (const optimize of levels(1, 2, 'speed')) is(jz(src, { optimize }).exports.run(), oracle(src).run(), `O${optimize}`)
  if (onKernel()) return
  ok(!/call \$Q\$mix\b/.test(compileWat(src, { wat: true, optimize: 'speed' })), 'the static is spliced at its site')
})

// A static, or any function's property, stored again beyond its definition
// (inside a function, before its class, through an alias or a parameter,
// under a computed key, by a pattern or a loop head, by Object.assign) holds
// what was stored last where it is called: the summary's census of a
// function's own properties is the one witness the namespace flattening, the
// program index and the emitter read before calling the lifted function.
test('class statics and function properties stored anywhere are called as stored', () => {
  // a fresh module each time: the programs store into their classes
  const agreesAt = (src) => {
    for (const optimize of levels(0, 2, 'speed')) {
      const want = oracle(src), got = jz(src, { optimize }).exports
      for (const name of Object.keys(want)) if (!/^class\b/.test(String(want[name]))) is(got[name](), want[name](), `${name} O${optimize}`)
    }
  }
  agreesAt(`class C { static m() { return 1 } }
    const g = () => { C.m = () => 2 }
    export let inFunction = () => { const a = C.m(); g(); return a * 10 + C.m() }`)
  agreesAt(`class C { static m() { return 1 } }
    const g = () => { C.m = () => 2 }
    g()
    export let calledAtTop = () => C.m()`)
  agreesAt(`class C { static m() { return 1 } }
    export let inBody = () => { const a = C.m(); C.m = () => 2; return a * 10 + C.m() }`)
  agreesAt(`class C { static m() { return 1 } }
    export let inClosure = () => { const s = () => { C.m = (x) => x * 3 }; const a = C.m(); s(); return a + C.m(5) }`)
  agreesAt(`const s = () => { C.m = () => 2 }
    class C { static m() { return 1 } }
    export let before = () => { const a = C.m(); s(); return a * 10 + C.m() }`)
  agreesAt(`class C { static m() { return 1 } }
    export let alias = () => { const a = C.m(); const K = C; K.m = () => 2; return a * 10 + C.m() }`)
  agreesAt(`class C { static m() { return 1 } }
    const w = (o) => { o.m = () => 2 }
    export let param = () => { const a = C.m(); w(C); return a * 10 + C.m() }`)
  agreesAt(`class C { static m() { return 1 } }
    export let computed = () => { const a = C.m(); C['m'] = () => 2; const b = C.m(), k = 'm', K = C; K[k] = () => 3; return a * 100 + b * 10 + C.m() }`)
  agreesAt(`class C { static m() { return 1 } }
    const set = (o, k, v) => { o[k] = v }, ks = ['x', 'm']
    export let dynamicKey = () => { const a = C.m(); set(C, 'm', () => 2); const b = C.m(); for (const k of ks) C[k] = () => 3; return a * 100 + b * 10 + C.m() }`)
  agreesAt(`function g() {} g.p = () => 1
    const del = (o, k) => { delete o[k] }
    export let deleted = () => { const a = g.p(); del(g, 'p'); try { return a + g.p() } catch (e) { return [a, e instanceof TypeError, typeof g.p] } }`)
  agreesAt(`class C { static m() { return 1 } }
    export let pattern = () => { const a = C.m(); ({ q: C.m } = { q: () => 2 }); const b = C.m(); [C.m] = [() => 3]; return a * 100 + b * 10 + C.m() }`)
  agreesAt(`class C { static m() { return 1 } }
    export let loopHead = () => { const a = C.m(); for (C.m of [() => 2]); return a * 10 + C.m() }`)
  agreesAt(`class C { static m() { return 1 } }
    export let assigned = () => { const a = C.m(); Object.assign(C, { m: () => 2 }); return a * 10 + C.m() }`)
  agreesAt(`class C { static m() { return 1 } }
    const s = () => { C.m = 5 }
    export let number = () => { s(); return C.m }`)
  agreesAt(`class C { static m() { return 1 } }
    const s = () => { C.m = () => 2 }
    export let held = () => { s(); const h = C.m; return h() }`)
  agreesAt(`class C { static k = 3; static m() { return this.k } static n() { return this.m() } }
    const s = () => { C.m = () => 7 }
    export let viaThis = () => { const a = C.n(); s(); return a * 10 + C.n() }`)
  agreesAt(`class C { static m() { return 1 } g() { return this.constructor.m() } }
    const s = () => { C.m = () => 2 }
    export let viaConstructor = () => { const c = new C(), a = c.g(); s(); return a * 10 + c.g() }`)
  agreesAt(`export class C { static m() { return 1 } }
    const s = () => { C.m = () => 2 }
    export let exported = () => { const a = C.m(); s(); return a * 10 + C.m() }`)
  agreesAt(`class C { static m = () => 1 }
    const s = () => { C.m = () => 2 }
    export let field = () => { const a = C.m(); s(); return a * 10 + C.m() }`)
  agreesAt(`function g() {} g.p = () => 1
    const s = () => { g.p = () => 2 }
    export let fnProp = () => { const a = g.p(); s(); return a * 10 + g.p() }`)
  agreesAt(`function g() {}
    const s = () => { g.p = () => 2 }
    g.p = () => 1
    export let fnPropBefore = () => { const a = g.p(); s(); return a * 10 + g.p() }`)
  agreesAt(`function b() { return 2 } function g() {} g.p = () => 1
    export let fnPropNamed = () => { const a = g.p(); g.p = b; return a * 10 + g.p() }`)
  agreesAt(`function g() {} g.p = () => 1
    const s = () => { g.p ||= () => 2; g.p &&= () => 3 }
    export let fnPropLogical = () => { s(); return g.p() }`)
  agreesAt(`function g() {} g.p = (x) => x
    export let fnPropLoop = () => { let t = 0; for (let i = 0; i < 3; i++) { t += g.p(i); g.p = (x) => x * 10 } return t }`)
  agreesAt(`function g() {} g.p = (x) => x * 2
    const s = () => { g.p = null }
    export let optional = () => { const a = g.p?.(21); s(); return [a, g.p?.(21)] }`)
})

test('named class expression static method sees inner name', () => {
  if (onWasi()) return  // wasi: run-reserved / void command entry
  const { run } = compile(`
    let Counter = class _Counter {
      static start = 10
      static next() { return _Counter.start + 2 }
    }
    export let run = () => Counter.next()
  `)
  is(run(), 12)
})

test('class extends: constructor super and inherited method', () => {
  if (onWasi()) return  // wasi: run-reserved / void command entry
  const { run } = compile(`
    class Base {
      constructor(x) { this.x = x }
      value() { return this.x }
    }
    class Derived extends Base {
      constructor(x) { super(x); this.y = 5 }
      sum() { return this.value() + this.y }
    }
    export let run = () => new Derived(7).sum()
  `)
  is(run(), 12)
})

test('class extends: default constructor forwards args', () => {
  if (onWasi()) return  // wasi: run-reserved / void command entry
  const { run } = compile(`
    class Base {
      constructor(x) { this.x = x }
      value() { return this.x }
    }
    class Derived extends Base {
      twice() { return this.value() * 2 }
    }
    export let run = () => new Derived(9).twice()
  `)
  is(run(), 18)
})

test('class extends: inherited helper used by derived method', () => {
  if (onWasi()) return  // wasi: run-reserved / void command entry
  const { run } = compile(`
    class Adapter {
      extract(item) { return item.qty + 1 }
    }
    class ProductAdapter extends Adapter {
      total(item) { return this.extract(item) * 10 }
    }
    export let run = () => new ProductAdapter().total({qty: 4})
  `)
  is(run(), 50)
})

test('class extends: expression heritage member is evaluated once', () => {
  if (onWasi()) return  // wasi: run-reserved / void command entry
  const { run } = compile(`
    class Base {
      constructor(x) { this.x = x }
      value() { return this.x + 1 }
    }
    let ns = { Base }
    class Derived extends ns.Base {
      value() { return super.value() * 2 }
    }
    export let run = () => new Derived(5).value()
  `)
  is(run(), 12)
})

test('class extends: call-expression heritage is evaluated once', () => {
  if (onWasi()) return  // wasi: run-reserved / void command entry
  const { run } = compile(`
    class Base {
      constructor(x) { this.x = x }
      value() { return this.x + 1 }
    }
    let picks = 0
    let pick = () => { picks++; return Base }
    class Derived extends pick() {
      value() { return super.value() + picks }
    }
    export let run = () => new Derived(5).value() * 10 + picks
  `)
  is(run(), 71)
})

test('class extends: super.method call dispatches to base implementation', () => {
  if (onWasi()) return  // wasi: run-reserved / void command entry
  const { run } = compile(`
    class Base {
      constructor(x) { this.x = x }
      value() { return this.x + 1 }
    }
    class Derived extends Base {
      value() { return super.value() * 2 }
    }
    export let run = () => new Derived(5).value()
  `)
  is(run(), 12)
})

test('class extends: super.method call from constructor', () => {
  if (onWasi()) return  // wasi: run-reserved / void command entry
  const { run } = compile(`
    class Base {
      constructor(x) { this.x = x }
      value() { return this.x + 1 }
    }
    class Derived extends Base {
      constructor(x) { super(x); this.y = super.value() * 3 }
      value() { return this.y }
    }
    export let run = () => new Derived(4).value()
  `)
  is(run(), 15)
})

test('class extends: super["method"] call dispatches to base implementation', () => {
  if (onWasi()) return  // wasi: run-reserved / void command entry
  const { run } = compile(`
    class Base {
      constructor(x) { this.x = x }
      value() { return this.x + 1 }
    }
    class Derived extends Base {
      value() { return super["value"]() * 4 }
    }
    export let run = () => new Derived(2).value()
  `)
  is(run(), 12)
})

test('rejects `super` property read', () => rejects(`class B { x(){ return 1 } } class A extends B { y(){ return super.x } } export let run = () => 1`, /super/))
test('rejects dynamic super member call', () => rejects(`class B { x(){ return 1 } } class A extends B { y(k){ return super[k]() } } export let run = () => 1`, /super/))
// Accessors lower to the `x__get`/`x__set` slots; a read or write of the
// name dispatches through them on OBJECT/unknown receivers (a known schema
// statically, an unknown receiver by a runtime probe with the plain access as
// the fallback), and every other receiver kind keeps its own lowering.
test('class accessors: getter and setter on a known instance', () => {
  if (onWasi()) return
  const { run } = compile(`
    class Param {
      #v = 1
      #writes = 0
      get value() { return this.#v * 10 }
      set value(v) { this.#writes++; this.#v = v }
      get writes() { return this.#writes }
    }
    export let run = () => {
      const p = new Param()
      p.value = 4
      p.value += 1
      return p.value * 100 + p.writes
    }
  `)
  is(run(), 41002)   // set 4, read 40 + 1 → set 41, read 410; two writes
})

test('class accessors: unknown receiver probes, a plain object reads its field', () => {
  if (onWasi()) return
  const { run } = compile(`
    class Ctx {
      #len = 7
      get length() { return this.#len }
      set length(n) { this.#len = n * 2 }
    }
    const lengthOf = (o) => o.length
    const setLength = (o, n) => { o.length = n; return o }
    export let run = () => {
      const c = new Ctx()
      const arr = [1, 2, 3]
      const plain = { length: 5 }
      setLength(c, 3)
      return lengthOf(c) * 100 + lengthOf(plain) * 10 + lengthOf(arr) + arr.length * 1000 + 'abcd'.length * 10000
    }
  `)
  is(run(), 43653)
})

test('object-literal accessors and a static accessor pair', () => {
  if (onWasi()) return
  const { run } = compile(`
    const o = { base: 2, get twice() { return this.base * 2 }, set twice(v) { this.base = v / 2 } }
    class K {
      tag = 1
      static get unit() { return 3 }
    }
    export let run = () => { o.twice = 10; return o.twice * 100 + K.unit }
  `)
  is(run(), 1003)
})

test('accessor: a derived class inherits the base getter', () => {
  if (onWasi()) return
  const { run } = compile(`
    class B { #n = 2; get n() { return this.#n + 1 } }
    class D extends B { m() { return this.n * 5 } }
    export let run = () => new D().m()
  `)
  is(run(), 15)
})
// a member under a computed name is defined (see 'computed member names evaluate in source order'); an accessor is not
test('rejects a getter or setter under a computed name', () => {
  rejects(`let key = "x"; class A { get [key]() { return 1 } } export let run = () => 1`, /computed name/)
  rejects(`let key = "x"; export let run = () => { const o = { set [key](v) {} }; return 1 }`, /computed name/)
})

// Computed class member names from module-scope const bindings: jzify's entry
// prepass collects `const K = 'str'`, class lowering folds `[K]` (const
// guarantees no reassignment). Dynamic keys still reject cleanly.
test('class: computed member names fold from module consts', () => {
  const j = (code) => jz(code).exports.f()
  is(j(`const K = "m"; class A { [K]() { return 5 } } export let f = () => new A().m()`), 5)
  is(j(`const F = "x"; class A { [F] = 7 } export let f = () => new A().x`), 7)
  is(j(`const K = "g"; class A { [K]() { return 1 } m() { return this["g"]() + 1 } } export let f = () => new A().m()`), 2)
})

// Pseudo-classical fold: `function P(){this.x=…}` + `P.prototype.m = function`
// siblings fold into the class lowering — the biggest `this` blocker in
// pre-class npm code. Function-valued methods only (an arrow RHS keeps lexical
// `this` — folding would rebind it, so it stays out and errors as before);
// ctor reassignment / whole-`prototype={…}` replacement fail closed.
test('class: pseudo-classical constructor + prototype methods fold', () => {
  const j = (code) => jz(code).exports.f()
  is(j(`function Point(x, y) { this.x = x; this.y = y }
Point.prototype.dist = function () { return Math.sqrt(this.x * this.x + this.y * this.y) }
export let f = () => new Point(3, 4).dist()`), 5)
  is(j(`function V(x) { this.x = x }
V.prototype.get = function () { return this.x }
V.prototype.scaled = function (k) { return new V(this.x * k) }
export let f = () => new V(5).scaled(3).get()`), 15)
  is(j(`function add(a, b) { return a + b } export let f = () => add(2, 3)`), 5)  // plain fns untouched
  is(j(`Q.prototype.get = function () { return this.x }
function Q(x) { this.x = x }
export let f = () => new Q(6).get()`), 6)  // methods BEFORE the ctor (decls hoist) still fold
  let err
  try { compileWat(`function P() { this.x = 1 }
P.prototype.m = () => 5
export let f = () => 1`) } catch (e) { err = e }
  ok(err && /this/.test(err.message), 'arrow-valued prototype member stays out (lexical this)')
})

// Object.assign(P.prototype, { m: function () {…}, … }) — the batch idiom joins
// the pseudo-classical fold; any non-function prop value fails the whole
// statement closed (arrow = lexical this, data prop = prototype state).
test('class: Object.assign(prototype) batch folds', () => {
  const j = (code) => jz(code).exports.f()
  is(j(`function V(x) { this.x = x }
Object.assign(V.prototype, { get: function () { return this.x }, dbl: function () { return this.x * 2 } })
export let f = () => new V(7).dbl() + new V(1).get()`), 15)
  let err
  try { compileWat(`function P() { this.x = 1 }
Object.assign(P.prototype, { m: function () { return this.x }, k: 5 })
export let f = () => 1`) } catch (e) { err = e }
  ok(err && /this/.test(err.message), 'mixed batch stays out')
})

// Static class members: fields + methods (this → the class) were already
// lowered as post-decl closure props; static BLOCKS now run in class-init
// order with the same this-binding.
test('class: static fields, methods, and blocks', () => {
  const j = (code) => jz(code).exports.f()
  is(j(`class A { static x = 41; static m(k) { return A.x + k } } export let f = () => A.m(1)`), 42)
  is(j(`class C { static base = 10; static mk(v) { return this.base + v } } export let f = () => C.mk(5)`), 15)
  is(j(`class E { static a = 1; static { E.b = E.a + 10 } static c = 100 } export let f = () => E.b + E.c`), 111)
})

// === Classes as structs (jzify/classes.js lowerStruct, src/compile/emit/class-dispatch.js) ===

// A receiver of no class calls the member it holds with every argument the
// call writes out: the dispatcher of a class member took only as many as the
// class's method declares, so a host object's `digest('SHA-1', data)` beside a
// class's `digest(t)` reached the host with one argument.
test('class dispatch passes a non-class receiver every argument the call writes out', () => {
  const src = `class E { m(t) { return [t] } }
    export const mk = () => new E()
    export const call = (o) => o.m(1, 2, 3)
    export const own = () => mk().m(5, 6)`
  for (const optimize of levels(0, 2, 'size')) {
    const e = jz(src, { optimize }).exports
    if (!onWasi()) is(e.call({ m: (...a) => a }), [1, 2, 3], `O${optimize} a host object's method takes them all`)
    is(e.own(), [5], `O${optimize} the class's method takes what it declares`)
  }
})

test('class struct: an instance holds its fields alone; a method is a function of the receiver', () => {
  const src = `export class P { constructor(x, y) { this.x = x; this.y = y } len() { return this.x * this.x + this.y * this.y } }
    export const f = (n) => { let s = 0; for (let i = 0; i < n; i++) { const p = new P(i, 2); s += p.len() } return s }`
  const { f, P } = jz(src).exports
  is(f(4), 30)
  is(jz(src + `\nexport const keys = () => Object.keys(new P(1, 2)).join()`).exports.keys(), 'x,y', 'no method slots')
  if (!onWasi()) is(JSON.stringify(new P(3, 4)), '{"x":3,"y":4}', 'the host sees the fields alone')
  // level 2: below it the member's dispatcher, dead here, is not shaken
  if (OPT_LEVEL === 2) {
    const inside = src.replace('export class', 'class')
    ok(!/__dyn_get|__hash|__str_concat|__closure/.test(compileWat(src, { wat: true })), 'a direct call: no dynamic read, no closure, no string path')
    ok(compileWat(inside).length < 1200, `the struct's size class (${compileWat(inside).length} B)`)
    // exported, the class takes the host's view of its member: one export of the method
    ok(compileWat(src).length < 1300, `the exported struct's size class (${compileWat(src).length} B)`)
  }
})

test('class struct: two classes of one shape dispatch on the schema id through an unknown receiver', () => {
  const { f, plain } = compile(`
    class Cat { constructor(n) { this.name = n } speak() { return this.name + ' meows' } }
    class Dog { constructor(n) { this.name = n } speak() { return this.name + ' barks' } }
    const pick = (i) => i ? new Dog('rex') : new Cat('tom')
    export const f = (i) => pick(i).speak()
    export const plain = () => ({ name: 'x', speak: () => 'plain' }).speak()`)
  is(f(0), 'tom meows'); is(f(1), 'rex barks')
  is(plain(), 'plain', 'a plain object with a closure property keeps its own dispatch')
})

test('class struct: a method read as a value is bound to its receiver; an own property shadows the method', () => {
  const j = (code) => jz(code).exports.f()
  is(j(`class P { constructor(x) { this.x = x } dbl() { return this.x * 2 } }
    export const f = () => { const p = new P(4); const f = p.dbl; return f() + [1].map(p.dbl)[0] }`), 16)
  is(j(`class P { constructor(x) { this.x = x } dbl() { return this.x * 2 } }
    export const f = () => { const p = new P(4); p.dbl = () => 1; return p.dbl() + new P(5).dbl() }`), 11)
})

// A member name some instance owns (`poke` stores it): a receiver of known
// layouts none of which holds the name keeps any such own property in its
// properties word, so one whose word is zero calls the class's method without
// the property lookup, and the instance that owns one still calls its own.
test('class struct: an instance with no own properties skips the shadowing lookup', () => {
  const src = `class Param { constructor(v) { this.v = v } tick() { return this.v } }
    class Node { constructor(v) { this.p = new Param(v) } run() { return this.p.tick() } }
    const poke = (x) => { x.tick = () => -1 }
    export const f = (k) => {
      const a = new Node(2), b = new Node(3)
      let s = 0
      for (let i = 0; i < 4; i++) { if (i === k) poke(b.p); s += a.run() * 10 + b.run() }
      return s
    }`
  for (const optimize of levels(0, 2, 3, 'size')) {
    const { f } = jz(src, { optimize }).exports
    for (const k of [-1, 0, 2, 5]) is(f(k), [92, 76, 84, 92][[-1, 0, 2, 5].indexOf(k)], `O${optimize}: poked at ${k}`)
  }
  if (onWasi() || onKernel()) return  // a host-only profiling option
  const inst = instantiate(new WebAssembly.Module(compileWat(src, { optimize: 2, helperCounters: true })), {})
  is(inst.exports.f(-1), 92)
  is((inst.instance?.exports ?? inst.exports).__hc_dyn_get_expr.value, 0n, 'no instance owns the name: no lookup')
})

test('class struct: nullable method values retain binding and reject missing receivers', () => {
  const src = `class P { constructor(x) { this.x = x } dbl() { return this.x * 2 } }
    export function f(i) {
      const rows = [new P(4)], p = rows[i];
      try { const method = p.dbl; return method(); } catch (e) { return e.name; }
    }`
  for (const optimize of [0, 2, 3, 'size']) {
    const { f } = jz(src, { optimize }).exports
    for (const i of [0, 0, 1, -1, 0]) is(f(i), i === 0 ? 8 : 'TypeError', `O${optimize}: row ${i}`)
  }
})

// A method wider than the closure's inline lanes (three.js's 16-argument
// Matrix4.set) still has a bound value: it takes its arguments as a rest.
test('class struct: a method wider than the closure lanes keeps a bound value', () => {
  const src = `class M { constructor() { this.e = [] }
      set(a, b, c, d, e, f, g, h, i, j) { const t = this.e; t[0] = a; t[7] = h; t[8] = i; t[9] = j; return this } }
    class V { constructor() { this.x = 0 } set(x) { this.x = x; return this } }
    export const f = (k) => { const o = k ? new M() : new V(), s = o.set
      return k ? s(1, 2, 3, 4, 5, 6, 7, 8).e[7] + (s(1).e[9] === undefined ? 100 : 0) : s(5).x }
    export const g = () => new M().set(1, 2, 3, 4, 5, 6, 7, 8, 9, 10).e[9]`
  for (const optimize of [0, 2, 3, 'size']) {
    const { f, g } = jz(src, { optimize }).exports
    for (const k of [1, 1, 0, 1]) is(f(k), k ? 108 : 5, `O${optimize}: value ${k}`)
    is(g(), 10, `O${optimize}: direct call`)
  }
})

test('class struct: accessors on a known receiver, an unknown receiver, a plain object', () => {
  const { f, unknown } = compile(`
    class T { #c = 0; constructor(v) { this.v = v } get twice() { return this.v * 2 } set twice(x) { this.v = x / 2 } }
    export const f = () => { const t = new T(3); t.twice = 10; return t.twice * 100 + t.v }
    const any = (o) => o.twice
    export const unknown = (i) => any(i ? new T(4) : { twice: 7 })`)
  is(f(), 1005); is(unknown(1), 8); is(unknown(0), 7)
  // The instance's literal inlines into the caller; an accessor accessed as a value, in a
  // branch, or compound-assigned is the class's function still (analyze-scans.js: a member's
  // name is no slot), where the setter's store folded away once (`t.v` read 3 for 5).
  const { asValue, compound, branch, maybe } = compile(`
    class T { constructor(v) { this.v = v } get twice() { return this.v * 2 } set twice(x) { this.v = x / 2 } }
    export const asValue = () => { const t = new T(3); const r = (t.twice = 10); return r * 100 + t.v }
    export const compound = () => { const t = new T(3); t.twice += 4; return t.twice * 100 + t.v }
    export const branch = (c) => { const t = new T(3); if (c) t.twice = 10; return t.twice * 100 + t.v }
    export const maybe = (c) => { const t = c ? new T(3) : null; return t ? t.twice : -1 }`)
  is(asValue(), 1005, 'the assignment\'s value is the value assigned'); is(compound(), 1005); is(branch(1), 1005); is(branch(0), 603); is(maybe(1), 6); is(maybe(0), -1)
})

test('class struct: a derived class shares the base fields and functions; super; instanceof', () => {
  const { f } = compile(`
    class B { constructor(x) { this.x = x } value() { return this.x + 1 } describe() { return 'b' + this.value() } }
    class D extends B { constructor(x, y) { super(x); this.y = y } value() { return super.value() * 2 + this.y } }
    class E extends D {}
    export const f = () => { const d = new D(5, 1), e = new E(1, 1)
      return d.describe() + ',' + e.describe() + ',' + (d instanceof B) + (d instanceof D) + (new B(1) instanceof D) + (e instanceof B) + (({}) instanceof B) }`)
  is(f(), 'b13,b5,truetruefalsetruefalse')
})

test('class struct: an imported class keeps its identity across modules', () => {
  const modules = { './p.js': `export class P { constructor(x) { this.x = x } dbl() { return this.x * 2 } get sq() { return this.x * this.x } }
    export const mk = (x) => new P(x)` }
  const { f } = jz(`import { P, mk } from './p.js'
    export const f = () => { const p = new P(3); const q = mk(4); return p.dbl() + q.sq }`, { modules }).exports
  is(f(), 22)
})

test('class static async methods, private ones too', async () => {
  if (onWasi()) return  // wasi: run-reserved / void command entry
  const { m, q, s } = compile(`
    class A {
      static k = 3
      static async m() { return this.k * 2 }
      static async #p() { return 4 }
      static async q() { return await A.#p() + 1 }
      async #r() { return 5 }
      s() { return this.#r() }
    }
    export let m = () => A.m()
    export let q = () => A.q()
    export let s = () => new A().s()
  `)
  is(await m(), 6)
  is(await q(), 5)
  is(await s(), 5)
})

test('class derived constructor with a bare super()', () => {
  if (onWasi()) return  // wasi: run-reserved / void command entry
  const { run } = compile(`
    class N { constructor() { this.w = 0 } }
    class W extends N { constructor() { super(); this.w = 1 } }
    class V extends N { }
    export let run = () => new W().w * 10 + new V().w
  `)
  is(run(), 10)
})

test('class optional method call on a known receiver', () => {
  if (onWasi()) return  // wasi: run-reserved / void command entry
  const { run } = compile(`
    class N { constructor() { this.w = 0 } }
    class W extends N { constructor() { super(); this.w = 1 } _wake() { this.w = 2 } }
    class P { constructor(node) { this.node = node } c() { this.node._wake?.(); return this.node.w } }
    export let run = () => new P(new N()).c() * 10 + new P(new W()).c()
  `)
  is(run(), 2, 'absent: undefined, present: the bound method runs')
})

// A class function returning BOOL yields the raw 0/1 to readers whose own type
// proves the call BOOL (a receiver of one named class); every other reader of
// the same value (a dispatcher's caller, an optional chain joining the
// undefined arm, a stored element) expects the true/false atom. Reference:
// ECMA-262 13.3.9.1 OptionalChain (a nullish base short-circuits to undefined),
// 13.5.3 typeof (a Boolean value reads "boolean").
test('class method boolean result keeps its atom through a dispatcher and an optional chain', () => {
  const { known, unknown, optional } = compile(`
    class C { ok() { return true } }
    class D { ok() { return false } }
    let o = null
    export let known = () => { const before = o?.ok() === true; o = new C(); const v = o?.ok(); return [before, v === true, typeof v, [o?.ok()][0]] }
    let pick = k => k === 0 ? new C() : k === 1 ? new D() : k === 2 ? { ok() { return 1 } } : null
    export let unknown = k => { const x = pick(k); return [typeof x.ok(), x.ok() === true] }
    export let optional = k => { const x = pick(k); return [typeof x?.ok(), x?.ok() === true] }
  `)
  is(known(), [false, true, 'boolean', true])
  is(unknown(0), ['boolean', true])
  is(unknown(1), ['boolean', false])
  is(unknown(2), ['number', false], 'an object literal method is not a class arm')
  is(optional(0), ['boolean', true])
  is(optional(1), ['boolean', false])
  is(optional(3), ['undefined', false], 'a nullish receiver short-circuits to undefined')
})

// `static get v() {}` / `static set v(x) {}` on one line parsed as a static
// field named `get` followed by a method (the multi-line form too, silently),
// and the one-line form failed with "Unclosed {". The parser now reads the
// accessor after `static` (subscript feature/class.js), and the class lowering
// takes the accessor onto the constructor. Reference: ECMA-262 15.7.1
// ClassElement: `static MethodDefinition`, with MethodDefinition covering
// `get`/`set` accessors.
test('class static accessors, one line or many', () => {
  const { one, many, both, viaThis } = compile(`
    class A { static get v() { return 7 } }
    class B {
      static get v() { return 8 }
    }
    class C { static w = 0; static set v(x) { C.w = x * 2 } static get v() { return C.w } static getter() { return 1 } }
    class D { static n = 4; static get twice() { return this.n * 2 } }
    export let one = () => A.v
    export let many = () => B.v
    export let both = () => { C.v = 3; return C.v + C.getter() }
    export let viaThis = () => D.twice
  `)
  is(one(), 7); is(many(), 8); is(both(), 7); is(viaThis(), 8)
})

// Every store to a static accessor calls its setter with the value it
// assigns, which the store yields: a compound or logical one reads through
// the getter first, an increment yields the old number postfix and the new
// prefix, and one with no setter throws a TypeError, as in strict code.
test('class static accessors under every store', () => {
  const src = `class C { static w = 1; static get v() { return C.w } static set v(x) { C.w = x * 10; return 99 } }
    class G { static get v() { return 7 } }
    class S { static w = 0; static set v(x) { S.w = x } }
    export let value = () => { C.w = 1; const r = (C.v = 5); let y; y = C.v = 2; return [r, y, C.w] }
    export let compound = () => { C.w = 1; const r = (C.v += 2); C.v *= 3; C.v -= 1; C.v **= 1; C.v %= 7; C.v <<= 1; C.v |= 1; return [r, C.w] }
    export let logical = () => { C.w = 0; C.v ||= 4; const a = C.w; C.v &&= 5; const b = C.w; C.w = null; C.v ??= 6; return [a, b, C.w] }
    export let steps = () => { C.w = 1; const a = C.v++, b = ++C.v, c = C.v--, d = --C.v; return [a, b, c, d, C.w] }
    export let getterOnly = () => { const log = []; try { G.v = (log.push('rhs'), 1) } catch (e) { log.push(e instanceof TypeError) } try { G.v += 1 } catch (e) { log.push(e instanceof TypeError) } return [log, G.v] }
    export let setterOnly = () => { S.v = 3; const r = S.v; S.v ??= 4; return [r, S.w] }
    export let inFunction = () => { const bump = () => { C.v += 1 }; C.w = 1; bump(); bump(); return C.w }`
  for (const optimize of levels(0, 2, 'speed')) {
    const want = oracle(src), got = jz(src, { optimize }).exports
    for (const name of Object.keys(want)) is(got[name](), want[name](), `${name} O${optimize}`)
  }
})

// A derived class reads a static it does not declare through its base, as JS
// reads it through the class's prototype: a method, a field as the base holds
// it now, a getter and a setter, through the class's name or a value holding
// it. A static that reads `this` runs with the class it is read through,
// `super.m()` and `super.x` in a static reach the base's with the receiver,
// an own static of the name replaces the base's member whole, and a private
// static stays the declaring class's.
test('class statics inherit through the base', () => {
  const src = `class A {
      static k = 3; static count = 0; static tag = 'a'
      static create(x) { return new this(x) }
      static describe() { return this.tag + ':' + this.k }
      static get g() { return 'g' + this.tag }
      static set s(v) { this.sv = v * 2 }
      static get ro() { return 1 }
      static bump() { A.count++; return A.count }
      static plain(x) { return x + 1 }
      static *steps() { yield this.k; yield this.k + 1 }
      static #p() { return 4 }
      static usesP() { return this.#p() }
      constructor(x) { this.x = x }
    }
    class B extends A {
      static tag = 'b'
      static describe() { return 'B(' + super.describe() + ')' }
      static get g() { return super.g + '!' }
      static plain(x) { return super.plain(x) * 10 }
      static k2 = super.k * 10
      static { this.blk = super.tag + this.tag }
    }
    class C extends B { static k = 9 }
    class D extends A { static get k() { return 42 } }
    class E extends A { static ro = 7 }
    const describe = (K) => K.describe(), make = (K, x) => K.create(x)
    export let methods = () => [B.create(5) instanceof B, B.create(5).x, C.create(6) instanceof C, B.describe(), C.describe(), D.describe(), C.plain(1), D.plain(1)]
    export let accessors = () => [B.g, C.g, D.k, A.g, [...C.steps()]]
    export let setters = () => { B.s = 4; C.s = 5; return [B.sv, C.sv, A.sv] }
    export let live = () => { A.bump(); A.bump(); const a = B.count; A.count = 10; return [a, B.count, C.count] }
    export let own = () => { B.k = 100; B.count += 5; return [A.k, B.k, C.k, A.count, B.count] }
    export let values = () => [describe(B), describe(C), make(C, 1) instanceof C, make(A, 2).x, [A, B, C].map(K => K.tag).join()]
    export let superFields = () => [B.k2, B.blk]
    export let replaced = () => { const log = []; try { B.ro = 5 } catch (e) { log.push(e instanceof TypeError) } E.ro = 8; log.push(E.ro, B.ro); return log }
    export let ownership = () => [B.hasOwnProperty('k'), Object.hasOwn(B, 'plain'), Object.hasOwn(D, 'plain'), D.hasOwnProperty('tag'), 'k' in C, 'plain' in D]
    export let privates = () => { const out = [A.usesP()]; try { out.push(C.usesP()) } catch (e) { out.push(e instanceof TypeError) } return out }`
  for (const optimize of levels(0, 2, 'speed')) {
    const want = oracle(src), got = jz(src, { optimize }).exports
    for (const name of Object.keys(want)) is(got[name](), want[name](), `${name} O${optimize}`)
  }
})

// Classes of closures (declared in a function, a class expression, a base an
// expression names) inherit their statics the same way, as does a class
// whose statics the program stores after its declaration; a base an
// expression names is `this` for the statics read through it.
test('class statics inherit in classes of closures', () => {
  const src = `class A { static k = 3; static name2 = 'A'; static plain(x) { return x + 1 } static who() { return this.name2 } static make() { return new this() } }
    class B extends A { static name2 = 'B' }
    export let nested = () => {
      class P { static k = 1; static who() { return this.k } static up() { return P.k } }
      class Q extends P { static k = 2; static both() { return super.who() * 10 + this.k } }
      return [Q.who(), Q.up(), Q.k, Q.both()]
    }
    export let fromModule = () => { class N extends A { static name2 = 'N' } return [N.who(), N.plain(5), N.make() instanceof A] }
    export let expression = () => { const X = class extends A { static name2 = 'X' }; return [X.who(), X.plain(2), X.k] }
    const pick = (f) => f ? A : B
    export let dynamic = () => { class Z extends pick(false) {} return [Z.plain(1), Z.k, Z.who()] }
    class R {}
    R.registry = new Map(); R.count = 1
    class S extends R {}
    export let storedAfter = () => { S.registry.set('a', 1); R.count++; return [R.registry.size, S.count, S.registry === R.registry] }`
  for (const optimize of levels(0, 2, 'speed')) {
    const want = oracle(src), got = jz(src, { optimize }).exports
    for (const name of Object.keys(want)) is(got[name](), want[name](), `${name} O${optimize}`)
  }
})

// Across modules, through an import under another name, and for the host: an
// exported derived class carries the statics it inherits.
test('class statics inherit across modules and to the host', () => {
  const modules = {
    './base.js': `const helper = (x) => x * 2
      export class A { static k = 1; static make() { return new this() } static twice() { return helper(this.k) } static plain(x) { return helper(x) } static get g() { return this.k + 100 } }`,
    './mid.js': `import { A as Base } from './base.js'\nexport class M extends Base { static k = 5 }`,
  }
  const src = `import { A } from './base.js'
    import { M } from './mid.js'
    class B extends M { static k = 7; static twice() { return super.twice() + 1 } }
    export let f = () => [A.twice(), M.twice(), B.twice(), M.plain(3), B.make() instanceof B, M.make() instanceof A, B.g, M.g]`
  // node: [2, 10, 15, 6, true, true, 107, 105]
  for (const optimize of levels(0, 2, 'speed')) is(jz(src, { optimize, modules }).exports.f(), [2, 10, 15, 6, true, true, 107, 105], `O${optimize}`)
  if (onWasi()) return
  const host = `export class A { static k = 1; static m() { return this.k } static plain() { return 5 } static get g() { return this.k * 100 } }
    export class B extends A { static k = 2 }
    class C extends A { static k = 3 }
    export class D extends C {}`
  for (const optimize of levels(0, 2)) {
    const { A, B, D } = jz(host, { optimize }).exports
    is([A.m(), B.m(), B.plain(), B.k, B.g, D.m(), D.k, D.plain(), D.g], [1, 2, 5, 2, 200, 3, 3, 5, 300], `host O${optimize}`)
  }
})

// A derived class holds a static of its base that reads `this` as its own,
// made where the class is defined: a program storing another value into the
// base's is rejected, where JS would read the new one through the base.
test('a static a derived class takes as declared and the program stores again is rejected', () => {
  throws(() => jz(`class A { static k = 1; static m() { return this.k } }
    class B extends A { static k = 2 }
    const patch = () => { A.m = () => 10 }
    export let f = () => { patch(); return B.m() }`), /stores another value into it/)
  // a static that does not read `this` is the base's, read through it
  const src = `class A { static m() { return 1 } }
    class B extends A {}
    export let f = () => { const a = B.m(); A.m = () => 2; return [a, B.m()] }`
  for (const optimize of levels(0, 2)) is(jz(src, { optimize }).exports.f(), oracle(src).f(), `O${optimize}`)
})

// A getter named `type` on some class is no reason to dispatch `e.type` on a
// receiver the summary types as a literal's layout: the read stays a slot read.
test('a class accessor name does not make reads on other layouts dynamic', () => {
  const src = `class Node { constructor() { this.kind = 1 } get type() { return 'node' } }
export let other = () => new Node().type.length
const mk = (v) => ({ type: 'a', value: v })
export let main = (n) => { const evs = [mk(1), mk(2), mk(3)]; let s = 0; for (let i = 0; i < evs.length; i++) { const e = evs[i]; if (e.type === 'a') s += e.value } return s }`
  const w = compileWat(src, { wat: true, optimize: 'speed' })
  const main = w.slice(w.indexOf('(func $main'), w.indexOf('\n  (func $', w.indexOf('(func $main') + 5))
  ok(!/__dyn_get|dispatch|type__get/.test(main), 'literal-shaped reads stay slot reads')
  is(jz(src).exports.main(3), 6)
  is(jz(src).exports.other(), 4)
})

test("classes: `in` finds a class member on an instance, as through a prototype", () => {
  const src = `class A { constructor(){ this.x = 1 } get sampleRate(){ return 44100 } m(){ return 1 } } class B { constructor(){ this.y = 2 } }
    const objs = [new A(), new B(), { sampleRate: 1 }]
    export let f = (i) => { const o = objs[i]; return ('sampleRate' in o ? 1 : 0) + ('m' in o ? 2 : 0) + ('x' in o ? 4 : 0) + ('zz' in o ? 8 : 0) }`
  const { f } = jz(src).exports
  is([f(0), f(1), f(2)], [7, 0, 1])
})

test('classes: a class extending a class of another module keeps the schema lowering', () => {
  const modules = { './a.js': `export class A { constructor(sr){ this.sr = sr; this.buf = new Float32Array(4); for (let i = 0; i < 4; i++) this.buf[i] = i } get sampleRate(){ return this.sr } process(n){ let s = 0; for (let i = 0; i < n; i++) s += this.buf[i & 3] * this.sampleRate; return s } }` }
  const src = `import { A } from './a.js'
    class B extends A { constructor(){ super(10); this.gain = 0.5 } process(n){ return super.process(n) * this.gain } }
    export let f = (n) => new B().process(n) + new A(1).process(n)`
  const warnings = []
  // The whole-module pin needs DCE: opt0 retains unused generic dispatch helpers.
  // Runtime correctness below still follows the active matrix level.
  const wat = compileWat(src, { modules, warnings: w => warnings.push(w), wat: true, optimize: 2 })
  is(warnings.filter(e => e.code === 'class-generic').length, 0, 'both classes are schemas')
  ok(!/\$__dyn_get/.test(wat), 'the inherited method reads its fields as slots')
  is(jz(src, { modules }).exports.f(4), 6 * 10 * 0.5 + 6 * 1)
})

// A module iterates what another one mints: the program's iterator producers
// gate the protocol lowering for every module (jzify.witness), so a consumer
// without producers of its own drives a provider's iterator instead of
// indexing the instance.
test('classes: a for-of over an iterable class of another module drives its iterator', () => {
  const modules = { './list.js': `export class List { constructor() { this._ev = [] }
  [Symbol.iterator]() { return this._ev[Symbol.iterator]() } add(e) { this._ev.push(e) } }` }
  const src = `import { List } from './list.js'
    export let f = () => { const l = new List(); l.add(1); l.add(2); let s = 0; for (const e of l) s += e; return s * 10 + [...l].length }`
  is(jz(src, { modules }).exports.f(), 32)
})

// Accessors reach their holders through the receiver the summary names or
// the dispatcher's `instanceof` arms: a derived class's accessor is a
// function of its own schema, an object literal's a slot of its schema, a
// static pair a property of the class value. An unknown receiver probes for
// the slot only where a literal or a static pair may carry it.
test('classes: accessors of derived classes, literals and static pairs on receivers of every kind', () => {
  const derived = `class Ctx { #n; constructor(n) { this.#n = n } }
    class Off extends Ctx { get length() { return 7 } }
    export let union = (w) => { const o = w ? new Off(1) : new Ctx(2); return o.length }
    export let mixed = () => { const items = [new Off(1), 'ab', [1, 2, 3]]; let s = ''; for (const x of items) s += x.length + ','; return s }`
  const d = jz(derived, { optimize: 'speed' })
  is(d.exports.union(1), 7); is(d.exports.union(0), undefined); is(d.exports.mixed(), '7,2,3,')
  ok(!/call_indirect/.test(compileWat(derived, { wat: true, optimize: 'speed' })), 'no literal carries the slot: the unknown receiver reads plainly, without a probe')
  const literal = `export let get = () => { const items = [{ get x() { return 5 } }, { x: 2 }, { y: 1, get x() { return 9 } }]; let s = 0; for (const it of items) s = s * 10 + it.x; return s }
    export let set = () => { const items = [{ v: 0, set x(a) { this.v = a * 2 } }, { v: 0, x: 0 }]; let s = 0; for (const it of items) { it.x = 3; s = s * 10 + it.v } return s }`
  const l = jz(literal, { optimize: 'speed' })
  is(l.exports.get(), 529); is(l.exports.set(), 60)
  const stat = jz(`class K { static get tag() { return 42 } }\nexport let f = () => K.tag`, { optimize: 'speed' })
  is(stat.exports.f(), 42)
  const setter = jz(`class B { v = 0 }\nclass D extends B { set x(a) { this.v = a + 1 } }\nexport let f = (w) => { const o = w ? new D() : new B(); o.x = 5; return o.v }`, { optimize: 'speed' })
  is(setter.exports.f(1), 6); is(setter.exports.f(0), 0)
})

// `new` of a function that is no constructor throws a TypeError once the callee
// and the arguments are evaluated (ECMA-262 13.3.5.1.1), where it ran the
// function as a call; constructors construct, shadowed or reassigned names
// stay calls.
test('new: a callee that is no constructor throws a TypeError, a constructor constructs', () => {
  const cases = {
    arrow: `let A = () => 1; new A(log.push('arg'))`,
    arrowTop: `new Top()`,
    literal: `new (() => 1)()`,
    method: `const o = { m() { return 1 } }; new o.m(log.push('a'))`,
    methodAlias: `const o = { m() { return 1 } }; const M = o.m; new M()`,
    classMethod: `class C { m() { return 1 } }; const c = new C(); new c.m()`,
    classStatic: `class C { static s() { return 1 } static *g() {} }; new C.s()`,
    asyncFn: `async function af() { return 1 }; new af()`,
    asyncArrow: `const af = async () => 1; new af()`,
    generator: `function* g() { yield 1 }; new g()`,
    bound: `const A = () => 1; const B = A.bind(null); new B()`,
    spread: `const A = () => 1; const xs = [1, 2]; new A(...xs, log.push('after'))`,
    builtins: `for (const make of [() => new Math.max(), () => new Symbol(), () => new BigInt(1), () => new JSON.parse('1'), () => new Math]) try { make() } catch (e) { log.push(e instanceof TypeError) }`,
    classOk: `class C { constructor() { this.x = 1 } }; log.push(new C().x)`,
    functionOk: `function F() { return { a: 2 } }; log.push(new F().a)`,
    staticClassOk: `class C { static make = class { constructor() { this.y = 3 } } }; log.push(new C.make().y)`,
    shadowOk: `class A { constructor() { this.v = 6 } }; let B = A; { let A = () => 1; log.push(new B().v) }`,
    // (the census of assignments is the module's: any `R = …` keeps every `R` a call)
    reassignedOk: `let R = () => 1; R = class { constructor() { this.q = 7 } }; log.push(new R().q)`,
    writtenOk: `const o = { w() { return 1 } }; o.w = class { constructor() { this.r = 8 } }; log.push(new o.w().r)`,
    returnedOk: `class C { constructor() { return { m: function () { return { s: 9 } } } } m() { return 0 } }; const c = new C(); log.push(new c.m().s)`,
    shadowedMathOk: `const Math = { max: class { constructor() { this.k = 12 } } }; log.push(new Math.max().k)`,
  }
  const src = `const Top = (x) => x\n` + Object.entries(cases).map(([name, body]) =>
    `export let ${name} = () => { let log = []; try { ${body}; return 'ok:' + log.join() } catch (e) { return (e instanceof TypeError ? 'TypeError' : 'other') + ':' + log.join() } }`).join('\n')
  for (const optimize of levels(0, 2, 'size')) {
    const host = oracle(src), mod = jz(src, { optimize }).exports
    for (const name of Object.keys(cases)) is(mod[name](), host[name](), `${name} at ${optimize}`)
  }
})
