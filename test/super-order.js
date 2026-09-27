// A derived constructor's statements before `super(…)` run before the base's
// constructor: they may compute the call's arguments, and their effects come
// first. The base's fields, the derived class's initializers and the rest of
// the body follow in that order (jzify/classes.js splitCtorSuper).
import test from 'tst'
import { levels } from './_matrix.js'
import { agree } from './util.js'

const each = (src, names, args, label) => {
  for (const optimize of levels(0, 2, 3, 'size')) for (const name of names) for (const a of args)
    agree(src, name, a, { optimize }, `${label}: ${name}(${a}) at ${optimize}`)
}

test('super order: arguments computed before the call', () => {
  const src = `class A { constructor(x) { this.x = x } }
class B extends A { constructor(o) { let v = o * 2; v += 1; super(v); this.y = v } }
class C extends A { constructor(o) { if (typeof o === 'object') o = o.n; super(o + 1); this.y = o } }
export let plain = (n) => { const b = new B(n); return b.x * 1000 + b.y }
export let fromObject = (n) => { const c = new C({ n }); return c.x * 1000 + c.y }
export let fromNumber = (n) => { const c = new C(n); return c.x * 1000 + c.y }`
  each(src, ['plain', 'fromObject', 'fromNumber'], [[5], [-2]], 'arguments')
})

test('super order: effects and a throw before the call', () => {
  const src = `let trace = ''
class D { constructor(x) { trace += 'D' + x; this.x = x } }
class E extends D { z = (trace += 'z', 1); constructor(x) { trace += 'E'; if (x < 0) throw new Error('neg'); super(x * 3); trace += 'e' + this.z } }
export let runs = (n) => { trace = ''; new E(n); return trace }
export let throws = (n) => { trace = ''; try { new E(-n - 1) } catch (e) { trace += '!' } return trace }`
  each(src, ['runs', 'throws'], [[5]], 'effects')
})

test('super order: a class declared in a function and a base that is an expression', () => {
  const src = `export let local = (n) => {
  let trace = ''
  class D { constructor(x) { trace += 'D' + x; this.x = x } }
  class E extends D { z = (trace += 'z', 1); constructor(x) { trace += 'E'; const k = x * 3; super(k); trace += 'e' + this.z } }
  const e = new E(n)
  return trace + e.x
}
const mk = (k) => class { constructor(x) { this.x = x + k } }
class F extends mk(10) { constructor(o) { const w = o + 1; super(w); this.y = w } }
export let expression = (n) => { const b = new F(n); return b.x * 1000 + b.y }`
  each(src, ['local', 'expression'], [[5]], 'lowered to closures')
})

test('super order: a field initializer reads what the base stored', () => {
  const src = `class G { constructor(x) { this.x = x } }
class H extends G { w = this.x + 7; constructor(o) { const q = o * 2; super(q); this.y = q + this.w } }
export let f = (n) => { const b = new H(n); return b.x * 1000000 + b.w * 1000 + b.y }`
  each(src, ['f'], [[5]], 'initializer')
})
