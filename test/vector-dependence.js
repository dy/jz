// A population of dependence-shaped loops over typed arrays, each answering what Node answers
// at every level and with the vectorizer off (src/optimize/vectorize/legality.js): two sites at
// `c * i + k` on one base and on two, at strides 1 to 4, the load before the store and after
// it; a mirror; a second store; a store under a condition; a local read after the loop; a
// counter stepped twice; a value the body carries from one iteration to the next. Five
// element types; trip counts around a strip of each lane width, from the arguments.
import test from 'tst'
import { is } from 'tst/assert.js'
import { jz, oracle } from './util.js'

const N = 80
const TYPES = {
  f64: ['Float64Array', 'k * 37 % 23 - 11 + k % 4 * 0.25', ' * 0.5 + 1'],
  f32: ['Float32Array', 'k * 37 % 23 - 11 + k % 4 * 0.25', ' * 0.5 + 1'],
  i32: ['Int32Array', '(k * 40503 * 65537) | 0', ' + 7'],
  i16: ['Int16Array', 'k * 2053 % 65536 - 32768', ' + 7'],
  u8: ['Uint8Array', 'k * 37 % 251', ' + 7'],
}
const TRIPS = [0, 1, 2, 3, 4, 5, 7, 8, 9, 15, 16, 17, 31, 32, 33, 63, 64, 65]
const CONFIGS = [0, 1, 2, 3, 'size', { level: 'speed', vectorizeLaneLocal: false, slp: false }]

// One program: `kernel` uses `n`, its trip count (at most `most`), and may set `ret`.
const program = (type, kernel) => {
  const [T, seed] = TYPES[type]
  return `const a = new ${T}(${N}), b = new ${T}(${N})
export let f = (n) => {
  for (let k = 0; k < ${N}; k++) { a[k] = ${seed}; b[k] = ${seed.replace(/k/g, '(k + 3)')} }
  let ret = 0
  ${kernel}
  let h = 0; for (let k = 0; k < ${N}; k++) h = (h * 31 + a[k] * 3 + b[k]) % 1000003
  return h + ret
}`
}

const kernels = []
const add = (name, types, most, kernel) => { for (const t of types) kernels.push({ name: `${name} ${t}`, src: program(t, kernel(TYPES[t][2])), most }) }
const ALL = Object.keys(TYPES)
// (the largest trip count keeping `c * (n - 1) + k` inside the array)
const reach = (c, k) => Math.floor((N - 1 - k) / c) + 1
for (const c of [1, 2, 3, 4]) {
  const at = (k) => k ? `${c} * i + ${k}` : `${c} * i`
  // one base, load then store: k1 ahead of k0 is a value an earlier iteration stored
  for (const [k0, k1] of [[0, c], [c, 0], [0, 2 * c], [0, 1], [1, 0], [0, 3]])
    add(`one base a[${at(k1)}] = a[${at(k0)}]`, ALL, reach(c, Math.max(k0, k1)), op => `for (let i = 0; i < n; i++) a[${at(k1)}] = a[${at(k0)}]${op}`)
}
for (const c of [1, 2]) {
  const at = (k) => k ? `${c} * i + ${k}` : `${c} * i`
  // one base, store then load
  for (const [k0, k1] of [[0, c], [c, 0], [0, 0], [0, 2 * c]])
    add(`store a[${at(k0)}] then load a[${at(k1)}]`, ALL, Math.min(N, reach(c, Math.max(k0, k1))), () => `for (let i = 0; i < n; i++) { a[${at(k0)}] = i; b[i] = a[${at(k1)}] }`)
  // two bases
  for (const [k0, k1] of [[0, 0], [0, 1], [1, 0]])
    add(`two bases b[${at(k1)}] = a[${at(k0)}]`, ALL, reach(c, Math.max(k0, k1)), op => `for (let i = 0; i < n; i++) b[${at(k1)}] = a[${at(k0)}]${op}`)
  // a second store
  for (const [k1, k2] of [[c, 0], [0, c], [1, 2]])
    add(`second store a[${at(k1)}], a[${at(k2)}]`, ALL, reach(c, Math.max(k1, k2)), op => `for (let i = 0; i < n; i++) { a[${at(k1)}] = a[${at(0)}]${op}; a[${at(k2)}] = 9 }`)
}
// a mirror, in place and into another array, from 0 and from 1
for (const [m, most] of [['n - 1', 64], ['n', 64], ['2 * n - 1', 40], ['n + 5', 64]])
  for (const s of [0, 1]) {
    add(`mirror a[${m} - i] = a[i] from ${s}`, ['f64', 'i32', 'u8'], most, op => `const m = ${m}; for (let i = ${s}; i < n; i++) a[m - i] = a[i]${op}`)
    add(`mirror b[${m} - i] = a[i] from ${s}`, ['f64', 'i32'], most, op => `const m = ${m}; for (let i = ${s}; i < n; i++) b[m - i] = a[i]${op}`)
  }
// a store under a condition, beside a store the lanes take and alone
for (const k of [0, 1, 2]) add(`conditional store a[i + ${k}]`, ALL, N - 2, op => `for (let i = 0; i < n; i++) if (a[i] > 3) a[i + ${k}] = a[i]${op}`)
add('ramp beside a conditional store', ALL, N, () => 'for (let i = 0; i < n; i++) { b[i] = i & 63; if ((i & 1) === 0) a[i] = 7 }')
// a local read after the loop
add('a lane local read after', ALL, N, op => 'let d = 0; for (let i = 0; i < n; i++) { d = a[i]' + op + '; b[i] = d } ret = d')
add('a reduction and its lane local read after', ['f64', 'f32', 'i32'], N, () => 'let s = 0, d = 0; for (let i = 0; i < n; i++) { d = a[i] * 2; s = s + d * d } ret = s + d')
// a counter stepped twice
add('a counter stepped twice', ALL, N, op => 'for (let i = 0; i < n; i++) { b[i] = a[i]' + op + '; i++ }')
add('a ramp stepped twice', ALL, N, () => 'for (let i = 0; i < n; i++) { b[i] = i & 63; i++ }')
// a value the body carries
add('a value carried', ['f64', 'f32'], N, () => 'let s = 0; for (let i = 0; i < n; i++) { s = s * 0.5 + a[i]; b[i] = s } ret = s')
add('a value carried', ['i32', 'i16', 'u8'], N, () => 'let s = 0; for (let i = 0; i < n; i++) { s = (s ^ a[i]) + 1; b[i] = s } ret = s')
add('a scalar the pixel loop carries', ['f64'], N, () => `let k = 0.5
  for (let x = 0; x < n; x++) { let zx = 0, it = 0
    while (it < 50) { zx = zx * zx + k; if (zx > 4) break; it++ }
    b[x] = it; k = k + 0.001 * it }
  ret = k`)

test(`vector dependence: ${kernels.length} loops, ${CONFIGS.length} configurations, trip counts to 65`, () => {
  for (const { name, src, most } of kernels) {
    const want = oracle(src), trips = TRIPS.filter(n => n <= most)
    for (const optimize of CONFIGS) {
      const got = jz(src, { optimize }).exports
      for (const n of trips) is(got.f(n), want.f(n), `${name} (n = ${n}) at ${JSON.stringify(optimize)}`)
    }
  }
})
