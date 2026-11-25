// An array whose length cannot change: every array of its cell is a literal of
// one count, nothing in the program resizes or deletes from any of them, no
// store names an index the count does not hold, no holder is out of the
// summary's sight (src/summary `lens`). Its reads and its stores inside the
// count are the cell's own load and store; every result is the host's.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
// These probes inspect the in-process summary; runtime checks still use the matrix target.
import { ctx } from '../src/ctx.js'
import { K, hasTag } from '../src/summary/index.js'
import { belowOpt, levels } from './_matrix.js'
import { agree, oracle, run, wat, funcWat, compileInProcess as compile, jz } from './util.js'
import parseWat from 'watr/parse'
import { walk } from '../scripts/wat-probe.mjs'

// The fact as the summary holds it after a compile: `fixedLenOf` of a module
// binding, or of a function's binding by the name the source gave it.
const fixedLen = (src, scope, name) => {
  compile(src, { host: 'js', optimize: 0, imports: { host: { sink: () => 0 } } })
  const fn = scope == null ? null : ctx.funcs.map.get(scope)
  const spelled = fn ? JSON.stringify([fn.sig.params.map(p => p.name), fn.body]).match(new RegExp('"' + name + '[^"A-Za-z0-9_$][^"]*"'))?.[0] : null
  return ctx.summary.at(fn?.body).fixedLenOf(spelled ? JSON.parse(spelled) : name)
}

test('fixed length: a literal written inside its count keeps it', () => {
  is(fixedLen(`const a = [1, 2, 3], out = [0, 0, 0]
    export const f = (k) => { out[0] = a[0] * k; out[2] = k; return out[0] }`, null, 'out'), 3)
  is(fixedLen(`const out = [3, 1, 2]
    export const f = (k) => { out.fill(k); out.sort(); out.reverse(); return out[0] }`, null, 'out'), 3, 'fill, sort and reverse move elements only')
  is(fixedLen(`const out = [0, 0, 0]
    export const f = (k) => { out[0] += k; out[1]++; out['2'] = k; return out[0] }`, null, 'out'), 3, 'compound, update and index-key stores')
  is(fixedLen(`export const f = (k) => { const v = [k, k, k]; v[1] = 2; return v[0] + v[1] }`, 'f', 'v'), 3, 'a local literal')
})

// A construction's count is a literal, or a name that holds an integer for good (the plan folds
// such a name's reads to the integer, so the emitter builds the one array either way).
test('fixed length: a construction counted by a name that holds an integer for good has that count', () => {
  const made = (decl, make, body = 't[0] = k') => fixedLen(`${decl}\nconst t = ${make}\nexport const f = (k) => { ${body}; return t[7] }`, null, 't')
  is(made('const N = 8', 'new Array(N)'), 8, 'a module constant')
  is(made('const N = 8', 'Array(N)'), 8, 'called without new')
  is(made('let N = 8', 'new Array(N)'), 8, 'a binding nothing writes again')
  is(fixedLen(`export const f = (k) => { const n = 5; const t = new Array(n); t[0] = k; return t[4] }`, 'f', 't'), 5, 'a constant of the function')
  is(made('let N = 8', 'new Array(N)', 'N = k; t[0] = k'), null, 'a binding written again holds none')
  is(made('const N = 8', 'new Array(N)', 't.push(k)'), null, 'a push opens it, as a literal count\'s')
  is(made('const N = 8', 'new Array(N)', 't[8] = k'), null, 'and a store past it')
  // `Array.from` of an array-like that is its length alone
  is(made('const N = 8', 'Array.from({ length: N }, (_, i) => i * 2)'), 8, 'Array.from of a module constant')
  is(made('', 'Array.from({ length: 8 }, (_, i) => i * 2)'), 8, 'of a literal')
  is(made('', 'Array.from({ length: 8 })'), 8, 'without a callback')
  is(made('', 'Array.from({ length: 8.5 }, (_, i) => i * 2)'), null, 'a fraction makes fewer elements than a counter below it reads')
  is(made('', 'Array.from({ length: 8, 0: 5 }, (_, i) => i * 2)'), null, 'an array-like of more than its length is no count')
  is(fixedLen(`export const f = (n) => { const t = Array.from({ length: n }, (_, i) => i * 2); return t[4] }`, 'f', 't'), null, 'nor is a count the caller gives')
})

// Its elements are what the callback returns for an index below the count, so a gather through it
// stays inside both arrays; an array-like of more keys, a fraction and a missing callback read as Node.
const FROM = [
  ['a gather through it', `const N = 8\nconst idx = Array.from({ length: N }, (_, i) => (i * 3 + 1) % N), a = Array.from({ length: N }, (_, i) => i * 0.5)\nexport const f = () => { let s = 0; for (let i = 0; i < N; i++) s += u(a[idx[i]]); return s }`, 'in in'],
  ['read past its count', `const t = Array.from({ length: 6 }, (_, i) => i * 2)\nexport const f = () => { let s = 0; for (let i = 0; i < 8; i++) s += u(t[i]); return s }`, 'open'],
  ['without a callback', `const t = Array.from({ length: 6 })\nexport const f = () => { let s = 0; for (let i = 0; i < 6; i++) s += u(t[i]); return s }`, 'hole'],
  ['an array-like of more keys', `const t = Array.from({ length: 6, 0: 5, 2: 7 })\nexport const f = () => { let s = 0; for (let i = 0; i < 6; i++) s += u(t[i]); return s }`, 'open'],
  ['a fraction', `const t = Array.from({ length: 3.5 }, (_, i) => i * 2)\nexport const f = () => { let s = 0; for (let i = 0; i < 3.5; i++) s += u(t[i]); return s }`, 'open'],
]
test('fixed length: Array.from of a length has its callback\'s results below the count', () => {
  for (const [what, src, reads] of FROM) {
    is(present(`${U}\n${src}`, 'f'), reads, what)
    for (const optimize of levels(0, 2, 3, 'size', 'speed')) agree(`${U}\n${src}`, 'f', [], { optimize }, `${what} at ${optimize}`)
  }
})

// The length of an array of fixed length is its count: a literal where it is read, after the
// holder's test where the holder may be unset. An array of open length reads its header.
test('fixed length: the length reads as the count', () => {
  const f = (src, optimize) => funcWat(wat(src, { optimize }), 'f')
  const fixed = `const N = 8\nconst t = new Array(N).fill(0)\nexport const f = () => t.length`
  const unset = `let t\nexport const init = () => { t = new Array(8).fill(0); return 0 }\nexport const f = () => t.length`
  const open = `const t = []\nexport const g = (k) => { t.push(k); return 0 }\nexport const f = () => t.length`
  for (const optimize of [0, 2]) {
    ok(/\b(?:f64|i32)\.const 8\b/.test(f(fixed, optimize)) && !/\.load/.test(f(fixed, optimize)), `a constant holder at ${optimize}: the count, no load`)
    ok(/\b(?:f64|i32)\.const 8\b/.test(f(unset, optimize)) && !/\.load/.test(f(unset, optimize)), `a holder that may be unset at ${optimize}: the count past its test`)
    ok(/\.load/.test(f(open, optimize)), `an array of open length at ${optimize}: its header`)
  }
  const tries = `const tries = (h) => { try { return h() } catch (e) { return e instanceof TypeError ? 'TypeError' : 'other' } }`
  const calls = `${unset.replace('export const f', 'const f')}\n${tries}\nexport const main = () => { const out = [tries(f)]; init(); out.push(f()); return out.join() }`
  for (const optimize of levels(0, 2, 3, 'size', 'speed')) agree(calls, 'main', [], { optimize }, `unset, then set, at ${optimize}`)
})

// A loop bounded by an array's own length is one the for emitter may version where that length is
// the count for good. One that grows in the loop is no bound a guard can read at the entry: the
// typed reads beside it stay tested. (Through the bounding name the loop's own scan sees the
// push; through another name of the array, or in a call, only the summary does.)
test('fixed length: a loop bounded by a length that grows keeps its reads tested', () => {
  const body = (grow) => `let s = 0; for (let i = 0; i < arr.length; i++) { ${grow}; t[i] = i + 0.5; s += t[i] === undefined ? 100 : t[i] } return s * 10 + arr.length`
  const grows = {
    'through its own name': `export const f = () => { const arr = [1, 2]; ${body('if (arr.length < 8) arr.push(i)')} }`,
    'through another name': `export const f = () => { const arr = [1, 2], more = arr; ${body('if (more.length < 8) more.push(i)')} }`,
    'in a call': `const arr = [1, 2]\nconst grow = (i) => { if (arr.length < 8) arr.push(i); if (i > 99) return grow(i - 1); return 0 }\nexport const f = () => { ${body('grow(i)')} }`,
  }
  for (const [what, src] of Object.entries(grows)) for (const optimize of levels(0, 2, 3, 'size', 'speed')) agree(`const t = new Float64Array(4)\n${src}`, 'f', [], { optimize }, `${what} at ${optimize}`)
  // (no call in the loop and the typed array the function's own: the loop the scan would version,
  // its guard reading two for a bound that reaches eight)
  const local = `export const f = () => { const t = new Float64Array(4); const arr = [1, 2], more = arr; ${body('if (more.length < 8) more[more.length] = i')} }`
  for (const optimize of levels(0, 2, 3, 'size', 'speed')) agree(local, 'f', [], { optimize }, `by a store at its end through another name, at ${optimize}`)
})

test('fixed length: a resize, a store past the count or an unbounded index opens it', () => {
  const open = (body, why) => is(fixedLen(`const out = [0, 0, 0]\nexport const f = (k, i) => { ${body}; return out[0] }`, null, 'out'), null, why)
  open('out[3] = k', 'a store past the count')
  open(`out['7'] = k`, 'an index key past the count')
  open('out[i] = k', 'a store at an index nothing bounds')
  open('out.push(k)', 'push')
  open('out.pop()', 'pop')
  open('out.shift()', 'shift')
  open('out.unshift(k)', 'unshift')
  open('out.splice(0, 1)', 'splice')
  open('out.length = 1', 'a length store')
  open('delete out[i]', 'a deleted element')
  open('[out[0], out[5]] = [k, k]', 'a destructuring store past the count')
  open('Object.assign(out, [k, k, k, k])', 'a callee the summary cannot see through')
})

test('fixed length: a holder out of sight opens it', () => {
  is(fixedLen(`const out = [0, 0, 0]\nexport const f = (k) => { out[0] = k; return out }`, null, 'out'), null, 'returned to the host')
  is(fixedLen(`export const out = [0, 0, 0]\nexport const f = (k) => { out[0] = k; return out[0] }`, null, 'out'), null, 'an exported binding')
  is(fixedLen(`import { sink } from 'host'\nconst a = [1, 2, 3]\nexport const f = () => { sink(a); return a[0] }`, null, 'a'), null, 'passed to an import')
  is(fixedLen(`const a = [1, 2, 3]\nexport const f = (o) => { o.held = a; return a[0] }`, null, 'a'), null, 'stored under an unknown receiver')
  // A join with a primitive keeps the array's cell (summary `primArray`): the
  // count holds until a resize through the join reaches the cell.
  is(fixedLen(`const a = [1, 2, 3]\nexport const f = (c) => { const v = c ? a : 5; return v === 5 ? 0 : v[0] }`, null, 'a'), 3, 'joined with a number')
  is(fixedLen(`const a = [1, 2, 3]\nexport const f = (c) => { const v = c ? a : 5; if (v !== 5) v.push(1); return a[0] }`, null, 'a'), null, 'pushed through the join')
  is(fixedLen(`const a = [1, 2, 3]\nexport const f = (c) => { const v = c ? a : 'x'; if (typeof v !== 'string') v.length = 0; return a[0] }`, null, 'a'), null, 'resized through the join')
  is(fixedLen(`const a = [1, 2, 3]\nconst g = (v) => { if (Array.isArray(v)) v.pop(); return 0 }\nexport const f = (c) => g(c ? a : 7) + a[0]`, null, 'a'), null, 'popped by a callee the join reaches')
  is(fixedLen(`const a = [1, 2, 3]\nconst holder = []\nexport const f = (c) => { holder.push(c ? a : 'q'); const h = holder[0]; if (Array.isArray(h)) h.length = 1; return a[0] }`, null, 'a'), null, 'resized out of an element')
})

