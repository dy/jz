// gainclass.as.ts — AssemblyScript translation of bench/gainclass/gainclass.js.
//
// Compile with:
//   asc gainclass.as.ts -O3 --runtime stub --noAssert -o gainclass.wasm
//
// The class, its typed-array field, the instance array and the method call
// through it are kept; the host imports match the other twins.

@external("env", "perfNow")
declare function perfNow(): f64

@external("env", "logLine")
declare function logLine(medianUs: i32, checksum: u32, samples: i32, stages: i32, runs: i32): void

const N_SAMPLES: i32 = 65536
const N_NODES: i32 = 8
const N_RUNS: i32 = 21
const N_WARMUP: i32 = 5

function mkInput(out: Float64Array): void {
  let s: u32 = 0x1234abcd
  for (let i = 0, n = out.length; i < n; i++) {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    unchecked(out[i] = (<f64>s / 4294967296.0) * 2.0 - 1.0)
  }
}

class Gain {
  buf: Float64Array
  gain: f64
  constructor(n: i32, gain: f64) {
    this.buf = new Float64Array(n)
    this.gain = gain
  }
  process(input: Float64Array): Float64Array {
    const b = this.buf, g = this.gain
    for (let i = 0, n = b.length; i < n; i++) unchecked(b[i] = input[i] * g)
    return b
  }
}

function mkChain(n: i32, count: i32): Gain[] {
  const nodes = new Array<Gain>()
  for (let k = 0; k < count; k++) nodes.push(new Gain(n, 0.9 + <f64>k * 0.01))
  return nodes
}

function render(input: Float64Array, nodes: Gain[]): Float64Array {
  let x = input
  for (let k = 0, n = nodes.length; k < n; k++) x = unchecked(nodes[k]).process(x)
  return x
}

function checksum(out: Float64Array): u32 {
  // FNV-1a over a strided u32 view of the f64 output's bit pattern.
  let h: u32 = 0x811c9dc5
  const stride: i32 = 256
  const total: i32 = out.length * 2
  const base: usize = changetype<usize>(out.buffer)
  for (let i = 0; i < total; i += stride) {
    const w = load<u32>(base + (<usize>i << 2))
    h = (h ^ w) * 0x01000193
  }
  return h
}

export function main(): void {
  const input = new Float64Array(N_SAMPLES)
  mkInput(input)
  const nodes = mkChain(N_SAMPLES, N_NODES)

  for (let i = 0; i < N_WARMUP; i++) render(input, nodes)

  const samples = new Float64Array(N_RUNS)
  let out = input
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = perfNow()
    out = render(input, nodes)
    unchecked(samples[i] = perfNow() - t0)
  }

  const cs = checksum(out)

  // Insertion sort for median.
  const sorted = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) unchecked(sorted[i] = samples[i])
  for (let i = 1; i < N_RUNS; i++) {
    const v = unchecked(sorted[i])
    let j = i - 1
    while (j >= 0 && unchecked(sorted[j]) > v) {
      unchecked(sorted[j + 1] = sorted[j])
      j--
    }
    unchecked(sorted[j + 1] = v)
  }
  const medianMs = unchecked(sorted[(N_RUNS - 1) >> 1])
  const medianUs = <i32>(medianMs * 1000.0)
  logLine(medianUs, cs, N_SAMPLES, N_NODES, N_RUNS)
}
