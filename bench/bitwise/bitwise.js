import { checksumU32, medianUs, printResult } from '../_lib/benchlib.js'

const N = 65536
const N_ROUNDS = 128
const N_RUNS = 21
const N_WARMUP = 5

const init = (state) => {
  let s = 0x1234abcd | 0
  for (let i = 0; i < state.length; i++) {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    state[i] = s
  }
}

const runKernel = (state) => {
  for (let r = 0; r < N_ROUNDS; r++) {
    for (let i = 0; i < state.length; i++) {
      let x = state[i] | 0
      x ^= x << 7
      x ^= x >>> 9
      x = Math.imul(x, 1103515245) + 12345
      state[i] = x ^ (x >>> 16)
    }
  }
}

export let main = () => {
  const state = new Int32Array(N)
  init(state)
  for (let i = 0; i < N_WARMUP; i++) { init(state); runKernel(state) }

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    init(state)
    const t0 = performance.now()
    runKernel(state)
    samples[i] = performance.now() - t0
  }
  printResult(medianUs(samples), checksumU32(state), N * N_ROUNDS, 3, N_RUNS)
}
