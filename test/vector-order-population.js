// A population of loops over typed arrays in every order their statements read and write one
// array, each answering what Node answers at levels 0, 2 and speed (the integrator's population
// for phase 6a's review, written without reading the writer's tests): two sites of one base in
// either statement order at distances around a strip of each lane width, stencils and records in
// place, what a loop leaves in a local or a global, ramps and narrow lanes, shifts, arms, exits
// and counts, outer loops over inner ones, straight lines, and one function over its arrays
// apart or one. Module arrays a, b, c and a global g; `n` the trip count; `ret` and g join the
// hash of the three arrays. Beside them the nine programs of the vectorizer census whose answer
// differed from Node's ("6a landed": W7 to W9 the dependence test, W1, W2 and W6 the account of
// locals, W3 and W5 a store under a condition, W4 a shift in a narrow lane), which
// test/vector-legality.js pins at levels 2 and 3.
import test from 'tst'
import { population } from './_population.js'
import { onKernel } from './_matrix.js'

// (levels 1, 3 and size agree too, native and under WASI, 2026-11-15: 236 s of one core for the
// six levels at load 20; with a part of 6a's legality taken out, level 2 is the first to differ)
const CONFIGS = [0, 2, 'speed']

const TYPES = {
  f64: ['Float64Array', 'q * 37 % 23 - 11 + q % 4 * 0.25', ' * 0.5 + 1', 2],
  f32: ['Float32Array', 'q * 37 % 23 - 11 + q % 4 * 0.25', ' * 0.5 + 1', 4],
  i32: ['Int32Array', '(q * 40503 * 65537) | 0', ' + 7', 4],
  i16: ['Int16Array', 'q * 2053 % 65536 - 32768', ' + 7', 8],
  u8: ['Uint8Array', 'q * 37 % 251', ' + 7', 16],
}
const ALL = Object.keys(TYPES), INT = ['i32', 'i16', 'u8'], FLT = ['f64', 'f32'], SMALL = ['f64', 'f32', 'i16', 'u8']
const TRIPS = [0, 1, 2, 3, 4, 5, 7, 8, 9, 15, 16, 17, 31, 32, 33, 47, 64]
const seedAt = (seed, d) => d ? seed.replace(/q/g, `(q + ${d})`) : seed

const program = (type, kernel) => {
  const [T, seed] = TYPES[type]
  return `const a = new ${T}(128), b = new ${T}(128), c = new ${T}(128)
let g = 0
export let f = (n) => {
  for (let q = 0; q < 128; q++) { a[q] = ${seed}; b[q] = ${seedAt(seed, 3)}; c[q] = ${seedAt(seed, 7)} }
  g = 0
  let ret = 0
  ${kernel}
  let h = 0; for (let q = 0; q < 128; q++) h = (h * 31 + a[q] * 3 + b[q] * 5 + c[q]) % 1000003
  return h + ret + g
}`
}
// the same body as a function of its arrays, called with them apart and as one
const programP = (type, kernel) => {
  const [T, seed] = TYPES[type]
  return `const a = new ${T}(128), b = new ${T}(128), c = new ${T}(128)
const kern = (d, s, t, n) => { ${kernel}; return 0 }
const fill = () => { for (let q = 0; q < 128; q++) { a[q] = ${seed}; b[q] = ${seedAt(seed, 3)}; c[q] = ${seedAt(seed, 7)} } }
const hash = () => { let h = 0; for (let q = 0; q < 128; q++) h = (h * 31 + a[q] * 3 + b[q] * 5 + c[q]) % 1000003; return h }
export let f = (n) => {
  let r = 0
  fill(); r += kern(a, b, c, n) + hash()
  fill(); r += kern(a, a, b, n) * 3 + hash()
  fill(); r += kern(b, a, a, n) * 5 + hash()
  fill(); r += kern(a, b, a, n) * 7 + hash()
  fill(); r += kern(a, a, a, n) * 11 + hash()
  return r
}`
}

const progs = []
const add = (name, most, body, types = ALL, make = program) => {
  for (const t of types) {
    const src = make(t, (typeof body === 'function' ? body(TYPES[t]) : body).replace(/@/g, TYPES[t][2]))
    progs.push({ name: `${t} ${name}`, src, args: TRIPS.filter(n => n <= most).map(n => [n]) })
  }
}

