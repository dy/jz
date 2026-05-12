// `class` lowering (jzify): constructor + instance fields + methods + `new` + `this`.
// Classes are pure desugaring — an instance is a plain object, methods are
// per-instance arrows capturing it, `this` is renamed to that object, `new C(a)`
// becomes `C(a)`. No `extends`/`super`/`static`/getters/setters (rejected).
import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import jz from '../index.js'

const compile = (src) => jz(src, { jzify: true }).exports
const rejects = (src, re) => {
  let msg = null
  try { jz(src, { jzify: true }) } catch (e) { msg = e.message }
  ok(msg != null, `expected jzify to reject: ${src}`)
  ok(re.test(msg), `error ${JSON.stringify(msg)} should match ${re}`)
}

test('class: fields + constructor + method', () => {
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
  const { run } = compile(`
    class Counter { n = 10; inc() { this.n = this.n + 1; return this.n } }
    export let run = () => { let c = new Counter(); return c.inc() + c.inc() }
  `)
  is(run(), 23)   // 11 + 12
})

test('class method calling another method via this', () => {
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
  const { run } = compile(`
    class Box { val; set(x) { this.val = x } read() { return this.val } }
    export let run = () => { let b = new Box(); let before = b.read() === undefined ? 1 : 0; b.set(42); return before * 100 + b.read() }
  `)
  is(run(), 142)
})

test('field initializer referencing an earlier field via this', () => {
  const { run } = compile(`
    class A { x = 7; y = this.x * 3; getY() { return this.y } }
    export let run = () => new A().getY()
  `)
  is(run(), 21)
})

test('class expression', () => {
  const { run } = compile(`
    let Make = class { constructor(n){ this.n = n } twice(){ return this.n * 2 } }
    export let run = () => new Make(8).twice()
  `)
  is(run(), 16)
})

test('export class — factory exported, methods exercised inside jz', () => {
  const { run } = compile(`
    export class Adder { constructor(b){ this.b = b } plus(x){ return x + this.b } }
    export let run = () => { let a = new Adder(10); return a.plus(5) }
  `)
  is(run(), 15)
})

test('two instances are independent', () => {
  const { run } = compile(`
    class Cell { v = 0; set(x){ this.v = x } get(){ return this.v } }
    export let run = () => { let a = new Cell(); let b = new Cell(); a.set(3); b.set(9); return a.get() * 10 + b.get() }
  `)
  is(run(), 39)
})

test('polymorphic method dispatch over a mixed array', () => {
  const { run } = compile(`
    class Sq { constructor(s){ this.s = s } area(){ return this.s * this.s } }
    class Rect { constructor(w,h){ this.w = w; this.h = h } area(){ return this.w * this.h } }
    export let run = () => { let shapes = [new Sq(3), new Rect(2,5)]; return shapes[0].area() + shapes[1].area() }
  `)
  is(run(), 19)
})

test('private #field', () => {
  const { run } = compile(`
    class Secret { #v = 99; reveal() { return this.#v } bump() { this.#v = this.#v + 1; return this.#v } }
    export let run = () => { let s = new Secret(); return s.reveal() * 1000 + s.bump() }
  `)
  is(run(), 99100)
})

test('new without parentheses', () => {
  const { run } = compile(`
    class Zero { v = 0; val(){ return this.v } }
    export let run = () => (new Zero).val()
  `)
  is(run(), 0)
})

test('this inside a method-nested arrow refers to the instance', () => {
  const { run } = compile(`
    class Summer { base = 100; sumWith(xs) { return xs.reduce((acc, x) => acc + x + this.base, 0) } }
    export let run = () => new Summer().sumWith([1, 2, 3])
  `)
  is(run(), 306)   // (1+100) + (2+100) + (3+100)
})

test('rejects `extends`', () => rejects(`class B {} class A extends B {} export let run = () => 1`, /extends/))
test('rejects `static`', () => rejects(`class A { static n = 5 } export let run = () => 1`, /static/))
test('rejects getters', () => rejects(`class A { get x(){ return 1 } } export let run = () => 1`, /getter/))
test('rejects setters', () => rejects(`class A { set x(v){ } } export let run = () => 1`, /setter|accessor/))
