// A key the program stores on objects after their literal, where nothing asks
// those objects for their keys, is a slot of the literal: its reads and writes
// load and store, no sidecar probe. Anything that can tell an undefined slot
// from a missing key (Object.keys, for-in, `in`, hasOwnProperty, a spread,
// JSON, delete, the host) keeps the key out (plan/declare-unseen-keys.js).
import test from 'tst'
import { ok } from 'tst/assert.js'
import { belowOpt, levels } from './_matrix.js'
import { funcWat, oracle, wat, jz } from './util.js'

const agree = (src, calls) => {
  for (const optimize of levels(0, 2, 3)) {
    const want = oracle(src)
    const got = jz(src, { optimize }).exports
    for (const [name, ...args] of calls) {
      const a = want[name](...args), b = got[name](...args)
      ok(Object.is(a, b) || JSON.stringify(a) === JSON.stringify(b), `${name}(${args}) at ${optimize}: ${b} for ${a}`)
    }
  }
}
const dynCalls = (text, fn) => { const body = funcWat(text, `${fn}$exp`, fn); ok(body, `${fn} is in the module`); return body.match(/call \$__(dyn_get|dyn_set|hash_get|hash_set|ihash)\w*/g) ?? [] }

// the atom shape: a state record per channel in a list, state added on first use, a default `{}` beside it
const state = `function svf (s, x, f, q) { s.l += f * s.b; let h = x - s.l - q * s.b; s.b += f * h; return h }
function kernel (data, params = {}) {
  let fc = params.fc ?? 80, keep = params.keep ?? 1
  if (!params._sub) { params._sub = { l: 0, b: 0 }; params._dc = 0 }
  for (let i = 0; i < data.length; i++) {
    let x = data[i]
    svf(params._sub, x, fc / 1000, 1.2)
    params._dc += 0.01 * (params._sub.l - params._dc)
    data[i] = x - (1 - keep) * params._sub.l + params._dc
  }
  return data
}
const chP = []; for (let c = 0; c < 2; c++) chP.push({ fs: 48000 })
const buf = new Float64Array(64)
export let run = (n, fc) => { let h = 0
  for (let r = 0; r < n; r++) for (let c = 0; c < 2; c++) {
    for (let i = 0; i < 64; i++) buf[i] = ((i * 7 + c * 3) % 11) / 8 - 0.5
    const p = chP[c]; p.fc = fc; p.keep = 0.5; kernel(buf, p); h += buf[7] + buf[63]
  }
  return h }
export let fresh = (fc) => kernel(new Float64Array([1, 2, 3]), { fc })[2]
export let bare = () => kernel(new Float64Array([1, 2, 3]))[2]`

test('declared keys: state added to a record after its literal agrees with JS', () => {
  agree(state, [['run', 1, 80], ['run', 3, 120], ['fresh', 90], ['bare']])
})

test('declared keys: the state reads and writes are slots', () => {
  if (belowOpt(2)) return
  const text = wat(state, { optimize: 2 })
  ok(!dynCalls(text, 'kernel').length, `kernel: ${dynCalls(text, 'kernel')}`)
  ok(!dynCalls(text, 'run').length, `run: ${dynCalls(text, 'run')}`)
})

// Each operation that asks for keys, on an object that gained a key on one path only.
const seen = {
  keys: 'Object.keys(o).join()',
  values: 'Object.values(o).length',
  forIn: '(() => { let s = ""; for (const k in o) s += k; return s })()',
  in: '("b" in o) + ":" + ("c" in o)',
  own: 'o.hasOwnProperty("b") + ":" + Object.hasOwn(o, "c")',
  json: 'JSON.stringify(o)',
  entries: 'Object.entries(o).length',
  spread: 'Object.keys({ ...o, ...{ z: 1 } }).join()',
  names: 'Object.getOwnPropertyNames(o).join()',
  alias: '((x) => Object.keys(x).length)(o)',
  assign: 'Object.keys(Object.assign({ z: 0 }, o)).join()',
}
for (const [name, ask] of Object.entries(seen)) test(`declared keys: ${name} sees only the keys stored so far`, () => {
  agree(`let o = { a: 1 }
    export let f = (c) => { if (c > 0) o.b = 2; if (c > 1) o.c = 3; return ${ask} }`, [['f', 0], ['f', 1], ['f', 2]])
})

