// A population of arithmetic on narrow typed-array elements, each answering what Node answers
// at levels 0, 2 and speed: JS computes in Numbers (an int32 where the operators say
// so) and the store keeps the low bits, and a lane of the element's width must give the same.
// 48 expressions `b[i] = E(a[i], c[i])` over each of seven integer element types and twelve
// mixed triples (narrow into wide, wide into narrow, signed against unsigned, into and from
// floats), and eleven reductions over eight types; trip counts around a strip of each lane
// width. It found a comparison in a narrow lane, `b[i] = a[i] & c[i]` into a Uint8ClampedArray
// storing 0 past 127 (dc4858fbc, lift.js laneCompare), and a uint32 divided as a signed word
// (cdc3b0711): .work/architecture.md, "Found reviewing 6a".
//
// Two programs meet a divergence the README documents ("Bitwise operands under 2^63": an
// operand of magnitude 2^63 or more reads as -1, as 0 when negative, where JS takes it modulo
// 2^32): `(a[i] * c[i]) >> 8` and `>> 15` of two Uint32Array elements, whose product passes
// 2^63. Node runs them as the README reads them, the product so converted before the shift.
import test from 'tst'
import { population } from './_population.js'

// (levels 1, 3 and size agree too, 2026-11-15: 266 s of one core for the six levels at load 20;
// with either fix above taken out, level 2 is the first to differ)
const CONFIGS = [0, 2, 'speed']

