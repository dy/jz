// A population of loops over arrays that may be one array, each answering what Node answers at
// levels 0 to 3, size and speed, whichever arrays the loop is handed: two views of one buffer at
// any distance (the store of one round read by a later one, or not yet overwritten when an earlier
// one reads it), made by `subarray`, by the constructor over the buffer, or the same view twice;
// 28 kernels (copies, maps, stencils, prefix sums, reductions, swaps, conditional stores, reversed
// and strided walks, a cursor, a wrap) over five element types, and five kernels over one array
// with the store a run-time distance from the load, a plain array among them. `off` and `n` arrive
// at run time, the trip count around a strip of lanes, and the function reads what the loop leaves
// in its locals.
import test from 'tst'
import { population } from './_population.js'

const CONFIGS = [0, 1, 2, 3, 'size', 'speed']

const TYPES = {
  f64: ['Float64Array', 'i * 37 % 23 - 11 + i % 4 * 0.25'],
  f32: ['Float32Array', 'i * 37 % 23 - 11 + i % 4 * 0.25'],
  i32: ['Int32Array', '(i * 40503 * 65537) | 0'],
  i16: ['Int16Array', 'i * 2053 % 65536 - 32768'],
  u8: ['Uint8Array', 'i * 37 % 251'],
}
// (d, s, n) each; every kernel returns a number
const KERN = {
  copy: 'for (let i = 0; i < n; i++) d[i] = s[i]; return 0',
  map: 'for (let i = 0; i < n; i++) d[i] = s[i] * 2 + 1; return 0',
  acc2: 'for (let i = 0; i < n; i++) d[i] = d[i] + s[i]; return 0',
  next: 'for (let i = 0; i + 1 < n; i++) d[i] = s[i + 1] + s[i]; return 0',
  prev: 'for (let i = 1; i < n; i++) d[i] = s[i - 1] - s[i]; return 0',
  sten: 'for (let i = 1; i + 1 < n; i++) d[i] = s[i - 1] + s[i] * 2 + s[i + 1]; return 0',
  first: 'for (let i = 0; i < n; i++) d[i] = s[0] + i; return 0',
  lastEl: 'if (n > 0) for (let i = 0; i < n; i++) d[i] = s[n - 1] - i; return 0',
  scale0: 'for (let i = 0; i < n; i++) d[i] = s[i] * d[0]; return 0',
  prefix: 'let acc = 0; for (let i = 0; i < n; i++) { acc += s[i]; d[i] = acc } return acc',
  dot: 'let acc = 0; for (let i = 0; i < n; i++) acc += s[i] * d[i]; return acc',
  sum: 'let acc = 0; for (let i = 0; i < n; i++) acc += s[i]; return acc',
  two: 'for (let i = 0; i < n; i++) { d[i] = s[i] + 1; s[i] = d[i] * 2 } return 0',
  swap: 'for (let i = 0; i < n; i++) { const t = d[i]; d[i] = s[i]; s[i] = t } return 0',
  cond: 'for (let i = 0; i < n; i++) if (s[i] > 0) d[i] = s[i] * 2; return 0',
  tern: 'for (let i = 0; i < n; i++) d[i] = s[i] > 0 ? s[i] : -s[i]; return 0',
  last: 'let last = -1; for (let i = 0; i < n; i++) { last = s[i]; d[i] = last + 1 } return last',
  count: 'let i = 0; for (; i < n; i++) d[i] = s[i] + 3; return i',
  min: 'let m = Infinity; for (let i = 0; i < n; i++) m = Math.min(m, s[i]); return m',
  minIf: 'let m = 1e9; for (let i = 0; i < n; i++) if (s[i] < m) m = s[i]; return m',
  rev: 'for (let i = n - 1; i >= 0; i--) d[i] = s[i] + 1; return 0',
  step2: 'for (let i = 0; i < n; i += 2) d[i] = s[i] * 3; return 0',
  cursor: 'let o = 0; for (let i = 0; i < n; i++) { d[o] = s[i]; o += 1 } return o',
  sq: 'for (let i = 0; i < n; i++) d[i] = s[i] * s[i]; return 0',
  fill: 'for (let i = 0; i < n; i++) d[i] = 7; return 0',
  wrap: 'for (let i = 0; i < n; i++) d[i] = s[(i + 1) % n] + 1; return 0',
  tenth: 'for (let i = 0; i < n; i++) d[i] = s[i] * 0.1 + s[i]; return 0',
  third: 'for (let i = 0; i < n; i++) d[i] = s[i] / 3; return 0',
}
// how the two views of one buffer are made (BASE the first element of `d`)
const VIEW = {
  sub: (T) => `const d = buf.subarray(16, 16 + n), s = buf.subarray(16 + off, 16 + off + n)`,
  ctor: (T) => `const d = new ${T}(buf.buffer, 16 * ${T}.BYTES_PER_ELEMENT, n), s = new ${T}(buf.buffer, (16 + off) * ${T}.BYTES_PER_ELEMENT, n)`,
  same: (T) => `const d = buf.subarray(16, 16 + n), s = off === 0 ? d : buf.subarray(16 + off, 16 + off + n)`,
}
const prog = (T, seed, kern, view) => `
const N = 64
const mk = () => { const b = new ${T}(N); for (let i = 0; i < N; i++) b[i] = ${seed}; return b }
const kern = (d, s, n) => { ${kern} }
const sum = (b) => { let h = 0; for (let i = 0; i < N; i++) h = (h * 31) % 1000003 + b[i] * (i + 1); return h }
export const f = (off, n) => {
  const w = mk(), x = mk()
  const r0 = kern(w.subarray(0, 4), x.subarray(8, 12), 4)
  const buf = mk()
  ${view(T)}
  const r = kern(d, s, n)
  return sum(buf) + r * 7 + sum(w) + r0
}`
// one array, the store a run-time distance from the load
const ONE = {
  shift: 'for (let i = lo; i < hi; i++) a[i + off] = a[i] * 2 + 1; return 0',
  shiftAcc: 'for (let i = lo; i < hi; i++) a[i + off] = a[i] + a[i + off]; return 0',
  shiftSum: 'let s = 0; for (let i = lo; i < hi; i++) { s += a[i]; a[i + off] = s } return s',
  shiftRev: 'for (let i = hi - 1; i >= lo; i--) a[i + off] = a[i] + 1; return 0',
  shiftCond: 'for (let i = lo; i < hi; i++) if (a[i] > 0) a[i + off] = a[i] - 1; return 0',
}
const progOne = (make, seed, kern) => `
const N = 40
const mk = () => { ${make} }
const kern = (a, off, lo, hi) => { ${kern} }
const sum = (b) => { let h = 0; for (let i = 0; i < N; i++) h = (h * 31) % 1000003 + b[i] * (i + 1); return h }
export const f = (off, n) => {
  const w = mk()
  const r0 = kern(w, 1, 0, 3)
  const a = mk()
  const r = kern(a, off, off < 0 ? -off : 0, off > 0 ? n - off : n)
  return sum(a) + r * 7 + sum(w) + r0
}`

