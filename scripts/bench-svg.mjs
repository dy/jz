#!/usr/bin/env node
// Renders bench/bench.svg — an animated "speed demo" of the benchmark corpus,
// far more navigable than the 11×N table. Each engine is one lane with a ball
// that bounces back and forth horizontally between a start wall and a finish
// wall; the ball's TRAVERSAL SPEED is the metric — fast engines zip across,
// slow ones crawl. Driven by the per-engine GEOMEAN of median runtimes across
// the corpus (one honest number per engine), shown as the "N×" label so the
// chart stays readable if the animation is stripped.
//
// GitHub renders SMIL-animated SVG embedded via <img>, so the balls animate in
// the README; the labels + "N×" numbers carry the meaning when frozen.
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

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif"
// per-lane accent (fastest-first order); jz is always its hero orange via isJz.
const PALETTE = ['#1f9e57', '#e8590c', '#4c6ef5', '#7048e8', '#c92a2a', '#0c8599', '#f08c00']

/** Build the animated SVG string from rows `[{ label, sub?, ratio }]` (sorted fastest-first). */
export function benchSvg(rows) {
  const W = 720, rowH = 62, top = 70, bottom = 30
  const H = top + rows.length * rowH + bottom

  const labelW = 152, numW = 60, wallW = 10, trackPad = 10
  const trackX = labelW + trackPad + wallW       // inner edge of the start wall
  const trackRight = W - numW - trackPad - wallW  // inner edge of the finish wall
  const trackLen = trackRight - trackX
  const ballR = 10, trailR = 7

  const fmt = n => n.toFixed(2)
  // full left→right→left period ∝ ratio (slower engine → slower ball); clamped so the
  // fastest isn't a blur and the slowest still moves rather than stalling.
  const period = ratio => Math.min(7.5, Math.max(0.9, ratio * 2))
  // deterministic per-lane phase offset (index-only — no wall-clock / randomness).
  const phase = i => i * 0.37

  const lane = (r, i) => {
    const cy = top + i * rowH + rowH / 2
    const isJz = r.label === 'jz'
    const color = isJz ? '#e8590c' : PALETTE[i % PALETTE.length]
    const dur = period(r.ratio)
    const bx0 = (trackX + ballR).toFixed(1)        // ball center at the start wall
    const bx1 = (trackRight - ballR).toFixed(1)    // ball center at the finish wall
    const off = phase(i)
    const trailBegin = (off + dur * 0.85).toFixed(3)  // ghost lags 0.15-cycle behind the racer (≡ −0.15 mod period)
    const tint = isJz ? 0.09 : (i % 2 === 0 ? 0.045 : 0)  // highlight the jz lane
    const fw = isJz ? 700 : 500
    const wall = isJz ? '#e8590c' : '#495057'
    const wallTop = cy - ballR - 4, wallH = (ballR + 4) * 2
    const gid = `g${i}`, tgid = `t${i}`

    const ballAnim = b => `<animate attributeName="cx" dur="${dur}s" repeatCount="indefinite"
        keyTimes="0;0.5;1" values="${bx0};${bx1};${bx0}" calcMode="linear" begin="-${b}s"/>`

    return `
  <defs>
    <radialGradient id="${gid}" cx="38%" cy="32%" r="62%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.75"/>
      <stop offset="58%" stop-color="${color}"/>
      <stop offset="100%" stop-color="${color}" stop-opacity="0.7"/>
    </radialGradient>
    <radialGradient id="${tgid}" cx="38%" cy="32%" r="62%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.3"/>
      <stop offset="100%" stop-color="${color}" stop-opacity="0.32"/>
    </radialGradient>
  </defs>
  <g font-family="${FONT}">
    <rect x="0" y="${cy - rowH / 2}" width="${W}" height="${rowH}" fill="${color}" opacity="${tint}"/>
    <rect x="${trackX - wallW}" y="${cy - 3}" width="${trackLen + wallW * 2}" height="6" rx="3" fill="#e9ecef"/>
    <rect x="${trackX - wallW}" y="${wallTop}" width="${wallW}" height="${wallH}" rx="3" fill="${wall}"/>
    <line x1="${trackX - wallW + 2}" y1="${wallTop}" x2="${trackX - wallW + 2}" y2="${wallTop + wallH}" stroke="#fff" stroke-width="1.5" stroke-dasharray="3 3" opacity="0.6"/>
    <rect x="${trackRight}" y="${wallTop}" width="${wallW}" height="${wallH}" rx="3" fill="${wall}"/>
    <line x1="${trackRight + wallW - 2}" y1="${wallTop}" x2="${trackRight + wallW - 2}" y2="${wallTop + wallH}" stroke="#fff" stroke-width="1.5" stroke-dasharray="3 3" opacity="0.6"/>
    <text x="${labelW - 8}" y="${cy - 5}" text-anchor="end" font-size="15" font-weight="${fw}" fill="#212529">${r.label}</text>
    ${r.sub ? `<text x="${labelW - 8}" y="${cy + 12}" text-anchor="end" font-size="10.5" fill="#868e96">${r.sub}</text>` : ''}
    <text x="${W - numW + 6}" y="${cy + 5}" font-size="14" font-weight="${fw}" fill="${color}">${fmt(r.ratio)}×</text>
    <circle cx="${bx0}" cy="${cy}" r="${trailR}" fill="url(#${tgid})">${ballAnim(trailBegin)}</circle>
    <circle cx="${bx0}" cy="${cy}" r="${ballR}" fill="url(#${gid})" stroke="${color}" stroke-width="1" stroke-opacity="0.4">${ballAnim(off.toFixed(3))}</circle>
  </g>`
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="jz benchmark — each ball bounces at a rate proportional to that engine's speed; jz is the 1.00× baseline">
  <rect width="${W}" height="${H}" rx="12" fill="#ffffff" stroke="#e9ecef" stroke-width="1"/>
  <text x="20" y="32" font-family="${FONT}" font-size="16" font-weight="700" fill="#212529">Speed vs jz — geomean across the bench corpus</text>
  <text x="20" y="52" font-family="${FONT}" font-size="12" fill="#868e96">faster ball = faster engine · 1.00× = jz baseline · lower is better</text>
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
