// A key the program stores on objects after their literal, where nothing asks
// those objects for their keys, is a slot of the literal: its reads and writes
// load and store, no sidecar probe. Anything that can tell an undefined slot
// from a missing key (Object.keys, for-in, `in`, hasOwnProperty, a spread,
// JSON, delete, the host) keeps the key out (plan/declare-unseen-keys.js).
import test from 'tst'
import { ok } from 'tst/assert.js'
import jz from '../index.js'
import { belowOpt, levels } from './_matrix.js'
import { funcWat, oracle, wat } from './util.js'

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
const dynCalls = (text, fn) => { const body = funcWat(text, `${fn}$exp`) || funcWat(text, fn); ok(body, `${fn} is in the module`); return body.match(/call \$__(dyn_get|dyn_set|hash_get|hash_set|ihash)\w*/g) ?? [] }

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
