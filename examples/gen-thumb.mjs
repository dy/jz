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

const W = 760, H = 468
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
if (name === 'dla' && exports.seed) exports.seed()
if (name === 'wireworld' && exports.seed) exports.seed()
if (name === 'marble' && exports.drop) {
  exports.clear?.()
  for (let i = 0; i < 11; i++) exports.drop((0.12 + i * 0.075) * W, (0.42 + (i % 2) * 0.18) * H, W * 0.05)
  exports.tine(0.05 * W, 0.3 * H, 0.95 * W, 0.32 * H)
  exports.tine(0.95 * W, 0.62 * H, 0.05 * W, 0.6 * H)
  exports.tine(0.3 * W, 0.95 * H, 0.34 * W, 0.05 * H)
}
if (name === 'waves' && exports.drop) {
  exports.clear?.()
  for (const [fx, fy] of [[0.3, 0.34], [0.62, 0.4], [0.5, 0.62], [0.4, 0.52], [0.72, 0.62]])
    exports.drop(fx * W, fy * H, 4, 1.5)
}
if (name === 'watercolor' && exports.paint) {
  exports.clear?.()
  for (let i = 0; i <= 30; i++) exports.paint((0.18 + i * 0.021) * W, (0.36 + Math.sin(i * 0.32) * 0.12) * H, 12, 1.4, 0.2)
  for (let i = 0; i <= 24; i++) exports.paint((0.8 - i * 0.024) * W, (0.62 + Math.cos(i * 0.32) * 0.12) * H, 12, -1.2, 0.3)
}
const WARMUP = { diffusion: 320, nbody: 320, metaballs: 70, lenia: 120, attractors: 200,
                 plasma: 40, swarm: 80, sand: 220, slime: 130, boids: 160, voronoi: 50,
                 dla: 600, wireworld: 26, waves: 90, cloth: 130, maze: 700, sph: 500,
                 erosion: 80, lbm: 150, watercolor: 200, cradle: 36 }[name] ?? 1
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
