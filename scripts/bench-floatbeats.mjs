import { compile } from '../index.js'
import { instantiate } from '../interop.js'

const floatbeats = [
  { name: 'Simple Sine', rate: 44100, body: '(t) => Math.sin(t * 0.02) * 0.5' },
  { name: 'Bitwise', rate: 8000, body: '(t) => t*(((t>>12)^(t>>10))%13&64)/32-1' },
  { name: 'Dual Sine', rate: 8000, body: '(t) => Math.sin(t*Math.sin(t>>11)*5e-4)+Math.sin(t*Math.sin(t>>14)*3e-4)' },
  { name: 'Complex Sine', rate: 8000, body: '(t) => Math.sin(t*0.02)*Math.cos(t*0.002)*0.8+Math.sin(t*0.005)*0.3' },
  { name: 'Mandelbrot', rate: 8000, body: '(t) => ((t%65536)*Math.sin(t>>9%8)*1e-4)*Math.pow(2,2*Math.sin(t*3e-5))*0.5' },
]

function moduleSrc(body) {
  return `export let beat = ${body}
export let fill = (out, len, off) => { let i = 0; while (i < len) { let s = beat(off + i); out[i] = s < -1 ? -1 : (s > 1 ? 1 : s); i++ } }`
}

for (const fb of floatbeats) {
  const wasm = compile(moduleSrc(fb.body), { optimize: 3 })
  const { exports, memory } = instantiate(wasm)
  const N = fb.rate, iters = 200

  // Warmup
  const out = memory.Float64Array(new Float64Array(N))
  for (let i = 0; i < 5; i++) exports.fill(out, N, 0)

  // Benchmark jz (with allocation per iter, matching jukebox pattern)
  let t0 = performance.now()
  for (let i = 0; i < iters; i++) {
    memory.reset()
    const o2 = memory.Float64Array(new Float64Array(N))
    exports.fill(o2, N, i * N)
  }
  const jzMs = (performance.now() - t0) / iters

  // Benchmark JS
  const fn = new Function('t', 'return ' + fb.body)
  t0 = performance.now()
  const arr = new Float64Array(N)
  for (let i = 0; i < iters; i++) {
    for (let j = 0; j < N; j++) arr[j] = fn(i * N + j)
  }
  const jsMs = (performance.now() - t0) / iters

  console.log(`${fb.name}: jz ${jzMs.toFixed(2)}ms vs JS ${jsMs.toFixed(2)}ms (${(jzMs/jsMs).toFixed(2)}x)`)
}
