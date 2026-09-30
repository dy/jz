#!/usr/bin/env node
// Render a single frame of an example and write thumbs/<name>.webp.
import fs from 'fs'
import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'
import { instantiate } from '../interop.js'

const name = process.argv[2]
if (!name) { console.error('usage: node examples/gen-thumb.mjs <example-name>'); process.exit(1) }

const dir = fileURLToPath(new URL('.', import.meta.url))
const wasm = fs.readFileSync(`${dir}/${name}/${name}.wasm`)
const { exports } = await instantiate(wasm)

// Most examples render at the standard thumb size; a few want a coarser grid so their cells
// stay chunky/legible at thumbnail scale (the gallery upscales the webp).
const SIZE = { wireworld: [1010, 700],          // larger die so the ~3×3 grid of distinct macro-cell blocks reads (bigger blocks now → fewer per unit area)
               lenia: [192, 118] }[name]        // the driver's cap — fixed-radius kernels mean creature size is set in CELLS
const W = SIZE ? SIZE[0] : 760, H = SIZE ? SIZE[1] : 468
let px = exports.resize(W, H)
if (exports.init) exports.init()

// Most kernels need a few frames of evolution to look like anything; some need
// the host to plant a seed first (diffusion). Warm up to a representative frame.
if (name === 'diffusion' && exports.seedBrush) {
  exports.clear?.()
  exports.setParams?.(0.054, 0.062)
  for (const [fx, fy] of [[0.5, 0.5], [0.3, 0.6], [0.7, 0.4]])
    exports.seedBrush(fx * W, fy * H, 12)
}
if (name === 'swarm' && exports.addFlies) exports.addFlies(0.5, 0.5, 70)
if (name === 'sand' && exports.paint) {
  exports.clear?.()
  for (let i = 0; i <= 22; i++) exports.paint((0.04 + i * 0.043) * W, 0.9 * H, 15, 3)   // floor
  // sand mound (left) + water (right), dropped near the floor so they settle in time
  for (let i = 0; i < 80; i++) exports.paint((0.2 + Math.random() * 0.22) * W, (0.5 + Math.random() * 0.2) * H, 9, 1)
  for (let i = 0; i < 80; i++) exports.paint((0.58 + Math.random() * 0.24) * W, (0.5 + Math.random() * 0.2) * H, 9, 2)
}
if (name === 'slime' && exports.seed) exports.seed()
if (name === 'lenia' && exports.seed) exports.seed(1)
if (name === 'sandpile' && exports.seed) exports.seed()
if (name === 'bz' && exports.seed) { exports.clear?.(); exports.seed(0, 0.5, 0.5) }
if (name === 'blackhole' && exports.setSeed) exports.setSeed(2.1, 7.7, 4.4)
if (name === 'ocean' && exports.setWind) exports.setWind(85, -45)
if (name === 'rule30' && exports.seed) exports.seed()    // single-1 center row → the light-cone triangle
if (name === 'dla' && exports.seed) exports.seed()
if (name === 'wireworld' && exports.seed) exports.seed()
if (name === 'marble' && exports.drop) {
  exports.clear?.()
  // suminagashi "stones": repeated drops at one point push the earlier rings outward
  // into concentric bands; then a few SHORT combs (tine shear scales with stroke length)
  for (const [fx, fy] of [[0.26, 0.32], [0.66, 0.26], [0.36, 0.72], [0.74, 0.66]])
    for (let i = 0; i < 8; i++) exports.drop(fx * W, fy * H, W * 0.05)
  exports.tine(0.2 * W, 0.52 * H, 0.52 * W, 0.48 * H)
  exports.tine(0.82 * W, 0.44 * H, 0.5 * W, 0.5 * H)
  exports.tine(0.48 * W, 0.78 * H, 0.52 * W, 0.5 * H)
}
if (name === 'watercolor' && exports.paint) {
  exports.clear?.()
  for (let i = 0; i <= 30; i++) exports.paint((0.18 + i * 0.021) * W, (0.36 + Math.sin(i * 0.32) * 0.12) * H, 12, 1.4, 0.2)
  for (let i = 0; i <= 24; i++) exports.paint((0.8 - i * 0.024) * W, (0.62 + Math.cos(i * 0.32) * 0.12) * H, 12, -1.2, 0.3)
}
// Per-example frame() args for a representative still (most math demos take interactive
// params; the bare frame(f/60) default would pass `undefined`). fn receives (f, warmup).
// NB: pass EVERY kernel frame() param — a trailing undefined arg reaches the kernel as
// NaN and blacks the whole frame. Values mirror each driver's home view.
const GOLDEN = 2.3999632297286535
const FRAME_ARGS = {
  newton:        () => [0, 1.0, 0.0, 0, 0, 1.6],
  'times-table': () => [0, 2.0, 280],
  boids:         (f) => [f / 60, -1, -1, 0],
  burningship:   () => [0, -0.45, -0.5, 1.35, 0],
  lyapunov:      () => [0, 0, 0, 1.5],
  buddhabrot:    (f) => [f / 60, -0.5, 0, 1.1],
  waves:         (f) => {                         // the page's weather: a drizzle and a few big drops,
    const r = (k) => { const x = Math.sin(f * 12.9898 + k * 78.233) * 43758.5453; return x - Math.floor(x) }   // seeded scatter
    if (f % 17 === 3) exports.rain(W * r(1), H * r(2))
    if (f % 210 === 40) exports.drop(W * (0.2 + 0.6 * r(3)), H * (0.25 + 0.5 * r(4)))
    return [f / 60, 0, 0, 0, 440]
  },

  bifurcation:   () => [0, 2.5, 4.0, 0.0, 1.0],
  lorenz:        (f) => [f / 60, -0.4],
  pendulum:      (f) => [f / 60],
  ulam:          () => [0, 0, 0, 2],   // zoomed out — dense prime-diagonal speckle
  'pascal-sierpinski': () => [0, 2, 1.0],   // mod 2 fully revealed — the classic Sierpiński
  'gauss-primes': () => [0, 0, 0, 1],
  'domain-color': () => [0, 0.3, 0.2, 0, 0, 2.5],
  chladni:       () => [4, 5],          // (n,m) — an even mode: crisp flowing nodal figure, no both-odd centre cross
  hydrogen:      () => [0, 6],          // sel=6 → the 3d_z² orbital (iconic lobes + ring)
  dithering:     () => [2.2, 5, 1],     // Floyd–Steinberg of the lips relief — the star subject
  plume:         () => [2.0, 1 / 18, 5, 14, 30, 0],   // original constants at t=1: pulse=2t, swirl=t/18
  spectra:       (f) => [f / 60, 0.001, 0.010],  // the Bohemian-lace α from the original piece
  phyllotaxis:   () => [0, GOLDEN, 3600, 1.0],
  harmonograph:  () => [0, 0.06, 0.5, 0, 0, 1, 0.3],
  truchet:       () => [0, 30],
  fern:          (f) => [f / 60, 0, 0, 0, 1, 0],
  lsystem:       () => [0, 7, 1.0],   // the bush — tapered strokes, distinct from pascal/fern
  epicycles:     (f, w) => [f / 60, (f / w) * 6.2831853, 96],
  apollonian:    () => [0, 0, 0, 1],
  hyperbolic:    () => [0, 0.35, 0.12, 0.3, 7, 3],   // the (2,3,7) group, translated off-centre
  ising:         (f) => [f / 60, 2.2],
  rule30:        (f) => [f / 60, 30],
  penrose:       () => [0, 0.0, 0.0, 1.0],
  blackhole:     () => [3.0, 80 * Math.PI / 180, 0.5],
  interference:  () => [1.5, 5, 520],   // 5 sources spaced past one wavelength — distinct diffraction orders
  lenia:         () => [],
  raymarcher:    (f) => { const az = 0.6, el = 0.35, d = 3.7; return [f / 60, Math.sin(az) * Math.cos(el) * d, Math.sin(el) * d, Math.cos(az) * Math.cos(el) * d] },
  percolation:   (f) => [f / 60, 0.62],
  schrodinger:   (f) => { if (f && f % 540 === 0) exports.emit(); return [f / 60] },   // the page's 9 s emitter
}

