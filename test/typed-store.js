// An integer element store converts its value by ToInt32 (SetValueInBuffer,
// ES2026 §25.1.3.16): the low 32 bits of a finite value's integer part, 0 for
// NaN and the infinities, the store's width keeping the low bits. The emitter
// stores the word a value narrows to (ir/numeric.js i32Narrowed: an i32, an
// integer element's read with its convert peeled, a checked read of one whose
// miss is 0, an exact-int tree, a bounded f64 tree) without an f64 detour or a
// call; only a value the runtime alone bounds converts through __to_int32, at
// the speed tiers behind its inline fast path. A receiver a module `let` holds
// (made in a resize, so nullable) keeps that word through the check of the
// receiver. Every form is compared with the host at every tier.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz from '../index.js'
import { compile } from '../index.js'
import { levels } from './_matrix.js'
import { oracle } from './util.js'

const agrees = (src, calls, label) => {
  const host = oracle(src)
  for (const optimize of levels(0, 2, 3, 'size')) {
    const mod = jz(src, { optimize }).exports
    for (const [name, ...args] of calls) {
      const want = host[name](...args), got = mod[name](...args)
      ok(Object.is(want, got), `${label}: ${name}(${args.join(',')}) at ${optimize}: ${String(got)} for ${String(want)}`)
    }
  }
}

test('typed store: clamping preserves the magnitude of unsigned element reads', () => {
  for (const init of ['const dst = new Uint8ClampedArray(1)', 'let dst; dst = new Uint8ClampedArray(1)']) {
    const src = `${init}; const values = new Uint32Array([0, 255, 2147483647, 2147483648, 4294967295]);
      export function f(i) { dst[0] = values[i]; return dst[0] }`
    agrees(src, [0, 0, 1, 2, 3, 4, 5, -1, 4, 0].map(i => ['f', i]), init)
  }
})

test('typed store: pointer carriers still coerce and assignments return the original value', () => {
  for (const ctor of ['Int32Array', 'Uint32Array', 'Uint8ClampedArray']) {
    const src = `export function f(i) {
      const dst = new ${ctor}(1); let calls = 0;
      const value = { valueOf() { calls++; return 42 } };
      dst[i] = value;
      const assigned = (dst[i] = value);
      return [dst[0], calls, assigned === value];
    }`
    const host = oracle(src).f
    for (const optimize of levels(0, 1, 2, 3, 'size')) {
      const { f } = jz(src, { optimize }).exports
      for (const i of [0, 0, 1, -1, 0]) is(f(i), host(i), `${ctor} O${optimize}: index ${i}`)
    }
    const assignment = `export function f(i) {
      const dst = new ${ctor}(1), values = new Uint32Array([2147483648, 4294967295]);
      return [dst[0] = values[i], dst[0] = -1, dst[0]];
    }`
    const expected = oracle(assignment).f
    for (const optimize of levels(0, 1, 2, 3, 'size')) {
      const { f } = jz(assignment, { optimize }).exports
      for (const i of [0, 1, 2, 0]) is(f(i), expected(i), `${ctor} O${optimize}: value ${i}`)
    }
  }
})

test('typed store: a throwing conversion runs before an invalid index but after a null receiver check', () => {
  for (const ctor of ['Int32Array', 'Uint8ClampedArray', 'Float64Array']) {
    const src = `let dst;
      export function f(i, missing, fail) {
        dst = missing ? null : new ${ctor}(1); let trace = '';
        function key() { trace += 'k'; return i }
        function rhs() { trace += 'r'; return { valueOf() { trace += 'v'; if (fail) throw 7; return 42 } } }
        let error = '';
        try { dst[key()] = rhs(); trace += 's' } catch(e) { error = e === 7 ? 'seven' : e.name }
        return [trace, error, missing ? -1 : dst[0]];
      }`
    const expected = oracle(src).f
    for (const optimize of levels(0, 1, 2, 3, 'size')) {
      const { f } = jz(src, { optimize }).exports
      for (const args of [[0,0,0],[0,0,0],[0,0,1],[1,0,1],[-1,0,1],[0,1,1],[0,1,0],[0,0,0]])
        is(f(...args), expected(...args), `${ctor} O${optimize}: ${args}`)
    }
  }
})

