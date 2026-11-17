// A population of reductions over plain arrays and of in-place updates of records, each
// answering what Node answers: what a lift over a plain array or a record's fields may not
// assume beyond the scalar loop it runs beside. A reduction's strips read bases and a bound
// its block stages ahead of the loop (vectorize/reduce.js, the preamble cloned ahead of them
// and run again by the loop as written); a pair of field stores packs where the two spellings
// of a record's address are one base (vectorize/access.js resolveAddr). The rows: every form a
// plain array is made in, at every holder, its loops to a trip count given at run time and to
// its length; an element no Number (a string, an object, undefined, null, a boolean, a BigInt),
// a hole, a read at or past the length; an array grown or replaced inside the loop or by a call
// it makes, or grown past its room before it (its header forwarded); two names of one array, a
// store into the array read; the length changed by `length = n`, pop, shift or splice before
// the loop or inside it; a bound or a base the loop's body sets; and for a record, a field no
// Number, a getter, a field added or deleted, two records that are one object, a store through
// one name read through the other. A row's variants differ in the call alone (`w`), one compile.
// The data keeps every sum exact, so a sum in lanes in any order is the loop's.
//
// Every program runs at level 2, the default, and at one of 0, 3 and 'size', which a fixed seed
// deals out in turn over a shuffled order, so each level takes a third of the programs: 5
// compiles a run (two chunks at level 2, one at each other level), 23 s at a load of 20. Every
// program at every level, in modules of 40, did not end: its records joined at level 3 meet a
// loop jz never leaves (open; the programs of that module each end alone).
import test from 'tst'
import { population } from './_population.js'

const OTHER = [0, 3, 'size']
const OWN = ['N', 'a', 'b', 'c', 'd', 'k', 'ps', 'st', 'mk', 'kern', 'grow', 'P', 'vals', 'a0', 'b0', 'c0']
const NS = [0, 1, 2, 3, 5, 8, 15, 16]
const KS = [0, 1, 2, 5]
const calls = (ws = [0]) => NS.flatMap(n => KS.flatMap(k => ws.map(w => [n, k, w])))
const upto = w => Array.from({ length: w }, (_, i) => i)

// The plain array forms (test/data-forms.js MAKE): `a` floats, `b` floats, `c` small integers.
const VAL = { a: 'i * 0.5', b: 'i + 1', c: '(i * 37 + 11) % 16' }
const MAKE = {
  push: (n, v) => `${n} = []; for (let i = 0; i < N; i++) ${n}.push(${v})`,
  index: (n, v) => `${n} = []; for (let i = 0; i < N; i++) ${n}[i] = ${v}`,
  newArray: (n, v) => `${n} = new Array(N); for (let i = 0; i < ${n}.length; i++) ${n}[i] = ${v}`,
  fill: (n, v) => `${n} = new Array(N).fill(0); for (let i = 0; i < N; i++) ${n}[i] = ${v}`,
  from: (n, v) => `${n} = Array.from({ length: N }, (_, i) => ${v})`,
  literal: (n, v) => `${n} = [${upto(16).map(i => Function('i', `return ${v}`)(i)).join(', ')}]`,
  map: (n, v) => `${n} = new Array(N).fill(0).map((_, i) => ${v})`,
}
const makeAll = (form, decl) => Object.entries(VAL).map(([n, v]) => `${decl}${MAKE[form](n, v)}`).join('\n')
// The kernels over the names `x`, `y`, `z` a holder gives them, each loop to `t`: in one body,
// each folding its sum into the answer, four to `n` (a trip count given at run time: a test of
// the length each read where no copy of the loop proves it) and four to `N` (the length, as the
// data-form gate's).
const KERN = {
  dot: (x, y, z, t) => `let s = 0; for (let i = 0; i < ${t}; i++) s += ${x}[i] * ${y}[i]`,
  sum: (x, y, z, t) => `let s = 0; for (let i = 0; i < ${t}; i++) s += ${x}[i]`,
  isum: (x, y, z, t) => `let s = 0; for (let i = 0; i < ${t}; i++) s += ${z}[i]`,
  imix: (x, y, z, t) => `let s = 0; for (let i = 0; i < ${t}; i++) s ^= ${z}[i]`,
}
const kernels = (x, y, z) => `let r = 0; ${['n', 'N'].flatMap(t => Object.values(KERN).map(k => `{ ${k(x, y, z, t)}; r = r * 7 + s }`)).join(' ')} return r`
const HOLD = {
  module: (form) => `${makeAll(form, 'const ')}
export const f = (n) => { ${kernels('a', 'b', 'c')} }`,
  param: (form) => `${makeAll(form, 'const ')}
const kern = (x, y, z, n) => { ${kernels('x', 'y', 'z')} }
export const f = (n) => kern(a, b, c, n)`,
  field: (form) => `${makeAll(form, 'const ')}
const d = { a, b, c }
export const f = (n) => { ${kernels('d.a', 'd.b', 'd.c')} }`,
  this: (form) => `class P { constructor() { ${makeAll(form, 'const ')}
this.a = a; this.b = b; this.c = c }
run(n) { ${kernels('this.a', 'this.b', 'this.c')} } }
const k = new P()
export const f = (n) => k.run(n)`,
  closure: (form) => `const mk = () => { ${makeAll(form, 'const ')}
return (n) => { ${kernels('a', 'b', 'c')} } }
const kern = mk()
export const f = (n) => kern(n)`,
  late: (form) => `let a = null, b = null, c = null
export const pre = () => { ${makeAll(form, '')} }
export const f = (n) => { ${kernels('a', 'b', 'c')} }`,
}