const OFFS = [-9, -8, -7, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 7, 8, 9], NS = [0, 1, 2, 3, 4, 5, 7, 8, 9, 15, 16, 17, 24]
const args = []
for (const off of OFFS) for (const n of NS) args.push([off, n])

const progs = []
for (const [t, [T, seed]] of Object.entries(TYPES)) {
  for (const [k, kern] of Object.entries(KERN)) for (const [v, view] of Object.entries(VIEW))
    progs.push({ name: `${t} ${k} ${v}`, src: prog(T, seed, kern, view), args })
  for (const [k, kern] of Object.entries(ONE))
    progs.push({ name: `${t} ${k} one`, src: progOne(`const b = new ${T}(N); for (let i = 0; i < N; i++) b[i] = ${seed}; return b`, seed, kern), args })
}
for (const [k, kern] of Object.entries(ONE))
  progs.push({ name: `arr ${k} one`, src: progOne(`const b = []; for (let i = 0; i < N; i++) b.push(i * 37 % 23 - 11 + i % 4 * 0.25); return b`, '', kern), args })

test(`vector alias population: ${progs.length} loops over two views of one buffer, ${args.length} offsets and counts, ${CONFIGS.length} configurations`, () =>
  population('vector alias', progs, { configs: CONFIGS, own: ['N', 'mk', 'kern', 'sum'] }))
