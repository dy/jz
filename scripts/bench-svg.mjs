#!/usr/bin/env node
// Renders bench/bench.svg — an animated summary of the benchmark corpus that's
// far more navigable than the 11×N table. Each engine is one lane: a bar whose
// length is its SPEED relative to jz (longer = faster, static-readable), with a
// ball that bounces at a rate proportional to that speed (jz bounces briskly,
// slow engines plod). Driven by the per-engine GEOMEAN of median runtimes across
// the corpus — one honest number per engine.
//
// GitHub renders SMIL-animated SVG embedded via <img>, so the balls animate in
// the README; the bars + labels carry the meaning if animation is stripped.
//
// `bench/bench.mjs` calls renderBenchSvg() at the end of a full run with freshly
// measured geomeans; `node scripts/bench-svg.mjs` (no args) regenerates from the
// last committed snapshot so the artifact never goes stale between full runs.

import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const SVG_PATH = join(ROOT, 'bench', 'bench.svg')

// Last measured snapshot (Apple Silicon, arm64). bench.mjs overwrites this block's
// inputs on a full run; kept here so the committed SVG regenerates deterministically.
//   ratio = geomean(engine median / jz median) over the cases the engine ran
//           (lower = faster; jz is the 1.00× baseline)
export const SNAPSHOT = [
  { label: 'native C', sub: 'clang -O3', ratio: 0.96 },
  { label: 'jz', sub: '→ wasm', ratio: 1.00 },
  { label: 'V8', sub: 'Node', ratio: 2.45 },
  { label: 'AssemblyScript', sub: 'asc -O3', ratio: 2.52 },
  { label: 'Porffor', sub: 'runs 4 / 12', ratio: 5.55 },
]

const PAD = (n, d = 2) => n.toFixed(d).replace(/\.?0+$/, '') || '0'

/** Build the animated SVG string from rows `[{ label, sub?, ratio }]`. */
export function benchSvg(rows) {
  const W = 720, rowH = 58, top = 64, bottom = 30
  const H = top + rows.length * rowH + bottom
  const labelX = 150, trackX = labelX + 16, trackW = W - trackX - 70
  const minRatio = Math.min(...rows.map(r => r.ratio))
  // bar length ∝ speed (1/ratio), normalized so the fastest engine fills the track.
  const speed = r => minRatio / r.ratio
  const palette = ['#1f9e57', '#e8590c', '#4c6ef5', '#7048e8', '#adb5bd', '#f08c00', '#e64980']

  const lane = (r, i) => {
    const cy = top + i * rowH + rowH / 2
    const len = Math.max(26, speed(r) * trackW)
    const isJz = r.label === 'jz'
    const color = isJz ? '#e8590c' : palette[(i + 2) % palette.length]
    const ballR = 11
    // bounce period ∝ ratio (faster engine → quicker bounce); clamped to stay lively.
    const dur = Math.min(2.6, Math.max(0.42, r.ratio * 0.5))
    const apex = cy - 22, floor = cy + 12, ballX = trackX + len - ballR - 2
    const tag = `${PAD(r.ratio)}×${isJz ? '' : ` · ${PAD(r.ratio)}× slower`}`
    return `
  <g font-family="-apple-system,Segoe UI,Roboto,sans-serif">
    <text x="${labelX}" y="${cy - 2}" text-anchor="end" font-size="15" font-weight="${isJz ? 700 : 500}" fill="#212529">${r.label}</text>
    ${r.sub ? `<text x="${labelX}" y="${cy + 14}" text-anchor="end" font-size="10.5" fill="#868e96">${r.sub}</text>` : ''}
    <rect x="${trackX}" y="${cy - 4}" width="${trackW}" height="8" rx="4" fill="#f1f3f5"/>
    <rect x="${trackX}" y="${cy - 4}" width="${len.toFixed(1)}" height="8" rx="4" fill="${color}" opacity="${isJz ? 0.95 : 0.65}"/>
    <circle cx="${ballX.toFixed(1)}" cy="${floor}" r="${ballR}" fill="${color}">
      <animate attributeName="cy" dur="${dur}s" repeatCount="indefinite"
        keyTimes="0;0.5;1" values="${floor};${apex};${floor}"
        calcMode="spline" keySplines="0.15 0.6 0.4 1;0.6 0 0.85 0.4"/>
    </circle>
    <text x="${(trackX + len + 8).toFixed(1)}" y="${cy + 4}" font-size="13" font-weight="${isJz ? 700 : 500}" fill="${color}">${PAD(r.ratio)}×</text>
  </g>`
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="jz benchmark geomean">
  <rect width="${W}" height="${H}" rx="10" fill="#ffffff"/>
  <text x="20" y="30" font-family="-apple-system,Segoe UI,Roboto,sans-serif" font-size="16" font-weight="700" fill="#212529">Speed vs jz — geomean across the bench corpus</text>
  <text x="20" y="48" font-family="-apple-system,Segoe UI,Roboto,sans-serif" font-size="12" fill="#868e96">longer bar / brisker bounce = faster · 1.00× = jz · lower is better</text>
${rows.map(lane).join('')}
</svg>
`
}

/** Write bench/bench.svg from `rows` (defaults to the committed snapshot). */
export function renderBenchSvg(rows = SNAPSHOT) {
  const sorted = [...rows].sort((a, b) => a.ratio - b.ratio)
  writeFileSync(SVG_PATH, benchSvg(sorted))
  return SVG_PATH
}

if (import.meta.url === `file://${process.argv[1]}`) {
  renderBenchSvg()
  console.log('wrote', SVG_PATH)
}