const progs = []
for (const form of Object.keys(MAKE)) for (const [h, hold] of Object.entries(HOLD))
  progs.push({ name: `${form}@${h}`, src: `const N = 16\n${hold(form)}`, args: NS.map(n => [n]) })

// One program a row, `f(n, k, w)`: `k` where the row's change lands, `w` its variant.
const row = (name, src, ws) => progs.push({ name, src: `const N = 16\n${src}`, args: calls(ws) })
const pushed = (n, v) => `const ${n} = []; for (let i = 0; i < N; i++) ${n}.push(${v})`
const AB = `${pushed('a', 'i * 0.5')}\n${pushed('b', 'i + 1')}`
const C = `const c = [${upto(16).map(i => (i * 37 + 11) % 16).join(', ')}]`

// an element no Number at `k`, set at run time and put back however the loop leaves
row('not a number', `${AB}
const vals = ['x', { v: 1 }, undefined, null, true, 2n]
export const f = (n, k, w) => { a[k] = vals[w]; try { let s = 0; for (let i = 0; i < n; i++) s += a[i] * b[i]; return s } finally { a[k] = k * 0.5 } }`, upto(6))
// a hole; a read at or past the length, of floats and of integers
row('hole, past the length', `const a0 = new Array(N); for (let i = 0; i < N; i += 3) a0[i] = i * 0.5
${AB}
${C}
export const f = (n, k, w) => { let s = 0
  if (w === 0) for (let i = 0; i < n; i++) s += a0[i] * b[i]
  else if (w === 1) for (let i = 0; i < n + k; i++) s += a[i]
  else for (let i = 0; i < n + k; i++) s += c[i]
  return s }`, upto(3))
// grown or replaced inside the loop, or by a call the loop makes
row('grown or replaced in the loop', `${AB}
let c = a
const grow = (k) => { for (let j = 0; j < 20; j++) b.push(k) }
export const f = (n, k, w) => { let s = 0; c = a
  if (w === 0) for (let i = 0; i < n; i++) { s += a[i] * b[i]; if (i === k) for (let j = 0; j < 20; j++) a.push(j) }
  else if (w === 1) for (let i = 0; i < n; i++) { s += a[i] * b[i]; if (i === k) grow(i) }
  else for (let i = 0; i < n; i++) { s += c[i]; if (i === k) c = b }
  return s + a.length + b.length }`, upto(3))
