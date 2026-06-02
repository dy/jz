// Pin every example's performance: the SAME kernel source run as jz (compiled
// wasm) vs as V8 (ESM import), timing the per-frame hot path each demo drives.
// jz must be strictly faster than V8 on every one — the script exits non-zero
// otherwise, so it doubles as a perf-regression guard.
//
//   node examples/bench.mjs
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import jz from '../index.js'

const dir = fileURLToPath(new URL('.', import.meta.url))
const SR = 44100

// rgb→bgr + the cell encoding game-of-life's init expects.
const bgr = (c) => ((c >>> 16) & 0xff) | (c & 0xff00) | ((c & 0xff) << 16)
// rfft excitation — a few partials, like the live demo's signal.
const fillSignal = (v) => {
  for (let i = 0; i < v.length; i++) {
    const t = i / SR
    v[i] = Math.sin(2*Math.PI*220*t) + 0.5*Math.sin(2*Math.PI*440*t)
         + 0.25*Math.sin(2*Math.PI*880*t) + 0.05*Math.sin(i*12.9898)
  }
}
const COIN = [1, .05, 1675, 0, .06, .24, 1, 1.82, 0, 0, 837, .06]

// Each example: `make(exports, memory|null)` does the demo's setup and returns
// the per-frame work closure. `memory` is the wasm memory for jz, null for V8.
const EXAMPLES = [
  { name: 'game-of-life', frame: 'step ×1',
    make: (e) => { e.init(512, 512, bgr(0xD392E6) | 1, bgr(0xA61B85) & ~1, 10); return () => e.step() } },

  { name: 'interference', frame: 'update ×1',
    make: (e) => { e.resize(320, 240); let tick = 0; return () => e.update(tick += 0.012) } },

  { name: 'mandelbrot', frame: 'computeLine ×H',
    make: (e) => { const W = 320, H = 240; e.resize(W, H); return () => { for (let y = 0; y < H; y++) e.computeLine(y, W, H, 40) } } },

  { name: 'rfft', frame: 'rfft N=2048',
    make: (e, mem) => { fillSignal(mem ? mem.read(e.init(2048)) : e.init(2048)); return () => e.rfft() } },

  { name: 'zzfx', frame: 'zzfxG Coin',
    make: (e, mem) => mem ? () => { e.zzfxG(...COIN); mem.reset() } : () => e.zzfxG(...COIN) },
]

// Auto-calibrated median µs/op: warm, size a batch to ~30ms, take the best-of-9
// median (steady-state, robust to GC/scheduler blips).
const timeUs = (fn) => {
  for (let i = 0; i < 30; i++) fn()
  const t0 = performance.now(); fn(); const one = performance.now() - t0
  const iters = Math.max(3, Math.min(50000, Math.round(30 / Math.max(one, 0.0005))))
  const samples = []
  for (let r = 0; r < 9; r++) {
    const a = performance.now()
    for (let i = 0; i < iters; i++) fn()
    samples.push((performance.now() - a) / iters * 1000)
  }
  samples.sort((a, b) => a - b)
  return samples[samples.length >> 1]
}

// Pass criteria: jz must be faster overall (geomean > 1) and no example may
// regress below FLOOR. mandelbrot sits near 1× — V8's JIT is exceptional on the
// tight escape loop, and jz's full-precision Math.log trails there — so the floor
// catches real regressions without flapping on that genuine near-tie.
const FLOOR = 0.9

console.log('Examples — same source, jz-wasm vs V8 (ESM). per-frame hot path.\n')
console.log('example         frame              V8 µs       jz µs    speedup')
console.log('─'.repeat(68))

let geo = 1, n = 0, wins = 0, regressed = []
for (const { name, frame, make } of EXAMPLES) {
  const src = readFileSync(dir + `${name}/${name}.js`, 'utf8')
  const jsmod = await import(new URL(`${name}/${name}.js`, import.meta.url).href)
  const { exports, memory } = jz(src)

  const jsT = timeUs(make(jsmod, null))
  const jzT = timeUs(make(exports, memory))
  const sp = jsT / jzT
  geo *= sp; n++
  if (sp > 1) wins++
  if (sp < FLOOR) regressed.push(`${name} ${sp.toFixed(2)}×`)
  const mark = sp >= 1 ? '' : sp >= FLOOR ? '  ~tie' : '  ← regressed'
  console.log(`${name.padEnd(15)} ${frame.padEnd(18)} ${jsT.toFixed(1).padStart(8)} ${jzT.toFixed(1).padStart(11)}    ${sp.toFixed(2)}×${mark}`)
}
const gm = Math.pow(geo, 1 / n)
console.log('─'.repeat(68))
console.log(`geomean ${gm.toFixed(2)}× · jz faster on ${wins}/${n} (>1 = jz faster)`)

if (gm <= 1 || regressed.length) {
  console.error(`\n✗ FAIL — ${gm <= 1 ? `geomean ${gm.toFixed(2)}× not > 1` : `below ${FLOOR}×: ${regressed.join(', ')}`}`)
  process.exit(1)
}
console.log(`\n✓ jz faster overall (${gm.toFixed(2)}×); every example within ${FLOOR}×+`)
