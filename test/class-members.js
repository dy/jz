/**
 * What JS keeps on a class's prototype, on a class lowered to a schema or to
 * closures (jzify/classes.js): an own property over a method of its name, a
 * member's own `arguments`, a store to the prototype, and `constructor`.
 * Every expectation is what Node computes for the same source (test/util.js
 * `agree`); three.js's math classes are written in these idioms.
 */
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { agree, funcWat, jz, compile } from './util.js'
import { levels } from './_matrix.js'

// Each row is [label, program]; the program's export `f` takes no argument.
const agrees = (rows) => { for (const [label, src] of rows) agree(src, 'f', [], undefined, label) }
const rejects = (src, re, label) => {
  let msg = null
  try { jz(src) } catch (e) { msg = e.message }
  ok(msg != null && re.test(msg), `${label}: ${msg == null ? 'compiled' : JSON.stringify(msg.slice(0, 80))}`)
}

test('class members: an own property stored under a method\'s name is called in its place', () => agrees([
  ['stored by a method, called by a setter', `class Q { constructor(x = 0) { this._x = x } set x(v) { this._x = v; this._onChangeCallback() } get x() { return this._x }
      _onChange(cb) { this._onChangeCallback = cb; return this } _onChangeCallback() {} }
    export const f = () => { const q = new Q(1); let n = 0; q._onChange(() => { n += 10 }); q.x = 3; return q.x + n }`],
  ['none stored: the method runs', `class Q { constructor(x = 0) { this._x = x; this.n = 0 } set x(v) { this._x = v; this._cb() } get x() { return this._x } _on(cb) { this._cb = cb; return this } _cb() { this.n += 1 } }
    export const f = () => { const q = new Q(1); q.x = 3; q.x = 4; return q.x + q.n }`],
  ['stored on one instance of two', `class Q { constructor() { this.n = 0 } hit() { this.cb() } on(cb) { this.cb = cb } cb() { this.n += 1 } }
    export const f = () => { const a = new Q(), b = new Q(); let k = 0; a.on(() => { k += 100 }); a.hit(); b.hit(); b.hit(); return k + a.n * 10 + b.n }`],
  ['stored from outside the class', `class Q { hit() { return this.cb() } cb() { return 1 } }
    export const f = () => { const a = new Q(), b = new Q(); a.cb = () => 50; return a.hit() + b.hit() }`],
  ['stored in the constructor', `class Q { constructor(g) { if (g) this.cb = g } cb() { return 1 } run() { return this.cb() } }
    export const f = () => new Q(() => 9).run() * 10 + new Q().run()`],
  ['read as a value', `class Q { on(cb) { this.cb = cb } cb() { return 1 } }
    export const f = () => { const a = new Q(), b = new Q(); a.on(() => 50); const g = a.cb, h = b.cb; return g() + h() }`],
  ['called with arguments, its result used', `class Q { on(cb) { this.cb = cb; return this } cb(a, b) { return a - b } run() { return this.cb(10, 3) } }
    export const f = () => new Q().on((a, b) => a * b).run() + new Q().run()`],
  ['inherited by a derived class', `class B { on(cb) { this.cb = cb; return this } cb() { return 1 } run() { return this.cb() } } class D extends B { extra() { return 5 } }
    export const f = () => new D().on(() => 30).run() + new D().run() + new D().extra()`],
  ['in a class declared inside a function', `export const f = () => { class Q { hit() { return this.cb() } on(cb) { this.cb = cb; return this } cb() { return 1 } } return new Q().on(() => 40).hit() + new Q().hit() }`],
  ['a field of the name in another class stays a field', `class A { constructor() { this.size = 3 } } class B { size() { return 5 } }
    export const f = () => new A().size * 10 + new B().size()`],
  // three.js Object3D: rotation and quaternion notify each other through `_onChange`
  ['two objects keeping each other in sync', `class E { constructor() { this._x = 0 } get x() { return this._x } set x(v) { this._x = v; this._onChangeCallback() } _onChange(cb) { this._onChangeCallback = cb; return this } _onChangeCallback() {} }
    class O { constructor() { const rotation = new E(), quaternion = new E()
      function onR() { quaternion._x = rotation._x * 2 } function onQ() { rotation._x = quaternion._x / 2 }
      rotation._onChange(onR); quaternion._onChange(onQ); this.rotation = rotation; this.quaternion = quaternion } }
    export const f = () => { const o = new O(); o.rotation.x = 4; const a = o.quaternion.x; o.quaternion.x = 3; return a * 10 + o.rotation.x }`],
]))

test('class members: a member has `arguments` of its own', () => agrees([
  ['arguments.length in a method', `class V { constructor(x = 0) { this.x = x } set(x, y) { if (arguments.length === 1) y = 5; this.x = x + y; return this } }
    export const f = () => new V(7).set(1).x * 100 + new V(7).set(1, 2).x`],
  // three.js Object3D.add
  ['a variadic method through arguments', `class O { constructor() { this.children = [] } add(object) { if (arguments.length > 1) { for (let i = 0; i < arguments.length; i++) this.add(arguments[i]); return this } this.children.push(object); return this } }
    export const f = () => { const o = new O(); o.add(1, 2, 3); o.add(4); return o.children.length * 10 + o.children[2] }`],
  ['in a constructor', `class V { constructor(x, y) { this.n = arguments.length; this.x = x } } export const f = () => new V(1).n * 10 + new V(1, 2, 3).n`],
  ['in a derived constructor, spread to super', `class B { constructor(a, b) { this.s = a + b } } class D extends B { constructor() { super(...arguments); this.n = arguments.length } }
    export const f = () => { const d = new D(3, 4); return d.s * 10 + d.n }`],
  ['in a static method', `class V { static count() { return arguments.length } } export const f = () => V.count(1, 2, 3) * 10 + V.count()`],
  ['in a setter', `class V { constructor() { this._v = 0 } set v(x) { this._v = x + arguments.length } get v() { return this._v } } export const f = () => { const v = new V(); v.v = 4; return v.v }`],
  ['in an arrow inside a method', `class V { m(a, b) { const g = () => arguments.length + arguments[1]; return g() } } export const f = () => new V().m(1, 20)`],
  ['beside a default parameter', `class V { m(a, b = 10) { return a + b + arguments.length } } export const f = () => new V().m(1) * 100 + new V().m(1, 2)`],
  ['in a method read as a value', `class V { m() { return arguments.length } } export const f = () => { const g = new V().m; return g(1, 2) }`],
  ['in a class declared inside a function', `export const f = () => { class V { m() { return arguments.length } } return new V().m(1, 2, 3) }`],
  ['in an object literal\'s method', `const o = { k: 2, m() { return arguments.length * this.k } }; export const f = () => o.m(1, 2, 3)`],
]))