// The values: a checked read that hits and one that misses, constants, an i32
// expression, sums only the runtime bounds, the non-numbers ToInt32 takes to 0.
const values = `let u8, i16, u32, i32
export const resize = (n) => { u8 = new Uint8Array(n); i16 = new Int16Array(n); u32 = new Uint32Array(n); i32 = new Int32Array(n); return n }
const src = new Uint8Array(4); src[0] = 200; src[1] = 7; src[2] = 255; src[3] = 1
export const hit = (j) => { u8[0] = src[j]; i16[0] = src[j]; u32[0] = src[j]; i32[0] = src[j]; return u8[0] * 1e9 + i16[0] * 1e6 + u32[0] * 1e3 + i32[0] }
export const constant = () => { u8[0] = 300.7; i16[0] = -1; u32[0] = -1; i32[0] = 4e9; return u8[0] * 1e9 + i16[0] + u32[0] * 1e3 + i32[0] }
export const shifted = () => { u8[0] = 250; u8[0] = (u8[0] * 234) >> 8; u32[0] = (u8[0] << 24) | 5; return u8[0] * 1e12 + u32[0] }
export const clamped = (a) => { u8[0] = 250; const v = u8[0] + a; u8[0] = v > 255 ? 255 : v; i32[0] = v; u32[0] = v; return u8[0] * 1e13 + i32[0] * 1e4 + u32[0] }
export const atoms = (k) => { const v = k === 0 ? undefined : k === 1 ? null : k === 2 ? true : k === 3 ? NaN : k === 4 ? Infinity : -Infinity; u8[0] = v; i32[0] = v; u32[0] = v; return u8[0] * 1e9 + i32[0] * 1e4 + u32[0] }
export const valued = (a) => { const r = (u8[0] = a); const s = (i32[1] = src[5]); return r * 1e6 + (s === undefined ? -1 : s) }`
const wide = [['hit', 0], ['hit', 1], ['hit', 3], ['hit', 9], ['constant'], ['shifted'],
  ['clamped', 3], ['clamped', 300], ['clamped', -300.5], ['clamped', 4294967296 + 7], ['clamped', 2 ** 64], ['clamped', -(2 ** 63) - 4096], ['clamped', NaN], ['clamped', Infinity],
  ['atoms', 0], ['atoms', 1], ['atoms', 2], ['atoms', 3], ['atoms', 4], ['atoms', 5],
  ['valued', 300.7], ['valued', -1.5], ['valued', 2 ** 40 + 3]]

test('typed store: every value converts as ToInt32 does, through a receiver a module let holds', () => {
  agrees(`${values}\nresize(4)`, wide, 'module let')
})

test('typed store: the same through local receivers', () => {
  const local = values.replace('let u8, i16, u32, i32\n', 'const u8 = new Uint8Array(4), i16 = new Int16Array(4), u32 = new Uint32Array(4), i32 = new Int32Array(4)\n')
    .replace(/export const resize = .*\n/, 'export const resize = (n) => n\n')
  agrees(local, wide, 'local')
})

