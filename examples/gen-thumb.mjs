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
const px = exports.resize(W, H)
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
if (name === 'waves' && exports.source) {
  exports.clear?.()
  const R = Math.min(W, H) * 0.13
  exports.source(0, W / 2 - R, H / 2, 0.22, 0.5)    // two in-phase driven sources → fringes
  exports.source(1, W / 2 + R, H / 2, 0.22, 0.5)
}
if (name === 'watercolor' && exports.paint) {
  exports.clear?.()
  for (let i = 0; i <= 30; i++) exports.paint((0.18 + i * 0.021) * W, (0.36 + Math.sin(i * 0.32) * 0.12) * H, 12, 1.4, 0.2)
  for (let i = 0; i <= 24; i++) exports.paint((0.8 - i * 0.024) * W, (0.62 + Math.cos(i * 0.32) * 0.12) * H, 12, -1.2, 0.3)
}
const WARMUP = { diffusion: 320, nbody: 520, metaballs: 70, lenia: 120, attractors: 200,
                 plasma: 40, swarm: 80, sand: 220, slime: 130, boids: 160, voronoi: 50,
                 dla: 600, wireworld: 26, waves: 360, cloth: 130, maze: 700, sph: 500,
                 erosion: 80, lbm: 150, watercolor: 200, cradle: 36 }[name] ?? 1
// nbody trails fade fast on screen; for a still, accumulate peak brightness across
// the run so the orbits read as long luminous curves (what the eye integrates live).
const peak = name === 'nbody' ? new Uint8Array(W * H) : null
for (let f = 0; f < WARMUP; f++) {
  if (name === 'swarm' && exports.setTarget)               // lead the swarm in a circle
    exports.setTarget(0.5 + Math.cos(f * 0.08) * 0.18, 0.5 + Math.sin(f * 0.08) * 0.18)
  if (name === 'raytrace') exports.frame(1.4, 0.85, -2.4)  // camera eye is a frame arg now
  else if (name === 'julia') exports.frame(0, -0.8, 0.156) // dendrite-region constant
  else exports.frame(f / 60)
  if (peak && f > WARMUP - 260) for (let i = 0; i < W * H; i++) { const g = px[i] & 0xff; if (g > peak[i]) peak[i] = g }
}
if (peak) for (let i = 0; i < W * H; i++) px[i] = (255 << 24) | (peak[i] << 16) | (peak[i] << 8) | peak[i]

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
