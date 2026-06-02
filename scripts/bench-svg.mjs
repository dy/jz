#!/usr/bin/env node
// Renders bench/bench.svg — an animated "speed demo" of the benchmark corpus,
// far more navigable than the big per-case table. Each engine is one lane with
// a single ball that runs back and forth horizontally between a start tick and
// a finish tick; the ball's TRAVERSAL SPEED is the metric — fast engines zip
// across, slow ones crawl. Driven by the per-engine GEOMEAN of median runtimes
// across the corpus (one honest number per engine), printed as the "N×" label
// so the chart still reads when the animation is frozen.
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

// Last measured snapshot (Apple Silicon, arm64). bench.mjs overwrites this on a
// full run; kept here so the committed SVG regenerates deterministically.
//   ratio = geomean(engine median / jz median) over the cases the engine ran
//           (lower = faster; jz is the 1.00× baseline). These reproduce from the
//           per-case table in README.md. Bun is the measured JSC geomean.
export const SNAPSHOT = [
  { label: 'jz', sub: '→ wasm', ratio: 1.00 },
  { label: 'native C', sub: 'clang -O3', ratio: 1.13 },
  { label: 'Zig', sub: 'ReleaseFast', ratio: 1.14 },
  { label: 'Rust', sub: 'rustc -O3', ratio: 1.19 },
  { label: 'Bun', sub: 'JavaScriptCore', ratio: 1.40 },
  { label: 'Go', sub: 'gc', ratio: 1.88 },
  { label: 'V8', sub: 'Node', ratio: 2.45 },
  { label: 'AssemblyScript', sub: 'asc -O3', ratio: 2.52 },
  { label: 'Porffor', sub: 'runs 4 / 12', ratio: 5.55 },
  { label: 'NumPy', sub: 'Python', ratio: 7.41 },
]

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif"
const HERO = '#e8590c'   // jz
const GRAY = '#adb5bd'   // every other ball — minimal, one accent

/** Build the animated SVG string from rows `[{ label, sub?, ratio }]`. */
export function benchSvg(rows) {
  const W = 720, rowH = 50, top = 20, bottom = 30
  const H = top + rows.length * rowH + bottom

  const labelW = 156, numW = 54, pad = 16
  const trackX = labelW + 18
  const trackRight = W - numW - pad
  const ballR = 8

  const fmt = n => n.toFixed(2)
  // full left→right→left period ∝ ratio (slower engine → slower ball), clamped so
  // the fastest isn't a blur and the slowest still moves rather than looking stuck.
  const period = ratio => Math.min(10, Math.max(0.85, ratio * 1.6))
  const phase = i => i * 0.41   // deterministic per-lane desync (index-only)

  const lane = (r, i) => {
    const cy = top + i * rowH + rowH / 2
    const isJz = r.label === 'jz'
    const color = isJz ? HERO : GRAY
    const dur = period(r.ratio)
    const bx0 = (trackX + ballR).toFixed(1)
    const bx1 = (trackRight - ballR).toFixed(1)
    const tickT = cy - 7, tickB = cy + 7
    const fw = isJz ? 700 : 500

    return `
  <g font-family="${FONT}">
    ${isJz ? `<rect x="0" y="${cy - rowH / 2}" width="${W}" height="${rowH}" fill="${HERO}" opacity="0.06"/>` : ''}
    <rect x="${trackX}" y="${cy - 1.5}" width="${trackRight - trackX}" height="3" rx="1.5" fill="#edf0f2"/>
    <line x1="${trackX}" y1="${tickT}" x2="${trackX}" y2="${tickB}" stroke="#ced4da" stroke-width="2"/>
    <line x1="${trackRight}" y1="${tickT}" x2="${trackRight}" y2="${tickB}" stroke="#ced4da" stroke-width="2"/>
    <text x="${labelW}" y="${cy - 4}" text-anchor="end" font-size="14" font-weight="${fw}" fill="${isJz ? HERO : '#343a40'}">${r.label}</text>
    ${r.sub ? `<text x="${labelW}" y="${cy + 11}" text-anchor="end" font-size="10" fill="#aeb4ba">${r.sub}</text>` : ''}
    <text x="${trackRight + 12}" y="${cy + 4}" font-size="13" font-weight="${fw}" fill="${isJz ? HERO : '#868e96'}">${fmt(r.ratio)}×</text>
    <circle cx="${bx0}" cy="${cy}" r="${ballR}" fill="${color}">
      <animate attributeName="cx" dur="${dur}s" repeatCount="indefinite" calcMode="linear"
        keyTimes="0;0.5;1" values="${bx0};${bx1};${bx0}" begin="-${phase(i).toFixed(2)}s"/>
    </circle>
  </g>`
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="jz benchmark — each ball runs back and forth at a rate proportional to that engine's speed; jz is the 1.00× baseline, lower is faster">
  <rect width="${W}" height="${H}" rx="12" fill="#ffffff"/>
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