for (const t of ALL) {
  const L = TYPES[t][3]
  for (const d of [...new Set([1, L - 1, L, L + 1])]) {
    add(`store, load ahead ${d}`, 64, `for (let i = 0; i < n; i++) { a[i + 20] = b[i]@; c[i] = a[i + ${20 + d}] }`, [t])
    add(`store, load behind ${d}`, 64, `for (let i = 0; i < n; i++) { a[i + 20] = b[i]@; c[i] = a[i + ${20 - d}] }`, [t])
    add(`load behind ${d}, store`, 64, `for (let i = 0; i < n; i++) { c[i] = a[i + ${20 - d}]; a[i + 20] = b[i]@ }`, [t])
    add(`load ahead ${d}, store`, 64, `for (let i = 0; i < n; i++) { c[i] = a[i + ${20 + d}]; a[i + 20] = b[i]@ }`, [t])
    add(`temp ahead ${d}`, 64, `for (let i = 0; i < n; i++) { const t = a[i + ${20 + d}]; a[i + 20] = t@ }`, [t])
    add(`temp behind ${d}`, 64, `for (let i = 0; i < n; i++) { const t = a[i + ${20 - d}]; a[i + 20] = t@ }`, [t])
    add(`two stores, second ahead ${d}`, 64, `for (let i = 0; i < n; i++) { a[i + 20] = b[i]@; a[i + ${20 + d}] = c[i] }`, [t])
    add(`two stores, second behind ${d}`, 64, `for (let i = 0; i < n; i++) { a[i + ${20 + d}] = c[i]; a[i + 20] = b[i]@ }`, [t])
  }
}
// stencils and records
add('stencil in place', 64, `for (let i = 0; i < n; i++) a[i + 20] = a[i + 19] + a[i + 21]`)
add('stencil ahead in place', 64, `for (let i = 0; i < n; i++) a[i + 20] = a[i + 21] + a[i + 22]`)
add('stencil self and next', 64, `for (let i = 0; i < n; i++) a[i + 20] = (a[i + 20] + a[i + 21]) * 2`)
add('stencil two bases', 64, `for (let i = 0; i < n; i++) b[i + 20] = a[i + 19] + a[i + 20] * 2 + a[i + 21]`)
add('stencil store behind', 64, `for (let i = 0; i < n; i++) a[i + 19] = a[i + 20] + a[i + 21]`)
add('aos swap', 30, `for (let i = 0; i < n; i++) { const x = a[2 * i], y = a[2 * i + 1]; a[2 * i] = y; a[2 * i + 1] = x@ }`)
add('aos chain', 30, `for (let i = 0; i < n; i++) { a[2 * i] = a[2 * i + 1]@; a[2 * i + 1] = a[2 * i] }`)
add('aos next pixel', 30, `for (let i = 0; i < n; i++) a[2 * i + 3] = a[2 * i] + a[2 * i + 1]`)
add('aos prev pixel', 30, `for (let i = 1; i < n; i++) a[2 * i] = a[2 * i - 2] + a[2 * i + 1]`)
add('aos4 rotate', 30, `for (let i = 0; i < n; i++) { const r = a[4 * i], w = a[4 * i + 1], p = a[4 * i + 2]; a[4 * i] = w; a[4 * i + 1] = p; a[4 * i + 2] = r@ }`)
add('aos4 carry', 30, `for (let i = 0; i < n; i++) { a[4 * i + 4] = a[4 * i + 3]@; a[4 * i + 1] = a[4 * i] }`)
add('aos3', 40, `for (let i = 0; i < n; i++) { a[3 * i] = a[3 * i + 1]@; a[3 * i + 2] = a[3 * i + 3] }`)
add('aos to soa', 30, `for (let i = 0; i < n; i++) { b[i] = a[2 * i]@; c[i] = a[2 * i + 1] }`)
add('expand in place', 30, `for (let i = 0; i < n; i++) { a[2 * i + 8] = a[i]@; a[2 * i + 9] = a[i + 1] }`)
add('compress in place', 60, `for (let i = 0; i < n; i++) a[i] = a[2 * i] + a[2 * i + 1]`)
add('mirror in place odd', 64, `for (let i = 1; i < n; i++) a[n + 3 - i] = a[i]@`)
add('mirror read', 64, `for (let i = 0; i < n; i++) b[i] = a[i] + a[n - 1 - i]`)
add('mirror read in place', 64, `for (let i = 0; i < n; i++) a[i] = a[i] + a[n - 1 - i]`)
// what the loop leaves in a local or a global
add('last index if', 64, `let last = -1; for (let i = 0; i < n; i++) { if (a[i] > 0) last = i; b[i] = a[i]@ } ret = last`)
add('two lane locals after', 64, `let p = 0, w = 0; for (let i = 0; i < n; i++) { p = a[i]@; w = p * 2; b[i] = w } ret = p + w * 3`)
add('counter after', 64, `let i = 0; for (; i < n; i++) b[i] = a[i]@; ret = i`)
add('cursor by 2 after', 50, `let o = 0; for (let i = 0; i < n; i++) { b[o] = a[i]@; o += 2 } ret = o`)
add('compaction', 64, `let o = 0; for (let i = 0; i < n; i++) if (a[i] > 0) { b[o] = a[i]; o++ } ret = o`)
add('count beside map', 64, `let cnt = 0; for (let i = 0; i < n; i++) { if (a[i] > 0) cnt++; b[i] = a[i]@ } ret = cnt`)
add('sum beside map', 64, `let s = 0; for (let i = 0; i < n; i++) { s += a[i]; b[i] = a[i] * 2 } ret = s`)
add('min and index', 64, `let m = 1e9, mi = -1; for (let i = 0; i < n; i++) if (a[i] < m) { m = a[i]; mi = i } ret = m * 3 + mi`)
add('delta', 64, `let prev = 0; for (let i = 0; i < n; i++) { b[i] = a[i] - prev; prev = a[i] } ret = prev`)
add('running max', 64, `let m = -1e9; for (let i = 0; i < n; i++) { if (a[i] > m) m = a[i]; b[i] = m } ret = m`)
add('global sum', 64, `for (let i = 0; i < n; i++) { g += a[i]; b[i] = a[i]@ }`)
add('global last', 64, `for (let i = 0; i < n; i++) { g = a[i]; b[i] = g * 2 }`)
add('global stepped', 64, `g = 3; for (let i = 0; i < n; i++) { b[i] = a[i] + g; g = g + 1 }`)
add('global sum alone', 64, `for (let i = 0; i < n; i++) g += a[i] * 2`)
add('sum of squares, local after', 64, `let s = 0, d = 0; for (let i = 0; i < n; i++) { d = a[i] * 2; s = s + d * d } ret = s + d`, SMALL)
add('two sums', 64, `let s = 0, t = 0; for (let i = 0; i < n; i++) { s += a[i]; t += b[i] * 2 } ret = s * 3 + t`)
add('sum read in the loop', 64, `let s = 0; for (let i = 0; i < n; i++) { s += a[i]; if (s > 100) b[i] = 1 } ret = s`)
add('max after', 64, `let m = -1e9; for (let i = 0; i < n; i++) m = Math.max(m, a[i]); ret = n ? m : 0`)
add('break', 64, `let i = 0; for (; i < n; i++) { if (a[i] < -9) break; b[i] = a[i]@ } ret = i`)
add('continue', 64, `for (let i = 0; i < n; i++) { if ((i & 3) === 1) continue; b[i] = a[i]@ }`)
// ramps and narrow lanes
add('ramp', 64, `for (let i = 0; i < n; i++) b[i] = i * 3 + 1`)
add('ramp squared', 64, `for (let i = 0; i < n; i++) b[i] = (i * i) & 255`)
add('ramp beside map', 64, `for (let i = 0; i < n; i++) { b[i] = i & 127; c[i] = a[i]@ }`)
add('ramp local after', 64, `let t = 0; for (let i = 0; i < n; i++) { t = (i * 5) & 255; b[i] = t } ret = t`)
add('ramp second counter', 64, `let j = 5; for (let i = 0; i < n; i++) { b[i] = j & 255; j += 3 } ret = j`)
add('ramp stepped in the body', 64, `for (let i = 0; i < n; i++) { b[i] = i & 127; if (a[i] > 5) i++ }`)
for (const s of [7, 8, 15, 16, 17, 31]) {
  add(`shr ${s}`, 64, `for (let i = 0; i < n; i++) b[i] = (a[i] * a[i]) >> ${s}`, INT)
  add(`shru ${s}`, 64, `for (let i = 0; i < n; i++) b[i] = (a[i] * 251) >>> ${s}`, INT)
  add(`shl ${s}`, 64, `for (let i = 0; i < n; i++) b[i] = a[i] << ${s}`, INT)
}
add('shift by counter', 64, `for (let i = 0; i < n; i++) b[i] = a[i] >> (i & 7)`, INT)
add('shift by element', 64, `for (let i = 0; i < n; i++) b[i] = a[i] << (c[i] & 31)`, INT)
add('shift by wide element', 64, `for (let i = 0; i < n; i++) b[i] = a[i] >> c[i]`, INT)
// arms
add('sqrt abs', 64, `for (let i = 0; i < n; i++) b[i] = Math.sqrt(Math.abs(a[i]))`, FLT)
add('log to int', 64, `for (let i = 0; i < n; i++) { const v = Math.abs(a[i]); if (v > 3) { c[i] = 7; b[i] = (Math.log(v * 1.5 + 1) * 20) | 0 } }`)
add('exp arm', 64, `for (let i = 0; i < n; i++) { if (a[i] > 0) b[i] = (Math.exp((a[i] & 31) * 0.125) * 8) | 0; else c[i] = 1 }`)
add('ternary sqrt', 64, `for (let i = 0; i < n; i++) b[i] = a[i] > 0 ? Math.sqrt(a[i]) : 0`, FLT)
add('if else stores', 64, `for (let i = 0; i < n; i++) { if (a[i] > 0) b[i] = a[i]@; else c[i] = a[i] }`)
add('if two stores', 64, `for (let i = 0; i < n; i++) if (a[i] > 0) { b[i] = 1; c[i] = a[i]@ }`)
add('cond store feeds the next test', 64, `for (let i = 0; i < n; i++) if (a[i] > 0) { b[i] = a[i]@; a[i + 1] = 0 }`)
add('cond store behind', 64, `for (let i = 1; i < n; i++) if (a[i] > 0) a[i - 1] = a[i]@`)
add('odd only', 64, `for (let i = 0; i < n; i++) if (i & 1) b[i] = a[i]@`)
add('select assign', 64, `for (let i = 0; i < n; i++) { let v = a[i]; if (v < 0) v = -v; b[i] = v@ }`)
add('clamp', 64, `for (let i = 0; i < n; i++) b[i] = Math.min(Math.max(a[i], -4), 4)`)
// how the loop counts
add('unsigned exit', 64, `for (let x = n - 8; x >= 0 && x < n; x++) b[x] = a[x]@`)
add('unsigned exit shr', 64, `for (let x = n - 8; (x >>> 0) < n; x++) b[x] = a[x]@`)
add('start 3', 64, `for (let i = 3; i < n; i++) b[i] = a[i - 3]@`)
add('descending in place', 64, `for (let i = n - 1; i >= 0; i--) a[i + 1] = a[i]@`)
add('descending', 64, `for (let i = n - 1; i >= 0; i--) b[i] = a[i]@`)
add('step 2', 64, `for (let i = 0; i < n; i += 2) b[i] = a[i]@`)
add('le bound', 64, `for (let i = 0; i <= n; i++) b[i] = a[i]@`)
add('ne bound', 64, `for (let i = 0; i !== n; i++) b[i] = a[i]@`)
add('bound n - 1', 64, `for (let i = 0; i < n - 1; i++) b[i] = a[i + 1] - a[i]`)
add('bound the body lowers', 64, `let m = n; for (let i = 0; i < m; i++) { b[i] = a[i]@; if (a[i] > 9) m-- } ret = m`)
add('bound read from an array the body stores', 64, `c[0] = n; for (let i = 0; i < c[0]; i++) { b[i] = a[i]@; if (i === 5) c[0] = 3 }`)
add('bound read from the stored array', 64, `b[100] = n; for (let i = 0; i < b[100]; i++) b[i + 90] = a[i] & 3`)
// an outer loop over an inner one
add('row sums', 12, `for (let y = 0; y < n; y++) { let s = 0; for (let x = 0; x < 8; x++) s += a[y * 8 + x]; b[y] = s }`)
add('row sums minus', 12, `for (let y = 0; y < n; y++) { let s = 100; for (let x = 0; x < 8; x++) s -= a[y * 8 + x]; b[y] = s }`)
add('row prefix', 12, `for (let y = 0; y < n; y++) { let s = 0; for (let x = 0; x < 8; x++) s += a[y * 8 + x]; b[y + 1] = s + b[y] }`)
add('row sums into the next row', 12, `for (let y = 0; y < n; y++) { let s = 0; for (let x = 0; x < 8; x++) s += a[y * 8 + x]; a[y * 8 + 8] = (s | 0) & 63 }`)
add('row sum after', 12, `let s = 0; for (let y = 0; y < n; y++) { s = 0; for (let x = 0; x < 8; x++) s += a[y * 8 + x]; b[y] = s } ret = s`)
add('ranges', 40, `for (let r = 0; r <= n; r++) c[r] = r * 2 + (r & 1); for (let r = 0; r < n; r++) { let s = 0; for (let k = c[r]; k < c[r + 1]; k++) s += a[k]; b[r] = s }`)
add('ranges times', 40, `for (let r = 0; r <= n; r++) c[r] = r * 3 - (r & 1); for (let r = 0; r < n; r++) { let s = 0; for (let k = c[r]; k < c[r + 1]; k++) s += a[k] * b[k + 40]; b[r] = s }`, SMALL)
add('taps', 60, `for (let i = 0; i < n; i++) { let s = 0; for (let k = 0; k < 4; k++) s += a[i + k] * c[k]; b[i] = s }`, SMALL)
add('taps stored ahead', 60, `for (let i = 0; i < n; i++) { let s = 0; for (let k = 0; k < 4; k++) s += a[i + k]; a[i + 2] = (s | 0) & 63 }`)
add('pixel escape', 40, `for (let x = 0; x < n; x++) { let z = 0, it = 0; const k0 = a[x] * 0.0625; while (it < 20) { z = z * z + k0; if (z > 4) break; it++ } b[x] = it }`, FLT)
add('pixel escape carried', 40, `let k = 0.5; for (let x = 0; x < n; x++) { let z = 0, it = 0; while (it < 20) { z = z * z + k; if (z > 4) break; it++ } b[x] = it; k = k + 0.001 * it } ret = k`, ['f64'])
add('pixel escape local after', 40, `let it = 0; for (let x = 0; x < n; x++) { let z = 0; it = 0; const k0 = a[x] * 0.0625; while (it < 20) { z = z * z + k0; if (z > 4) break; it++ } b[x] = it } ret = it`, FLT)
// straight lines
add('line dot pair', 0, `b[0] = a[0] * c[0] + a[1] * c[1]; b[1] = a[2] * c[0] + a[3] * c[1]`)
add('line dot in place', 0, `a[0] = a[0] * c[0] + a[1] * c[1]; a[1] = a[0] * c[2] + a[1] * c[3]`)
add('line chain', 0, `b[0] = a[0] + 1; b[1] = b[0] + a[1]`)
add('line chain 4', 0, `a[1] = a[0] + 1; a[2] = a[1] + 1; a[3] = a[2] + 1; a[4] = a[3] + 1`)
add('line unrolled', 0, `for (let i = 0; i < 4; i++) a[i + 1] = a[i] + 1`)
add('line swap', 0, `const t0 = a[0], t1 = a[1]; a[0] = t1; a[1] = t0`)
add('line pairs crossing', 0, `a[1] = b[0] + 1; a[2] = b[1] + 1; b[1] = a[1] * 2; b[2] = a[2] * 2`)
add('line zeros', 0, `b[0] = a[1] * 0 - 0; b[1] = -(a[2] * 0); ret = (1 / b[0] > 0 ? 1 : 2) + (1 / b[1] > 0 ? 4 : 8)`, FLT)
add('line mat2 in place', 0, `const m0 = a[0] * b[0] + a[1] * b[2], m1 = a[0] * b[1] + a[1] * b[3]; a[2] = a[2] * b[0] + a[3] * b[2]; a[3] = a[2] * b[1] + a[3] * b[3]; a[0] = m0; a[1] = m1`)
// one function, its arrays apart or one
add('P shift up', 64, `for (let i = 0; i < n; i++) d[i + 1] = s[i]@`, ALL, programP)
add('P shift down', 64, `for (let i = 0; i < n; i++) d[i] = s[i + 1]@`, ALL, programP)
add('P store, load ahead', 64, `for (let i = 0; i < n; i++) { d[i + 20] = t[i]@; s[i] = d[i + 21] }`, ALL, programP)
add('P store then copy on', 64, `for (let i = 0; i < n; i++) { d[i] = s[i]@; t[i + 1] = d[i] }`, ALL, programP)
add('P sum beside map', 64, `let acc = 0; for (let i = 0; i < n; i++) { acc += s[i]; d[i] = t[i]@ } return acc`, ALL, programP)
add('P mirror read', 64, `for (let i = 0; i < n; i++) d[i] = s[i] + t[n - 1 - i]`, ALL, programP)
add('P strided store', 60, `for (let i = 0; i < n; i++) d[2 * i + 1] = s[i] + t[2 * i]`, ALL, programP)
add('P cond store ahead', 64, `for (let i = 0; i < n; i++) if (s[i] > 0) d[i + 1] = t[i]@`, ALL, programP)
add('P stencil', 64, `for (let i = 1; i < n; i++) d[i] = s[i - 1] + s[i] + t[i + 1]`, ALL, programP)
add('P first element', 64, `for (let i = 0; i < n; i++) d[i] = s[0] + t[i]`, ALL, programP)