// The pixel composite (`px[i] = lut[ink[i]]`, a lut of 256 entries indexed by a
// byte, both arrays made at a resize) and the pixel fade store words: no
// ToInt32 call at any tier. A clamped sum only the runtime bounds converts
// inline at the speed tiers, the call its cold arm; -Os keeps the call alone.
const pixels = `let W = 0, H = 0, px, ink
let lut = new Uint32Array(256)
export const resize = (w, h) => { W = w; H = h; ink = new Uint8Array(W * H); px = new Uint32Array(W * H); return px }
export const composite = () => { const n = W * H; let i = 0; while (i < n) { px[i] = lut[ink[i]]; i++ } }
export const fade = () => { const n = W * H; for (let i = 0; i < n; i++) ink[i] = (ink[i] * 246) >> 8 }`
const splat = `let ink
export const resize = (n) => { ink = new Uint8Array(n); return n }
export const splat = (p, a) => { const v = ink[p] + a; ink[p] = v > 255 ? 255 : v }`
const fn = (wat, name) => wat.match(new RegExp(`\\(func \\$${name}\\b[\\s\\S]*?\\n  \\)\\n`))?.[0] ?? ''
const calls = (s) => (s.match(/call \$__to_int32/g) || []).length
// the s-expression of a function's first store of the kind
const store = (body, op) => { const at = body.indexOf(`(${op}`); let depth = 0; for (let i = at; i < body.length; i++) { if (body[i] === '(') depth++; else if (body[i] === ')' && --depth === 0) return body.slice(at, i + 1) } return '' }

test('typed store: a composite through a byte lut and a fade store words, no ToInt32 call', () => {
  for (const optimize of [0, 2, 3, 'size', 'speed']) {
    const wat = compile(pixels, { optimize, wat: true })
    is(calls(fn(wat, 'composite')), 0, `composite at ${optimize}`)
    is(calls(fn(wat, 'fade')), 0, `fade at ${optimize}`)
    const st = store(fn(wat, 'composite'), 'i32.store')
    ok(st && !/trunc|convert|call/.test(st), `composite stores the loaded word at ${optimize}`)
  }
})

test('typed store: a clamped sum converts inline at the speed tiers, through the kernel at -Os', () => {
  for (const optimize of [2, 3, 'speed']) {
    const body = fn(compile(splat, { optimize, wat: true }), 'splat')
    ok(/i64\.trunc_sat_f64_s/.test(body), `the fast path is inline at ${optimize}`)
    is(calls(body), 1, `the kernel is the cold arm at ${optimize}`)
    ok(/\(else\s*\(call \$__to_int32/.test(body.replace(/\n\s*/g, ' ')), `the call is under the else at ${optimize}`)
  }
  const lean = fn(compile(splat, { optimize: 'size', wat: true }), 'splat').replace(/\n\s*/g, ' ')
  is(calls(lean), 1, 'the call alone at -Os')
  ok(!/\(else\s*\(call \$__to_int32/.test(lean), 'no inline fast path at -Os')
})

// ToUint8Clamp (ES2026 §7.1.12): the value clamped to [0, 255], rounded half
// to even, NaN to 0. The store converts inline: `f64.nearest` of the clamped
// value for a number, two selects for a word, a folded constant. No call.
const clamped = `let d
export const resize = (n) => { d = new Uint8ClampedArray(n); return n }
const src = new Int16Array(4); src[0] = -7; src[1] = 300; src[2] = 128
export const put = (i, r) => { d[i] = r; d[i + 1] = 300; d[i + 2] = (r * 255) | 0; d[i + 3] = src[i]; return d[i] * 1e9 + d[i + 1] * 1e6 + d[i + 2] * 1e3 + d[i + 3] }
export const fill = (r) => { d.fill(r); return d[0] }
export const valued = (r) => (d[0] = r)`
test('typed store: a clamped byte rounds half to even inside [0, 255], inline', () => {
  const edges = [0.5, 1.5, 2.5, 254.5, 255.5, -0.5, 0.49999, 300, -300, NaN, Infinity, -Infinity, 1e300, 127.5, 128.5, -1.2, 2, -2000000000, 2000000000]
  agrees(clamped + '\nresize(8)', [...edges.flatMap(r => [['put', 0, r], ['put', 1, r], ['fill', r], ['valued', r]])], 'clamped')
  for (const optimize of [0, 2, 3, 'size', 'speed']) {
    const wat = compile(clamped, { optimize, wat: true })
    is((fn(wat, 'put').match(/__u8_clamp/g) || []).length, 0, `no clamp call at ${optimize}`)
    if (optimize !== 0) is((fn(wat, 'put').match(/f64\.nearest/g) || []).length, 1, `one rounding, of the number: a word and a constant clamp without it, at ${optimize}`)
  }
})