const WARMUP = { diffusion: 320, nbody: 380, metaballs: 70, attractors: 200,
                 plasma: 40, swarm: 480, sand: 220, slime: 130, boids: 220, voronoi: 50,
                 dla: 600, wireworld: 500, waves: 800, cloth: 700, maze: 200, sph: 170,
                 erosion: 350, lbm: 1300, watercolor: 200, cradle: 36, lenia: 240,
                 buddhabrot: 120, lorenz: 320, pendulum: 250, fern: 150, ising: 140, dwa: 95,
                 rule30: 480, epicycles: 130, percolation: 120, schrodinger: 1150,
                 sandpile: 1000, fireflies: 433, bz: 260, magnet: 250, pathtracer: 450, ocean: 90,
                 spectra: 120, 'threejs-math': 90 }[name] ?? 1
for (let f = 0; f < WARMUP; f++) {
  if (name === 'swarm' && exports.setTarget)               // the page's idle Lissajous stand-in for the cursor
    exports.setTarget(0.5 + 0.32 * Math.sin(f / 60 * 0.23), 0.5 + 0.3 * Math.sin(f / 60 * 0.37 + 1))
  if (name === 'raytrace') exports.frame(1.4, 0.85, -2.4)  // camera eye is a frame arg now
  else if (name === 'julia') exports.frame(0, -0.8, 0.156, 0, 0, 1.5) // dendrite-region constant, home view
  else if (FRAME_ARGS[name]) exports.frame(...FRAME_ARGS[name](f, WARMUP))  // math demos
  else exports.frame(f / 60)
}

// Write PPM (RGB) — pixels are 0xAABBGGRR in host memory (low byte = R).
const ppm = `${dir}/thumbs/${name}.ppm`
fs.mkdirSync(`${dir}/thumbs`, { recursive: true })
const header = Buffer.from(`P6\n${W} ${H}\n255\n`)
const rgb = Buffer.alloc(W * H * 3)
let o = 0
for (let i = 0; i < W * H; i++) {
  const p = px[i]
  rgb[o++] = p & 0xff
  rgb[o++] = (p >> 8) & 0xff
  rgb[o++] = (p >> 16) & 0xff
}
fs.writeFileSync(ppm, Buffer.concat([header, rgb]))

const webp = `${dir}/thumbs/${name}.webp`
execFileSync('cwebp', ['-q', '85', ppm, '-o', webp])
fs.unlinkSync(ppm)
console.log(`wrote ${webp}`)