// grown past its room before the loop: read through its forward at module level and as a parameter
row('forwarded before the loop', `const a0 = [1, 2], c0 = [1, 2]
${pushed('b', 'i + 1')}
const kern = (x, y, n) => { let s = 0; for (let i = 0; i < n; i++) s += x[i] * y[i]; return s }
export const pre = () => { if (a0.length < N) for (let i = 2; i < N; i++) { a0.push(i * 0.5); c0.push((i * 37 + 11) % 16) } }
export const f = (n, k, w) => { let s = 0
  if (w === 0) for (let i = 0; i < n; i++) s += a0[i] * b[i]
  else if (w === 1) s = kern(a0, b, n)
  else for (let i = 0; i < n; i++) s += c0[i]
  return s }`, upto(3))
// two names of one array; a store in the loop into the array it reads
row('two names, a store into the array read', `${AB}
const kern = (x, y, n) => { let s = 0; for (let i = 0; i < n; i++) s += x[i] * y[i]; return s }
const sums = (x, y, n) => { let s = 0; for (let i = 0; i < n; i++) { s += x[i]; y[i] = s } return s }
export const f = (n, k, w) => { if (w === 0) return kern(a, k & 1 ? a : b, n)
  const r = sums(a, k & 1 ? a : b, n); let h = 0; for (let i = 0; i < N; i++) h = (h * 31 + a[i] + b[i]) % 1000003
  for (let i = 0; i < N; i++) { a[i] = i * 0.5; b[i] = i + 1 } return r + h }`, upto(2))
// the length changed between the proof and the read, before the loop (w < 4) or inside it
row('the length changed', `let a = []
const cut = (w, k) => { if (w === 0) a.length = k; else if (w === 1) a.pop(); else if (w === 2) a.shift(); else a.splice(k, 1) }
export const f = (n, k, w) => { a = []; for (let i = 0; i < N; i++) a.push(i * 0.5); let s = 0
  if (w < 4) { cut(w, k); for (let i = 0; i < n; i++) s += a[i] }
  else for (let i = 0; i < n; i++) { s += a[i]; if (i === k) cut(w - 4, k) }
  return s }`, upto(8))
// a bound or a base the loop's body sets: no preamble may stage it (scaffold.js preambleOf)
row('a bound or a base the body sets', `${AB}
export const f = (n, k, w) => { let s = 0
  if (w === 0) { let m = n; for (let i = 0; i < m; i++) { s += a[i] * b[i]; if (i === k) m = k + 3 } }
  else { let p = a; for (let i = 0; i < n; i++) { s += p[i]; if (i === k) p = b } }
  return s }`, upto(2))

