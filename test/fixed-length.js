// An array whose length cannot change: every array of its cell is a literal of
// one count, nothing in the program resizes or deletes from any of them, no
// store names an index the count does not hold, no holder is out of the
// summary's sight (src/summary `lens`). Its reads and its stores inside the
// count are the cell's own load and store; every result is the host's.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz, { compile } from '../index.js'
import { ctx } from '../src/ctx.js'
import { levels } from './_matrix.js'
import { agree, wat, funcWat } from './util.js'

// The fact as the summary holds it after a compile: `fixedLenOf` of a module
// binding, or of a function's binding by the name the source gave it.
const fixedLen = (src, scope, name) => {
  compile(src, { optimize: 0, imports: { host: { sink: () => 0 } } })
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
  is(fixedLen(`const a = [1, 2, 3]\nexport const f = (c) => { const v = c ? a : 5; return v === 5 ? 0 : v[0] }`, null, 'a'), null, 'joined with a number')
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
  for (const name of ['b', 'c', 'd'])
    is(fixedLen(`const a = [1, 2, 3]\nconst b = [...a, 4], c = a.map(x => x * 2), d = Array.from(a)\nexport const f = () => b[0] + c[0] + d[0]`, null, name), null, `${name}: built by something other than a plain literal`)
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
// before the round's first store and restored by `_clear`.
test('fixed length: a reset restores a durable array stored to directly', () => {
  const src = `const out = [1, 2, 3]
    const ps = []
    for (let i = 0; i < 300; i++) ps.push([i, i])
    export const bump = (k) => { out[0] = out[0] + k; out[2] = out[2] * 2; let s = out[0] + out[2]; for (let i = 0; i < 300; i++) { const p = ps[i]; p[1] = p[1] + k; s += p[1] } return s }`
  let base = 0; for (let i = 0; i < 300; i++) base += i
  for (const optimize of levels(0, 2)) {
    const { exports } = jz(src, { optimize })
    is(exports.bump(1), 2 + 6 + base + 300, `round 1 at ${optimize}`)
    is(exports.bump(1), 3 + 12 + base + 600, 'a second call builds on the first')
    exports._clear()
    is(exports.bump(1), 2 + 6 + base + 300, 'round 2 starts from what module init left')
  }
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
  const warnings = { entries: [] }
  compile(src, { warnings, optimize: 2 })
  ok(!warnings.entries.some(e => e.code === 'deopt-prop-read'), 'no dynamic property read')
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
    ok((body.match(/__throw_property_nullish/g) || []).length <= 1, `at most one check per pass at ${optimize}`)
  }
})

test('fixed length: the advisory names the first cause an array keeps its checks by', () => {
  const warnings = { entries: [] }
  compile(`const out = [0, 0, 0]\nexport const f = (k) => { out.push(k); return out[0] }`, { warnings, why: true })
  const entry = warnings.entries.find(e => e.code === 'array-open')
  ok(entry && /3 elements/.test(entry.message) && /push/.test(entry.message), entry?.message)
})