// three.js Euler.set(x, y, z, order = this._order), ColorManagement's methods
test('class members: a parameter\'s default reads the receiver', () => agrees([
  ['a method', `class E { constructor() { this._order = 'XYZ'; this._x = 0 } set(x, order = this._order) { this._x = x; this._order = order; return this } }
    export const f = () => { const e = new E().set(2); return e._x + e._order.length * 10 + new E().set(1, 'ZY')._order.length * 100 }`],
  ['after a plain default, before one reading it', `class V { constructor() { this.k = 3 } m(a = 1, b = this.k, c = b * 2) { return a + b * 10 + c * 100 } }
    export const f = () => new V().m() + new V().m(2, 4) * 1000`],
  ['through a getter', `class V { constructor() { this.k = 2 } get d() { return this.k * 2 } m(a = this.d) { return a } } export const f = () => new V().m() * 10 + new V().m(1)`],
  ['a static method: the class', `class V { static k = 4; static m(a = this.k) { return a } } export const f = () => V.m() * 10 + V.m(2)`],
  ['a class declared inside a function', `export const f = () => { class E { constructor() { this.o = 7 } set(x, o = this.o) { return x + o } } return new E().set(1) * 10 + new E().set(1, 2) }`],
  ['an object\'s function property', `const C = { w: 3, g: function (t, c = this.w) { return t + c } }; export const f = () => C.g(1) * 10 + C.g(1, 5)`],
  ['an object\'s method, with a default after it', `const C = { w: 3, g(t, c = this.w, d = c + 1) { return t + c * 10 + d * 100 } }; export const f = () => C.g(1) + C.g(1, 5) * 1000`],
  ['an object\'s method whose body is one expression statement', `const o = { k: 5, n: 0, m(a = this.k) { a } }; export const f = () => o.m() === undefined ? 1 : 0`],
  ['an object\'s method with an empty body', `const o = { k: 5, m(a = this.k) {} }; export const f = () => o.m() === undefined ? 1 : 0`],
]))

test('class members: a store to the class\'s prototype names a member', () => agrees([
  // three.js r186: `static { Vector3.prototype.isVector3 = true }`
  ['a flag in a static block', `class V { static { V.prototype.isV = true } constructor(x = 0) { this.x = x } } export const f = () => { const v = new V(2); return v.isV ? v.x : -1 }`],
  ['through `this` in a static block', `class V { static { this.prototype.isV = true } } export const f = () => new V().isV === true ? 1 : 0`],
  ['a flag never read', `class V { static { V.prototype.isV = true } constructor(x = 0) { this.x = x } } export const f = () => new V(2).x`],
  // three.js before r180: the statement after the class
  ['a flag in the statement after the class', `class V { constructor(x = 0) { this.x = x } }\nV.prototype.isV = true\nexport const f = () => new V(2).isV ? 1 : 0`],
  ['read on instances of two classes', `class V { static { V.prototype.isV = true } constructor() { this.x = 1 } } class Q { constructor() { this.w = 1 } }
    const is = o => o.isV === true ? 1 : 0; export const f = () => is(new V()) * 10 + is(new Q())`],
  // three.js Matrix4.setPosition(x, y, z): a vector or three numbers. The method
  // is cloned per argument kind (narrow/specialize.js); the clone keeps the
  // origin's pointer result (variant.js), read here through the chained `.e[i]`.
  ['read on a number by many callers and an instance by one, chained', `class V { static { V.prototype.isVector3 = true } constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z } }
    class M { constructor() { this.e = [0, 0, 0] } setPosition(x, y, z) { const te = this.e; if (x.isVector3) { te[0] = x.x; te[1] = x.y; te[2] = x.z } else { te[0] = x; te[1] = y; te[2] = z } return this } }
    export const f = () => new M().setPosition(new V(1, 2, 3)).e[2] * 10 + ${Array.from({ length: 10 }, (_, i) => `new M().setPosition(${i}, 5, 6).e[1]`).join(' + ')}`],
  ['read on an instance or a number', `class V { static { V.prototype.isVector3 = true } constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z } }
    class M { constructor() { this.e = [0, 0, 0] } setPosition(x, y, z) { const te = this.e; if (x.isVector3) { te[0] = x.x; te[1] = x.y; te[2] = x.z } else { te[0] = x; te[1] = y; te[2] = z } return this } }
    export const f = () => new M().setPosition(new V(1, 2, 3)).e[2] * 10 + new M().setPosition(4, 5, 6).e[1]`],
  ['inherited by a derived class', `class B { static { B.prototype.isB = true } } class D extends B { constructor() { super(); this.k = 1 } } export const f = () => new D().isB ? 1 : 0`],
  ['no own key of the instance', `class V { static { V.prototype.isV = true } constructor() { this.x = 1 } } export const f = () => Object.keys(new V()).join(',')`],
  ['found by `in`', `class V { static { V.prototype.isV = true } } export const f = () => ('isV' in new V()) ? 1 : 0`],
  ['shadowed by a store on the instance', `class V { static { V.prototype.k = 1 } constructor() { this.x = 1 } } export const f = () => { const a = new V(), b = new V(); a.k = 5; return a.k * 10 + b.k }`],
  ['a number and a string', `class V { static { V.prototype.n = 7; V.prototype.s = 'ab' } } export const f = () => new V().n + new V().s.length`],
  ['a computed value', `let n = 3\nclass V { static { V.prototype.k = n * 2 } }\nexport const f = () => new V().k`],
  ['a computed value stored later', `let n = 4\nclass V { constructor() { this.x = 1 } }\nconst a = new V()\nconst before = a.k === undefined ? 1 : 0\nV.prototype.k = n * 2\nexport const f = () => before * 100 + a.k`],
  ['stored twice', `class V {}\nV.prototype.k = 1\nV.prototype.k = 2\nexport const f = () => new V().k`],
  ['an array every instance shares', `class V { static { V.prototype.list = [] } add(x) { this.list.push(x); return this } } export const f = () => { new V().add(1); return new V().add(2).list.length }`],
  ['a method by assignment', `class V { constructor(x) { this.x = x } }\nV.prototype.twice = function () { return this.x * 2 }\nexport const f = () => new V(4).twice()`],
  ['a method in a static block', `class V { static { V.prototype.twice = function () { return this.x * 2 } } constructor(x) { this.x = x } } export const f = () => new V(4).twice()`],
  ['a method over the class\'s own', `class V { k() { return 1 } }\nV.prototype.k = function () { return 2 }\nexport const f = () => new V().k()`],
  ['Object.assign of methods and a flag', `class V { constructor(x) { this.x = x } }\nObject.assign(V.prototype, { isV: true, twice: function () { return this.x * 2 }, thrice() { return this.x * 3 } })\nexport const f = () => { const v = new V(2); return v.isV ? v.twice() + v.thrice() : -1 }`],
  ['on an exported class', `export class V { static { V.prototype.isV = true } constructor() { this.x = 3 } }\nexport const f = () => new V().isV ? 1 : 0`],
  ['in a class declared inside a function', `export const f = () => { class V { static { V.prototype.isV = true } constructor() { this.x = 3 } } const v = new V(); return v.isV ? v.x : -1 }`],
]))

