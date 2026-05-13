import { medianUs, mix, printResult } from '../_lib/benchlib.js'

// CRC-32 (IEEE, reflected) over a byte buffer, table-driven, hammered many
// passes per run. Pure-integer kernel: Uint8Array reads, an Int32Array LUT,
// `>>>`, `^`, `&` — all bit-exact between wasm i32 and JS, so jz and V8 must
// agree on the checksum. Exercises the typed-array-param + i32-narrowing path
// (`crc32(buf, table)` is the hot inner call) without any float arithmetic.

const N = 16384        // buffer length in bytes
const N_ITERS = 220    // CRC passes over the whole buffer per kernel run
const N_RUNS = 21
const N_WARMUP = 5

const buildTable = (table) => {
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
    table[n] = c | 0
  }
}

const initBuf = (buf) => {
  let x = 0x12345678 | 0
  for (let i = 0; i < N; i++) {
    x = (Math.imul(x, 1103515245) + 12345) | 0
    buf[i] = (x >>> 16) & 0xff
  }
}

const crc32 = (buf, table) => {
  let c = 0xffffffff | 0
  for (let i = 0; i < N; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const runKernel = (buf, table) => {
  let h = 0
  for (let it = 0; it < N_ITERS; it++) {
    h = mix(h, crc32(buf, table) | 0)
    const j = it % N
    buf[j] = (buf[j] + 1) & 0xff   // perturb the buffer so the CRC can't be hoisted out of the loop
  }
  return h >>> 0
}

export let main = () => {
  const buf = new Uint8Array(N)
  const table = new Int32Array(256)
  buildTable(table)
  initBuf(buf)
  let cs = 0
  for (let i = 0; i < N_WARMUP; i++) cs = runKernel(buf, table)

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = performance.now()
    cs = runKernel(buf, table)
    samples[i] = performance.now() - t0
  }
  printResult(medianUs(samples), cs, N * N_ITERS, 1, N_RUNS)
}
