import compileSelf from '../../scripts/self.js'
import { medianUs, mix, printResult } from '../_lib/benchlib.js'

// Compiler bench: drive the WHOLE jz pipeline — parse (jessie) → jzify →
// prepare → compile → watr-encode — over three small-but-representative
// programs at optimize level 2. This is the self-host workload: the jz row
// runs the compiler compiled by itself (jz.wasm compiling JS), every JS-engine
// row runs the same compiler source as plain JS. Output bytes are checksummed,
// so the cross-engine checksum gate doubles as a determinism proof.

// Memory note: the kernel bump-allocates per compile with no free — the
// instance watermarks at ~0.5 GB over a full run's 45 compiles. The page's
// runner instantiates fresh per click and drops the instance after, so the
// cost is transient; the module itself starts at 64 pages (4 MB).
const N_RUNS = 13
const N_WARMUP = 2
const N_ITERS = 3

const PROG_LOOP = `
export let dot = (n) => {
  let a = new Float64Array(n), b = new Float64Array(n)
  for (let i = 0; i < n; i++) { a[i] = i * 0.5; b[i] = i * 0.25 }
  let s = 0
  for (let i = 0; i < n; i++) s += a[i] * b[i]
  return s
}`

const PROG_CLOSURE = `
let mk = (k) => (x) => x * k + 1
let f2 = mk(2), f3 = mk(3)
export let go = (n) => {
  let t = 0
  for (let i = 0; i < n; i++) t = (t + f2(i) + f3(i)) | 0
  return t
}`

const PROG_DATA = `
let parts = ['jz', 'compiles', 'itself']
export let label = (n) => {
  let out = ''
  for (let i = 0; i < n; i++) out += parts[i % 3] + '-'
  return out.length
}`

const checksumBytes = (buf) => {
  let h = 0x811c9dc5 | 0
  for (let i = 0; i < buf.length; i++) h = mix(h, buf[i])
  return h >>> 0
}

export let main = () => {
  let h = 0x811c9dc5 | 0
  let cs = 0
  for (let i = 0; i < N_WARMUP; i++) {
    h = 0x811c9dc5 | 0
    for (let k = 0; k < N_ITERS; k++) {
      if (k % 3 === 0) cs = checksumBytes(compileSelf(PROG_LOOP, 0, '2'))
      else if (k % 3 === 1) cs = checksumBytes(compileSelf(PROG_CLOSURE, 0, '2'))
      else cs = checksumBytes(compileSelf(PROG_DATA, 0, '2'))
      h = mix(h, cs)
    }
    cs = h >>> 0
  }

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = performance.now()
    h = 0x811c9dc5 | 0
    for (let k = 0; k < N_ITERS; k++) {
      if (k % 3 === 0) cs = checksumBytes(compileSelf(PROG_LOOP, 0, '2'))
      else if (k % 3 === 1) cs = checksumBytes(compileSelf(PROG_CLOSURE, 0, '2'))
      else cs = checksumBytes(compileSelf(PROG_DATA, 0, '2'))
      h = mix(h, cs)
    }
    cs = h >>> 0
    samples[i] = performance.now() - t0
  }
  printResult(medianUs(samples), cs, N_ITERS, 3, N_RUNS)
}
