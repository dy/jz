// Floatbeat synthesis: jz-wasm vs V8 on the rfft demo tunes.
//   node examples/rfft/floatbeat-bench.mjs

import jz from '../../index.js'
import { songs, songBeatSrc } from './songs.js'

const SR = 44100
const LEN = Math.round(SR * 8)

const timeMs = (fn, reps = 8) => {
  for (let i = 0; i < 20; i++) fn()
  const samples = []
  for (let r = 0; r < reps; r++) {
    const t0 = performance.now()
    fn()
    samples.push(performance.now() - t0)
  }
  samples.sort((a, b) => a - b)
  return samples[samples.length >> 1]
}

const jsEngine = (body) => {
  const beat = new Function('t', `return (${body})(t)`)
  return {
    beat: (t) => beat(t),
    fill: (out, len, sr) => { for (let i = 0; i < len; i++) out[i] = beat(i / sr) },
  }
}

const jzEngine = (src) => {
  const { exports, memory } = jz(src)
  return {
    beat: exports.beat,
    fill: (out, len, sr) => {
      const ptr = memory.Float64Array(out)
      exports.fill(ptr, len, sr)
      out.set(memory.read(ptr))
    },
  }
}

console.log(`floatbeat synthesis — ${LEN} samples (8 s @ ${SR} Hz). lower ms = faster.\n`)

for (const song of songs) {
  const body = songBeatSrc(song)
  const src = `export let beat = ${body}
export let fill = (out, len, sr) => { let i = 0; while (i < len) { out[i] = beat(i / sr); i++ } }`
  const js = jsEngine(body)
  const jzE = jzEngine(src)

  let maxDiff = 0
  for (let i = 0; i < 2000; i++) {
    const t = i / SR
    maxDiff = Math.max(maxDiff, Math.abs(js.beat(t) - jzE.beat(t)))
  }

  const perCallJs = timeMs(() => { for (let i = 0; i < LEN; i++) js.beat(i / SR) })
  const perCallJz = timeMs(() => { for (let i = 0; i < LEN; i++) jzE.beat(i / SR) })
  const fillJs = timeMs(() => js.fill(new Float64Array(LEN), LEN, SR))
  const fillJz = timeMs(() => jzE.fill(new Float64Array(LEN), LEN, SR))

  console.log(`${song.name}  (max |Δ| = ${maxDiff.toExponential(1)})`)
  console.log(`  beat() ×${LEN}   V8 ${perCallJs.toFixed(0)} ms   jz ${perCallJz.toFixed(0)} ms   jz ${(perCallJs / perCallJz).toFixed(2)}×`)
  console.log(`  fill() loop     V8 ${fillJs.toFixed(0)} ms   jz ${fillJz.toFixed(0)} ms   jz ${(fillJs / fillJz).toFixed(2)}×`)
  console.log()
}

console.log(`Notes:
  · rfft() at N=4096 is ~1.7× faster in jz (see bench.mjs).
  · jz's sin/cos are branchless round-reduction minimax; 2** and exp share $math.exp2
    (2^k via the IEEE exponent field). fill→beat inlining + sin guard inlined.
  · jz now beats V8 on the inlined fill() loop for most tunes; the few it trails are
    array/loop-bound (dynamic-length chord loops), not transcendental.
`)