const TYPES = {
  i32: ['Int32Array', '(q * 40503 * 65537) | 0'], u32: ['Uint32Array', '(q * 40503 * 65537) >>> 0'],
  i16: ['Int16Array', 'q * 2053 % 65536 - 32768'], u16: ['Uint16Array', 'q * 2053 % 65536'],
  i8: ['Int8Array', 'q * 37 % 256 - 128'], u8: ['Uint8Array', 'q * 37 % 251'], u8c: ['Uint8ClampedArray', 'q * 37 % 251'],
  f32: ['Float32Array', 'q * 37 % 23 - 11 + q % 4 * 0.25'], f64: ['Float64Array', 'q * 37 % 23 - 11 + q % 4 * 0.25'],
}
const seedAt = (seed, d) => seed.replace(/q/g, `(q + ${d})`)
const program = (ta, tb, tc, kernel) => `const a = new ${TYPES[ta][0]}(128), b = new ${TYPES[tb][0]}(128), c = new ${TYPES[tc][0]}(128)
export let f = (n) => {
  for (let q = 0; q < 128; q++) { a[q] = ${TYPES[ta][1]}; b[q] = ${seedAt(TYPES[tb][1], 3)}; c[q] = ${seedAt(TYPES[tc][1], 7)} }
  let ret = 0
  ${kernel}
  let h = 0; for (let q = 0; q < 128; q++) h = (h * 31 + a[q] * 3 + b[q] * 5 + c[q]) % 1000003
  return h + ret
}`
const TRIPS = [0, 1, 3, 4, 7, 8, 9, 15, 16, 17, 31, 32, 33, 64]
const progs = []
const loop = body => `for (let i = 0; i < n; i++) ${body}`
// b[i] = E(a[i], c[i]): each expression over every same-type triple, and into another type
const EXPR = {
  'avg': '(a[i] + c[i]) >> 1', 'avg u': '(a[i] + c[i]) >>> 1', 'avg round': '(a[i] + c[i] + 1) >> 1', 'half': 'a[i] / 2',
  'half int': '(a[i] / 2) | 0', 'diff': 'a[i] - c[i]', 'abs diff': 'Math.abs(a[i] - c[i])', 'fixed mul': '(a[i] * c[i]) >> 8',
  'fixed mul 15': '(a[i] * c[i]) >> 15', 'gray': '(a[i] * 77 + c[i] * 150 + b[i] * 29) >> 8', 'scale': 'a[i] * 3',
  'scale shift': '(a[i] * 3) >> 2', 'neg': '-a[i]', 'not': '~a[i]', 'shr': 'a[i] >> 3', 'shru': 'a[i] >>> 3', 'shl': 'a[i] << 3',
  'shl then shr': '(a[i] << 4) >> 4', 'shru then and': '(a[i] >>> 4) & 15', 'xor shift': 'a[i] ^ (a[i] >> 1)', 'mod': 'a[i] % 7',
  'div': '(a[i] / 3) | 0', 'max': 'a[i] > c[i] ? a[i] : c[i]', 'math max': 'Math.max(a[i], c[i])', 'sat add': 'Math.min(a[i] + c[i], 255)',
  'clamp': 'Math.max(0, Math.min(255, a[i] + c[i]))', 'sum 3': 'a[i] + b[i] + c[i]', 'mul': 'a[i] * c[i]', 'imul': 'Math.imul(a[i], c[i])',
  'square': 'a[i] * a[i]', 'cmp': 'a[i] > c[i] ? 1 : 0', 'cmp u': '(a[i] >>> 0) > (c[i] >>> 0) ? 1 : 0', 'eq': 'a[i] === c[i] ? 255 : 0',
  'sign': 'a[i] < 0 ? -1 : a[i] > 0 ? 1 : 0', 'lerp': 'a[i] + (((c[i] - a[i]) * 3) >> 2)', 'round': 'Math.round(a[i] / 3)',
  'trunc': 'Math.trunc(a[i] / 3)', 'floor': 'Math.floor(a[i] / 3)', 'or 0': 'a[i] | 0', 'unsigned': 'a[i] >>> 0', 'and': 'a[i] & c[i]',
  'add const': 'a[i] + 200', 'sub const': 'a[i] - 200', 'mul const': 'a[i] * 255', 'bool': 'a[i] > 100', 'inc': 'a[i] + 1',
  'rotate': '(a[i] << 3) | (a[i] >>> 13)', 'byte swap': '((a[i] & 255) << 8) | ((a[i] >> 8) & 255)',
}
const SAME = ['i32', 'u32', 'i16', 'u16', 'i8', 'u8', 'u8c']
for (const [name, e] of Object.entries(EXPR)) {
  for (const t of SAME) progs.push({ name: `${t} ${name}`, src: program(t, t, t, loop(`b[i] = ${e}`)) })
  // narrow into wide, wide into narrow, signed against unsigned, into floats and from them
  for (const [ta, tb, tc] of [['u8', 'i16', 'u8'], ['i16', 'u8', 'i16'], ['i8', 'u8', 'u8'], ['u8', 'i32', 'i8'], ['i32', 'u8', 'i32'],
    ['u16', 'i16', 'i16'], ['u8', 'f32', 'u8'], ['f64', 'u8', 'f64'], ['f32', 'i16', 'f32'], ['f64', 'u8c', 'f64'], ['i16', 'f64', 'u8'], ['u32', 'f64', 'i32']])
    progs.push({ name: `${ta}>${tb}(${tc}) ${name}`, src: program(ta, tb, tc, loop(`b[i] = ${e}`)) })
}
// reductions over narrow elements
const RED = {
  'sum': 'let s = 0; for (let i = 0; i < n; i++) s += a[i]; ret = s', 'sum of products': 'let s = 0; for (let i = 0; i < n; i++) s += a[i] * c[i]; ret = s',
  'sum int': 'let s = 0; for (let i = 0; i < n; i++) s = (s + a[i]) | 0; ret = s', 'xor': 'let s = 0; for (let i = 0; i < n; i++) s ^= a[i]; ret = s',
  'max': 'let m = -1e9; for (let i = 0; i < n; i++) if (a[i] > m) m = a[i]; ret = m', 'math min': 'let m = 1e9; for (let i = 0; i < n; i++) m = Math.min(m, a[i]); ret = m',
  'count': 'let k = 0; for (let i = 0; i < n; i++) if (a[i] > c[i]) k++; ret = k', 'sum abs diff': 'let s = 0; for (let i = 0; i < n; i++) s += Math.abs(a[i] - c[i]); ret = s',
  'sum imul': 'let s = 0; for (let i = 0; i < n; i++) s = (s + Math.imul(a[i], c[i])) | 0; ret = s', 'or': 'let s = 0; for (let i = 0; i < n; i++) s |= a[i]; ret = s',
  'hash': 'let s = 7; for (let i = 0; i < n; i++) s = (Math.imul(s, 31) + a[i]) | 0; ret = s',
}
for (const [name, k] of Object.entries(RED)) for (const t of [...SAME, 'f32']) progs.push({ name: `${t} reduce ${name}`, src: program(t, t, t, k) })
for (const p of progs) p.args = TRIPS.map(n => [n])
// (the README's reading of a shift's operand past 2^63, for the two programs that reach it)
const R63 = '((v) => v >= 2 ** 63 ? -1 : v <= -(2 ** 63) ? 0 : v)'
for (const p of progs) if (p.name === 'u32 fixed mul' || p.name === 'u32 fixed mul 15') p.node = p.src.replace('b[i] = (a[i] * c[i]) >>', `b[i] = ${R63}(a[i] * c[i]) >>`)

test(`vector narrow population: ${progs.length} loops of narrow-element arithmetic, ${CONFIGS.length} configurations`, () =>
  population('vector narrow', progs, { configs: CONFIGS, own: ['a', 'b', 'c'] }))
