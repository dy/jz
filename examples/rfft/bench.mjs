// Paired benchmark: the SAME rfft.js source run as jz (compiled wasm) vs as JS
// (ESM import on V8). Confirms numerical equivalence, then reports best-of-N
// median µs per op. The source uses idiomatic f64 globals (`while (i < N)`) with
// no manual `let n = N | 0` hoist — jz's analyzer auto-narrows affine index
// counters to i32, so idiomatic code runs at int speed without a rewrite.
//
//   node examples/rfft/bench.mjs            # N=2048
//   node examples/rfft/bench.mjs 512 8192   # custom sizes

import { readFileSync } from 'fs'
import jz from '../../index.js'

const SR = 44100
const sizes = process.argv.slice(2).map(Number).filter(Boolean)
const SIZES = sizes.length ? sizes : [2048]
const SRC = readFileSync(new URL('rfft.js', import.meta.url), 'utf8')

const fillSignal = (view) => {
  for (let i = 0; i < view.length; i++) {
    const t = i / SR
    view[i] = Math.sin(2*Math.PI*220*t) + 0.5*Math.sin(2*Math.PI*440*t)
            + 0.25*Math.sin(2*Math.PI*880*t) + 0.05*Math.sin(i*12.9898)
  }
}

// best-of-`reps` median µs/op over `iters` calls
const timeUs = (fn, iters, reps = 8) => {
  for (let i = 0; i < 200; i++) fn()           // warmup
  const samples = []
  for (let r = 0; r < reps; r++) {
    const t0 = performance.now()
    for (let i = 0; i < iters; i++) fn()
    samples.push((performance.now() - t0) / iters * 1000)
  }
  samples.sort((a, b) => a - b)
  return samples[samples.length >> 1]
}

const jsmod = await import(new URL('rfft.js', import.meta.url).href)

console.log('rfft.js — same source, jz-wasm vs V8 (JS-ESM). lower µs = faster.\n')
for (const N of SIZES) {
  const { exports, memory } = jz(SRC)
  fillSignal(memory.read(exports.init(N)))
  fillSignal(jsmod.init(N))

  // numerical equivalence (jz vs V8) on the magnitude spectrum
  exports.rfft(); jsmod.rfft()
  const ws = memory.read(exports.spectrum()), js = jsmod.spectrum()
  let maxDiff = 0
  for (let i = 0; i < N >> 1; i++) maxDiff = Math.max(maxDiff, Math.abs(ws[i] - js[i]))

  const iters = Math.max(200, (1 << 22) / N | 0)
  const rfftJz = timeUs(() => exports.rfft(), iters)
  const rfftJs = timeUs(() => jsmod.rfft(), iters)
  const pipeJz = timeUs(() => { exports.rfft(); exports.cepstrum() }, iters)
  const pipeJs = timeUs(() => { jsmod.rfft(); jsmod.cepstrum() }, iters)

  console.log(`N=${String(N).padStart(5)}  (max |Δspectrum| = ${maxDiff.toExponential(1)})`)
  console.log(`  rfft()             jz ${rfftJz.toFixed(2)}µs   V8 ${rfftJs.toFixed(2)}µs   jz ${(rfftJs/rfftJz).toFixed(2)}×`)
  console.log(`  rfft()+cepstrum()  jz ${pipeJz.toFixed(2)}µs   V8 ${pipeJs.toFixed(2)}µs   jz ${(pipeJs/pipeJz).toFixed(2)}×`)
}