// three.js: Vector3 stores `this.x` beside Quaternion's `set x(v)`.
test('class members: a field stored under another class\'s accessor name keeps its slot', () => {
  const src = `class Q { constructor() { this._x = 0 } get x() { return this._x } set x(v) { this._x = v * 2 } }
    class V { constructor(x = 0, y = 0) { this.x = x; this.y = y } min(v) { this.x = Math.min(this.x, v.x); this.y = Math.min(this.y, v.y); return this } fromArray(a, o = 0) { this.x = a[o]; this.y = a[o + 1]; return this } }
    class B { constructor() { this.min = new V(9, 9) } expand(v) { this.min.min(v); return this } }
    const w = new V(1, 2), a = new Float32Array([5, 6, 7])
    export const f = () => { const v = new V().fromArray(a, 1); v.min(w); const q = new Q(); q.x = 4; const b = new B().expand(v); return v.x * 100 + v.y * 10 + q.x + b.min.x * 1000 }`
  agrees([['a field under an accessor name', src]])
  const w = compile(src, { wat: true, optimize: 2 }), at = w.indexOf('(func $f\n'), body = w.slice(at, w.indexOf('\n  )\n', at))
  is((body.match(/__hash_set/g) || []).length, 0, 'every store of f is a slot store')
})

// A class that assigns to a name through `this` has a slot of the name in its layout, and a
// setter of the name, its own or a derived class's, takes the assignment all the same: the
// instance never holds the property. A store or a read through a receiver the plan cannot
// turn into a call of the accessor (two classes, a base's method on a derived instance) runs
// the accessor, and what its body does counts: here it grows an array past the literal's four.
test('class members: an accessor runs under a name the class also assigns to', () => {
  const B = `class B { constructor() { this.n = 0 } set at(i) { this.n = i } get at() { return this.n } }`
  const pick = `const pick = (k) => k ? new A() : new B()`
  const rows = [
    ['a setter that grows an array, stored through a receiver of two classes', `class A { constructor() { this.v = [0, 0, 0, 0] } set at(i) { this.v[i] = 7 } go() { this.at = 1; return this.v.length } }\n${B}\n${pick}
      export const run = (k) => { const a = new A(), o = pick(k); const n = a.go(); o.at = 9; return n * 100 + (k ? o.v.length * 10 + (o.v[9] === 7 ? 1 : 0) : o.n) }`],
    ['the same setter with no slot under its name', `class A { constructor() { this.v = [0, 0, 0, 0] } set at(i) { this.v[i] = 7 } }\n${B}\n${pick}
      export const run = (k) => { const o = pick(k); o.at = 9; return k ? o.v.length * 10 + (o.v[9] === 7 ? 1 : 0) : o.n }`],
    ['a derived class\'s setter under a name its base assigns to', `class P { constructor() { this.v = [0, 0, 0, 0] } go(i) { this.at = i; return this.v.length } }
      class D extends P { set at(i) { this.v[i] = 7 } }
      export const run = (k) => { const p = new P(), d = new D(); const n = p.go(2) + d.go(k + 8); return n * 100 + d.v.length * 10 + (d.v[9] === 7 ? 1 : 0) + (p.at === 2 ? 1000 : 0) }`],
    ['a derived class\'s getter under a name its base reads', `class P { constructor() { this.v = [0, 0, 0, 0] } put(i) { this.at = i } get() { return this.at } }
      class D extends P { get at() { this.v[9] = 7; return 'd' } set at(i) { this.v[0] = i } }
      export const run = (k) => { const p = new P(), d = new D(); p.put(3); d.put(k + 5); const x = p.get(), y = d.get(); return '' + x + y + d.v.length + (d.v[9] === 7 ? 'y' : 'n') + d.v[0] }`],
    ['a getter that counts its reads, through a receiver of two classes', `class A { constructor() { this.n = 0 } get at() { this.n += 1; return this.n } set at(i) { this.n = i } go() { this.at = 10; return 0 } }
      class B { constructor() { this.n = 0 } get at() { this.n += 2; return this.n } set at(i) { this.n = i } }\n${pick}
      export const run = (k) => { const a = new A(), o = pick(k); a.go(); o.at = 20; const x = o.at + o.at; return x * 100 + o.n }`],
    ['a compound store, read by the getter and stored by the setter', `class A { constructor() { this.n = 0 } get at() { return this.n * 2 } set at(i) { this.n = i + 1 } go() { this.at = 3; return 0 } }
      export const run = (k) => { const a = new A(); a.go(); a.at += k; a.at++; return a.n * 10 + a.at }`],
  ]
  for (const [label, src] of rows) for (const optimize of levels(0, 1, 2, 3, 'size', 'speed')) for (const k of [0, 1]) agree(src, 'run', [k], { optimize }, `${label}, run(${k}) at ${optimize}`)
})

test('class members: a compound store through a spliced receiver keeps its class', () => {
  // `target.copy(o).addScaledVector(d, t)` splices into the loop; addScaledVector's `this.x += …`
  // stages its receiver in a temp, and the temp keeps the class: no accessor probe, no hash store
  const src = `class V { constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z }
      copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this }
      addScaledVector(v, s) { this.x += v.x * s; this.y += v.y * s; this.z += v.z * s; return this } }
    class Q { constructor() { this._x = 0 } get x() { return this._x } set x(v) { this._x = v } }
    class R { constructor() { this.origin = new V(1, 2, 3); this.direction = new V(0, 0, 1) }
      at(t, target) { return target.copy(this.origin).addScaledVector(this.direction, t) }
      hitAt(t, target) { if (t < 0) return null; return this.at(t, target) } }
    export const f = (n) => { const r = new R(), hit = new V(), q = new Q(); q.x = 2; let acc = q.x
      for (let i = 0; i < n; i++) { if (r.hitAt(i - 2, hit) !== null) acc += hit.z }
      return acc }`
  agree(src, 'f', [7], undefined, 'the compound stores land')
  const w = compile(src, { wat: true, optimize: 2 }), at = w.indexOf('(func $f\n'), body = w.slice(at, w.indexOf('\n  )\n', at))
  is((body.match(/dispatch|__hash_set|__dyn_set|__add_slow/g) || []).length, 0, 'the stores of f are slot stores, the adds numeric')
})

