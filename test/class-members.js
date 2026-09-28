/**
 * What JS keeps on a class's prototype, on a class lowered to a schema or to
 * closures (jzify/classes.js): an own property over a method of its name, a
 * member's own `arguments`, a store to the prototype, and `constructor`.
 * Every expectation is what Node computes for the same source (test/util.js
 * `agree`); three.js's math classes are written in these idioms.
 */
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz from '../index.js'
import { agree } from './util.js'

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

// three.js: Vector3 stores `this.x` beside Quaternion's `set x(v)`. A store
// under an accessor's name on a receiver the summary types as instances of a
// class without the accessor is the field's slot store, keeping the
// receiver's own type (class-dispatch.js lacksSlot): held in a local for the
// setter probe it lost its layout and stored through a hash.
test('class members: a field stored under another class\'s accessor name keeps its slot', () => {
  const src = `class Q { constructor() { this._x = 0 } get x() { return this._x } set x(v) { this._x = v * 2 } }
    class V { constructor(x = 0, y = 0) { this.x = x; this.y = y } min(v) { this.x = Math.min(this.x, v.x); this.y = Math.min(this.y, v.y); return this } fromArray(a, o = 0) { this.x = a[o]; this.y = a[o + 1]; return this } }
    class B { constructor() { this.min = new V(9, 9) } expand(v) { this.min.min(v); return this } }
    const w = new V(1, 2), a = new Float32Array([5, 6, 7])
    export const f = () => { const v = new V().fromArray(a, 1); v.min(w); const q = new Q(); q.x = 4; const b = new B().expand(v); return v.x * 100 + v.y * 10 + q.x + b.min.x * 1000 }`
  agrees([['a field under an accessor name', src]])
  const w = jz.compile(src, { wat: true, optimize: 2 }), at = w.indexOf('(func $f\n'), body = w.slice(at, w.indexOf('\n  )\n', at))
  is((body.match(/__hash_set/g) || []).length, 0, 'every store of f is a slot store')
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
  const w = jz.compile(src, { wat: true, optimize: 2 }), at = w.indexOf('(func $f\n'), body = w.slice(at, w.indexOf('\n  )\n', at))
  is((body.match(/dispatch|__hash_set|__dyn_set|__add_slow/g) || []).length, 0, 'the stores of f are slot stores, the adds numeric')
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