// Records {x, y, vx, vy}, updated in place two fields a pass, in each form a record is made in;
// `w` the kernel: step, advance, two names of one record crossed (`k` odd) or apart, a record's
// own fields read after its store, one record at two indices.
const REC = {
  literal: { make: (x, y, vx, vy) => `({ x: ${x}, y: ${y}, vx: ${vx}, vy: ${vy} })` },
  class: { pre: 'class P { constructor(x, y, vx, vy) { this.x = x; this.y = y; this.vx = vx; this.vy = vy } }', make: (...v) => `new P(${v.join(', ')})` },
  spread: { make: (x, y, vx, vy) => `({ x: ${x}, y: ${y}, ...{ vx: ${vx}, vy: ${vy} } })` },
  factory: { pre: 'const mk = (x, y, vx, vy) => ({ x, y, vx, vy })', make: (...v) => `mk(${v.join(', ')})` },
  stores: { pre: 'const mk = (x, y, vx, vy) => { const p = {}; p.x = x; p.y = y; p.vx = vx; p.vy = vy; return p }', make: (...v) => `mk(${v.join(', ')})` },
}
const recs = (r) => `${r.pre ?? ''}
const ps = []
for (let i = 0; i < N; i++) ps.push(${r.make('i * 0.5', 'i + 1', 'i % 7 - 3', 'i % 5 * 0.25')})
const st = ps[N >> 1]`
const reset = 'for (let i = 0; i < N; i++) { const p = ps[i]; p.x = i * 0.5; p.y = i + 1 }'
const hash = 'let h = 0; for (let i = 0; i < N; i++) h = (h * 31 + (ps[i].x === ps[i].x ? ps[i].x : 0) * 3 + (ps[i].y === ps[i].y ? ps[i].y : 0)) % 1000003'
for (const [form, r] of Object.entries(REC)) row(`record ${form}`, `${recs(r)}
export const f = (n, k, w) => { ${reset}
  if (w === 1) { st.x = 1; st.y = 2; for (let i = 0; i < n; i++) { st.x += st.vx; st.y += st.vy } return st.x + st.y * 3 }
  if (w === 0) for (let i = 0; i < n; i++) { const p = ps[i]; p.x += p.vx; p.y += p.vy }
  else if (w === 2) for (let i = 0; i < n; i++) { const p = ps[i], q = ps[k & 1 ? i : (i + 1) % N]; p.x = q.y + 1; p.y = q.x + 1 }
  else if (w === 3) for (let i = 0; i < n; i++) { const p = ps[i]; p.x = p.y + p.vx; p.y = p.x + p.vy }
  else { const keep = ps[k + 1]; ps[k + 1] = ps[k]; for (let i = 0; i < n; i++) { const p = ps[i]; p.x += p.vx; p.y += p.vy } ps[k + 1] = keep }
  ${hash}; return h }`, upto(5))
// a field no Number (w < 3), deleted (3) or added (4), put back after
row('record fields', `${recs(REC.literal)}
const vals = ['x', undefined, { v: 1 }]
export const f = (n, k, w) => { ${reset}; const q = ps[k], key = w === 3 ? 'vy' : 'vx', was = q[key]
  if (w < 3) q.vx = vals[w]; else if (w === 3) delete q[key]; else q.z = 5
  for (let i = 0; i < n; i++) { const p = ps[i]; p.x += p.vx; p.y += p.vy }
  q[key] = was; ${hash}; return h + (q.z ?? 0) }`, upto(5))
// a getter and a setter where the field was
row('record getter', `class P { constructor(x, y, vx, vy) { this._x = x; this.y = y; this.vx = vx; this.vy = vy } get x() { return this._x * 2 } set x(v) { this._x = v } }
const ps = []
for (let i = 0; i < N; i++) ps.push(new P(i * 0.5, i + 1, i % 7 - 3, i % 5 * 0.25))
export const f = (n, k, w) => { for (let i = 0; i < N; i++) { ps[i].x = i * 0.5; ps[i].y = i + 1 } for (let i = 0; i < n; i++) { const p = ps[i]; p.x += p.vx; p.y += p.vy }
  let h = 0; for (let i = 0; i < N; i++) h = (h * 31 + ps[i].x * 3 + ps[i].y) % 1000003; return h }`)

// Each program at one level beside the default, dealt in turn over an order a fixed seed shuffles.
const order = progs.map((_, i) => i)
for (let i = order.length - 1, s = 1; i > 0; i--) {
  s ^= s << 13; s ^= s >>> 17; s ^= s << 5
  const j = (s >>> 0) % (i + 1);
  [order[i], order[j]] = [order[j], order[i]]
}
const at = new Map(order.map((p, i) => [p, OTHER[i % OTHER.length]]))
test(`plain lift population: ${progs.length} programs at level 2, a third each at 0, 3 and size`, () => {
  population('plain lift at 2', progs, { configs: [2], own: OWN, chunk: Math.ceil(progs.length / 2) })
  for (const level of OTHER) population(`plain lift at ${level}`, progs.filter((_, i) => at.get(i) === level), { configs: [level], own: OWN })
})