// At the speed tier a method called on a receiver that may be missing takes the receiver past its
// test (plan/scope.js devirtClassCalls), and a spliced getter leaves its read on that test, a call:
// the read is the receiver's own (settleTestedReceivers), a slot load by its class, where it was a
// lookup by name whose sum went through `__add_slow` and a string concatenation.
test('class members: a getter and a setter spliced over a receiver that may be missing read and store by its class', () => {
  const cls = `class P { constructor(x, y) { this.x = x; this.y = y } getX() { return this.x } getY() { return this.y } setX(v) { this.x = v } bump() { this.y += 1 } pick() { return this[sel()] } }
    let picked = 0
    const sel = () => { picked++; return 'x' }`
  const src = `${cls}
    const ps = []; for (let i = 0; i < 64; i++) ps.push(new P(i * 0.5, i + 1))
    export const f = (n) => { let s = 0
      for (let r = 0; r < n; r++) for (let i = 0; i < ps.length; i++) { const p = ps[i]; p.setX(p.getX() + p.getY()); p.bump(); s += p.getX() + 2 * p.getY() }
      return s }`
  // a loop that runs past the array reads a missing receiver: the read's TypeError, a setter's before its argument runs
  const missing = `${cls}
    const qs = []; for (let i = 0; i < 4; i++) qs.push(new P(i + 1, i + 2))
    let ran = 0
    const arg = () => { ran++; return 5 }
    const read = (n) => { let s = 0; for (let k = 0; k < n; k++) { const p = qs[k]; s += p.getX() + 2 * p.getY() + p.pick() } return s }
    const write = (n) => { let s = 0; for (let k = 0; k < n; k++) { const p = qs[k]; p.setX(arg()); p.bump(); s += p.getY() } return s }
    export const f = (n) => { let a = 0, b = 0
      try { a = read(n) } catch (e) { a = e instanceof TypeError ? -1 : -2 }
      try { b = write(n) } catch (e) { b = e instanceof TypeError ? -10 : -20 }
      return a + 1000 * b + 1000000 * ran + 100000000 * picked }`
  for (const optimize of levels(0, 2, 3, 'size', 'speed')) {
    agree(src, 'f', [3], { optimize }, `the getters and the setter at ${optimize}`)
    for (const n of [3, 4, 6]) agree(missing, 'f', [n], { optimize }, `${n} of four receivers at ${optimize}`)
  }
  for (const optimize of levels(3, 'speed')) {
    const w = compile(src, { wat: true, optimize })
    is((w.match(/call \$__(dyn_get|dyn_set|add_slow|str_concat|hash_set)\w*/g) || []).join(' '), '', `no lookup by name and no untyped sum at ${optimize}`)
  }
})

