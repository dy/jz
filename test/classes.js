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
// `super.x` property semantics, non-constant computed member names.
import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import { onWasi, OPT_LEVEL } from './_matrix.js'
import jz from '../index.js'

const compile = (src) => jz(src, { jzify: true }).exports
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
test('rejects dynamic computed class fields', () => rejects(`let key = "x"; class A { [key] = 1 } export let run = () => 1`, /computed/))
test('rejects dynamic computed class methods', () => rejects(`let key = "x"; class A { [key]() { return 1 } } export let run = () => 1`, /computed/))

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
  try { jz.compile(`function P() { this.x = 1 }
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
  try { jz.compile(`function P() { this.x = 1 }
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

test('class struct: an instance holds its fields alone; a method is a function of the receiver', () => {
  const src = `export class P { constructor(x, y) { this.x = x; this.y = y } len() { return this.x * this.x + this.y * this.y } }
    export const f = (n) => { let s = 0; for (let i = 0; i < n; i++) { const p = new P(i, 2); s += p.len() } return s }`
  const { f, P } = jz(src).exports
  is(f(4), 30)
  is(jz(src + `\nexport const keys = () => Object.keys(new P(1, 2)).join()`).exports.keys(), 'x,y', 'no method slots')
  if (!onWasi()) is(JSON.stringify(P(3, 4)), '{"x":3,"y":4}', 'the host sees the fields alone')
  // level 2: below it the member's dispatcher, dead here, is not shaken
  if (OPT_LEVEL === 2) {
    ok(!/__dyn_get|__hash|__str_concat|__closure/.test(jz.compile(src, { wat: true })), 'a direct call: no dynamic read, no closure, no string path')
    ok(jz.compile(src).length < 1200, `the struct's size class (${jz.compile(src).length} B)`)
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

// A getter named `type` on some class is no reason to dispatch `e.type` on a
// receiver the summary types as a literal's layout: the read stays a slot read.
test('a class accessor name does not make reads on other layouts dynamic', () => {
  const src = `class Node { constructor() { this.kind = 1 } get type() { return 'node' } }
export let other = () => new Node().type.length
const mk = (v) => ({ type: 'a', value: v })
export let main = (n) => { const evs = [mk(1), mk(2), mk(3)]; let s = 0; for (let i = 0; i < evs.length; i++) { const e = evs[i]; if (e.type === 'a') s += e.value } return s }`
  const w = jz.compile(src, { wat: true, optimize: 'speed' })
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
  const warnings = { entries: [] }
  const wat = jz.compile(src, { modules, warnings, wat: true })
  is(warnings.entries.filter(e => e.code === 'class-generic').length, 0, 'both classes are schemas')
  ok(!/\$__dyn_get/.test(wat), 'the inherited method reads its fields as slots')
  is(jz(src, { modules }).exports.f(4), 6 * 10 * 0.5 + 6 * 1)
})
