import { compile } from '../index.js'
import { instantiate } from '../interop.js'
import { FLOATBEATS, moduleSrc } from '../examples/jukebox/floatbeats.js'

console.log('=' .repeat(70))
console.log('BENCHMARKING JUKEBOX FLOATBEATS: jz WASM vs. V8 JS')
console.log('=' .repeat(70))

for (let i = 0; i < FLOATBEATS.length; i++) {
  const fb = FLOATBEATS[i]
  const wasm = compile(moduleSrc(fb.body), { optimize: 3 })
  const { exports, memory } = instantiate(wasm)
  
  const N = fb.sr // 1 second of samples
  const iters = 100 // run 100 times to get solid, stable numbers

  // Warmup jz
  const out = memory.Float64Array(new Float64Array(N))
  for (let k = 0; k < 5; k++) exports.fill(out, N, 0)

  // Benchmark jz (resetting memory like jukebox does)
  let t0 = performance.now()
  for (let k = 0; k < iters; k++) {
    memory.reset()
    const o2 = memory.Float64Array(new Float64Array(N))
    exports.fill(o2, N, k * N)
  }
  const jzMs = (performance.now() - t0) / iters

  // Benchmark JS — build the arrow AND call it (`(body)(t)`), matching the
  // jukebox HTML engine. `'return ' + body` alone returns the arrow uncalled,
  // so V8 would execute none of the DSP — measuring only closure allocation.
  const fn = new Function('t', 'return (' + fb.body + ')(t)')
  const jsFill = (out, len, off) => {
    let j = 0
    while (j < len) {
      let s = fn(off + j)
      out[j] = s < -1 ? -1 : (s > 1 ? 1 : s)
      j++
    }
  }

  // Warmup JS
  const jsOut = new Float64Array(N)
  for (let k = 0; k < 5; k++) jsFill(jsOut, N, 0)

  t0 = performance.now()
  for (let k = 0; k < iters; k++) {
    jsFill(jsOut, N, k * N)
  }
  const jsMs = (performance.now() - t0) / iters

  const speedup = jsMs / jzMs
  const status = speedup > 1.05 ? '🚀 FASTER' : (speedup < 0.95 ? '🐌 SLOWER' : '⚖️ PARITY')

  console.log(`${i}. [${fb.name}] by ${fb.by} (${N} Hz)`)
  console.log(`   jz WASM : ${jzMs.toFixed(3)} ms`)
  console.log(`   V8 JS   : ${jsMs.toFixed(3)} ms`)
  console.log(`   Ratio   : ${speedup.toFixed(2)}x (${status})\n`)
}
console.log('=' .repeat(70))