// A receiver the summary names several classes for, an override among them, is one of those classes
// and no other value (emit/class-dispatch.js closedArms): a compare of its schema id per function and
// the class's function called directly, where it took the dispatcher of every class of the program,
// whose last arm looks the member up by name and may allocate.
test('class members: an override among the receiver\'s classes is a test per function, with no lookup by name', () => {
  const src = `let log = ''
    const note = (s) => { log += s; return s.length }
    class A { constructor(v) { this.v = v } area() { return this.v * 2 } name() { return 'A' } get twice() { return this.v * 2 } set twice(x) { this.v = x / 2 }
      scale(k, m) { this.v = this.v * k + m; return this } tag() { return this.v > 2 } }
    class B extends A { area() { return this.v * 3 } name() { return 'B' } get twice() { return this.v * 20 } set twice(x) { this.v = x / 20 } tag() { return 'b' + this.v } }
    class C extends A { name() { return 'C' } scale(k, m) { this.v = this.v + k - m; return this } }
    class D extends B { area() { return super.area() + 1 } tag() { return this.v } }
    class U { constructor(v) { this.w = v } area() { return this.w + 100 } name() { return 'U' } }
    const mk = (i) => i % 4 === 0 ? new A(i + 1) : i % 4 === 1 ? new B(i + 1) : i % 4 === 2 ? new C(i + 1) : new D(i + 1)
    const xs = []; for (let i = 0; i < 12; i++) xs.push(mk(i))
    const ys = []; for (let i = 0; i < 8; i++) ys.push(i & 1 ? new U(i) : new A(i))
    const pair = []; for (let i = 0; i < 6; i++) pair.push(i % 3 === 0 ? new B(i) : new D(i))
    export const f = (n) => { let s = 0, names = ''
      for (let i = 0; i < xs.length; i++) { const x = xs[i]; s += x.area(); names += x.name() }
      for (let i = 0; i < ys.length; i++) { s += ys[i].area() * 1000; names += ys[i].name() }
      for (let i = 0; i < pair.length; i++) { const p = pair[i]; s += p.area() * 7 + p.twice; p.twice = p.twice + 20; s += p.v; names += typeof p.tag() + p.tag() }
      for (let i = 0; i < xs.length; i++) { const x = xs[i]; x.scale(note('k' + i), note('m')); s += x.v + x.twice }
      for (let i = 0; i < xs.length; i++) names += typeof xs[i].tag()
      let threw = ''
      try { for (let i = 0; i < n; i++) s += xs[xs.length - 2 + i].scale(note('!'), 1).v } catch (e) { threw = e instanceof TypeError ? 'TypeError' : 'other' }
      try { for (let i = 0; i < n; i++) s += pair[pair.length - 2 + i].area() } catch (e) { threw += e instanceof TypeError ? '+TypeError' : '+other' }
      const g = xs[n % xs.length].area, h = ys[n % ys.length].name
      return s + '|' + names + '|' + log.length + log.slice(-6) + '|' + threw + '|' + typeof g + typeof h }`
  // (a receiver past the array's end throws the read's TypeError before the arguments run: n = 4)
  for (const optimize of levels(0, 2, 3, 'size', 'speed')) for (const n of [1, 2, 4]) agree(src, 'f', [n], { optimize }, `five classes, ${n}, at ${optimize}`)
  const two = `class P { constructor(x, y) { this.x = x; this.y = y } weigh() { return this.x + 2 * this.y } move() { this.x += this.y } }
    class Q extends P { weigh() { return 2 * this.y + this.x + 1 } move() { this.y += this.x } }
    const ps = []; for (let i = 0; i < 64; i++) ps.push(i & 1 ? new Q(i * 0.5, i + 1) : new P(i * 0.5, i + 1))
    export const f = (n) => { let s = 0
      for (let r = 0; r < n; r++) for (let i = 0; i < ps.length; i++) { const p = ps[i]; p.move(); s += p.weigh() }
      return s }`
  for (const optimize of levels(0, 2, 3, 'size', 'speed')) agree(two, 'f', [3], { optimize }, `two classes at ${optimize}`)
  // A BigInt each class's function returns in its raw word joins as one; through the dispatcher
  // (a class of the receiver without the member) it comes back boxed, and its reader takes the
  // word: read raw, the sum was of the boxes' pointers (36028797018964128 read -12384898975253024).
  const big = `class A { constructor(v) { this.v = v } big() { return 9007199254740993n + BigInt(this.v) } get wide() { return 9007199254740993n + BigInt(this.v) } mix() { return this.v } }
    class B extends A { big() { return 7n * BigInt(this.v) } get wide() { return 7n * BigInt(this.v) } mix() { return BigInt(this.v) + 1n } }
    class U { constructor(v) { this.v = -v } }
    const xs = [], ys = []
    for (let i = 0; i < 8; i++) { xs.push(i & 1 ? new B(i + 1) : new A(i + 1)); ys.push(i & 1 ? new U(i + 1) : new A(i + 1)) }
    export const f = (n) => { let t = 0n, u = 0n, w = 0n, s = ''
      for (let i = 0; i < xs.length; i++) { const x = xs[i]; t += x.big() * BigInt(n); w += x.wide; s += typeof x.mix() + String(x.mix()) }
      for (let i = 0; i < ys.length; i++) { const y = ys[i]; if (y.v > 0) u += y.big() * BigInt(n) }
      return String(t) + '|' + String(u) + '|' + String(w) + '|' + s }`
  for (const optimize of levels(0, 2, 3, 'size', 'speed')) agree(big, 'f', [3], { optimize }, `BigInt results at ${optimize}`)
  // an own property stored under the member's name shadows it on the instance that stores one
  const own = `class A { constructor(v) { this.v = v } area() { return this.v * 2 } }
    class B extends A { area() { return this.v * 3 } }
    const xs = []; for (let i = 0; i < 6; i++) xs.push(i & 1 ? new B(i + 1) : new A(i + 1))
    xs[2].area = () => -5
    xs[3].area = () => -7
    export const f = () => { let s = 0; for (let i = 0; i < xs.length; i++) s = s * 10 + xs[i].area(); return s }`
  for (const optimize of levels(0, 2, 3, 'size', 'speed')) agree(own, 'f', [], { optimize }, `an own property over the member at ${optimize}`)
  // a Boolean each class's function returns, to every reader of one; a call with a spread and with
  // fewer and more arguments than parameters; a receiver with an effect, run once; an accessor read
  // and stored on a missing receiver
  const more = `class A { constructor(v) { this.v = v } ok() { return this.v > 2 } get on() { return this.v > 2 } set on(x) { this.v = x ? 9 : 0 }
      scale(k, m) { return this.v * k + (m === undefined ? 100 : m) } }
    class B extends A { ok() { return this.v < 2 } get on() { return this.v < 2 } set on(x) { this.v = x ? 0 : 9 } scale(k, m) { return this.v + k - (m === undefined ? 100 : m) } }
    class U { constructor(v) { this.v = -v } }
    const xs = [], ys = []
    for (let i = 0; i < 6; i++) { xs.push(i & 1 ? new B(i) : new A(i)); ys.push(i & 1 ? new U(i + 1) : new A(i + 1)) }
    let ran = 0, picks = 0
    const arg = () => { ran++; return true }
    const pick = (i) => { picks++; return xs[i] }
    export const f = (n) => { let s = '', c = 0, kept = []
      const pair = [n, 3], three = [n, 3, 9]
      for (let i = 0; i < xs.length; i++) c += pick(i).scale(3) + (pick(i).on ? 1 : 0)
      for (let i = 0; i < xs.length; i++) { const x = xs[i]
        if (x.ok()) c += 1
        if (x.ok() === true) c += 10
        if (x.on) c += 100
        c += x.ok() + 1000 * (x.on ? 1 : 0) + x.scale(2) + x.scale(2, 1, 77) + x.scale(...pair) + x.scale(...three)
        s += typeof x.ok() + String(x.ok()) + (x.on === false ? 'f' : 't')
        kept.push(x.ok(), x.on) }
      for (let i = 0; i < ys.length; i++) { const y = ys[i]; if (y.v > 0) { if (y.ok()) c += 100000; s += String(y.ok()) + (y.ok() === false); kept.push(y.ok()) } }
      let threw = ''
      try { for (let i = 0; i < n; i++) c += xs[xs.length - 2 + i].on ? 7 : 5 } catch (e) { threw += e instanceof TypeError ? 'R' : 'r' }
      try { for (let i = 0; i < n; i++) xs[xs.length - 2 + i].on = arg() } catch (e) { threw += e instanceof TypeError ? 'W' : 'w' }
      return c + '|' + s + '|' + JSON.stringify(kept) + '|' + threw + ran + '|' + xs[xs.length - 1].v + '|' + picks }`
  for (const optimize of levels(0, 2, 3, 'size', 'speed')) for (const n of [1, 4]) agree(more, 'f', [n], { optimize }, `Booleans, argument counts and a missing receiver's accessor, ${n}, at ${optimize}`)
  // (where the module keeps only what its program reaches: the runtime that looks a member up by name is not in it)
  for (const optimize of levels(2, 3, 'size', 'speed')) {
    const w = compile(two, { wat: true, optimize })
    is((w.match(/call \$__(ext_method|ext_invoke|dyn_get_expr)\w*|call_indirect/g) || []).join(' '), '', `no lookup by name and no indirect call at ${optimize}`)
  }
})

