// gainclass.js — a chain of class-based gain nodes over Float64Array.
//
// The library shape the numeric corpus leaves out: a class with a typed-array
// field and a scalar field, instances built in a loop, a method with the hot
// loop called through an array of instances (an audio node graph in small).
// Stays inside the subset every engine here runs (no async, no regex).
//
// Reports: median ms across N_RUNS, output checksum (FNV-1a over a sparse
// stride of the result so the optimizer can't elide it).

import { checksumF64, medianUs, printResult } from '../_lib/benchlib.js'

const N_SAMPLES = 65536
const N_NODES = 8
const N_RUNS = 21
const N_WARMUP = 5

// XorShift32: deterministic per-target. Output is in [-1, 1).
const mkInput = (n) => {
  const out = new Float64Array(n)
  let s = 0x1234abcd | 0
  for (let i = 0; i < n; i++) {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    out[i] = ((s >>> 0) / 4294967296) * 2 - 1
  }
  return out
}

class Gain {
  constructor(n, gain) {
    this.buf = new Float64Array(n)
    this.gain = gain
  }
  process(input) {
    const b = this.buf, g = this.gain
    for (let i = 0; i < b.length; i++) b[i] = input[i] * g
    return b
  }
}

const mkChain = (n, count) => {
  const nodes = []
  for (let k = 0; k < count; k++) nodes.push(new Gain(n, 0.9 + k * 0.01))
  return nodes
}

// Hot path: every node scales the previous node's output.
const render = (input, nodes) => {
  let x = input
  for (let k = 0; k < nodes.length; k++) x = nodes[k].process(x)
  return x
}

const run = () => {
  const input = mkInput(N_SAMPLES)
  const nodes = mkChain(N_SAMPLES, N_NODES)

  for (let i = 0; i < N_WARMUP; i++) render(input, nodes)

  const samples = new Float64Array(N_RUNS)
  let out = input
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = performance.now()
    out = render(input, nodes)
    samples[i] = performance.now() - t0
  }

  printResult(medianUs(samples), checksumF64(out), N_SAMPLES, N_NODES, N_RUNS)
}

export let main = () => {
  run()
}
