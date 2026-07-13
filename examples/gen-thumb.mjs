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
if (name === 'lenia' && exports.seed) exports.seed()
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
  waves:         (f) => {                         // overlapping drops, never a synthetic drag
    if (f >= 620 && f <= 755 && (f - 620) % 15 === 0) {
      const k = (f - 620) / 15
      exports.drop(W * (0.5 + 0.22 * Math.sin(k * 2.4)), H * (0.5 + 0.22 * Math.cos(k * 1.7)), 1.0)
    }
    return [f / 60, 0, 0, 0, 240, 0.45, 0.03, 0.9985, 2.5, 1.0]   // the driver's home knobs
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
  lsystem:       () => [0, 1, 1.0],   // dragon curve — boldest, distinct from pascal/fern
  epicycles:     (f, w) => [f / 60, (f / w) * 6.2831853, 96],
  apollonian:    () => [0, 0, 0, 1],
  hyperbolic:    () => [0, 0],
  ising:         (f) => [f / 60, 2.2],
  rule30:        (f) => [f / 60, 30],
  penrose:       () => [0, 0.0, 0.0, 1.0],
  blackhole:     () => [3.0, 80 * Math.PI / 180, 0.5],
  interference:  () => [1.5, 5, 520],   // 5 sources spaced past one wavelength — distinct diffraction orders
  lenia:         () => [0.2, 0, 0, 0],  // dt is a STEP, not a clock — match the driver's fixed 0.2
  raymarcher:    (f) => { const az = 0.6, el = 0.35, d = 3.7; return [f / 60, Math.sin(az) * Math.cos(el) * d, Math.sin(el) * d, Math.cos(az) * Math.cos(el) * d] },
  percolation:   (f) => [f / 60, 0.62],
  schrodinger:   (f) => [f / 60],
}

const WARMUP = { diffusion: 320, nbody: 320, metaballs: 70, attractors: 200,
                 plasma: 40, swarm: 80, sand: 220, slime: 130, boids: 220, voronoi: 50,
                 dla: 600, wireworld: 500, waves: 800, cloth: 130, maze: 200, sph: 500,
                 erosion: 350, lbm: 1300, watercolor: 200, cradle: 36, lenia: 800,
                 buddhabrot: 120, lorenz: 320, pendulum: 250, fern: 150, ising: 140, dwa: 95,
                 rule30: 480, epicycles: 130, percolation: 120, schrodinger: 230,
                 sandpile: 1000, fireflies: 433, bz: 260, magnet: 250, pathtracer: 450, ocean: 90,
                 spectra: 120 }[name] ?? 1
// nbody live is 3 bodies trailing short comet tails on black — a raw frame leaves them as
// specks in a sea of black. So: capture a single frame, crop to the bodies, and upscale so the
// trio fills the frame. Roll many initial conditions and keep the most balanced triangle with
// visible (but short) tails — single-shot, no long-exposure smearing.
if (name === 'nbody') {
  const ROLLS = 30, LO = 16, AR = W / H   // LO = tail-tip threshold for the crop box
  const grayAt = (src, fx, fy) => {       // bilinear sample of gray (low byte), clamped to frame
    fx = fx < 0 ? 0 : fx > W - 1 ? W - 1 : fx; fy = fy < 0 ? 0 : fy > H - 1 ? H - 1 : fy
    const x0 = fx | 0, y0 = fy | 0, x1 = x0 < W - 1 ? x0 + 1 : x0, y1 = y0 < H - 1 ? y0 + 1 : y0
    const tx = fx - x0, ty = fy - y0, g = (x, y) => src[y * W + x] & 0xff
    return ((g(x0, y0) * (1 - tx) + g(x1, y0) * tx) * (1 - ty) + (g(x0, y1) * (1 - tx) + g(x1, y1) * tx) * ty) | 0
  }
  const cropScale = (src, x0, y0, x1, y1) => {   // crop bbox (padded, frame aspect) → upscale to W×H
    const pad = 0.20 * Math.max(x1 - x0, y1 - y0)
    x0 -= pad; y0 -= pad; x1 += pad; y1 += pad
    let cw = x1 - x0, ch = y1 - y0; const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2
    if (cw / ch < AR) cw = ch * AR; else ch = cw / AR
    if (cw < 340) { const k = 340 / cw; cw *= k; ch *= k }   // cap upscale (~2.2×) so tight clusters stay crisp
    x0 = cx - cw / 2; y0 = cy - ch / 2
    const out = new Uint32Array(W * H)
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const g = grayAt(src, x0 + (i / (W - 1)) * cw, y0 + (j / (H - 1)) * ch)
      out[j * W + i] = (255 << 24) | (g << 16) | (g << 8) | g
    }
    return out
  }
  let best = null, bestScore = -Infinity
  for (let r = 0; r < ROLLS; r++) {
    const buf = exports.resize(W, H)
    exports.init()
    for (let f = 0; f < WARMUP; f++) exports.frame(f / 60)
    let minx = W, maxx = -1, miny = H, maxy = -1, lit = 0, sx = 0, sy = 0
    for (let yy = 0; yy < H; yy++) for (let xx = 0; xx < W; xx++)
      if ((buf[yy * W + xx] & 0xff) > LO) { lit++; sx += xx; sy += yy; if (xx < minx) minx = xx; if (xx > maxx) maxx = xx; if (yy < miny) miny = yy; if (yy > maxy) maxy = yy }
    if (lit < 50) continue
    const bw = maxx - minx, bh = maxy - miny, span = Math.max(bw, bh)
    const fill = lit / (bw * bh + 1)            // ~0.03 = comets w/ visible tails; lower = bare dots, higher = blob
    const off = Math.hypot(sx / lit - (minx + maxx) / 2, sy / lit - (miny + maxy) / 2) / span  // 0 = balanced triangle
    const aspectErr = Math.abs((bw + 1) / (bh + 1) - AR)   // 0 = bbox already frame-shaped (no black-bar padding)
    const score = -Math.abs(span - 340) / 340 - aspectErr * 0.6 - off * 3 - Math.abs(fill - 0.03) * 20 - (span > W * 0.7 ? 5 : 0)
    if (score > bestScore) { bestScore = score; best = cropScale(buf, minx, miny, maxx, maxy) }
    console.log(`  roll ${String(r + 1).padStart(2)}/${ROLLS}: span ${String(span).padStart(3)} fill ${fill.toFixed(3)} off ${off.toFixed(2)} → ${score.toFixed(2)}`)
  }
  px = best
} else {
  for (let f = 0; f < WARMUP; f++) {
    if (name === 'swarm' && exports.setTarget)               // lead the swarm in a circle
      exports.setTarget(0.5 + Math.cos(f * 0.08) * 0.18, 0.5 + Math.sin(f * 0.08) * 0.18)
    if (name === 'raytrace') exports.frame(1.4, 0.85, -2.4)  // camera eye is a frame arg now
    else if (name === 'julia') exports.frame(0, -0.8, 0.156) // dendrite-region constant
    else if (FRAME_ARGS[name]) exports.frame(...FRAME_ARGS[name](f, WARMUP))  // math demos
    else exports.frame(f / 60)
  }
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