test('fixed length: arrays that meet share one count or none', () => {
  const two = `const a = [1, 2, 3], b = [4, 5, 6]
    const first = (v) => v[0]
    export const f = () => first(a) + first(b)`
  is(fixedLen(two, null, 'a'), 3)
  is(fixedLen(two, 'first', 'v'), 3, 'a parameter holds its arguments\' count')
  const mixed = `const a = [1, 2, 3], b = [1, 2, 3, 4]
    const first = (v) => v[0]
    export const f = () => first(a) + first(b)`
  is(fixedLen(mixed, null, 'a'), null, 'two counts in one parameter')
  is(fixedLen(mixed, 'first', 'v'), null)
  is(fixedLen(`const a = [1, 2, 3]\nconst b = [...a, 4], c = a.map(x => x * 2), d = Array.from(a)\nexport const f = () => b[0] + c[0] + d[0]`, null, 'a'), 3, 'a copy is an array of its own')
  for (const name of ['b', 'd'])
    is(fixedLen(`const a = [1, 2, 3]\nconst b = [...a, 4], c = a.map(x => x * 2), d = Array.from(a)\nexport const f = () => b[0] + c[0] + d[0]`, null, name), null, `${name}: built by something other than a plain literal`)
  // (a map makes an element for each of its receiver's, test/element-numbers.js)
  is(fixedLen(`const a = [1, 2, 3]\nconst b = [...a, 4], c = a.map(x => x * 2), d = Array.from(a)\nexport const f = () => b[0] + c[0] + d[0]`, null, 'c'), 3, 'c: a map of an array of one count')
})

test('fixed length: a counted loop bounds the index it stores at', () => {
  is(fixedLen(`const n = [0, 0, 0]
    for (let axis = 0; axis < 3; axis++) n[axis] = axis * 2
    export const f = () => n[1]`, null, 'n'), 3, 'a counter under the count')
  is(fixedLen(`const n = [0, 0, 0]
    for (let axis = 0; axis <= 3; axis++) n[axis] = axis * 2
    export const f = () => n[1]`, null, 'n'), null, 'a counter reaching the count')
  is(fixedLen(`const N = 4
    const m = [0, 0, 0, 0, 0, 0, 0, 0]
    for (let r = 0; r < N; r++) { m[r * 2] = r; m[r * 2 + 1] = -r }
    export const f = () => m[3]`, null, 'm'), 8, 'a product and a sum of counters and constants')
  is(fixedLen(`const n = [0, 0, 0]
    for (let i = 0; i < 3; i++) { n[i] = 1; i = i + 1 }
    export const f = () => n[1]`, null, 'n'), null, 'a counter the body assigns is no bound')
})

const kernels = [
  ['vec3 add through a helper', `const a = [1, 2, 3], b = [4, 5, 6], out = [0, 0, 0]
    const add = (o, x, y) => { o[0] = x[0] + y[0]; o[1] = x[1] + y[1]; o[2] = x[2] + y[2]; return o }
    export const f = (k) => { add(out, a, b); add(out, out, a); return out[0] * k + out[1] + out[2] }`, [2]],
  ['an operand that is the output', `const v = [1, 2, 3]
    const scale = (o, x, s) => { o[0] = x[0] * s; o[1] = x[1] * s; o[2] = x[2] * s; return o }
    export const f = (k) => { scale(v, v, k); scale(v, v, k); return v[0] + v[1] + v[2] }`, [3]],
  ['a read past the count', `const a = [1, 2, 3]
    const g = (v, i) => v[i]
    export const f = (i) => { const x = g(a, i); return x === undefined ? -1 : x }`, [5]],
  ['a read at a negative index', `const a = [1, 2, 3]
    const g = (v, i) => v[i]
    export const f = (i) => { const x = g(a, i); return x === undefined ? -1 : x }`, [-1]],
  ['a literal read past the count', `const a = [1, 2, 3]\nexport const f = () => { const x = a[3]; return x === undefined ? -1 : x }`, []],
  ['the length', `const a = [1, 2, 3]\nconst n = (v) => v.length\nexport const f = () => n(a)`, []],
  ['a list of vec3 built by push', `const ps = []
    for (let i = 0; i < 8; i++) ps.push([i, i * 2, i * 3])
    export const f = (k) => { let s = 0; for (let i = 0; i < 8; i++) { const p = ps[i]; p[0] = p[0] + k; p[2] = p[1] * p[0]; s += p[0] + p[1] + p[2] } return s }`, [2]],
  ['a vec3 held by an object', `const pl = { normal: [0, 1, 0], constant: 2 }
    export const f = (x) => { pl.normal[0] = x; pl.normal[2] = pl.normal[0] * 2; return pl.normal[0] + pl.normal[1] + pl.normal[2] + pl.constant }`, [4]],
  ['strings', `const names = ['a', 'bb', 'ccc']\nconst pick = (v, i) => v[i]\nexport const f = () => pick(names, 1).length + names[2].length`, []],
  ['mixed kinds stored', `const box = [0, 0]\nexport const f = (k) => { box[0] = k; box[1] = 'x'; return typeof box[1] === 'string' ? box[0] + 1 : -1 }`, [5]],
  ['a closure writes the array it captures', `const state = [0, 0]
    const bump = () => { state[0] = state[0] + 1; state[1] = state[0] * 2 }
    export const f = () => { bump(); bump(); return state[0] + state[1] }`, []],
  ['NaN, infinities and negative zero', `const v = [0, 0, 0, 0]
    export const f = (k) => { v[0] = k / 0; v[1] = -k / 0; v[2] = 0 / 0; v[3] = -0; return (v[0] === Infinity ? 1 : 0) + (v[1] === -Infinity ? 10 : 0) + (v[2] !== v[2] ? 100 : 0) + (1 / v[3] === -Infinity ? 1000 : 0) }`, [1]],
  ['a counted loop over a matrix', `const create = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
    const m = create(), n = create(), o = create()
    const mul = (out, a, b) => { for (let r = 0; r < 4; r++) { const b0 = b[r * 4], b1 = b[r * 4 + 1], b2 = b[r * 4 + 2], b3 = b[r * 4 + 3]; out[r * 4] = b0 * a[0] + b1 * a[4] + b2 * a[8] + b3 * a[12]; out[r * 4 + 1] = b0 * a[1] + b1 * a[5] + b2 * a[9] + b3 * a[13]; out[r * 4 + 2] = b0 * a[2] + b1 * a[6] + b2 * a[10] + b3 * a[14]; out[r * 4 + 3] = b0 * a[3] + b1 * a[7] + b2 * a[11] + b3 * a[15] } return out }
    export const f = (k) => { m[12] = k; n[13] = k * 2; mul(o, m, n); return o[12] + o[13] * 10 + o[0] }`, [3]],
]

test('fixed length: kernels over such arrays match the host', () => {
  for (const [name, src, args] of kernels)
    for (const optimize of levels(0, 1, 2, 3, 'size')) agree(src, 'f', args, { optimize }, `${name} at ${optimize}`)
})

test('fixed length: a store to a missing receiver throws as the host does', () => {
  const src = `const ps = [[1, 2], [3, 4]]
    const put = (p, k) => { p[0] = k; return p[0] }
    export const f = (i, k) => { try { return put(ps[i], k) } catch (e) { return e instanceof TypeError ? -1 : -2 } }`
  for (const optimize of levels(0, 2)) {
    agree(src, 'f', [1, 9], { optimize }, `an element that is there at ${optimize}`)
    agree(src, 'f', [5, 9], { optimize }, `an element that is not at ${optimize}`)
  }
})

test('fixed length: reads and stores inside the count call no helper', () => {
  const src = `const a = [1, 2, 3], b = [4, 5, 6], out = [0, 0, 0]
    const add = (o, x, y) => { o[0] = x[0] + y[0]; o[1] = x[1] + y[1]; o[2] = x[2] + y[2]; return o }
    export const f = () => { add(out, a, b); return out[0] + out[1] + out[2] }`
  for (const optimize of levels(2, 3)) {
    const body = funcWat(wat(src, { optimize }), 'f')
    ok(!/__arr_set_idx_ptr|__ptr_offset|__arr_idx/.test(body), `no store, forward or index helper at ${optimize}`)
    // Three element stores: two of them pack into one v128 store at the speed tiers (SLP).
    is((body.match(/f64\.store/g) || []).length + 2 * (body.match(/v128\.store/g) || []).length, 3, 'three stores, scalar or packed')
  }
})

// The reset keeps its meaning: a durable array stored to directly is saved
// before the round's first store and restored by `__jz_clear`.
test('fixed length: a reset restores a durable array stored to directly', () => {
  const src = `const out = [1, 2, 3]
    const ps = []
    for (let i = 0; i < 300; i++) ps.push([i, i])
    export const bump = (k) => { out[0] = out[0] + k; out[2] = out[2] * 2; let s = out[0] + out[2]; for (let i = 0; i < 300; i++) { const p = ps[i]; p[1] = p[1] + k; s += p[1] } return s }`
  let base = 0; for (let i = 0; i < 300; i++) base += i
  for (const optimize of levels(0, 2)) {
    const { exports, memory } = jz(src, { optimize })
    is(exports.bump(1), 2 + 6 + base + 300, `round 1 at ${optimize}`)
    is(exports.bump(1), 3 + 12 + base + 600, 'a second call builds on the first')
    memory.reset()
    is(exports.bump(1), 2 + 6 + base + 300, 'round 2 starts from what module init left')
  }
})

