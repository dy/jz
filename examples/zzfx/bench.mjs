// ZzFX synthesis: jz-wasm vs V8, same preset, fair timing.
//   node examples/zzfx/bench.mjs
import { compile } from '../../index.js'
import { instantiate } from '../../interop.js'
import { zzfxG as jsG } from './zzfx.js'
import fs from 'fs'

const DEFAULTS = [1, .05, 220, 0, 0, .1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0]
const fill = (s) => DEFAULTS.map((d, i) => s[i] === undefined ? d : s[i])
const PRESETS = {
  Coin:      [, , 1675, , .06, .24, 1, 1.82, , , 837, .06],
  Laser:     [2, , 270, , .1, , 3, 1, , , , , , , 9, , , .5],
  Explosion: [, , 80, .3, , .4, , 1.3, , , -9999, , , .1],
  Jump:      [, , 539, .05, .3, .54, 1, 2.26, , , , , , , 4],
  Powerup:   [, , 400, , , .4, 3, 2, , , , , , 3],
  Hit:       [, , 183, .02, .02, .2, 1, 9.1, , , , , , 6],
  Blip:      [, , 150, .05, , .05],
  Pew:       [, , 925, .04, .3, .6, 1, .3, , 6.27, -184, .09, .17],
  Piano:     [1.5, .8, 270, , .1, , 1, 1.5, , , , , , , , .1, .01],
  HiHat:     [, , 77, .12, , .12, 3, 1.14, , , , , , 5.2, 14.1, , .05, .08],
}

const { exports, memory } = instantiate(new Uint8Array(compile(fs.readFileSync(new URL('./zzfx.js', import.meta.url), 'utf8'))))

const med = (fn, reps = 41) => {
  for (let i = 0; i < 200; i++) fn()                 // warm
  const t = []
  for (let r = 0; r < reps; r++) { const a = performance.now(); fn(); t.push(performance.now() - a) }
  t.sort((a, b) => a - b); return t[t.length >> 1]
}

console.log(`ZzFX synthesis — exact canonical zzfxG, same preset, median of 41 (after 200 warm).\nlower µs = faster.\n`)
console.log(`preset       samples     V8 µs    jz µs    jz speedup`)
console.log('─'.repeat(58))
let geo = 1, n = 0
for (const [name, sparse] of Object.entries(PRESETS)) {
  const p = fill(sparse)
  const len = jsG(...p).length
  const js = med(() => jsG(...p)) * 1000
  const jz = med(() => { exports.zzfxG(...p); memory.reset() }) * 1000
  const sp = js / jz
  geo *= sp; n++
  console.log(`${name.padEnd(11)} ${String(len).padStart(7)}   ${js.toFixed(1).padStart(7)}  ${jz.toFixed(1).padStart(7)}    ${sp.toFixed(2)}x`)
}
console.log('─'.repeat(58))
console.log(`geomean speedup: ${Math.pow(geo, 1 / n).toFixed(2)}x  (>1 = jz faster)`)