// A field every constructor sets to one function of the module, or a property every literal of a
// shape gives it, holds that function wherever it is read (the summary's heldCallee): the call
// through it is the call of the function, past the test the member read makes of its receiver
// (plan/scope.js devirtHeldCalls), where it was an indirect call through the closure ABI. A field
// of two functions, one a later store replaces, a closure with an environment and a field read
// before its constructor stores it keep the call they had.
test('class members: a call through a field that holds one function for good is the call of that function', () => {
  const src = `let log = ''
    const note = (s) => { log += s; return s.length }
    const double = (p, k) => p.v * 2 + (k | 0)
    const triple = (p, k) => p.v * 3 + (k | 0)
    const early = []
    class One { constructor(v) { this.v = v; this.f = double } }
    class Two { constructor(v) { this.v = v; this.f = v & 1 ? double : triple } }
    class Late { constructor(v) { this.v = v; this.f = double } }
    class Env { constructor(v, bias) { this.v = v; this.f = (p, k) => p.v + bias + (k | 0) } }
    class Seen { constructor(v) { this.v = v; early.push(this); if (v === 3) { try { log += early[early.length - 1].f(this) } catch (e) { log += e instanceof TypeError ? 'T' : 'o' } } this.f = triple } }
    const ones = [], twos = [], lates = [], envs = [], seens = []
    for (let i = 0; i < 6; i++) { ones.push(new One(i + 1)); twos.push(new Two(i + 1)); lates.push(new Late(i + 1)); envs.push(new Env(i + 1, i * 10)); seens.push(new Seen(i + 1)) }
    lates[3].f = triple
    export const f = (n) => { let s = 0
      for (let i = 0; i < ones.length; i++) { const p = ones[i]; s += p.f(p, note('a')) }
      for (let i = 0; i < twos.length; i++) s += twos[i].f(twos[i], 1) * 10
      for (let i = 0; i < lates.length; i++) { const p = lates[i]; s += p.f(p) * 100 }
      for (let i = 0; i < envs.length; i++) { const p = envs[i]; s += p.f(p, 2) * 1000 }
      for (let i = 0; i < seens.length; i++) s += seens[i].f(seens[i]) * 7
      let threw = ''
      try { for (let i = 0; i < n; i++) { const p = ones[ones.length - 2 + i]; s += p.f(p, note('!')) } } catch (e) { threw = e instanceof TypeError ? 'TypeError' : 'other' }
      const fresh = new One(n)
      return s + '|' + log.length + log.slice(-3) + '|' + threw + '|' + fresh.f(fresh, 5) + '|' + (typeof ones[0].f) + (ones[0].f === double) + (lates[3].f === triple) }`
  for (const optimize of levels(0, 2, 3, 'size', 'speed')) for (const n of [1, 2, 4]) agree(src, 'f', [n], { optimize }, `the held functions, ${n}, at ${optimize}`)
  // object literals: a property that holds a function of the module, beside a method that reads `this`
  const lit = `const inc = (x) => x + 1
    const o = { w: 3, h: 4, m() { return this.w + this.h }, arrow: (x) => x + 1, inc, grow(k) { this.w += k; return this } }
    const api = { twice: (x) => x * 2, inc, name: 'api' }
    const mk = (w) => ({ w, m() { return this.w * 2 }, inc })
    const os = []; for (let i = 0; i < 4; i++) os.push(mk(i + 1))
    export const f = (n) => { let s = o.m() + 1000 * o.arrow(n) + api.twice(n) + 7 * api.inc(n) + o.inc(n) + o.grow(n).m()
      for (let i = 0; i < os.length; i++) { const q = os[i]; s += q.m() * 100 + q.inc(i) }
      let threw = 0
      try { for (let i = 0; i < n; i++) s += os[os.length - 1 + i].inc(i) } catch (e) { threw = e instanceof TypeError ? 1 : 2 }
      return s + threw * 0.5 }`
  for (const optimize of levels(0, 2, 3, 'size', 'speed')) for (const n of [1, 5]) agree(lit, 'f', [n], { optimize }, `object literals, ${n}, at ${optimize}`)
  // what is no slot holding one function: a getter that answers it (the getter runs), alone and as
  // one shape of a receiver whose other shape holds the function, a field that is the function or
  // null, a slot a computed key deletes; and a held call's spread, its argument counts, and its
  // receiver's effect, run once
  const not = `let reads = 0
    const add = (a, b) => (a | 0) + (b | 0)
    const double = (p) => p.v * 2
    const o = { get f() { reads += 10; return add }, v: 1 }
    class H { constructor(v) { this.v = v; this.f = add } }
    class O { constructor(v) { this.v = v; this.f = v & 1 ? double : null } }
    const hs = [], os = []
    for (let i = 0; i < 4; i++) { hs.push(new H(i)); os.push(new O(i + 1)) }
    const gone = { v: 7, f: double }
    const mixed = [{ v: 1, f: add }, { v: 2, get f() { reads += 100; return add } }, { v: 3, f: add }]
    let picks = 0
    const pick = (i) => { picks++; return hs[i] }
    export const f = (n) => { let s = 0, threw = 0
      const pair = [n, 3]
      for (let i = 0; i < 4; i++) s += o.f(i, 2) + pick(i).f(i, 1) + mixed[i % 3].f(i, 4)
      for (let i = 0; i < hs.length; i++) { const h = hs[i]; s += h.f(i) * 10 + h.f(i, 2, 99) * 100 + h.f(...pair) * 1000 }
      for (let i = 0; i < os.length; i++) { const q = os[i]; try { s += q.f(q) * 7 } catch (e) { threw += e instanceof TypeError ? 10 : 1000 } }
      const key = n > 2 ? 'f' : 'zz'
      delete gone[key]
      try { s += gone.f(gone) } catch (e) { threw += e instanceof TypeError ? 1 : 100 }
      return s + '|' + reads + '|' + threw + '|' + picks }`
  for (const optimize of levels(0, 2, 3, 'size', 'speed')) for (const n of [1, 4]) agree(not, 'f', [n], { optimize }, `a getter, a null and a deleted slot, ${n}, at ${optimize}`)
  const one = `const weigh = (p) => p.x + 2 * p.y
    class P { constructor(x, y) { this.x = x; this.y = y; this.weigh = weigh } }
    const ps = []; for (let i = 0; i < 64; i++) ps.push(new P(i * 0.5, i + 1))
    export const f = (n) => { let s = 0; for (let r = 0; r < n; r++) for (let i = 0; i < ps.length; i++) { const p = ps[i]; s += p.weigh(p) }; return s }`
  for (const optimize of levels(0, 2, 3, 'size', 'speed')) {
    agree(one, 'f', [3], { optimize }, `one function at ${optimize}`)
    ok(!/call_indirect/.test(funcWat(compile(one, { wat: true, optimize }), 'f')), `no indirect call at ${optimize}`)
  }
})

