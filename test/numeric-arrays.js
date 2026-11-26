// Numeric arrays (src/compile/numeric-arrays.js): an Array the program proves
// holds only Numbers, made where the emitter tags it and read only through the
// emitter's own element paths, keeps its elements as raw f64 (its pointer's aux
// ARRAY_RAW, layout.js). A store takes the value's bits as they are, a read is
// the load; a NaN of any bits is read back as a Number. Every walk of memory
// (compaction, the release walk, the reset log) reads no element of such an
// array for a pointer, and every other use keeps the boxed layout.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { levels, onWasi, belowOpt, OPT_LEVEL } from './_matrix.js'
import { oracle, wat, funcWat, jz } from './util.js'

const tiers = () => levels(0, 1, 2, 3, 'size')
// the levels that keep arrays raw (src/passes.js numericArrays): O0 and O1, the reference tiers, keep every array boxed
const raw = (optimize) => optimize !== 0 && optimize !== 1
const BITS = `const bits = (hi, lo) => { const t = new Float64Array(1), w = new Uint32Array(t.buffer); w[0] = lo; w[1] = hi; return t[0] }`
// payloads a box spells: an array's pointer, the hole, undefined, a sign-set NaN (x86's fresh one), one
const PAYLOADS = [[0x7FF88000, 0x1000], [0x7FF87FFF, 0xFFFFFFFF], [0x7FF80002, 0], [0xFFF80000, 0], [0x3FF00000, 0]]
// the ARRAY_RAW aux a construction ORs into its pointer, as the emitter spells it
const tagged = (text) => text.includes('0x0000000100000000')
// the same in one export's own text, where the module holds the constant in a global of its own as where it is written out
// (a helper of the runtime's may spell it for a test of its own: the module's whole text says nothing of one array)
const taggedIn = (text, name) => {
  const pooled = /\(global (\$\S+) i64\s*\(i64\.const 0x0000000100000000\)/.exec(text)?.[1]
  // (the export's body is its own function, or the wrapper's where it was inlined there)
  return [name, name + '$exp'].some(f => {
    let fn
    try { fn = funcWat(text, f) } catch { return false }
    return tagged(fn) || pooled != null && fn.includes(`(global.get ${pooled})`)
  })
}
// canonicalNumberIR's own test of its temp: `cn != cn` (read before watr, whose local coalescing renames the temp)
const UNOPT = { level: 2, sourceInline: false, watr: false }
const canons = (text) => (text.match(/\(f64\.ne \(local\.get \$\S*cn\d+\S*\) \(local\.get \$\S*cn\d+\S*\)\)/g) || []).length

test('numeric arrays: a state pair stores what it is given, and reads the load', () => {
  // the library idiom: `[z1, z2]` pairs in an array kept in a params bag, filtered in place
  const src = `const filter = (data, params) => {
      const n = params.coefs.length
      if (!params.state) { params.state = new Array(n); for (let i = 0; i < n; i++) params.state[i] = [0, 0] }
      const state = params.state, c = params.coefs
      for (let i = 0; i < data.length; i++) {
        let x = data[i]
        for (let j = 0; j < n; j++) { const s = state[j], y = c[j] * x + s[0]; s[0] = c[j] * 0.5 * x - 0.25 * y + s[1]; s[1] = 0.125 * x - 0.0625 * y; x = y }
        data[i] = x
      }
      return data
    }
    export let f = (len, k) => {
      const d = new Float64Array(len)
      for (let i = 0; i < len; i++) d[i] = ((i * 37) % 11 - 5) * k
      const p = { coefs: [0.9, 0.8, 0.7] }
      filter(d, p); filter(d, p)
      let h = 0
      for (let i = 0; i < len; i++) h += d[i] * (i + 1)
      return h
    }`
  const want = oracle(src)
  for (const optimize of tiers()) {
    const got = jz(src, { optimize }).exports
    for (const [len, k] of [[0, 1], [5, 0.3], [200, 0.07]]) is(got.f(len, k), want.f(len, k), `f(${len}, ${k}) O${optimize}`)
  }
  if (belowOpt(2)) return
  const text = funcWat(wat(src, { optimize: UNOPT }), 'filter')
  is(canons(text), 0, 'the pair stores keep their bits: no canonicalization')
  ok(tagged(wat(src, { optimize: { level: 2, sourceInline: false } })), 'the pair is made raw')
})

test('numeric arrays: a NaN of any bits is read back as a Number, its bits kept', () => {
  // a module literal (static data) and pairs a module loop pushes (heap), each holding a payload
  const src = `${BITS}
    const a = [0, 0, 0]
    const rows = []
    for (let i = 0; i < 4; i++) rows.push([i, i])
    export let f = (hi, lo, k) => {
      a[1] = bits(hi, lo)
      const r = rows[k & 3]
      r[0] = a[1]
      const v = a[1], u = r[0]
      return [typeof v, Number.isNaN(v), v === undefined, a.length, String(v), typeof u, u === u, r.length, v == null, [v][0] === v]
    }
    export let g = (hi, lo, k) => {
      f(hi, lo, k)
      const out = new Float64Array(2); out[0] = a[1]; out[1] = rows[k & 3][0]
      const w = new Uint32Array(out.buffer)
      return [w[1], w[0], w[3], w[2]]
    }`
  const want = oracle(src)
  for (const optimize of tiers()) {
    const got = jz(src, { optimize }).exports
    for (const [hi, lo] of PAYLOADS) {
      is(got.f(hi, lo, 1), want.f(hi, lo, 1), `f(${hi.toString(16)}:${lo.toString(16)}) O${optimize}`)
      // the bits a Float64Array keeps, a numeric array keeps too (NaN payloads are the engine's own to keep or not: jz keeps them)
      if (raw(optimize)) is(got.g(hi, lo, 2), [hi >>> 0, lo >>> 0, hi >>> 0, lo >>> 0], `bits kept ${hi.toString(16)}:${lo.toString(16)} O${optimize}`)
    }
  }
})

test('numeric arrays: an array a generic reader reads keeps the boxed layout', () => {
  // each reader reads the elements as values: they hold the canonical NaN, the reader sees a Number
  const src = `${BITS}
    const hold = (a) => a
    export let f = (hi, lo, mode) => {
      const a = [1, 2]
      a[0] = bits(hi, lo)
      if (mode === 0) return a.join(',')
      if (mode === 1) return String(a)
      if (mode === 2) return Math.max(...a)
      if (mode === 3) return a.includes(a[0])
      if (mode === 4) return a.indexOf(2)
      if (mode === 5) return 0 in a
      if (mode === 6) return JSON.stringify(a)
      if (mode === 7) return a.slice(0, 1).length + a.map(x => x + 1).length
      if (mode === 8) return [a, [3]].flat().length
      return hold(a).length
    }`
  const want = oracle(src)
  for (const optimize of tiers()) {
    const got = jz(src, { optimize }).exports
    for (const [hi, lo] of PAYLOADS) for (let mode = 0; mode <= 9; mode++)
      is(got.f(hi, lo, mode), want.f(hi, lo, mode), `mode ${mode} ${hi.toString(16)}:${lo.toString(16)} O${optimize}`)
  }
  ok(!tagged(wat(src, { optimize: { level: 2 } })), 'no array of the program is raw')
})

test('numeric arrays: growth keeps the raw layout, the walks keep the bits', () => {
  if (onWasi()) return
  // pushed raw Numbers spelling pointers into the heap, state replaced each call: the
  // compaction walks the module's arrays while their elements read as pointers
  const src = `${BITS}
    let hist = [], junk = []
    export const step = (i) => {
      const p = [0, i * 1]   // (a Number: an export's parameter itself may be any value)
      p[0] = bits(0x7FF88000, 0x8000 + (i % 1024) * 8)   // an array's pointer into the heap
      hist.push(p)
      if (hist.length > 40) hist = hist.slice(20)
      junk = [{ i }, { i: i + 1 }, [i]]
      let s = 0
      for (let k = 0; k < hist.length; k++) { const q = hist[k]; s += (q[0] === q[0] ? 1 : 0) + q[1] }
      return s + junk.length
    }
    export const low = (k) => { const t = new Float64Array(1), w = new Uint32Array(t.buffer); t[0] = hist[Number(k)][0]; return w[0] }
    export const n = () => hist.length`
  // (the default level compacts; the others, the size tier and O0 without the rewind among them, agree all the same)
  for (const optimize of [undefined, ...levels(0, 2, 3, 'size')]) {
    const want = oracle(src), { exports, memory } = jz(src, optimize === undefined ? {} : { optimize })
    let last = 0, compactions = 0
    for (let i = 0; i < 3000; i++) {
      is(exports.step(i), want.step(i), `step(${i}) O${optimize}`)
      if (memory.used < last) compactions++
      last = memory.used
    }
    if (optimize === undefined && !belowOpt(1)) ok(compactions >= 1, `compacted (${compactions})`)
    // the last steps' payloads, low words as stored: no walk forwarded them
    const len = exports.n(), first = 3000 - len
    // (no option compiles at the leg's level: the opt0 leg's boxes the payloads, as O0 does)
    if (raw(optimize ?? OPT_LEVEL)) for (let k = 0; k < len; k++) is(exports.low(k), 0x8000 + ((first + k) % 1024) * 8, `payload ${k} kept O${optimize}`)
  }
})

test('numeric arrays: a durable array saved for the reset keeps raw bits through it', () => {
  if (onWasi()) return
  // made as the module starts, written each call: the reset log saves it (a raw record),
  // the compaction walks that record, the reset restores it
  const src = `${BITS}
    const st = [bits(0x7FF88000, 0x8000), 0]
    let junk = []
    export const step = (i) => { st[1] = st[1] + 1; st[0] = bits(0x7FF88000, 0x8000 + (i % 1024) * 8); junk = [{ i }, [i, i]]; return st[1] + junk.length }
    export const low = () => { const t = new Float64Array(1), w = new Uint32Array(t.buffer); t[0] = st[0]; return w[0] }`
  for (const optimize of levels(2, 3)) {
    const { exports, memory } = jz(src, { optimize })
    is(exports.low(), 0x8000, `as the module starts O${optimize}`)
    for (let i = 0; i < 2000; i++) exports.step(i)
    is(exports.low(), 0x8000 + (1999 % 1024) * 8, `written O${optimize}`)
    memory.reset()
    is(exports.low(), 0x8000, `restored by the reset O${optimize}`)
    is(exports.step(0), 1 + 2, `its count restored O${optimize}`)
  }
})

test('numeric arrays: a literal a function returns as lanes is built raw where a call takes it whole', () => {
  // the library idiom: `create()` returns a literal (a multi-value result, prepare/handlers.js),
  // the caller keeps the array it builds of the lanes as an out-parameter
  const src = `${BITS}
    const create = () => [0, 0, 0, 0]
    function pair(a) { return [a[0], a[1]] }
    const scale = (v, k) => [v[0] * k, v[2] * k]
    const mul = (out, a, b) => { out[0] = a[0] * b[3] + a[3] * b[0]; out[1] = a[1] * b[3] - a[2] * b[0]; out[2] = a[2]; out[3] = a[3] * b[3]; return out }
    const a = [1, 2, 3, 4], b = [0.5, 0.25, 2, 3], out = create(), made = [create]
    export let f = (hi, lo) => {
      a[2] = bits(hi, lo)
      mul(out, a, b)
      const [x, y] = pair(out), q = made[0]()
      q[1] = out[2]
      const s = scale(a, 2)
      return [out[0], out[1], typeof out[2], Number.isNaN(out[2]), String(out[2]), x, y, out[3], typeof q[1], q[1] === q[1], [out[2]][0] === out[2], s[0], typeof s[1], s[1] === s[1]]
    }
    export let g = (hi, lo) => {
      f(hi, lo)
      const t = new Float64Array(2); t[0] = out[2]; t[1] = made[0]()[0] + out[2]
      const w = new Uint32Array(t.buffer)
      return [w[1], w[0]]
    }
    export let h = (hi, lo) => { a[2] = bits(hi, lo); return pair([a[2], a[0]]) }`
  const want = oracle(src)
  for (const optimize of tiers()) {
    const got = jz(src, { optimize }).exports
    for (const [hi, lo] of PAYLOADS) {
      is(got.f(hi, lo), want.f(hi, lo), `f(${hi.toString(16)}:${lo.toString(16)}) O${optimize}`)
      // an exported function's lanes reach the host: what it returns is a Number to it
      is(got.h(hi, lo), want.h(hi, lo), `h(${hi.toString(16)}:${lo.toString(16)}) O${optimize}`)
      // (the size tier, one summary per function, joins `pair`'s parameter with h's literal, which the host reads: `out` stays boxed there)
      if (raw(optimize) && optimize !== 'size') is(got.g(hi, lo), [hi >>> 0, lo >>> 0], `bits kept ${hi.toString(16)}:${lo.toString(16)} O${optimize}`)
    }
  }
  if (belowOpt(2)) return
  const text = wat(src, { optimize: UNOPT })
  is(canons(funcWat(text, 'mul')), 0, 'the out-parameter stores keep their bits')
  is(canons(funcWat(text, 'scale')), 0, 'the lanes of a raw literal keep their bits')
})

test('numeric arrays: an array built of lanes keeps its bits through a compaction', () => {
  if (onWasi()) return
  // each step builds an array of a function's lanes and stores a payload spelling a heap pointer in it
  const src = `${BITS}
    const make = (i) => [0, i * 1], makers = [make, make]
    let hist = [], junk = []
    export const step = (i) => {
      const p = i & 2 ? make(i) : makers[i & 1](i)   // a call, and a call through the function's value (its trampoline)
      p[0] = bits(0x7FF88000, 0x8000 + (i % 1024) * 8)
      hist.push(p)
      if (hist.length > 40) hist = hist.slice(20)
      junk = [{ i }, { i: i + 1 }, [i]]
      let s = 0
      for (let k = 0; k < hist.length; k++) { const q = hist[k]; s += (q[0] === q[0] ? 1 : 0) + q[1] }
      return s + junk.length
    }
    export const low = (k) => { const t = new Float64Array(1), w = new Uint32Array(t.buffer); t[0] = hist[Number(k)][0]; return w[0] }
    export const n = () => hist.length`
  // (inlined, the function's literal is made where it is called: a call keeps the lanes with source inlining off)
  for (const optimize of [{ sourceInline: false }, ...levels(2, 3).map(level => ({ level, sourceInline: false }))]) {
    const want = oracle(src), { exports, memory } = jz(src, { optimize })
    let last = 0, compactions = 0
    for (let i = 0; i < 3000; i++) {
      is(exports.step(i), want.step(i), `step(${i}) O${optimize.level}`)
      if (memory.used < last) compactions++
      last = memory.used
    }
    if (optimize.level == null && !belowOpt(1)) ok(compactions >= 1, `compacted (${compactions})`)
    const len = exports.n(), first = 3000 - len
    for (let k = 0; k < len; k++) is(exports.low(k), 0x8000 + ((first + k) % 1024) * 8, `payload ${k} kept O${optimize.level}`)
  }
})

test('numeric arrays: a call no value reaches the receiver of reads nothing', () => {
  // three's Euler: `setFromQuaternion` hands the module's `_matrix` to a method of `this`,
  // and nothing calls it (a member another member calls, which nothing calls either): the
  // summary walks it with its receiver unbound.
  const src = `${BITS}
    class M {
      constructor() { this.e = [1, 0, 0, 1] }
      mul(a, b) { const t = this.e, x = a.e, y = b.e; const x0 = x[0], x1 = x[1], x2 = x[2], x3 = x[3]; t[0] = x0 * y[0] + x1 * y[2]; t[1] = x0 * y[1] + x1 * y[3]; t[2] = x2 * y[0] + x3 * y[2]; t[3] = x2 * y[1] + x3 * y[3]; return this }
    }
    const scratch = new M()
    class E {
      constructor() { this.v = 0 }
      fromQ(q) { scratch.mul(q, q); return this.apply(scratch) }
      apply(m) { this.v = m.e[0]; return this }
      reorder(q) { return this.fromQ(q) }
    }
    export let f = (k, n) => {
      const a = new M()
      a.e[1] = k
      for (let i = 0; i < n; i++) scratch.mul(scratch, a)
      const s = scratch.e
      return s[0] + s[1] * 3 + s[2] * 5 + s[3] * 7
    }
    export let g = (hi, lo) => { scratch.e[2] = bits(hi, lo); const s = scratch.e; return [typeof s[2], s[2] === s[2], s.length] }`
  const want = oracle(src)
  for (const optimize of tiers()) {
    const got = jz(src, { optimize }).exports
    // (one instance each: the scratch matrix carries its state from call to call, as the host's)
    const host = oracle(src)
    for (const [k, n] of [[0.5, 1], [2, 3], [-1.25, 0], [NaN, 2], [1e300, 4]]) is(got.f(k, n), host.f(k, n), `f(${k}, ${n}) O${optimize}`)
    for (const [hi, lo] of PAYLOADS) is(got.g(hi, lo), want.g(hi, lo), `g ${hi.toString(16)}:${lo.toString(16)} O${optimize}`)
  }
  if (belowOpt(2)) return
  const selfTests = (t) => (t.match(/\(f64\.ne \(local\.get (\$\S+)\) \(local\.get \1\)\)/g) || []).length
  for (const optimize of levels(2, 3)) is(selfTests(funcWat(wat(src, { optimize }), 'f')), 0, `f reads and stores the scratch's elements raw O${optimize}`)
})

test('numeric arrays: a store under the length of its own array keeps a pushed array raw', () => {
  // (a counter the loop bounds by the length it leaves alone stores into a cell the array
  // has: no hole, so the read there is a Number, and the elements stay Numbers)
  const build = `const build = (n) => { const a = []; for (let i = 0; i < n; i++) a.push(i); return a }`
  const src = `${build}
    const bump = (a) => { for (let i = 0; i < a.length; i++) a[i] = a[i] + 1; return a[0] }
    export let f = (n) => {
      const a = build(n)
      let s = 0
      for (let k = 0; k < 3; k++) s += bump(a)
      for (let i = 0; i < n; i++) s = (s * 31 + a[i]) % 1000003
      return s + a.length
    }`
  // (the length moves under these: each answers as the host does)
  const moved = `${build}
    const grow = (a) => { for (let i = 0; i < a.length; i++) { a[i] = a[i] * 2; if (i === 2) a.push(-1) } return a[a.length - 1] }
    const cut = (a) => { for (let i = 0; i < a.length; i++) { a[i] = a[i] + 3; if (i === 1) a.length = 3 } return a.length }
    const hole = (a) => { a.length += 2; for (let i = 0; i < a.length; i++) a[i] = a[i] + 1; return a[a.length - 1] }
    export let f = (n) => { const b = build(n), c = build(n), d = build(n); return grow(b) + b.length + cut(c) + c[c.length - 1] + hole(d) + d.length }`
  // (pops below the counter before its store: the store leaves a hole under it)
  const dropped = `${build}
    const drop = (a) => { for (let i = 0; i < a.length; i++) { if (i === 2) { a.pop(); a.pop(); a.pop(); a.pop() } a[i] = 7 } return a[1] }
    export let f = (n) => { const e = build(n), r = drop(e); return (r === undefined ? -1 : r) + e.length }`
  for (const program of [src, moved, dropped]) {
    const want = oracle(program)
    for (const optimize of tiers()) {
      const got = jz(program, { optimize }).exports
      for (const n of [0, 1, 3, 5, 40]) is(got.f(n), want.f(n), `f(${n}) O${optimize}`)
    }
  }
  if (belowOpt(2)) return
  is(canons(funcWat(wat(src, { optimize: UNOPT }), 'bump')), 0, 'the store keeps its bits: no canonicalization')
})

// A reader of a call's result reads the array the call hands on. The query answers a method
// by its result's type, so it names no array for `fill`, which returns its receiver and
// leaves it raw, nor for `at`, `pop` and `shift`, which return an element. The census reads
// through such a call (src/compile/numeric-arrays.js handsOn): the receiver and what it holds
// keep the boxed layout. Where it did not, the array stayed raw under the reader:
// a Number whose bits spell the hole was a hole to it, and `new Array(4).fill(x).map(f)`
// called `f` for none of its four elements.
test('numeric arrays: a reader of a call\'s result reads the array the call hands on', () => {
  const four = '[h, h, h, h]', pairs = `[${four}, ${four}]`, tally = '() => { n++; return 1 }'
  // [name, the statements after `const h = bits(hi, lo); let n = 0`]
  const rows = [
    ['fill, map', `new Array(4).fill(h).map(${tally}); return n`],
    ['fill, filter', `return new Array(4).fill(h).filter(() => true).length`],
    ['fill, forEach', `new Array(4).fill(h).forEach(() => { n++ }); return n`],
    ['fill, every', `new Array(4).fill(h).every(() => { n++; return true }); return n`],
    ['fill, some', `new Array(4).fill(h).some(() => { n++; return false }); return n`],
    ['fill, reduce', `return new Array(4).fill(h).reduce((k) => k + 1, 0)`],
    ['fill, includes', `return new Array(4).fill(h).includes(NaN) ? 1 : 0`],
    ['fill, indexOf', `return new Array(4).fill(h).indexOf(1)`],
    ['fill, join', `return new Array(3).fill(h).join('|')`],
    ['fill, slice', `new Array(4).fill(h).slice(1).forEach(() => { n++ }); return n`],
    ['fill, a spread, join', `return [...new Array(3).fill(h)].join('|')`],
    ['fill, a spread, includes', `return [...new Array(4).fill(h)].includes(NaN) ? 1 : 0`],
    ['at, fill, map', `const rows = [[1, 2, 3, 4], [5, 6, 7, 8]]; rows.at(1).fill(h).map(${tally}); return n`],
    ['at, a spread, join', `const rows = ${pairs}; return [...rows.at(1)].join('|')`],
    ['pop, a spread, includes', `const rows = ${pairs}; return [...rows.pop()].includes(NaN) ? 1 : 0`],
    ['shift, concat, join', `const rows = ${pairs}; return [7].concat(rows.shift()).join('|')`],
    ['fill, findIndex', `return new Array(4).fill(h).findIndex((v) => v !== v || v === 1)`],
    // (handed to a function: the size tier reads the element where it is passed)
    ['fill, an element', `return what(new Array(4).fill(h)[1])`],
    ['at, an element', `const rows = ${pairs}; return what(rows.at(1)[2]) * 10 + what(rows.pop()[0])`],
    ['at, an element a round', `const rows = ${pairs}; let s = 0; for (let i = 0; i < 4; i++) s += what(rows.at(0)[i]); return s`],
    ['reverse', `const t = ${four}; t.reverse().map(${tally}); return n`],
    ['sort', `const t = ${four}; t.sort().map(${tally}); return n`],
    ['copyWithin', `const t = ${four}; t.copyWithin(0, 1).map(${tally}); return n`],
    ['at', `const rows = ${pairs}; rows.at(1).map(${tally}); return n`],
    ['pop', `const rows = ${pairs}; rows.pop().map(${tally}); return n`],
    ['shift', `const rows = ${pairs}; rows.shift().map(${tally}); return n`],
    ['find', `const rows = ${pairs}; rows.find(() => true).map(${tally}); return n`],
    ['an element', `const rows = ${pairs}; rows[1].map(${tally}); return n`],
    ['a choice', `const a = ${four}, b = ${four}; (lo & 1 ? a : b).map(${tally}); return n`],
    ['an assignment', `let t; (t = ${four}).map(${tally}); return n + t.length`],
    ['a call of the program\'s', `const mk = () => ${four}; mk().map(${tally}); return n`],
  ]
  const src = `${BITS}\nconst what = (v) => v === undefined ? 1 : v !== v ? 2 : 3\n` + rows.map(([, body], i) => `export let r${i} = (hi, lo) => { const h = bits(hi, lo); let n = 0; ${body} }`).join('\n')
  const want = oracle(src)
  for (const optimize of tiers()) {
    const got = jz(src, { optimize }).exports
    for (const [hi, lo] of PAYLOADS) rows.forEach(([name], i) =>
      is(got[`r${i}`](hi, lo), want[`r${i}`](hi, lo), `${name} ${hi.toString(16)}:${lo.toString(16)} O${optimize}`))
  }
  // An element read over what a call hands on is the emitter's generic read, which cannot name
  // the array. A program of these reads alone: which read a tier takes out of line depends on
  // the program around it, and the size tier takes these.
  const paths = `${BITS}
    const kind = (v) => v === undefined ? 1 : v !== v ? 2 : 3
    export const elem = (hi, lo) => { const h = bits(hi, lo); return kind(new Array(4).fill(h)[1]) }
    export const elemNamed = (hi, lo) => { const h = bits(hi, lo); const t = new Array(4); return kind(t.fill(h)[2]) }
    export const elemLoop = (hi, lo) => { const h = bits(hi, lo); const t = new Array(4); let s = 0; for (let i = 0; i < 4; i++) s += kind(t.fill(h)[i]); return s }
    export const rowElem = (hi, lo) => { const h = bits(hi, lo); const rows = ${pairs}; return kind(rows.at(1)[2]) * 10 + kind(rows.pop()[0]) }
    export const rowLoop = (hi, lo) => { const h = bits(hi, lo); const rows = ${pairs}; let s = 0; for (let i = 0; i < 4; i++) s += kind(rows.at(0)[i]); return s }
    export const stored = (hi, lo) => { const h = bits(hi, lo); const rows = [[1, 2, 3, 4], [5, 6, 7, 8]]; rows.at(1)[2] = h; return kind(rows[1][2]) * 10 + kind(rows.at(1)[2]) }`
  const host = oracle(paths)
  for (const optimize of tiers()) {
    const got = jz(paths, { optimize }).exports
    for (const [hi, lo] of PAYLOADS) for (const name of ['elem', 'elemNamed', 'elemLoop', 'rowElem', 'rowLoop', 'stored'])
      is(got[name](hi, lo), host[name](hi, lo), `${name} ${hi.toString(16)}:${lo.toString(16)} O${optimize}`)
  }
})

// An array of Numbers is kept raw however the emitter makes it: by `Array.from`, by an
// array's `map`, by a literal that spreads Numbers into it, as by a literal of its own
// elements (src/summary/query.js taggedConstruction; the pointer tagged where the node is
// emitted, src/compile/emit/dispatch.js). What the maker stores is a Number's bits either
// way, so the array it fills is the cell's as a literal's is: a store after keeps its
// bits, the release walk and the compaction read no element of it. A `map` makes an array
// only of an array: of a receiver that is one on every run, reached by no optional link.
test('numeric arrays: an array Array.from, map or a spread literal makes is raw', () => {
  const SRC = 'const src = []; for (let i = 0; i < n; i++) src.push(i * 0.5)'
  // [name, the statements ahead, the array's expression]
  const makers = [
    ['Array.from of a count', '', 'Array.from({ length: n }, (_, i) => i * 0.5)'],
    // (its count is the source's, which no rule holds: the payload enters by a push, where a store at an index could leave a hole)
    ['Array.from of a typed array', 'const t = new Float64Array(n); for (let i = 0; i < n; i++) t[i] = i * 0.5', 'Array.from(t)', 'a.push(bits(hi, lo))', 'a[a.length - 1]'],
    ['Array.from of an array, mapped', SRC, 'Array.from(src, (v, i) => v + i)', 'a.push(bits(hi, lo))', 'a[a.length - 1]'],
    ['a map of a filled array', '', 'new Array(n).fill(0).map((_, i) => i * 0.5)'],
    ['a map of a built array', SRC, 'src.map((v) => v * 3)'],
    ['a copy by spread', SRC, '[...src]'],
    ['a spread beside elements', SRC, '[9, ...src, 8]'],
    ['two spreads', SRC, '[...src, ...src]'],
  ]
  // (the count a constant of the module: a store at an index a count of any value may not hold would leave a hole)
  const program = (pre, make, n, put = 'a[1] = bits(hi, lo)', at = 'a[1]') => `${BITS}
    const n = ${n}
    export let f = (hi, lo) => {
      ${pre}
      const a = ${make}
      ${put}
      a.push(n)
      let s = 0
      for (let i = 0; i < a.length; i++) s += a[i] === a[i] ? a[i] : 1000
      return [typeof a[1], a[1] === a[1], a[1] === undefined, a.length, s, a[0], a[a.length - 1]]
    }
    export let g = (hi, lo) => {
      ${pre}
      const a = ${make}
      ${put}
      const out = new Float64Array(1); out[0] = ${at}
      const w = new Uint32Array(out.buffer)
      return [w[1], w[0]]
    }
    let kept
    export let h = () => { ${pre}; kept = ${make}; return kept.length }
    export let last = () => kept[kept.length - 1]`
  for (const [name, pre, make, put, at] of makers) for (const n of [2, 9]) {
    const src = program(pre, make, n, put, at), want = oracle(src)
    for (const optimize of tiers()) {
      const got = jz(src, { optimize }).exports
      for (const [hi, lo] of PAYLOADS) {
        is(got.f(hi, lo), want.f(hi, lo), `${name} of ${n}: f(${hi.toString(16)}:${lo.toString(16)}) O${optimize}`)
        is([got.h(), got.last()], [want.h(), want.last()], `${name} of ${n}: kept in a module binding O${optimize}`)
        // (the bits a raw array keeps: a boxed one stores the canonical NaN)
        if (raw(optimize)) is(got.g(hi, lo), [hi >>> 0, lo >>> 0], `${name} of ${n}: bits kept ${hi.toString(16)}:${lo.toString(16)} O${optimize}`)
      }
    }
    // (the one a module binding keeps holds its pointer whole: a function's own may be read by its offset alone)
    if (!belowOpt(2)) ok(taggedIn(wat(src, { optimize: { level: 2, sourceInline: false } }), 'h'), `${name} of ${n}: made raw`)
  }

  // What keeps the boxed layout, each answering as the host: a maker's array a generic reader
  // reads; a `map` of a receiver that is no array on every run (the tag would be written
  // into the typed array the other receiver's `map` returns); one through an optional link.
  // `g` stores the payload and reads its bits back: a boxed array holds the canonical NaN.
  const READ = `const out = new Float64Array(1); out[0] = a[0]; const w = new Uint32Array(out.buffer); return [w[1], w[0]]`
  const boxed = [
    ['a made array a generic reader reads', `${BITS}
      export let f = (hi, lo) => { const a = Array.from({ length: 3 }, (_, i) => i + 1); a[1] = bits(hi, lo); return a.join(',') + a.slice(1).length }
      export let g = (hi, lo) => { const a = Array.from({ length: 3 }, (_, i) => i + 1); a[0] = bits(hi, lo); if (a.join(',').length < 0) return [0, 0]; ${READ} }`, [[]]],
    ['a map of what is an array on some runs and a typed array on others', `${BITS}
      let any = [1, 2, 3]
      export let swap = (k) => { any = k ? new Float64Array([4, 5, 6]) : [7, 8, 9]; return 0 }
      export let f = (hi, lo) => { const r = any.map(v => v + 1); r[0] = bits(hi, lo); return [r.length, r[1], r[2], r[0] === r[0]] }
      export let g = (hi, lo) => { const a = any.map(v => v + 1); a[0] = bits(hi, lo); ${READ} }`, [[], ['swap', 1], [], ['swap', 0], []]],
    ['a map through an optional link', `${BITS}
      const hold = { xs: [1, 2, 3] }
      const pick = (c) => c ? hold : null
      export let f = (hi, lo) => {
        const a = pick(lo & 1)?.xs.map(v => v * 2), b = pick(hi & 1 ? 0 : 1)?.xs.map(v => v * 2)
        if (a) a[0] = bits(hi, lo)
        if (b) b[0] = bits(hi, lo)
        return [a === undefined, a ? a.length + a[2] : -1, b === undefined, b ? b[0] === b[0] : -1]
      }
      export let g = (hi, lo) => { const a = pick(1)?.xs.map(v => v * 2); if (!a) return [0, 0]; a[0] = bits(hi, lo); ${READ} }`, [[]]],
  ]
  const nan = (hi, lo) => (hi & 0x7FF00000) === 0x7FF00000 && ((hi & 0xFFFFF) !== 0 || lo !== 0)
  for (const [name, src, calls] of boxed) {
    for (const optimize of tiers()) {
      // (one instance each: the binding a call swaps is carried from call to call, as the host's)
      const got = jz(src, { optimize }).exports, want = oracle(src)
      for (const [hi, lo] of PAYLOADS) {
        for (const [fn, ...args] of calls)
          fn ? is(got[fn](...args), want[fn](...args), `${name}: ${fn} O${optimize}`) : is(got.f(hi, lo), want.f(hi, lo), `${name}: f(${hi.toString(16)}:${lo.toString(16)}) O${optimize}`)
        is(got.g(hi, lo), nan(hi, lo) ? [0x7FF80000, 0] : [hi >>> 0, lo >>> 0], `${name}: a NaN stored is the canonical one ${hi.toString(16)}:${lo.toString(16)} O${optimize}`)
      }
    }
    if (!belowOpt(2)) ok(!taggedIn(wat(src, { optimize: { level: 2, sourceInline: false } }), 'f'), `${name}: its array is not raw`)
  }

  // A maker called for what it does alone hands on no array.
  const dropped = `let n = 0
    export let f = () => { n = 0; Array.from({ length: 3 }, (_, i) => { n += i + 1; return i }); [1, 2, 3].map((v) => { n += v; return v }); [...[4, 5]]; return n }`
  for (const optimize of tiers()) is(jz(dropped, { optimize }).exports.f(), oracle(dropped).f(), `makers for effect O${optimize}`)
})