test('declared keys: a delete keeps presence a runtime fact', () => {
  agree(`let o = { a: 1 }
    export let f = (c) => { const k = c > 1 ? 'b' : 'a'; o.b = c; if (c) delete o[k]; return (o.b ?? -1) + Object.keys(o).length * 10 }`, [['f', 0], ['f', 1], ['f', 0]])
})

test('declared keys: an object the host receives keeps its own keys', () => {
  const src = `export let f = (c) => { const o = { a: 1 }; if (c) o.b = 2; return o }`
  for (const optimize of levels(0, 2)) {
    const { f } = jz(src, { optimize }).exports
    ok(Object.keys(f(0)).join() === 'a' && Object.keys(f(1)).join() === 'a,b', `host keys at ${optimize}`)
  }
})

test('declared keys: an inherited name still reads through the prototype before its store', () => {
  agree(`let o = { a: 1 }
    export let f = (c) => { if (c) o.toString = () => 'mine'; return String(o) }`, [['f', 0], ['f', 1]])
})

test('declared keys: a record read before its state is stored reads undefined', () => {
  agree(`const recs = [{ n: 1 }, { n: 2 }]
    export let f = (i, c) => { const r = recs[i]; if (c) r.late = c * 10; return (r.late ?? -1) + r.n }`, [['f', 0, 0], ['f', 1, 3], ['f', 1, 0], ['f', 0, 2]])
})

// Object.assign stores into its target without asking it for its keys: the
// keys it copies are declared like any other store's, and a target the summary
// holds to one layout (an element of a list of records) takes them as slots.
test('declared keys: Object.assign onto a list element stores slots', () => {
  const src = `let mk = (g) => ({ b0: g, a1: 0.5 })
    let run = (data, f) => { f.state ??= new Float64Array(2); let s = f.state; for (let i = 0; i < data.length; i++) { let y = data[i] * f.coefs.b0 + s[0]; s[0] = y * f.coefs.a1; data[i] = y } }
    export let f = (n) => { let fs = [1, 2, 3].map(() => ({})); for (let i = 0; i < 3; i++) Object.assign(fs[i], { coefs: mk(i), flat: !i })
      let d = new Float64Array(n).fill(1); for (let f of fs) { if (!f.flat) run(d, f); else f.state = null } return d[0] + d[n - 1] }`
  agree(src, [['f', 8], ['f', 1]])
  for (const optimize of levels(2, 3)) ok(dynCalls(wat(src, { optimize }), 'f').length === 0, `slots at ${optimize}`)
})

test('declared keys: Object.assign keeps what its target can tell', () => {
  agree(`export let f = (i) => { let fs = [1, 2].map(() => ({})); try { Object.assign(fs[i], { a: 1 }); return fs[i].a + (fs[i].b ?? 7) } catch (e) { return e instanceof TypeError ? -1 : -2 } }`, [['f', 0], ['f', 1], ['f', 5]])
  agree(`export let f = () => { let o = {}; Object.assign(o, { b: 1 }); o.a = 2; return Object.keys(o).join() }`, [['f']])
  agree(`export let f = () => { let l = [{}, {}]; Object.assign(l[1], { b: 1, c: 2 }); l[0].z = 3; return JSON.stringify(l) + Object.keys(l[1]) }`, [['f']])
  agree(`export let f = (x) => { let l = [{ q: 1 }]; Object.assign(l[0], { b: x }, { c: 2, b: 5 }); return l[0].b + l[0].c + l[0].q }`, [['f', 3]])
  agree(`let mk = () => ({}); export let f = (x) => { let a = mk(), b = mk(); Object.assign(a, { s: x }); b.t = 2; return (a.s ?? 0) + (a.t ?? 10) + (b.s ?? 100) + b.t }`, [['f', 3]])
})