// A block storing a durable fixed-length array (three's Matrix4.compose: `const
// te = this.elements`, sixteen products, then `te[0] = …`) saves it where it
// binds it, before the products: the save's call no longer stands among their
// live values.
test('fixed length: a block saves its durable array where it binds it', () => {
  const src = `class M {
    constructor() { this.elements = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }
    scale(s, t) {
      const te = this.elements
      const a = te[0] * s, b = te[5] * s, c = te[10] * s, d = te[12] + t, e = te[13] + t
      te[0] = a; te[5] = b; te[10] = c; te[12] = d; te[13] = e
      return this
    }
  }
  const m = new M()
  export const f = (s, t) => { m.scale(s, t); const e = m.elements; return e[0] + e[5] + e[10] + e[12] + e[13] }`
  for (const optimize of levels(0, 2)) {
    const { exports, memory } = jz(src, { optimize })
    is(exports.f(2, 1), 2 + 2 + 2 + 1 + 1, `round 1 at ${optimize}`)
    is(exports.f(2, 1), 4 + 4 + 4 + 2 + 2, 'a second call builds on the first')
    memory.reset()
    is(exports.f(2, 1), 2 + 2 + 2 + 1 + 1, 'round 2 starts from what module init left')
  }
  if (belowOpt(2)) return
  // (the method spliced into `f`, or a function of its own; the save's test reads the bitmap of saved arrays)
  const text = wat(src, { optimize: 2 }), body = text.split(/\n(?=  \(func )/).find(fn => /f64\.mul/.test(fn) && /__durable_arr_seen/.test(fn)) ?? ''
  const save = body.indexOf('__durable_arr_seen'), product = body.indexOf('f64.mul')
  ok(save > 0 && product > save, 'the save comes before the first product')
})

// An array frozen after module init: built at a count and grown only by pushes
// at the module's top level through its own const name, inside counted loops.
// Its const binding holds the final pointer, so reads through it after init
// skip the forwarding follow and know the length.
const frozenLen = (src, name) => { compile(src, { optimize: 0 }); return ctx.summary.at(undefined).frozenLenOf(name) }

test('frozen length: counted top-level pushes through the binding fix the length', () => {
  is(frozenLen(`const ps = []\nfor (let i = 0; i < 100; i++) ps.push([i, i * 2, i * 3])\nexport const f = () => ps[3][1]`, 'ps'), 100)
  is(frozenLen(`const N = 4\nconst ps = []\nfor (let i = 0; i < N; i++) for (let j = 0; j < 3; j++) { ps.push(i * 10 + j); ps.push(-j) }\nexport const f = () => ps[5]`, 'ps'), 24, 'two pushes per pass of nested loops')
  is(frozenLen(`const ps = [7, 8]\nfor (let i = 0; i < 5; i++) ps.push(i)\nexport const f = () => ps[6]`, 'ps'), 7, 'a literal start counts')
  const none = (body, why) => is(frozenLen(`const ps = []\n${body}\nexport const f = (v) => ps[0]`, 'ps'), null, why)
  none('for (let i = 0; i < 10; i++) if (i % 2) ps.push(i)', 'a push under a condition')
  none('const add = (v) => ps.push(v)\nfor (let i = 0; i < 10; i++) add(i)', 'a push inside a function')
  none('for (let i = 0; i < 10; i++) ps.push(i)\nexport const g = (v) => ps.push(v)', 'a push at runtime')
  none('const alias = ps\nfor (let i = 0; i < 10; i++) alias.push(i)', 'pushes through another name')
  none('for (let i = 0; i < 10; i++) ps.push(i)\nps.pop()', 'a pop after the pushes')
  none('for (let i = 0; i < 10; i++) ps.push(...[i, i])', 'a spread push')
})

test('frozen length: reads through the binding match the host, past the length and across relocation', () => {
  const kernels = [
    ['vec3 list', `const ps = []
      for (let i = 0; i < 100; i++) ps.push([i, i * 2, i * 3])
      export const f = () => { let s = 0; for (let i = 0; i < 100; i++) { const p = ps[i]; s += p[0] + p[1] * p[2] } return s }`, []],
    ['a read past the length', `const ps = []
      for (let i = 0; i < 10; i++) ps.push(i)
      export const f = (k) => { const v = ps[k]; return v === undefined ? -1 : v }`, [12]],
    ['a thousand pushes relocate the array', `const ps = []
      for (let i = 0; i < 1000; i++) ps.push(i * 0.5)
      export const f = () => { let s = 0; for (let i = 0; i < 1000; i++) s += ps[i]; return s }`, []],
    ['elements written in place', `const ps = []
      for (let i = 0; i < 50; i++) ps.push([i, i])
      export const f = (k) => { for (let i = 0; i < 50; i++) { const p = ps[i]; p[1] = p[0] * k } let s = 0; for (let i = 0; i < 50; i++) s += ps[i][1]; return s }`, [3]],
  ]
  for (const [name, src, args] of kernels)
    for (const optimize of levels(0, 1, 2, 3, 'size')) agree(src, 'f', args, { optimize }, `${name} at ${optimize}`)
})

test('frozen length: a read through the binding follows no forward and loads no length', () => {
  const src = `const ps = []
    for (let i = 0; i < 100; i++) ps.push([i, i * 2, i * 3])
    export const f = () => { let s = 0; for (let i = 0; i < 100; i++) { const p = ps[i]; s += p[0] + p[1] * p[2] } return s }`
  for (const optimize of levels(2, 3)) {
    const body = funcWat(wat(src, { optimize }), 'f')
    ok(!/__ptr_offset|i32\.load|__throw_property_nullish/.test(body), `only element loads at ${optimize}`)
  }
})

// The count is the pushes' own: a store of the module's own statements at or past what the array
// was constructed with may make it longer by a number no push counts (summary `initStored`). Read
// by the constructed count, not by what the pushes gave so far: a loop's pushes are counted whole
// as its first is walked, ahead of a store in the same loop that the first round runs short of them.
// Before, `const ps = []; ps[3] = 1` and four pushes read as four elements: `ps[7]` was undefined.
const STORED = [
  ['a store before the pushes', `const ps = []\nps[3] = 1\nfor (let i = 0; i < 4; i++) ps.push(i)`, 7],
  ['a store between the pushes, past what they gave', `const ps = [1, 2]\nfor (let i = 0; i < 3; i++) ps.push(i)\nps[6] = 9\nfor (let i = 0; i < 3; i++) ps.push(i + 10)`, 9],
  ['a loop of stores between the pushes, from its third element on', `const ps = []\nfor (let i = 0; i < 4; i++) ps.push(i)\nfor (let i = 2; i < 8; i++) ps[i] = i * 3\nfor (let i = 0; i < 4; i++) ps.push(i)`, 11],
  ['a store in the loop that pushes, past its first rounds', `const ps = []\nfor (let i = 0; i < 4; i++) { ps.push(i); ps[3] = 0 }`, 6],
  ['a store ahead of the push of its round', `const ps = []\nfor (let i = 0; i < 4; i++) { ps[i] = 0; ps.push(7) }`, 4],
  ['a store by a key the walk cannot bound', `const ps = []\nlet k = 2\nk += k\nps[k] = 1\nfor (let i = 0; i < 4; i++) ps.push(i)`, 8],
]
test('frozen length: a store of the module\'s own statements past what the array was made with takes the count back', () => {
  for (const [name, body, last] of STORED) {
    const src = `${body}\nexport const f = () => { const v = ps[${last}]; return ps.length * 1000 + (v === undefined ? 500 : v) }`
    is(frozenLen(src, 'ps'), null, name)
    for (const optimize of levels(0, 2, 3, 'size', 'speed')) agree(src, 'f', [], { optimize }, `${name} at ${optimize}`)
  }
  is(frozenLen(`const ps = [1, 2, 3]\nps[1] = 9\nfor (let i = 0; i < 4; i++) ps.push(i)\nexport const f = () => ps[6]`, 'ps'), 7, 'a store inside the constructed count leaves it')
})

// The frozen length is the array's once the initializers are done with it. A
// function a statement runs before the last of the pushes reads the array short
// of that count, under whatever name it holds it: an index past what is pushed
// so far is undefined there (summary `short`, settleInitOrder). The module's own
// statements read the array by what it holds as they run.
const PEEK = `(k) => { const v = ps[k]; return v === undefined ? 1000 : v }`
const PUSHES = `for (let i = 0; i < 10; i++) ps.push(i)`
const readShort = [
  ['a function called before the pushes', `const ps = []\nconst g = ${PEEK}\nconst e = g(4)\n${PUSHES}\nexport const f = () => e + g(3)`],
  ['one the pushing statement calls', `const ps = []\nconst g = ${PEEK}\nfor (let i = 0; i < 10; i++) ps.push(g(9 - i) + i)\nexport const f = () => ps[0] + ps[9]`],
  ['one called between two runs of pushes', `const ps = []\nconst g = ${PEEK}\nfor (let i = 0; i < 5; i++) ps.push(i)\nconst e = g(7)\nfor (let i = 5; i < 10; i++) ps.push(i)\nexport const f = () => e + g(7)`],
  ['a literal start', `const ps = [1, 2]\nconst g = ${PEEK}\nconst e = g(1) * 10 + g(5)\n${PUSHES}\nexport const f = () => e + g(5)`],
  ['a function that calls the reader', `const ps = []\nconst g = ${PEEK}\nconst h = (k) => g(k) + 1\nconst e = h(4)\n${PUSHES}\nexport const f = () => e + h(3)`],
  ['a function handed it as an argument', `const ps = []\nconst g = (xs, k) => { const v = xs[k]; return v === undefined ? 1000 : v }\nconst e = g(ps, 4)\n${PUSHES}\nexport const f = () => e + g(ps, 3)`],
  ['a closure an array holds', `const ps = []\nconst cb = [${PEEK}]\nconst e = cb[0](4)\n${PUSHES}\nexport const f = () => e + cb[0](3)`],
  ['a closure an object holds', `const ps = []\nconst o = { peek: ${PEEK} }\nconst e = o.peek(4)\n${PUSHES}\nexport const f = () => e + o.peek(3)`],
  ['a callback handed to a function', `const ps = []\nconst g = ${PEEK}\nconst run = (fn) => fn(4)\nconst e = run(g)\n${PUSHES}\nexport const f = () => e + run(g)`],
  ['a method', `const ps = []\nclass P { at(k) { const v = ps[k]; return v === undefined ? 1000 : v } }\nconst p = new P()\nconst e = p.at(4)\n${PUSHES}\nexport const f = () => e + p.at(3)`],
  ['a method the pushing statement calls', `const ps = []\nclass P { at(k) { const v = ps[k]; return v === undefined ? 1000 : v } }\nconst p = new P()\nfor (let i = 0; i < 10; i++) ps.push(p.at(9 - i) + i)\nexport const f = () => ps[0] + ps[9]`],
  ['a constructor', `const ps = []\nclass P { constructor(k) { const v = ps[k]; this.v = v === undefined ? 1000 : v } }\nconst p = new P(4)\n${PUSHES}\nexport const f = () => p.v + new P(3).v`],
  ['a static method', `const ps = []\nclass P { static at(k) { const v = ps[k]; return v === undefined ? 1000 : v } }\nconst e = P.at(4)\n${PUSHES}\nexport const f = () => e + P.at(3)`],
  ['a getter', `const ps = []\nclass P { get four() { const v = ps[4]; return v === undefined ? 1000 : v } }\nconst p = new P()\nconst e = p.four\n${PUSHES}\nexport const f = () => e + p.four`],
  ['a static getter', `const ps = []\nclass P { static get four() { const v = ps[4]; return v === undefined ? 1000 : v } }\nconst e = P.four\n${PUSHES}\nexport const f = () => e + P.four`],
  ['a getter a subclass inherits', `const ps = []\nclass B { get four() { const v = ps[4]; return v === undefined ? 1000 : v } }\nclass P extends B {}\nconst p = new P()\nconst e = p.four\n${PUSHES}\nexport const f = () => e + p.four`],
  ['a method a subclass inherits, called by one of its own', `const ps = []\nclass B { at(k) { const v = ps[k]; return v === undefined ? 1000 : v } }\nclass P extends B { twice(k) { return this.at(k) * 2 } }\nconst p = new P()\nconst e = p.twice(4)\n${PUSHES}\nexport const f = () => e + p.twice(3)`],
  ['a method under a computed name', `const ps = []\nclass P { at(k) { const v = ps[k]; return v === undefined ? 1000 : v } }\nconst p = new P()\nconst name = 'at'\nconst e = p[name](4)\n${PUSHES}\nexport const f = () => e + p.at(3)`],
  ['a callback handed to an array\'s method', `const ps = []\nlet e = 0;\n[4, 5].forEach((k) => { const v = ps[k]; e += v === undefined ? 1000 : v })\n${PUSHES}\nexport const f = () => e + ps[4]`],
  ['a method taken as a value', `const ps = []\nclass P { at(k) { const v = ps[k]; return v === undefined ? 1000 : v } }\nconst p = new P()\nconst m = p.at\nconst e = m(4)\n${PUSHES}\nexport const f = () => e + p.at(3)`],
  ['a method handed to a function', `const ps = []\nclass P { at(k) { const v = ps[k]; return v === undefined ? 1000 : v } }\nconst p = new P()\nconst run = (fn) => fn(4)\nconst e = run(p.at)\n${PUSHES}\nexport const f = () => e + p.at(3)`],
  ['a method handed to an array\'s method', `const ps = []\nclass P { at(k) { const v = ps[k]; return v === undefined ? 1000 : v } }\nconst p = new P()\nconst e = [4, 5].map(p.at)\n${PUSHES}\nexport const f = () => e[0] + e[1] + p.at(3)`],
  ['a method of an object a computed key reads', `const ps = []\nclass P { at(k) { const v = ps[k]; return v === undefined ? 1000 : v } }\nconst table = { go: null }\ntable.go = new P()\nconst key = ['go']\nconst e = table[key[0]].at(4)\n${PUSHES}\nexport const f = () => e + table.go.at(3)`],
  ['an iterator a loop walks', `const ps = []\nclass Bag { constructor() { this.n = 3 } [Symbol.iterator]() { let i = 0; const n = this.n; return { next: () => { const v = ps[i]; return i++ < n ? { done: false, value: v === undefined ? 1000 : v } : { done: true, value: undefined } } } } }\nconst b = new Bag()\nlet e = 0\nfor (const v of b) e += v\n${PUSHES}\nexport const f = () => e`],
  ['a generator a spread walks', `const ps = []\nclass Bag { constructor() { this.n = 3 } *[Symbol.iterator]() { for (let i = 0; i < this.n; i++) { const v = ps[i]; yield (v === undefined ? 1000 : v) } } }\nconst b = new Bag()\nconst got = [...b]\n${PUSHES}\nexport const f = () => got[0] + got[1] + got[2] + [...b][2]`],
  ['a conversion an operator runs', `const ps = [1, 2, 3, 4]\nclass P { at(k) { const v = ps[k]; return v === undefined ? 1000 : v } valueOf() { return this.at(4) + this.at(5) * 10 + this.at(6) * 100 + this.at(7) * 1000 } }\nconst p = new P()\nconst e = p * 2\n${PUSHES}\nexport const f = () => e + p.at(3)`],
  ['a conversion to a string', `const ps = [1, 2, 3, 4]\nclass P { at(k) { const v = ps[k]; return v === undefined ? 1000 : v } toString() { return 'x' + this.at(4) + this.at(5) } }\nconst p = new P()\nconst e = ('' + p).length\n${PUSHES}\nexport const f = () => e + p.at(3)`],
  ['a method among values of several kinds, called', `const ps = []\nclass P { at(k) { const v = ps[k]; return v === undefined ? 1000 : v } }\nconst p = new P()\nconst mixed = [1, 'a', p.at]\nconst e = mixed[2](4)\n${PUSHES}\nexport const f = () => e + p.at(3)`],
  ['a method among values of several kinds, handed to an array\'s method', `const ps = []\nclass P { at(k) { const v = ps[k]; return v === undefined ? 1000 : v } }\nconst p = new P()\nconst mixed = [1, 'a', p.at]\nconst e = [4, 5].map(mixed[2])\n${PUSHES}\nexport const f = () => e[0] + e[1] + p.at(3)`],
  ['a method a call answers, handed to an array\'s method', `const ps = []\nclass P { at(k) { const v = ps[k]; return v === undefined ? 1000 : v } }\nconst p = new P()\nconst pick = () => p.at\nconst e = [4, 5].map(pick())\n${PUSHES}\nexport const f = () => e[0] + e[1] + p.at(3)`],
  ['a method behind a closure a stored member holds, called by the pushes', `const ps = []\nclass P { at(k) { const v = ps[k]; return v === undefined ? 1000 : v } }\nconst p = new P()\nconst mixed = [1, 'a', p.at]\nconst o = {}\no.go = (k) => mixed[2](k)\nfor (let i = 0; i < 10; i++) ps.push(o.go(9 - i) + i)\nexport const f = () => ps[0] + ps[9]`],
  ['a closure an inline list holds, handed to a method of an array', `const ps = []\nconst g = ${PEEK}\nconst e = [4, 5].map([g][0])\n${PUSHES}\nexport const f = () => e[0] + e[1] + g(3)`],
  ['a method an inline list holds, handed to a method of an array', `const ps = []\nclass P { at(k) { const v = ps[k]; return v === undefined ? 1000 : v } }\nconst p = new P()\nconst e = [4, 5].map([p.at][0])\n${PUSHES}\nexport const f = () => e[0] + e[1] + p.at(3)`],
  ['a getter of an object literal', `const ps = []\nconst o = { get four() { const v = ps[4]; return v === undefined ? 1000 : v } }\nconst e = o.four\n${PUSHES}\nexport const f = () => e + o.four`],
  ['a conversion of an object literal', `const ps = []\nconst o = { valueOf() { const v = ps[4]; return v === undefined ? 1000 : v } }\nconst e = o * 2\n${PUSHES}\nexport const f = () => e + o * 1`],
  ['an iterator of a class, walked through a value of any kind', `const ps = []\nclass Bag { [Symbol.iterator]() { let i = 0; return { next: () => { const v = ps[i]; return i++ < 3 ? { done: false, value: v === undefined ? 1000 : v } : { done: true, value: undefined } } } } }\nconst boxes = { any: null }\nboxes.any = new Bag()\nlet e = 0\nfor (const v of boxes.any) e += v\n${PUSHES}\nexport const f = () => e`],
  ['an iterator Array.from walks', `const ps = []\nclass Bag { [Symbol.iterator]() { let i = 0; return { next: () => { const v = ps[i]; return i++ < 3 ? { done: false, value: v === undefined ? 1000 : v } : { done: true, value: undefined } } } } }\nconst b = new Bag()\nconst got = Array.from(b)\n${PUSHES}\nexport const f = () => got[0] + got[1] + got[2]`],
  ['an iterator a Set is made from', `const ps = []\nclass Bag { [Symbol.iterator]() { let i = 0; return { next: () => { const v = ps[i]; return i++ < 3 ? { done: false, value: v === undefined ? 1000 : v } : { done: true, value: undefined } } } } }\nconst b = new Bag()\nconst got = new Set(b)\n${PUSHES}\nexport const f = () => got.size * 10000 + (got.has(1000) ? 1 : 0)`],
  ['an iterator a destructuring walks', `const ps = []\nclass Bag { [Symbol.iterator]() { let i = 0; return { next: () => { const v = ps[i]; return i++ < 3 ? { done: false, value: v === undefined ? 1000 : v } : { done: true, value: undefined } } } } }\nconst b = new Bag()\nconst [x, y] = b\n${PUSHES}\nexport const f = () => x + y`],
  ['a generator another delegates to', `const ps = []\nclass Bag { *[Symbol.iterator]() { for (let i = 0; i < 3; i++) { const v = ps[i]; yield (v === undefined ? 1000 : v) } } }\nconst b = new Bag()\nconst all = function* () { yield* b }\nlet e = 0\nfor (const v of all()) e += v\n${PUSHES}\nexport const f = () => e`],
  ['an iterator spread into the arguments of Math, through a value of any kind', `const ps = []\nclass Bag { [Symbol.iterator]() { let i = 0; return { next: () => { const v = ps[i]; return i++ < 3 ? { done: false, value: v === undefined ? 1000 : v } : { done: true, value: undefined } } } } }\nconst boxes = { any: null }\nboxes.any = new Bag()\nconst e = Math.max(...boxes.any)\n${PUSHES}\nexport const f = () => e`],
  ['a method behind a closure handed to a function', `const ps = []\nclass P { at(k) { const v = ps[k]; return v === undefined ? 1000 : v } }\nconst p = new P()\nconst m = (k) => p.at(k)\nconst run = (fn) => fn(4)\nconst e = run(m)\n${PUSHES}\nexport const f = () => e + m(3)`],
]
// Each of these keeps its count: what runs before the last push holds no such array.
const readWhole = [
  ['a function the pushes call that holds another array', `const qs = [3, 4]\nconst ps = []\nconst g = (k) => qs[k & 1] * k\nfor (let i = 0; i < 10; i++) ps.push(g(i))\nexport const f = () => { let s = 0; for (let i = 0; i < 10; i++) s += ps[i]; return s }`],
  ['a reader called once the pushes are done', `const ps = []\nconst g = ${PEEK}\n${PUSHES}\nconst e = g(4) + g(12)\nexport const f = () => e + g(3)`],
  ['a method the pushes call, beside one that reads the array and runs later', `const ps = []\nclass R { constructor() { this.s = 1 } next() { this.s = (this.s * 5 + 3) % 16; return this.s } at(k) { const v = ps[k]; return v === undefined ? 1000 : v } }\nconst r = new R()\nfor (let i = 0; i < 10; i++) ps.push(r.next())\nexport const f = () => r.at(3) + r.at(12)`],
  ['a class\'s method of the name the pushes go by', `const ps = []\nclass Q { constructor() { this.n = 0 } push(k) { const v = ps[k]; this.n += v === undefined ? 1000 : v } }\n${PUSHES}\nconst q = new Q()\nq.push(3)\nq.push(12)\nexport const f = () => q.n`],
  ['a reader made before the pushes, which call a method of a class', `const ps = []\nclass R { constructor() { this.s = 1 } next() { this.s = (this.s * 5 + 3) % 16; return this.s } }\nconst r = new R()\nconst g = ${PEEK}\nfor (let i = 0; i < 10; i++) ps.push(r.next())\nexport const f = () => g(3) + g(12)`],
  ['a closure an object holds, never called, beside the pushes\' call of a class\'s method', `const ps = []\nclass R { constructor() { this.s = 1 } next() { this.s = (this.s * 5 + 3) % 16; return this.s } }\nconst r = new R()\nconst o = { peek: ${PEEK} }\nfor (let i = 0; i < 10; i++) ps.push(r.next())\nexport const f = () => o.peek(3) + o.peek(12)`],
  ['a getter of a class with no instance until the pushes are done', `const ps = []\nclass P { get four() { const v = ps[4]; return v === undefined ? 1000 : v } }\n${PUSHES}\nconst p = new P()\nexport const f = () => p.four + 1`],
  ['a call nothing names, beside a method never taken as a value', `const ps = []\nclass P { at(k) { const v = ps[k]; return v === undefined ? 1000 : v } }\nconst mixed = [1, 'a', (k) => k + 1]\nconst e = mixed[2](4)\n${PUSHES}\nconst p = new P()\nexport const f = () => e + p.at(3) + p.at(12)`],
  ['an iteration nothing names, beside a method taken as a value and not called', `const ps = []\nclass P { at(k) { const v = ps[k]; return v === undefined ? 1000 : v } }\nclass Bag { [Symbol.iterator]() { let i = 0; return { next: () => i++ < 2 ? { done: false, value: i } : { done: true, value: undefined } } } }\nconst p = new P()\nconst m = p.at\nlet e = 0\nfor (const v of new Bag()) e += v\n${PUSHES}\nexport const f = () => e + m(3) + m(12)`],
  ['Math handed what no kind names, beside a reader an object holds', `const ps = []\nconst o = { peek: ${PEEK} }\nconst h = (x) => Math.min(9, x[0])\nconst e = h([5, 6]) + h(new Float64Array(2))\n${PUSHES}\nexport const f = () => e + o.peek(3) + o.peek(12)`],
  ['a method of an array handed what a function of the module returns', `const ps = []\nconst o = { peek: ${PEEK} }\nconst fib = (n) => n < 2 ? n : fib(n - 1) + fib(n - 2)\nlet k = 3\nk += 1\nconst e = [1, 2, 3].indexOf(fib(k))\n${PUSHES}\nexport const f = () => e + o.peek(3) + o.peek(12)`],
  ['a method of an array handed what Math returns', `const ps = []\nconst o = { peek: ${PEEK} }\nlet k = 2.5\nk += 1\nconst e = [1, 2, 3].indexOf(Math.floor(k))\n${PUSHES}\nexport const f = () => e + o.peek(3) + o.peek(12)`],
  ['the module reading it as it grows', `const ps = []\nlet e = 0\nfor (let i = 0; i < 10; i++) { const v = ps[9 - i]; e += v === undefined ? 1000 : v; ps.push(i) }\nconst g = ${PEEK}\nexport const f = () => e + g(3) + g(11)`],
]

test('frozen length: an array a function holds before the last push is no frozen one', () => {
  for (const [name, src] of readShort) is(frozenLen(src, 'ps'), null, name)
  for (const [name, src] of readWhole) is(frozenLen(src, 'ps'), 10, name)
})

test('frozen length: a read before the last push is the host\'s, in a function and in the module', () => {
  for (const [name, src] of [...readShort, ...readWhole])
    for (const optimize of levels(0, 2, 3, 'size')) agree(src, 'f', [], { optimize }, `${name} at ${optimize}`)
})

// An array a function builds, a literal grown by pushes through its name alone,
// each inside counted loops of one trip count and named by nothing else until
// the pushes end, has that many elements wherever it is read
// (summary `builds`, query builtLenOf): the length of a design function's
// sections is a number, and a loop bounded by it runs that many times.
const builtLen = (src, scope, name) => {
  compile(src, { optimize: 0 })
  const fn = ctx.funcs.map.get(scope)
  const spelled = JSON.stringify(fn.body).match(new RegExp('"' + name + '[^"A-Za-z0-9_$][^"]*"'))?.[0]
  return ctx.summary.at(fn.body).builtLenOf(spelled ? JSON.parse(spelled) : name)
}
const use = `const use = (xs) => { let s = 0; for (let i = 0; i < xs.length; i++) s += xs[i]; return s * 100 + xs.length }`
const built = [
  ['one push a pass', `const make = (n) => { const out = []; for (let i = 0; i < n; i++) out.push(i * 2); return out }
    ${use}\nexport const f = () => use(make(5))`, 5],
  ['nested loops, two arguments, a literal start', `const make = (n) => { const out = [7]; for (let i = 0; i < n; i++) for (let j = 0; j < 3; j++) out.push(i, j); return out }
    ${use}\nexport const f = () => use(make(4))`, 25],
  ['a bound the module holds', `const N = 6\nconst make = () => { const out = []; for (let i = 0; i <= N; i++) out.push(i); return out }
    ${use}\nexport const f = () => use(make())`, 7],
]
const unbuilt = [
  ['a push under a condition', `const make = (n) => { const out = []; for (let i = 0; i < n; i++) if (i % 2) out.push(i); return out }\n${use}\nexport const f = () => use(make(5))`],
  ['a loop that may leave early', `const make = (n) => { const out = []; for (let i = 0; i < n; i++) { if (i > 2) break; out.push(i) } return out }\n${use}\nexport const f = () => use(make(5))`],
  ['a loop that may skip a push', `const make = (n) => { const out = []; for (let i = 0; i < n; i++) { if (i === 1) continue; out.push(i) } return out }\n${use}\nexport const f = () => use(make(5))`],
  ['a stride', `const make = (n) => { const out = []; for (let i = 0; i < n; i += 2) out.push(i); return out }\n${use}\nexport const f = () => use(make(5))`],
  ['calls passing two counts', `const make = (n) => { const out = []; for (let i = 0; i < n; i++) out.push(i); return out }\n${use}\nexport const f = () => use(make(5)) + use(make(6))`],
  ['a count reassigned in the body', `const make = (n) => { const out = []; for (let i = 0; i < n; i++) { out.push(i); n = n - 1 } return out }\n${use}\nexport const f = () => use(make(6))`],
  ['named before it is whole', `let held = null\nconst peek = () => held ? held.length : -1\nconst make = (n) => { const out = []; held = out; for (let i = 0; i < n; i++) out.push(peek()); return out }\n${use}\nexport const f = () => use(make(4))`],
  ['resized by its reader', `const make = (n) => { const out = []; for (let i = 0; i < n; i++) out.push(i); return out }
    const use = (xs) => { xs.push(9); let s = 0; for (let i = 0; i < xs.length; i++) s += xs[i]; return s * 100 + xs.length }\nexport const f = () => use(make(5))`],
  ['joined with another array', `const make = (n) => { const out = []; for (let i = 0; i < n; i++) out.push(i); return out }\n${use}\nexport const f = (c) => use(c > 0 ? make(5) : [1, 2])`],
]

test('built length: counted pushes before anything else names the array give its length to another function', () => {
  for (const [name, src, len] of built) is(builtLen(src, 'use', 'xs'), len, name)
  for (const [name, src] of unbuilt) is(builtLen(src, 'use', 'xs'), null, name)
  is(builtLen(built[0][1], 'make', 'out'), 5, 'the builder\'s own mentions of it follow the pushes')
  // (a function declared in the body stands ahead of the array, and an arrow may name a `const` declared after it)
  const between = (peek, after = '') => `const u = (v) => v === undefined ? 1000 : v\nconst make = (n) => {\n${peek}\nconst out = []\nlet seen = 0\nfor (let i = 0; i < n; i++) { seen += sum(); out.push(i) }\n${after}\nreturn seen + sum() + out.length }\nexport const f = () => make(5)`
  const SUMS = `{ let s = 0; for (let j = 0; j < 5; j++) s += u(out[j]); return s }`
  is(builtLen(between('', `function sum() ${SUMS}`), 'make', 'out'), null, 'a function declared in the body, called between the pushes')
  is(builtLen(between(`const sum = () => ${SUMS}`), 'make', 'out'), null, 'an arrow ahead of the array it names, called between the pushes')
})

test('built length: every kernel matches the host', () => {
  for (const [name, src] of [...built, ...unbuilt])
    for (const optimize of levels(0, 2, 3, 'size')) {
      const host = oracle(src).f, mod = run(src, { optimize }).f
      for (const c of [0, 1]) is(mod(c), host(c), `${name} at ${optimize}, ${c}`)
    }
})

// The length an array is built to is also the solver's own (summary `steady`,
// `steadyOf`, `solve`): a function's build for every reader but its builder, the
// module's for its functions where none runs ahead of the last push. An element
// read whose index the walk bounds below it is present, with no miss to answer
// for, and its span is its array's integers where they have one hull, for an
// index that is itself an element (`a[idx[i]]`). The solve runs once without the
// lengths and again with those it found given: a hole raised by a store walked
// before its array's builder is taken back by no later round.
// Each element read of a function in source order, a store's target aside: `in`
// where the summary holds it inside its array's length (query presentArrayRead),
// `hole` where it does and the element may still be one no store filled.
const present = (src, scope, optimize = 0) => {
  compile(src, { optimize })
  const fn = ctx.funcs.list.find(f => typeof scope === 'string' ? f.name === scope : scope.test(f.name)), view = ctx.summary.at(fn.body), out = []
  const read = (n, target) => {
    if (!Array.isArray(n)) return
    if (n[0] === '[]' && n.length === 3 && !target) out.push(!view.presentArrayRead(n) ? 'open' : hasTag(view.kindOfExpr(n), K.ABSENT) ? 'hole' : 'in')
    for (let i = 1; i < n.length; i++) read(n[i], n[0] === '=' && i === 1)
  }
  read(fn.body, false)
  return out.join(' ')
}
const U = `const u = (v) => v === undefined ? 1000 : v`
const MK = `const mk = (n) => { const out = []; for (let i = 0; i < n; i++) out.push(i); return out }`
const SUM = (n) => `(xs) => { let s = 0; for (let i = 0; i < ${n}; i++) s += u(xs[i]); return s }`
const VALS = `const vals = (n) => { const out = []; for (let i = 0; i < n; i++) out.push(i * 0.25); return out }`
const GATHER = (n) => `const g = (a, idx) => { let s = 0; for (let i = 0; i < ${n}; i++) s += u(a[idx[i]]); return s }`
// The module's array stored by index: [what, the statements that make it, how far the reader goes, its read]
const READ = (n) => `export const f = () => { let s = 0; for (let i = 0; i < ${n}; i++) s += u(xs[i]); return s }`
const APPENDED = [
  ['stored by index from empty at the top level', `const xs = []; for (let i = 0; i < 6; i++) xs[i] = i * 0.5`, 6, 'in'],
  ['and read past its rounds', `const xs = []; for (let i = 0; i < 6; i++) xs[i] = i * 0.5`, 7, 'open'],
  ['by a loop that may leave early', `const xs = []; for (let i = 0; i < 6; i++) { if (i === 4) break; xs[i] = i * 0.5 }`, 6, 'open'],
  ['by a loop that may skip a round', `const xs = []; for (let i = 0; i < 6; i++) { if (i === 2) continue; xs[i] = i * 0.5 }`, 6, 'open'],
  ['over a literal it outgrows', `const xs = [9, 9]; for (let i = 0; i < 6; i++) xs[i] = i * 0.5`, 6, 'in'],
  ['then pushed to twice', `const xs = []; for (let i = 0; i < 6; i++) xs[i] = i * 0.5\nxs.push(7); xs.push(8)`, 8, 'in'],
  ['after pushes it stays inside', `const xs = []; xs.push(7); xs.push(8); xs.push(9)\nfor (let i = 0; i < 2; i++) xs[i] = i * 0.5`, 3, 'in'],
  ['after pushes it outgrows', `const xs = []; xs.push(7); xs.push(8)\nfor (let i = 0; i < 6; i++) xs[i] = i * 0.5`, 6, 'in'],
  ['twice, the second the longer', `const xs = []; for (let i = 0; i < 4; i++) xs[i] = i\nfor (let i = 0; i < 6; i++) xs[i] = i * 0.5`, 6, 'in'],
  ['twice, the second the shorter', `const xs = []; for (let i = 0; i < 6; i++) xs[i] = i\nfor (let i = 0; i < 4; i++) xs[i] = i * 0.5`, 6, 'in'],
  ['under a test that fails', `const xs = []; if (xs.length === 1) for (let i = 0; i < 6; i++) xs[i] = i * 0.5`, 6, 'open'],
  ['inside a longer loop', `const xs = []; for (let r = 0; r < 8; r++) for (let i = 0; i < 6; i++) xs[i] = i * 0.5 + r`, 8, 'open'],
  ['through a second name, after a push through the first', `const xs = []; xs.push(7)\nconst ys = xs; for (let i = 0; i < 6; i++) ys[i] = i * 0.5`, 6, 'open'],
  ['from one', `const xs = []; for (let i = 1; i < 6; i++) xs[i] = i * 0.5`, 6, 'open'],
  ['by a function run ahead of a second loop', `const xs = []; for (let i = 0; i < 4; i++) xs[i] = i\nconst peek = () => u(xs[5])\nconst early = peek()\nfor (let i = 0; i < 6; i++) xs[i] = i * 0.5 + early`, 6, 'open'],
  ['between two loops of pushes', `const xs = []; for (let i = 0; i < 4; i++) xs.push(i)\nfor (let i = 0; i < 8; i++) xs[i] = i * 3\nfor (let i = 0; i < 4; i++) xs.push(i)`, 12, 'in'],
  // (rounds a loop may not run are no count: the pushes after it would be added to what it never stored)
  ['by a loop that may leave early, between pushes', `const xs = []; xs.push(1); xs.push(2)\nfor (let i = 0; i < 8; i++) { if (i === 6) break; xs[i] = i }\nfor (let i = 0; i < 8; i++) xs.push(9)`, 14, 'open'],
  // (a push of the loop's own adds rounds the stores do not: five elements after four rounds of both, not eight)
  ['by a loop that pushes after each store', `const xs = []; for (let i = 0; i < 4; i++) { xs[i] = i * 0.5; xs.push(7) }`, 8, 'open'],
  ['by a loop that pushes ahead of each store', `const xs = []; for (let i = 0; i < 4; i++) { xs.push(7); xs[i] = i * 0.5 }`, 6, 'open'],
  ['and at an index further on in the same loop', `const xs = []; for (let i = 0; i < 4; i++) { xs[i] = i * 0.5; xs[i + 4] = 1 }`, 9, 'open'],
].map(([what, make, n, reads]) => [what, `${U}\n${make}\n${READ(n)}`, 'f', reads])
// (a function's stores are no part of init: it may never run, or run after the read; beside a loop
// of the module's its rounds would be taken for the module's own)
APPENDED.push(['stored by index in a function', `${U}\nconst xs = []\nconst fillUp = () => { for (let i = 0; i < 6; i++) xs[i] = i * 0.5; return 0 }\nexport const f = () => { let s = 0; for (let i = 0; i < 6; i++) s += u(xs[i]); fillUp(); return s }`, 'f', 'open'])
APPENDED.push(['stored by index at the top level and further in a function', `${U}\nconst xs = []; for (let i = 0; i < 4; i++) xs[i] = i\nconst fillUp = () => { for (let i = 0; i < 6; i++) xs[i] = i * 0.5; return 0 }\nexport const f = () => { let s = 0; for (let i = 0; i < 6; i++) s += u(xs[i]); fillUp(); return s }`, 'f', 'open'])
// [what, source, the reading function, its reads]
const steady = [
  ['a build read by another function under its count', `${U}\n${MK}\nconst use = ${SUM(5)}\nexport const f = () => use(mk(5))`, 'use', 'in'],
  ['read past its count', `${U}\n${MK}\nconst use = ${SUM(6)}\nexport const f = () => use(mk(5))`, 'use', 'open'],
  ['built and read in one function, under its count and past it', `${U}\nexport const f = () => { const xs = []; for (let i = 0; i < 6; i++) xs.push(i * 0.5); let s = 0; for (let i = 0; i < 6; i++) s += u(xs[i]); for (let i = 0; i < 8; i++) s += u(xs[i]); return s }`, 'f', 'in open'],
  ['built, read, then pushed to again in one function', `${U}\nexport const f = () => { const xs = []; for (let i = 0; i < 6; i++) xs.push(i * 0.5); let s = 0; for (let i = 0; i < 6; i++) s += u(xs[i]); xs.push(9); for (let i = 0; i < 6; i++) s += u(xs[i]); return s }`, 'f', 'open open'],
  ['read by its builder as it grows', `${U}\nconst mk = (n) => { const out = []; let seen = 0; for (let i = 0; i < n; i++) { out.push(i); seen += u(out[n - 1 - i]) } return seen }\nexport const f = () => mk(6)`, 'mk', 'open'],
  ['stored to inside its count, then read', `${MK}\nconst use = (xs) => { for (let i = 0; i < 5; i++) xs[i] = xs[i] * 3 + 1; let s = 0; for (let i = 0; i < 5; i++) s += xs[i]; return s + xs.length }\nexport const f = () => use(mk(5))`, 'use', 'in in'],
  ['stored to inside its count by one function, read by another under its own length', `${MK}\nconst fill = (xs) => { for (let i = 0; i < 5; i++) xs[i] = i * 2 }\nconst use = (xs) => { let s = 0; for (let i = 0; i < xs.length; i++) s += xs[i]; return s }\nexport const f = () => { const a = mk(5); fill(a); return use(a) }`, 'use', 'in'],
  ['a build and an empty literal through one reader', `${U}\n${MK}\nconst use = ${SUM(5)}\nexport const f = () => use(mk(5)) * 10000 + use([])`, 'use', 'open'],
  ['a hole stored inside its count', `${U}\n${MK}\nconst use = (xs) => { xs[2] = undefined; let s = 0; for (let i = 0; i < 5; i++) s += u(xs[i]); return s }\nexport const f = () => use(mk(5))`, 'use', 'in'],
  ['stored to past its count', `${U}\n${MK}\nconst use = (xs) => { xs[7] = 1; let s = 0; for (let i = 0; i < 5; i++) s += u(xs[i]); return s + xs.length }\nexport const f = () => use(mk(5))`, 'use', 'open'],
  ['a reader that pushes', `${U}\n${MK}\nconst use = (xs) => { xs.push(9); let s = 0; for (let i = 0; i < 5; i++) s += u(xs[i]); return s }\nexport const f = () => use(mk(5))`, 'use', 'open'],
  ['a reader that pops', `${U}\n${MK}\nconst use = (xs) => { xs.pop(); let s = 0; for (let i = 0; i < 5; i++) s += u(xs[i]); return s }\nexport const f = () => use(mk(5))`, 'use', 'open'],
  ['a reader that shifts', `${U}\n${MK}\nconst use = (xs) => { xs.shift(); let s = 0; for (let i = 0; i < 5; i++) s += u(xs[i]); return s }\nexport const f = () => use(mk(5))`, 'use', 'open'],
  ['a reader that splices', `${U}\n${MK}\nconst use = (xs) => { xs.splice(1, 2); let s = 0; for (let i = 0; i < 5; i++) s += u(xs[i]); return s }\nexport const f = () => use(mk(5))`, 'use', 'open'],
  ['a reader that cuts the length', `${U}\n${MK}\nconst use = (xs) => { xs.length = 2; let s = 0; for (let i = 0; i < 5; i++) s += u(xs[i]); return s }\nexport const f = () => use(mk(5))`, 'use', 'open'],
  ['two counts through one reader', `${U}\n${MK}\nconst use = ${SUM(5)}\nexport const f = () => use(mk(5)) * 10000 + use(mk(6))`, 'use', 'open'],
  ['a build and a literal through one reader', `${U}\n${MK}\nconst use = ${SUM(5)}\nexport const f = () => use(mk(5)) * 10000 + use([1, 2])`, 'use', 'open'],
  ['a push more under a condition', `${U}\nconst mk = (n, c) => { const out = []; for (let i = 0; i < n; i++) out.push(i); if (c) out.push(99); return out }\nconst use = ${SUM(5)}\nexport const f = () => use(mk(5, false)) * 10000 + use(mk(5, true))`, 'use', 'open'],
  ['a loop that may leave before its count', `${U}\nconst mk = (n, stop) => { const out = []; for (let i = 0; i < n; i++) { if (i === stop) break; out.push(i) } return out }\nconst use = ${SUM(5)}\nexport const f = () => use(mk(5, 3)) * 10000 + use(mk(5, 9))`, 'use', 'open'],
  ['a loop that may return before its count', `${U}\nconst mk = (n, stop) => { const out = []; for (let i = 0; i < n; i++) { if (i === stop) return out; out.push(i) } return out }\nconst use = ${SUM(5)}\nexport const f = () => use(mk(5, 2)) * 10000 + use(mk(5, 9))`, 'use', 'open'],
  ['a loop a throw may end, caught in the builder', `${U}\nconst check = (i) => { if (i === 3) throw new Error('stop') }\nconst mk = (n) => { const out = []; try { for (let i = 0; i < n; i++) { check(i); out.push(i) } } catch (e) {} return out }\nconst use = ${SUM(5)}\nexport const f = () => use(mk(5))`, 'use', 'open'],
  ['a loop a throw may end, the array in a holder', `${U}\nconst box = { list: [0] }\nconst check = (i) => { if (i === 3) throw new Error('stop') }\nconst mk = (n) => { const out = []; box.list = out; for (let i = 0; i < n; i++) { check(i); out.push(i) } return out }\nconst use = ${SUM(5)}\nexport const f = () => { try { mk(5) } catch (e) {} return use(box.list) }`, 'use', 'open'],
  ['handed to a reader before the last push', `${U}\nconst use = ${SUM(5)}\nconst mk = (n) => { const out = []; let seen = 0; for (let i = 0; i < n; i++) { seen += use(out); out.push(i) } return seen + use(out) }\nexport const f = () => mk(5)`, 'use', 'open'],
  ['held by an object before the pushes, read between them', `${U}\nconst use = (o) => { const xs = o.list; let s = 0; for (let i = 0; i < 5; i++) s += u(xs[i]); return s }\nconst mk = (n) => { const out = []; const o = { list: out }; let seen = 0; for (let i = 0; i < n; i++) { seen += use(o); out.push(i) } return seen + use(o) }\nexport const f = () => mk(5)`, 'use', 'open'],
  ['yielded before the last push', `${U}\nfunction* mk(n) { const out = []; for (let i = 0; i < n; i++) { yield out; out.push(i) } yield out }\nconst use = ${SUM(4)}\nexport const f = () => { let t = 0; for (const xs of mk(4)) t += use(xs); return t }`, 'use', 'open'],
  ['what a constructor built, read by a method', `${U}\nclass K { constructor() { const a = []; for (let i = 0; i < 6; i++) a.push(i * 2); this.a = a } sum(n) { let s = 0; for (let i = 0; i < n; i++) s += u(this.a[i]); return s } }\nexport const f = () => new K().sum(6)`, /sum$/, 'in'],
  ['what a constructor built, read past its count', `${U}\nclass K { constructor() { const a = []; for (let i = 0; i < 6; i++) a.push(i * 2); this.a = a } sum(n) { let s = 0; for (let i = 0; i < n; i++) s += u(this.a[i]); return s } }\nexport const f = () => new K().sum(8)`, /sum$/, 'open'],
  ['what a constructor built and a method grows', `${U}\nclass K { constructor() { const a = []; for (let i = 0; i < 6; i++) a.push(i * 2); this.a = a } sum(n) { let s = 0; for (let i = 0; i < n; i++) s += u(this.a[i]); return s } more() { this.a.push(1) } }\nexport const f = () => { const k = new K(); const a = k.sum(6); k.more(); return a * 100000 + k.sum(6) }`, /sum$/, 'open'],
  ['a constructor that stores it before the pushes and reads between them', `${U}\nclass K { constructor() { const a = []; this.a = a; this.seen = 0; for (let i = 0; i < 6; i++) { this.seen += this.sum(6); a.push(i * 2) } } sum(n) { let s = 0; for (let i = 0; i < n; i++) s += u(this.a[i]); return s } }\nexport const f = () => { const k = new K(); return k.seen * 100 + k.sum(6) }`, /sum$/, 'open'],
  ['the module\'s, through a name taken before the pushes', `const ps = []\nconst alias = ps\nfor (let i = 0; i < 200; i++) ps.push(i)\n${U}\nexport const f = () => { let s = 0; for (let i = 0; i < 200; i++) s += u(alias[i]); return s + alias.length }`, 'f', 'in'],
  ['the module\'s, through a holder made before the pushes', `const ps = []\nconst holder = { list: ps }\nfor (let i = 0; i < 200; i++) ps.push(i * 0.5)\n${U}\nexport const f = () => { const xs = holder.list; let s = 0; for (let i = 0; i < 200; i++) s += u(xs[i]); return s + xs.length }`, 'f', 'in'],
  ['the module\'s, pushed in two loops and a nest', `const ps = []\nfor (let i = 0; i < 3; i++) ps.push(i)\nfor (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) ps.push(i * 10 + j)\n${U}\nexport const f = () => { let s = 0; for (let i = 0; i < 7; i++) s += u(ps[i]); return s + ps.length }`, 'f', 'in'],
  ['the module\'s, pushed through a name that holds one of two arrays', `const a = [], b = []\nconst ps = Math.random() < 2 ? a : b\nfor (let i = 0; i < 4; i++) ps.push(i)\n${U}\nexport const f = () => { let s = 0; for (let i = 0; i < 4; i++) s += u(b[i]) * 10 + u(a[i]); return s }`, 'f', 'open open'],
  ['the module\'s, read past its count', `const ps = []\nfor (let i = 0; i < 3; i++) ps.push(i)\n${U}\nexport const f = () => { let s = 0; for (let i = 0; i < 4; i++) s += u(ps[i]); return s + ps.length }`, 'f', 'open'],
  ['the module\'s, read by a function between two loops of pushes', `const ps = []\n${U}\nconst use = () => { let s = 0; for (let i = 0; i < 6; i++) s += u(ps[i]); return s }\nfor (let i = 0; i < 3; i++) ps.push(i)\nconst mid = use()\nfor (let i = 0; i < 3; i++) ps.push(i + 5)\nexport const f = () => mid * 100000 + use()`, 'use', 'open'],
  ['the module\'s, which a function pushes to', `const ps = []\nfor (let i = 0; i < 4; i++) ps.push(i)\n${U}\nexport const f = () => { let s = 0; for (let i = 0; i < 4; i++) s += u(ps[i]); ps.push(50); for (let i = 0; i < 4; i++) s += u(ps[i]); return s }`, 'f', 'open open'],
  ['the module\'s, which a function empties', `const ps = []\nfor (let i = 0; i < 4; i++) ps.push(i + 1)\n${U}\nexport const f = () => { let s = 0; for (let i = 0; i < 4; i++) s += u(ps[i]); ps.length = 0; for (let i = 0; i < 4; i++) s += u(ps[i]); return s }`, 'f', 'open open'],
  ['a gather through a built index', `${U}\nconst mk = (n) => { const out = []; for (let i = 0; i < n; i++) out.push((i * 3 + 1) % n); return out }\n${VALS}\n${GATHER(16)}\nexport const f = () => g(vals(16), mk(16))`, 'g', 'in in'],
  ['a gather of a gather', `const mk = (n, k) => { const out = []; for (let i = 0; i < n; i++) out.push((i * k + 1) % n); return out }\nconst mk2 = (n, k) => { const out = []; for (let i = 0; i < n; i++) out.push((i * k + 2) % n); return out }\n${VALS}\nconst g = (a, p, q) => { let s = 0; for (let i = 0; i < 8; i++) s += a[p[q[i]]]; return s }\nexport const f = () => g(vals(8), mk(8, 3), mk2(8, 5))`, 'g', 'in in in'],
  ['a gather whose index reaches past the values', `${U}\nconst mk = (n) => { const out = []; for (let i = 0; i < n; i++) out.push(i * 2); return out }\n${VALS}\n${GATHER(8)}\nexport const f = () => g(vals(8), mk(8))`, 'g', 'open in'],
  ['a gather by fractions', `${U}\nconst mk = (n) => { const out = []; for (let i = 0; i < n; i++) out.push(i * 0.5); return out }\n${VALS}\n${GATHER(4)}\nexport const f = () => g(vals(4), mk(4))`, 'g', 'open in'],
  ['a gather by an index below zero', `${U}\nconst mk = (n) => { const out = []; for (let i = 0; i < n; i++) out.push(i - 2); return out }\n${VALS}\n${GATHER(4)}\nexport const f = () => g(vals(4), mk(4))`, 'g', 'open in'],
  ['a gather by an index one element of which is undefined', `${U}\n${MK}\n${VALS}\n${GATHER(4)}\nexport const f = () => { const idx = mk(4); idx[1] = undefined; return g(vals(4), idx) }`, 'g', 'open in'],
  ['a gather by a literal index with a hole', `${U}\n${VALS}\n${GATHER(4)}\nexport const f = () => g(vals(4), [2, , 1, 0])`, 'g', 'open hole'],
  ['a gather by a literal index a later function shortens', `${U}\nconst idx = [2, 0, 1, 3], vals = [10, 20, 30, 40]\nconst g = () => { let s = 0; for (let i = 0; i < 4; i++) s += u(vals[idx[i]]); return s }\nconst cut = () => { idx.pop() }\nexport const f = () => { cut(); return g() }`, 'g', 'open open'],
  ['a gather by a literal index a later function stores a fraction in', `${U}\nconst idx = [2, 0, 1, 3], vals = [10, 20, 30, 40]\nconst g = () => { let s = 0; for (let i = 0; i < 4; i++) s += u(vals[idx[i]]); return s }\nconst spoil = () => { idx[1] = 0.5 }\nexport const f = () => { spoil(); return g() }`, 'g', 'open in'],
  ['a gather by an index one element of which is a string', `${U}\n${MK}\n${VALS}\n${GATHER(4)}\nexport const f = () => { const idx = mk(4); idx[1] = 'length'; return g(vals(4), idx) }`, 'g', 'open in'],
  // (the module's stores by index from empty: a counter from 0 that each round stores at leaves the
  // array as long as the loop's rounds, a count added once at init as counted pushes add theirs)
  ...APPENDED,
]
// (programs whose reading code is a closure, or whose arrays meet other builtins: the answer alone)
const steadyRuns = [
  ['a function declared after the pushes, called between them', `${U}\nfunction mk(n) { const out = []; let seen = 0; for (let i = 0; i < n; i++) { seen += sum(); out.push(i) } return seen + sum(); function sum() { let s = 0; for (let j = 0; j < 5; j++) s += u(out[j]); return s } }\nexport const f = () => mk(5)`],
  ['an arrow ahead of the array it names, called between the pushes', `${U}\nconst mk = (n) => { const sum = () => { let s = 0; for (let j = 0; j < 5; j++) s += u(out[j]); return s }; const out = []; let seen = 0; for (let i = 0; i < n; i++) { seen += sum(); out.push(i) } return seen + sum() }\nexport const f = () => mk(5)`],
  ['a closure made in the builder before the last push', `${U}\nconst mk = (n) => { const out = []; const peek = (k) => u(out[k]); let seen = 0; for (let i = 0; i < n; i++) { seen += peek(n - 1); out.push(i) } return seen + peek(n - 1) }\nexport const f = () => mk(5)`],
  ['closures made in the builder after the last push, one of which grows it', `${U}\nconst mk = (n) => { const out = []; for (let i = 0; i < n; i++) out.push(i * 2); return { at: (k) => u(out[k]), grow: () => out.push(7) } }\nexport const f = () => { const o = mk(4); let s = 0; for (let i = 0; i < 6; i++) s += o.at(i); o.grow(); for (let i = 0; i < 6; i++) s += o.at(i); return s }`],
  ['a closure summing what its maker built', `const mk = (n) => { const out = []; for (let i = 0; i < n; i++) out.push(i * 2); return () => { let s = 0; for (let i = 0; i < 6; i++) s += out[i]; return s } }\nexport const f = () => mk(6)() + mk(6)()`],
  ['a recursive builder reading the array of the call below', `${U}\nconst mk = (d) => { const out = []; const below = d > 0 ? mk(d - 1) : out; let s = 0; for (let i = 0; i < 4; i++) { s += u(below[i]); out.push(i + d) } return d === 2 ? [s] : out }\nexport const f = () => mk(2)[0]`],
  ['sorted, reversed, filled, joined and cut by the builtins', `${U}\nconst mk = (n) => { const out = []; for (let i = 0; i < n; i++) out.push(n - i); return out }\nconst use = (xs) => { let s = 0; for (let i = 0; i < 5; i++) s = s * 3 + u(xs[i]); return s }\nexport const f = () => { const c = mk(5); c.sort((x, y) => x - y); const d = mk(5); d.reverse(); const e = mk(5); e.fill(undefined, 1, 3); const b = c.concat(mk(5)), t = d.slice(1); return [use(c), use(d), use(e), use(b), use(t)].join() }`],
  ['the module\'s own statements reading it as it grows', `const ps = []\n${U}\nfor (let i = 0; i < 3; i++) ps.push(i)\nlet mid = 0\nfor (let i = 0; i < 6; i++) mid += u(ps[i])\nfor (let i = 0; i < 3; i++) ps.push(i + 5)\nexport const f = () => { let s = 0; for (let i = 0; i < 6; i++) s += u(ps[i]); return mid * 100000 + s }`],
  ['a function\'s build the module pushes further', `${MK}\nconst ps = mk(3)\nfor (let i = 0; i < 4; i++) ps.push(i + 10)\n${U}\nconst use = ${SUM(8)}\nexport const f = () => use(ps)`],
  ['a function\'s build another function pushes further', `${MK}\nconst more = (xs) => { for (let i = 0; i < 4; i++) xs.push(i + 10); return xs }\n${U}\nconst use = ${SUM(8)}\nexport const f = () => use(more(mk(3)))`],
  ['a scatter through a built index', `${U}\nconst mk = (n) => { const out = []; for (let i = 0; i < n; i++) out.push((i * 5 + 2) % n); return out }\nconst zeros = (n) => { const out = []; for (let i = 0; i < n; i++) out.push(0); return out }\nconst scatter = (a, idx) => { for (let i = 0; i < 8; i++) a[idx[i]] = i + 1; let s = 0; for (let i = 0; i < 8; i++) s = s * 3 + u(a[i]); return s }\nexport const f = () => scatter(zeros(8), mk(8))`],
  ['a scatter whose index reaches past its target', `${U}\nconst mk = (n) => { const out = []; for (let i = 0; i < n; i++) out.push(i * 2); return out }\nconst zeros = (n) => { const out = []; for (let i = 0; i < n; i++) out.push(0); return out }\nconst scatter = (a, idx) => { for (let i = 0; i < 6; i++) a[idx[i]] = i + 1; let s = 0; for (let i = 0; i < 12; i++) s = s * 3 + u(a[i]); return s + a.length }\nexport const f = () => scatter(zeros(6), mk(6))`],
]

test('built length: a read another function bounds below it is present, and only there', () => {
  for (const [name, src, fn, reads] of steady) is(present(src, fn), reads, name)
})

test('built length: a store inside it leaves no hole, where no read asks for the length either', () => {
  // (the stores run from the last element down, no append; the reader hands the elements to a callback,
  // with no index of its own: only the store's span meets the open count)
  const src = `${MK}\nconst fill = (xs) => { for (let i = 4; i >= 0; i--) xs[i] = i * 2 }\nconst use = (xs) => xs.reduce((s, v) => s + v, 0)\nexport const f = () => { const a = mk(5); fill(a); return use(a) }`
  compile(src, { optimize: 0 })
  const fn = ctx.funcs.map.get('use'), xs = JSON.parse(JSON.stringify(fn.sig.params.map(p => p.name)))[0]
  ok(!hasTag(ctx.summary.at(fn.body).elemKindOf(xs), K.ABSENT), 'the elements are all there')
  for (const optimize of levels(0, 2, 3, 'size', 'speed')) agree(src, 'f', [], { optimize }, `at ${optimize}`)
})

test('built length: a read two statements share keeps its verdict in the one load it becomes', () => {
  // (compile/cse-load.js runs after the last summary and reads the element once for both: the load left is the first read's own node)
  const src = `${MK}\nconst A = mk(64)\nconst use = (xs, w) => { let s = 0, t = 0; for (let i = 0; i < 64; i++) { s += xs[i] * w; t += xs[i] + s } return s + t }\nexport const f = () => use(A, 2) + use(A, 3)`
  for (const optimize of levels(2, 'speed')) ok(/^in( in)*$/.test(present(src, 'use', optimize)), `every read left is inside the length at ${optimize}: ${present(src, 'use', optimize)}`)
  for (const optimize of levels(0, 2, 3, 'size', 'speed')) agree(src, 'f', [], { optimize }, `at ${optimize}`)
})

// The second solve walks every function from its first round, where the first reaches a
// callee a round after its caller. A parameter's hull comes a round after its kind, so a
// function walked in the round that binds it read an element bounded by that hull as
// "maybe absent", for good: a read there waits for the round that binds the function, as
// its stores do (summary `runs`).
test('built length: a read in a function no call has bound yet waits for its parameter\'s hull', () => {
  const program = (p) => `${MK}\nconst idx = mk(8)\n${p}
    class V { constructor(x = 0, y = 0) { this.x = x; this.y = y } from(array, offset = 0) { this.x = array[offset]; this.y = array[offset + 1]; return this } len() { return this.x * this.x + this.y * this.y } }
    const a = new V(), b = new V()
    const count = () => { let s = 0; for (let i = 0; i < 8; i++) s += idx[i]; return s }
    const ray = (out) => { let s = 0; for (let k = 0; k < 4; k++) for (let i = 0; i < 4; i++) { a.from(p, i * 4); b.from(p, i * 4 + 2); s += a.len() + b.len() } out[1] = s }
    const run = (out) => { out[0] = count(); ray(out) }
    export let f = () => { const out = new Float64Array(3); for (let i = 0; i < 3; i++) run(out); return out[0] + out[1] }`
  const holders = {
    'a typed array': `const p = new Float32Array(16)\nfor (let i = 0; i < p.length; i++) p[i] = i * 0.5`,
    'an array of fixed length': `const p = [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6, 6.5, 7, 7.5, 8]`,
  }
  for (const [name, p] of Object.entries(holders)) {
    const src = program(p)
    compile(src, { optimize: 0 })
    const fn = ctx.funcs.list.find(f => /len$/.test(f.name)), view = ctx.summary.at(fn.body), fields = []
    const read = (n) => { if (!Array.isArray(n)) return; if (n[0] === '.' && (n[2] === 'x' || n[2] === 'y')) fields.push(hasTag(view.kindOfExpr(n), K.ABSENT) ? 'maybe absent' : 'there'); for (let i = 1; i < n.length; i++) read(n[i]) }
    read(fn.body)
    is(fields.join(), 'there,there,there,there', `${name}: the fields it fills are Numbers`)
    for (const optimize of levels(0, 2, 3, 'size', 'speed')) agree(src, 'f', [], { optimize }, `${name} at ${optimize}`)
  }
})

test('built length: a build the module pushes further is neither\'s', () => {
  // (the module's counted pushes resize nothing by the summary's count of them: the build's length is not the array's)
  const src = `${MK}\nconst ps = mk(3)\nfor (let i = 0; i < 4; i++) ps.push(i + 10)\n${use}\nexport const f = () => use(ps)`
  is(builtLen(src, 'use', 'xs'), null)
  is(builtLen(`${MK}\n${use}\nexport const f = () => use(mk(3))`, 'use', 'xs'), 3, 'the build alone keeps its length')
  // (the module's own array is the frozen length's to answer, by name: its statements read it as it grows)
  compile(`const ps = []\nfor (let i = 0; i < 4; i++) ps.push(i)\nlet n = 0\nfor (let i = 0; i < ps.length; i++) n += ps[i]\nexport const f = () => n + ps.length`, { optimize: 0 })
  is(ctx.summary.at(undefined).builtLenOf('ps'), null, 'the module\'s own has none')
})

test('built length: every such program answers as the host', () => {
  for (const [name, src] of [...steady, ...steadyRuns])
    for (const optimize of levels(0, 2, 3, 'size', 'speed')) agree(src, 'f', [], { optimize }, `${name} at ${optimize}`)
})

// A store inside the length an array was built to is the cell's own store, as a read there is the
// cell's own load (query builtArrayStore): an index the walk holds a span of integers, from 0 up,
// below that length, in code that meets the array built. Nothing grows, so the store asks no
// length and calls no helper; the block may have moved while it was built, so the store goes by
// the hop its holder needs. Each element store of a function in source order: `in` where the
// summary holds it so.
const storedIn = (src, scope) => {
  compile(src, { optimize: 0 })
  const fn = ctx.funcs.list.find(f => f.name === scope), view = ctx.summary.at(fn.body), out = []
  const visit = (n) => {
    if (!Array.isArray(n)) return
    if (n[0] === '=' && Array.isArray(n[1]) && n[1][0] === '[]') out.push(view.builtArrayStore(n[1]) ? 'in' : 'open')
    for (let i = 1; i < n.length; i++) visit(n[i])
  }
  visit(fn.body)
  return out.join(' ')
}
const PS = (n) => `const ps = []\nfor (let i = 0; i < ${n}; i++) ps.push(i)`
// [what, source, the storing function, its stores]
const builtStores = [
  ['a build stored to by another function under its count', `${MK}\nconst fill = (xs) => { for (let i = 0; i < 5; i++) xs[i] = i * 2 + 1; return xs.length }\nexport const f = () => { const a = mk(5); return fill(a) * 1000 + a[0] + a[4] }`, 'fill', 'in'],
  ['built and stored to in one function', `export const f = () => { const xs = []; for (let i = 0; i < 6; i++) xs.push(i); for (let i = 0; i < 6; i++) xs[i] = xs[i] * 2 + 1; return xs[5] * 100 + xs.length }`, 'f', 'in'],
  ['stored to at a parameter every call keeps under its count', `${MK}\nconst put = (xs, k) => { xs[k] = 7; return xs.length }\nexport const f = () => { const a = mk(5); return put(a, 2) * 1000 + put(a, 4) * 100 + a[2] * 10 + a[4] }`, 'put', 'in'],
  ['stored to at a parameter one call puts at its count', `${MK}\nconst put = (xs, k) => { xs[k] = 7; return xs.length }\nexport const f = () => { const a = mk(5); return put(a, 2) * 1000 + put(a, 5) * 100 + a[2] * 10 + a[5] }`, 'put', 'open'],
  ['stored to at its count', `${MK}\nconst put = (xs) => { xs[5] = 7; return xs.length }\nexport const f = () => { const a = mk(5); return put(a) * 100 + a[5] }`, 'put', 'open'],
  ['stored to under and at its count', `${MK}\nconst fill = (xs) => { for (let i = 0; i < 6; i++) xs[i] = i + 1; return xs.length }\nexport const f = () => { const a = mk(5); return fill(a) * 100 + a[5] }`, 'fill', 'open'],
  ['stored to by a reader that pushes first', `${MK}\nconst fill = (xs) => { xs.push(9); for (let i = 0; i < 5; i++) xs[i] = 1; return xs.length }\nexport const f = () => { const a = mk(5); return fill(a) * 100 + a[5] + a[0] }`, 'fill', 'open'],
  ['stored to at a fraction of its count', `${MK}\nconst fill = (xs) => { for (let i = 0; i < 4; i++) xs[i * 0.5] = 9; return xs.length }\nexport const f = () => { const a = mk(5); return fill(a) * 10000 + a[0] * 100 + a[1] * 10 + a[2] }`, 'fill', 'open'],
  ['the module\'s, stored to by a function under its count', `${PS(8)}\nexport const f = () => { for (let i = 0; i < 8; i++) ps[i] = ps[i] * 2 + 1; let s = 0; for (let i = 0; i < 8; i++) s += ps[i]; return s * 100 + ps.length }`, 'f', 'in'],
  ['the module\'s, stored to at its count', `${PS(8)}\nexport const f = () => { ps[8] = 5; return ps.length * 100 + ps[8] }`, 'f', 'open'],
  // (a guard keeps the index below the length and says nothing of 0: `ps[-2]` names a property)
  ['the module\'s, stored to under a guard from below zero', `${PS(100)}\nexport const f = () => { for (let i = -2; i < 50; i++) if (i < ps.length) ps[i] = 7; return ps.length * 1000 + ps[0] + ps[49] + ps[50] }`, 'f', 'open'],
  // (a name taken before the pushes holds the block's first place, which forwards: the arrays pushed between move it)
  ['the module\'s, stored to through a name taken before it moved', `const ps = []\nlet alias = ps\nconst pad = []\nfor (let i = 0; i < 100; i++) { ps.push(i); pad.push([i, i]) }\nexport const swap = () => { alias = ps; return 0 }\nexport const f = () => { for (let i = 0; i < 100; i++) alias[i] = i * 2 + 1; return ps[99] * 1000 + ps.length + pad.length }`, 'f', 'in'],
]
// (stores of the module's own statements, which meet the array as it grows: the answer alone)
const builtStoreRuns = [
  ['the module\'s, stored to by its own statements past what it has', `const ps = []\nfor (let i = 0; i < 4; i++) ps.push(i)\nfor (let i = 0; i < 8; i++) ps[i] = i * 3\nfor (let i = 0; i < 4; i++) ps.push(i)\nexport const f = () => ps.length * 1000 + ps[7] + ps[11]`],
  ['the module\'s, stored to by its own statements between its pushes', `const ps = []\nfor (let i = 0; i < 4; i++) ps.push(i)\nfor (let i = 0; i < 4; i++) ps[i] = i * 3 + 1\nfor (let i = 0; i < 4; i++) ps.push(i)\nexport const f = () => ps.length * 1000 + ps[3] + ps[7]`],
]

test('built length: a store another function bounds below it is inside, and only there', () => {
  for (const [name, src, fn, stores] of builtStores) is(storedIn(src, fn), stores, name)
})

test('built length: a store inside it is the cell\'s own, with no helper and no test of the reset\'s save in its loop', () => {
  if (belowOpt(2)) return
  for (const [name, src, fn, stores] of builtStores) {
    if (stores !== 'in') continue
    // (a function spliced into its caller has no text of its own: the export's, which then holds its loop)
    const body = funcWat(wat(src, { optimize: 2 }), fn, 'f')
    ok(!/__arr_set_idx_ptr|__arr_set_num/.test(body), `${name}: no store helper`)
    // (a durable array is saved for the reset once, ahead of the loop that runs: the bitmap's test is not in it,
    // the loop's own text to its closing paren. An array the split's proof does not reach has a second loop
    // after it, for one shorter than the bound, and that loop's save stands between the two.)
    const loop = body.indexOf('(loop')
    let end = loop, depth = 0
    if (loop >= 0) do { depth += body[end] === '(' ? 1 : body[end] === ')' ? -1 : 0; end++ } while (depth > 0)
    ok(loop < 0 || !body.slice(loop, end).includes('__durable_arr_seen'), `${name}: the save's test is ahead of the loop`)
  }
})

test('built length: every program storing so answers as the host', () => {
  for (const [name, src] of [...builtStores, ...builtStoreRuns])
    for (const optimize of levels(0, 2, 3, 'size', 'speed')) agree(src, 'f', [], { optimize }, `${name} at ${optimize}`)
})

// A construction a loop fills whole holds no hole: the loop at once after it stores each index
// below the count, the count being the loop's bound by its own name, by the same integer, or as
// the array's own length; the value may read a count nothing writes again (summary/index.js
// covers, countBound).
const WHOLE = [
  ['the array\'s own length', `const t = new Array(8); for (let i = 0; i < t.length; i++) t[i] = i * 2`],
  ['the same integer', `const t = new Array(8); for (let i = 0; i < 8; i++) t[i] = i * 2`],
  ['a name that holds it', `const N = 8\nconst t = new Array(N); for (let i = 0; i < N; i++) t[i] = i * 2`],
  ['a name, and its integer as the bound', `const N = 8\nconst t = new Array(N); for (let i = 0; i < 8; i++) t[i] = i * 2`],
  ['a value that reads the count', `const N = 8\nconst t = new Array(N); for (let i = 0; i < N; i++) t[i] = (i * 3 + 1) % N`],
]
const HOLED = [
  ['a bound short of the count', `const t = new Array(8); for (let i = 0; i < 7; i++) t[i] = i * 2`],
  ['a name short of the count', `const N = 8, M = 7\nconst t = new Array(N); for (let i = 0; i < M; i++) t[i] = i * 2`],
  ['another array\'s length', `const w = new Array(7)\nconst t = new Array(8); for (let i = 0; i < w.length; i++) t[i] = i * 2`],
  ['a value that reads the array', `const t = new Array(8); for (let i = 0; i < 8; i++) t[i] = t[7 - i] === undefined ? 1 : 2`],
  ['a loop from one', `const t = new Array(8); for (let i = 1; i < 8; i++) t[i] = i * 2`],
]
const READS = `export const f = () => { let s = 0; for (let i = 0; i < 8; i++) s += u(t[i]); return s }`
// (a count the caller gives: read under the array's own length; one the value moves fills nothing)
const GIVEN = (count, value) => `export const f = (n) => { ${count}; const t = new Array(m); for (let i = 0; i < m; i++) t[i] = ${value}; let s = 0; for (let i = 0; i < t.length; i++) { const v = t[i]; s += v === undefined ? 1000 : v } return s }`
test('fixed length: a construction a loop fills whole holds no hole', () => {
  for (const [what, make] of WHOLE) is(present(`${U}\n${make}\n${READS}`, 'f'), 'in', what)
  for (const [what, make] of HOLED) is(present(`${U}\n${make}\n${READS}`, 'f'), 'hole', what)
  is(present(GIVEN('const m = n', '(i * 3 + 1) % m'), 'f'), 'in', 'a value that reads a count held for good')
  is(present(GIVEN('let m = n', '(m = 3)'), 'f'), 'hole', 'a value that moves the count')
  for (const [what, make] of [...WHOLE, ...HOLED]) for (const optimize of levels(0, 2, 3, 'size', 'speed')) agree(`${U}\n${make}\n${READS}`, 'f', [], { optimize }, `${what} at ${optimize}`)
  for (const [count, value] of [['const m = n', '(i * 3 + 1) % m'], ['let m = n', '(m = 3)']])
    for (const optimize of levels(0, 2, 3, 'size', 'speed')) for (const n of [8, 0, 5]) agree(GIVEN(count, value), 'f', [n], { optimize }, `${count}, ${value}: f(${n}) at ${optimize}`)
})

// An element read whose counter the walk found inside the fixed length is
// present, by node: a field of it reads its slot, an element of it its cell.
test('fixed length: a counted read of an array of one shape reads slots and cells directly', () => {
  const src = `const planes = [{ normal: [0, 1, 0], constant: 2 }, { normal: [1, 0, 0], constant: -1 }, { normal: [0, 0, 1], constant: 3 }]
    export const f = (x, y, z) => { let s = 0; for (let i = 0; i < 3; i++) { const n = planes[i].normal; s += n[0] * x + n[1] * y + n[2] * z + planes[i].constant } return s }`
  for (const optimize of levels(0, 2, 3)) agree(src, 'f', [1, 2, 3], { optimize }, `at ${optimize}`)
  for (const optimize of levels(2, 3)) {
    const body = funcWat(wat(src, { optimize }), 'f')
    ok(!/__dyn_get|__ptr_offset|__throw_property_nullish/.test(body), `no lookup, follow or check at ${optimize}`)
  }
  const warnings = []
  compile(src, { warnings: w => warnings.push(w), optimize: 2 })
  ok(!warnings.some(e => e.code === 'deopt-prop-read'), 'no dynamic property read')
})

// A name a statement checked (an element or a field read threw for a missing
// receiver) holds an object for the rest of its block: the later reads check
// nothing, and a missing receiver still throws where the first read is.
test('present receiver: one check per block for the fields of a nullable element', () => {
  const src = `const bones = []
    for (let i = 0; i < 4; i++) bones.push({ start: [i, 0, 0], end: [i + 1, 0, 0], len: 1 })
    export const f = (k, n) => { let s = 0; for (let i = 0; i < n; i++) { const b = bones[i]; const st = b.start; const en = b.end; s += st[0] * k + en[0] + b.len } return s }
    export const g = (i) => { const b = bones[i]; try { return b.start[0] + b.end[0] } catch (e) { return e instanceof TypeError ? -1 : -2 } }`
  for (const optimize of levels(0, 2, 3)) {
    agree(src, 'f', [2, 4], { optimize }, `every bone at ${optimize}`)
    agree(src, 'g', [1], { optimize }, `a bone that is there at ${optimize}`)
    agree(src, 'g', [9], { optimize }, `a bone that is not at ${optimize}`)
  }
  for (const optimize of levels(2, 3)) {
    const body = funcWat(wat(src, { optimize }), 'f')
    let loops=0
    walk(parseWat(body),n=>{
      if(n[0]!=='loop')return
      loops++
      ok((JSON.stringify(n).match(/__throw_property_nullish/g) || []).length <= 1, `at most one check in each loop at ${optimize}`)
    })
    ok(loops>0,'the guarded loop paths remain present')
  }
})

// A call through a function's property (`m.assign = nz`, stdlib's out-buffer
// variants) or an alias of it is the function's own call (plan/scope.js
// devirtGlobalCalls rewrites the site; the summary reads the property's
// closure): the array passed keeps its count, the callee inlines, and the
// stores are the cell's own, as through the direct call.
test('fixed length: an out-buffer through a function property keeps its count', () => {
  const nz = `function nz(v, out, s, o) { out[o] = v; out[o + s] = 0; return out }
    function m(v) { return nz(v, [0, 0], 1, 0) }
    m.assign = nz
    const W = [0, 0]`
  const direct = nz + `\nexport const f = (x) => { nz(x * 2, W, 1, 0); return W[0] * 2 + W[1] }`
  const prop = nz + `\nexport const f = (x) => { m.assign(x * 2, W, 1, 0); return W[0] * 2 + W[1] }`
  const alias = nz + `\nconst nrm = m.assign\nexport const f = (x) => { nrm(x * 2, W, 1, 0); return W[0] * 2 + W[1] }`
  const held = nz + `\nconst keep = [m.assign]\nexport const f = (x) => { m.assign(x * 2, W, 1, 0); return W[0] * 2 + W[1] + keep.length }`
  is(fixedLen(prop, null, 'W'), 2, 'the property call passes W to nz')
  is(fixedLen(alias, null, 'W'), 2, 'the alias passes W to nz')
  for (const optimize of levels(0, 2, 3)) for (const [name, src] of Object.entries({ direct, prop, alias, held })) agree(src, 'f', [0.5], { optimize }, `${name} at ${optimize}`)
  if (belowOpt(2)) return
  const stores = (src) => (funcWat(wat(src, { optimize: 3 }), 'f') || '').match(/__arr_set_idx/g)?.length ?? 0
  is(stores(prop), stores(direct), 'the property call stores as the direct call does')
  is(stores(alias), stores(direct), 'the alias stores as the direct call does')
  is(stores(direct), 0, 'the direct call stores into the cell')
})
