// Numeric arrays (src/compile/numeric-arrays.js): an Array the program proves
// holds only Numbers, made where the emitter tags it and read only through the
// emitter's own element paths, keeps its elements as raw f64 (its pointer's aux
// ARRAY_RAW, layout.js). A store takes the value's bits as they are, a read is
// the load; a NaN of any bits is read back as a Number. Every walk of memory
// (compaction, the release walk, the reset log) reads no element of such an
// array for a pointer, and every other use keeps the boxed layout.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz from '../index.js'
import { levels, onWasi, belowOpt } from './_matrix.js'
import { oracle, wat, funcWat } from './util.js'

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
    if (optimize === undefined || raw(optimize)) for (let k = 0; k < len; k++) is(exports.low(k), 0x8000 + ((first + k) % 1024) * 8, `payload ${k} kept O${optimize}`)
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
