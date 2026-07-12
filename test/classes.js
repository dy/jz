// `class` lowering (jzify): constructor + instance fields + methods + `new` + `this`,
// plus `extends`, `super(…)`, `static` members, and private `#fields`.
// Classes are pure desugaring — an instance is a plain object, methods are
// per-instance arrows capturing it, `this` is renamed to that object, `new C(a)`
// becomes `C(a)`. Rejected: full `super.x` property semantics, getters/setters,
// non-constant computed member names.
import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import { onWasi } from './_matrix.js'
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
test('rejects getters', () => rejects(`class A { get x(){ return 1 } } export let run = () => 1`, /getter/))
test('rejects setters', () => rejects(`class A { set x(v){ } } export let run = () => 1`, /setter|accessor/))
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