// A name tested for its truth holds neither undefined nor null on the arm the test guards
// (compile/flow-types.js extractRefinements): a member read there makes no test of its own.
test('class members: a receiver tested for its truth is read without a second test', () => {
  const src = `class N { constructor(v) { this.v = v; this.next = null } }
    let head = null; for (let i = 5; i >= 0; i--) { const n = new N(i + 1); n.next = head; head = n }
    let none = null
    export const first = () => { const p = head; if (p) return p.v; return -1 }
    export const second = () => { const p = head; return p && p.next ? p.next.v : -1 }
    export const empty = () => { const p = none; if (p) return p.v; return -1 }
    export const not = () => { const p = none; if (!p) return -2; return p.v }
    export const falsy = (k) => { const p = k > 0 ? head : none; if (!p) { try { return p.v } catch (e) { return e instanceof TypeError ? -3 : -4 } } return p.v }
    export const other = (k) => { const p = k > 0 ? head : none; if (!p) return -5; else return p.v }
    export const loop = (k) => { let s = 0; for (let p = k > 0 ? head : none; p; p = p.next) s += p.v; return s }
    export const walk = (k) => { let s = 0, p = k > 0 ? head : none; while (p) { s += p.v; p = p.next } return s }
    export const f = (k) => first() + 10 * second() + 100 * empty() + 1000 * not() + 10000 * falsy(k) + 100000 * other(k) + 1000000 * loop(k) + 100000000 * walk(k)`
  // (the false arm proves nothing: a read of the name there, null on that arm, throws as it did)
  for (const optimize of levels(0, 2, 3, 'size', 'speed')) for (const k of [0, 1]) agree(src, 'f', [k], { optimize }, `${k} at ${optimize}`)
  for (const optimize of levels(2, 3, 'speed')) {
    const w = compile(src, { wat: true, optimize })
    ok(!/throw_property_nullish|__throw/.test(funcWat(w, 'first')), `the guarded read throws nothing at ${optimize}`)
  }
})

// A rewrite of calls answers a body it leaves alone as the node it was given: the summary is
// the program's until a sweep reports a change (plan/index.js `sweep`), which the armed build
// checks at each reuse (compile/index.js summarizeProgram, under JZ_DEBUG_INVARIANTS). A folded
// `0 / 0` is a literal whose value is unequal to itself: read as a child that changed, it had
// every node above it copied. The check sees it at level 0, which every leg compiles here
// for the armed one; without the checks these are the programs against the host.
test('class members: a body no call rewrite changes is the node it was, a folded NaN in it or not', () => {
  const rows = [
    ['a local', `export let f = (a) => { let x = 0 / 0; if (x) return 1; return a }`],
    ['a class and no call of it', `class A { constructor() { this.x = 0 / 0 } }
      const a = new A()
      export let f = (k) => { const v = a.x; return v !== v ? k : 0 / 0 }`],
    ['an argument', `const g = (x, y) => x !== x ? y : x
      export let f = (k) => g(0 / 0, k) + g(k, 0 / 0)`],
    ['a held function', `const add = (a, b) => a + b
      const o = { f: add, n: 0 / 0 }
      export let f = (k) => { const v = o.f(k, 0 / 0); return v !== v ? k : 0 }`],
    ['a spliced method', `class P { constructor(x) { this.x = x } sum(k) { return this.x + k + 0 / 0 } }
      const ps = [new P(1), new P(2)]
      export let f = (n) => { let s = 0; for (let i = 0; i < 2; i++) { const v = ps[i].sum(n); s += v !== v ? 1 : 0 } return s }`],
    ['a loop', `export let f = (n) => { let s = 0; for (let i = 0; i < n; i++) { const v = i % 2 ? 0 / 0 : i; s += v !== v ? 1 : v } return s }`],
  ]
  for (const optimize of [0, ...levels(2, 3)]) for (const [label, src] of rows) agree(src, 'f', [3], { optimize }, `${label} at ${optimize}`)
})

test('class members: a prototype store the class cannot take is rejected at compile time', () => {
  rejects(`class V {}\nconst patch = () => { V.prototype.k = 1 }\nexport const f = () => { patch(); return new V().k }`, /prototype/, 'inside a function')
  rejects(`class V {}\nV.prototype.k = function () { return 1 }\nV.prototype.k = 5\nexport const f = () => new V().k`, /prototype/, 'a function and a value under one name')
  rejects(`class V {}\nconst n = 'k' + 1\nV.prototype[n] = 1\nexport const f = () => 1`, /prototype/, 'a computed name')
  rejects(`class V {}\nif (Math.random() > 2) V.prototype.k = 1\nexport const f = () => 1`, /prototype/, 'inside a branch')
  rejects(`class V {}\nV.prototype.m = function () { return 1 }\nconst v = new V()\nconst early = v.m()\nV.prototype.m = function () { return 2 }\nexport const f = () => early * 10 + v.m()`, /prototype/, 'a method stored again once an instance exists')
  rejects(`export const f = () => { class V {} const patch = () => { V.prototype.k = 1 }; patch(); return new V().k }`, /prototype/, 'inside a function, on a class of a function')
  rejects(`const V = class {}\nV.prototype.k = 1\nexport const f = () => new V().k`, /prototype/, 'on a class expression\'s binding')
  rejects(`export const f = () => { let C = class {}; C = class {}; C.prototype.m = function () { return 1 }; return new C().m() }`, /prototype/, 'on a reassigned class binding')
  rejects(`export default class V {}\nconst patch = () => { V.prototype.k = 1 }\nexport const f = () => { patch(); return new V().k }`, /prototype/, 'on a default-exported class')
})