test(`vector order population: ${progs.length} loops over typed arrays one may alias, ${CONFIGS.length} configurations`, () => {
  if (onKernel()) return
  population('vector order', progs, { configs: CONFIGS, own: ['a', 'b', 'c', 'kern', 'fill', 'hash'] })
})

// The census's nine, each `f()` of no argument
const fillA = 'for (let i = 0; i < 64; i++) a[i] = ((i * 7) % 13) - 5.75'
const hashA = 'let h = 0; for (let i = 0; i < 64; i++) h = (h * 31 + a[i]) % 1000003; return h'
const P = {
  'W1 reduce lane local read after': `const a = new Float64Array(64)
export let f = () => { ${fillA}
  let s = 0, d = 0
  for (let i = 0; i < 64; i++) { d = a[i] * 2; s = s + d * d }
  return s + d }`,
  'W2 ramp two steps': `const a = new Uint8Array(64)
export let f = () => { for (let i = 0; i < 64; i++) { a[i] = i & 127; i++ }
  ${hashA} }`,
  'W3 ramp conditional store': `const a = new Uint8Array(64), b = new Uint8Array(64)
export let f = () => { for (let i = 0; i < 64; i++) { a[i] = i & 127; if ((i & 1) === 0) b[i] = 7 }
  let h = 0; for (let i = 0; i < 64; i++) h = (h * 31 + b[i]) % 1000003; return h }`,
  'W4 ramp shift 16': `const a = new Uint8Array(64), b = new Uint8Array(64)
export let f = () => { for (let i = 0; i < 64; i++) a[i] = (i * 37 + 11) & 127
  for (let i = 0; i < 64; i++) b[i] = (a[i] * a[i]) >> 16
  let h = 0; for (let i = 0; i < 64; i++) h = (h * 31 + b[i]) % 1000003; return h }`,
  'W5 tone-map arm store': `const d = new Int32Array(64), a = new Int32Array(64), b = new Int32Array(64)
export let f = () => { for (let i = 0; i < 64; i++) d[i] = (i * 37 + 11) & 127
  for (let i = 0; i < 64; i++) { const v = d[i]; if (v > 60) { b[i] = 7; a[i] = (Math.log(v * 1.5 + 1) * 20) | 0 } }
  let h = 0; for (let i = 0; i < 64; i++) h = (h * 31 + a[i] + b[i]) % 1000003; return h }`,
  'W6 divergent escape carried scalar': `const out = new Float64Array(64)
export let f = () => { let k = 0.5
  for (let x = 0; x < 64; x++) { let zx = 0, it = 0
    while (it < 50) { zx = zx * zx + k; if (zx > 4) break; it++ }
    out[x] = it; k = k + 0.001 * it }
  return k }`,
  'W7 mirror store': `const a = new Float64Array(64)
export let f = () => { ${fillA}
  for (let i = 1; i < 63; i++) a[63 - i] = a[i]
  ${hashA} }`,
  'W8 aos stride 2': `const a = new Float64Array(64)
export let f = () => { ${fillA}
  for (let i = 0; i < 31; i++) a[2 * i + 2] = a[2 * i] + 1
  ${hashA} }`,
  'W9 aos stride 4': `const a = new Float64Array(64)
export let f = () => { ${fillA}
  for (let i = 0; i < 15; i++) a[4 * i + 4] = a[4 * i] + 1
  ${hashA} }`,
}
const census = Object.entries(P).map(([name, src]) => ({ name, src, args: [[]] }))

test(`vector order population: the census's ${census.length} programs, ${CONFIGS.length} configurations`, () =>
  population('vector census', census, { configs: CONFIGS, own: ['a', 'b', 'd', 'out'] }))
