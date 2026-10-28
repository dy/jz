// A class the program exports reaches the host as a class: `new mod.C(...)`
// constructs, an instance's methods, getters and setters run in the module, its
// fields read and write the instance as it stands, and handed back to the
// module it is the instance itself. Each scenario drives the jz exports and
// the same program run as plain JS, and must observe the same.
import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import { inspect } from 'node:util'
import jz, { compile } from '../index.js'
import { levels, onWasi } from './_matrix.js'
import { oracle } from './util.js'

const agree = async (src, drive) => {
  const want = await drive(oracle(src))
  for (const optimize of levels(0, 2, 3, 'size')) is(await drive(jz(src, { optimize }).exports), want, `O${optimize}`)
}

const COUNTER = `
  export class Counter {
    static made = 0
    static of(n) { return new Counter(n) }
    #secret = 7
    constructor(start = 0) { this.count = start; this.log = []; Counter.made++ }
    get double() { return this.count * 2 }
    set double(v) { this.count = v / 2 }
    add(k = 1) { this.count += k; this.log.push(k); return this }
    label(...parts) { return parts.join('-') + ':' + this.count }
    async later(k) { await null; return this.count + k }
    peek() { return this.#secret }
  }
  export const total = (c) => c.count + c.log.length
  export const same = (c) => c
  export const keep = []
  export const hold = (c) => { keep.push(c); return keep.length }
  export const first = () => keep[0]
`

test('new of an exported class constructs; methods, accessors and statics run in the module', async () => {
  if (onWasi()) return
  await agree(COUNTER, async ({ Counter }) => {
    const c = new Counter(3)
    const out = [typeof Counter, c instanceof Counter, c.count, c.double]
    out.push(c.add(2) === c, c.count, c.log.slice(), c.label('a', 'b'), c.label(), await c.later(10), c.peek())
    c.double = 20
    out.push(c.count, c.double)
    c.count = 1
    out.push(c.add().count, Object.keys(c), JSON.stringify(c), '#secret' in c)
    out.push(Counter.of(5).count, Counter.of(5) instanceof Counter, Counter.made)
    try { Counter(1) } catch (e) { out.push(e instanceof TypeError) }
    return out
  })
})

test('an instance handed back to the module is the instance: its writes and its identity', async () => {
  if (onWasi()) return
  await agree(COUNTER, ({ Counter, total, same, hold, first }) => {
    const c = new Counter(4), d = new Counter(9)
    c.add(1).add(1)
    const out = [total(c), same(c) === c, hold(c), hold(d), first() === c, first().count]
    c.count = 100
    out.push(total(c), first().count)
    return out
  })
})

test('an exported base is the prototype of an exported derived class; an override dispatches by instance', async () => {
  if (onWasi()) return
  await agree(`
    export class Shape { constructor(n) { this.n = n } area() { return 0 } name() { return 'shape' + this.n } }
    export class Square extends Shape { constructor(s) { super(4); this.s = s } area() { return this.s * this.s } }
    class Hidden extends Shape { area() { return -1 } }
    export const hidden = () => new Hidden(2)
    export const areaOf = (x) => x.area()
  `, ({ Shape, Square, hidden, areaOf }) => {
    const sq = new Square(3), sh = new Shape(1), h = hidden()
    return [sq instanceof Square, sq instanceof Shape, sh instanceof Square, sq.area(), sq.name(), sh.area(), Shape.prototype.name.call(sq),
      h instanceof Shape, h.area(), h.name(), areaOf(sq), areaOf(h), Object.getPrototypeOf(Square) === Shape, Square.prototype.name === Shape.prototype.name]
  })
  // the module dispatches a method on the instance: a base's method taken
  // around an override is refused rather than answered with the override
  const { Shape, Square, hidden } = jz(`
    export class Shape { area() { return 0 } }
    export class Square extends Shape { area() { return 9 } }
    class Hidden extends Shape { area() { return -1 } }
    export const hidden = () => new Hidden()
  `).exports
  throws(() => Shape.prototype.area.call(new Square()), /overrides it/)
  throws(() => Shape.prototype.area.call(hidden()), /overrides it/)
})

test('the host prints an instance by its fields, and a member called on another object is a TypeError', () => {
  if (onWasi()) return
  const { Counter } = jz(COUNTER).exports
  const c = new Counter(2).add(3)
  is(inspect(c), inspect(new (oracle(COUNTER).Counter)(2).add(3)))
  throws(() => Counter.prototype.add.call({}), /not an instance of Counter/)
  // a member of the class is no export of its own
  ok(Object.keys(jz(COUNTER).exports).every(k => !//.test(k)), 'member exports stay out of the namespace')
})

test('without a JS host an exported class exports its factory alone', () => {
  const wat = compile(COUNTER, { host: 'wasi', wat: true })
  ok(!/jz:class/.test(wat), 'no class table under WASI')
})

// A static field is the class's own, written as it is read; a static getter
// and setter run the class's (the getter read undefined, the field had no setter).
test('a static field of an exported class reads and writes the class, its accessors run', async () => {
  if (onWasi()) return
  await agree(`export class C { static n = 1; static s = 'a'; static get g() { return C.n * 10 } static set g(v) { C.n = v / 10 }
      static get ro() { return 7 } static inc() { return ++C.n } }
    export const readN = () => C.n`, ({ C, readN }) => {
    const out = [C.n, C.s, C.g, C.ro]
    C.n = 5; out.push(C.n, readN())
    C.g = 90; out.push(C.n, readN(), C.g)
    try { C.ro = 1; out.push('assigned') } catch (e) { out.push(e.constructor.name) }
    out.push(C.inc(), C.n, Object.keys(C).join())
    return out
  })
})
