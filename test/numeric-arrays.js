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
  // summary walks it with its receiver unbound. The scratch matrix's elements stay raw
  // for the calls that run: their stores keep their bits, their reads are the loads.
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