test('class members: `constructor` is the instance\'s class', () => agrees([
  // three.js clone()
  ['new this.constructor(x, y, z)', `class V { constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z } clone() { return new this.constructor(this.x, this.y, this.z) } }
    export const f = () => { const a = new V(1, 2, 3), b = a.clone(); b.x = 9; return a.x * 100 + b.x * 10 + b.z }`],
  ['new this.constructor().copy(this)', `class V { constructor(x = 0, y = 0) { this.x = x; this.y = y } copy(v) { this.x = v.x; this.y = v.y; return this } clone() { return new this.constructor().copy(this) } }
    export const f = () => new V(4, 5).clone().y`],
  ['a derived instance clones as its own class', `class B { constructor() { this.k = 1 } kind() { return 1 } clone() { return new this.constructor() } } class D extends B { constructor() { super(); this.k = 2 } kind() { return 2 } }
    export const f = () => new D().clone().kind() * 10 + new B().clone().kind()`],
  ['a derived class without a constructor', `class B { constructor(a) { this.a = a } clone() { return new this.constructor(this.a + 1) } } class D extends B { tag() { return 7 } }
    export const f = () => { const c = new D(4).clone(); return c.a * 10 + c.tag() }`],
  ['read: the class itself', `class V {} class W {} export const f = () => { const a = new V(), b = new V(), c = new W(); return (a.constructor === b.constructor ? 1 : 0) + (a.constructor === V ? 10 : 0) + (a.constructor === c.constructor ? 100 : 0) }`],
  ['read, then constructed', `class V { constructor(x) { this.x = x } } export const f = () => { const C = new V(1).constructor; return new C(5).x }`],
  ['no own key of the instance', `class V { constructor() { this.x = 1 } clone() { return new this.constructor() } } export const f = () => Object.keys(new V().clone()).join(',')`],
  ['a rest parameter', `class V { constructor(...a) { this.n = a.length } clone() { return new this.constructor(1, 2, 3) } } export const f = () => new V().clone().n`],
  ['defaults', `class V { constructor(x = 5, y = x * 2) { this.x = x; this.y = y } clone() { return new this.constructor(this.x) } } export const f = () => { const c = new V(3, 1).clone(); return c.x * 10 + c.y }`],
  // the factory takes the initializer's defaults: each runs once, in order, where its argument is left out
  ['a default with an effect runs once per construction', `let n = 0\nconst next = () => ++n\nclass V { constructor(x = next()) { this.x = x } clone() { return new this.constructor() } }\nexport const f = () => { const a = new V(), b = new V(10), c = a.clone(); return a.x + b.x * 10 + c.x * 100 + n * 1000 }`],
  ['a default reading the receiver', `class V { constructor(x = 5, y = this.k) { this.k = 4; this.x = x; this.y = y } clone() { return new this.constructor() } }\nexport const f = () => { const a = new V().clone(); return a.x * 10 + (a.y === undefined ? 1 : 0) }`],
  ['a default reading an earlier parameter, left out', `class V { constructor(x = 1, y = x * 2, z = x + y) { this.x = x; this.y = y; this.z = z } clone() { return new this.constructor(this.x) } }\nexport const f = () => { const a = new V().clone(), b = new V(3).clone(); return a.z + b.z * 10 + b.y * 100 }`],
  ['a class expression', `const V = class { constructor(x = 0) { this.x = x } clone() { return new this.constructor(this.x + 1) } }\nexport const f = () => new V(2).clone().x`],
  ['in a class declared inside a function', `export const f = () => { class V { constructor(x = 0) { this.x = x } clone() { return new this.constructor(this.x + 1) } } return new V(2).clone().x }`],
  ['in a derived class declared inside a function', `export const f = () => { class B { clone() { return new this.constructor() } kind() { return 1 } } class D extends B { kind() { return 2 } } return new D().clone().kind() * 10 + new B().clone().kind() }`],
]))

test('class members: an own closure over a method shadows it only on the shapes that store one', () => {
  // `this.tick = fn` on a disposed node (web-audio-api AudioNode.dispose): a
  // call through a shape whose slot never holds a closure is the method's,
  // with its result; a shape that stores one calls the closure too.
  const src = `class Node {
      constructor(n) { this.buf = new Float32Array(n); this.gain = 0.5 }
      tick() { const b = this.buf; for (let i = 0; i < b.length; i++) b[i] = i * this.gain; return b }
      dispose() { this.tick = () => { throw new Error('disposed') } }
    }
    class Pure {
      constructor(n) { this.buf = new Float32Array(n) }
      tick() { const b = this.buf; for (let i = 0; i < b.length; i++) b[i] = i; return b }
    }
    export function f() {
      const node = new Node(8), pure = new Pure(8)
      let s = 0
      for (let r = 0; r < 4; r++) {
        if (r === 2) node.dispose()
        try { s += node.tick()[7] } catch (e) { s -= 1 }
        s += pure.tick()[7]
      }
      return s
    }`
  agree(src, 'f', [], undefined, 'a disposed node throws through its own closure, a live one ticks')
  const wat = compile(src, { wat: true, optimize: { sourceInline: false, inlineFns: false, watr: false } })
  const body = funcWat(wat, 'f')
  ok(!/__dyn_call|__to_num/.test(body), 'the calls resolve statically and the typed results stay numeric')
})

// A read of a name a class has as a method, and another class or an object
// literal as a getter, takes whichever the receiver has: through a receiver the
// summary cannot name, the getter's probe falls back to the class's method
// (module/core.js `__raw_prop`), and one dispatcher of the read, or of the call,
// answers a getter class and a method class alike (class-dispatch.js
// synthesizeClassDispatchers).
test('class members: a method reads and calls beside a getter of its name elsewhere', () => {
  const rows = [
    ['beside a literal\'s getter', `const o = { get foo() { return 1 } }
      class Th { foo() { return 5 } }
      const probe = (v) => v.foo
      const vals = [o, new Th(), { a: 1 }, [1], 'x', 3]
      export const f = () => vals.map(v => typeof probe(v))`],
    ['beside a class\'s getter', `class A { get foo() { return 'getter' } }
      class B { foo() { return 'method' } }
      const lit = { get foo() { return 'lit' } }
      const vals = [new A(), new B(), lit, { foo: 'data' }, { a: 1 }, [1], 'x', 3]
      export const f = () => vals.map(v => typeof v.foo === 'function' ? v.foo() : v.foo)`],
    ['called, an override of either kind', `class A { get foo() { return () => 'A' } }
      class B { foo() { return 'B' } }
      class C extends B { get foo() { return () => 'C' } }
      class D extends A { foo() { return 'D' } }
      const lit = { get foo() { return () => 'lit' } }
      const vals = [new A(), new B(), new C(), new D(), lit, { foo: () => 'data' }]
      export const f = () => [vals.map(v => v.foo()), vals.map(v => typeof v.foo)]`],
    ['a thenable class awaited', `class Th { then(r) { r('c') } }
      const bad = { get then() { return undefined } }
      export const f = () => [typeof bad.then, typeof new Th().then]`],
  ]
  for (const optimize of levels(false, 2, 3, 'size')) for (const [label, src] of rows) agree(src, 'f', [], { optimize }, `O${optimize} ${label}`)
})
