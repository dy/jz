// A population of loops over arrays that may be one array, each answering what Node answers at
// levels 0 to 3, size and speed, whichever arrays the loop is handed: two views of one buffer at
// any distance (the store of one round read by a later one, or not yet overwritten when an earlier
// one reads it), made by `subarray`, by the constructor over the buffer, or the same view twice;
// the 28 kernels of test/_vector-alias.js (copies, maps, stencils, prefix sums, reductions, swaps,
// conditional stores, reversed and strided walks, a cursor, a wrap) over five element types, and
// five kernels over one array
// with the store a run-time distance from the load, a plain array among them. `off` and `n` arrive
// at run time, the trip count around a strip of lanes, and the function reads what the loop leaves
// in its locals.
import test from 'tst'
import { population, sampled } from './_population.js'
import { TYPES, KERN, VIEW, program } from './_vector-alias.js'

const CONFIGS = [0, 1, 2, 3, 'size', 'speed']

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
    progs.push({ name: `${t} ${k} ${v}`, src: program(T, seed, kern, view), args })
  for (const [k, kern] of Object.entries(ONE))
    progs.push({ name: `${t} ${k} one`, src: progOne(`const b = new ${T}(N); for (let i = 0; i < N; i++) b[i] = ${seed}; return b`, seed, kern), args })
}
for (const [k, kern] of Object.entries(ONE))
  progs.push({ name: `arr ${k} one`, src: progOne(`const b = []; for (let i = 0; i < N; i++) b.push(i * 37 % 23 - 11 + i % 4 * 0.25); return b`, '', kern), args })

test(sampled(`vector alias population: ${progs.length} loops over two views of one buffer, ${args.length} offsets and counts, ${CONFIGS.length} configurations`), () =>
  population('vector alias', progs, { configs: CONFIGS, own: ['N', 'mk', 'kern', 'sum'] }))