// Literals that meet (the elements of a list, the arms of a choice) with the
// same keys in two orders take one layout: a read through the join is a slot.
// Literals of two sets of keys stay two layouts, which tell their objects
// apart (`lacks` below, and the pins of the reads by layout: test/splice.js,
// test/struct-inline.js, test/optimizer-devirt.js).
const total = `let total = (l) => { let s = 0; for (let i = 0; i < l.length; i++) { const p = l[i]; s += p.x * 2 + p.y * 3 + (p.m ?? 7) } return s }`
const meet = `${total}
export let elems = (n) => { const l = []; for (let i = 0; i < n; i++) l.push(i % 2 ? { x: i, y: i * 0.5 } : { y: i * 0.25, x: i + 1 }); return total(l) }
export let arms = (n) => { let s = 0; for (let i = 0; i < n; i++) { const p = i % 3 ? { x: i, y: 2 } : { y: 5, x: i * 2 }; s += p.x - p.y } return s }
export let member = (n) => { const o = { u: n, w: n * 2 }; const l = [{ x: o.u, y: o.w }, { y: o.u + 1, x: o.w - 1 }]; return total(l) }
export let inArrow = (n) => { const l = [1, 2, 3].map(i => ({ y: i, x: i * 2 })); l.push({ x: n, y: n + 1 }); return total(l) }
let k = 0
let next = () => ++k
export let oneCalls = (c, i) => { k = 0; const p = c ? { x: next(), y: next() } : { y: i, x: i * 2 }; return p.x * 10 + p.y }
export let laterCalls = (c, i) => { k = 0; const p = c ? { y: i, x: i * 2 } : { x: next(), y: next() }; return p.x * 10 + p.y }
export let other = (i, n, o) => typeof i + typeof n + typeof o`
const meetCalls = [['elems', 9], ['arms', 9], ['member', 3], ['inArrow', 4], ['oneCalls', 0, 5], ['oneCalls', 1, 5], ['laterCalls', 0, 5], ['laterCalls', 1, 5]]

test('one layout: literals that meet in two key orders agree with JS', () => agree(meet, meetCalls))

test('one layout: a read through the join is a slot', () => {
  for (const optimize of levels(2, 3)) {
    const text = wat(meet, { optimize })
    for (const fn of ['total', 'arms', 'oneCalls', 'laterCalls']) ok(!dynCalls(text, fn).length, `${fn} at ${optimize}: ${dynCalls(text, fn)}`)
  }
})

// An entry moves only where it has no effect and cannot throw: a call, an
// accessor, a conversion and a read that may throw each keep their place.
test('one layout: an entry with an effect keeps its place', () => {
  agree(`let k = 0
    let next = () => ++k
    export let calls = (c) => { k = 0; const p = c ? { x: next(), y: next() } : { y: next(), x: next() }; return p.x * 10 + p.y }
    let seen = 0
    const g = { get v () { return ++seen } }
    export let getter = (c) => { seen = 0; const p = c ? { x: g.v, y: g.v } : { y: g.v, x: g.v }; return p.x * 10 + p.y }
    export let thrower = (c, has) => { let n = 0; const o = has ? { q: 4 } : null; try { const p = c ? { x: n++, y: o.q } : { y: o.q, x: n++ }; return p.x * 10 + p.y + n * 100 } catch (e) { return -1 - n } }
    let log = ''
    const va = { valueOf: () => { log += 'a'; return 2 } }, vb = { valueOf: () => { log += 'b'; return 3 } }
    export let converts = (c) => { log = ''; const p = c ? { x: va * 1, y: vb * 1 } : { y: vb * 1, x: va * 1 }; return log + (p.x * 10 + p.y) }
    export let shadows = (c) => { log = ''; let a = 1, b = 2; const q = { x: a, y: b }; const mk = [(a, b) => ({ y: b * 1, x: a * 1 }), (a, b) => ({ y: b * 2, x: a * 2 })]; const p = c > 1 ? q : mk[c](va, vb); return log + (p.x * 10 + p.y) }
    let before = (a, b) => a + b
    let conv = (c, a, b) => { const q = { x: 1, y: 2 }; const p = c ? q : { y: b * 1, x: a * 1 }; return p.x * 10 + p.y }
    let after = (a, b) => a - b
    export let scoped = (c) => { log = ''; const r = conv(c, va, vb) + before(1, 2) + after(3, 4); return log + r }`,
  [['calls', 0], ['calls', 1], ['getter', 0], ['getter', 1], ['thrower', 0, 0], ['thrower', 1, 0], ['thrower', 0, 1], ['thrower', 1, 1], ['converts', 0], ['converts', 1], ['shadows', 0], ['shadows', 1], ['shadows', 2], ['scoped', 0], ['scoped', 1]])
})

// Each operation that can tell a key order, or a key one literal lacks.
const told = {
  ...seen,
  values: 'Object.values(o).join()',
  in: '("m" in o) + ":" + ("x" in o)',
  own: 'o.hasOwnProperty("m") + ":" + Object.hasOwn(o, "x")',
  entries: 'Object.entries(o).join()',
  spread: 'Object.keys({ ...o, z: 1 }).join()',
  copy: 'Object.keys({ ...o }).join()',
  rest: '(() => { const { x, ...others } = o; return x + Object.keys(others).join() })()',
  alias: '((q) => Object.keys(q).join())(o)',
  del: '(() => { let k = c ? "x" : "y"; delete o[k]; return Object.keys(o).join() + (o.x ?? "gone") })()',
  computed: '(() => { const k = "n" + "ew"; o[k] = 1; return Object.keys(o).join() })()',
}
for (const [name, ask] of Object.entries(told)) test(`one layout: ${name} sees each literal's own keys in its own order`, () => {
  agree(`export let order = (c) => { const o = c ? { x: 1, y: 2 } : { y: 3, x: 4 }; const r = o.x * 10 + o.y; return r + ':' + ${ask} }
    export let lacks = (c) => { const o = c ? { m: 1, x: 2 } : { x: 4 }; const r = o.x * 10 + (o.m ?? 7); return r + ':' + ${ask} }`,
  [['order', 0], ['order', 1], ['lacks', 0], ['lacks', 1]])
})

test('one layout: the host sees each literal as written', () => {
  agree(`export let order = (c) => c ? { x: 1, y: 2 } : { y: 3, x: 4 }
    export let lacks = (c) => c ? { m: 1, x: 2 } : { x: 4 }`, [['order', 0], ['order', 1], ['lacks', 0], ['lacks', 1]])
})

// `toString: undefined` in the literal that lacks it would answer for the prototype's.
test('one layout: a literal is given no inherited name', () => {
  agree(`let mk = (c) => c ? { a: 1, toString: () => 'mine' } : { a: 2 }
    export let f = (c) => { const o = mk(c); o.late = 5; return String(o) + o.late + o.a }`, [['f', 0], ['f', 1]])
})

// A small record made many times beside larger ones of other keys keeps its
// own size: the layout's room is no more than what the group's literals hold.
test('one layout: a group whose literals hold little of it stays as written', () => {
  const bigs = (p) => [1, 2, 3].map(g => `{ ${[1, 2, 3, 4, 5, 6, 7, 8].map(i => `${p}${g}${i}: ${i}`).join(', ')} }`).join(', ')
  const src = `const alone = [], all = [], marked = []
    export let small = (n) => { alone.length = 0; for (let i = 0; i < n; i++) alone.push({ v: i }); let s = 0; for (let i = 0; i < alone.length; i++) s += alone[i].v; return s }
    export let many = (n) => { all.length = 0; all.push(${bigs('a')}); for (let i = 0; i < n; i++) all.push({ v: i }); let s = 0; for (let i = 0; i < all.length; i++) s += all[i].v ?? all[i].a11; return s }
    export let late = (n) => { marked.length = 0; marked.push(${bigs('b')}); for (let i = 0; i < n; i++) marked.push({ w: i }); marked[0].tag = 9; let s = 0; for (let i = 0; i < marked.length; i++) s += marked[i].w ?? marked[i].tag; return s }`
  agree(src, [['small', 50], ['many', 50], ['late', 50]])
  for (const optimize of levels(2, 3)) {
    const grown = (name) => { const { exports, memory } = jz(src, { optimize }); const at = memory.buffer.byteLength; exports[name](20000); return memory.buffer.byteLength - at }
    const base = grown('small')
    for (const name of ['many', 'late']) { const g = grown(name); ok(g <= base * 1.5, `${name} at ${optimize}: ${g / 65536} pages beside ${base / 65536}`) }
  }
})
